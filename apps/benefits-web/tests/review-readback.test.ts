import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewService } from "../src/server/review/review-service.ts";
import { projectReviewedBenefit, projectReviewReceipt } from "../src/server/review/presentation.ts";
import type { ReviewResult, ReviewTransaction } from "../src/server/review/contracts.ts";
import { createReviewedBenefitViewState, reduceReviewedBenefitView } from "../src/domain/reviewed-benefit-view.ts";
import { CANDIDATE_ID, SERVICE_ID, REVIEW_NOW, SYNTHETIC_PRIVATE,
  createReviewMemoryStore, reviewAuthority, reviewValues } from "./support/review-memory-store.ts";

// Internal synthetic transactions only: no auth provider, durable DB, HTTP route
// or real user data. A read snapshot is not a perpetual freshness guarantee.
const draft = () => ({ candidateId: CANDIDATE_ID, candidateRevision: 1,
  serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues({ remainingAmount: 0,
    expiresAt: "2028-02-29", observedAt: "2026-09-27T12:34:56.123456789+09:00" }) });
function success<T>(result: ReviewResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}
function frozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}
async function setup() {
  const store = createReviewMemoryStore();
  const service = createReviewService(store.dependencies);
  const preview = success(await service.preview(draft()));
  const saved = success(await service.confirm({ previewId: preview.id,
    operationId: "synthetic-confirm-readback", decision: "confirm" }));
  const request = { benefitId: saved.benefitId };
  const remove = () => service.remove({ ...request, expectedRevision: saved.benefitRevision,
    operationId: "synthetic-remove-readback", decision: "delete" });
  return { store, service, saved, preview, request, remove };
}

test("saved benefit is readable by a fresh same-owner session without a replay command or writes", async () => {
  const f = await setup();
  const before = f.store.snapshot();
  f.store.controls.authority = reviewAuthority({ sessionId: "synthetic-new-session", sessionRevision: 8 });
  f.store.controls.trace.length = 0;
  const service = createReviewService({ ...f.store.dependencies,
    newId: () => { throw new Error("read must not allocate an id"); } });
  const result = await service.get(f.request);
  const value = success(result);
  assert.deepEqual(Object.keys(value).sort(), ["schema", "dataGeneration", "outcome", "benefitId", "benefitRevision", "content"].sort());
  assert.equal(value.benefitId, f.saved.benefitId);
  assert.equal(value.outcome, "saved");
  assert.equal(value.content!.values.remainingAmount, 0);
  assert.equal(value.content!.values.trialDaysStated, null);
  assert.equal(value.content!.values.expiresAt, "2028-02-29");
  assert.equal(value.content!.values.observedAt, "2026-09-27T12:34:56.123456789+09:00");
  assert.equal(value.content!.source.values.observedAt, null);
  assert.equal(value.content!.valueOrigins.observedAt, "user-corrected");
  assert.equal(value.content!.accountProof, "not-established");
  assert.equal(value.content!.currentBalanceProof, "not-established");
  assert.equal(value.content!.reviewStatus, "accepted-by-user");
  assert.deepEqual(f.store.snapshot(), before);
  assert.deepEqual(f.store.controls.trace, ["readAuthority", "limitCommitTime", "readAuthority",
    "getBenefit", "readAuthority", "readAuthority"]);
  frozen(result);
});

test("accepted observations remain readable after their original pending candidate deadline", async () => {
  const f = await setup();
  f.store.controls.now = REVIEW_NOW + 86400000;
  f.store.controls.authority = reviewAuthority({ sessionId: "synthetic-next-day", expiresAt: f.store.controls.now + 60000 });
  const before = f.store.snapshot();
  assert.equal(success(await f.service.get(f.request)).outcome, "saved");
  assert.deepEqual(f.store.snapshot(), before);
});

test("readback projects exactly the receipt DTO without private source or operation bindings", async () => {
  const f = await setup();
  const read = success(await f.service.get(f.request));
  const view = projectReviewedBenefit(read);
  assert.deepEqual(view, projectReviewReceipt(f.saved));
  const serialized = JSON.stringify(view);
  for (const key of ["ownerId", "sessionId", "operationId", "replayed", "candidateId", "candidateRevision",
    "mailboxBindingId", "analysisOperationId", "candidateIndex", "source", "deletedAt", "body", "quote"]) {
    assert.equal(serialized.includes(`"${key}"`), false, key);
  }
  for (const binding of [read.content!.candidateId, read.content!.source.mailboxBindingId,
    read.content!.source.analysisOperationId]) assert.equal(serialized.includes(binding), false);
  frozen(view);
});

