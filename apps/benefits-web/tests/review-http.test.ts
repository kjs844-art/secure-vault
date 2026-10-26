import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createReviewHttpHandler } from "../src/server/http/review-http.ts";
import { MAX_REVIEW_REQUEST_BYTES, MAX_REVIEW_RESPONSE_BYTES, MAX_REVIEW_REQUEST_MS,
  type ReviewAdmissionRequest, type ReviewHttpDependencies, type ReviewHttpError,
  type ReviewSessionContext } from "../src/server/http/review-http-contracts.ts";
import { decodeReviewPreviewView, type ReviewPreviewView } from "../src/domain/review-preview-view.ts";
import { decodeReviewedBenefitView, type ReviewedBenefitView } from "../src/domain/reviewed-benefit-view.ts";
import { decodeReviewedBenefitPage, type ReviewedBenefitPageView } from "../src/domain/reviewed-benefit-page.ts";
import { CANDIDATE_ID, REVIEW_NOW, REVIEW_OWNER, SERVICE_ID, SYNTHETIC_PRIVATE,
  benefitCollectionRevisionKey, candidateRow, createReviewMemoryStore, reviewAuthority, reviewValues } from "./support/review-memory-store.ts";

// Fetch objects and the actual service with a serialized synthetic memory store.
// Not a mounted route, real credentials/admission limiter, network or durable DB.
const ORIGIN = "https://review.example.test";
const COOKIE = "synthetic-session=fixture";
const draft = (candidateId = CANDIDATE_ID) => ({ candidateId, candidateRevision: 1,
  serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues({ remainingAmount: 0,
    expiresAt: "2020-02-29", observedAt: "2026-09-27T12:34:56.123456789+09:00" }) });
const confirmInput = (previewId: string, operationId = "synthetic-http-confirm") => ({ previewId, operationId, decision: "confirm" });
const deleteInput = (view: ReviewedBenefitView, operationId = "synthetic-http-delete") => ({
  benefitId: view.benefitId, expectedRevision: view.benefitRevision, operationId, decision: "delete",
});
const grant = (input: ReviewAdmissionRequest) => Object.freeze({ allowed: true, surface: input.surface,
  requestId: input.requestId, action: input.action, authority: input.authority, expiresAt: input.notAfter });

function fixture(overrides: Partial<ReviewHttpDependencies> = {}) {
  const store = createReviewMemoryStore(), initial = store.snapshot();
  const sessions: Array<{ context: ReviewSessionContext; signal: AbortSignal }> = [];
  const admissions: Array<{ request: ReviewAdmissionRequest; signal: AbortSignal }> = [];
  const deps: ReviewHttpDependencies = {
    trustedOrigin: overrides.trustedOrigin ?? ORIGIN,
    ...(overrides.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: overrides.requestTimeoutMs }),
    now: () => overrides.now ? overrides.now() : store.controls.now,
    newId: () => overrides.newId ? overrides.newId() : store.dependencies.newId(),
    readSession: async (context, signal) => {
      sessions.push({ context, signal });
      return overrides.readSession ? overrides.readSession(context, signal) : structuredClone(store.controls.authority);
    },
    admit: async (input, signal) => {
      admissions.push({ request: input, signal });
      return overrides.admit ? overrides.admit(input, signal) : grant(input);
    },
    transaction: (authority, action) => (overrides.transaction ?? store.dependencies.transaction)(authority, action),
  };
  return { store, initial, controls: store.controls, sessions, admissions, overrides, deps,
    handler: createReviewHttpHandler(deps) };
}
type Fixture = ReturnType<typeof fixture>;
type RequestOptions = { url?: string; method?: string; headers?: Record<string, string | null>;
  raw?: BodyInit | null; signal?: AbortSignal };
