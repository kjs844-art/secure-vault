import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createInboxHttpHandler } from "../src/server/http/inbox-http.ts";
import { INBOX_HTTP_PATH, INBOX_REQUEST_HEADER, MAX_INBOX_REQUEST_BYTES, MAX_INBOX_REQUEST_MS,
  MAX_INBOX_RESPONSE_BYTES, type InboxAdmissionRequest, type InboxBatchMapping,
  type InboxBatchResolutionRequest, type InboxHttpDependencies, type InboxHttpError } from "../src/server/http/inbox-http-contracts.ts";
import { decodeCandidateBatchDisplay, type CandidateBatchDisplay } from "../src/domain/candidate-batch-view.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import { createCandidateBatchReferences } from "../src/server/inbox/batch-references.ts";
import { createCandidateSelectionFixture } from "./support/candidate-selection-fixture.ts";
import { REVIEW_NOW, REVIEW_OWNER, SYNTHETIC_PRIVATE, analysisAuthority, reviewAuthority, reviewValues } from "./support/review-memory-store.ts";

// Actual runMailAnalysis -> stage/list -> this unmounted Fetch boundary with
// synthetic authority/limiter and serialized memory; alias issuance/resolution
// now use the actual reference controller and atomic staging transaction.
// Not a real network, public route, provider, durable mapping or database proof.
const ORIGIN = "https://inbox.example.test", COOKIE = "synthetic-session=fixture";
const REFERENCE = "synthetic-opaque-batch-reference";
const grant = (r: InboxAdmissionRequest) => ({ allowed: true, surface: r.surface, requestId: r.requestId,
  action: r.action, authority: r.authority, expiresAt: r.notAfter });
