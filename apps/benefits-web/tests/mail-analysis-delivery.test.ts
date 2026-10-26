import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverMailAnalysis, type MailAnalysisDeliveryDependencies, type MailAnalysisDeliveryError,
  type MailAnalysisDeliveryResult } from "../src/server/mail/deliver-analysis.ts";
import type { MailAnalysisAdapters, MailRunOptions } from "../src/server/mail/run-analysis.ts";
import { createCandidateBatchReferences } from "../src/server/inbox/batch-references.ts";
import { ReviewFailure } from "../src/server/review/validation.ts";
import { createCandidateSelectionFixture } from "./support/candidate-selection-fixture.ts";
import { REVIEW_NOW, SYNTHETIC_PRIVATE, analysisAuthority, createReviewMemoryStore, reviewAuthority,
  stagingGrant } from "./support/review-memory-store.ts";

// Real runner -> original WeakMap handoff -> same-transaction references stage.
// All ports are synthetic memory. No real consent, provider/DB durability,
// multi-process concurrency, HTTP route, cancellation rollback or undo proof.
const ALIAS = "synthetic-delivery-public-reference";
const source = analysisAuthority();
const options = (): MailRunOptions => ({ operationId: source.operationId,
  mailboxBindingId: source.mailboxBindingId, recipientId: source.recipientId });
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const store = createReviewMemoryStore(); store.rows.candidates.clear();
  const calls = { authority: 0, quota: 0, mailbox: 0, analyze: 0 };
  const used = new Set<string>();
  const analysis: MailAnalysisAdapters = {
    readAuthority: async () => {
      calls.authority++;
      const current = store.controls.analysisAuthority as typeof source | null;
      return current === null ? null : { ...current, grantOwnerId: current.ownerId,
        grantSessionId: current.sessionId, grantMailboxBindingId: current.mailboxBindingId };
    },
    reserveQuota: async ({ authority }) => {
      calls.quota++;
      const key = JSON.stringify([authority.ownerId, authority.operationId]);
      if (used.has(key)) return { status: "denied" }; used.add(key);
      return { status: "granted", ownerId: authority.ownerId, sessionId: authority.sessionId,
        sessionRevision: authority.sessionRevision, dataGeneration: authority.dataGeneration,
        mailboxBindingId: authority.mailboxBindingId, recipientId: authority.recipientId, policyVersion: authority.policyVersion,
        grantId: authority.grantId, grantRevision: authority.grantRevision, operationId: authority.operationId, remaining: 0 };
    },
    readMailbox: async () => {
      calls.mailbox++;
      return JSON.stringify([{ id: "synthetic-delivery-mail-not-retained", payload: { mimeType: "text/plain",
        headers: [{ name: "Subject", value: "Synthetic Studio notice" }],
        body: { data: Buffer.from("Synthetic Studio grants 100 credits.").toString("base64url") } } }]);
    },
    analyze: async () => {
      calls.analyze++;
      return JSON.stringify({ schema: "keyatlas.gmail-candidates.v1", discoveries: [{ evidence_message_index: 0,
        confidence: "high", benefit_kind: "credit",
        service_name: { value: "Synthetic Studio", part: "subject", quote: "Synthetic Studio" },
        benefit_name: null, unit: { value: "credits", part: "body", quote: "100 credits" },
        granted_amount: { value: 100, part: "body", quote: "grants 100 credits" }, remaining_amount: null,
        trial_days: null, remaining_days: null, expires_at: null, observed_at: null }] });
    },
    now: () => store.controls.now,
  };
  const deps: MailAnalysisDeliveryDependencies = { analysis,
    references: { ...store.referenceDependencies, newReference: () => ALIAS } };
  return { store, calls, analysis, deps, run: (patch: Partial<MailRunOptions> = {}) => deliverMailAnalysis(deps, { ...options(), ...patch }) };
}
function noPrivate(result: MailAnalysisDeliveryResult) {
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.receipt));
  assert.deepEqual(Object.keys(result.receipt).sort(), ["analysis", "mailbox", "quota", "storage", "undoAvailable"]);
  assert.equal(result.receipt.undoAvailable, false);
  const serialized = JSON.stringify(result);
  for (const privateValue of [SYNTHETIC_PRIVATE, source.ownerId, source.sessionId, source.operationId, source.mailboxBindingId,
    source.grantId, source.recipientId, "synthetic-staging-grant", "synthetic-delivery-mail-not-retained", "Synthetic Studio",
    "grants 100 credits", "authorityAtStart", "candidateIds", "fingerprint", "extractedAt"])
    assert.equal(serialized.includes(privateValue), false, `private marker: ${privateValue}`);
}
function failure(result: MailAnalysisDeliveryResult, expected: MailAnalysisDeliveryError) {
  assert.equal(result.ok, false); if (result.ok) throw new Error("unexpected success");
  assert.equal(result.code, expected); assert.deepEqual(Object.keys(result).sort(), ["code", "ok", "receipt"]); noPrivate(result);
}