function request(action = "preview", command: unknown = draft(), options: RequestOptions = {}) {
  const headers = new Headers({ "content-type": "application/json", origin: ORIGIN,
    "x-keyatlas-request": "review-v1", "sec-fetch-site": "same-origin", cookie: COOKIE });
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(key); else headers.set(key, value);
  }
  const method = options.method ?? "POST";
  const init: RequestInit & { duplex?: "half" } = { method, headers, ...(options.signal ? { signal: options.signal } : {}) };
  if (method !== "GET" && method !== "HEAD") {
    init.body = "raw" in options ? options.raw : JSON.stringify(command);
    if (init.body instanceof ReadableStream) init.duplex = "half";
  }
  const result = new Request(options.url ?? `${ORIGIN}/api/review/${action}`, init);
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
  for (const header of ["set-cookie", "access-control-allow-origin", "access-control-allow-credentials", "authorization", "cookie"]) {
    assert.equal(response.headers.get(header), null);
  }
  const text = await response.text();
  for (const marker of [COOKIE, SYNTHETIC_PRIVATE, REVIEW_OWNER, CANDIDATE_ID,
    "synthetic-mailbox", "synthetic-analysis-operation"]) assert.equal(text.includes(marker), false, marker);
  for (const key of ["ownerId", "sessionId", "sessionRevision", "candidateId", "candidateRevision", "source",
    "mailboxBindingId", "analysisOperationId", "candidateIndex", "operationId", "replayed", "body", "quote"]) {
    assert.equal(text.includes(`"${key}"`), false, key);
  }
  return JSON.parse(text) as Record<string, unknown>;
}
async function success<T>(response: Response): Promise<T> {
  const decoded = await body(response);
  assert.equal(response.status, 200, JSON.stringify(decoded));
  assert.deepEqual(Object.keys(decoded).sort(), ["ok", "value"]); assert.equal(decoded.ok, true);
  return decoded.value as T;
}
async function failure(response: Response, code: ReviewHttpError, status: number) {
  assert.deepEqual(await body(response), { ok: false, code }); assert.equal(response.status, status);
  if (status !== 405) assert.equal(response.headers.get("allow"), null);
  if (status !== 429) assert.equal(response.headers.get("retry-after"), null);
}
async function preview(f: Fixture, candidateId = CANDIDATE_ID) {
  const value = await success<ReviewPreviewView>(await f.handler(request("preview", draft(candidateId))));
  assert.deepEqual(decodeReviewPreviewView(value), value);
  return value;
}
async function saved(f: Fixture, candidateId = CANDIDATE_ID, operationId = "synthetic-http-confirm") {
  const p = await preview(f, candidateId), command = confirmInput(p.previewId, operationId);
  const value = await success<ReviewedBenefitView>(await f.handler(request("confirm", command)));
  assert.deepEqual(decodeReviewedBenefitView(value), value);
  return { preview: p, command, value };
}
function noWrites(f: Fixture) { assert.deepEqual(f.store.snapshot(), f.initial); assert.equal(f.controls.commits, 0); }
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("HTTP preview/confirm/get/list/delete/replay composes real memory service and only minimal DTOs", async () => {
  const f = fixture(), first = await saved(f);
  assert.equal(first.preview.content.reviewStatus, "pending-review");
  assert.equal(first.preview.content.evidenceAvailability, "not-retained");
  assert.equal(first.value.outcome, "saved"); assert.ok(first.value.content);
  assert.equal(first.value.content.values.remainingAmount, 0);
  assert.equal(first.value.content.values.trialDaysStated, null);
  assert.equal(first.value.content.values.expiresAt, "2020-02-29");
  assert.equal(first.value.content.values.observedAt, "2026-09-27T12:34:56.123456789+09:00");
  assert.equal(first.value.content.sourceObservedAt, null);
  assert.equal(first.value.content.valueOrigins.remainingAmount, "user-corrected");
  assert.equal(first.value.content.accountProof, "not-established");
  assert.equal(first.value.content.currentBalanceProof, "not-established");
  assert.deepEqual(await success(await f.handler(request("get", { benefitId: first.value.benefitId }))), first.value);
  assert.deepEqual(await success(await f.handler(request("confirm", first.command))), first.value);
  const page = await success<ReviewedBenefitPageView>(await f.handler(request("list", { limit: 50, cursor: null })));
  assert.deepEqual(decodeReviewedBenefitPage(page), page);
  assert.deepEqual(page.benefits, [first.value]); assert.equal(page.benefitCollectionRevision, 2);
  const remove = deleteInput(first.value);
  const deleted = await success<ReviewedBenefitView>(await f.handler(request("delete", remove)));
  assert.equal(deleted.outcome, "deleted"); assert.equal(deleted.content, null); assert.equal(deleted.benefitRevision, 2);
  assert.deepEqual(await success(await f.handler(request("delete", remove))), deleted);
  assert.deepEqual(await success(await f.handler(request("confirm", first.command))), deleted);
  assert.deepEqual(await success(await f.handler(request("get", { benefitId: deleted.benefitId }))), deleted);
  const empty = await success<ReviewedBenefitPageView>(await f.handler(request("list", { limit: 50, cursor: null })));
  assert.deepEqual(empty.benefits, []); assert.equal(empty.benefitCollectionRevision, 3);
  assert.equal(f.store.rows.operations.size, 2);
  assert.equal(f.admissions.length, 10, "every exact replay is independently admitted");
});

