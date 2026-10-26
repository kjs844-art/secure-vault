import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCatalogClient, createCatalogGetRequest, MAX_CATALOG_RESPONSE_BODY_BYTES, CATALOG_VIEW_SCHEMA,
  type CatalogTransport,
} from "../src/domain/catalog-client/client.ts";

// Synthetic in-memory Fetch streams; no network, accounts, storage or secrets.
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" };
const SYNTHETIC_CONTEXT = Object.freeze({ viewScope: "synthetic-stream-view", dataGeneration: 1 });
const encoder = new TextEncoder();
const payload = JSON.stringify({ ok: true, value: {
  schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, serviceId: "svc-1", serviceRevision: 1,
  state: "live", profile: { name: "합성 서비스", provider: null, planName: null, accountLabel: null,
    timezone: "Asia/Seoul", subscriptionStatus: "active", trialEndsAt: null, notes: null },
  createdAt: 1, updatedAt: 1, provenance: "user-reported", accountProof: "not-established",
} });
function call(fetch: CatalogTransport, timeoutMs = 10000) {
  return createCatalogClient({ origin: "https://synthetic.invalid", fetch, timeoutMs,
    readViewContext: () => SYNTHETIC_CONTEXT })(createCatalogGetRequest("svc-1"));
}

test("stream: reject oversized chunk before requesting the tail and cancel the source", async () => {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls === 1) controller.enqueue(new Uint8Array(MAX_CATALOG_RESPONSE_BODY_BYTES + 1));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  assert.deepEqual(await call(async () => new Response(stream, { headers: HEADERS })), { kind: "invalid", reason: "BODY" });
  assert.equal(pulls, 1);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("stream: a small Content-Length cannot bypass the decoded body cap", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(MAX_CATALOG_RESPONSE_BODY_BYTES + 1)); },
    cancel() { cancelled = true; },
  });
  const result = await call(async () => new Response(stream, { headers: { ...HEADERS, "content-length": "1" } }), 100);
  assert.deepEqual(result, { kind: "invalid", reason: "BODY" });
  assert.equal(cancelled, true);
});

test("stream: invalid UTF-8 returns BODY instead of rejecting the client promise", async () => {
  const result = await call(async () => new Response(new Uint8Array([0xc3, 0x28]), { headers: HEADERS }));
  assert.deepEqual(result, { kind: "invalid", reason: "BODY" });
});

test("stream: a body read rejection returns BODY without leaking its message", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("synthetic-body-failure")); } });
  assert.deepEqual(await call(async () => new Response(stream, { headers: HEADERS })), { kind: "invalid", reason: "BODY" });
  assert.equal(stream.locked, false);
});

test("stream: deadline during body read returns timeout even if the source ignores abort", { timeout: 3000 }, async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  assert.deepEqual(await call(async () => new Response(stream, { headers: HEADERS }), 50), { kind: "timeout" });
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("stream: abort-aware body failures at the deadline are still timeouts", { timeout: 3000 }, async () => {
  const result = await call(async (_request, signal) => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      signal.addEventListener("abort", () => controller.error(new Error("synthetic-abort")), { once: true });
    } });
    return new Response(stream, { headers: HEADERS });
  }, 50);
  assert.deepEqual(result, { kind: "timeout" });
});

test("stream: a never-settling transport cannot defeat the deadline", { timeout: 3000 }, async () => {
  assert.deepEqual(await call(() => new Promise<Response>(() => {}), 50), { kind: "timeout" });
});

test("stream: late transport responses are discarded after timeout", { timeout: 3000 }, async () => {
  let deliver!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { deliver = resolve; });
  assert.deepEqual(await call(() => pending, 50), { kind: "timeout" });
  let cancelled = false;
  deliver(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: HEADERS }));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
});

test("stream: rejected headers dispose of an unread body", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  assert.deepEqual(await call(async () => new Response(stream, { headers: { ...HEADERS, "content-type": "text/html" } })),
    { kind: "invalid", reason: "HEADERS" });
  assert.equal(cancelled, true);
});

