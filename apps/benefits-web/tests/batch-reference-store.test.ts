import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateBatchReferenceRow } from "../src/server/inbox/batch-reference-contracts.ts";
import type { CandidateBatchRow } from "../src/server/inbox/contracts.ts";
import { analysisAuthority, createReviewMemoryStore, operationKey, REVIEW_NOW, REVIEW_OWNER,
  reviewAuthority, stagingGrant, SYNTHETIC_PRIVATE } from "./support/review-memory-store.ts";

// Adapter-only synthetic fixtures deliberately seed private persisted rows.
// Real analysis/stage/service orchestration is covered separately; this is not
// durable DB isolation, authentication, random-ID quality or deployment proof.
const OPERATION = "synthetic-analysis-operation", REFERENCE = "synthetic-reference-store";
function batch(patch: Partial<CandidateBatchRow> = {}): CandidateBatchRow {
  return { ownerId: REVIEW_OWNER, dataGeneration: 1, analysisOperationId: OPERATION,
    mailboxBindingId: "synthetic-mailbox", extractedAt: new Date(REVIEW_NOW).toISOString(),
    pendingAccessUntil: REVIEW_NOW + 86400000, fingerprint: "a".repeat(64), candidateIds: [], ...patch };
}
function reference(patch: Partial<CandidateBatchReferenceRow> = {}): CandidateBatchReferenceRow {
  return { batchReference: REFERENCE, ownerId: REVIEW_OWNER, dataGeneration: 1,
    analysisOperationId: OPERATION, state: "active", revision: 1, ...patch };
}
function fixture(seed = true) {
  const store = createReviewMemoryStore();
  if (seed) store.rows.batches.set(operationKey(REVIEW_OWNER, OPERATION), batch());
  return store;
}
type Store = ReturnType<typeof fixture>;
async function insert(store: Store, row = reference()) {
  return store.referenceDependencies.transaction(reviewAuthority(), async (tx) => tx.insertBatchReference(row));
}
function retired(row = reference()): CandidateBatchReferenceRow { return { ...row, state: "retired", revision: 2 }; }

test("owned existing batch permits one detached alias and two consistent lookup indexes", async () => {
  const store = fixture(), before = store.snapshot(), row = reference();
  assert.equal(await insert(store, row), true);
  assert.deepEqual(store.rows.batchReferences.get(REFERENCE), row);
  assert.equal(store.rows.batchReferenceSlots.get(operationKey(REVIEW_OWNER, OPERATION)), REFERENCE);
  assert.deepEqual(store.rows.batches, before.batches); assert.deepEqual(store.rows.candidates, before.candidates);
  await store.referenceDependencies.transaction(reviewAuthority(), async (tx) => {
    assert.deepEqual(await tx.getBatchReference(REFERENCE), row);
    assert.deepEqual(await tx.getBatchReferenceByOperation(OPERATION), row);
    tx.requireBatchReference(row);
    const read = await tx.getBatchReference(REFERENCE); assert.ok(read);
    assert.notEqual(read, store.rows.batchReferences.get(REFERENCE));
  });
  assert.ok(store.controls.trace.includes("requireBatchReference"));
});

test("same transaction may stage a batch, insert its alias and require it before commit", async () => {
  const store = fixture(false);
  await store.referenceDependencies.transaction(reviewAuthority(), async (tx) => {
    tx.requireCandidateStaging(analysisAuthority(), stagingGrant());
    assert.equal(await tx.insertCandidateBatch(batch()), true);
    assert.equal(await tx.insertBatchReference(reference()), true);
    tx.requireBatchReference(reference());
    assert.deepEqual(await tx.getBatchReferenceByOperation(OPERATION), reference());
  });
  assert.equal(store.rows.batches.size, 1); assert.equal(store.rows.batchReferences.size, 1);
  assert.equal(store.rows.batchReferenceSlots.size, 1);
});