test("reject is explicit, projected minimally, and prevents a later confirm without saving", async () => {
  const f = fixture(), p = await preview(f);
  const command = { previewId: p.previewId, expectedRevision: p.previewRevision, decision: "reject" };
  assert.deepEqual(await success(await f.handler(request("reject", command))), { previewId: p.previewId, state: "revoked" });
  await failure(await f.handler(request("confirm", confirmInput(p.previewId))), "API_CONFLICT", 409);
  await failure(await f.handler(request("reject", command)), "API_CONFLICT", 409);
  assert.equal(f.store.rows.benefits.size, 0); assert.equal(f.store.rows.operations.size, 0);
  assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.state, "pending");
});

test("expired or already consumed previews map to conflict rather than unavailable", async () => {
  const f = fixture(), p = await preview(f);
  f.controls.now = p.expiresAt;
  await failure(await f.handler(request("confirm", confirmInput(p.previewId))), "API_CONFLICT", 409);
  assert.equal(f.store.rows.benefits.size, 0);
  const g = fixture(), s = await saved(g);
  await failure(await g.handler(request("confirm", confirmInput(s.preview.previewId, "synthetic-different-op"))), "API_CONFLICT", 409);
  await failure(await g.handler(request("reject", { previewId: s.preview.previewId, expectedRevision: 1, decision: "reject" })), "API_CONFLICT", 409);
  assert.equal(g.store.rows.benefits.size, 1);
});

test("saved history survives original candidate expiry; same-owner new session may read it", async () => {
  const f = fixture(), first = await saved(f);
  f.controls.now = REVIEW_NOW + 86400000;
  f.controls.authority = reviewAuthority({ sessionId: "synthetic-fresh-session", sessionRevision: 2, expiresAt: f.controls.now + 600000 });
  assert.deepEqual(await success(await f.handler(request("get", { benefitId: first.value.benefitId }))), first.value);
  assert.deepEqual(await success(await f.handler(request("confirm", first.command))), first.value,
    "saved confirmation replay does not inherit its original pending preview deadline");
  assert.equal((await success<ReviewedBenefitPageView>(await f.handler(request("list", { limit: 50, cursor: null })))).benefits.length, 1);
});

for (const offset of [-1, 0]) test(`short candidate preview expiry at final HTTP session read: offset ${offset}`, async () => {
  const f = fixture(), deadline = REVIEW_NOW + 200;
  f.store.rows.candidates.set(CANDIDATE_ID, candidateRow({ expiresAt: deadline }));
  let committed = false, postCommitReads = 0;
  const clocksAtReads: number[] = [];
  f.controls.afterCommit = () => { committed = true; };
  f.overrides.readSession = async () => {
    if (committed) {
      postCommitReads++;
      // 1: service final guard, 2: HTTP after dispatch, 3: HTTP after serialization.
      // Advance only the trusted synthetic clock; no arbitrary sleep/timer race.
      if (postCommitReads === 3) f.controls.now = deadline + offset;
      clocksAtReads.push(f.controls.now);
    }
    return structuredClone(f.controls.authority);
  };
  const response = await f.handler(request());
  if (offset === 0) await failure(response, "API_CONFLICT", 409);
  else assert.equal((await success<ReviewPreviewView>(response)).expiresAt, deadline);
  assert.equal(postCommitReads, 3);
  assert.deepEqual(clocksAtReads, [REVIEW_NOW, REVIEW_NOW, deadline + offset]);
  assert.ok(f.admissions[0]!.request.notAfter > deadline, "HTTP permit remains valid at preview expiry");
  assert.ok(reviewAuthority().expiresAt > deadline, "session remains valid at preview expiry");
  assert.equal(f.controls.commits, 1); assert.equal(f.controls.rollbacks, 0);
  assert.equal(f.store.rows.previews.size, 1, "a suppressed preview response is not rollback");
  assert.equal([...f.store.rows.previews.values()][0]!.expiresAt, deadline);
  assert.equal(f.store.rows.benefits.size, 0);
});

test("body pagination is bounded and a collection change rejects old cursor", async () => {
  const f = fixture(); await saved(f);
  f.store.rows.candidates.set("synthetic-second", candidateRow({ id: "synthetic-second" }));
  const second = await saved(f, "synthetic-second", "synthetic-confirm-second");
  const firstPage = await success<ReviewedBenefitPageView>(await f.handler(request("list", { limit: 1, cursor: null })));
  assert.ok(firstPage.nextCursor);
  const lastPage = await success<ReviewedBenefitPageView>(await f.handler(request("list", { limit: 1, cursor: firstPage.nextCursor })));
  assert.equal(lastPage.benefits.length, 1); assert.equal(lastPage.nextCursor, null);
  assert.notEqual(lastPage.benefits[0]!.benefitId, firstPage.benefits[0]!.benefitId);
  await success(await f.handler(request("delete", deleteInput(second.value))));
  await failure(await f.handler(request("list", { limit: 1, cursor: firstPage.nextCursor })), "API_CONFLICT", 409);
});

