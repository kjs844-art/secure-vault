import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyReadFailure, readBoundedJson, type BodyReadFailureCode, type BoundedJsonOptions } from "../src/server/http/bounded-json.ts";

// Synthetic in-memory Request/ReadableStream only: no network or HTTP server.
const encoder = new TextEncoder();
function request(body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request("https://synthetic.invalid/local", { method: "POST", body,
    headers: { "content-type": "application/json", ...headers }, duplex: "half" } as RequestInit & { duplex: "half" });
}
function chunks(parts: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({ pull(controller) {
    if (index < parts.length) controller.enqueue(parts[index++]!);
    else controller.close();
  } });
}
function bytes(value: readonly number[]): ReadableStream<Uint8Array> { return chunks([new Uint8Array(value)]); }
async function failure(promise: Promise<unknown>, code: BodyReadFailureCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BodyReadFailure);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.name, "BodyReadFailure");
    assert.ok(!JSON.stringify(error).includes("synthetic-sensitive"));
    return true;
  });
}
function pending(cancel: () => void | PromiseLike<void> = () => undefined): ReadableStream<Uint8Array> {
  return new ReadableStream({ pull() { return new Promise<void>(() => {}); }, cancel });
}

test("plain objects preserve JSON values without coercion and callers own the returned object", async () => {
  const value = await readBoundedJson(request(' {"name":"합성 😀","zero":0,"no":false,"missing":null,"nested":{"array":[1,true,"x"]}}\r\n'));
  assert.deepEqual(value, { name: "합성 😀", zero: 0, no: false, missing: null, nested: { array: [1, true, "x"] } });
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.isFrozen(value), false);
  assert.deepEqual(await readBoundedJson(request("{}")), {});
});

test("accepted media types are exactly JSON with an optional UTF-8 charset and identity encoding", async () => {
  for (const mediaType of ["application/json", "APPLICATION/JSON", "application/json;charset=utf-8",
    "Application/Json ; CHARSET=UTF-8", "application/json\t;\tcharset=utf-8"]) {
    assert.deepEqual(await readBoundedJson(request("{}", { "content-type": mediaType, "content-encoding": "IDENTITY" })), {});
  }
  for (const mediaType of ["", "text/json", "text/plain", "application/problem+json", "application/json;charset=utf8",
    "application/json;charset=ascii", 'application/json;charset="utf-8"', "application/json; charset = utf-8",
    "application/json; charset=utf-8; extra=value", "application/json, application/json"]) {
    await failure(readBoundedJson(request("{}", { "content-type": mediaType })), "BODY_MEDIA_TYPE");
  }
  const missing = request("{}");
  missing.headers.delete("content-type");
  await failure(readBoundedJson(missing), "BODY_MEDIA_TYPE");
  for (const encoding of ["", "gzip", "br", "deflate", "identity, identity", "identity, gzip"]) {
    await failure(readBoundedJson(request("{}", { "content-encoding": encoding })), "BODY_MEDIA_TYPE");
  }
});

test("internal limits must be positive safe integers within their hard ceilings", async () => {
  for (const value of [0, -1, 0.5, NaN, Infinity, "2", null]) {
    for (const key of ["maxBytes", "timeoutMs"]) {
      await failure(readBoundedJson(request("{}"), { [key]: value } as BoundedJsonOptions), "BODY_INVALID");
    }
  }
  await failure(readBoundedJson(request("{}"), { maxBytes: 65537 }), "BODY_INVALID");
  await failure(readBoundedJson(request("{}"), { timeoutMs: 10001 }), "BODY_INVALID");
  await failure(readBoundedJson(request("{}"), { signal: {} as AbortSignal }), "BODY_INVALID");
  await failure(readBoundedJson(request("{}"), null as unknown as BoundedJsonOptions), "BODY_INVALID");
  assert.deepEqual(await readBoundedJson(request("{}"), { maxBytes: 2, timeoutMs: 10000 }), {});
});