test("failure after same-transaction stage/alias insertion rolls back batches and both reference maps", async () => {
  const store = fixture(false), before = store.snapshot();
  await assert.rejects(store.referenceDependencies.transaction(reviewAuthority(), async (tx) => {
    tx.requireCandidateStaging(analysisAuthority(), stagingGrant());
    assert.equal(await tx.insertCandidateBatch(batch()), true);
    assert.equal(await tx.insertBatchReference(reference()), true);
    throw Error(SYNTHETIC_PRIVATE);
  }));
  assert.deepEqual(store.snapshot(), before); assert.equal(store.controls.rollbacks, 1);
});

test("missing, foreign and corrupt backing batches cannot acquire aliases", async () => {
  for (const value of [null, batch({ ownerId: "other-owner" }), batch({ dataGeneration: 2 }),
    batch({ analysisOperationId: "other-operation" }), batch({ fingerprint: "invalid" })]) {
    const store = fixture(false);
    if (value) store.rows.batches.set(operationKey(REVIEW_OWNER, OPERATION), value);
    const before = store.snapshot(); assert.equal(await insert(store), false); assert.deepEqual(store.snapshot(), before);
  }
});

for (const corruption of ["missing-row", "wrong-operation", "wrong-owner", "wrong-reference"] as const)
  test(`observable ${corruption} index corruption is not treated as an absent alias`, async () => {
    const store = fixture(); await insert(store);
    if (corruption === "missing-row") store.rows.batchReferences.delete(REFERENCE);
    if (corruption === "wrong-operation") store.rows.batchReferences.set(REFERENCE, reference({ analysisOperationId: "other-operation" }));
    if (corruption === "wrong-owner") store.rows.batchReferences.set(REFERENCE, reference({ ownerId: "other-owner" }));
    if (corruption === "wrong-reference") store.rows.batchReferences.set(REFERENCE, reference({ batchReference: "other-reference" }));
    const before = store.snapshot();
    await assert.rejects(store.referenceDependencies.transaction(reviewAuthority(), async (tx) => tx.getBatchReferenceByOperation(OPERATION)));
    assert.deepEqual(store.snapshot(), before);
  });

test("missing index remains a lookup absence while orphan-row uniqueness still forbids replacement", async () => {
  const store = fixture(); await insert(store);
  store.rows.batchReferenceSlots.delete(operationKey(REVIEW_OWNER, OPERATION));
  const before = store.snapshot();
  await store.referenceDependencies.transaction(reviewAuthority(), async (tx) => {
    assert.equal(await tx.getBatchReferenceByOperation(OPERATION), null);
    assert.equal(await tx.insertBatchReference(reference({ batchReference: "replacement-reference" })), false);
    assert.throws(() => tx.requireBatchReference(reference()));
  });
  assert.deepEqual(store.snapshot(), before);
});

test("global reference and owner/operation uniqueness remain reserved after retirement and generation change", async () => {
  const store = fixture(); assert.equal(await insert(store), true);
  await store.referenceDependencies.transaction(reviewAuthority(), async (tx) => {
    assert.equal(await tx.retireBatchReference(retired(), 1), true);
    assert.equal(await tx.insertBatchReference(reference({ batchReference: "synthetic-replacement" })), false);
    assert.equal(await tx.insertBatchReference(reference()), false);
  });
  store.controls.authority = reviewAuthority({ dataGeneration: 2 });
  store.rows.batches.set(operationKey(REVIEW_OWNER, OPERATION), batch({ dataGeneration: 2 }));
  await store.referenceDependencies.transaction(reviewAuthority({ dataGeneration: 2 }), async (tx) => {
    assert.equal(await tx.insertBatchReference(reference({ batchReference: "synthetic-next-generation", dataGeneration: 2 })), false);
  });
  store.controls.authority = reviewAuthority({ ownerId: "other-owner" });
  store.rows.batches.set(operationKey("other-owner", OPERATION), batch({ ownerId: "other-owner" }));
  await store.referenceDependencies.transaction(reviewAuthority({ ownerId: "other-owner" }), async (tx) => {
    assert.equal(await tx.getBatchReference(REFERENCE), null);
    assert.equal(await tx.getBatchReferenceByOperation(OPERATION), null);
    assert.equal(await tx.insertBatchReference(reference({ ownerId: "other-owner" })), false);
  });
  assert.deepEqual(store.rows.batchReferences.get(REFERENCE), retired()); assert.equal(store.rows.batchReferences.size, 1);
});

