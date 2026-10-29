import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createInboxDiscardHttpHandler } from "../src/server/http/inbox-discard-http.ts";
import { INBOX_DISCARD_HTTP_PATH, INBOX_DISCARD_REQUEST_HEADER, MAX_INBOX_DISCARD_REQUEST_BYTES,
  MAX_INBOX_DISCARD_RESPONSE_BYTES, MAX_INBOX_DISCARD_REQUEST_MS,
  type InboxDiscardHttpDependencies, type InboxDiscardAdmissionRequest } from "../src/server/http/inbox-discard-http-contracts.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import { handleRequest } from "../src/server/runtime-policy.ts";
import { createCandidateSelectionFixture } from "./support/candidate-selection-fixture.ts";
import { REVIEW_NOW, REVIEW_OWNER, SYNTHETIC_PRIVATE, analysisAuthority, candidateRow,
  reviewAuthority, reviewValues } from "./support/review-memory-store.ts";

// Real analysis -> staging/reference -> internal mutation handler, synthetic
// serialized memory/auth/limiter ports only. No real mailbox, DB or public mount.
const ORIGIN = "https://discard.example.test", COOKIE = "synthetic-session=fixture";
const REFERENCE: string = "synthetic-discard-batch-reference";
const permit = (request: InboxDiscardAdmissionRequest) => ({ allowed: true, surface: request.surface,
  requestId: request.requestId, action: request.action, authority: request.authority, expiresAt: request.notAfter });