test("the default 16384-byte cap and configured 65536-byte ceiling include every UTF-8 byte", async () => {
  for (const cap of [16384, 65536]) {
    const exact = '{"value":"' + "a".repeat(cap - 12) + '"}';
    assert.equal(encoder.encode(exact).byteLength, cap);
    const options = cap === 16384 ? undefined : { maxBytes: cap };
    assert.ok(await readBoundedJson(request(exact), options));
    await failure(readBoundedJson(request(exact + " "), options), "BODY_TOO_LARGE");
  }
  const multibyte = '{"value":"😀"}';
  const length = encoder.encode(multibyte).byteLength;
  assert.ok(await readBoundedJson(request(multibyte), { maxBytes: length }));
  await failure(readBoundedJson(request(multibyte), { maxBytes: length - 1 }), "BODY_TOO_LARGE");
});

test("stream cap applies without Content-Length and with a false smaller Content-Length", async () => {
  for (const headers of [{}, { "content-length": "2" }]) {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode("{\"x\":"));
      controller.enqueue(encoder.encode("12345}"));
    }, cancel() { cancelled++; } });
    const input = request(stream, headers);
    await failure(readBoundedJson(input, { maxBytes: 8 }), "BODY_TOO_LARGE");
    assert.equal(cancelled, 1);
    assert.equal(input.body!.locked, false);
  }
});

test("canonical decimal Content-Length must equal streamed bytes at EOF", async () => {
  assert.deepEqual(await readBoundedJson(request("{}", { "content-length": "2" })), {});
  const multibyte = '{"x":"😀"}';
  assert.deepEqual(await readBoundedJson(request(multibyte, { "content-length": String(encoder.encode(multibyte).length) })), { x: "😀" });
  for (const length of ["", "00", "02", "+2", "-1", "2.0", "2e0", "2,2", "2 0", "NaN"]) {
    await failure(readBoundedJson(request("{}", { "content-length": length })), "BODY_INVALID");
  }
  for (const length of ["0", "1", "3", "4"]) {
    await failure(readBoundedJson(request("{}", { "content-length": length })), "BODY_INVALID");
  }
  await failure(readBoundedJson(request(multibyte, { "content-length": String(multibyte.length) })), "BODY_INVALID");
  for (const length of ["16385", "9".repeat(400)]) {
    await failure(readBoundedJson(request("{}", { "content-length": length })), "BODY_TOO_LARGE");
  }
});

test("bodyUsed, locked and absent bodies fail without unbounded convenience reads", async () => {
  const used = request("{}");
  const usedReader = used.body!.getReader();
  await usedReader.read();
  usedReader.releaseLock();
  await failure(readBoundedJson(used), "BODY_INVALID");
  const locked = request("{}");
  const lock = locked.body!.getReader();
  await failure(readBoundedJson(locked), "BODY_INVALID");
  lock.releaseLock();
  await failure(readBoundedJson(new Request("https://synthetic.invalid/local", { headers: { "content-type": "application/json" } })), "BODY_INVALID");
  const input = request("{}");
  input.json = () => { throw new Error("UNBOUNDED_JSON_CALLED"); };
  input.text = () => { throw new Error("UNBOUNDED_TEXT_CALLED"); };
  assert.deepEqual(await readBoundedJson(input), {});
});

test("UTF-8 characters may cross every stream boundary and byte offsets are respected", async () => {
  const encoded = encoder.encode('{"name":"한글 😀"}');
  const parts = Array.from(encoded, (byte) => new Uint8Array([99, byte, 99]).subarray(1, 2));
  assert.deepEqual(await readBoundedJson(request(chunks(parts))), { name: "한글 😀" });
  assert.deepEqual(await readBoundedJson(request(chunks([new Uint8Array(), encoder.encode("{}"), new Uint8Array()]))), {});
});