test("retirement requires exact active immutable binding and preserves the terminal slot", async () => {
  const store = fixture(); await insert(store);
  await store.referenceDependencies.transaction(reviewAuthority(), async (tx) => {
    for (const row of [retired(reference({ ownerId: "other-owner" })), retired(reference({ dataGeneration: 2 })),
      retired(reference({ analysisOperationId: "other-operation" })), reference(), retired(reference({ batchReference: "other-ref" }))])
      assert.equal(await tx.retireBatchReference(row, 1), false);
    assert.equal(await tx.retireBatchReference(retired(), 2 as 1), false);
    assert.equal(await tx.retireBatchReference(retired(), 1), true);
    assert.equal(await tx.retireBatchReference(retired(), 1), false);
    assert.throws(() => tx.requireBatchReference(reference()));
  });
  assert.deepEqual(store.rows.batchReferences.get(REFERENCE), retired());
  assert.equal(store.rows.batchReferenceSlots.get(operationKey(REVIEW_OWNER, OPERATION)), REFERENCE);
});

for (const method of ["insertBatchReference", "retireBatchReference"] as const)
  test(`conditional ${method} failure never partially changes a reference or index`, async () => {
    const store = fixture(); if (method === "retireBatchReference") await insert(store);
    store.controls.falseMethod = method; const before = store.snapshot();
    await store.referenceDependencies.transaction(reviewAuthority(), async (tx) => {
      assert.equal(await (method === "insertBatchReference" ? tx.insertBatchReference(reference()) : tx.retireBatchReference(retired(), 1)), false);
    });
    assert.deepEqual(store.snapshot(), before);
  });

for (const field of ["record", "index", "backing-batch"] as const)
  test(`insertion rejects concurrent ${field} change at commit and preserves external data`, async () => {
    const store = fixture(); let external: ReturnType<Store["snapshot"]> | undefined;
    store.controls.beforeCommit = () => {
      if (field === "record") store.rows.batchReferences.set(REFERENCE, retired());
      if (field === "index") store.rows.batchReferenceSlots.set(operationKey(REVIEW_OWNER, OPERATION), "external-reference");
      if (field === "backing-batch") store.rows.batches.set(operationKey(REVIEW_OWNER, OPERATION), batch({ fingerprint: "b".repeat(64) }));
      external = store.snapshot();
    };
    await assert.rejects(insert(store)); assert.deepEqual(store.snapshot(), external);
    assert.equal(store.controls.commits, 0); assert.equal(store.controls.rollbacks, 1);
  });

test("new staged batch cannot replace a concurrently inserted persisted batch at alias commit", async () => {
  const store = fixture(false); let external: ReturnType<Store["snapshot"]> | undefined;
  store.controls.beforeCommit = () => {
    store.rows.batches.set(operationKey(REVIEW_OWNER, OPERATION), batch({ fingerprint: "b".repeat(64) }));
    external = store.snapshot();
  };
  await assert.rejects(store.referenceDependencies.transaction(reviewAuthority(), async (tx) => {
    tx.requireCandidateStaging(analysisAuthority(), stagingGrant());
    assert.equal(await tx.insertCandidateBatch(batch()), true);
    assert.equal(await tx.insertBatchReference(reference()), true); tx.requireBatchReference(reference());
  }));
  assert.deepEqual(store.snapshot(), external); assert.equal(store.rows.batchReferences.size, 0);
});