test("overlapping identical confirmation is admitted twice, stores once and projects equal responses", async () => {
  const f = fixture(), p = await preview(f), command = confirmInput(p.previewId);
  const values = await Promise.all([f.handler(request("confirm", command)).then(success), f.handler(request("confirm", command)).then(success)]);
  assert.deepEqual(values[0], values[1]); assert.equal(f.store.rows.benefits.size, 1);
  assert.equal(f.store.rows.operations.size, 1); assert.equal(f.admissions.length, 3);
  assert.equal(f.store.rows.benefitsRevisions.get(benefitCollectionRevisionKey(REVIEW_OWNER, 1)), 2);
});

for (const patch of [{ ownerId: "synthetic-other-owner" }, { dataGeneration: 2 }]) {
  test(`server scope ${Object.keys(patch)[0]} hides saved data and forbids deletion`, async () => {
    const f = fixture(), first = await saved(f), before = f.store.snapshot();
    f.controls.authority = reviewAuthority(patch);
    await failure(await f.handler(request("get", { benefitId: first.value.benefitId })), "API_NOT_FOUND", 404);
    await failure(await f.handler(request("delete", deleteInput(first.value))), "API_NOT_FOUND", 404);
    const page = await success<ReviewedBenefitPageView>(await f.handler(request("list", { limit: 50, cursor: null })));
    assert.deepEqual(page.benefits, []); assert.deepEqual(f.store.snapshot(), before);
  });
}

test("configured byte/time ceilings remain 16 KiB, 1 MiB and ten seconds", () => {
  assert.equal(MAX_REVIEW_REQUEST_BYTES, 16384); assert.equal(MAX_REVIEW_RESPONSE_BYTES, 1048576);
  assert.equal(MAX_REVIEW_REQUEST_MS, 10000);
});
for (const origin of [`${ORIGIN}/`, `${ORIGIN}/path`, `${ORIGIN}?x=1`, `${ORIGIN}#x`,
  "https://REVIEW.example.test", "https://review.example.test:443", "https://user@review.example.test",
  "http://review.example.test", "http://localhost.example.test", "not-a-url"]) {
  test(`factory rejects noncanonical origin ${origin}`, () => {
    const f = fixture();
    assert.throws(() => createReviewHttpHandler({ ...f.deps, trustedOrigin: origin }), { message: "API_CONFIGURATION_INVALID" });
  });
}
for (const origin of [ORIGIN, "http://localhost:4317", "http://127.0.0.1:4317", "http://[::1]:4317"]) {
  test(`canonical configured origin ${origin} is supported`, async () => {
    const f = fixture({ trustedOrigin: origin });
    await success(await f.handler(request("list", { limit: 1, cursor: null }, { url: `${origin}/api/review/list`, headers: { origin } })));
  });
}
for (const timeout of [0, -1, 0.5, 10001, NaN, Infinity, "10"]) test(`invalid timeout ${String(timeout)} is rejected`, () => {
  const f = fixture();
  assert.throws(() => createReviewHttpHandler({ ...f.deps, requestTimeoutMs: timeout as number }), { message: "API_CONFIGURATION_INVALID" });
});
for (const key of ["readSession", "admit", "transaction", "now", "newId"] as const) test(`missing dependency ${key} is rejected`, () => {
  const f = fixture();
  assert.throws(() => createReviewHttpHandler({ ...f.deps, [key]: null } as unknown as ReviewHttpDependencies), { message: "API_CONFIGURATION_INVALID" });
});
for (const action of ["", "revoke", "remove", "preview/", "PREVIEW", "preview/extra", "%70review", "../other"]) {
  test(`unknown action ${JSON.stringify(action)} cannot invoke adapters`, async () => {
    const f = fixture(); await failure(await f.handler(request(action)), "API_NOT_FOUND", 404);
    assert.equal(f.sessions.length, 0); assert.equal(f.admissions.length, 0); noWrites(f);
  });
}
for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) test(`method ${method} cannot dispatch`, async () => {
  const f = fixture(), response = await f.handler(request("list", { limit: 1, cursor: null }, { method }));
  await failure(response, "API_METHOD_NOT_ALLOWED", 405); assert.equal(response.headers.get("allow"), "POST");
  assert.equal(f.sessions.length, 0); noWrites(f);
});
for (const [label, headers] of [
  ["no Origin", { origin: null }], ["foreign Origin", { origin: "https://other.example.test" }],
  ["opaque Origin", { origin: "null" }], ["Origin slash", { origin: `${ORIGIN}/` }],
  ["missing marker", { "x-keyatlas-request": null }], ["catalog marker", { "x-keyatlas-request": "catalog-v1" }],
  ["cross-site", { "sec-fetch-site": "cross-site" }], ["same-site", { "sec-fetch-site": "same-site" }],
  ["bearer", { authorization: "synthetic-not-a-real-token" }], ["empty authorization", { authorization: "" }],
  ["large cookie", { cookie: "x".repeat(4097) }], ["non ASCII cookie", { cookie: "synthetic=é" }],
] as Array<[string, Record<string, string | null>]>) test(`request rejects ${label} before session or admission`, async () => {
  const f = fixture(); await failure(await f.handler(request("preview", draft(), { headers })), "API_REQUEST_REJECTED", 403);
  assert.equal(f.sessions.length, 0); assert.equal(f.admissions.length, 0); noWrites(f);
});
for (const suffix of ["?private=synthetic", "#fragment"]) test(`URL ${suffix} cannot carry private input`, async () => {
  const f = fixture();
  await failure(await f.handler(request("preview", draft(), { url: `${ORIGIN}/api/review/preview${suffix}` })), "API_REQUEST_REJECTED", 403);
  assert.equal(f.sessions.length, 0); noWrites(f);
});
test("forwarded headers cannot replace the trusted origin", async () => {
  const f = fixture();
  await failure(await f.handler(request("preview", draft(), { url: "https://other.example.test/api/review/preview",
    headers: { host: "review.example.test", "x-forwarded-host": "review.example.test", "x-forwarded-proto": "https" } })), "API_REQUEST_REJECTED", 403);
  assert.equal(f.sessions.length, 0); noWrites(f);
});
for (const cookie of [null, "", "  "]) test(`empty cookie ${JSON.stringify(cookie)} cannot use ambient authority`, async () => {
  const f = fixture(); await failure(await f.handler(request("preview", draft(), { headers: { cookie } })), "API_AUTH_REQUIRED", 401);
  assert.equal(f.sessions.length, 0); noWrites(f);
});

