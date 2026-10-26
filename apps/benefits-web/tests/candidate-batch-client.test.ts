import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { createCandidateBatchClient, MAX_CANDIDATE_BATCH_RESPONSE_BYTES,
  type CandidateBatchClientConfig, type CandidateBatchContext } from "../src/domain/candidate-batch-client.ts";

// Native synthetic Request/Response/streams only; no real provider/auth/HTTP.
const NOW = 1790000000000, ORIGIN = "https://synthetic.invalid";
const A = Object.freeze({ bindingId: "synthetic-view-A", dataGeneration: 1, batchReference: "synthetic-batch" });
const B = Object.freeze({ ...A, bindingId: "synthetic-view-B" });
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" };
const candidate = { candidateId: "synthetic-candidate", candidateRevision: 1, state: "pending", accessExpiresAt: NOW + 1000,
  content: { serviceName: "합성 서비스 😀", extractionConfidence: "low", values: { name: null, kind: "credit", unit: "credits",
    grantedAmount: 10, remainingAmount: 0, trialDaysStated: null, remainingDaysStated: 0, expiresAt: "2028-02-29",
    observedAt: "2026-09-27T12:34:56.123456789+09:00" }, receivedAt: null, extractedAt: new Date(NOW).toISOString(),
  reviewReasons: ["USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED", "RECEIVED_DATE_UNKNOWN"],
  evidenceAvailability: "not-retained", reviewStatus: "pending-review", accountProof: "not-established", currentBalanceProof: "not-established" } };
const batch = { schema: "keyatlas.candidate-batch-view.v1", dataGeneration: 1, candidates: [candidate] };
const envelope = { ok: true, value: { batchReference: A.batchReference, batch } };
const json = (value: unknown = envelope, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { ...HEADERS, ...extra } });
function barrier<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(respond: CandidateBatchClientConfig["fetch"] = async () => json(), patch: Partial<CandidateBatchClientConfig> = {}) {
  let context: CandidateBatchContext | null = A;
  const calls: { request: Request; signal: AbortSignal }[] = [];
  const read = createCandidateBatchClient({ origin: ORIGIN, readContext: () => context, now: () => NOW,
    fetch: async (request, signal) => { calls.push({ request, signal }); return respond(request, signal); }, ...patch });
  return { read, calls, setContext(value: CandidateBatchContext | null) { context = value; } };
}
function frozen(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  assert.ok(Object.isFrozen(input)); for (const value of Object.values(input)) frozen(value);
}