test("deleted readback is content-null and cannot revive an already observed tombstone", async () => {
  const f = await setup();
  const old = projectReviewedBenefit(success(await f.service.get(f.request)));
  success(await f.remove());
  const before = f.store.snapshot();
  const read = success(await f.service.get(f.request));
  assert.equal(read.outcome, "deleted");
  assert.equal(read.content, null);
  assert.equal(read.benefitRevision, 2);
  const deleted = projectReviewedBenefit(read);
  let state = createReviewedBenefitViewState("synthetic-view-a", read.dataGeneration);
  state = reduceReviewedBenefitView(state, { type: "response", capturedScope: state.viewScope, payload: deleted });
  assert.equal(reduceReviewedBenefitView(state, { type: "response", capturedScope: state.viewScope, payload: old }), state);
  const reset = createReviewedBenefitViewState("synthetic-view-b", read.dataGeneration);
  assert.equal(reduceReviewedBenefitView(reset, { type: "response", capturedScope: state.viewScope, payload: old }), reset);
  assert.deepEqual(f.store.snapshot(), before);
});

for (const [name, authority] of [
  ["other owner", reviewAuthority({ ownerId: "synthetic-other-owner" })],
  ["other generation", reviewAuthority({ dataGeneration: 2 })],
] as const) test(`readback hides ${name} as not found without writes`, async () => {
  const f = await setup();
  const before = f.store.snapshot();
  f.store.controls.authority = authority;
  assert.deepEqual(await f.service.get(f.request), { ok: false, code: "REVIEW_NOT_FOUND" });
  assert.deepEqual(f.store.snapshot(), before);
});

for (const input of [null, [], {}, { benefitId: "" }, { benefitId: " bad" }, { benefitId: 1 },
  { benefitId: "synthetic-id", ownerId: "synthetic-owner" },
  { benefitId: "synthetic-id", dataGeneration: 1 },
  { benefitId: "synthetic-id", operationId: "synthetic-op" },
  { benefitId: "synthetic-id", decision: "confirm" }]) {
  test(`readback rejects noncanonical input ${JSON.stringify(input)} before auth or DB`, async () => {
    const store = createReviewMemoryStore();
    assert.deepEqual(await createReviewService(store.dependencies).get(input), { ok: false, code: "REVIEW_INPUT_INVALID" });
    assert.equal(store.controls.authorityReads, 0);
    assert.equal(store.controls.transactions, 0);
  });
}

test("readback rejects input accessors without invoking them and captures the ID before awaiting auth", async () => {
  const f = await setup();
  let invoked = 0;
  assert.deepEqual(await f.service.get({ get benefitId() { invoked++; return f.request.benefitId; } }),
    { ok: false, code: "REVIEW_INPUT_INVALID" });
  assert.equal(invoked, 0);
  const request = { ...f.request };
  const service = createReviewService({ ...f.store.dependencies, readAuthority: async () => {
    request.benefitId = "synthetic-missing";
    return f.store.dependencies.readAuthority();
  } });
  assert.equal(success(await service.get(request)).benefitId, f.request.benefitId);
});

for (const authority of [null, reviewAuthority({ expiresAt: REVIEW_NOW })]) {
  test(`readback denies ${authority === null ? "missing" : "expired"} authority before transaction`, async () => {
    const f = await setup();
    f.store.controls.authority = authority;
    const count = f.store.controls.transactions;
    assert.deepEqual(await f.service.get(f.request), { ok: false, code: "REVIEW_AUTH_REQUIRED" });
    assert.equal(f.store.controls.transactions, count);
  });
}

for (const moment of ["after-read", "after-commit"] as const) {
  test(`readback hides payload if authority changes ${moment}`, async () => {
    const f = await setup();
    const before = f.store.snapshot();
    const revoke = () => { f.store.controls.authority = reviewAuthority({ sessionRevision: 2 }); };
    if (moment === "after-read") f.store.controls.afterMethod = (method) => { if (method === "getBenefit") revoke(); };
    else f.store.controls.afterCommit = revoke;
    assert.deepEqual(await f.service.get(f.request), { ok: false, code: "REVIEW_AUTHORITY_CHANGED" });
    assert.deepEqual(f.store.snapshot(), before);
  });
}

for (const offset of [0, -1, -600001]) {
  test(`readback checks the final clock independently of final authority: offset ${offset}`, async () => {
    const f = await setup();
    const end = REVIEW_NOW + 600000;
    let committed = false;
    let ticks = 0;
    f.store.controls.afterCommit = () => { committed = true; };
    const service = createReviewService({ ...f.store.dependencies, now: () => {
      if (!committed || ++ticks === 1) return REVIEW_NOW;
      return end + offset;
    } });
    const result = await service.get(f.request);
    assert.equal(ticks, 2);
    if (offset === -1) assert.equal(success(result).outcome, "saved");
    else assert.deepEqual(result, { ok: false, code: "REVIEW_AUTHORITY_CHANGED" });
  });
}

