import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { createCandidateDiscardClient, snapshotCandidateDiscardRequest,
  MAX_CANDIDATE_DISCARD_REQUEST_BYTES, MAX_CANDIDATE_DISCARD_RESPONSE_BYTES,
  type CandidateDiscardClientConfig } from "../src/domain/candidate-discard-client.ts";
import type { CandidateBatchContext } from "../src/domain/candidate-batch-client.ts";

const NOW = 1790000000000, ORIGIN = "https://synthetic.invalid";
const CONTEXT = Object.freeze({ bindingId: "synthetic-view", dataGeneration: 1, batchReference: "synthetic-batch" });
const REQUEST = Object.freeze({ batchReference: CONTEXT.batchReference, candidateId: "synthetic-candidate",
  expectedRevision: 1, decision: "discard" as const });
const RECEIPT = Object.freeze({ batchReference: REQUEST.batchReference, candidateId: REQUEST.candidateId,
  candidateRevision: 2, state: "deleted", content: null });
const ENVELOPE = { ok: true, value: RECEIPT };
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" };
const json = (value: unknown = ENVELOPE, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { ...HEADERS, ...extra } });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(respond: CandidateDiscardClientConfig["fetch"] = async () => json(),
  patch: Partial<CandidateDiscardClientConfig> = {}) {
  let context: CandidateBatchContext | null = CONTEXT;
  const calls: { request: Request; signal: AbortSignal }[] = [];
  const client = createCandidateDiscardClient({ origin: ORIGIN, now: () => NOW, readContext: () => context,
    fetch: async (request, signal) => { calls.push({ request, signal }); return respond(request, signal); }, ...patch });
  return { client, calls, setContext(value: CandidateBatchContext | null) { context = value; } };
}
const failure = (kind: string, rest: object = {}, dispatched = true) => ({ kind, ...rest, dispatched });