for (const origin of ["", "ftp://synthetic.invalid", "http://synthetic.invalid", "https://u:p@synthetic.invalid",
  ORIGIN + "/", ORIGIN + "/path", ORIGIN + "?query=1", ORIGIN + "#fragment"]) {
  test(`rejects invalid origin ${origin}`, () => assert.throws(() => fixture(undefined, { origin }), { message: "CANDIDATE_BATCH_CLIENT_CONFIG_INVALID" }));
}
for (const timeoutMs of [0, -1, 0.1, 10001, NaN, Infinity, null]) test(`rejects invalid timeout ${timeoutMs}`, () => {
  assert.throws(() => fixture(undefined, { timeoutMs: timeoutMs as never }), { message: "CANDIDATE_BATCH_CLIENT_CONFIG_INVALID" });
});
test("construction is inert, snapshots trusted ports, and supports HTTPS or loopback only", async () => {
  let clocks = 0, contexts = 0, fetches = 0;
  const config = { origin: ORIGIN, now: () => { clocks++; return NOW; }, readContext: () => { contexts++; return A; },
    fetch: async () => { fetches++; return json(); } };
  const read = createCandidateBatchClient(config); assert.deepEqual([clocks, contexts, fetches], [0, 0, 0]);
  config.fetch = async () => { throw new Error("synthetic-private"); };
  assert.equal((await read()).kind, "success"); assert.equal(fetches, 1);
  for (const origin of ["http://localhost:4317", "http://127.0.0.1:4317", "http://[::1]:4317"])
    assert.equal((await fixture(undefined, { origin }).read()).kind, "success");
  for (const patch of [{ fetch: null }, { readContext: null }, { now: null }])
    assert.throws(() => fixture(undefined, patch as never), { message: "CANDIDATE_BATCH_CLIENT_CONFIG_INVALID" });
});
test("one explicit read sends only batchReference and native browser transport policy", async () => {
  let wire = "";
  const caller = new AbortController(), response = json();
  const f = fixture(async (request) => { wire = await request.text(); return response; });
  const result = await f.read(caller.signal); assert.equal(result.kind, "success"); if (result.kind !== "success") return;
  assert.deepEqual(result.context, A); assert.notEqual(result.context, A); assert.deepEqual(result.batch, batch); frozen(result);
  const { request, signal } = f.calls[0]!; assert.equal(f.calls.length, 1);
  assert.equal(request.url, ORIGIN + "/api/inbox/batch"); assert.equal(request.method, "POST");
  assert.equal(request.headers.get("x-keyatlas-request"), "candidate-inbox-v1");
  for (const name of ["authorization", "cookie", "origin", "sec-fetch-site"]) assert.equal(request.headers.get(name), null);
  assert.equal(request.credentials, "same-origin"); assert.equal(request.cache, "no-store");
  assert.equal(request.redirect, "error"); assert.equal(request.referrerPolicy, "no-referrer");
  assert.deepEqual(JSON.parse(wire), { batchReference: A.batchReference }); assert.equal(signal.aborted, false);
  assert.equal(request.signal.aborted, false); assert.equal(response.body!.locked, false);
  assert.equal(response.bodyUsed, true); assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  assert.equal(result.batch.candidates[0]!.content!.values.name, null);
  assert.equal(result.batch.candidates[0]!.content!.values.remainingAmount, 0);
  assert.equal(result.batch.candidates[0]!.content!.values.observedAt, candidate.content.values.observedAt);
  caller.abort();
  assert.equal(signal.aborted, false); assert.equal(request.signal.aborted, false); assert.equal(f.calls.length, 1);
});
test("strict missing/invalid context prevents network and clock reads without invoking accessors", async () => {
  let getters = 0, clocks = 0;
  const accessor = { ...A }; Object.defineProperty(accessor, "batchReference", { enumerable: true, get() { getters++; return A.batchReference; } });
  for (const context of [null, {}, { ...A, extra: true }, { ...A, [Symbol()]: 1 }, { ...A, bindingId: "a\n" },
    { ...A, batchReference: " padded" }, { ...A, dataGeneration: 0 }, { ...A, dataGeneration: 1.1 }, accessor,
    Object.create(A), new Proxy(A, { ownKeys() { throw new Error("synthetic-private"); } })]) {
    const f = fixture(undefined, { readContext: () => context as CandidateBatchContext, now: () => { clocks++; return NOW; } });
    assert.deepEqual(await f.read(), { kind: "stale" }); assert.equal(f.calls.length, 0);
  }
  assert.equal(getters, 0); assert.equal(clocks, 0);
});
test("fake signal is invalid, native already-aborted signal is aborted, overridden getter is ignored", async () => {
  const f = fixture(); assert.deepEqual(await f.read({} as AbortSignal), { kind: "invalid", reason: "REQUEST" });
  const control = new AbortController(); control.abort();
  Object.defineProperty(control.signal, "aborted", { get() { throw new Error("synthetic-private"); } });
  assert.deepEqual(await f.read(control.signal), { kind: "aborted" }); assert.equal(f.calls.length, 0);
});
for (const outcome of ["success", "error", "rejection"] as const) test(`changed context fences delayed ${outcome}`, async () => {
  for (const context of [null, B, { ...A, dataGeneration: 2 }, { ...A, batchReference: "other-batch" }]) {
    const gate = barrier<Response>(), f = fixture(async () => gate.promise);
    const pending = f.read(); assert.equal(f.calls.length, 1); f.setContext(context);
    if (outcome === "rejection") gate.reject(new Error("synthetic-private"));
    else gate.resolve(outcome === "success" ? json() : json({ ok: false, code: "API_CONFLICT" }, 409));
    assert.deepEqual(await pending, { kind: "stale" }); assert.equal(f.calls[0]!.signal.aborted, true);
  }
});
test("a reused mutable context cannot relabel the request or successful response", async () => {
  const scope: { bindingId: string; dataGeneration: number; batchReference: string } = { ...A };
  const gate = barrier<Response>(); let wire = "";
  const f = fixture(async (request) => { wire = await request.text(); return gate.promise; }, { readContext: () => scope });
  const pending = f.read(); scope.batchReference = "other-batch"; gate.resolve(json());
  assert.deepEqual(await pending, { kind: "stale" }); assert.equal(JSON.parse(wire).batchReference, A.batchReference);
});
test("network errors are fixed and retries require another explicit read", async () => {
  let attempts = 0;
  const f = fixture(async () => { if (++attempts === 1) throw new Error("synthetic-private-network"); return json(); });
  assert.deepEqual(await f.read(), { kind: "network" }); assert.equal(attempts, 1);
  assert.equal((await f.read()).kind, "success"); assert.equal(attempts, 2);
});
for (const time of [-0, -1, NaN, Infinity, 0.5, 253402300800000]) test(`invalid wall clock ${time} stops before transport`, async () => {
  const f = fixture(undefined, { now: () => time });
  assert.deepEqual(await f.read(), { kind: "invalid", reason: "CLOCK" }); assert.equal(f.calls.length, 0);
});
test("clock throw and rollback are fixed failures, not transport error", async () => {
  let calls = 0;
  const throwing = fixture(undefined, { now: () => { if (++calls === 1) throw new Error("synthetic-private-clock"); return NOW; } });
  assert.deepEqual(await throwing.read(), { kind: "invalid", reason: "CLOCK" }); assert.equal(throwing.calls.length, 0);
  let time = NOW; const f = fixture(async () => { time--; return json(); }, { now: () => time });
  assert.deepEqual(await f.read(), { kind: "invalid", reason: "CLOCK" });
});
test("clock-triggered context change fences delivery", async () => {
  let scope: CandidateBatchContext | null = A, change = false;
  const f = fixture(async () => { change = true; return json(); }, { readContext: () => scope, now: () => { if (change) scope = B; return NOW; } });
  assert.deepEqual(await f.read(), { kind: "stale" });
  assert.equal(f.calls[0]!.signal.aborted, true);
});
test("final success observer scope/caller changes still fence delivery after listener cleanup", async () => {
  let reads = 0;
  assert.equal((await fixture(undefined, { readContext: () => { reads++; return A; } }).read()).kind, "success");
  const finalRead = reads; assert.ok(finalRead > 5);
  for (const mode of ["scope", "abort"] as const) {
    const caller = new AbortController(); let count = 0, callerListeners = -1, transportAborted: boolean | undefined;
    const f = fixture(undefined, { readContext: () => {
      if (++count === finalRead) {
        callerListeners = getEventListeners(caller.signal, "abort").length;
        transportAborted = f.calls[0]!.signal.aborted;
        if (mode === "scope") return B;
        caller.abort();
      }
      return A;
    } });
    assert.deepEqual(await f.read(caller.signal), { kind: mode === "scope" ? "stale" : "aborted" });
    assert.equal(callerListeners, 0); assert.equal(transportAborted, false);
    assert.equal(f.calls[0]!.signal.aborted, true);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  }
});
test("error cleanup still aborts transport and fences reentrant scope/caller changes", async () => {
  for (const mode of ["scope", "abort"] as const) {
    let scope: CandidateBatchContext | null = A, aborts = 0; const caller = new AbortController();
    const cleanup = fixture(async (_request, signal) => {
      signal.addEventListener("abort", () => { aborts++; if (mode === "scope") scope = B; else caller.abort(); });
      return json({ ok: false, code: "API_CONFLICT" }, 409);
    }, { readContext: () => scope });
    assert.deepEqual(await cleanup.read(caller.signal), { kind: mode === "scope" ? "stale" : "aborted" });
    assert.equal(aborts, 1); assert.equal(cleanup.calls[0]!.signal.aborted, true);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  }
});
test("pending content is redacted at exact final-delivery expiry after final context observation", async () => {
  let reads = 0;
  assert.equal((await fixture(undefined, { readContext: () => { reads++; return A; } }).read()).kind, "success");
  const finalRead = reads; assert.ok(finalRead > 5);
  for (const delta of [-1, 0, 1]) {
    let time = NOW, count = 0;
    const f = fixture(undefined, { readContext: () => {
      if (++count === finalRead) time = candidate.accessExpiresAt + delta;
      return A;
    }, now: () => time });
    const result = await f.read(); assert.equal(result.kind, "success"); if (result.kind !== "success") continue;
    assert.equal(count, finalRead); assert.equal(f.calls[0]!.signal.aborted, false);
    const row = result.batch.candidates[0]!;
    assert.equal(row.state, delta < 0 ? "pending" : "expired"); assert.equal(row.candidateRevision, 1);
    assert.equal(row.accessExpiresAt, candidate.accessExpiresAt);
    if (delta >= 0) { assert.equal(row.content, null); assert.ok(!JSON.stringify(result).includes("합성 서비스")); }
    frozen(result);
  }
  assert.notEqual(candidate.content, null, "redaction cannot erase already-returned copies or mutate the source");
});
test("invalid final-delivery clocks fail and retain failure cleanup after a decoded success", async () => {
  let reads = 0;
  assert.equal((await fixture(undefined, { readContext: () => { reads++; return A; } }).read()).kind, "success");
  const finalRead = reads; assert.ok(finalRead > 5);
  for (const time of [NOW - 1, NaN, Infinity, -0]) {
    let count = 0, final = false;
    const caller = new AbortController();
    const f = fixture(undefined, { readContext: () => { if (++count === finalRead) final = true; return A; },
      now: () => final ? time : NOW });
    assert.deepEqual(await f.read(caller.signal), { kind: "invalid", reason: "CLOCK" });
    assert.equal(final, true); assert.equal(f.calls[0]!.signal.aborted, true);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  }
});
test("last clock read after final context lookup is used for expiry", async () => {
  let reads = 0;
  await fixture(undefined, { readContext: () => { reads++; return A; } }).read();
  const finalRead = reads; assert.ok(finalRead > 5); let count = 0, time = NOW;
  const f = fixture(undefined, { readContext: () => { if (++count === finalRead) time = candidate.accessExpiresAt; return A; }, now: () => time });
  const result = await f.read(); assert.equal(count, finalRead); assert.equal(result.kind, "success");
  if (result.kind === "success") assert.equal(result.batch.candidates[0]!.state, "expired");
});
test("only exact envelope, echoed reference and same generation may return data", async () => {
  for (const value of [null, [], { ...envelope, privateField: true }, { ...envelope, ok: false },
    { ok: true, value: { ...envelope.value, ownerId: "synthetic-private" } },
    { ok: true, value: { ...envelope.value, batchReference: "wrong-batch" } },
    { ok: true, value: { ...envelope.value, batch: { ...batch, dataGeneration: 2 } } },
    { ok: true, value: { ...envelope.value, batch: { ...batch, analysisOperationId: "synthetic-private" } } }]) {
    const f = fixture(async () => json(value));
    assert.deepEqual(await f.read(), { kind: "invalid", reason: "ENVELOPE" });
    assert.equal(f.calls[0]!.signal.aborted, true);
  }
  const terminal = { ...candidate, state: "accepted", content: null };
  const result = await fixture(async () => json({ ok: true, value: { ...envelope.value, batch: { ...batch, candidates: [terminal] } } })).read();
  assert.equal(result.kind, "success"); if (result.kind === "success") assert.deepEqual(result.batch.candidates, [terminal]);
});
for (const patch of [{ "content-type": "text/html" }, { "cache-control": "private" }, { "set-cookie": "synthetic=1" },
  { "content-length": "-1" }, { "content-length": "1.5" }, { "content-length": "1048577" }]) test(`rejects headers ${JSON.stringify(patch)}`, async () => {
  const response = json(envelope, 200, patch);
  assert.deepEqual(await fixture(async () => response).read(), { kind: "invalid", reason: "HEADERS" });
  assert.equal(response.bodyUsed, true);
});
test("response URL/redirect metadata and HTTP status are validated before body", async () => {
  for (const [field, value] of [["url", ORIGIN + "/api/inbox/other"], ["url", "https://other.invalid/api/inbox/batch"],
    ["redirected", true], ["status", 0], ["status", 600]] as const) {
    const response = json(); Object.defineProperty(response, field, { value });
    assert.deepEqual(await fixture(async () => response).read(), { kind: "invalid", reason: field === "status" ? "STATUS" : "HEADERS" });
    assert.equal(response.bodyUsed, true);
  }
  const response = json(); Object.defineProperty(response, "url", { value: ORIGIN + "/api/inbox/batch" });
  assert.equal((await fixture(async () => response).read()).kind, "success");
});
test("actual stream bytes are bounded and identity length must agree; compressed metadata is not decoded length", async () => {
  for (const response of [new Response(new Uint8Array(MAX_CANDIDATE_BATCH_RESPONSE_BYTES + 1), { headers: HEADERS }),
    json(envelope, 200, { "content-length": "1" })]) {
    assert.deepEqual(await fixture(async () => response).read(), { kind: "invalid", reason: "BODY" });
    assert.equal(response.body!.locked, false);
  }
  assert.equal((await fixture(async () => json(envelope, 200, { "content-length": "1", "content-encoding": "gzip" })).read()).kind, "success");
});
for (const invalid of [new Uint8Array([255]), new Uint8Array([239, 187, 191, 123, 125]), "not-json"]) {
  test(`rejects invalid UTF8/JSON ${String(invalid)}`, async () => assert.deepEqual(
    await fixture(async () => new Response(invalid, { headers: HEADERS })).read(), { kind: "invalid", reason: "BODY" }));
}
test("split multibyte stream is decoded only after bounded bytes and releases its reader", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope)); let index = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index)); else controller.close();
  } }), { headers: HEADERS });
  assert.equal((await fixture(async () => response).read()).kind, "success"); assert.equal(response.body!.locked, false);
});
const statuses = { API_NOT_FOUND: 404, API_METHOD_NOT_ALLOWED: 405, API_REQUEST_REJECTED: 403, API_MEDIA_TYPE: 415,
  API_BODY_TOO_LARGE: 413, API_INPUT_INVALID: 400, API_AUTH_REQUIRED: 401, API_SESSION_CHANGED: 403,
  API_RATE_LIMITED: 429, API_CONFLICT: 409, API_UNAVAILABLE: 503, API_TIMEOUT: 408, API_ABORTED: 408 };
