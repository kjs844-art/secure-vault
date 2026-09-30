import assert from "node:assert/strict";
import { test } from "node:test";
import { MAIL_LIMITS } from "../src/server/mail/contracts.ts";
import { runMailAnalysis, type MailAnalysisAdapters, type MailRunResult, type RunAuthority } from "../src/server/mail/run-analysis.ts";
import { createCandidateInbox } from "../src/server/inbox/candidate-inbox.ts";
import { INBOX_SCHEMA, MAX_PENDING_WINDOW_MS, type CandidateBatchView } from "../src/server/inbox/contracts.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import type { ReviewErrorCode, ReviewResult } from "../src/server/review/contracts.ts";
import {
  REVIEW_NOW, REVIEW_OWNER, SERVICE_ID, SYNTHETIC_PRIVATE,
  analysisAuthority, createReviewMemoryStore, operationKey, reviewAuthority, reviewValues, stagingGrant,
} from "./support/review-memory-store.ts";

// Real pure orchestration functions, synthetic in-memory adapters only. No real
// provider, database, durable inbox, production grant enforcement, or RLS proof.
type SuccessfulRun = Extract<MailRunResult, { ok: true }>;
function success<T>(result: ReviewResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}
function failure(result: ReviewResult<unknown>, code: ReviewErrorCode) {
  assert.ok(!result.ok, "unexpected success");
  assert.equal(result.code, code);
  assert.deepEqual(Object.keys(result).sort(), ["code", "ok"]);
  assert.ok(!JSON.stringify(result).includes(SYNTHETIC_PRIVATE));
  assert.ok(Object.isFrozen(result));
}
function frozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozenTree(child);
}
function fixture() {
  const store = createReviewMemoryStore();
  store.rows.candidates.clear();
  return { store, controls: store.controls, inbox: createCandidateInbox(store.inboxDependencies),
    review: createReviewService(store.dependencies) };
}
type Fixture = ReturnType<typeof fixture>;

async function analysis(options: { count?: number; name?: string; partial?: boolean; fail?: boolean; authority?: RunAuthority } = {}) {
  const authority = options.authority ?? analysisAuthority();
  const calls = { mail: 0, analysis: 0 };
  const count = options.count ?? 1;
  const discovery = {
    evidence_message_index: 0, confidence: "high", benefit_kind: "credit",
    service_name: { value: "Synthetic Studio", part: "subject", quote: "Synthetic Studio" },
    benefit_name: { value: options.name ?? "Synthetic credits", part: "body", quote: "grants 100 credits" },
    unit: { value: "credits", part: "body", quote: "100 credits" },
    granted_amount: { value: 100, part: "body", quote: "grants 100 credits" },
    remaining_amount: null, trial_days: null, remaining_days: null, expires_at: null, observed_at: null,
  };
  const adapters: MailAnalysisAdapters = {
    readAuthority: async () => ({ ...authority, grantOwnerId: authority.ownerId,
      grantSessionId: authority.sessionId, grantMailboxBindingId: authority.mailboxBindingId }),
    reserveQuota: async ({ authority: current }) => ({ status: "granted", ownerId: current.ownerId,
      sessionId: current.sessionId, sessionRevision: current.sessionRevision, dataGeneration: current.dataGeneration,
      mailboxBindingId: current.mailboxBindingId, recipientId: current.recipientId, policyVersion: current.policyVersion,
      grantId: current.grantId, grantRevision: current.grantRevision, operationId: current.operationId, remaining: 0 }),
    readMailbox: async () => {
      calls.mail++;
      return JSON.stringify(count === 0 ? [] : [{ id: "synthetic-mail-id-not-retained",
        snippet: "Synthetic Studio grants 100 credits.", payload: {
          mimeType: options.partial ? "text/html" : "text/plain",
          headers: [{ name: "Subject", value: "Synthetic Studio notice" }],
          body: { data: Buffer.from("Synthetic Studio grants 100 credits.").toString("base64url") },
        } }]);
    },
    analyze: async () => {
      calls.analysis++;
      return options.fail ? "synthetic malformed response" : JSON.stringify({ schema: "keyatlas.gmail-candidates.v1",
        discoveries: Array.from({ length: count }, () => discovery) });
    },
    now: () => REVIEW_NOW,
  };
  const result = await runMailAnalysis(adapters, { operationId: authority.operationId,
    mailboxBindingId: authority.mailboxBindingId, recipientId: authority.recipientId });
  return { result, calls, authority };
}
async function successfulAnalysis(options: Parameters<typeof analysis>[0] = {}): Promise<SuccessfulRun> {
  const { result } = await analysis(options);
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}
async function staged(f: Fixture, options: Parameters<typeof analysis>[0] = {}) {
  const original = await successfulAnalysis(options);
  return { original, batch: success(await f.inbox.stage(original)) };
}
const listInput = () => ({ analysisOperationId: analysisAuthority().operationId });
const discardInput = (batch: CandidateBatchView) => ({
  candidateId: batch.candidates[0]!.id, expectedRevision: batch.candidates[0]!.revision, decision: "discard",
});
async function accept(f: Fixture, batch: CandidateBatchView) {
  const candidate = batch.candidates[0]!;
  const preview = success(await f.review.preview({ candidateId: candidate.id, candidateRevision: candidate.revision,
    serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues() }));
  return success(await f.review.confirm({ previewId: preview.id, operationId: "synthetic-confirm", decision: "confirm" }));
}