test("one explicit request carries only the exact immutable discard command and returns a detached minimal receipt", async () => {
  const response = json(), caller = new AbortController(); let wire = "";
  const f = fixture(async (request) => { wire = await request.text(); return response; });
  const result = await f.client(REQUEST, caller.signal);
  assert.deepEqual(result, { kind: "success", context: CONTEXT, receipt: RECEIPT });
  assert.ok(Object.isFrozen(result));
  if (result.kind !== "success") return;
  assert.ok(Object.isFrozen(result.context)); assert.ok(Object.isFrozen(result.receipt));
  assert.notEqual(result.context, CONTEXT); assert.notEqual(result.receipt, RECEIPT);
  assert.equal(f.calls.length, 1); const { request, signal } = f.calls[0]!;
  assert.equal(request.url, ORIGIN + "/api/inbox/discard"); assert.equal(request.method, "POST");
  assert.equal(request.headers.get("x-keyatlas-request"), "candidate-inbox-discard-v1");
  assert.equal(request.credentials, "same-origin"); assert.equal(request.cache, "no-store");
  assert.equal(request.redirect, "error"); assert.equal(request.referrerPolicy, "no-referrer");
  for (const name of ["authorization", "cookie", "origin", "sec-fetch-site"]) assert.equal(request.headers.get(name), null);
  assert.deepEqual(JSON.parse(wire), REQUEST); assert.ok(Buffer.byteLength(wire) <= MAX_CANDIDATE_DISCARD_REQUEST_BYTES);
  assert.equal(signal.aborted, false); assert.equal(response.body!.locked, false);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  caller.abort(); assert.equal(signal.aborted, false);
});
for (const origin of ["", "ftp://synthetic.invalid", "http://synthetic.invalid", "https://u:p@synthetic.invalid",
  ORIGIN + "/", ORIGIN + "/path", ORIGIN + "?query=1", ORIGIN + "#fragment"]) {
  test("invalid origin is rejected: " + origin, () => assert.throws(() => fixture(undefined, { origin }),
    { message: "CANDIDATE_DISCARD_CLIENT_CONFIG_INVALID" }));
}
for (const timeoutMs of [0, -1, 0.1, 10001, NaN, Infinity, null]) {
  test("invalid timeout is rejected: " + String(timeoutMs), () => assert.throws(() => fixture(undefined, { timeoutMs: timeoutMs as never }),
    { message: "CANDIDATE_DISCARD_CLIENT_CONFIG_INVALID" }));
}
test("constructor is inert, snapshots trusted ports and rejects config accessors or extras without calling them", async () => {
  let clocks = 0, contexts = 0, sends = 0, getters = 0;
  const config = { origin: ORIGIN, fetch: async () => { sends++; return json(); },
    now: () => { clocks++; return NOW; }, readContext: () => { contexts++; return CONTEXT; } };
  const client = createCandidateDiscardClient(config); assert.deepEqual([clocks, contexts, sends], [0, 0, 0]);
  config.fetch = async () => { throw new Error("synthetic-private"); };
  assert.equal((await client(REQUEST)).kind, "success"); assert.equal(sends, 1);
  for (const input of [{ ...config, extra: true }, { ...config, get fetch() { getters++; return config.fetch; } },
    new Proxy(config, { ownKeys() { throw new Error("synthetic-private"); } })]) {
    assert.throws(() => createCandidateDiscardClient(input), { message: "CANDIDATE_DISCARD_CLIENT_CONFIG_INVALID" });
  }
  assert.equal(getters, 0);
  for (const origin of ["http://localhost:4317", "http://127.0.0.1:4317", "http://[::1]:4317"])
    assert.equal((await fixture(undefined, { origin }).client(REQUEST)).kind, "success");
});
const badRequests: readonly [string, unknown][] = [
  ["null", null], ["array", []], ["missing", {}], ["extra", { ...REQUEST, content: "synthetic-private" }],
  ["symbol", { ...REQUEST, [Symbol()]: true }], ["wrong decision", { ...REQUEST, decision: "delete" }],
  ["foreign batch", { ...REQUEST, batchReference: "foreign" }], ["padded id", { ...REQUEST, candidateId: " padded" }],
  ["overlong id", { ...REQUEST, candidateId: "x".repeat(129) }], ["zero revision", { ...REQUEST, expectedRevision: 0 }],
  ["negative zero", { ...REQUEST, expectedRevision: -0 }], ["fractional", { ...REQUEST, expectedRevision: 1.1 }],
  ["unsafe", { ...REQUEST, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }],
  ["infinite", { ...REQUEST, expectedRevision: Infinity }], ["prototype", Object.create(REQUEST)],
  ["hidden", Object.defineProperty({ ...REQUEST }, "decision", { enumerable: false })],
];
for (const [name, request] of badRequests) test("request preflight rejects " + name + " without sending", async () => {
  const f = fixture(); assert.deepEqual(await f.client(request), failure("invalid", { reason: "REQUEST" }, false));
  assert.equal(f.calls.length, 0);
});
test("request getters, toJSON and throwing reflection never leak or execute ordinary getters", async () => {
  let calls = 0;
  for (const input of [{ ...REQUEST, get candidateId() { calls++; return REQUEST.candidateId; } },
    { ...REQUEST, toJSON() { calls++; return REQUEST; } }, new Proxy(REQUEST, { ownKeys() { throw new Error("synthetic-private"); } })]) {
    const f = fixture(); assert.deepEqual(await f.client(input), failure("invalid", { reason: "REQUEST" }, false));
    assert.equal(f.calls.length, 0);
  }
  assert.equal(calls, 0);
  const plain = Object.assign(Object.create(null), REQUEST);
  assert.deepEqual(snapshotCandidateDiscardRequest(plain), REQUEST);
});
test("mutable source cannot relabel an in-flight request and max safe revision cannot accept an unsafe ACK", async () => {
  const mutable: { batchReference: string; candidateId: string; expectedRevision: number; decision: "discard" } = { ...REQUEST };
  const gate = deferred<Response>(); let wire = "";
  const f = fixture(async (request) => { wire = await request.text(); return gate.promise; });
  const pending = f.client(mutable); mutable.candidateId = "changed"; mutable.expectedRevision = 99;
  gate.resolve(json()); assert.equal((await pending).kind, "success"); assert.deepEqual(JSON.parse(wire), REQUEST);
  const max = { ...REQUEST, expectedRevision: Number.MAX_SAFE_INTEGER };
  const maxClient = fixture(async () => json({ ok: true, value: { ...RECEIPT, candidateRevision: Number.MAX_SAFE_INTEGER + 1 } }));
  assert.deepEqual(await maxClient.client(max), failure("invalid", { reason: "ENVELOPE" }));
});
test("invalid context is stale before clocks or transport", async () => {
  let getters = 0, clocks = 0;
  for (const context of [null, {}, { ...CONTEXT, extra: true }, { ...CONTEXT, dataGeneration: 0 },
    { ...CONTEXT, get bindingId() { getters++; return CONTEXT.bindingId; } }]) {
    const f = fixture(undefined, { readContext: () => context as CandidateBatchContext, now: () => { clocks++; return NOW; } });
    assert.deepEqual(await f.client(REQUEST), failure("stale", {}, false)); assert.equal(f.calls.length, 0);
  }
  assert.equal(getters, 0); assert.equal(clocks, 0);
});
test("fake signal, pre-abort and invalid preflight clocks explicitly report no dispatch", async () => {
  const f = fixture(); assert.deepEqual(await f.client(REQUEST, {} as AbortSignal), failure("invalid", { reason: "REQUEST" }, false));
  const caller = new AbortController(); caller.abort();
  Object.defineProperty(caller.signal, "aborted", { get() { throw new Error("synthetic-private"); } });
  assert.deepEqual(await f.client(REQUEST, caller.signal), failure("aborted", {}, false)); assert.equal(f.calls.length, 0);
  for (const value of [-1, -0, NaN, Infinity, 0.1, 253402300800000]) {
    const bad = fixture(undefined, { now: () => value });
    assert.deepEqual(await bad.client(REQUEST), failure("invalid", { reason: "CLOCK" }, false)); assert.equal(bad.calls.length, 0);
  }
});
for (const outcome of ["success", "error", "rejection"] as const) test("scope changes fence delayed " + outcome, async () => {
  for (const context of [null, { ...CONTEXT, bindingId: "new" }, { ...CONTEXT, dataGeneration: 2 },
    { ...CONTEXT, batchReference: "foreign" }]) {
    const gate = deferred<Response>(), f = fixture(() => gate.promise), pending = f.client(REQUEST);
    f.setContext(context);
    if (outcome === "rejection") gate.reject(new Error("synthetic-private"));
    else gate.resolve(outcome === "success" ? json() : json({ ok: false, code: "API_CONFLICT" }, 409));
    assert.deepEqual(await pending, failure("stale")); assert.equal(f.calls[0]!.signal.aborted, true);
  }
});
test("adapter throws/rejects after entry are possibly dispatched and never automatically retried", async () => {
  for (const respond of [() => { throw new Error("synthetic-private"); }, async () => { throw new Error("synthetic-private"); }]) {
    const f = fixture(respond); assert.deepEqual(await f.client(REQUEST), failure("network")); assert.equal(f.calls.length, 1);
    await Promise.resolve(); assert.equal(f.calls.length, 1);
  }
});
test("invalid receipt envelopes, different target/revision and private fields never escape", async () => {
  for (const value of [null, [], { ...ENVELOPE, private: "synthetic-private" }, { ok: false, value: RECEIPT },
    { ok: true, value: { ...RECEIPT, replayed: true } }, { ok: true, value: { ...RECEIPT, batchReference: "foreign" } },
    { ok: true, value: { ...RECEIPT, candidateId: "foreign" } }, { ok: true, value: { ...RECEIPT, candidateRevision: 3 } },
    { ok: true, value: { ...RECEIPT, candidateRevision: 1 } }, { ok: true, value: { ...RECEIPT, state: "pending" } },
    { ok: true, value: { ...RECEIPT, content: { private: "synthetic-private" } } }]) {
    const f = fixture(async () => json(value));
    assert.deepEqual(await f.client(REQUEST), failure("invalid", { reason: "ENVELOPE" }));
  }
});
for (const patch of [{ "content-type": "text/html" }, { "cache-control": "private" }, { "set-cookie": "synthetic=1" },
  { "content-length": "-1" }, { "content-length": "1.5" }, { "content-length": "2049" }]) {
  test("invalid response headers stay bounded: " + JSON.stringify(patch), async () => {
    const f = fixture(async () => json(ENVELOPE, 200, patch));
    assert.deepEqual(await f.client(REQUEST), failure("invalid", { reason: "HEADERS" }));
  });
}
test("status and redirect metadata are rejected before receipt read", async () => {
  for (const [field, value] of [["url", ORIGIN + "/api/inbox/batch"], ["url", "https://foreign.invalid"],
    ["redirected", true], ["status", 0], ["status", 600]] as const) {
    const response = json(); Object.defineProperty(response, field, { value });
    assert.deepEqual(await fixture(async () => response).client(REQUEST),
      failure("invalid", { reason: field === "status" ? "STATUS" : "HEADERS" }));
  }
});
test("actual bytes, declared identity length, invalid UTF8 and BOM are bounded and rejected", async () => {
  for (const response of [new Response(new Uint8Array(MAX_CANDIDATE_DISCARD_RESPONSE_BYTES + 1), { headers: HEADERS }),
    json(ENVELOPE, 200, { "content-length": "1" }), new Response(new Uint8Array([255]), { headers: HEADERS }),
    new Response(new Uint8Array([239, 187, 191, 123, 125]), { headers: HEADERS }), new Response("not-json", { headers: HEADERS })]) {
    assert.deepEqual(await fixture(async () => response).client(REQUEST), failure("invalid", { reason: "BODY" }));
    assert.equal(response.body!.locked, false);
  }
  assert.equal((await fixture(async () => json(ENVELOPE, 200, { "content-length": "1", "content-encoding": "gzip" })).client(REQUEST)).kind, "success");
});
const statuses = { API_NOT_FOUND: 404, API_METHOD_NOT_ALLOWED: 405, API_REQUEST_REJECTED: 403, API_MEDIA_TYPE: 415,
  API_BODY_TOO_LARGE: 413, API_INPUT_INVALID: 400, API_AUTH_REQUIRED: 401, API_SESSION_CHANGED: 403,
  API_RATE_LIMITED: 429, API_CONFLICT: 409, API_UNAVAILABLE: 503, API_TIMEOUT: 408, API_ABORTED: 408 };