test("fixed error vocabulary/status parity, bounded Retry-After, and no automatic retry", async () => {
  for (const [code, status] of Object.entries(statuses)) {
    const f = fixture(async () => json({ ok: false, code }, status, status === 429 ? { "retry-after": "3" } : {}));
    assert.deepEqual(await f.read(), { kind: "error", code, retriableAfterMs: status === 429 ? 3000 : null }); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.signal.aborted, true);
    assert.deepEqual(await fixture(async () => json({ ok: false, code }, 200)).read(), { kind: "invalid", reason: "ENVELOPE" });
  }
  for (const value of [{ ok: false, code: "UNKNOWN" }, { ok: false, code: "API_CONFLICT", detail: "synthetic-private" }, { ok: false, code: "API_CONFLICT" }])
    assert.deepEqual(await fixture(async () => json(value, 503)).read(), { kind: "invalid", reason: "ENVELOPE" });
  for (const retry of ["", "0", "61", "1.5", "tomorrow", "999999999999999999999"]) assert.deepEqual(
    await fixture(async () => json({ ok: false, code: "API_RATE_LIMITED" }, 429, { "retry-after": retry })).read(), { kind: "invalid", reason: "HEADERS" });
  assert.deepEqual(await fixture(async () => json({ ok: false, code: "API_RATE_LIMITED" }, 429)).read(), { kind: "invalid", reason: "HEADERS" });
});
test("monotonic timeout bounds never-settling fetch and cancels a late body without retry", { timeout: 5000 }, async () => {
  const gate = barrier<Response>(), f = fixture(async () => gate.promise, { timeoutMs: 1000 });
  assert.deepEqual(await f.read(), { kind: "timeout" }); assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.signal.aborted, true);
  const cancelled = barrier<void>();
  const late = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled.resolve(); } }), { headers: HEADERS });
  gate.resolve(late); await cancelled.promise; assert.equal(late.bodyUsed, true);
});
test("caller abort bounds stalled stream, cleans listeners/reader and redacts cancel failure", async () => {
  const entered = barrier<void>(), caller = new AbortController(); let cancelled = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull() { entered.resolve(); return new Promise(() => {}); },
    cancel() { cancelled++; throw new Error("synthetic-private-cancel"); } }), { headers: HEADERS });
  const f = fixture(async () => response), pending = f.read(caller.signal); await entered.promise; caller.abort();
  assert.deepEqual(await pending, { kind: "aborted" }); assert.equal(cancelled, 1); assert.equal(response.body!.locked, false);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});