for (const action of ["require", "unrelated-read", "retire"] as const)
  test(`${action} cannot overwrite an external retirement with its older snapshot`, async () => {
    const store = fixture(); await insert(store); const beforeCommits = store.controls.commits;
    store.controls.beforeCommit = () => { store.rows.batchReferences.set(REFERENCE, retired()); };
    await assert.rejects(store.referenceDependencies.transaction(reviewAuthority(), async (tx) => {
      if (action === "require") tx.requireBatchReference(reference());
      else if (action === "retire") assert.equal(await tx.retireBatchReference(retired(), 1), true);
      else await tx.getCandidate("unknown");
    }));
    assert.deepEqual(store.rows.batchReferences.get(REFERENCE), retired());
    assert.equal(store.rows.batchReferenceSlots.get(operationKey(REVIEW_OWNER, OPERATION)), REFERENCE);
    assert.equal(store.controls.commits, beforeCommits);
  });

test("require and retire also check persisted backing-batch stability at commit", async () => {
  for (const retire of [false, true]) {
    const store = fixture(); await insert(store);
    store.controls.beforeCommit = () => { store.rows.batches.delete(operationKey(REVIEW_OWNER, OPERATION)); };
    await assert.rejects(store.referenceDependencies.transaction(reviewAuthority(), async (tx) => {
      if (retire) assert.equal(await tx.retireBatchReference(retired(), 1), true);
      else tx.requireBatchReference(reference());
    }));
    assert.deepEqual(store.rows.batchReferences.get(REFERENCE), reference()); assert.equal(store.rows.batches.size, 0);
  }
});

test("direct committed resolver does not nest a transaction, expose uncommitted aliases or return shared rows", { timeout: 5000 }, async () => {
  const store = fixture(), signal = new AbortController().signal;
  await store.referenceDependencies.transaction(reviewAuthority(), async (tx) => {
    assert.equal(await tx.insertBatchReference(reference()), true);
    assert.equal(await store.referenceDependencies.readReference(REFERENCE, signal), null);
  });
  const transactions = store.controls.transactions;
  const read = await store.referenceDependencies.readReference(REFERENCE, signal);
  assert.deepEqual(read, reference()); assert.notEqual(read, store.rows.batchReferences.get(REFERENCE));
  assert.equal(store.controls.transactions, transactions);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(store.referenceDependencies.readReference(REFERENCE, abort.signal));
  assert.equal(store.controls.transactions, transactions);
});

test("uncertain post-commit acknowledgement leaves exactly one committed alias and reserved slot", async () => {
  const store = fixture(); store.controls.afterCommit = () => { throw Error(SYNTHETIC_PRIVATE); };
  await assert.rejects(insert(store));
  assert.deepEqual(store.rows.batchReferences.get(REFERENCE), reference());
  assert.equal(store.rows.batchReferenceSlots.size, 1); assert.equal(store.controls.commits, 1); assert.equal(store.controls.rollbacks, 0);
  delete store.controls.afterCommit;
  await store.referenceDependencies.transaction(reviewAuthority(), async (tx) => {
    assert.deepEqual(await tx.getBatchReferenceByOperation(OPERATION), reference());
    assert.equal(await tx.insertBatchReference(reference({ batchReference: "new-reference" })), false);
  });
  assert.equal(store.rows.batchReferences.size, 1);
});

test("synthetic reference generator has an independent namespace without clocks, grants or requests", () => {
  const store = fixture(), before = store.snapshot();
  const first = store.referenceDependencies.newReference(), second = store.referenceDependencies.newReference();
  assert.match(first, /^synthetic-batch-reference-/); assert.notEqual(first, second);
  assert.notEqual(first, store.dependencies.newId()); assert.notEqual(first, OPERATION);
  assert.equal(store.controls.trace.length, 0); assert.equal(store.controls.transactions, 0); assert.deepEqual(store.snapshot(), before);
});