test("original successful runner result stages scalar candidates without mail text, IDs, quotes, or spans", async () => {
  const f = fixture();
  const { result, calls } = await analysis({ partial: true });
  assert.ok(result.ok);
  const stagedResult = await f.inbox.stage(result);
  const batch = success(stagedResult);
  assert.equal(batch.schema, INBOX_SCHEMA);
  assert.equal(batch.dataGeneration, 1);
  assert.equal(batch.replayed, false);
  assert.equal(batch.candidates.length, 1);
  const candidate = batch.candidates[0]!;
  assert.equal(candidate.state, "pending");
  assert.equal(candidate.revision, 1);
  assert.equal(candidate.expiresAt, stagingGrant().pendingAccessUntil);
  assert.equal(candidate.content!.serviceName, "Synthetic Studio");
  assert.equal(candidate.content!.values.name, "Synthetic credits");
  assert.equal(candidate.content!.values.observedAt, null);
  assert.equal(candidate.content!.receivedAt, null);
  assert.equal(candidate.content!.evidenceAvailability, "not-retained");
  assert.ok(candidate.content!.reviewReasons.includes("PARTIAL_MAIL_TEXT"));
  assert.ok(candidate.content!.reviewReasons.includes("NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF"));
  const text = JSON.stringify(f.store.snapshot(), (_key, value: unknown) => value instanceof Map ? [...value] : value);
  for (const excluded of ["synthetic-mail-id-not-retained", "Synthetic Studio grants 100 credits.", '"quote"', '"evidence"']) {
    assert.ok(!text.includes(excluded));
  }
  assert.equal(f.store.rows.candidates.size, 1);
  assert.equal(f.store.rows.batches.size, 1);
  assert.equal(f.store.rows.benefits.size, 0);
  assert.deepEqual(calls, { mail: 1, analysis: 1 });
  assert.ok(f.controls.trace.includes("requireCandidateStaging"));
  frozenTree(stagedResult);
});

test("stage, list, preview, confirm and remove connect through the same memory transaction boundary", async () => {
  const f = fixture();
  const { original, batch } = await staged(f);
  assert.deepEqual(success(await f.inbox.listBatch(listInput())).candidates, batch.candidates);
  const saved = await accept(f, batch);
  assert.equal(saved.content!.reviewStatus, "accepted-by-user");
  assert.equal(saved.content!.currentBalanceProof, "not-established");
  const accepted = success(await f.inbox.stage(original));
  assert.equal(accepted.replayed, true);
  assert.equal(accepted.candidates[0]!.state, "accepted");
  assert.equal(accepted.candidates[0]!.content, null);
  success(await f.review.remove({ benefitId: saved.benefitId, expectedRevision: saved.benefitRevision,
    operationId: "synthetic-delete", decision: "delete" }));
  const deleted = success(await f.inbox.stage(original));
  assert.equal(deleted.candidates[0]!.state, "deleted");
  assert.equal(deleted.candidates[0]!.content, null);
  assert.equal(f.store.rows.candidates.size, 1);
  assert.equal(f.store.rows.benefits.get(saved.benefitId)!.content, null);
});