test("fatal decoding rejects overlong, truncated, surrogate, illegal and out-of-range UTF-8", async () => {
  const prefix = [...encoder.encode('{"x":"')];
  const suffix = [...encoder.encode('"}')];
  for (const bad of [[0xc0, 0xaf], [0xc1, 0xbf], [0xe0, 0x80, 0xaf], [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80], [0xff], [0x80], [0xe2, 0x28, 0xa1]]) {
    await failure(readBoundedJson(request(bytes([...prefix, ...bad, ...suffix]))), "BODY_INVALID");
  }
  for (const truncated of [[0xc2], [0xe2, 0x82], [0xf0, 0x9f, 0x98]]) {
    await failure(readBoundedJson(request(bytes([...prefix, ...truncated]))), "BODY_INVALID");
  }
});

test("a leading UTF-8 BOM is rejected even when split but a BOM inside a JSON string is data", async () => {
  const body = encoder.encode("{}");
  for (const parts of [[new Uint8Array([0xef, 0xbb, 0xbf]), body],
    [new Uint8Array([0xef]), new Uint8Array([0xbb]), new Uint8Array([0xbf]), body]]) {
    await failure(readBoundedJson(request(chunks(parts))), "BODY_INVALID");
  }
  assert.deepEqual(await readBoundedJson(request('{"x":"\ufeff"}')), { x: "\ufeff" });
  await failure(readBoundedJson(request(bytes([0xff, 0xfe, 0x7b, 0, 0x7d, 0]))), "BODY_INVALID");
});

test("root JSON arrays and scalars, empty bodies and non-JSON whitespace are rejected", async () => {
  for (const body of ["", " \r\n\t", "[]", "[{}]", '"value"', "1", "0", "true", "false", "null", "\v{}", "\u00a0{}", "{}\f"]) {
    await failure(readBoundedJson(request(body)), "BODY_INVALID");
  }
});

test("duplicate decoded keys are rejected at any nesting level including escapes and prototype-like names", async () => {
  for (const body of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"\\u0078":1,"x":2}',
    '{"a":{"x":1,"x":2}}', '{"a":[{"x":1,"x":2}]}', '{"😀":1,"\\ud83d\\ude00":2}',
    '{"__proto__":1,"\\u005f_proto__":2}', '{"":1,"":2}']) {
    await failure(readBoundedJson(request(body)), "BODY_INVALID");
  }
  assert.deepEqual(await readBoundedJson(request('{"a":{"x":1},"b":{"x":2}}')), { a: { x: 1 }, b: { x: 2 } });
  const prototype = await readBoundedJson(request('{"__proto__":{"synthetic":true},"constructor":null}')) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(prototype), Object.prototype);
  assert.ok(Object.hasOwn(prototype, "__proto__"));
  assert.equal(Object.hasOwn(Object.prototype, "synthetic"), false);
});

test("JSON string grammar allows standard escapes and rejects invalid or unfinished escapes", async () => {
  assert.deepEqual(await readBoundedJson(request('{"x":"\\\"\\\\\\/\\b\\f\\n\\r\\t\\u0061"}')), { x: '"\\/\b\f\n\r\ta' });
  for (const body of ['{"x":"\\x20"}', '{"x":"\\u123"}', '{"x":"\\u00gg"}', '{"x":"\\',
    '{"x":"line\nfeed"}', '{"x":"\u0000"}', '{"x":"unterminated}', '{"x":\'single\'}']) {
    await failure(readBoundedJson(request(body)), "BODY_INVALID");
  }
  // Escaped lone surrogates are legal JSON; domain validation can reject them.
  assert.deepEqual(await readBoundedJson(request('{"x":"\\ud800"}')), { x: "\ud800" });
});