async function fixture(overrides: Partial<InboxDiscardHttpDependencies> = {}, pendingWindowMs = 86400000) {
  const source = await createCandidateSelectionFixture(REVIEW_NOW, pendingWindowMs, () => REFERENCE), { store } = source;
  const initial = store.snapshot(), initialGrants = [store.controls.analysisChecks, store.controls.stagingGrantReads];
  const sessions: AbortSignal[] = [], admissions: InboxDiscardAdmissionRequest[] = [], resolutions: AbortSignal[] = [];
  const deps: InboxDiscardHttpDependencies = {
    trustedOrigin: ORIGIN, ...overrides,
    now: () => overrides.now ? overrides.now() : store.controls.now,
    newId: () => overrides.newId ? overrides.newId() : store.dependencies.newId(),
    readSession: async (context, signal) => {
      sessions.push(signal); assert.deepEqual(context, { cookie: COOKIE });
      return overrides.readSession ? overrides.readSession(context, signal) : structuredClone(store.controls.authority);
    },
    admit: async (request, signal) => {
      admissions.push(request); return overrides.admit ? overrides.admit(request, signal) : permit(request);
    },
    resolveBatch: async (request, signal) => {
      resolutions.push(signal);
      return overrides.resolveBatch ? overrides.resolveBatch(request, signal) : source.references.resolve(request, signal);
    },
    transaction: (authority, action) => (overrides.transaction ?? store.referenceDependencies.transaction)(authority, action),
  };
  const target = source.batch.candidates[0]!;
  const command = Object.freeze({ batchReference: REFERENCE, candidateId: target.candidateId,
    expectedRevision: target.candidateRevision, decision: "discard" });
  return { ...source, initial, initialGrants, overrides, deps, sessions, admissions, resolutions, command,
    handler: createInboxDiscardHttpHandler(deps) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Options = { url?: string; method?: string; headers?: Record<string, string | null>; raw?: BodyInit | null; signal?: AbortSignal };
function request(command: unknown, options: Options = {}) {
  const headers = new Headers({ "content-type": "application/json", origin: ORIGIN, cookie: COOKIE,
    "x-keyatlas-request": INBOX_DISCARD_REQUEST_HEADER, "sec-fetch-site": "same-origin" });
  for (const [key, value] of Object.entries(options.headers ?? {})) value === null ? headers.delete(key) : headers.set(key, value);
  const method = options.method ?? "POST";
  const init: RequestInit & { duplex?: "half" } = { method, headers, ...(options.signal ? { signal: options.signal } : {}) };
  if (method !== "GET" && method !== "HEAD") {
    init.body = "raw" in options ? options.raw : JSON.stringify(command);
    if (init.body instanceof ReadableStream) init.duplex = "half";
  }
  const value = new Request(options.url ?? `${ORIGIN}${INBOX_DISCARD_HTTP_PATH}`, init);
  for (const [key, entry] of Object.entries(options.headers ?? {})) if (entry === null) value.headers.delete(key);
  return value;
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
  assert.ok(Buffer.byteLength(text) <= MAX_INBOX_DISCARD_RESPONSE_BYTES);
  for (const value of [COOKIE, REVIEW_OWNER, SYNTHETIC_PRIVATE, analysisAuthority().operationId,
    "Synthetic Service grants 100 credits.", "synthetic-selection-mail-not-retained"])
    assert.equal(text.includes(value), false, value);
  for (const key of ["ownerId", "sessionId", "sessionRevision", "analysisOperationId", "mailboxBindingId",
    "grantId", "fingerprint", "replayed", "source", "quote", "serviceName", "receivedAt"])
    assert.equal(text.includes(`"${key}"`), false, key);
  return JSON.parse(text) as Record<string, unknown>;
}
async function success(f: Fixture, response: Response) {
  const value = await body(response);
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.deepEqual(value, { ok: true, value: { batchReference: REFERENCE, candidateId: f.command.candidateId,
    candidateRevision: f.command.expectedRevision + 1, state: "deleted", content: null } });
  return value;
}
async function failure(response: Response, code: string, status: number) {
  assert.deepEqual(await body(response), { ok: false, code }); assert.equal(response.status, status);
  if (status !== 405) assert.equal(response.headers.get("allow"), null);
  if (status !== 429) assert.equal(response.headers.get("retry-after"), null);
}
function unchanged(f: Fixture, expected = f.initial) { assert.deepEqual(f.store.snapshot(), expected); }
function unchangedAnalysis(f: Fixture) {
  assert.deepEqual([f.store.controls.analysisChecks, f.store.controls.stagingGrantReads], f.initialGrants);
  assert.deepEqual(f.readAnalysisCounts(), { quota: 1, mailbox: 1, analysis: 1 });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("discard constants are a separate bounded mutation surface, not the existing read permit", () => {
  assert.equal(INBOX_DISCARD_HTTP_PATH, "/api/inbox/discard");
  assert.equal(INBOX_DISCARD_REQUEST_HEADER, "candidate-inbox-discard-v1");
  assert.equal(MAX_INBOX_DISCARD_REQUEST_BYTES, 1024);
  assert.equal(MAX_INBOX_DISCARD_RESPONSE_BYTES, 2048);
  assert.equal(MAX_INBOX_DISCARD_REQUEST_MS, 10000);
});

test("explicit discard erases one pending payload; exact retry returns the identical minimal receipt", async () => {
  const f = await fixture(), other = structuredClone(f.store.rows.candidates.get(f.batch.candidates[1]!.candidateId));
  const beforeCommits = f.store.controls.commits;
  const first = await success(f, await f.handler(request(f.command)));
  const erased = f.store.rows.candidates.get(f.command.candidateId)!;
  assert.equal(erased.state, "deleted"); assert.equal(erased.revision, 2); assert.equal(erased.content, null);
  assert.deepEqual(f.store.rows.candidates.get(f.batch.candidates[1]!.candidateId), other);
  const traceOffset = f.store.controls.trace.length, snapshot = f.store.snapshot();
  assert.deepEqual(await success(f, await f.handler(request(f.command))), first);
  unchanged(f, snapshot);
  assert.equal(f.store.controls.trace.slice(traceOffset).includes("updateCandidate"), false);
  assert.equal(f.store.controls.trace.slice(traceOffset).includes("eraseCandidatePreviews"), false);
  assert.equal(f.store.controls.commits, beforeCommits + 2);
  assert.ok(f.admissions.every((entry) => entry.surface === INBOX_DISCARD_REQUEST_HEADER && entry.action === "discard"));
  await failure(await f.handler(request({ ...f.command, expectedRevision: 2 })), "API_CONFLICT", 409);
  unchanged(f, snapshot); unchangedAnalysis(f);
});

test("linked pending preview is erased without deleting another accepted candidate or reviewed benefit", async () => {
  const f = await fixture(), review = createReviewService(f.store.dependencies);
  const pending = await review.preview({ candidateId: f.command.candidateId, candidateRevision: 1,
    serviceId: f.services[0]!.serviceId, serviceRevision: 1, values: reviewValues() });
  assert.ok(pending.ok);
  const second = f.batch.candidates[1]!;
  const otherPreview = await review.preview({ candidateId: second.candidateId, candidateRevision: 1,
    serviceId: f.services[1]!.serviceId, serviceRevision: 1, values: reviewValues() });
  assert.ok(otherPreview.ok);
  const accepted = await review.confirm({ previewId: otherPreview.value.id, operationId: "synthetic-keep-benefit", decision: "confirm" });
  assert.ok(accepted.ok);
  const beforeOther = structuredClone(f.store.rows.candidates.get(second.candidateId));
  const beforeBenefits = structuredClone(f.store.rows.benefits);
  await success(f, await f.handler(request(f.command)));
  assert.equal(f.store.rows.previews.get(pending.value.id)!.content, null);
  assert.deepEqual(f.store.rows.candidates.get(second.candidateId), beforeOther);
  assert.deepEqual(f.store.rows.benefits, beforeBenefits);
  const beforeRejected = f.store.snapshot();
  await failure(await f.handler(request({ ...f.command, candidateId: second.candidateId, expectedRevision: 2 })), "API_CONFLICT", 409);
  unchanged(f, beforeRejected); unchangedAnalysis(f);
});

test("expired pending candidate can be explicitly erased without renewal, new analysis or staging consent", async () => {
  const f = await fixture({}, 1000);
  f.store.controls.now += 1000;
  f.store.controls.analysisAuthority = null; f.store.controls.stagingGrant = null;
  await success(f, await f.handler(request(f.command)));
  assert.equal(f.store.rows.candidates.get(f.command.candidateId)!.expiresAt, REVIEW_NOW + 1000);
  unchangedAnalysis(f);
});

test("fresh current app session may discard its existing owner/generation batch without old mailbox grants", async () => {
  const f = await fixture();
  f.store.controls.authority = reviewAuthority({ sessionId: "synthetic-new-session", sessionRevision: 2 });
  f.store.controls.analysisAuthority = null; f.store.controls.stagingGrant = null;
  await success(f, await f.handler(request(f.command))); unchangedAnalysis(f);
});

for (const mismatch of ["unknown-alias", "missing-candidate", "foreign-owner", "wrong-generation", "other-batch"] as const)
  test(`discard ${mismatch} is generic not-found with no erasure`, async () => {
    const f = await fixture(); let command = { ...f.command };
    if (mismatch === "unknown-alias") command.batchReference = "synthetic-unknown-reference";
    if (mismatch === "missing-candidate") command.candidateId = "synthetic-missing-candidate";
    if (mismatch === "foreign-owner") f.store.controls.authority = reviewAuthority({ ownerId: "synthetic-other-owner" });
    if (mismatch === "wrong-generation") f.store.controls.authority = reviewAuthority({ dataGeneration: 2 });
    if (mismatch === "other-batch") {
      // Deliberate same-owner foreign-batch row: owner equality alone is not
      // enough to authorize a mutation through the selected batch reference.
      const foreign = candidateRow({ id: "synthetic-other-batch-candidate" });
      f.store.rows.candidates.set(foreign.id, foreign); command.candidateId = foreign.id;
    }
    const before = f.store.snapshot();
    await failure(await f.handler(request(command)), "API_NOT_FOUND", 404);
    unchanged(f, before); unchangedAnalysis(f);
  });

test("valid same-owner batch containing another candidate is not interchangeable with the selected batch", async () => {
  const f = await fixture();
  const original = [...f.store.rows.batches.values()][0]!;
  const otherId = "synthetic-other-batch-candidate", otherOperation = "synthetic-other-analysis-operation";
  const other = candidateRow({ id: otherId });
  const row = { ...other, content: { ...other.content!, analysisOperationId: otherOperation } };
  f.store.rows.candidates.set(otherId, row);
  f.store.rows.batches.set(JSON.stringify([REVIEW_OWNER, otherOperation]), { ...original,
    analysisOperationId: otherOperation, candidateIds: [otherId] });
  const before = f.store.snapshot();
  await failure(await f.handler(request({ ...f.command, candidateId: otherId })), "API_NOT_FOUND", 404);
  unchanged(f, before);
});

for (const corruption of ["missing", "duplicate-id", "bad-fingerprint", "wrong-analysis"] as const)
  test(`malformed backing batch ${corruption} is unavailable without partial erasure`, async () => {
    const f = await fixture(), [key, batch] = [...f.store.rows.batches.entries()][0]!;
    if (corruption === "missing") f.store.rows.batches.delete(key);
    else f.store.rows.batches.set(key, { ...batch,
      ...(corruption === "duplicate-id" ? { candidateIds: [f.command.candidateId, f.command.candidateId] } : {}),
      ...(corruption === "bad-fingerprint" ? { fingerprint: SYNTHETIC_PRIVATE } : {}),
      ...(corruption === "wrong-analysis" ? { analysisOperationId: "synthetic-corrupt-operation" } : {}),
    });
    const before = f.store.snapshot();
    await failure(await f.handler(request(f.command)), "API_UNAVAILABLE", 503); unchanged(f, before);
  });

for (const corruption of ["analysis", "mailbox", "extractedAt", "index", "access-expiry", "missing-content"] as const)
  test(`candidate-to-batch ${corruption} corruption cannot be erased as a valid member`, async () => {
    const f = await fixture(), row = f.store.rows.candidates.get(f.command.candidateId)!;
    const content = row.content!;
    f.store.rows.candidates.set(row.id, { ...row,
      ...(corruption === "access-expiry" ? { expiresAt: row.expiresAt + 1 } : {}),
      content: corruption === "missing-content" ? null : { ...content,
        ...(corruption === "analysis" ? { analysisOperationId: "synthetic-mismatched-operation" } : {}),
        ...(corruption === "mailbox" ? { mailboxBindingId: "synthetic-mismatched-mailbox" } : {}),
        ...(corruption === "extractedAt" ? { extractedAt: new Date(REVIEW_NOW - 1).toISOString() } : {}),
        ...(corruption === "index" ? { candidateIndex: 1 } : {}),
      },
    });
    const before = f.store.snapshot();
    await failure(await f.handler(request(f.command)), "API_UNAVAILABLE", 503); unchanged(f, before);
  });

test("safe-integer maximum expected revision conflicts instead of overflowing or partially erasing", async () => {
  const f = await fixture(), row = f.store.rows.candidates.get(f.command.candidateId)!;
  f.store.rows.candidates.set(row.id, { ...row, revision: Number.MAX_SAFE_INTEGER });
  const before = f.store.snapshot();
  await failure(await f.handler(request({ ...f.command, expectedRevision: Number.MAX_SAFE_INTEGER })), "API_CONFLICT", 409);
  unchanged(f, before);
});

test("concurrent exact requests erase once and both receive the same tombstone receipt", async () => {
  const f = await fixture(), offset = f.store.controls.trace.length;
  const responses = await Promise.all([f.handler(request(f.command)), f.handler(request(f.command))]);
  const first = await success(f, responses[0]!);
  assert.deepEqual(await success(f, responses[1]!), first);
  assert.equal(f.store.controls.trace.slice(offset).filter((entry) => entry === "updateCandidate").length, 1);
  assert.equal(f.store.controls.trace.slice(offset).filter((entry) => entry === "eraseCandidatePreviews").length, 1);
  unchangedAnalysis(f);
});

for (const options of [
  { url: `${ORIGIN}/api/inbox/batch` }, { url: `${ORIGIN}${INBOX_DISCARD_HTTP_PATH}/extra` },
] satisfies Options[]) test(`only exact mutation path is exposed: ${options.url}`, async () => {
  const f = await fixture(); await failure(await f.handler(request(f.command, options)), "API_NOT_FOUND", 404);
  assert.equal(f.sessions.length, 0); unchanged(f);
});

for (const method of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]) test(`method ${method} cannot discard`, async () => {
  const f = await fixture(), response = await f.handler(request(f.command, { method }));
  await failure(response, "API_METHOD_NOT_ALLOWED", 405); assert.equal(response.headers.get("allow"), "POST");
  assert.equal(f.sessions.length, 0); unchanged(f);
});

const rejectedRequests: Options[] = [
  { headers: { origin: null } }, { headers: { origin: "https://other.example.test" } },
  { headers: { "x-keyatlas-request": "candidate-inbox-v1" } }, { headers: { "x-keyatlas-request": null } },
  { headers: { "sec-fetch-site": "cross-site" } }, { headers: { authorization: "synthetic-not-allowed" } },
  { url: `${ORIGIN}${INBOX_DISCARD_HTTP_PATH}?candidateId=synthetic-query` },
  { url: `https://other.example.test${INBOX_DISCARD_HTTP_PATH}` },
];
for (const options of rejectedRequests) test(`request-origin/header/query rejection ${JSON.stringify(options)}`, async () => {
  const f = await fixture(); await failure(await f.handler(request(f.command, options)), "API_REQUEST_REJECTED", 403);
  assert.equal(f.sessions.length, 0); unchanged(f);
});

for (const cookie of [null, ""]) test(`missing cookie ${String(cookie)} cannot discard`, async () => {
  const f = await fixture(); await failure(await f.handler(request(f.command, { headers: { cookie } })), "API_AUTH_REQUIRED", 401);
  assert.equal(f.sessions.length, 0); unchanged(f);
});

for (const authority of [null, {}, reviewAuthority({ expiresAt: REVIEW_NOW }), reviewAuthority({ dataGeneration: 0 })])
  test(`invalid initial authority ${JSON.stringify(authority)} cannot enter mutation`, async () => {
    const f = await fixture({ readSession: async () => authority });
    await failure(await f.handler(request(f.command)), "API_AUTH_REQUIRED", 401);
    assert.equal(f.admissions.length, 0); assert.equal(f.resolutions.length, 0); unchanged(f);
  });

for (const patch of [
  { decision: "delete" }, { decision: "retire" }, { expectedRevision: 0 }, { expectedRevision: "1" },
  { candidateId: "synthetic-id\n" }, { batchReference: "" }, { operationId: "synthetic-extra" },
  { ownerId: REVIEW_OWNER }, { analysisOperationId: analysisAuthority().operationId },
]) test(`exact command rejects ${JSON.stringify(patch)}`, async () => {
  const f = await fixture(); await failure(await f.handler(request({ ...f.command, ...patch })), "API_INPUT_INVALID", 400);
  assert.equal(f.resolutions.length, 0); unchanged(f);
});

for (const raw of ["{", "[]", "null", "{}", "{\"batchReference\":\"x\",\"batchReference\":\"y\"}"])
  test(`malformed or incomplete JSON command ${raw}`, async () => {
    const f = await fixture(); await failure(await f.handler(request(null, { raw })), "API_INPUT_INVALID", 400); unchanged(f);
  });

test("bounded request body and media type fail before mutation", async () => {
  const f = await fixture();
  await failure(await f.handler(request(f.command, { headers: { "content-type": "text/plain" } })), "API_MEDIA_TYPE", 415);
  await failure(await f.handler(request(f.command, { raw: " ".repeat(MAX_INBOX_DISCARD_REQUEST_BYTES + 1) })), "API_BODY_TOO_LARGE", 413);
  assert.equal(f.resolutions.length, 0); unchanged(f);
});

test("read-only admission permit cannot authorize discard", async () => {
  const f = await fixture({ admit: async (value) => ({ ...permit(value), action: "batch", surface: "candidate-inbox-v1" }) });
  await failure(await f.handler(request(f.command)), "API_UNAVAILABLE", 503);
  assert.equal(f.resolutions.length, 0); unchanged(f);
});

test("rate rejection has bounded exact retry hint and never resolves a candidate", async () => {
  const f = await fixture({ admit: async () => ({ allowed: false, retryAfterSeconds: 3 }) });
  const response = await f.handler(request(f.command));
  await failure(response, "API_RATE_LIMITED", 429); assert.equal(response.headers.get("retry-after"), "3");
  assert.equal(f.resolutions.length, 0); unchanged(f);
});

for (const phase of ["readSession", "admit", "resolveBatch", "transaction"] as const)
  test(`throwing ${phase} is private, fixed unavailable and not automatically retried`, async () => {
    const f = await fixture(); let calls = 0;
    f.overrides[phase] = async () => { calls++; throw new Error(SYNTHETIC_PRIVATE); };
    await failure(await f.handler(request(f.command)), "API_UNAVAILABLE", 503);
    assert.equal(calls, 1); unchanged(f);
  });

for (const method of ["updateCandidate", "eraseCandidatePreviews"] as const)
  test(`failure inside ${method} rolls back candidate and preview erasure atomically`, async () => {
    const f = await fixture();
    const preview = await createReviewService(f.store.dependencies).preview({ candidateId: f.command.candidateId,
      candidateRevision: 1, serviceId: f.services[0]!.serviceId, serviceRevision: 1, values: reviewValues() });
    assert.ok(preview.ok);
    const before = f.store.snapshot();
    f.store.controls.afterMethod = (current) => { if (current === method) throw new Error(SYNTHETIC_PRIVATE); };
    await failure(await f.handler(request(f.command)), "API_UNAVAILABLE", 503); unchanged(f, before);
  });

test("post-commit lost acknowledgement keeps tombstone and exact replay does not re-erase", async () => {
  const f = await fixture(), before = f.store.controls.commits;
  f.store.controls.afterCommit = () => { throw new Error(SYNTHETIC_PRIVATE); };
  await failure(await f.handler(request(f.command)), "API_UNAVAILABLE", 503);
  assert.equal(f.store.controls.commits, before + 1); assert.equal(f.store.controls.rollbacks, 0);
  assert.equal(f.store.rows.candidates.get(f.command.candidateId)!.content, null);
  delete f.store.controls.afterCommit;
  const snapshot = f.store.snapshot(), offset = f.store.controls.trace.length;
  await success(f, await f.handler(request(f.command))); unchanged(f, snapshot);
  assert.equal(f.store.controls.trace.slice(offset).includes("updateCandidate"), false);
});

test("post-commit authority change suppresses receipt without claiming rollback", async () => {
  const f = await fixture(), before = f.store.controls.commits;
  f.store.controls.afterCommit = () => { f.store.controls.authority = reviewAuthority({ sessionRevision: 2 }); };
  await failure(await f.handler(request(f.command)), "API_SESSION_CHANGED", 403);
  assert.equal(f.store.controls.commits, before + 1); assert.equal(f.store.controls.rollbacks, 0);
  assert.equal(f.store.rows.candidates.get(f.command.candidateId)!.state, "deleted");
  delete f.store.controls.afterCommit;
  // Same owner/generation, new legitimate current app session; not a stale token.
  await success(f, await f.handler(request(f.command)));
});

test("session revocation during tentative erasure rolls the whole mutation back", async () => {
  const f = await fixture(), before = f.store.controls.commits;
  f.store.controls.afterMethod = (method) => {
    if (method === "updateCandidate") f.store.controls.authority = reviewAuthority({ sessionRevision: 2 });
  };
  await failure(await f.handler(request(f.command)), "API_SESSION_CHANGED", 403);
  assert.equal(f.store.controls.commits, before); unchanged(f);
});

for (const [label, authority] of [
  ["owner", reviewAuthority({ ownerId: "synthetic-other-owner" })],
  ["session", reviewAuthority({ sessionId: "synthetic-replaced-session" })],
  ["session revision", reviewAuthority({ sessionRevision: 2 })],
  ["data generation", reviewAuthority({ dataGeneration: 2 })],
  ["revoked session", null],
] as const) test(`${label} change at commit rolls back both candidate and linked preview erasure`, async () => {
  const f = await fixture();
  const preview = await createReviewService(f.store.dependencies).preview({ candidateId: f.command.candidateId,
    candidateRevision: 1, serviceId: f.services[0]!.serviceId, serviceRevision: 1, values: reviewValues() });
  assert.ok(preview.ok);
  const before = f.store.snapshot(), commits = f.store.controls.commits, rollbacks = f.store.controls.rollbacks;
  const traceOffset = f.store.controls.trace.length;
  f.store.controls.beforeCommit = () => { f.store.controls.authority = authority; };
  await failure(await f.handler(request(f.command)), "API_SESSION_CHANGED", 403);
  const attempted = f.store.controls.trace.slice(traceOffset);
  assert.ok(attempted.includes("updateCandidate"));
  assert.ok(attempted.includes("eraseCandidatePreviews"));
  assert.equal(f.store.controls.commits, commits);
  assert.equal(f.store.controls.rollbacks, rollbacks + 1);
  unchanged(f, before); unchangedAnalysis(f);
});

test("serialization crossing request deadline suppresses a committed receipt without claiming rollback", async (t) => {
  const f = await fixture({ requestTimeoutMs: 1000 }), stringify = JSON.stringify;
  t.mock.method(JSON, "stringify", (value: unknown, ...args: unknown[]) => {
    const result = Reflect.apply(stringify, JSON, [value, ...args]) as string | undefined;
    if (value && typeof value === "object" && "ok" in value && value.ok === true && "value" in value
      && value.value && typeof value.value === "object" && "candidateRevision" in value.value) {
      f.store.controls.now = REVIEW_NOW + 1000;
    }
    return result;
  });
  const before = f.store.controls.commits;
  await failure(await f.handler(request(f.command)), "API_TIMEOUT", 408);
  assert.equal(f.store.controls.commits, before + 1); assert.equal(f.store.controls.rollbacks, 0);
  assert.equal(f.store.rows.candidates.get(f.command.candidateId)!.state, "deleted");
});

for (const bound of ["permit", "session", "overall"] as const) test(`${bound} exact deadline prevents mutation commit`, async () => {
  const f = await fixture({ requestTimeoutMs: 2000 });
  const deadline = REVIEW_NOW + (bound === "overall" ? 2000 : 1000), limits: number[] = [];
  if (bound === "session") f.store.controls.authority = reviewAuthority({ expiresAt: deadline });
  if (bound === "permit") f.overrides.admit = async (value) => ({ ...permit(value), expiresAt: deadline });
  f.overrides.transaction = (authority, task) => f.store.referenceDependencies.transaction(authority,
    (tx) => task({ ...tx, limitCommitTime(notAfter) { limits.push(notAfter); tx.limitCommitTime(notAfter); } }));
  f.store.controls.beforeCommit = () => { f.store.controls.now = deadline; };
  await failure(await f.handler(request(f.command)), bound === "session" ? "API_SESSION_CHANGED" : "API_TIMEOUT", bound === "session" ? 403 : 408);
  assert.ok(limits.includes(deadline)); unchanged(f);
});

test("atomic alias retirement at commit cannot erase candidates through a stale reference", async () => {
  const f = await fixture(), before = f.store.controls.commits;
  let external: ReturnType<typeof f.store.snapshot> | null = null;
  f.store.controls.beforeCommit = () => {
    const row = f.store.rows.batchReferences.get(REFERENCE)!;
    f.store.rows.batchReferences.set(REFERENCE, { ...row, state: "retired", revision: 2 }); external = f.store.snapshot();
  };
  await failure(await f.handler(request(f.command)), "API_CONFLICT", 409);
  assert.notEqual(external, null); assert.deepEqual(f.store.snapshot(), external);
  assert.equal(f.store.controls.commits, before); assert.equal(f.store.controls.rollbacks, 1);
  assert.equal(f.store.rows.candidates.get(f.command.candidateId)!.state, "pending");
});

test("alias retirement after acknowledged commit suppresses receipt but does not undo erasure", async () => {
  const f = await fixture(), before = f.store.controls.commits;
  f.store.controls.afterCommit = () => {
    const row = f.store.rows.batchReferences.get(REFERENCE)!;
    f.store.rows.batchReferences.set(REFERENCE, { ...row, state: "retired", revision: 2 });
  };
  await failure(await f.handler(request(f.command)), "API_CONFLICT", 409);
  assert.equal(f.store.controls.commits, before + 1); assert.equal(f.store.controls.rollbacks, 0);
  assert.equal(f.store.rows.candidates.get(f.command.candidateId)!.state, "deleted");
  delete f.store.controls.afterCommit;
  const snapshot = f.store.snapshot();
  await failure(await f.handler(request(f.command)), "API_NOT_FOUND", 404); unchanged(f, snapshot);
});

test("pre-aborted request performs no adapter call or mutation", async () => {
  const f = await fixture(), abort = new AbortController(); abort.abort(SYNTHETIC_PRIVATE);
  await failure(await f.handler(request(f.command, { signal: abort.signal })), "API_ABORTED", 408);
  assert.equal(f.sessions.length, 0); unchanged(f);
});

test("abort during body read cancels the reader before target lookup", async () => {
  const f = await fixture(), entered = deferred<void>(), abort = new AbortController(); let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull() { entered.resolve(); return new Promise<void>(() => {}); }, cancel() { cancelled++; } });
  const pending = f.handler(request(null, { raw: stream, signal: abort.signal }));
  await entered.promise; await nextTurn(); abort.abort(SYNTHETIC_PRIVATE);
  await failure(await pending, "API_ABORTED", 408); assert.equal(cancelled, 1); assert.equal(f.resolutions.length, 0); unchanged(f);
});