test("private frozen cookie context and surface-bound permit share one finished cooperative signal", async () => {
  const f = fixture();
  await success(await f.handler(request("list", { limit: 1, cursor: null }, { headers: { cookie: "x".repeat(4096), "sec-fetch-site": null } })));
  const initial = f.sessions[0]!, admission = f.admissions[0]!;
  assert.ok(f.sessions.length > 3); assert.ok(Object.isFrozen(initial.context));
  assert.deepEqual(Object.keys(initial.context), ["cookie"]); assert.equal(initial.context.cookie?.length, 4096);
  for (const session of f.sessions) { assert.equal(session.context, initial.context); assert.equal(session.signal, initial.signal); }
  assert.equal(admission.signal, initial.signal); assert.equal(admission.request.surface, "review-v1");
  assert.deepEqual(Object.keys(admission.request).sort(), ["action", "authority", "notAfter", "requestId", "surface"]);
  assert.ok(Object.isFrozen(admission.request)); assert.ok(Object.isFrozen(admission.request.authority));
  assert.equal(initial.signal.aborted, true);
});
for (const initial of [null, {}, reviewAuthority({ expiresAt: REVIEW_NOW }), reviewAuthority({ dataGeneration: 0 })]) {
  test(`invalid initial authority ${JSON.stringify(initial)} cannot be admitted`, async () => {
    const f = fixture({ readSession: async () => initial });
    await failure(await f.handler(request()), "API_AUTH_REQUIRED", 401);
    assert.equal(f.admissions.length, 0); noWrites(f);
  });
}
type BadPermit = (request: ReviewAdmissionRequest) => unknown;
const badPermits: Array<[string, BadPermit]> = [
  ["null", () => null], ["empty", () => ({})], ["truthy", (r) => ({ ...grant(r), allowed: 1 })],
  ["missing surface", (r) => { const { surface: _, ...rest } = grant(r); return rest; }],
  ["catalog surface", (r) => ({ ...grant(r), surface: "catalog-v1" })],
  ["request ID", (r) => ({ ...grant(r), requestId: "another-request" })],
  ["action", (r) => ({ ...grant(r), action: "delete" })],
  ["extra", (r) => ({ ...grant(r), privateDetail: SYNTHETIC_PRIVATE })],
  ["expired", (r) => ({ ...grant(r), expiresAt: REVIEW_NOW })],
  ["long", (r) => ({ ...grant(r), expiresAt: r.notAfter + 1 })],
  ["fraction", (r) => ({ ...grant(r), expiresAt: REVIEW_NOW + 0.5 })],
  ["authority extra", (r) => ({ ...grant(r), authority: { ...r.authority, privateDetail: SYNTHETIC_PRIVATE } })],
];
for (const [key, value] of Object.entries({ ownerId: "other", sessionId: "other", sessionRevision: 2,
  dataGeneration: 2, expiresAt: REVIEW_NOW + 599999 })) {
  badPermits.push([`authority ${key}`, (r) => ({ ...grant(r), authority: { ...r.authority, [key]: value } })]);
}
for (const [label, permit] of badPermits) test(`admission ${label} cannot dispatch`, async () => {
  const f = fixture({ admit: async (input) => permit(input) });
  await failure(await f.handler(request()), "API_UNAVAILABLE", 503);
  assert.equal(f.controls.transactions, 0); noWrites(f);
});
test("permit accessors are not invoked", async () => {
  let getters = 0;
  const f = fixture({ admit: async (input) => ({ ...grant(input), get surface() { getters++; return "review-v1"; } }) });
  await failure(await f.handler(request()), "API_UNAVAILABLE", 503);
  assert.equal(getters, 0); noWrites(f);
});
for (const retryAfterSeconds of [1, 60]) test(`denial emits exact bounded Retry-After ${retryAfterSeconds}`, async () => {
  const f = fixture({ admit: async () => ({ allowed: false, retryAfterSeconds }) }), response = await f.handler(request());
  await failure(response, "API_RATE_LIMITED", 429); assert.equal(response.headers.get("retry-after"), String(retryAfterSeconds));
  noWrites(f);
});
for (const denied of [{ allowed: false }, { allowed: false, retryAfterSeconds: 0 }, { allowed: false, retryAfterSeconds: 61 },
  { allowed: false, retryAfterSeconds: 1.5 }, { allowed: false, retryAfterSeconds: "1" },
  { allowed: false, retryAfterSeconds: 1, extra: true }]) test(`bad denial ${JSON.stringify(denied)} fails closed`, async () => {
  const f = fixture({ admit: async () => denied }); await failure(await f.handler(request()), "API_UNAVAILABLE", 503); noWrites(f);
});