test("JSON number grammar, separators and trailing input must be exact", async () => {
  assert.deepEqual(await readBoundedJson(request('{"a":-0,"b":0.25,"c":-1.2E+3,"d":1e-2}')), { a: -0, b: 0.25, c: -1200, d: 0.01 });
  for (const body of ['{"x":01}', '{"x":+1}', '{"x":.1}', '{"x":1.}', '{"x":1e}', '{"x":1e+}',
    '{"x":NaN}', '{"x":Infinity}', '{"x":undefined}', '{"x":True}', '{"x":truex}', '{"x":nullx}',
    '{"x":1,}', '{,"x":1}', '{"x" 1}', '{x:1}', '{"x":[1,]}', '{"x":[,1]}', '{"x":[1 2]}',
    '{"x":1 "y":2}', '{}{}', '{} synthetic-sensitive', '{"x":/*comment*/1}', '{"x":1', '{"x":[1}']) {
    await failure(readBoundedJson(request(body)), "BODY_INVALID");
  }
});

test("container nesting is bounded at depth twelve with the root counted as one", async () => {
  const nested = (depth: number) => '{"x":'.repeat(depth) + "0" + "}".repeat(depth);
  assert.ok(await readBoundedJson(request(nested(12))));
  await failure(readBoundedJson(request(nested(13))), "BODY_INVALID");
  assert.ok(await readBoundedJson(request('{"x":' + "[".repeat(11) + "0" + "]".repeat(11) + "}")));
  await failure(readBoundedJson(request('{"x":' + "[".repeat(12) + "0" + "]".repeat(12) + "}")), "BODY_INVALID");
});

test("the global 256-node cap counts containers and values across sibling subtrees", async () => {
  const members = (count: number) => "{" + Array.from({ length: count }, (_, index) => `"k${index}":0`).join(",") + "}";
  assert.ok(await readBoundedJson(request(members(255))));
  await failure(readBoundedJson(request(members(256))), "BODY_INVALID");
  assert.ok(await readBoundedJson(request(JSON.stringify({ values: Array(254).fill(null) }))));
  await failure(readBoundedJson(request(JSON.stringify({ values: Array(255).fill(null) }))), "BODY_INVALID");
  await failure(readBoundedJson(request(JSON.stringify({ a: Array(127).fill(null), b: Array(127).fill(null) }))), "BODY_INVALID");
});

test("stream failures and non-byte chunks produce fixed data-free errors and release locks", async () => {
  const errored = request(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("synthetic-sensitive")); } }));
  await failure(readBoundedJson(errored), "BODY_INVALID");
  assert.equal(errored.body!.locked, false);
  for (const chunk of ["{}", new Uint16Array([123, 125]), null, undefined]) {
    const input = request(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(chunk as unknown as Uint8Array);
      controller.close();
    } }));
    await failure(readBoundedJson(input), "BODY_INVALID");
    assert.equal(input.body!.locked, false);
  }
});

test("pre-aborted request and additional signals reject without exposing their reasons", async () => {
  for (const useRequestSignal of [true, false]) {
    const controller = new AbortController();
    controller.abort(new Error("synthetic-sensitive"));
    const input = useRequestSignal ? new Request(request("{}"), { signal: controller.signal }) : request("{}");
    await failure(readBoundedJson(input, useRequestSignal ? {} : { signal: controller.signal }), "BODY_ABORTED");
  }
});

test("either signal can abort a pending read and cancellation never holds the result open", { timeout: 2000 }, async () => {
  for (const useRequestSignal of [true, false]) {
    const controller = new AbortController();
    let cancelled = 0;
    const input = request(pending(() => { cancelled++; return new Promise<void>(() => {}); }));
    const scoped = useRequestSignal ? new Request(input, { signal: controller.signal }) : input;
    const task = readBoundedJson(scoped, { timeoutMs: 1000, ...(useRequestSignal ? {} : { signal: controller.signal }) });
    const timer = setTimeout(() => controller.abort("synthetic-sensitive"), 10);
    try { await failure(task, "BODY_ABORTED"); } finally { clearTimeout(timer); }
    assert.equal(cancelled, 1);
    assert.equal(scoped.body!.locked, false);
  }
});

