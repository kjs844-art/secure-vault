import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { createReviewClient, createReviewGetRequest, createReviewPreviewRequest, createReviewListRequest,
  MAX_REVIEW_RESPONSE_BODY_BYTES, type ReviewClientConfig, type ReviewViewContext } from "../src/domain/review-client/index.ts";
import { createReviewPreviewDemoData } from "../src/lib/review-preview-demo-data.ts";

// Synthetic Fetch objects/streams only. Actual HTTP is tested separately.
const ORIGIN = "https://synthetic.invalid", NOW = 1790000000000;
const A = Object.freeze({ viewScope: "synthetic-view-a", dataGeneration: 1 });
const B = Object.freeze({ viewScope: "synthetic-view-b", dataGeneration: 1 });
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" };
const tombstone = { schema: "keyatlas.reviewed-benefit-view.v1", dataGeneration: 1,
  benefitId: "synthetic-benefit", benefitRevision: 2, outcome: "deleted", content: null };
const envelope = { ok: true, value: tombstone };
const get = () => createReviewGetRequest(tombstone.benefitId);
const json = (value: unknown = envelope, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { ...headers, ...extra } });
function barrier<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(respond: ReviewClientConfig["fetch"] = async () => json(), overrides: Partial<ReviewClientConfig> = {}) {
  let context: ReviewViewContext | null = A;
  const calls: Array<{ request: Request; signal: AbortSignal }> = [];
  const client = createReviewClient({ origin: ORIGIN, now: () => NOW, readViewContext: () => context,
    fetch: async (request, signal) => { calls.push({ request, signal }); return respond(request, signal); }, ...overrides });
  return { client, calls, setContext: (value: ReviewViewContext | null) => { context = value; } };
}