test("missing ID is not found and adapter failure is a fixed error without private detail", async () => {
  const f = await setup();
  assert.deepEqual(await f.service.get({ benefitId: "synthetic-missing" }), { ok: false, code: "REVIEW_NOT_FOUND" });
  f.store.controls.beforeMethod = () => { throw new Error(SYNTHETIC_PRIVATE); };
  const result = await f.service.get(f.request);
  assert.deepEqual(result, { ok: false, code: "REVIEW_STORE_UNAVAILABLE" });
  frozen(result);
});

for (const patch of [{ ownerId: "synthetic-other-owner" }, { dataGeneration: 2 }, { id: "synthetic-other-benefit" }]) {
  test(`service rejects a broken adapter row binding ${JSON.stringify(patch)}`, async () => {
    const f = await setup();
    const foreign = { ...f.store.rows.benefits.get(f.request.benefitId)!, ...patch };
    const service = createReviewService({ ...f.store.dependencies, transaction: (authority, action) =>
      f.store.dependencies.transaction(authority, (tx) => action({ ...tx, getBenefit: async () => foreign })) });
    assert.deepEqual(await service.get(f.request), { ok: false, code: "REVIEW_NOT_FOUND" });
  });
}

test("a later serialized deletion can overtake delivery of a read snapshot without resurrecting the view", async () => {
  const f = await setup();
  let release!: () => void;
  let readCommitted!: () => void;
  const ready = new Promise<void>((resolve) => { readCommitted = resolve; });
  const delivery = new Promise<void>((resolve) => { release = resolve; });
  const reader = createReviewService({ ...f.store.dependencies,
    transaction: async (authority, action) => {
      const result = await f.store.dependencies.transaction(authority, action);
      // Real async gap AFTER the serialized transaction released its lock.
      readCommitted();
      await delivery;
      return result;
    } });
  const pendingRead = reader.get(f.request);
  await ready;
  let state = createReviewedBenefitViewState("synthetic-racing-view", 1);
  try {
    const deleted = projectReviewReceipt(success(await f.remove()));
    state = reduceReviewedBenefitView(state, { type: "response", capturedScope: state.viewScope, payload: deleted });
    assert.equal(state.entries[0]!.outcome, "deleted");
  } finally { release(); }
  const late = projectReviewedBenefit(success(await pendingRead));
  // This is the valid earlier transaction snapshot, not a claim of latest state.
  assert.equal(late.outcome, "saved");
  assert.equal(late.benefitRevision, 1);
  assert.equal(reduceReviewedBenefitView(state, { type: "response", capturedScope: state.viewScope, payload: late }), state);
  const next = success(await f.service.get(f.request));
  assert.equal(next.outcome, "deleted");
  assert.equal(next.content, null);
});

test("preview generation is derived from current server authority and not the draft", async () => {
  const store = createReviewMemoryStore();
  store.controls.authority = reviewAuthority({ dataGeneration: 7 });
  for (const row of store.rows.candidates.values()) store.rows.candidates.set(row.id, { ...row, dataGeneration: 7 });
  for (const row of store.rows.services.values()) store.rows.services.set(row.id, { ...row, dataGeneration: 7 });
  const service = createReviewService(store.dependencies);
  assert.equal(success(await service.preview(draft())).dataGeneration, 7);
  assert.deepEqual(await service.preview({ ...draft(), dataGeneration: 1 }), { ok: false, code: "REVIEW_INPUT_INVALID" });
});

for (const patch of [{ revision: 0 }, { state: "unknown" }, { content: null }, { deletedAt: "not-a-date" }]) {
  test(`readback refuses malformed persisted rows ${JSON.stringify(patch)}`, async () => {
    const f = await setup();
    const row = f.store.rows.benefits.get(f.request.benefitId)!;
    f.store.rows.benefits.set(row.id, { ...row, ...patch } as typeof row);
    assert.deepEqual(await f.service.get(f.request), { ok: false, code: "REVIEW_STORE_UNAVAILABLE" });
  });
}

test("readback calls no transaction mutation port", async () => {
  const f = await setup();
  const mutation = () => { throw new Error("read attempted a write"); };
  const service = createReviewService({ ...f.store.dependencies, transaction: (authority, action) =>
    f.store.dependencies.transaction(authority, (tx) => {
      const onlyRead: ReviewTransaction = { ...tx, insertPreview: mutation, insertBenefit: mutation,
        insertOperation: mutation, updateCandidate: mutation, updatePreview: mutation,
        updateBenefit: mutation, eraseCandidatePreviews: mutation, requireServiceVersion: mutation,
        advanceBenefitCollectionRevision: mutation };
      return action(onlyRead);
    }) });
  assert.equal(success(await service.get(f.request)).outcome, "saved");
});