test("repeated and concurrent original handoffs create one batch and one set of candidate IDs", async () => {
  const f = fixture();
  const original = await successfulAnalysis({ count: 3 });
  const results = await Promise.all([f.inbox.stage(original), f.inbox.stage(original)]);
  const first = success(results[0]!);
  const second = success(results[1]!);
  assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);
  assert.deepEqual(first.candidates.map((row) => row.id), second.candidates.map((row) => row.id));
  assert.equal(f.store.rows.candidates.size, 3);
  assert.equal(f.store.rows.batches.size, 1);
});

test("a completed empty batch has its own replay fence and does not call the analyzer", async () => {
  const f = fixture();
  const { result, calls } = await analysis({ count: 0 });
  assert.ok(result.ok);
  const first = success(await f.inbox.stage(result));
  const second = success(await f.inbox.stage(result));
  assert.deepEqual(first.candidates, []);
  assert.equal(second.replayed, true);
  assert.equal(f.store.rows.candidates.size, 0);
  assert.equal(f.store.rows.batches.size, 1);
  assert.equal(calls.analysis, 0);
});

for (const forgery of ["copy", "structured-clone", "JSON-copy", "minimal", "null", "failed"] as const) {
  test(`stage refuses an unregistered or unsuccessful handoff: ${forgery}`, async () => {
    const f = fixture();
    const original = await successfulAnalysis();
    const input = forgery === "copy" ? { ...original } : forgery === "structured-clone" ? structuredClone(original)
      : forgery === "JSON-copy" ? JSON.parse(JSON.stringify(original)) as unknown
        : forgery === "minimal" ? { ok: true, candidates: [] } : forgery === "null" ? null
          : (await analysis({ fail: true })).result;
    const before = f.store.snapshot();
    failure(await f.inbox.stage(input), "REVIEW_INPUT_INVALID");
    assert.deepEqual(f.store.snapshot(), before);
  });
}

for (const patch of [{ ownerId: "synthetic-other" }, { sessionId: "synthetic-other" }, { sessionRevision: 2 }, { dataGeneration: 2 }]) {
  test(`handoff cannot be reassigned to a different ${Object.keys(patch)[0]}`, async () => {
    const f = fixture();
    const original = await successfulAnalysis();
    f.controls.authority = reviewAuthority(patch);
    failure(await f.inbox.stage(original), "REVIEW_AUTHORITY_CHANGED");
    assert.equal(f.store.rows.batches.size, 0);
  });
}

const grantPatches: Array<[string, Record<string, unknown>]> = [
  ["storage revoked", { allowCandidateStorage: false }], ["storage missing", { allowCandidateStorage: undefined }],
  ["owner", { ownerId: "synthetic-other" }], ["session", { sessionId: "synthetic-other" }],
  ["session revision", { sessionRevision: 2 }], ["data generation", { dataGeneration: 2 }],
  ["operation", { analysisOperationId: "synthetic-other" }], ["mailbox", { mailboxBindingId: "synthetic-other" }],
  ["recipient", { recipientId: "synthetic-other" }], ["analysis grant", { analysisGrantId: "synthetic-other" }],
  ["analysis grant revision", { analysisGrantRevision: 2 }], ["policy", { policyVersion: "synthetic-other" }],
  ["expired", { expiresAt: REVIEW_NOW }], ["expired pending window", { pendingAccessUntil: REVIEW_NOW }],
  ["overlong pending window", { pendingAccessUntil: REVIEW_NOW + MAX_PENDING_WINDOW_MS + 1 }],
  ["fractional pending window", { pendingAccessUntil: REVIEW_NOW + 0.5 }],
];
for (const [name, patch] of grantPatches) {
  test(`staging grant fails closed before writing: ${name}`, async () => {
    const f = fixture();
    const original = await successfulAnalysis();
    f.controls.stagingGrant = { ...stagingGrant(), ...patch };
    const before = f.store.snapshot();
    failure(await f.inbox.stage(original), "REVIEW_AUTHORITY_CHANGED");
    assert.deepEqual(f.store.snapshot(), before);
  });
}