for (const origin of ["", "ftp://synthetic.invalid", "http://synthetic.invalid", "https://u:p@synthetic.invalid",
  "https://synthetic.invalid/", "https://synthetic.invalid/path", "https://synthetic.invalid?q=1", "https://synthetic.invalid#x"]) {
  test(`configuration rejects origin ${origin}`, () => assert.throws(() => fixture(undefined, { origin }), /REVIEW_CLIENT_CONFIG_INVALID/));
}
for (const timeoutMs of [null, 0, -1, 0.5, 10001, NaN, Infinity]) test(`configuration rejects timeout ${timeoutMs}`, () => {
  assert.throws(() => fixture(undefined, { timeoutMs: timeoutMs as never }), /REVIEW_CLIENT_CONFIG_INVALID/);
});
test("configuration snapshots trusted ports and rejects invalid port types", async () => {
  for (const patch of [{ fetch: null }, { readViewContext: null }, { now: null }]) {
    assert.throws(() => fixture(undefined, patch as never), /REVIEW_CLIENT_CONFIG_INVALID/);
  }
  for (const origin of ["http://localhost:4317", "http://127.0.0.1:4317", "http://[::1]:4317", ORIGIN]) {
    assert.equal((await fixture(undefined, { origin }).client(get())).kind, "success");
  }
});
test("exact POST transport policy and original captured context are retained", async () => {
  let body = "";
  const f = fixture(async (request) => { body = await request.text(); return json(); });
  const result = await f.client(get());
  assert.ok(result.kind === "success" && result.success.kind === "view");
  assert.deepEqual(result.capturedScope, A); assert.deepEqual(result.success.view, tombstone);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.capturedScope));
  const { request, signal } = f.calls[0]!;
  assert.equal(request.url, ORIGIN + "/api/review/get"); assert.equal(request.method, "POST");
  assert.equal(request.headers.get("x-keyatlas-request"), "review-v1");
  assert.equal(request.headers.get("authorization"), null); assert.equal(request.headers.get("cookie"), null);
  assert.equal(request.headers.get("origin"), null, "native browser supplies its origin; module must not forge it");
  assert.equal(request.credentials, "same-origin"); assert.equal(request.redirect, "error");
  assert.equal(request.cache, "no-store"); assert.equal(request.referrerPolicy, "no-referrer");
  assert.deepEqual(JSON.parse(body), { benefitId: tombstone.benefitId });
  assert.equal(signal.aborted, true, "owned signal is finished, not proof of server rollback");
});
test("invalid inputs, foreign cursor generation and fake signal never invoke transport", async () => {
  const f = fixture();
  for (const request of [null, {}, { action: "get", body: { benefitId: tombstone.benefitId, ownerId: "hidden" } }]) {
    assert.deepEqual(await f.client(request as never), { kind: "invalid", reason: "REQUEST" });
  }
  assert.deepEqual(await f.client(createReviewListRequest(50, { afterId: "a", benefitCollectionRevision: 1, dataGeneration: 2 })),
    { kind: "invalid", reason: "REQUEST" });
  assert.deepEqual(await f.client(get(), {} as AbortSignal), { kind: "invalid", reason: "REQUEST" });
  assert.equal(f.calls.length, 0);
});
test("same-object retry cannot change action/body or cross a scope after a failed attempt", async () => {
  const f = fixture(async () => { throw new Error("synthetic-private-network-detail"); });
  const mutable = { action: "get" as const, body: { benefitId: tombstone.benefitId } };
  assert.deepEqual(await f.client(mutable), { kind: "network" });
  mutable.body.benefitId = "synthetic-other";
  assert.deepEqual(await f.client(mutable), { kind: "invalid", reason: "REQUEST" });
  mutable.body.benefitId = tombstone.benefitId;
  f.setContext(B);
  assert.deepEqual(await f.client(mutable), { kind: "stale" });
  assert.equal(f.calls.length, 1);
});
test("in-flight mutable input changes do not alter the captured wire request or response binding", async () => {
  const gate = barrier<Response>(), entered = barrier<void>(); let body = "";
  const f = fixture(async (request) => { body = await request.text(); entered.resolve(); return gate.promise; });
  const mutable = { action: "get" as const, body: { benefitId: tombstone.benefitId } };
  const pending = f.client(mutable); await entered.promise;
  mutable.body.benefitId = "synthetic-replaced"; gate.resolve(json());
  const result = await pending; assert.equal(result.kind, "success");
  assert.equal(JSON.parse(body).benefitId, tombstone.benefitId);
  assert.deepEqual(await f.client(mutable), { kind: "invalid", reason: "REQUEST" }); assert.equal(f.calls.length, 1);
});
for (const response of ["success", "error", "rejection"] as const) test(`old scope ${response} is stale, not current-view data/error`, async () => {
  const gate = barrier<Response>(), entered = barrier<void>();
  const f = fixture(async () => { entered.resolve(); return gate.promise; });
  const pending = f.client(get()); await entered.promise; f.setContext(B);
  if (response === "rejection") gate.reject(new Error("synthetic-private-error"));
  else gate.resolve(response === "success" ? json() : json({ ok: false, code: "API_CONFLICT" }, 409));
  assert.deepEqual(await pending, { kind: "stale" }); assert.equal(f.calls[0]!.signal.aborted, true);
});
test("snapshot reflection that revokes scope cannot cause a network request", async () => {
  const f = fixture(); const request = new Proxy(get(), { ownKeys(target) { f.setContext(null); return Reflect.ownKeys(target); } });
  assert.deepEqual(await f.client(request), { kind: "stale" }); assert.equal(f.calls.length, 0);
});
for (const time of [-0, -1, NaN, Infinity, 0.5, 253402300800000]) test(`invalid clock ${time} denies payload before network`, async () => {
  const f = fixture(undefined, { now: () => time });
  assert.deepEqual(await f.client(get()), { kind: "invalid", reason: "CLOCK" }); assert.equal(f.calls.length, 0);
});
test("one-off throwing clock remains CLOCK rather than a fictitious network error", async () => {
  let calls = 0;
  const f = fixture(undefined, { now: () => { if (++calls === 1) throw new Error("synthetic-private-clock"); return NOW; } });
  assert.deepEqual(await f.client(get()), { kind: "invalid", reason: "CLOCK" }); assert.equal(f.calls.length, 0);
});
test("clock rollback after response cannot return a saved observation", async () => {
  let time = NOW;
  const f = fixture(async () => { time--; return json(); }, { now: () => time });
  assert.deepEqual(await f.client(get()), { kind: "invalid", reason: "CLOCK" });
});
test("clock callback changing view context fences delivery", async () => {
  let invalidate = false; let context: ReviewViewContext = A;
  const f = fixture(async () => { invalidate = true; return json(); }, {
    readViewContext: () => context, now: () => { if (invalidate) context = B; return NOW; },
  });
  assert.deepEqual(await f.client(get()), { kind: "stale" });
});
test("final preview delivery checks expiry separately from the monotonic request timeout", async () => {
  const preview = createReviewPreviewDemoData("corrected-zero", NOW, 1);
  const request = createReviewPreviewRequest("synthetic-candidate", 1, preview.content.serviceId, 1, preview.content.values);
  let reads = 0;
  assert.equal((await fixture(async () => json({ ok: true, value: preview }), { now: () => { reads++; return NOW; } }).client(request)).kind, "success");
  const finalRead = reads; assert.ok(finalRead > 4);
  for (const offset of [-1, 0]) {
    let clockReads = 0;
    const f = fixture(async () => json({ ok: true, value: preview }), {
      now: () => ++clockReads >= finalRead ? preview.expiresAt + offset : NOW,
    });
    const result = await f.client(request);
    assert.equal(clockReads, finalRead);
    if (offset < 0) assert.equal(result.kind, "success");
    else assert.deepEqual(result, { kind: "invalid", reason: "ENVELOPE" });
    assert.equal(f.calls.length, 1);
  }
});
for (const patch of [{ "content-type": "text/html" }, { "cache-control": "private" }, { "set-cookie": "synthetic=1" },
  { "content-length": "-1" }, { "content-length": "1048577" }]) test(`invalid response header ${JSON.stringify(patch)}`, async () => {
  const f = fixture(async () => json(envelope, 200, patch));
  assert.deepEqual(await f.client(get()), { kind: "invalid", reason: "HEADERS" });
});
test("off-target response and redirected fixture are rejected without reading body", async () => {
  for (const [field, value] of [["url", "https://other.invalid/api/review/get"], ["redirected", true]] as const) {
    const response = json(); Object.defineProperty(response, field, { value });
    const f = fixture(async () => response);
    assert.deepEqual(await f.client(get()), { kind: "invalid", reason: "HEADERS" }); assert.equal(response.bodyUsed, true);
  }
});
for (const body of [new Uint8Array([255]), new Uint8Array([239, 187, 191, 123, 125]), "not-json", "null", "[]"]) {
  test(`invalid UTF8/JSON/envelope ${String(body)}`, async () => {
    const f = fixture(async () => new Response(body, { headers }));
    const result = await f.client(get()); assert.equal(result.kind, "invalid");
  });
}
test("actual decoded response bytes are capped and identity Content-Length must agree", async () => {
  for (const response of [new Response(new Uint8Array(MAX_REVIEW_RESPONSE_BODY_BYTES + 1), { headers }),
    json(envelope, 200, { "content-length": "1" })]) {
    const f = fixture(async () => response);
    assert.deepEqual(await f.client(get()), { kind: "invalid", reason: "BODY" }); assert.equal(response.body!.locked, false);
  }
  const f = fixture(async () => json(envelope, 200, { "content-length": "1", "content-encoding": "gzip" }));
  assert.equal((await f.client(get())).kind, "success", "adapter provides native-Fetch-style decompressed bytes");
});
test("error codes require matching HTTP status and 429 is guidance, never automatic retry", async () => {
  const f = fixture(async () => json({ ok: false, code: "API_RATE_LIMITED" }, 429, { "retry-after": "3" }));
  assert.deepEqual(await f.client(get()), { kind: "error", code: "API_RATE_LIMITED", retriableAfterMs: 3000 });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await fixture(async () => json({ ok: false, code: "API_CONFLICT" }, 503)).client(get()), { kind: "invalid", reason: "ENVELOPE" });
  for (const retry of ["", "0", "61", "1.5", "tomorrow"]) {
    assert.deepEqual(await fixture(async () => json({ ok: false, code: "API_RATE_LIMITED" }, 429, { "retry-after": retry })).client(get()),
      { kind: "invalid", reason: "HEADERS" });
  }
});
for (const ending of ["resolve", "reject"] as const) test(`aborted pending transport handles late ${ending} and cleans caller listener`, async () => {
  const gate = barrier<Response>(), entered = barrier<void>(), abort = new AbortController(); let cancelled = 0;
  const f = fixture(async () => { entered.resolve(); return gate.promise; });
  const pending = f.client(get(), abort.signal); await entered.promise; abort.abort("synthetic-private-abort");
  assert.deepEqual(await pending, { kind: "aborted" }); assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  if (ending === "resolve") gate.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers }));
  else gate.reject(new Error("synthetic-private-late-error"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, ending === "resolve" ? 1 : 0); assert.equal(f.calls.length, 1);
});
test("caller cancellation during pending body releases reader without awaiting uncooperative cancel", async () => {
  const entered = barrier<void>(), abort = new AbortController(); let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ pull() { entered.resolve(); return new Promise(() => {}); },
    cancel() { cancelled++; return new Promise(() => {}); } }, { highWaterMark: 0 });
  const f = fixture(async () => new Response(body, { headers }));
  const pending = f.client(get(), abort.signal); await entered.promise; abort.abort();
  assert.deepEqual(await pending, { kind: "aborted" }); assert.equal(body.locked, false); assert.equal(cancelled, 1);
});
test("whole-request timeout covers body and pending transport without automatic retry", async () => {
  for (const phase of ["transport", "body"]) {
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } }, { highWaterMark: 0 });
    const f = fixture(async () => phase === "transport" ? new Promise(() => {}) : new Response(body, { headers }), { timeoutMs: 20 });
    assert.deepEqual(await f.client(get()), { kind: "timeout" }); assert.equal(f.calls.length, 1); assert.equal(body.locked, false);
  }
});
test("immediate empty chunks yield to cancellation before the defensive pull cap", async () => {
  const abort = new AbortController(); let pulls = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (++pulls === 1) timer = setTimeout(() => abort.abort(), 0);
    if (pulls > 257) { controller.error(new Error("synthetic-yield-missing")); return; }
    controller.enqueue(new Uint8Array());
  } }, { highWaterMark: 0 });
  try {
    const f = fixture(async () => new Response(body, { headers }), { timeoutMs: 1000 });
    assert.deepEqual(await f.client(get(), abort.signal), { kind: "aborted" });
    assert.ok(pulls >= 64 && pulls <= 257); assert.equal(body.locked, false);
  } finally { if (timer !== undefined) clearTimeout(timer); }
});
test("stream wait listeners stay bounded and cleanup does not retain the caller", async () => {
  const bytes = new Uint8Array(1024).fill(32); bytes.set(new TextEncoder().encode(JSON.stringify(envelope)));
  const abort = new AbortController(); let offset = 0, peak = 0, baseline = 0; let signal!: AbortSignal;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    peak = Math.max(peak, getEventListeners(signal, "abort").length);
    if (offset === bytes.length) controller.close(); else controller.enqueue(bytes.subarray(offset, ++offset));
  } }, { highWaterMark: 0 });
  const f = fixture(async (_request, transportSignal) => { signal = transportSignal;
    baseline = getEventListeners(signal, "abort").length; return new Response(body, { headers }); });
  assert.equal((await f.client(get(), abort.signal)).kind, "success");
  assert.ok(peak <= baseline + 1); assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  assert.equal(signal.aborted, true); assert.equal(body.locked, false); assert.equal(offset, bytes.length);
});
