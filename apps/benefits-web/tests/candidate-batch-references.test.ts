import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import { createCandidateBatchReferences } from "../src/server/inbox/batch-references.ts";
import type { CandidateBatchReferenceDependencies, CandidateBatchLocator } from "../src/server/inbox/batch-reference-contracts.ts";
import { createCandidateInbox } from "../src/server/inbox/candidate-inbox.ts";
import { runMailAnalysis, type MailAnalysisAdapters, type MailRunResult } from "../src/server/mail/run-analysis.ts";
import type { ReviewErrorCode, ReviewResult } from "../src/server/review/contracts.ts";
import { ReviewFailure } from "../src/server/review/validation.ts";
import { REVIEW_NOW, REVIEW_OWNER, SYNTHETIC_PRIVATE, analysisAuthority, createReviewMemoryStore,
  operationKey, reviewAuthority, stagingGrant } from "./support/review-memory-store.ts";

// Real verified runner -> staging -> reference orchestration, with serialized
// synthetic memory transactions. These tests do not prove a real auth provider,
// CSPRNG entropy, persistent DB concurrency, HTTP exposure or physical erasure.
type Original = Extract<MailRunResult, { ok: true }>;
type Store = ReturnType<typeof createReviewMemoryStore>;
const OPERATION = analysisAuthority().operationId;
const ALIAS = "synthetic-independent-reference";
const input = () => ({ analysisOperationId: OPERATION });
const retireInput = (batchReference: string) => ({ batchReference, expectedRevision: 1, decision: "retire" });
function success<T>(result: ReviewResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result)); return result.value;
}
function failure(result: ReviewResult<unknown>, code: ReviewErrorCode) {
  assert.equal(result.ok, false); if (result.ok) return;
  assert.equal(result.code, code); assert.deepEqual(Object.keys(result).sort(), ["code", "ok"]);
  assert.equal(JSON.stringify(result).includes(SYNTHETIC_PRIVATE), false); assert.ok(Object.isFrozen(result));
}
function fixedError(code: ReviewErrorCode) {
  return (error: unknown) => error instanceof ReviewFailure && error.code === code && !String(error).includes(SYNTHETIC_PRIVATE);
}
function fixture(override: (store: Store) => Partial<CandidateBatchReferenceDependencies> = () => ({})) {
  const store = createReviewMemoryStore(); store.rows.candidates.clear();
  const deps = { ...store.referenceDependencies, ...override(store) };
  return { store, controls: store.controls, deps, references: createCandidateBatchReferences(deps) };
}
type Fixture = ReturnType<typeof fixture>;
async function original(options: { count?: number; operationId?: string; malformed?: boolean } = {}): Promise<MailRunResult> {
  const authority = analysisAuthority({ operationId: options.operationId ?? OPERATION }), count = options.count ?? 1;
  const discovery = { evidence_message_index: 0, confidence: "high", benefit_kind: "credit",
    service_name: { value: "Synthetic Studio", part: "subject", quote: "Synthetic Studio" },
    benefit_name: { value: "Synthetic credits", part: "body", quote: "grants 100 credits" },
    unit: { value: "credits", part: "body", quote: "100 credits" },
    granted_amount: { value: 100, part: "body", quote: "grants 100 credits" },
    remaining_amount: null, trial_days: null, remaining_days: null, expires_at: null, observed_at: null };
  const adapters: MailAnalysisAdapters = {
    readAuthority: async () => ({ ...authority, grantOwnerId: authority.ownerId, grantSessionId: authority.sessionId,
      grantMailboxBindingId: authority.mailboxBindingId }),
    reserveQuota: async ({ authority: current }) => ({ status: "granted", ownerId: current.ownerId,
      sessionId: current.sessionId, sessionRevision: current.sessionRevision, dataGeneration: current.dataGeneration,
      mailboxBindingId: current.mailboxBindingId, recipientId: current.recipientId, policyVersion: current.policyVersion,
      grantId: current.grantId, grantRevision: current.grantRevision, operationId: current.operationId, remaining: 0 }),
    readMailbox: async () => JSON.stringify(count === 0 ? [] : [{ id: "synthetic-raw-message-not-retained",
      snippet: "Synthetic Studio grants 100 credits.", payload: { mimeType: "text/plain",
        headers: [{ name: "Subject", value: "Synthetic Studio notice" }],
        body: { data: Buffer.from("Synthetic Studio grants 100 credits.").toString("base64url") } } }]),
    analyze: async () => options.malformed ? "synthetic malformed" : JSON.stringify({ schema: "keyatlas.gmail-candidates.v1",
      discoveries: Array.from({ length: count }, () => discovery) }), now: () => REVIEW_NOW,
  };
  return runMailAnalysis(adapters, { operationId: authority.operationId, mailboxBindingId: authority.mailboxBindingId,
    recipientId: authority.recipientId });
}
async function verified(options: Parameters<typeof original>[0] = {}): Promise<Original> {
  const result = await original(options); assert.ok(result.ok); return result;
}
async function staged(f: Fixture, options: Parameters<typeof original>[0] = {}) {
  const run = await verified(options), locator = success(await f.references.stage(run)); return { run, locator };
}
const resolution = (batchReference: string) => ({ batchReference, authority: reviewAuthority() });
const signal = () => new AbortController().signal;
function publicLocator(locator: CandidateBatchLocator) {
  assert.deepEqual(Object.keys(locator).sort(), ["batchReference", "dataGeneration"]);
  assert.ok(Object.isFrozen(locator)); assert.equal(locator.dataGeneration, 1);
  const text = JSON.stringify(locator);
  for (const privateValue of [OPERATION, REVIEW_OWNER, "synthetic-session", "synthetic-mailbox", "synthetic-analyzer",
    "synthetic-analysis-grant", "synthetic-staging-grant", "synthetic-raw-message-not-retained", "Synthetic Studio", "fingerprint"])
    assert.equal(text.includes(privateValue), false);
}