test("abort after committed erase retains tombstone and original retry is safe", async () => {
  const f = await fixture(), entered = deferred<void>(), ack = deferred<void>(), returned = deferred<void>(), abort = new AbortController();
  const before = f.store.controls.commits;
  f.store.controls.afterCommit = async () => { entered.resolve(); await ack.promise; returned.resolve(); };
  const pending = f.handler(request(f.command, { signal: abort.signal })); await entered.promise;
  abort.abort(SYNTHETIC_PRIVATE); await failure(await pending, "API_ABORTED", 408);
  assert.equal(f.store.controls.commits, before + 1); assert.equal(f.store.controls.rollbacks, 0);
  assert.equal(f.store.rows.candidates.get(f.command.candidateId)!.content, null);
  ack.resolve(); await returned.promise; await nextTurn(); delete f.store.controls.afterCommit;
  const snapshot = f.store.snapshot(); await success(f, await f.handler(request(f.command))); unchanged(f, snapshot);
});

test("hung resolver reaches finite timeout and a late rejection cannot erase anything", async () => {
  const f = await fixture({ requestTimeoutMs: 100 }), late = deferred<unknown>();
  f.overrides.resolveBatch = async () => late.promise;
  await failure(await f.handler(request(f.command)), "API_TIMEOUT", 408);
  late.reject(new Error(SYNTHETIC_PRIVATE)); await nextTurn(); await nextTurn(); unchanged(f);
});

test("public app still returns 503 for new discard descendant without rendering or invoking internal handler", async () => {
  const f = await fixture(); let renders = 0;
  const response = await handleRequest(request(f.command), {}, async () => { renders++; return f.handler(request(f.command)); });
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { code: "INTEGRATION_NOT_CONNECTED" });
  assert.equal(renders, 0); assert.equal(f.sessions.length, 0); unchanged(f);
});