for (const [label, options, code, status] of [
  ["no media", { headers: { "content-type": null } }, "API_MEDIA_TYPE", 415],
  ["text media", { headers: { "content-type": "text/plain" } }, "API_MEDIA_TYPE", 415],
  ["compressed", { headers: { "content-encoding": "gzip" } }, "API_MEDIA_TYPE", 415],
  ["no body", { raw: null }, "API_INPUT_INVALID", 400], ["bad JSON", { raw: "{invalid" }, "API_INPUT_INVALID", 400],
  ["array", { raw: "[]" }, "API_INPUT_INVALID", 400],
  ["duplicate keys", { raw: '{"candidateId":"a","candidateId":"b"}' }, "API_INPUT_INVALID", 400],
  ["excess bytes", { raw: JSON.stringify({ padding: "x".repeat(16384) }) }, "API_BODY_TOO_LARGE", 413],
  ["declared excess", { headers: { "content-length": "16385" } }, "API_BODY_TOO_LARGE", 413],
  ["wrong length", { headers: { "content-length": "1" } }, "API_INPUT_INVALID", 400],
  ["invalid length", { headers: { "content-length": "-1" } }, "API_INPUT_INVALID", 400],
] as Array<[string, RequestOptions, ReviewHttpError, number]>) test(`body ${label} is rejected before transaction`, async () => {
  const f = fixture(); await failure(await f.handler(request("preview", draft(), options)), code, status);
  assert.equal(f.admissions.length, 1); assert.equal(f.controls.transactions, 0); noWrites(f);
});
for (const [action, command] of [["preview", { ...draft(), authority: reviewAuthority() }],
  ["preview", { ...draft(), values: { ...reviewValues(), extra: true } }], ["confirm", {}], ["reject", {}], ["delete", {}],
  ["get", { benefitId: "missing", ownerId: REVIEW_OWNER }], ["list", { limit: 0, cursor: null }],
  ["list", { limit: 51, cursor: null }], ["list", { limit: 1 }]] as const) test(`invalid ${action} command cannot mutate`, async () => {
  const f = fixture(); await failure(await f.handler(request(action, command)), "API_INPUT_INVALID", 400); noWrites(f);
});