test("actual analysis -> stage returns only frozen saved locator and safe observations", async () => {
  const f = fixture(), result = await f.run(); assert.ok(result.ok); noPrivate(result);
  assert.deepEqual(Object.keys(result).sort(), ["ok", "receipt", "value"]);
  assert.deepEqual(result.value, { schema: "keyatlas.candidate-batch-saved.v1", state: "saved", batchReference: ALIAS, dataGeneration: 1 });
  assert.ok(Object.isFrozen(result.value));
  assert.deepEqual(result.receipt, { quota: "consumed", mailbox: "returned", analysis: "returned", storage: "acknowledged", undoAvailable: false });
  assert.equal(f.calls.quota, 1); assert.equal(f.calls.mailbox, 1); assert.equal(f.calls.analyze, 1);
  assert.equal(f.store.controls.commits, 1); assert.equal(f.store.rows.candidates.size, 1);
  assert.equal(f.store.rows.batches.size, 1); assert.equal(f.store.rows.batchReferences.size, 1);
});
test("method-style ID ports preserve their snapshotted configuration receiver", async () => {
  const f = fixture(); let sequence = 0;
  const references = { ...f.deps.references,
    newId() { return this.now() === REVIEW_NOW ? `synthetic-method-reference-${++sequence}` : "synthetic-wrong-clock"; },
    newReference() { return this.newId(); },
  };
  const result = await deliverMailAnalysis({ ...f.deps, references }, options());
  assert.ok(result.ok); noPrivate(result); assert.equal(result.value.batchReference, "synthetic-method-reference-2");
  assert.equal([...f.store.rows.candidates.keys()][0], "synthetic-method-reference-1");
  assert.equal(sequence, 2); assert.equal(f.store.controls.commits, 1);
});
test("existing candidate fixture now returns actual coordinator receipt and compatible locator", async () => {
  const f = await createCandidateSelectionFixture(REVIEW_NOW, 86400000, () => ALIAS);
  assert.deepEqual(f.completionReceipt, { schema: "keyatlas.candidate-batch-saved.v1", state: "saved", ...f.locator });
  assert.equal(f.batch.candidates.length, 2); assert.equal(f.services.length, 2);
  assert.deepEqual(f.readAnalysisCounts(), { quota: 1, mailbox: 1, analysis: 1 });
  assert.deepEqual(await f.refresh(), f.batch);
  assert.deepEqual(f.readAnalysisCounts(), { quota: 1, mailbox: 1, analysis: 1 });
  assert.ok(Object.isFrozen(f.readAnalysisCounts()));
});
test("empty mailbox stores an empty completed batch without calling analysis or inventing rows", async () => {
  const f = fixture(); f.analysis.readMailbox = async () => { f.calls.mailbox++; return "[]"; };
  const result = await f.run(); assert.ok(result.ok); noPrivate(result);
  assert.equal(result.receipt.analysis, "not-started"); assert.equal(f.calls.analyze, 0);
  assert.equal(f.store.rows.candidates.size, 0); assert.equal(f.store.rows.batches.size, 1);
});
test("explicit second execution does not automatically reuse or rerun a consumed operation", async () => {
  const f = fixture(); assert.ok((await f.run()).ok); const before = f.store.snapshot();
  const result = await f.run(); failure(result, "QUOTA_DENIED");
  assert.deepEqual(result.receipt, { quota: "not-consumed", mailbox: "not-started", analysis: "not-started", storage: "not-started", undoAvailable: false });
  assert.equal(f.calls.quota, 2); assert.equal(f.calls.mailbox, 1); assert.equal(f.calls.analyze, 1);
  assert.deepEqual(f.store.snapshot(), before);
});
for (const [label, patch] of [
  ["bad operation", { operationId: "invalid space" }], ["extra input", { extra: "private" }],
  ["zero timeout", { timeoutMs: 0 }], ["too long timeout", { timeoutMs: 120001 }],
  ["null timeout", { timeoutMs: null }], ["undefined supplied signal", { signal: undefined }],
  ["signal imitation", { signal: { aborted: false, addEventListener() {} } }],
] as const) {
  test(`configuration rejects ${label} without calling ports`, async () => {
    const f = fixture(); failure(await deliverMailAnalysis(f.deps, { ...options(), ...patch } as never), "RUN_CONFIG_INVALID");
    assert.deepEqual(f.calls, { authority: 0, quota: 0, mailbox: 0, analyze: 0 }); assert.equal(f.store.controls.transactions, 0);
  });
}
test("ordinary getters in options/dependencies are never executed", async () => {
  const f = fixture(); let getters = 0;
  failure(await deliverMailAnalysis(f.deps, { ...options(), get operationId() { getters++; return source.operationId; } }), "RUN_CONFIG_INVALID");
  failure(await deliverMailAnalysis({ ...f.deps, get analysis() { getters++; return f.analysis; } }, options()), "RUN_CONFIG_INVALID");
  failure(await deliverMailAnalysis({ ...f.deps, analysis: { ...f.analysis, get readMailbox() { getters++; return f.analysis.readMailbox; } } }, options()), "RUN_CONFIG_INVALID");
  failure(await deliverMailAnalysis({ ...f.deps, references: { ...f.deps.references, get now() { getters++; return () => REVIEW_NOW; } } }, options()), "RUN_CONFIG_INVALID");
  assert.equal(getters, 0); assert.equal(f.calls.authority, 0);
});
test("accessor authority fields from a trusted port fail closed without invoking the getter", async () => {
  const f = fixture(); let getters = 0;
  const read = f.analysis.readAuthority;
  f.analysis.readAuthority = async (signal) => ({ ...await read(signal) as object,
    get ownerId() { getters++; return source.ownerId; } });
  failure(await f.run(), "AUTHORITY_UNAVAILABLE"); assert.equal(getters, 0); assert.equal(f.calls.quota, 0);
});
test("pre-aborted signal calls no authority/provider/transaction ports", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(SYNTHETIC_PRIVATE);
  const result = await f.run({ signal: controller.signal }); failure(result, "RUN_CANCELLED");
  assert.deepEqual(f.calls, { authority: 0, quota: 0, mailbox: 0, analyze: 0 }); assert.equal(f.store.controls.transactions, 0);
});
for (const field of ["aborted", "addEventListener", "removeEventListener"] as const) {
  test(`native signal with shadowed ${field} is rejected before dispatch without reading or calling it`, async () => {
    const f = fixture(), controller = new AbortController(); let calls = 0;
    Object.defineProperty(controller.signal, field, { configurable: true,
      get() { calls++; throw new Error(SYNTHETIC_PRIVATE); } });
    failure(await f.run({ signal: controller.signal }), "RUN_CONFIG_INVALID");
    assert.equal(calls, 0); assert.equal(f.calls.authority, 0); assert.equal(f.store.controls.commits, 0);
  });
}
test("native signal shadow cleanup cannot mutate authority after the final guard", async () => {
  const f = fixture(), controller = new AbortController(); let calls = 0;
  Object.defineProperty(controller.signal, "removeEventListener", { value: (...args: Parameters<AbortSignal["removeEventListener"]>) => {
    calls++; f.store.controls.authority = reviewAuthority({ sessionRevision: 2 });
    EventTarget.prototype.removeEventListener.call(controller.signal, ...args);
  } });
  failure(await f.run({ signal: controller.signal }), "RUN_CONFIG_INVALID");
  assert.equal(calls, 0); assert.equal(f.calls.authority, 0); assert.equal(f.store.controls.commits, 0);
});
test("runtime-invalid ReviewFailure code is never echoed from a faulty adapter", async () => {
  const f = fixture(); f.store.controls.readAuthority = () => { throw new ReviewFailure(SYNTHETIC_PRIVATE as never); };
  failure(await f.run(), "AUTHORITY_UNAVAILABLE"); assert.equal(f.store.controls.commits, 0);
});
test("caller signal changed during async work cannot inject cleanup after the final authority guard", async () => {
  const f = fixture(), controller = new AbortController(); let calls = 0;
  f.store.controls.afterCommit = () => {
    Object.defineProperty(controller.signal, "removeEventListener", { value: () => {
      calls++; f.store.controls.authority = reviewAuthority({ sessionRevision: 2 }); throw new Error(SYNTHETIC_PRIVATE);
    } });
  };
  const result = await f.run({ signal: controller.signal }); assert.ok(result.ok); noPrivate(result);
  assert.equal(calls, 0); assert.deepEqual(f.store.controls.authority, reviewAuthority());
});
test("faulty final adapter error code accessor is not called or echoed", async () => {
  const baseline = fixture(); assert.ok((await baseline.run()).ok); const finalRead = baseline.store.controls.authorityReads;
  const f = fixture(); let getters = 0;
  f.store.controls.readAuthority = (call) => {
    if (call !== finalRead) return f.store.controls.authority;
    const error = new ReviewFailure("REVIEW_STORE_UNAVAILABLE");
    Object.defineProperty(error, "code", { get() { getters++; throw new Error(SYNTHETIC_PRIVATE); } });
    throw error;
  };
  const result = await f.run(); failure(result, "AUTHORITY_UNAVAILABLE");
  assert.equal(getters, 0); assert.equal(result.receipt.storage, "acknowledged");
});
for (const [label, port, code, quota, mailbox, analysis] of [
  ["quota failure", "reserveQuota", "QUOTA_UNAVAILABLE", "unknown", "not-started", "not-started"],
  ["mailbox failure", "readMailbox", "MAIL_UNAVAILABLE", "consumed", "started", "not-started"],
  ["analysis failure", "analyze", "ANALYSIS_UNAVAILABLE", "consumed", "returned", "started"],
] as const) {
  test(`${label} exposes fixed code/accurate observations and never stages`, async () => {
    const f = fixture(); f.analysis[port] = async () => { f.calls[port === "reserveQuota" ? "quota" : port === "readMailbox" ? "mailbox" : "analyze"]++; throw new Error(SYNTHETIC_PRIVATE); };
    const result = await f.run(); failure(result, code);
    assert.deepEqual(result.receipt, { quota, mailbox, analysis, storage: "not-started", undoAvailable: false });
    assert.equal(f.store.controls.transactions, 0); assert.equal(f.store.rows.batchReferences.size, 0);
  });
}
test("malformed analysis cannot be reconstructed as a successful staging handoff", async () => {
  const f = fixture(); f.analysis.analyze = async () => "invalid synthetic candidate JSON";
  const result = await f.run(); failure(result, "CANDIDATE_INPUT_INVALID");
  assert.equal(result.receipt.analysis, "returned"); assert.equal(result.receipt.storage, "not-started");
  assert.equal(f.store.controls.transactions, 0);
});
test("cancellation during an ignored mailbox promise stops before analysis and storage", async () => {
  const f = fixture(), entered = deferred(), release = deferred<string>(), controller = new AbortController();
  f.analysis.readMailbox = async () => { f.calls.mailbox++; entered.resolve(); return release.promise; };
  const pending = f.run({ signal: controller.signal });
  try {
    await entered.promise; controller.abort(SYNTHETIC_PRIVATE);
    const result = await pending; failure(result, "RUN_CANCELLED");
    assert.equal(result.receipt.mailbox, "started"); assert.equal(result.receipt.storage, "not-started");
    assert.equal(f.calls.analyze, 0); assert.equal(f.store.controls.transactions, 0);
  } finally { release.resolve("[]"); await pending; }
});
test("scheduled deadline terminates an ignored analysis promise without a fresh staging budget", async (t) => {
  let monotonic = 0;
  t.mock.method(performance, "now", () => monotonic);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), entered = deferred(), release = deferred<string>();
  f.analysis.analyze = async () => { entered.resolve(); return release.promise; };
  const pending = f.run({ timeoutMs: 150 });
  try {
    await entered.promise; monotonic = 150; f.store.controls.now += 150; t.mock.timers.tick(150);
    const result = await pending; failure(result, "RUN_TIMED_OUT");
    assert.equal(result.receipt.analysis, "started"); assert.equal(result.receipt.storage, "not-started");
    assert.equal(f.store.controls.transactions, 0);
  } finally { release.resolve("{}"); await pending; }
});
test("storage uses the original wall deadline, not a new timeout after analysis", async () => {
  const f = fixture(), read = f.analysis.readMailbox;
  f.analysis.readMailbox = async (context, signal) => { const value = await read(context, signal); f.store.controls.now += 900; return value; };
  f.store.controls.readStagingGrant = () => { f.store.controls.now += 100; return f.store.controls.stagingGrant; };
  const result = await f.run({ timeoutMs: 1000 }); failure(result, "RUN_TIMED_OUT");
  assert.equal(result.receipt.analysis, "returned"); assert.equal(result.receipt.storage, "started");
  assert.equal(f.store.controls.commits, 0);
});
test("shared clock rejects rollback between completed analysis and staging", async () => {
  const f = fixture(); f.store.controls.readAuthority = () => { f.store.controls.now--; return f.store.controls.authority; };
  const result = await f.run(); failure(result, "AUTHORITY_UNAVAILABLE");
  assert.equal(result.receipt.storage, "started"); assert.equal(f.store.controls.commits, 0);
});
for (const now of [NaN, Infinity, -1, -0, 0.5, 253402300800000]) {
  test(`invalid shared clock ${String(now)} makes no provider calls`, async () => {
    const f = fixture(); f.store.controls.now = now;
    failure(await f.run(), "AUTHORITY_UNAVAILABLE"); assert.equal(f.calls.authority, 0);
  });
}
test("analysis.now cannot supply a conflicting second lifetime clock", async () => {
  const f = fixture(); let calls = 0; f.analysis.now = () => { calls++; throw new Error(SYNTHETIC_PRIVATE); };
  assert.ok((await f.run()).ok); assert.equal(calls, 0);
});
test("separate storage consent remains mandatory after successful analysis", async () => {
  const f = fixture(); f.store.controls.stagingGrant = null;
  const result = await f.run(); failure(result, "REVIEW_AUTHORITY_CHANGED");
  assert.equal(result.receipt.quota, "consumed"); assert.equal(result.receipt.storage, "started");
  assert.equal(f.store.controls.transactions, 0);
});
test("original authority cannot be rebound to a different generation for storage", async () => {
  const f = fixture(); f.store.controls.authority = reviewAuthority({ dataGeneration: 2 });
  const result = await f.run(); failure(result, "REVIEW_AUTHORITY_CHANGED");
  assert.equal(f.store.controls.transactions, 0); assert.equal(f.store.rows.batchReferences.size, 0);
});
test("commit failure does not retry and never claims acknowledged storage", async () => {
  const f = fixture(); f.store.controls.beforeCommit = () => { throw new Error(SYNTHETIC_PRIVATE); };
  const result = await f.run(); failure(result, "REVIEW_STORE_UNAVAILABLE");
  assert.equal(result.receipt.storage, "started"); assert.equal(f.store.controls.transactions, 1);
  assert.equal(f.store.controls.commits, 0); assert.equal(f.store.controls.rollbacks, 1); assert.equal(f.store.rows.candidates.size, 0);
});
test("commit acknowledgement loss preserves committed state and explicit recovery never reruns analysis", async () => {
  const f = fixture(); f.store.controls.afterCommit = () => { throw new Error(SYNTHETIC_PRIVATE); };
  const result = await f.run(); failure(result, "REVIEW_STORE_UNAVAILABLE");
  assert.equal(result.receipt.storage, "started"); assert.equal(f.store.controls.commits, 1); assert.equal(f.store.controls.rollbacks, 0);
  assert.equal(f.store.rows.candidates.size, 1); assert.equal(f.store.rows.batchReferences.size, 1);
  delete f.store.controls.afterCommit;
  f.store.controls.authority = reviewAuthority({ sessionId: "synthetic-new-session", sessionRevision: 2 });
  f.store.controls.analysisAuthority = null; f.store.controls.stagingGrant = null;
  const before = f.store.snapshot(), calls = { ...f.calls };
  const recovery = await createCandidateBatchReferences(f.deps.references).ensure({ analysisOperationId: source.operationId });
  assert.ok(recovery.ok); assert.deepEqual(recovery.value, { batchReference: ALIAS, dataGeneration: 1 });
  assert.deepEqual(f.store.snapshot(), before); assert.deepEqual(f.calls, calls);
});
test("abort while commit acknowledgement is held suppresses locator, not committed rows", async () => {
  const f = fixture(), committed = deferred(), release = deferred(), controller = new AbortController();
  f.store.controls.afterCommit = async () => { committed.resolve(); await release.promise; };
  const pending = f.run({ signal: controller.signal });
  try {
    await committed.promise; controller.abort(SYNTHETIC_PRIVATE);
    const result = await pending; failure(result, "RUN_CANCELLED"); assert.equal(result.receipt.storage, "started");
    assert.equal(f.store.controls.commits, 1); assert.equal(f.store.controls.rollbacks, 0); assert.equal(f.store.rows.batchReferences.size, 1);
  } finally { release.resolve(); await pending; }
});
test("authority change after committed acknowledgement suppresses public locator", async () => {
  const f = fixture(); f.store.controls.afterCommit = () => { f.store.controls.authority = reviewAuthority({ sessionRevision: 2 }); };
  const result = await f.run(); failure(result, "REVIEW_AUTHORITY_CHANGED");
  assert.equal(result.receipt.storage, "started"); assert.equal(f.store.controls.commits, 1);
  assert.equal(f.store.rows.batchReferences.size, 1);
});
for (const changed of [null, reviewAuthority({ sessionRevision: 2 }), reviewAuthority({ dataGeneration: 2 })]) {
  test(`coordinator final authority guard rejects ${changed === null ? "logout" : Object.keys(changed).filter((key) => changed[key as keyof typeof changed] === 2).join("/")} after stage acknowledgement`, async () => {
    const baseline = fixture(); assert.ok((await baseline.run()).ok);
    const finalRead = baseline.store.controls.authorityReads; assert.ok(finalRead > 1);
    const f = fixture(); let triggered = false;
    f.store.controls.readAuthority = (call) => { if (call === finalRead) { triggered = true; return changed; } return f.store.controls.authority; };
    const result = await f.run(); failure(result, "REVIEW_AUTHORITY_CHANGED");
    assert.ok(triggered); assert.equal(result.receipt.storage, "acknowledged");
    assert.equal(f.store.controls.commits, 1); assert.equal(f.store.controls.rollbacks, 0);
  });
}
test("cancellation in the coordinator's final authority await preserves acknowledgement but exposes no locator", async () => {
  const baseline = fixture(); assert.ok((await baseline.run()).ok); const finalRead = baseline.store.controls.authorityReads;
  const f = fixture(), entered = deferred(), release = deferred(), controller = new AbortController();
  f.store.controls.readAuthority = async (call) => {
    if (call === finalRead) { entered.resolve(); await release.promise; }
    return f.store.controls.authority;
  };
  const pending = f.run({ signal: controller.signal });
  try {
    await entered.promise; controller.abort(SYNTHETIC_PRIVATE);
    const result = await pending; failure(result, "RUN_CANCELLED"); assert.equal(result.receipt.storage, "acknowledged");
    assert.equal(f.store.controls.commits, 1); assert.equal(f.store.rows.batchReferences.size, 1);
  } finally { release.resolve(); await pending; }
});
test("exact pending access boundary after commit does not disclose a saved receipt", async () => {
  const f = fixture(), deadline = REVIEW_NOW + 1000;
  f.store.controls.stagingGrant = stagingGrant({ pendingAccessUntil: deadline });
  f.store.controls.afterCommit = () => { f.store.controls.now = deadline; };
  const result = await f.run(); failure(result, "REVIEW_AUTHORITY_CHANGED");
  assert.equal(result.receipt.storage, "started"); assert.equal(f.store.controls.commits, 1);
  assert.equal([...f.store.rows.candidates.values()][0]!.expiresAt, deadline);
});
test("independent concurrent deliveries retain each locator and their own receipt state", async () => {
  const first = fixture(), second = fixture(), entered = deferred(), release = deferred();
  const secondDeps = { ...second.deps, references: { ...second.deps.references, newReference: () => `${ALIAS}-second` } };
  first.store.controls.afterCommit = async () => { entered.resolve(); await release.promise; };
  const one = first.run();
  try {
    await entered.promise;
    const two = await deliverMailAnalysis(secondDeps, options()); assert.ok(two.ok); assert.equal(two.value.batchReference, `${ALIAS}-second`);
    release.resolve(); const result = await one; assert.ok(result.ok); assert.equal(result.value.batchReference, ALIAS);
    assert.equal(result.receipt.storage, "acknowledged"); assert.equal(two.receipt.storage, "acknowledged");
  } finally { release.resolve(); await one; }
});