for (const change of ["revoked", "revision", "expiry"] as const) {
  test(`analysis authorization ${change} prevents candidate storage`, async () => {
    const f = fixture();
    const original = await successfulAnalysis();
    f.controls.analysisAuthority = change === "revoked" ? null
      : analysisAuthority(change === "revision" ? { grantRevision: 2 } : { grantExpiresAt: REVIEW_NOW });
    failure(await f.inbox.stage(original), "REVIEW_AUTHORITY_CHANGED");
    assert.equal(f.store.rows.candidates.size, 0);
  });
}

test("a different genuine handoff fingerprint for the same operation never replaces stored candidates", async () => {
  const f = fixture();
  await staged(f);
  // Independent synthetic runner adapters model conflicting upstream provenance;
  // this is not a claim that a correctly enforced production quota allows replay.
  const conflicting = await successfulAnalysis({ name: "Different synthetic candidate" });
  const before = f.store.snapshot();
  failure(await f.inbox.stage(conflicting), "REVIEW_OPERATION_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
});

for (const patch of [{ revision: 2 }, { pendingAccessUntil: REVIEW_NOW + 2 * 86400000 }]) {
  test(`a new staging ${Object.keys(patch)[0]} cannot rewrite or extend an existing operation batch`, async () => {
    const f = fixture();
    const { original } = await staged(f);
    const before = f.store.snapshot();
    f.controls.stagingGrant = stagingGrant(patch);
    failure(await f.inbox.stage(original), "REVIEW_OPERATION_CONFLICT");
    assert.deepEqual(f.store.snapshot(), before);
  });
}

test("a completed empty batch cannot later acquire candidates under the same operation", async () => {
  const f = fixture();
  await staged(f, { count: 0 });
  const before = f.store.snapshot();
  failure(await f.inbox.stage(await successfulAnalysis()), "REVIEW_OPERATION_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
});

test("list uses owned stored data and does not query mailbox, AI, or staging grants", async () => {
  const f = fixture();
  const { batch } = await staged(f);
  const calls = { analysis: f.controls.analysisChecks, grants: f.controls.stagingGrantReads };
  f.controls.analysisAuthority = null;
  f.controls.stagingGrant = null;
  f.controls.isAnalysisAuthorized = () => { throw new Error(SYNTHETIC_PRIVATE); };
  f.controls.readStagingGrant = () => { throw new Error(SYNTHETIC_PRIVATE); };
  assert.deepEqual(success(await f.inbox.listBatch(listInput())).candidates, batch.candidates);
  assert.equal(f.controls.analysisChecks, calls.analysis);
  assert.equal(f.controls.stagingGrantReads, calls.grants);
});

for (const patch of [{ ownerId: "synthetic-other" }, { dataGeneration: 2 }]) {
  test(`list never reveals a batch owned by a different ${Object.keys(patch)[0]}`, async () => {
    const f = fixture();
    await staged(f);
    f.controls.authority = reviewAuthority(patch);
    failure(await f.inbox.listBatch(listInput()), "REVIEW_NOT_FOUND");
  });
}

test("unknown batch is generic not-found", async () => {
  const f = fixture();
  failure(await f.inbox.listBatch({ analysisOperationId: "synthetic-unknown" }), "REVIEW_NOT_FOUND");
});

test("expired pending candidates are hidden without claiming physical erasure and can be discarded", async () => {
  const f = fixture();
  f.controls.stagingGrant = stagingGrant({ pendingAccessUntil: REVIEW_NOW + 1000 });
  const { batch } = await staged(f);
  f.controls.now = REVIEW_NOW + 1000;
  const listed = success(await f.inbox.listBatch(listInput()));
  assert.equal(listed.candidates[0]!.state, "expired");
  assert.equal(listed.candidates[0]!.content, null);
  assert.notEqual(f.store.rows.candidates.get(batch.candidates[0]!.id)!.content, null);
  failure(await f.review.preview({ candidateId: batch.candidates[0]!.id, candidateRevision: 1,
    serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues() }), "REVIEW_CONFLICT");
  const discarded = success(await f.inbox.discard(discardInput(batch)));
  assert.equal(discarded.state, "deleted");
  assert.equal(discarded.content, null);
  assert.equal(f.store.rows.candidates.get(discarded.candidateId)!.content, null);
});

test("a reviewed benefit remains removable after its original pending candidate access deadline", async () => {
  const f = fixture();
  f.controls.stagingGrant = stagingGrant({ pendingAccessUntil: REVIEW_NOW + 1000 });
  const { batch } = await staged(f);
  const saved = await accept(f, batch);
  f.controls.now = REVIEW_NOW + 1000;
  const removed = success(await f.review.remove({ benefitId: saved.benefitId, expectedRevision: saved.benefitRevision,
    operationId: "synthetic-delete", decision: "delete" }));
  assert.equal(removed.content, null);
  assert.equal(removed.outcome, "deleted");
});

test("discard erases candidate and linked pending preview payloads and exact retry only replays the tombstone", async () => {
  const f = fixture();
  const { original, batch } = await staged(f);
  const candidate = batch.candidates[0]!;
  const preview = success(await f.review.preview({ candidateId: candidate.id, candidateRevision: candidate.revision,
    serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues() }));
  const input = discardInput(batch);
  const first = success(await f.inbox.discard(input));
  assert.equal(first.replayed, false);
  assert.equal(first.revision, 2);
  assert.equal(f.store.rows.previews.get(preview.id)!.content, null);
  const second = success(await f.inbox.discard(input));
  assert.equal(second.replayed, true);
  assert.equal(second.revision, first.revision);
  assert.equal(success(await f.inbox.stage(original)).candidates[0]!.content, null);
  failure(await f.inbox.discard({ ...input, expectedRevision: 2 }), "REVIEW_CONFLICT");
  frozenTree(first);
});

test("discard cannot remove an accepted candidate or its reviewed benefit", async () => {
  const f = fixture();
  const { batch } = await staged(f);
  const saved = await accept(f, batch);
  const before = f.store.snapshot();
  failure(await f.inbox.discard({ ...discardInput(batch), expectedRevision: 2 }), "REVIEW_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(f.store.rows.benefits.get(saved.benefitId)!.state, "live");
});

for (const mismatch of ["missing", "other-owner", "generation"]) {
  test(`discard ${mismatch} candidate is generic not-found`, async () => {
    const f = fixture();
    const { batch } = await staged(f);
    const candidate = batch.candidates[0]!;
    if (mismatch === "other-owner") f.controls.authority = reviewAuthority({ ownerId: "synthetic-other" });
    if (mismatch === "generation") f.controls.authority = reviewAuthority({ dataGeneration: 2 });
    failure(await f.inbox.discard({ ...discardInput(batch), candidateId: mismatch === "missing" ? "synthetic-missing" : candidate.id }), "REVIEW_NOT_FOUND");
  });
}

test("discard revision overflow is a conflict without partial erasure", async () => {
  const f = fixture();
  const { batch } = await staged(f);
  const row = f.store.rows.candidates.get(batch.candidates[0]!.id)!;
  f.store.rows.candidates.set(row.id, { ...row, revision: Number.MAX_SAFE_INTEGER });
  const before = f.store.snapshot();
  failure(await f.inbox.discard({ ...discardInput(batch), expectedRevision: Number.MAX_SAFE_INTEGER }), "REVIEW_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
});

for (const method of ["insertCandidate", "insertCandidateBatch"] as const) {
  for (const fault of ["throw-after", "false"] as const) {
    test(`stage ${method} ${fault} rolls back candidates, unique slots, and batch together`, async () => {
      const f = fixture();
      const original = await successfulAnalysis({ count: 3 });
      if (fault === "false") f.controls.falseMethod = method;
      else f.controls.afterMethod = (current) => { if (current === method) throw new Error(SYNTHETIC_PRIVATE); };
      const before = f.store.snapshot();
      failure(await f.inbox.stage(original), fault === "false" ? "REVIEW_CONFLICT" : "REVIEW_STORE_UNAVAILABLE");
      assert.deepEqual(f.store.snapshot(), before);
    });
  }
}

for (const method of ["updateCandidate", "eraseCandidatePreviews"] as const) {
  test(`discard ${method} exception rolls back all erasure`, async () => {
    const f = fixture();
    const { batch } = await staged(f);
    f.controls.afterMethod = (current) => { if (current === method) throw new Error(SYNTHETIC_PRIVATE); };
    const before = f.store.snapshot();
    failure(await f.inbox.discard(discardInput(batch)), "REVIEW_STORE_UNAVAILABLE");
    assert.deepEqual(f.store.snapshot(), before);
  });
}

for (const change of ["session", "generation", "analysis", "storage", "analysis-revision", "storage-revision", "expiry"] as const) {
  test(`registered grants and authority are rechecked atomically at commit: ${change}`, async () => {
    const f = fixture();
    const original = await successfulAnalysis();
    f.controls.beforeCommit = () => {
      if (change === "session") f.controls.authority = reviewAuthority({ sessionRevision: 2 });
      if (change === "generation") f.controls.authority = reviewAuthority({ dataGeneration: 2 });
      if (change === "analysis") f.controls.analysisAuthority = null;
      if (change === "storage") f.controls.stagingGrant = { ...stagingGrant(), allowCandidateStorage: false };
      if (change === "analysis-revision") f.controls.analysisAuthority = analysisAuthority({ grantRevision: 2 });
      if (change === "storage-revision") f.controls.stagingGrant = stagingGrant({ revision: 2 });
      if (change === "expiry") f.controls.now = stagingGrant().expiresAt;
    };
    const before = f.store.snapshot();
    failure(await f.inbox.stage(original), "REVIEW_STORE_UNAVAILABLE");
    assert.deepEqual(f.store.snapshot(), before);
  });
}

for (const action of ["stage", "list", "discard"] as const) {
  test(`${action} drops payload after a post-commit authority change without claiming rollback`, async () => {
    const f = fixture();
    const original = await successfulAnalysis();
    const batch = action === "stage" ? null : success(await f.inbox.stage(original));
    const commitsBefore = f.controls.commits;
    f.controls.afterCommit = () => { f.controls.authority = reviewAuthority({ sessionRevision: 2 }); };
    const result = action === "stage" ? await f.inbox.stage(original)
      : action === "list" ? await f.inbox.listBatch(listInput()) : await f.inbox.discard(discardInput(batch!));
    failure(result, "REVIEW_AUTHORITY_CHANGED");
    assert.equal(f.controls.commits, commitsBefore + 1);
    if (action === "stage") assert.equal(f.store.rows.batches.size, 1);
    if (action === "discard") assert.equal(f.store.rows.candidates.get(batch!.candidates[0]!.id)!.content, null);
  });
}

test("an uncertain post-commit stage error does not duplicate the batch on exact retry", async () => {
  const f = fixture();
  const original = await successfulAnalysis();
  f.controls.afterCommit = () => { throw new Error(SYNTHETIC_PRIVATE); };
  failure(await f.inbox.stage(original), "REVIEW_STORE_UNAVAILABLE");
  assert.equal(f.store.rows.batches.size, 1);
  delete f.controls.afterCommit;
  assert.equal(success(await f.inbox.stage(original)).replayed, true);
  assert.equal(f.store.rows.candidates.size, 1);
});

test("the allowed maximum of 100 candidates stages atomically and 101 never produces a trusted handoff", async () => {
  const f = fixture();
  const original = await successfulAnalysis({ count: MAIL_LIMITS.candidates });
  const batch = success(await f.inbox.stage(original));
  assert.equal(batch.candidates.length, 100);
  assert.equal(f.store.rows.candidateSlots.size, 100);
  const tooMany = await analysis({ count: MAIL_LIMITS.candidates + 1 });
  assert.ok(!tooMany.result.ok);
  assert.equal(tooMany.result.code, "CANDIDATE_LIMIT_EXCEEDED");
  failure(await f.inbox.stage(tooMany.result), "REVIEW_INPUT_INVALID");
  assert.equal(f.store.rows.candidates.size, 100);
});

test("memory candidate uniqueness survives payload erasure and expiry cannot be rewritten", async () => {
  const f = fixture();
  const { batch } = await staged(f);
  const row = f.store.rows.candidates.get(batch.candidates[0]!.id)!;
  await f.store.inboxDependencies.transaction(reviewAuthority(), async (tx) => {
    tx.requireCandidateStaging(analysisAuthority(), stagingGrant());
    assert.equal(await tx.updateCandidate({ ...row, revision: 2, expiresAt: row.expiresAt + 1 }, 1), false);
  });
  success(await f.inbox.discard(discardInput(batch)));
  await f.store.inboxDependencies.transaction(reviewAuthority(), async (tx) => {
    tx.requireCandidateStaging(analysisAuthority(), stagingGrant());
    assert.equal(await tx.insertCandidate({ ...row, id: "synthetic-replacement" }), false);
  });
  assert.equal(f.store.rows.candidates.size, 1);
  assert.ok(f.store.rows.batches.has(operationKey(REVIEW_OWNER, analysisAuthority().operationId)));
});

type InboxAction = "stage" | "list" | "discard";
async function actionFixture(action: InboxAction) {
  const f = fixture();
  const original = await successfulAnalysis();
  const batch = action === "stage" ? null : success(await f.inbox.stage(original));
  f.controls.authorityReads = 0;
  const run = (): Promise<ReviewResult<unknown>> => action === "stage" ? f.inbox.stage(original)
    : action === "list" ? f.inbox.listBatch(listInput()) : f.inbox.discard(discardInput(batch!));
  return { f, run };
}

for (const action of ["stage", "list", "discard"] as const) {
  test(`${action} suppresses output at every asynchronous authority recheck`, async (t) => {
    const baseline = await actionFixture(action);
    success(await baseline.run());
    for (let call = 2; call <= baseline.f.controls.authorityReads; call++) {
      for (const patch of [{ sessionRevision: 2 }, { dataGeneration: 2 }]) {
        await t.test(`${Object.keys(patch)[0]} at read ${call}`, async () => {
          const { f, run } = await actionFixture(action);
          f.controls.readAuthority = (index) => index === call ? reviewAuthority(patch) : reviewAuthority();
          const before = f.store.snapshot();
          const commitsBefore = f.controls.commits;
          failure(await run(), "REVIEW_AUTHORITY_CHANGED");
          if (f.controls.commits === commitsBefore) assert.deepEqual(f.store.snapshot(), before);
          else assert.equal(f.controls.commits, commitsBefore + 1, "post-commit refusal must not claim rollback");
        });
      }
    }
  });
  test(`${action} redacts initial authority reader errors`, async () => {
    const { f, run } = await actionFixture(action);
    f.controls.readAuthority = () => { throw new Error(SYNTHETIC_PRIVATE); };
    failure(await run(), "REVIEW_STORE_UNAVAILABLE");
  });
}

for (const kind of ["analysis", "storage"] as const) {
  test(`stage rechecks ${kind} permission at every lookup, including after commit`, async (t) => {
    const baseline = fixture();
    const original = await successfulAnalysis();
    success(await baseline.inbox.stage(original));
    const checks = kind === "analysis" ? baseline.controls.analysisChecks : baseline.controls.stagingGrantReads;
    for (let call = 1; call <= checks; call++) {
      await t.test(`lookup ${call}`, async () => {
        const f = fixture();
        if (kind === "analysis") f.controls.isAnalysisAuthorized = (_expected, index) => index !== call;
        else f.controls.readStagingGrant = (_expected, index) => stagingGrant({ revision: index === call ? 2 : 1 });
        const before = f.store.snapshot();
        failure(await f.inbox.stage(original), "REVIEW_AUTHORITY_CHANGED");
        if (f.controls.commits === 0) assert.deepEqual(f.store.snapshot(), before);
        else assert.equal(f.store.rows.batches.size, 1);
      });
    }
  });
  test(`stage redacts ${kind} authorization adapter errors`, async () => {
    const f = fixture();
    const original = await successfulAnalysis();
    if (kind === "analysis") f.controls.isAnalysisAuthorized = () => { throw new Error(SYNTHETIC_PRIVATE); };
    else f.controls.readStagingGrant = () => { throw new Error(SYNTHETIC_PRIVATE); };
    failure(await f.inbox.stage(original), "REVIEW_AUTHORITY_CHANGED");
    assert.equal(f.store.rows.batches.size, 0);
  });
}

for (const limit of ["analysis", "storage", "pending"] as const) {
  test(`${limit} deadline independently prevents commit while the session remains valid`, async () => {
    const f = fixture();
    const short = REVIEW_NOW + 1000;
    const authority = analysisAuthority(limit === "analysis" ? { grantExpiresAt: short } : {});
    f.controls.analysisAuthority = authority;
    f.controls.stagingGrant = stagingGrant(limit === "storage" ? { expiresAt: short }
      : limit === "pending" ? { pendingAccessUntil: short } : {});
    const original = await successfulAnalysis({ authority });
    f.controls.beforeCommit = () => { f.controls.now = short; };
    const before = f.store.snapshot();
    failure(await f.inbox.stage(original), "REVIEW_STORE_UNAVAILABLE");
    assert.deepEqual(f.store.snapshot(), before);
  });
}

test("list hides candidates that expire after the transaction snapshot but before output", async () => {
  const f = fixture();
  f.controls.stagingGrant = stagingGrant({ pendingAccessUntil: REVIEW_NOW + 1000 });
  await staged(f);
  f.controls.afterCommit = () => { f.controls.now = REVIEW_NOW + 1000; };
  const listed = success(await f.inbox.listBatch(listInput()));
  assert.equal(listed.candidates[0]!.state, "expired");
  assert.equal(listed.candidates[0]!.content, null);
});

test("stage drops newly committed payload if its staging authorization expires before acknowledgement", async () => {
  const f = fixture();
  f.controls.stagingGrant = stagingGrant({ expiresAt: REVIEW_NOW + 1000 });
  const original = await successfulAnalysis();
  f.controls.afterCommit = () => { f.controls.now = REVIEW_NOW + 1000; };
  failure(await f.inbox.stage(original), "REVIEW_AUTHORITY_CHANGED");
  assert.equal(f.store.rows.batches.size, 1, "a committed batch is not rolled back by an output refusal");
});

for (const limit of ["analysis", "storage", "pending"] as const) {
  test(`final authority lookup crossing the ${limit} deadline drops stage output after one committed batch`, async () => {
    const short = REVIEW_NOW + 1000;
    const authority = analysisAuthority(limit === "analysis" ? { grantExpiresAt: short } : {});
    const grant = stagingGrant(limit === "storage" ? { expiresAt: short }
      : limit === "pending" ? { pendingAccessUntil: short } : {});
    const original = await successfulAnalysis({ authority });
    const prepare = () => {
      const f = fixture();
      f.controls.analysisAuthority = authority;
      f.controls.stagingGrant = grant;
      return f;
    };
    const baseline = prepare();
    success(await baseline.inbox.stage(original));
    const finalRead = baseline.controls.authorityReads;
    const f = prepare();
    f.controls.readAuthority = async (call) => {
      if (call === finalRead) {
        assert.equal(f.controls.commits, 1);
        assert.equal(f.controls.analysisChecks, baseline.controls.analysisChecks);
        assert.equal(f.controls.stagingGrantReads, baseline.controls.stagingGrantReads);
        // Change only time while returning the same still-valid app authority.
        f.controls.now = short;
      }
      return reviewAuthority();
    };
    assert.equal(f.controls.afterCommit, undefined);
    failure(await f.inbox.stage(original), "REVIEW_AUTHORITY_CHANGED");
    assert.ok(reviewAuthority().expiresAt > f.controls.now);
    assert.equal(f.controls.authorityReads, finalRead);
    assert.equal(f.controls.commits, 1);
    assert.equal(f.controls.rollbacks, 0);
    assert.equal(f.store.rows.batches.size, 1);
    assert.equal(f.store.rows.candidates.size, 1);
  });
}