test("a never-settling read and cancel time out while cancelling exactly once and releasing the lock", { timeout: 2000 }, async () => {
  let cancelled = 0;
  const input = request(pending(() => { cancelled++; return new Promise<void>(() => {}); }));
  await failure(readBoundedJson(input, { timeoutMs: 20 }), "BODY_TIMEOUT");
  assert.equal(cancelled, 1);
  assert.equal(input.body!.locked, false);
});

test("a rejected cancel is handled on timeout and cannot leak its error", { timeout: 2000 }, async () => {
  let cancelled = 0;
  const input = request(pending(() => { cancelled++; return Promise.reject(new Error("synthetic-sensitive")); }));
  await failure(readBoundedJson(input, { timeoutMs: 20 }), "BODY_TIMEOUT");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled, 1);
  assert.equal(input.body!.locked, false);
});

test("abort during a partial UTF-8 character is an abort rather than an exposed decode failure", { timeout: 2000 }, async () => {
  const abort = new AbortController();
  let cancelled = 0;
  const input = request(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array([...encoder.encode('{"x":"'), 0xf0, 0x9f]));
  }, cancel() { cancelled++; } }));
  const task = readBoundedJson(input, { signal: abort.signal, timeoutMs: 1000 });
  const timer = setTimeout(() => abort.abort(), 10);
  try { await failure(task, "BODY_ABORTED"); } finally { clearTimeout(timer); }
  assert.equal(cancelled, 1);
});

test("an endless stream of empty chunks cannot starve timeout or external abort", { timeout: 2000 }, async () => {
  for (const abortFirst of [false, true]) {
    let cancelled = 0;
    const controller = new AbortController();
    const input = request(new ReadableStream<Uint8Array>({ pull(stream) { stream.enqueue(new Uint8Array()); }, cancel() { cancelled++; } }));
    const task = readBoundedJson(input, { timeoutMs: abortFirst ? 1000 : 20, signal: controller.signal });
    const timer = abortFirst ? setTimeout(() => controller.abort(), 10) : undefined;
    try { await failure(task, abortFirst ? "BODY_ABORTED" : "BODY_TIMEOUT"); } finally { clearTimeout(timer); }
    assert.equal(cancelled, 1);
    assert.equal(input.body!.locked, false);
  }
});

test("listeners are removed after success, invalid input, abort and timeout", { timeout: 2000 }, async () => {
  for (const outcome of ["success", "invalid", "abort", "timeout"]) {
    const controller = new AbortController();
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    let added = 0;
    let removed = 0;
    Object.defineProperty(signal, "addEventListener", { value: (...args: Parameters<typeof add>) => { added++; add(...args); } });
    Object.defineProperty(signal, "removeEventListener", { value: (...args: Parameters<typeof remove>) => { removed++; remove(...args); } });
    const input = request(outcome === "success" ? "{}" : outcome === "invalid" ? "{" : pending());
    // Only the timeout case needs a short deadline; the others verify cleanup under suite load.
    const timeoutMs = outcome === "timeout" ? 20 : 1000;
    const task = readBoundedJson(input, { signal, timeoutMs });
    if (outcome === "abort") controller.abort();
    if (outcome === "success") assert.deepEqual(await task, {});
    else await failure(task, outcome === "invalid" ? "BODY_INVALID" : outcome === "abort" ? "BODY_ABORTED" : "BODY_TIMEOUT");
    assert.equal(added, 1);
    assert.equal(removed, 1);
    assert.equal(input.body!.locked, false);
  }
});

test("the listener-registration race is closed by rechecking the signals before reading", async () => {
  const controller = new AbortController();
  const add = controller.signal.addEventListener.bind(controller.signal);
  Object.defineProperty(controller.signal, "addEventListener", { value: (...args: Parameters<typeof add>) => {
    controller.abort("synthetic-sensitive");
    add(...args);
  } });
  let cancelled = 0;
  const input = request(pending(() => { cancelled++; }));
  await failure(readBoundedJson(input, { signal: controller.signal }), "BODY_ABORTED");
  assert.equal(cancelled, 1);
  assert.equal(input.body!.locked, false);
});