for (const stage of ["readSession", "admit", "transaction"] as const) test(`thrown ${stage} detail is redacted without retry`, async () => {
  const f = fixture(); let calls = 0;
  f.overrides[stage] = async () => { calls++; throw Error(SYNTHETIC_PRIVATE); };
  await failure(await f.handler(request()), "API_UNAVAILABLE", 503); assert.equal(calls, 1); noWrites(f);
});
test("malformed persisted benefit content cannot cross the projection boundary", async () => {
  const f = fixture(), first = await saved(f), row = f.store.rows.benefits.get(first.value.benefitId)!;
  f.store.rows.benefits.set(row.id, { ...row, content: { ...row.content!, accountProof: "wrong" } as unknown as typeof row.content });
  const before = f.store.snapshot();
  await failure(await f.handler(request("get", { benefitId: row.id })), "API_UNAVAILABLE", 503);
  await failure(await f.handler(request("list", { limit: 50, cursor: null })), "API_UNAVAILABLE", 503);
  assert.deepEqual(f.store.snapshot(), before);
});
for (const patch of [{ ownerId: "other-owner" }, { sessionId: "other-session" }, { sessionRevision: 2 },
  { dataGeneration: 2 }, { expiresAt: REVIEW_NOW + 599999 }]) test(`admission cannot rebind ${Object.keys(patch)[0]}`, async () => {
  const f = fixture(); f.overrides.admit = async (input) => { f.controls.authority = reviewAuthority(patch); return grant(input); };
  await failure(await f.handler(request()), "API_SESSION_CHANGED", 403); noWrites(f);
});
test("every reauthorization boundary catches persistent owner change including after commit", async (t) => {
  const baseline = fixture(); await preview(baseline); const reads = baseline.sessions.length;
  assert.ok(reads >= 6);
  for (let index = 2; index <= reads; index++) await t.test(`session reread ${index}/${reads}`, async () => {
    const f = fixture(); f.overrides.readSession = async () => {
      if (f.sessions.length === index) f.controls.authority = reviewAuthority({ ownerId: "owner-B", sessionId: "session-B" });
      return structuredClone(f.controls.authority);
    };
    await failure(await f.handler(request()), "API_SESSION_CHANGED", 403);
    for (const row of f.store.rows.previews.values()) assert.equal(row.ownerId, REVIEW_OWNER);
    assert.equal(f.store.rows.benefits.size, 0);
    if (f.controls.commits === 1) assert.equal(f.controls.rollbacks, 0, "suppressed output does not imply rollback");
    else noWrites(f);
  });
});