test("fixed error parity and bounded rate hints do not imply rollback or automatic retry", async () => {
  for (const [code, status] of Object.entries(statuses)) {
    const f = fixture(async () => json({ ok: false, code }, status, status === 429 ? { "retry-after": "3" } : {}));
    assert.deepEqual(await f.client(REQUEST), failure("error", { code, retriableAfterMs: status === 429 ? 3000 : null }));
    assert.equal(f.calls.length, 1);
  }
  for (const value of [{ ok: false, code: "UNKNOWN" }, { ok: false, code: "API_CONFLICT", detail: "synthetic-private" },
    { ok: false, code: "API_CONFLICT" }]) assert.deepEqual(await fixture(async () => json(value, 503)).client(REQUEST),
    failure("invalid", { reason: "ENVELOPE" }));
  for (const retry of ["", "0", "61", "1.5", "tomorrow"])
    assert.deepEqual(await fixture(async () => json({ ok: false, code: "API_RATE_LIMITED" }, 429, { "retry-after": retry })).client(REQUEST),
      failure("invalid", { reason: "HEADERS" }));
});
test("deadline bounds an uncooperative transport and safely cancels a late body", { timeout: 5000 }, async () => {
  const gate = deferred<Response>(), cancelled = deferred<void>(), f = fixture(() => gate.promise, { timeoutMs: 100 });
  assert.deepEqual(await f.client(REQUEST), failure("timeout")); assert.equal(f.calls.length, 1);
  const late = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled.resolve(); } }), { headers: HEADERS });
  gate.resolve(late); await cancelled.promise; assert.equal(late.bodyUsed, true);
});
test("caller abort settles stalled stream and removes listener without claiming rollback", async () => {
  const entered = deferred<void>(), caller = new AbortController(); let cancelled = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull() { entered.resolve(); return new Promise(() => {}); },
    cancel() { cancelled++; throw new Error("synthetic-private"); } }), { headers: HEADERS });
  const f = fixture(async () => response), pending = f.client(REQUEST, caller.signal); await entered.promise; caller.abort();
  assert.deepEqual(await pending, failure("aborted")); assert.equal(cancelled, 1); assert.equal(response.body!.locked, false);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});