test("constructor is frozen and inert: no authority, transaction, clock or ID port calls", () => {
  let calls = 0; const invoke = () => { calls++; throw new Error(SYNTHETIC_PRIVATE); };
  const references = createCandidateBatchReferences({ readAuthority: invoke, isAnalysisAuthorized: invoke,
    readStagingGrant: invoke, transaction: invoke, newId: invoke, now: invoke, newReference: invoke, readReference: invoke });
  assert.ok(Object.isFrozen(references)); assert.equal(calls, 0);
  assert.deepEqual(Object.keys(references).sort(), ["ensure", "resolve", "retire", "stage"]);
});
test("malformed config/accessors fail fixed and do not execute ordinary getters", () => {
  const store = createReviewMemoryStore(); let called = 0;
  for (const config of [null, {}, { ...store.referenceDependencies, extra: true }, { ...store.referenceDependencies, now: 1 },
    { ...store.referenceDependencies, get newReference() { called++; return () => ALIAS; } }]) {
    assert.throws(() => createCandidateBatchReferences(config as never), { message: "CANDIDATE_BATCH_REFERENCE_CONFIG_INVALID" });
  }
  assert.equal(called, 0);
});
test("real verified staging creates candidates, batch and one independent alias in one commit", async () => {
  const f = fixture(() => ({ newReference: () => ALIAS })); const before = f.controls.commits;
  const { locator } = await staged(f, { count: 2 }); publicLocator(locator); assert.equal(locator.batchReference, ALIAS);
  assert.equal(f.controls.commits, before + 1); assert.equal(f.store.rows.candidates.size, 2); assert.equal(f.store.rows.batches.size, 1);
  assert.equal(f.store.rows.batchReferences.size, 1); assert.equal(f.store.rows.batchReferenceSlots.size, 1);
  assert.equal(f.store.rows.batchReferenceSlots.get(operationKey(REVIEW_OWNER, OPERATION)), ALIAS);
  assert.deepEqual(f.store.rows.batchReferences.get(ALIAS), { batchReference: ALIAS, ownerId: REVIEW_OWNER,
    analysisOperationId: OPERATION, dataGeneration: 1, state: "active", revision: 1 });
  assert.ok(f.controls.trace.includes("requireCandidateStaging")); assert.ok(f.controls.trace.includes("insertBatchReference"));
});
test("registered empty analysis receives a locator without fabricating candidate rows", async () => {
  const f = fixture(); const { locator } = await staged(f, { count: 0 }); publicLocator(locator);
  assert.equal(f.store.rows.candidates.size, 0); assert.equal(f.store.rows.batches.size, 1); assert.equal(f.store.rows.batchReferences.size, 1);
});
for (const kind of ["copy", "structured-clone", "JSON", "fake", "null", "failed"] as const) {
  test(`unverified ${kind} analysis cannot stage or obtain an alias`, async () => {
    const f = fixture(), run = await verified();
    const bad = kind === "copy" ? { ...run } : kind === "structured-clone" ? structuredClone(run)
      : kind === "JSON" ? JSON.parse(JSON.stringify(run)) as unknown : kind === "fake" ? { ok: true, candidates: [] }
        : kind === "null" ? null : await original({ malformed: true });
    const before = f.store.snapshot(); failure(await f.references.stage(bad), "REVIEW_INPUT_INVALID");
    assert.deepEqual(f.store.snapshot(), before);
  });
}
test("same original stage and explicit ensure return the same locator without extra IDs or rows", async () => {
  let references = 0; const f = fixture(() => ({ newReference: () => `${ALIAS}-${++references}` }));
  const { run, locator } = await staged(f), before = f.store.snapshot();
  assert.deepEqual(success(await f.references.stage(run)), locator); assert.deepEqual(success(await f.references.ensure(input())), locator);
  assert.deepEqual(f.store.snapshot(), before); assert.equal(references, 1);
});
test("ensure can attach a locator to an already staged owned batch without mail/analysis grants", async () => {
  const f = fixture(); const inbox = createCandidateInbox(f.store.inboxDependencies);
  success(await inbox.stage(await verified())); f.controls.analysisAuthority = null; f.controls.stagingGrant = null;
  const analysisChecks = f.controls.analysisChecks, stagingReads = f.controls.stagingGrantReads;
  const locator = success(await f.references.ensure(input())); publicLocator(locator);
  assert.equal(f.controls.analysisChecks, analysisChecks); assert.equal(f.controls.stagingGrantReads, stagingReads);
  assert.equal(f.store.rows.candidates.size, 1); assert.equal(f.store.rows.batchReferences.size, 1);
});
test("ensure missing batch cannot mint a reference or create a candidate", async () => {
  let ids = 0; const f = fixture(() => ({ newReference: () => { ids++; return ALIAS; } })), before = f.store.snapshot();
  failure(await f.references.ensure(input()), "REVIEW_NOT_FOUND"); assert.deepEqual(f.store.snapshot(), before); assert.equal(ids, 0);
});
for (const method of ["insertCandidate", "insertCandidateBatch", "insertBatchReference"] as const) {
  test(`${method} CAS failure rolls candidates, batch, slot and alias back together`, async () => {
    const f = fixture(); f.controls.falseMethod = method; const before = f.store.snapshot();
    failure(await f.references.stage(await verified({ count: 2 })), "REVIEW_CONFLICT");
    assert.deepEqual(f.store.snapshot(), before); assert.equal(f.controls.commits, 0); assert.equal(f.controls.rollbacks, 1);
  });
}
for (const kind of ["throw", "malformed", "collision"] as const) {
  test(`reference generation ${kind} cannot leave a partially staged batch`, async () => {
    const f = fixture(() => ({ newReference: () => { if (kind === "throw") throw new Error(SYNTHETIC_PRIVATE);
      return kind === "malformed" ? "invalid reference" : ALIAS; } }));
    if (kind === "collision") f.store.rows.batchReferences.set(ALIAS, { batchReference: ALIAS, ownerId: "synthetic-other",
      dataGeneration: 1, analysisOperationId: "synthetic-other-operation", state: "retired", revision: 2 });
    const before = f.store.snapshot(); failure(await f.references.stage(await verified()), kind === "collision" ? "REVIEW_CONFLICT" : "REVIEW_STORE_UNAVAILABLE");
    assert.deepEqual(f.store.snapshot(), before); assert.equal(f.controls.commits, 0); assert.equal(f.controls.rollbacks, 1);
  });
}
test("commit failure rolls every new staging and mapping row back", async () => {
  const f = fixture(); f.controls.beforeCommit = () => { throw new Error(SYNTHETIC_PRIVATE); }; const before = f.store.snapshot();
  failure(await f.references.stage(await verified()), "REVIEW_STORE_UNAVAILABLE"); assert.deepEqual(f.store.snapshot(), before);
  assert.equal(f.controls.commits, 0); assert.equal(f.controls.rollbacks, 1);
});
test("acknowledgement loss is committed, not rollback; new login and revoked grants ensure the same locator", async () => {
  const f = fixture(() => ({ newReference: () => ALIAS })), run = await verified();
  f.controls.afterCommit = () => { throw new Error(SYNTHETIC_PRIVATE); };
  failure(await f.references.stage(run), "REVIEW_STORE_UNAVAILABLE");
  assert.equal(f.controls.commits, 1); assert.equal(f.controls.rollbacks, 0); assert.equal(f.store.rows.batchReferences.size, 1);
  assert.equal(f.store.rows.candidates.size, 1); assert.equal(f.store.rows.batches.size, 1);
  delete f.controls.afterCommit;
  f.controls.authority = reviewAuthority({ sessionId: "synthetic-new-login", sessionRevision: 2 });
  f.controls.analysisAuthority = null; f.controls.stagingGrant = null;
  const before = f.store.snapshot(), reads = [f.controls.analysisChecks, f.controls.stagingGrantReads];
  assert.deepEqual(success(await f.references.ensure(input())), { batchReference: ALIAS, dataGeneration: 1 });
  assert.deepEqual(f.store.snapshot(), before); assert.deepEqual([f.controls.analysisChecks, f.controls.stagingGrantReads], reads);
  failure(await f.references.stage(run), "REVIEW_AUTHORITY_CHANGED");
});
for (const patch of [{ ownerId: "synthetic-other" }, { dataGeneration: 2 }]) {
  test(`ensure cannot rebind an old batch to another ${Object.keys(patch)[0]}`, async () => {
    const f = fixture(); await staged(f); f.controls.authority = reviewAuthority(patch); const before = f.store.snapshot();
    failure(await f.references.ensure(input()), "REVIEW_NOT_FOUND"); assert.deepEqual(f.store.snapshot(), before);
  });
}
test("serialized overlapping ensure calls issue one alias, with no claim of real DB concurrency", async () => {
  let references = 0; const f = fixture(() => ({ newReference: () => `${ALIAS}-${++references}` }));
  success(await createCandidateInbox(f.store.inboxDependencies).stage(await verified()));
  const outputs = await Promise.all(Array.from({ length: 4 }, () => f.references.ensure(input())));
  const first = success(outputs[0]!); for (const output of outputs) assert.deepEqual(success(output), first);
  assert.equal(references, 1); assert.equal(f.store.rows.batchReferences.size, 1); assert.equal(f.store.rows.batchReferenceSlots.size, 1);
});
test("retirement is terminal exact revision 1 -> 2 and repeated original retirement is idempotent", async () => {
  const f = fixture(), { run, locator } = await staged(f), beforeCandidates = structuredClone(f.store.rows.candidates);
  const first = success(await f.references.retire(retireInput(locator.batchReference)));
  assert.deepEqual(first, { ...locator, state: "retired", revision: 2 }); assert.ok(Object.isFrozen(first));
  const retired = f.store.snapshot(); assert.deepEqual(success(await f.references.retire(retireInput(locator.batchReference))), first);
  assert.deepEqual(f.store.snapshot(), retired); assert.deepEqual(f.store.rows.candidates, beforeCandidates);
  assert.equal(f.store.rows.batchReferenceSlots.get(operationKey(REVIEW_OWNER, OPERATION)), locator.batchReference);
  failure(await f.references.ensure(input()), "REVIEW_CONFLICT"); failure(await f.references.stage(run), "REVIEW_CONFLICT");
  assert.equal(await f.references.resolve(resolution(locator.batchReference), signal()), null);
  failure(await f.references.retire({ ...retireInput(locator.batchReference), expectedRevision: 2 }), "REVIEW_CONFLICT");
  assert.deepEqual(f.store.snapshot(), retired);
});
test("retirement CAS failure and transaction failure preserve the active alias", async () => {
  for (const mode of ["CAS", "commit"] as const) {
    const f = fixture(), { locator } = await staged(f), before = f.store.snapshot();
    if (mode === "CAS") f.controls.falseMethod = "retireBatchReference";
    else f.controls.beforeCommit = () => { throw new Error(SYNTHETIC_PRIVATE); };
    failure(await f.references.retire(retireInput(locator.batchReference)), mode === "CAS" ? "REVIEW_CONFLICT" : "REVIEW_STORE_UNAVAILABLE");
    assert.deepEqual(f.store.snapshot(), before);
  }
});
test("retired global reference cannot be reused for a different verified operation", async () => {
  const f = fixture(() => ({ newReference: () => ALIAS })); await staged(f);
  success(await f.references.retire(retireInput(ALIAS)));
  const nextOperation = "synthetic-second-operation";
  f.controls.analysisAuthority = analysisAuthority({ operationId: nextOperation });
  f.controls.stagingGrant = stagingGrant({ analysisOperationId: nextOperation });
  const before = f.store.snapshot(); failure(await f.references.stage(await verified({ operationId: nextOperation })), "REVIEW_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
});
for (const mutation of ["missing-slot", "missing-row", "wrong-slot", "row-operation", "row-reference", "row-state-revision"] as const) {
  test(`ensure fails closed on inconsistent stored lookup: ${mutation}`, async () => {
    const f = fixture(), { locator } = await staged(f), row = f.store.rows.batchReferences.get(locator.batchReference)!;
    if (mutation === "missing-slot") f.store.rows.batchReferenceSlots.delete(operationKey(REVIEW_OWNER, OPERATION));
    else if (mutation === "missing-row") f.store.rows.batchReferences.delete(locator.batchReference);
    else if (mutation === "wrong-slot") f.store.rows.batchReferenceSlots.set(operationKey(REVIEW_OWNER, OPERATION), "synthetic-absent-reference");
    else if (mutation === "row-operation") f.store.rows.batchReferences.set(locator.batchReference, { ...row, analysisOperationId: "synthetic-wrong-operation" });
    else if (mutation === "row-reference") f.store.rows.batchReferences.set(locator.batchReference, { ...row, batchReference: "synthetic-wrong-reference" });
    else f.store.rows.batchReferences.set(locator.batchReference, { ...row, state: "active", revision: 2 });
    const before = f.store.snapshot();
    // With no operation slot, the read port cannot observe the orphan row.
    // The retained unique constraint still refuses a second alias. In contrast,
    // a present slot pointing to a missing/wrong row is observable corruption.
    failure(await f.references.ensure(input()), mutation === "missing-slot" ? "REVIEW_CONFLICT" : "REVIEW_STORE_UNAVAILABLE");
    assert.deepEqual(f.store.snapshot(), before);
    if (mutation === "missing-slot") {
      assert.equal(f.store.rows.batchReferences.size, 1);
      assert.deepEqual(f.store.rows.batchReferences.get(locator.batchReference), row);
      assert.equal(f.store.rows.batchReferenceSlots.size, 0);
    }
  });
}
test("resolve returns only exact four internal mapping fields and does not create/write/renew rows", async () => {
  const f = fixture(), { locator } = await staged(f), before = f.store.snapshot(), commits = f.controls.commits, transactions = f.controls.transactions;
  const mapped = await f.references.resolve(resolution(locator.batchReference), signal());
  assert.deepEqual(mapped, { ...locator, ownerId: REVIEW_OWNER, analysisOperationId: OPERATION }); assert.ok(Object.isFrozen(mapped));
  assert.deepEqual(f.store.snapshot(), before); assert.equal(f.controls.commits, commits); assert.equal(f.controls.transactions, transactions);
});
test("unknown, foreign-owner, foreign-generation and retired references all resolve to null", async () => {
  const f = fixture(), { locator } = await staged(f);
  assert.equal(await f.references.resolve(resolution("synthetic-unknown"), signal()), null);
  for (const patch of [{ ownerId: "synthetic-other" }, { dataGeneration: 2 }]) {
    f.controls.authority = reviewAuthority(patch);
    assert.equal(await f.references.resolve({ batchReference: locator.batchReference, authority: reviewAuthority(patch) }, signal()), null);
  }
  f.controls.authority = reviewAuthority(); success(await f.references.retire(retireInput(locator.batchReference)));
  assert.equal(await f.references.resolve(resolution(locator.batchReference), signal()), null);
});
test("malformed resolver row and adapter exception expose only fixed errors", async () => {
  for (const malformed of [true, false]) {
    const f = fixture(() => ({ readReference: async () => { if (!malformed) throw new Error(SYNTHETIC_PRIVATE);
      return { batchReference: ALIAS, ownerId: REVIEW_OWNER, dataGeneration: 1, analysisOperationId: OPERATION,
        state: "active", revision: 2, privateDetail: SYNTHETIC_PRIVATE }; } }));
    await assert.rejects(f.references.resolve(resolution(ALIAS), signal()), fixedError("REVIEW_STORE_UNAVAILABLE"));
  }
});
test("pre-aborted resolution never reads the mapping and exposes no stale payload", async () => {
  let reads = 0; const f = fixture(() => ({ readReference: async () => { reads++; return null; } })), abort = new AbortController(); abort.abort();
  await assert.rejects(f.references.resolve(resolution(ALIAS), abort.signal), fixedError("REVIEW_AUTHORITY_CHANGED")); assert.equal(reads, 0);
});
test("cancellation during direct row read rejects the later mapping", async () => {
  const abort = new AbortController(); const f = fixture((store) => ({ readReference: async (reference, receivedSignal) => {
    assert.equal(receivedSignal, abort.signal); const row = await store.referenceDependencies.readReference(reference, receivedSignal);
    abort.abort(); return row;
  } }));
  const { locator } = await staged(f);
  await assert.rejects(f.references.resolve(resolution(locator.batchReference), abort.signal), fixedError("REVIEW_AUTHORITY_CHANGED"));
});
test("current authority change during direct mapping read suppresses the old mapping", async () => {
  const f = fixture((store) => ({ readReference: async (reference, receivedSignal) => {
    const row = await store.referenceDependencies.readReference(reference, receivedSignal);
    store.controls.authority = reviewAuthority({ sessionRevision: 2 }); return row;
  } }));
  const { locator } = await staged(f);
  await assert.rejects(f.references.resolve(resolution(locator.batchReference), signal()), fixedError("REVIEW_AUTHORITY_CHANGED"));
});
test("captured authority mismatch is denied before reference read, including newer same-owner login", async () => {
  let reads = 0; const f = fixture(() => ({ readReference: async () => { reads++; return null; } }));
  f.controls.authority = reviewAuthority({ sessionId: "synthetic-new-login", sessionRevision: 2 });
  await assert.rejects(f.references.resolve(resolution(ALIAS), signal()), fixedError("REVIEW_AUTHORITY_CHANGED")); assert.equal(reads, 0);
});
test("resolve clock rollback and exact authority expiry fail closed", async () => {
  for (const time of [REVIEW_NOW - 1, reviewAuthority().expiresAt]) {
    const f = fixture((store) => ({ readReference: async (reference, receivedSignal) => {
      const row = await store.referenceDependencies.readReference(reference, receivedSignal); store.controls.now = time; return row;
    } }));
    const { locator } = await staged(f);
    await assert.rejects(f.references.resolve(resolution(locator.batchReference), signal()), fixedError("REVIEW_AUTHORITY_CHANGED"));
  }
});
test("after-commit authority change suppresses locator without pretending rows rolled back", async () => {
  const f = fixture(); f.controls.afterCommit = () => { f.controls.authority = reviewAuthority({ sessionRevision: 2 }); };
  failure(await f.references.stage(await verified()), "REVIEW_AUTHORITY_CHANGED");
  assert.equal(f.controls.commits, 1); assert.equal(f.controls.rollbacks, 0);
  assert.equal(f.store.rows.candidates.size, 1); assert.equal(f.store.rows.batches.size, 1); assert.equal(f.store.rows.batchReferences.size, 1);
  delete f.controls.afterCommit; success(await f.references.ensure(input()));
});
test("ordinary input getters are not called and invalid inputs never read authority", async () => {
  const f = fixture(); let reads = 0;
  for (const value of [null, {}, { ...input(), extra: true }, { get analysisOperationId() { reads++; return OPERATION; } }]) {
    failure(await f.references.ensure(value), "REVIEW_INPUT_INVALID");
  }
  for (const value of [null, { ...retireInput(ALIAS), decision: "delete" },
    { ...retireInput(ALIAS), get batchReference() { reads++; return ALIAS; } }]) failure(await f.references.retire(value), "REVIEW_INPUT_INVALID");
  assert.equal(reads, 0); assert.equal(f.controls.authorityReads, 0); assert.equal(f.controls.transactions, 0);
});
test("resolver input getters and malformed exact envelope are rejected before authority/read ports", async () => {
  const f = fixture(); let reads = 0;
  for (const value of [null, { ...resolution(ALIAS), extra: true }, { get batchReference() { reads++; return ALIAS; }, authority: reviewAuthority() },
    { batchReference: ALIAS, authority: { ...reviewAuthority(), get ownerId() { reads++; return REVIEW_OWNER; } } }]) {
    await assert.rejects(f.references.resolve(value as never, signal()), fixedError("REVIEW_INPUT_INVALID"));
  }
  assert.equal(reads, 0); assert.equal(f.controls.authorityReads, 0);
});

for (const [label, value] of Object.entries({ owner: REVIEW_OWNER, session: reviewAuthority().sessionId,
  operation: OPERATION, mailbox: analysisAuthority().mailboxBindingId, recipient: analysisAuthority().recipientId,
  analysisGrant: analysisAuthority().grantId, stagingGrant: stagingGrant().id, candidate: "synthetic-fixed-candidate" })) {
  test(`reference equal to known private ${label} ID is not published or partially committed`, async () => {
    const f = fixture(() => ({ newReference: () => value, newId: () => "synthetic-fixed-candidate" }));
    const before = f.store.snapshot(); failure(await f.references.stage(await verified()), "REVIEW_STORE_UNAVAILABLE");
    assert.deepEqual(f.store.snapshot(), before); assert.equal(f.controls.commits, 0); assert.equal(f.controls.rollbacks, 1);
  });
}
test("ensure refuses the stored private batch fingerprint as a public reference", async () => {
  let proposed = ALIAS; const f = fixture(() => ({ newReference: () => proposed }));
  success(await createCandidateInbox(f.store.inboxDependencies).stage(await verified()));
  proposed = f.store.rows.batches.get(operationKey(REVIEW_OWNER, OPERATION))!.fingerprint;
  const before = f.store.snapshot(); failure(await f.references.ensure(input()), "REVIEW_STORE_UNAVAILABLE");
  assert.deepEqual(f.store.snapshot(), before); assert.equal(f.store.rows.batchReferences.size, 0);
});
test("cancel settles without waiting for a noncooperative direct reader and observes its late rejection", { timeout: 1_000 }, async () => {
  let entered!: () => void, rejectRead!: (error: Error) => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const pendingRead = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
  const f = fixture(() => ({ readReference: () => { entered(); return pendingRead; } }));
  const abort = new AbortController(), result = f.references.resolve(resolution(ALIAS), abort.signal);
  await reading; abort.abort(); await assert.rejects(result, fixedError("REVIEW_AUTHORITY_CHANGED"));
  rejectRead(new Error(SYNTHETIC_PRIVATE)); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.controls.commits, 0);
});
test("A to B to fresh A authority with a newer revision cannot revive a captured mapping read", async () => {
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture((store) => ({ readReference: async (reference, receivedSignal) => {
    const row = await store.referenceDependencies.readReference(reference, receivedSignal); entered(); await held; return row;
  } }));
  const { locator } = await staged(f), result = f.references.resolve(resolution(locator.batchReference), signal());
  await reading; f.controls.authority = reviewAuthority({ sessionId: "synthetic-login-B", sessionRevision: 2 });
  f.controls.authority = reviewAuthority({ sessionRevision: 3 }); release();
  await assert.rejects(result, fixedError("REVIEW_AUTHORITY_CHANGED"));
  // Reverting every trusted authority field between observations is not an
  // observable event; actual authority adapters must maintain revision epochs.
});
test("authority change during row reflection is caught after decode before delivery", async () => {
  let reflected = 0; const f = fixture((store) => ({ readReference: async (reference, receivedSignal) => {
    const row = await store.referenceDependencies.readReference(reference, receivedSignal);
    assert.ok(row !== null && typeof row === "object");
    return new Proxy(row, { ownKeys(target) { reflected++; store.controls.authority = reviewAuthority({ sessionRevision: 2 });
      return Reflect.ownKeys(target); } });
  } }));
  const { locator } = await staged(f);
  await assert.rejects(f.references.resolve(resolution(locator.batchReference), signal()), fixedError("REVIEW_AUTHORITY_CHANGED"));
  assert.ok(reflected > 0);
});
test("simultaneous cancellation takes precedence over a private direct-read exception", async () => {
  const abort = new AbortController(); const f = fixture(() => ({ readReference: async () => {
    abort.abort(); throw new Error(SYNTHETIC_PRIVATE);
  } }));
  await assert.rejects(f.references.resolve(resolution(ALIAS), abort.signal), fixedError("REVIEW_AUTHORITY_CHANGED"));
});
for (const action of ["ensure", "retire"] as const) {
  test(`${action} acknowledgement at exact auth expiry suppresses receipt but does not undo commit`, async () => {
    const f = fixture(); let reference = ALIAS;
    if (action === "ensure") success(await createCandidateInbox(f.store.inboxDependencies).stage(await verified()));
    else reference = (await staged(f)).locator.batchReference;
    const commits = f.controls.commits, rollbacks = f.controls.rollbacks;
    f.controls.afterCommit = () => { f.controls.now = reviewAuthority().expiresAt; };
    failure(await (action === "ensure" ? f.references.ensure(input()) : f.references.retire(retireInput(reference))), "REVIEW_AUTHORITY_CHANGED");
    assert.equal(f.controls.commits, commits + 1); assert.equal(f.controls.rollbacks, rollbacks);
    assert.equal(f.store.rows.batchReferences.size, 1);
    assert.equal([...f.store.rows.batchReferences.values()][0]!.state, action === "ensure" ? "active" : "retired");
  });
}
test("stage acknowledgement at exact pending deadline does not disclose a locator after commit", async () => {
  const f = fixture(), pendingAccessUntil = REVIEW_NOW + 1000;
  const grant = stagingGrant({ pendingAccessUntil }); f.controls.stagingGrant = grant;
  for (const deadline of [reviewAuthority().expiresAt, analysisAuthority().sessionExpiresAt,
    analysisAuthority().grantExpiresAt, grant.expiresAt]) assert.ok(deadline > pendingAccessUntil);
  f.controls.afterCommit = () => { f.controls.now = pendingAccessUntil; };
  failure(await f.references.stage(await verified()), "REVIEW_AUTHORITY_CHANGED");
  assert.equal(f.controls.commits, 1); assert.equal(f.controls.rollbacks, 0);
  assert.equal(f.store.rows.candidates.size, 1); assert.equal(f.store.rows.batchReferences.size, 1);
  assert.equal([...f.store.rows.candidates.values()][0]!.expiresAt, pendingAccessUntil);
  assert.equal(f.store.rows.batches.get(operationKey(REVIEW_OWNER, OPERATION))!.pendingAccessUntil, pendingAccessUntil);
  assert.equal(f.controls.now, pendingAccessUntil);
});
test("overlapping stages keep invocation-local locators while the first committed acknowledgement is held", { timeout: 2_000 }, async () => {
  // Request-local synthetic adapter partitions let B finish while A's committed
  // acknowledgement is delayed. This tests one service instance's local state,
  // not two simultaneous writers against a durable/shared database.
  const context = new AsyncLocalStorage<Store>(), first = createReviewMemoryStore(), second = createReviewMemoryStore();
  first.rows.candidates.clear(); second.rows.candidates.clear();
  const secondOperation = "synthetic-independent-operation-B";
  second.controls.analysisAuthority = analysisAuthority({ operationId: secondOperation });
  second.controls.stagingGrant = stagingGrant({ analysisOperationId: secondOperation });
  const current = () => { const store = context.getStore(); assert.ok(store); return store; };
  const deps: CandidateBatchReferenceDependencies = {
    readAuthority: () => current().referenceDependencies.readAuthority(),
    isAnalysisAuthorized: (expected) => current().referenceDependencies.isAnalysisAuthorized(expected),
    readStagingGrant: (expected) => current().referenceDependencies.readStagingGrant(expected),
    transaction: (authority, action) => current().referenceDependencies.transaction(authority, action),
    newId: () => current().referenceDependencies.newId(), now: () => current().referenceDependencies.now(),
    newReference: () => current() === first ? "synthetic-alias-A" : "synthetic-alias-B",
    readReference: (reference, abortSignal) => current().referenceDependencies.readReference(reference, abortSignal),
  };
  const references = createCandidateBatchReferences(deps);
  let committed!: () => void, release!: () => void;
  const firstCommitted = new Promise<void>((resolve) => { committed = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  first.controls.afterCommit = async () => { committed(); await hold; };
  const runA = await verified(), runB = await verified({ operationId: secondOperation });
  const firstResult = context.run(first, () => references.stage(runA));
  await firstCommitted;
  try {
    const resultB = success(await context.run(second, () => references.stage(runB)));
    assert.deepEqual(resultB, { batchReference: "synthetic-alias-B", dataGeneration: 1 });
    assert.equal(first.controls.commits, 1); assert.equal(second.controls.commits, 1);
  } finally { release(); }
  assert.deepEqual(success(await firstResult), { batchReference: "synthetic-alias-A", dataGeneration: 1 });
  assert.equal(first.rows.batchReferences.get("synthetic-alias-A")!.analysisOperationId, OPERATION);
  assert.equal(second.rows.batchReferences.get("synthetic-alias-B")!.analysisOperationId, secondOperation);
});