for (const mode of ["caller", "timeout"] as const) test(`complete JSON without EOF still requires ${mode} cancellation`, { timeout: 5000 }, async () => {
  const entered = barrier<void>(), caller = new AbortController(); let pulls = 0, cancelled = 0;
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (++pulls === 1) { controller.enqueue(bytes); return undefined; }
    entered.resolve(); return new Promise<void>(() => {});
  }, cancel() { cancelled++; } }), { headers: { ...HEADERS, "content-length": String(bytes.byteLength) } });
  const f = fixture(async () => response, { timeoutMs: 1000 }), pending = f.read(caller.signal);
  await entered.promise;
  if (mode === "caller") caller.abort();
  assert.deepEqual(await pending, { kind: mode === "caller" ? "aborted" : "timeout" });
  assert.equal(cancelled, 1); assert.equal(response.body!.locked, false); assert.equal(f.calls[0]!.signal.aborted, true);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});
test("an endless immediate empty stream yields so monotonic timeout can fire", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(control) { control.enqueue(new Uint8Array()); }, cancel() { cancelled = true; } }), { headers: HEADERS });
  const f = fixture(async () => response, { timeoutMs: 1000 });
  assert.deepEqual(await f.read(), { kind: "timeout" }); assert.equal(cancelled, true); assert.equal(response.body!.locked, false);
});