test("valid complete JSON is not success until transport EOF", { timeout: 5000 }, async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(ENVELOPE)); let first = true;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (first) { first = false; controller.enqueue(bytes); return; } return new Promise<void>(() => {});
  } }), { headers: { ...HEADERS, "content-length": String(bytes.length) } });
  assert.deepEqual(await fixture(async () => response, { timeoutMs: 100 }).client(REQUEST), failure("timeout"));
  assert.equal(response.body!.locked, false);
});
test("chunked receipt is decoded only after bounded stream completion", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(ENVELOPE)); let index = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index)); else controller.close();
  } }), { headers: HEADERS });
  assert.equal((await fixture(async () => response).client(REQUEST)).kind, "success");
  assert.equal(response.body!.locked, false);
});
test("post-dispatch clock rollback and final clock/context/caller changes fence receipt delivery", async () => {
  let time = NOW;
  const rollback = fixture(async () => { time--; return json(); }, { now: () => time });
  assert.deepEqual(await rollback.client(REQUEST), failure("invalid", { reason: "CLOCK" }));
  let clockReads = 0;
  assert.equal((await fixture(undefined, { now: () => { clockReads++; return NOW; } }).client(REQUEST)).kind, "success");
  for (const mode of ["clock", "context", "abort"] as const) {
    let count = 0, scope: CandidateBatchContext | null = CONTEXT; const caller = new AbortController();
    const f = fixture(undefined, { readContext: () => scope, now: () => {
      if (++count === clockReads) {
        if (mode === "clock") return NOW - 1;
        if (mode === "context") scope = null;
        if (mode === "abort") caller.abort();
      }
      return NOW;
    } });
    assert.deepEqual(await f.client(REQUEST, caller.signal), mode === "clock"
      ? failure("invalid", { reason: "CLOCK" }) : failure(mode === "context" ? "stale" : "aborted"));
    assert.equal(f.calls[0]!.signal.aborted, true);
  }
});