async function fixture(overrides: Partial<InboxHttpDependencies> = {}, pendingWindowMs = 86400000) {
  const source = await createCandidateSelectionFixture(REVIEW_NOW, pendingWindowMs, () => REFERENCE), { store } = source;
  assert.equal(source.locator.batchReference, REFERENCE);
  const initial = store.snapshot(), initialGrantReads = [store.controls.analysisChecks, store.controls.stagingGrantReads];
  const mapping: InboxBatchMapping = Object.freeze({ batchReference: REFERENCE, ownerId: REVIEW_OWNER,
    dataGeneration: 1, analysisOperationId: analysisAuthority().operationId });
  const sessions: AbortSignal[] = [], admissions: InboxAdmissionRequest[] = [];
  const resolutions: InboxBatchResolutionRequest[] = [], resolverSignals: AbortSignal[] = [];
  const deps: InboxHttpDependencies = {
    trustedOrigin: ORIGIN, ...overrides,
    now: () => overrides.now ? overrides.now() : store.controls.now,
    newId: () => overrides.newId ? overrides.newId() : store.dependencies.newId(),
    readSession: async (context, signal) => {
      sessions.push(signal); assert.deepEqual(context, { cookie: COOKIE });
      return overrides.readSession ? overrides.readSession(context, signal) : structuredClone(store.controls.authority);
    },
    admit: async (request, signal) => {
      admissions.push(request); return overrides.admit ? overrides.admit(request, signal) : grant(request);
    },
    resolveBatch: async (request, signal) => {
      resolutions.push(request); resolverSignals.push(signal);
      return overrides.resolveBatch ? overrides.resolveBatch(request, signal)
        : source.references.resolve(request, signal);
    },
    transaction: (authority, action) => (overrides.transaction ?? store.referenceDependencies.transaction)(authority, action),
  };
  return { ...source, initial, initialGrantReads, mapping, overrides, deps, sessions, admissions,
    resolutions, resolverSignals, handler: createInboxHttpHandler(deps) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Options = { url?: string; method?: string; headers?: Record<string, string | null>; raw?: BodyInit | null; signal?: AbortSignal };
function request(command: unknown = { batchReference: REFERENCE }, options: Options = {}) {
  const headers = new Headers({ "content-type": "application/json", origin: ORIGIN,
    "x-keyatlas-request": INBOX_REQUEST_HEADER, "sec-fetch-site": "same-origin", cookie: COOKIE });
  for (const [key, value] of Object.entries(options.headers ?? {})) value === null ? headers.delete(key) : headers.set(key, value);
  const method = options.method ?? "POST";
  const init: RequestInit & { duplex?: "half" } = { method, headers, ...(options.signal ? { signal: options.signal } : {}) };
  if (method !== "GET" && method !== "HEAD") {
    init.body = "raw" in options ? options.raw : JSON.stringify(command);
    if (init.body instanceof ReadableStream) init.duplex = "half";
  }
  const result = new Request(options.url ?? `${ORIGIN}${INBOX_HTTP_PATH}`, init);
  for (const [key, value] of Object.entries(options.headers ?? {})) if (value === null) result.headers.delete(key);
  return result;
}
async function body(response: Response) {
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  for (const key of ["set-cookie", "access-control-allow-origin", "access-control-allow-credentials", "authorization", "cookie"])
    assert.equal(response.headers.get(key), null);
  const text = await response.text();
  for (const value of [COOKIE, REVIEW_OWNER, SYNTHETIC_PRIVATE, "synthetic-mailbox", analysisAuthority().operationId,
    "synthetic-selection-mail-not-retained", "Synthetic Service grants 100 credits."]) assert.equal(text.includes(value), false, value);
  for (const key of ["ownerId", "sessionId", "sessionRevision", "analysisOperationId", "mailboxBindingId", "candidateIndex",
    "grantId", "fingerprint", "replayed", "source", "quote"]) assert.equal(text.includes(`"${key}"`), false, key);
  return JSON.parse(text) as Record<string, unknown>;
}
async function success(response: Response) {
  const result = await body(response); assert.equal(response.status, 200, JSON.stringify(result));
  assert.deepEqual(Object.keys(result).sort(), ["ok", "value"]); assert.equal(result.ok, true);
  const value = result.value as { batchReference: string; batch: CandidateBatchDisplay };
  assert.deepEqual(Object.keys(value).sort(), ["batch", "batchReference"]); assert.equal(value.batchReference, REFERENCE);
  assert.deepEqual(decodeCandidateBatchDisplay(value.batch), value.batch); return value.batch;
}
async function failure(response: Response, code: InboxHttpError, status: number) {
  assert.deepEqual(await body(response), { ok: false, code }); assert.equal(response.status, status);
  if (status !== 405) assert.equal(response.headers.get("allow"), null);
  if (status !== 429) assert.equal(response.headers.get("retry-after"), null);
}
function unchanged(f: Fixture) {
  assert.deepEqual(f.store.snapshot(), f.initial);
  assert.deepEqual([f.store.controls.analysisChecks, f.store.controls.stagingGrantReads], f.initialGrantReads);
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}

test("real analysis/stage -> HTTP known batch is minimal, scoped and read-only; every read is admitted", async () => {
  const f = await fixture();
  const first = await success(await f.handler(request())), second = await success(await f.handler(request()));
  assert.deepEqual(first, f.batch); assert.deepEqual(second, first); assert.equal(first.candidates.length, 2);
  assert.equal(first.candidates[0]!.content?.values.name, null);
  assert.equal(first.candidates[0]!.content?.accountProof, "not-established");
  assert.equal(f.admissions.length, 2); assert.equal(f.resolutions.length, 10);
  assert.ok(f.resolutions.every((r) => Object.isFrozen(r) && Object.isFrozen(r.authority)));
  assert.ok(f.resolverSignals.every((signal) => signal.aborted)); unchanged(f);
  assert.equal(MAX_INBOX_REQUEST_BYTES, 1024); assert.equal(MAX_INBOX_RESPONSE_BYTES, 1048576);
  assert.equal(MAX_INBOX_REQUEST_MS, 10000);
});
test("revoked analysis/staging grants and same-owner new login do not block existing batch reads", async () => {
  const f = await fixture(); f.store.controls.analysisAuthority = null; f.store.controls.stagingGrant = null;
  f.store.controls.authority = reviewAuthority({ sessionId: "synthetic-new-session", sessionRevision: 2 });
  assert.deepEqual(await success(await f.handler(request())), f.batch); unchanged(f);
});
for (const boundary of [1, 3, 5])
  test(`actual resolver authority failure at boundary ${boundary} remains fatal even if auth appears restored`, async () => {
    const f = await fixture(); let referenceReads = 0;
    const actual = createCandidateBatchReferences({ ...f.store.referenceDependencies,
      readReference: async (reference, signal) => {
        const result = await f.store.referenceDependencies.readReference(reference, signal);
        if (++referenceReads === boundary) f.store.controls.authority = reviewAuthority({ sessionRevision: 2 });
        return result;
      } });
    f.overrides.resolveBatch = async (command, signal) => {
      try { return await actual.resolve(command, signal); }
      finally {
        // Restore only after the real resolver observed the change. A later
        // observation of the original values must not erase that failure.
        f.store.controls.authority = reviewAuthority();
      }
    };
    await failure(await f.handler(request()), "API_SESSION_CHANGED", 403); unchanged(f);
    assert.ok(referenceReads >= boundary);
  });
test("current accepted/deleted/expired states replace old payload; access expiry does not erase persisted rows", async () => {
  const f = await fixture({}, 1000), first = f.batch.candidates[0]!, second = f.batch.candidates[1]!;
  const review = createReviewService(f.store.dependencies);
  const preview = await review.preview({ candidateId: first.candidateId, candidateRevision: first.candidateRevision,
    serviceId: f.services[0]!.serviceId, serviceRevision: f.services[0]!.serviceRevision, values: reviewValues() }); assert.ok(preview.ok);
  assert.ok((await review.confirm({ previewId: preview.value.id, operationId: "synthetic-inbox-confirm", decision: "confirm" })).ok);
  f.store.controls.now += 1000;
  const expired = await success(await f.handler(request()));
  assert.deepEqual(expired.candidates.map((c) => [c.state, c.content]), [["accepted", null], ["expired", null]]);
  assert.equal(f.store.rows.candidates.get(second.candidateId)!.state, "pending");
  assert.ok((await f.inbox.discard({ candidateId: second.candidateId, expectedRevision: 1, decision: "discard" })).ok);
  assert.deepEqual((await success(await f.handler(request()))).candidates.map((c) => [c.state, c.content]), [["accepted", null], ["deleted", null]]);
});
test("empty known batch is an empty observation, unknown reference is 404", async () => {
  const f = await fixture(), batch = [...f.store.rows.batches.values()][0]!;
  f.store.rows.batches.set(JSON.stringify([batch.ownerId, batch.analysisOperationId]), { ...batch, candidateIds: [] });
  assert.equal((await success(await f.handler(request()))).candidates.length, 0);
  const before = f.store.controls.transactions;
  await failure(await f.handler(request({ batchReference: "synthetic-unknown" })), "API_NOT_FOUND", 404);
  assert.equal(f.store.controls.transactions, before);
});
for (const [label, options, code, status] of [
  ["route", { url: `${ORIGIN}/api/inbox/stage` }, "API_NOT_FOUND", 404],
  ["method", { method: "GET" }, "API_METHOD_NOT_ALLOWED", 405],
  ["origin", { headers: { origin: "https://foreign.example.test" } }, "API_REQUEST_REJECTED", 403],
  ["missing origin", { headers: { origin: null } }, "API_REQUEST_REJECTED", 403],
  ["request URL", { url: `https://foreign.example.test${INBOX_HTTP_PATH}` }, "API_REQUEST_REJECTED", 403],
  ["query", { url: `${ORIGIN}${INBOX_HTTP_PATH}?batchReference=a` }, "API_REQUEST_REJECTED", 403],
  ["hash", { url: `${ORIGIN}${INBOX_HTTP_PATH}#a` }, "API_REQUEST_REJECTED", 403],
  ["wrong surface", { headers: { "x-keyatlas-request": "review-v1" } }, "API_REQUEST_REJECTED", 403],
  ["cross site", { headers: { "sec-fetch-site": "cross-site" } }, "API_REQUEST_REJECTED", 403],
  ["authorization", { headers: { authorization: "synthetic-only" } }, "API_REQUEST_REJECTED", 403],
  ["no cookie", { headers: { cookie: null } }, "API_AUTH_REQUIRED", 401],
  ["empty cookie", { headers: { cookie: "" } }, "API_AUTH_REQUIRED", 401],
  ["long cookie", { headers: { cookie: "x".repeat(4097) } }, "API_REQUEST_REJECTED", 403],
] as Array<[string, Options, InboxHttpError, number]>) test(`reject ${label} before adapters`, async () => {
  const f = await fixture(); const response = await f.handler(request(undefined, options));
  await failure(response, code, status); if (status === 405) assert.equal(response.headers.get("allow"), "POST");
  assert.equal(f.sessions.length, 0); assert.equal(f.admissions.length, 0); unchanged(f);
});
for (const [label, options, code, status] of [
  ["media", { headers: { "content-type": "text/plain" } }, "API_MEDIA_TYPE", 415],
  ["encoding", { headers: { "content-encoding": "gzip" } }, "API_MEDIA_TYPE", 415],
  ["no body", { raw: null }, "API_INPUT_INVALID", 400],
  ["JSON", { raw: "{invalid" }, "API_INPUT_INVALID", 400],
  ["duplicate", { raw: '{"batchReference":"a","batchReference":"b"}' }, "API_INPUT_INVALID", 400],
  ["too large", { raw: " ".repeat(1025) }, "API_BODY_TOO_LARGE", 413],
  ["declared too large", { headers: { "content-length": "1025" } }, "API_BODY_TOO_LARGE", 413],
  ["length mismatch", { headers: { "content-length": "1" } }, "API_INPUT_INVALID", 400],
] as Array<[string, Options, InboxHttpError, number]>) test(`body ${label} cannot resolve`, async () => {
  const f = await fixture(); await failure(await f.handler(request(undefined, options)), code, status);
  assert.equal(f.resolutions.length, 0); unchanged(f);
});
for (const command of [null, [], {}, { batchReference: "" }, { batchReference: " padded" }, { batchReference: "a b" },
  { batchReference: "x".repeat(129) }, { batchReference: 1 }, { batchReference: REFERENCE, ownerId: REVIEW_OWNER },
  { analysisOperationId: analysisAuthority().operationId }]) test(`exact reference request rejects ${JSON.stringify(command)}`, async () => {
  const f = await fixture(); await failure(await f.handler(request(command)), "API_INPUT_INVALID", 400);
  assert.equal(f.resolutions.length, 0); unchanged(f);
});
for (const [field, value] of [["surface", "review-v1"], ["surface", "catalog-v1"], ["requestId", "other"],
  ["action", "list"], ["allowed", 1], ["expiresAt", REVIEW_NOW], ["expiresAt", REVIEW_NOW + 10001]] as const)
  test(`permit rejects ${field}=${value}`, async () => {
    const f = await fixture({ admit: async (r) => ({ ...grant(r), [field]: value }) });
    await failure(await f.handler(request()), "API_UNAVAILABLE", 503); assert.equal(f.resolutions.length, 0); unchanged(f);
  });
test("permit exact fields/accessors and authority binding cannot be bypassed", async () => {
  let reads = 0;
  for (const mutate of [(r: InboxAdmissionRequest) => ({ ...grant(r), extra: true }),
    (r: InboxAdmissionRequest) => ({ ...grant(r), get surface() { reads++; return r.surface; } }),
    (r: InboxAdmissionRequest) => ({ ...grant(r), authority: { ...r.authority, dataGeneration: 2 } })]) {
    const f = await fixture({ admit: async (r) => mutate(r) });
    await failure(await f.handler(request()), "API_UNAVAILABLE", 503); unchanged(f);
  }
  assert.equal(reads, 0);
});
test("denied admission has exact retry hint and cannot resolve", async () => {
  const f = await fixture({ admit: async () => ({ allowed: false, retryAfterSeconds: 7 }) });
  const response = await f.handler(request()); await failure(response, "API_RATE_LIMITED", 429);
  assert.equal(response.headers.get("retry-after"), "7"); assert.equal(f.resolutions.length, 0); unchanged(f);
});
for (const retryAfterSeconds of [0, 61, 1.5, "1"]) test(`invalid denial ${retryAfterSeconds} is unavailable`, async () => {
  const f = await fixture({ admit: async () => ({ allowed: false, retryAfterSeconds }) });
  await failure(await f.handler(request()), "API_UNAVAILABLE", 503); unchanged(f);
});
test("resolver must return exact same-scope mapping without invoking getters", async () => {
  let reads = 0;
  const f = await fixture();
  for (const raw of [undefined, {}, { ...f.mapping, extra: SYNTHETIC_PRIVATE }, { ...f.mapping, dataGeneration: 0 },
    { ...f.mapping, analysisOperationId: " " }, { ...f.mapping, get analysisOperationId() { reads++; return "x"; } }]) {
    f.overrides.resolveBatch = async () => raw;
    await failure(await f.handler(request()), "API_UNAVAILABLE", 503);
  }
  assert.equal(reads, 0); unchanged(f);
});
for (const patch of [{ ownerId: "foreign-owner" }, { dataGeneration: 2 }, { batchReference: "foreign-reference" }])
  test(`foreign resolved ${Object.keys(patch)[0]} is not found`, async () => {
    const f = await fixture(); f.overrides.resolveBatch = async () => ({ ...f.mapping, ...patch });
    await failure(await f.handler(request()), "API_NOT_FOUND", 404); unchanged(f);
  });
for (const index of [2, 3, 4, 5]) for (const change of ["missing", "different", "foreign"] as const)
  test(`mapping ${change} at boundary ${index} remains conflict even after ABA`, async () => {
    const f = await fixture(); f.overrides.resolveBatch = async () => f.resolutions.length !== index ? f.mapping
      : change === "missing" ? null : change === "different" ? { ...f.mapping, analysisOperationId: "synthetic-reassigned" }
        : { ...f.mapping, ownerId: "foreign-owner" };
    await failure(await f.handler(request()), "API_CONFLICT", 409); unchanged(f);
  });
test("inconsistent resolver, missing backing batch and corrupt content fail closed without private data", async () => {
  const f = await fixture(); f.overrides.resolveBatch = async () => ({ ...f.mapping, analysisOperationId: "synthetic-missing" });
  // A known alias with a fabricated target is inconsistent, not an unknown
  // alias. The new atomic store predicate rejects it before reading content.
  await failure(await f.handler(request()), "API_UNAVAILABLE", 503); unchanged(f);
  const missing = await fixture(); missing.store.rows.batches.clear();
  const missingSnapshot = missing.store.snapshot();
  await failure(await missing.handler(request()), "API_UNAVAILABLE", 503);
  assert.deepEqual(missing.store.snapshot(), missingSnapshot);
  const g = await fixture(), row = [...g.store.rows.candidates.values()][0]!;
  g.store.rows.candidates.set(row.id, { ...row, content: { ...row.content!, candidateIndex: 999 } });
  await failure(await g.handler(request()), "API_UNAVAILABLE", 503);
});
test("actual terminal retirement returns unknown alias without deleting candidates or accepted benefits", async () => {
  const f = await fixture(), review = createReviewService(f.store.dependencies), candidate = f.batch.candidates[0]!;
  const preview = await review.preview({ candidateId: candidate.candidateId, candidateRevision: candidate.candidateRevision,
    serviceId: f.services[0]!.serviceId, serviceRevision: f.services[0]!.serviceRevision, values: reviewValues() });
  assert.ok(preview.ok);
  assert.ok((await review.confirm({ previewId: preview.value.id, operationId: "synthetic-before-retirement", decision: "confirm" })).ok);
  assert.equal(f.store.rows.benefits.size, 1);
  const before = f.store.snapshot();
  const result = await f.references.retire({ batchReference: REFERENCE, expectedRevision: 1, decision: "retire" });
  assert.ok(result.ok);
  assert.deepEqual(result.value, { batchReference: REFERENCE, dataGeneration: 1, state: "retired", revision: 2 });
  const retired = f.store.snapshot(), readsBefore = f.store.controls.transactions;
  await failure(await f.handler(request()), "API_NOT_FOUND", 404);
  assert.equal(f.store.controls.transactions, readsBefore);
  assert.deepEqual(f.store.snapshot(), retired);
  assert.deepEqual(retired.candidates, before.candidates); assert.deepEqual(retired.batches, before.batches);
  assert.deepEqual(retired.benefits, before.benefits);
  assert.deepEqual(await f.references.ensure({ analysisOperationId: f.mapping.analysisOperationId }),
    { ok: false, code: "REVIEW_CONFLICT" });
  assert.deepEqual(f.store.snapshot(), retired);
});
for (const change of ["retire", "slot", "target", "batch"] as const)
  test(`atomic read predicate preserves external ${change} at commit instead of overwriting it`, async () => {
    const f = await fixture(), beforeCommits = f.store.controls.commits;
    let external: ReturnType<typeof f.store.snapshot> | null = null;
    f.store.controls.beforeCommit = () => {
      const row = f.store.rows.batchReferences.get(REFERENCE)!;
      const slot = JSON.stringify([row.ownerId, row.analysisOperationId]);
      if (change === "retire") f.store.rows.batchReferences.set(REFERENCE, { ...row, state: "retired", revision: 2 });
      else if (change === "slot") f.store.rows.batchReferenceSlots.delete(slot);
      else if (change === "target") f.store.rows.batchReferences.set(REFERENCE, { ...row, analysisOperationId: "synthetic-changed-target" });
      else f.store.rows.batches.delete(slot);
      external = f.store.snapshot();
    };
    // The final resolver observes a changed active mapping as a conflict;
    // unobservable index/backing corruption retains the fixed unavailable code.
    const observed = change === "retire" || change === "target";
    await failure(await f.handler(request()), observed ? "API_CONFLICT" : "API_UNAVAILABLE", observed ? 409 : 503);
    assert.notEqual(external, null); assert.deepEqual(f.store.snapshot(), external);
    assert.equal(f.store.controls.commits, beforeCommits); assert.equal(f.store.controls.rollbacks, 1);
    assert.deepEqual([f.store.controls.analysisChecks, f.store.controls.stagingGrantReads], f.initialGrantReads);
    delete f.store.controls.beforeCommit;
  });
test("retirement after read commit suppresses delivery and is not reported as a rollback", async () => {
  const f = await fixture(), before = f.store.controls.commits;
  f.store.controls.afterCommit = () => {
    const row = f.store.rows.batchReferences.get(REFERENCE)!;
    f.store.rows.batchReferences.set(REFERENCE, { ...row, state: "retired", revision: 2 });
  };
  await failure(await f.handler(request()), "API_CONFLICT", 409);
  assert.equal(f.store.controls.commits, before + 1); assert.equal(f.store.controls.rollbacks, 0);
  assert.equal(f.store.rows.batchReferences.get(REFERENCE)!.state, "retired");
  assert.deepEqual(f.store.rows.candidates, f.initial.candidates);
  delete f.store.controls.afterCommit;
  await failure(await f.handler(request()), "API_NOT_FOUND", 404);
});
for (const patch of [{ ownerId: "other-owner" }, { sessionId: "other-session" }, { sessionRevision: 2 },
  { dataGeneration: 2 }, { expiresAt: REVIEW_NOW + 500000 }]) test(`resolver cannot rebind authority ${Object.keys(patch)[0]}`, async () => {
  const f = await fixture(); f.overrides.resolveBatch = async () => {
    f.store.controls.authority = reviewAuthority(patch); return f.mapping;
  };
  await failure(await f.handler(request()), "API_SESSION_CHANGED", 403); unchanged(f);
});
test("all authority rereads suppress persistent session change, including after acknowledged read", async (t) => {
  const baseline = await fixture(); await success(await baseline.handler(request())); const count = baseline.sessions.length;
  assert.ok(count > 10);
  for (let index = 2; index <= count; index++) await t.test(`authority read ${index}/${count}`, async () => {
    const f = await fixture(); f.overrides.readSession = async () => {
      if (f.sessions.length === index) f.store.controls.authority = reviewAuthority({ sessionRevision: 2 });
      return structuredClone(f.store.controls.authority);
    };
    await failure(await f.handler(request()), "API_SESSION_CHANGED", 403); unchanged(f);
  });
});
test("expiry during final resolver is redacted, not denied by old staging consent", async () => {
  const f = await fixture({}, 1000);
  f.overrides.resolveBatch = async () => {
    if (f.resolutions.length === 5) f.store.controls.now += 1000;
    return f.mapping;
  };
  const batch = await success(await f.handler(request()));
  assert.ok(batch.candidates.every((row) => row.state === "expired" && row.content === null)); unchanged(f);
});
test("serialization crossing final access deadline suppresses pending content", async (t) => {
  const f = await fixture({}, 1000), original = JSON.stringify;
  // Deterministically advance only the injected clock after real serialization;
  // this is not evidence about physical CPU speed or a replaced HTTP payload.
  t.mock.method(JSON, "stringify", (value: unknown, ...args: unknown[]) => {
    const serialized = Reflect.apply(original, JSON, [value, ...args]) as string | undefined;
    if (value && typeof value === "object" && "ok" in value && "value" in value
      && value.value && typeof value.value === "object" && "batch" in value.value) f.store.controls.now += 1000;
    return serialized;
  });
  await failure(await f.handler(request()), "API_CONFLICT", 409); unchanged(f);
});
for (const phase of ["readSession", "admit", "resolveBatch", "transaction"] as const)
  test(`thrown ${phase} is fixed unavailable and never retried`, async () => {
    const f = await fixture(); let calls = 0;
    f.overrides[phase] = async () => { calls++; throw Error(SYNTHETIC_PRIVATE); };
    await failure(await f.handler(request()), "API_UNAVAILABLE", 503); assert.equal(calls, 1); unchanged(f);
  });
test("pre-aborted input calls no adapter", async () => {
  const f = await fixture(), abort = new AbortController(); abort.abort(SYNTHETIC_PRIVATE);
  await failure(await f.handler(request(undefined, { signal: abort.signal })), "API_ABORTED", 408);
  assert.equal(f.sessions.length, 0); unchanged(f);
});
for (const authority of [null, {}, reviewAuthority({ expiresAt: REVIEW_NOW }), reviewAuthority({ dataGeneration: 0 })])
  test(`invalid initial authority cannot resolve: ${JSON.stringify(authority)}`, async () => {
    const f = await fixture({ readSession: async () => authority });
    await failure(await f.handler(request()), "API_AUTH_REQUIRED", 401);
    assert.equal(f.admissions.length, 0); assert.equal(f.resolutions.length, 0); unchanged(f);
  });
test("abort while reading body cancels the stream and cannot resolve a batch", async () => {
  const f = await fixture(), entered = deferred<void>(), abort = new AbortController(); let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull() { entered.resolve(); return new Promise<void>(() => {}); }, cancel() { cancelled++; },
  });
  const pending = f.handler(request(undefined, { raw: stream, signal: abort.signal }));
  await entered.promise; await nextTurn(); abort.abort(SYNTHETIC_PRIVATE);
  await failure(await pending, "API_ABORTED", 408);
  assert.equal(cancelled, 1); assert.equal(f.resolutions.length, 0); unchanged(f);
});
test("abort after acknowledged read suppresses payload without claiming rollback; late adapter returns cleanly", async () => {
  const f = await fixture(), committed = deferred<void>(), ack = deferred<void>(), returned = deferred<void>();
  const abort = new AbortController(), before = f.store.controls.commits;
  f.store.controls.afterCommit = async () => { committed.resolve(); await ack.promise; returned.resolve(); };
  const pending = f.handler(request(undefined, { signal: abort.signal })); await committed.promise;
  abort.abort(SYNTHETIC_PRIVATE); await failure(await pending, "API_ABORTED", 408);
  assert.equal(f.store.controls.commits, before + 1); assert.equal(f.store.controls.rollbacks, 0);
  ack.resolve(); await returned.promise; await nextTurn(); delete f.store.controls.afterCommit;
  unchanged(f); assert.deepEqual(await success(await f.handler(request())), f.batch);
});
test("mapping replacement during read acknowledgement is conflict, not a new batch read", async () => {
  const f = await fixture(), before = f.store.controls.commits;
  f.store.controls.afterCommit = () => {
    f.overrides.resolveBatch = async () => ({ ...f.mapping, analysisOperationId: "synthetic-rebound-batch" });
  };
  await failure(await f.handler(request()), "API_CONFLICT", 409);
  assert.equal(f.store.controls.commits, before + 1); assert.equal(f.store.controls.rollbacks, 0); unchanged(f);
});
for (const ending of ["resolve", "reject"] as const) test(`aborted resolver late ${ending} cannot enter transaction`, async () => {
  const f = await fixture(), entered = deferred<void>(), late = deferred<unknown>(), abort = new AbortController();
  const before = f.store.controls.transactions;
  f.overrides.resolveBatch = async () => { entered.resolve(); return late.promise; };
  const pending = f.handler(request(undefined, { signal: abort.signal })); await entered.promise; abort.abort(SYNTHETIC_PRIVATE);
  await failure(await pending, "API_ABORTED", 408);
  if (ending === "resolve") late.resolve(f.mapping); else late.reject(Error(SYNTHETIC_PRIVATE));
  await nextTurn(); await nextTurn(); assert.equal(f.store.controls.transactions, before); unchanged(f);
  assert.ok(f.resolverSignals.every((signal) => signal.aborted));
});
test("deadline bounds hung resolver and late rejection is consumed", async () => {
  const f = await fixture({ requestTimeoutMs: 100 }), late = deferred<unknown>();
  f.overrides.resolveBatch = async () => late.promise;
  await failure(await f.handler(request()), "API_TIMEOUT", 408);
  late.reject(Error(SYNTHETIC_PRIVATE)); await nextTurn(); unchanged(f);
});
for (const bound of ["permit", "session", "overall"] as const) test(`${bound} exact deadline is registered and enforced at transaction commit`, async () => {
  const f = await fixture({ requestTimeoutMs: 2000 }); const deadline = REVIEW_NOW + (bound === "overall" ? 2000 : 1000);
  if (bound === "session") f.store.controls.authority = reviewAuthority({ expiresAt: deadline });
  if (bound === "permit") f.overrides.admit = async (r) => ({ ...grant(r), expiresAt: deadline });
  const registered: number[] = [];
  f.overrides.transaction = (authority, action) => f.store.referenceDependencies.transaction(authority,
    (tx) => action({ ...tx, limitCommitTime(notAfter) { registered.push(notAfter); tx.limitCommitTime(notAfter); } }));
  f.store.controls.beforeCommit = () => { f.store.controls.now = deadline; };
  await failure(await f.handler(request()), bound === "session" ? "API_SESSION_CHANGED" : "API_TIMEOUT", bound === "session" ? 403 : 408);
  assert.ok(registered.includes(deadline)); unchanged(f);
});
for (const clock of [NaN, Infinity, -1, REVIEW_NOW - 1]) test(`invalid/backward clock ${clock} cannot deliver`, async () => {
  const f = await fixture(); f.overrides.resolveBatch = async () => { f.store.controls.now = clock; return f.mapping; };
  await failure(await f.handler(request()), "API_UNAVAILABLE", 503); unchanged(f);
});
test("configuration rejects nonlocal HTTP, nonexact origins, missing ports and invalid timeout", async () => {
  const f = await fixture();
  for (const patch of [{ trustedOrigin: "http://foreign.example.test" }, { trustedOrigin: `${ORIGIN}/` },
    { requestTimeoutMs: 0 }, { requestTimeoutMs: 10001 }, { requestTimeoutMs: null }, { resolveBatch: null }]) {
    assert.throws(() => createInboxHttpHandler({ ...f.deps, ...patch } as unknown as InboxHttpDependencies), /API_CONFIGURATION_INVALID/);
  }
});