test("pre-aborted request invokes no asynchronous adapter", async () => {
  const f = fixture(), abort = new AbortController(); abort.abort(SYNTHETIC_PRIVATE);
  await failure(await f.handler(request("preview", draft(), { signal: abort.signal })), "API_ABORTED", 408);
  assert.equal(f.sessions.length, 0); assert.equal(f.admissions.length, 0); noWrites(f);
});
for (const phase of ["session", "admission", "transaction"] as const) for (const ending of ["resolve", "reject"] as const) {
  test(`cancel pending ${phase} then late ${ending} cannot resume writes`, { timeout: 5000 }, async () => {
    const f = fixture(), entered = deferred<void>(), late = deferred<unknown>(), abort = new AbortController();
    if (phase === "session") f.overrides.readSession = async () => { entered.resolve(); return late.promise; };
    if (phase === "admission") f.overrides.admit = async () => { entered.resolve(); return late.promise; };
    if (phase === "transaction") f.overrides.transaction = async (authority, action) => {
      entered.resolve(); await late.promise; return f.store.dependencies.transaction(authority, action);
    };
    const pending = f.handler(request("preview", draft(), { signal: abort.signal })); await entered.promise;
    abort.abort(SYNTHETIC_PRIVATE); await failure(await pending, "API_ABORTED", 408);
    if (ending === "reject") late.reject(Error(SYNTHETIC_PRIVATE));
    else late.resolve(phase === "session" ? reviewAuthority() : phase === "admission" ? grant(f.admissions[0]!.request) : undefined);
    await nextTurn(); await nextTurn(); noWrites(f);
    assert.ok(f.sessions.every(({ signal }) => signal.aborted));
  });
}
for (const phase of ["session", "admission", "transaction"] as const) test(`deadline stops pending ${phase} and handles late rejection`, async () => {
  const f = fixture({ requestTimeoutMs: 250 }), late = deferred<unknown>();
  if (phase === "session") f.overrides.readSession = async () => late.promise;
  if (phase === "admission") f.overrides.admit = async () => late.promise;
  if (phase === "transaction") f.overrides.transaction = async () => { await late.promise; throw Error(SYNTHETIC_PRIVATE); };
  await failure(await f.handler(request()), "API_TIMEOUT", 408);
  late.reject(Error(SYNTHETIC_PRIVATE)); await nextTurn(); noWrites(f);
  assert.ok(f.sessions.every(({ signal }) => signal.aborted));
});
for (const interruption of ["abort", "timeout"] as const) test(`confirm ${interruption} after commit preserves row/revision for exact retry`, { timeout: 5000 }, async () => {
  const f = fixture({ requestTimeoutMs: 500 }), p = await preview(f), command = confirmInput(p.previewId);
  const committed = deferred<void>(), ack = deferred<void>(), abort = new AbortController();
  const commitsBefore = f.controls.commits;
  f.controls.afterCommit = async () => { committed.resolve(); await ack.promise; };
  const pending = f.handler(request("confirm", command, { signal: abort.signal })); await committed.promise;
  if (interruption === "abort") abort.abort(SYNTHETIC_PRIVATE);
  await failure(await pending, interruption === "abort" ? "API_ABORTED" : "API_TIMEOUT", 408);
  assert.equal(f.controls.commits, commitsBefore + 1); assert.equal(f.controls.rollbacks, 0);
  assert.equal(f.store.rows.benefits.size, 1); assert.equal(f.store.rows.operations.size, 1);
  assert.equal(f.store.rows.benefitsRevisions.get(benefitCollectionRevisionKey(REVIEW_OWNER, 1)), 2);
  ack.resolve(); await nextTurn(); await nextTurn(); delete f.controls.afterCommit;
  const retry = await success<ReviewedBenefitView>(await f.handler(request("confirm", command)));
  assert.equal(retry.outcome, "saved"); assert.equal(f.store.rows.benefits.size, 1);
  assert.equal(f.store.rows.operations.size, 1);
  assert.equal(f.store.rows.benefitsRevisions.get(benefitCollectionRevisionKey(REVIEW_OWNER, 1)), 2);
});

test("abort during body reading cancels its stream without a transaction", { timeout: 5000 }, async () => {
  const f = fixture(), reading = deferred<void>(), abort = new AbortController(); let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); return new Promise<void>(() => {}); }, cancel() { cancelled++; } });
  const pending = f.handler(request("preview", undefined, { raw: stream, signal: abort.signal }));
  await reading.promise; await nextTurn(); abort.abort(SYNTHETIC_PRIVATE);
  await failure(await pending, "API_ABORTED", 408);
  assert.equal(cancelled, 1); assert.equal(f.controls.transactions, 0); noWrites(f);
});
for (const scope of ["session", "permit", "overall"] as const) test(`${scope} deadline is forwarded and blocks exact-deadline commit`, async () => {
  const f = fixture({ requestTimeoutMs: 2000 }); let deadline = REVIEW_NOW + 2000;
  if (scope === "session") { deadline = REVIEW_NOW + 1000; f.controls.authority = reviewAuthority({ expiresAt: deadline }); }
  if (scope === "permit") { deadline = REVIEW_NOW + 1000; f.overrides.admit = async (input) => ({ ...grant(input), expiresAt: deadline }); }
  const registered: number[] = [];
  f.overrides.transaction = (authority, action) => f.store.dependencies.transaction(authority, (tx) => action({ ...tx,
    limitCommitTime(notAfter) { registered.push(notAfter); tx.limitCommitTime(notAfter); },
  }));
  f.controls.beforeCommit = () => { f.controls.now = deadline; };
  await failure(await f.handler(request()), scope === "session" ? "API_SESSION_CHANGED" : "API_TIMEOUT", scope === "session" ? 403 : 408);
  assert.ok(registered.includes(deadline)); assert.equal(f.controls.rollbacks, 1); noWrites(f);
});
test("short permit expiring during pending body is timeout, not user abort", async () => {
  const f = fixture({ requestTimeoutMs: 2000 });
  f.overrides.admit = async (input) => ({ ...grant(input), expiresAt: REVIEW_NOW + 250 });
  const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
  await failure(await f.handler(request("preview", undefined, { raw: stream })), "API_TIMEOUT", 408); noWrites(f);
});
for (const clock of [NaN, Infinity, -1, REVIEW_NOW - 1]) test(`bad/backward clock ${String(clock)} fails closed`, async () => {
  const f = fixture(); f.overrides.admit = async (input) => { f.controls.now = clock; return grant(input); };
  await failure(await f.handler(request()), "API_UNAVAILABLE", 503); noWrites(f);
});