test("stream: cancelling a hostile source must not hold the result open", { timeout: 3000 }, async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(MAX_CATALOG_RESPONSE_BODY_BYTES + 1)); },
    cancel() { return new Promise<void>(() => {}); },
  });
  assert.deepEqual(await call(async () => new Response(stream, { headers: HEADERS }), 100), { kind: "invalid", reason: "BODY" });
  assert.equal(stream.locked, false);
});

test("stream: split UTF-8 and exactly capped bodies remain valid", async () => {
  const encoded = encoder.encode(payload);
  const bytes = new Uint8Array(MAX_CATALOG_RESPONSE_BODY_BYTES).fill(0x20);
  bytes.set(encoded);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    const end = Math.min(bytes.length, offset < encoded.length ? offset + 1 : offset + 65536);
    controller.enqueue(bytes.subarray(offset, end));
    offset = end;
  } }, { highWaterMark: 0 });
  const result = await call(async () => new Response(stream, { headers: { ...HEADERS, "content-length": String(bytes.length) } }));
  assert.equal(result.kind, "success");
});

test("stream: identity Content-Length mismatch is invalid, decoded compressed length is independent", async () => {
  assert.deepEqual(await call(async () => new Response(payload, { headers: { ...HEADERS, "content-length": "1" } })),
    { kind: "invalid", reason: "BODY" });
  const compressed = await call(async () => new Response(payload, {
    headers: { ...HEADERS, "content-length": "1", "content-encoding": "gzip" },
  }));
  assert.equal(compressed.kind, "success");
});

test("stream: an immediate empty-chunk loop yields before the controlled deadline", { timeout: 3000 }, async (t) => {
  let cancelled = false;
  let heartbeatRan = false;
  let pulls = 0;
  let logicalNow = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  t.mock.method(performance, "now", () => logicalNow);
  // This test proves event-loop yielding, not a real 50ms scheduling guarantee.
  // Under load the old real deadline could expire before any heartbeat, which
  // was a valid timeout but falsely failed this test. Other tests use real time.
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls === 1) timer = setTimeout(() => { heartbeatRan = true; logicalNow = 10000; }, 0);
      // If the product stops yielding, fail finitely rather than creating an
      // infinite microtask loop that also starves the test runner's watchdog.
      if (pulls > 256) controller.error(new Error("synthetic-stream-did-not-yield"));
      else controller.enqueue(new Uint8Array(0));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  try {
    assert.deepEqual(await call(async () => new Response(stream, { headers: HEADERS })), { kind: "timeout" });
    assert.equal(heartbeatRan, true);
    assert.ok(pulls > 0 && pulls <= 256);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  } finally { if (timer !== undefined) clearTimeout(timer); }
});

test("stream: cumulative overflow cancels before pulling any trailing bytes", async () => {
  let pulls = 0;
  let cancelled = false;
  const half = MAX_CATALOG_RESPONSE_BODY_BYTES / 2;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(pulls <= 2 ? half : 1));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  assert.deepEqual(await call(async () => new Response(stream, { headers: HEADERS })),
    { kind: "invalid", reason: "BODY" });
  assert.equal(pulls, 3);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("stream: a valid JSON prefix without end-of-body cannot become success", { timeout: 3000 }, async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(payload)); },
    cancel() { cancelled = true; },
  });
  assert.deepEqual(await call(async () => new Response(stream, { headers: HEADERS }), 50),
    { kind: "timeout" });
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("stream: rejected source cancellation is handled without changing the result", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(MAX_CATALOG_RESPONSE_BODY_BYTES + 1)); },
    cancel() { cancelled = true; return Promise.reject(new Error("synthetic-cancel-failure")); },
  });
  assert.deepEqual(await call(async () => new Response(stream, { headers: HEADERS })),
    { kind: "invalid", reason: "BODY" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("stream: a late transport rejection stays handled after the timeout result", { timeout: 3000 }, async () => {
  let rejectTransport!: (reason: Error) => void;
  const pending = new Promise<Response>((_resolve, reject) => { rejectTransport = reject; });
  assert.deepEqual(await call(() => pending, 50), { kind: "timeout" });
  rejectTransport(new Error("synthetic-late-transport-failure"));
  // node:test reports unhandled rejections; allow the rejection turn to complete.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});
