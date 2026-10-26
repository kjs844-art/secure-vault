import assert from "node:assert/strict";
import { test } from "node:test";
import { selectReviewedBenefitHistory } from "../src/domain/reviewed-benefit-history.ts";
import { createReviewedBenefitListOwner } from "../src/domain/reviewed-benefit-list-owner.ts";
import { projectReviewedBenefitPage } from "../src/server/review/page-presentation.ts";
import { projectReviewReceipt } from "../src/server/review/presentation.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import type { ReviewResult, ReviewValues } from "../src/server/review/contracts.ts";
import { candidateRow, createReviewMemoryStore, REVIEW_NOW, reviewAuthority,
  reviewValues, SERVICE_ID, serviceRow } from "./support/review-memory-store.ts";

// Actual internal service -> synthetic serialized adapter -> browser projection
// -> lifetime owner -> display selector. This is not HTTP, authenticated browser
// integration, a real DB, provider balance proof or a complete/fresh inventory.
type Owner = ReturnType<typeof createReviewedBenefitListOwner>;
function success<T>(result: ReviewResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}
function snapshot(owner: Owner) {
  const value = owner.getSnapshot(); assert.ok(value); return value;
}
function begin(owner: Owner) {
  const current = snapshot(owner);
  const attempt = owner.begin(current.lease, current); assert.ok(attempt); return attempt;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const store = createReviewMemoryStore(), ids: string[] = [];
  const service = createReviewService({ ...store.dependencies, newId: () => {
    assert.ok(ids.length, "only explicit synthetic preview/confirm writes allocate IDs");
    return ids.shift()!;
  } });
  return { store, service, ids };
}
type Fixture = ReturnType<typeof fixture>;
async function add(f: Fixture, id: string, values: ReviewValues = reviewValues(), generation = 1) {
  const candidateId = `candidate-${id}`;
  f.store.rows.candidates.set(candidateId, candidateRow({ id: candidateId, dataGeneration: generation }));
  f.ids.push(`preview-${id}`, id);
  const preview = success(await f.service.preview({ candidateId, candidateRevision: 1,
    serviceId: SERVICE_ID, serviceRevision: 1, values }));
  const saved = success(await f.service.confirm({ previewId: preview.id,
    operationId: `confirm-${id}`, decision: "confirm" }));
  return { saved, remove: { benefitId: id, expectedRevision: saved.benefitRevision,
    operationId: `remove-${id}`, decision: "delete" } };
}
const id = (index: number) => `synthetic-benefit-${String(index).padStart(3, "0")}`;
const elapsed = () => reviewValues({ expiresAt: "2026-09-27T23:59:59.999999999Z", remainingAmount: 0 });
const listCalls = (f: Fixture) => f.store.controls.trace.filter((entry) => entry === "listReviewedBenefits").length;

test("fifty elapsed first-page observations do not hide the next explicit page when review selection is empty", async () => {
  const f = fixture(), owner = createReviewedBenefitListOwner();
  try {
    for (let index = 0; index < 50; index++) await add(f, id(index), elapsed());
    await add(f, id(50), reviewValues({ expiresAt: null, remainingAmount: null }));
    await add(f, id(51), reviewValues({ expiresAt: "2026-09-28T00:00:00.000000001Z", remainingAmount: 0 }));
    const before = f.store.snapshot();
    assert.ok(owner.activate(1));
    const first = begin(owner);
    assert.deepEqual(first.request, { limit: 50, cursor: null });
    const firstPage = projectReviewedBenefitPage(success(await f.service.list(first.request)));
    assert.equal(firstPage.nextCursor?.afterId, id(49));
    assert.equal(owner.settle(first.ticket, firstPage), true);
    const shown = snapshot(owner);
    assert.equal(shown.phase, "more"); assert.equal(shown.pagesAccepted, 1);
    assert.equal(shown.pageRowsObserved, 50); assert.equal(shown.entries.length, 50);
    const review = selectReviewedBenefitHistory(shown.entries, "review", REVIEW_NOW)!;
    assert.ok(review); assert.deepEqual(review.records, []);
    assert.equal(review.totalLiveCount, 50); assert.equal(review.historyCount, 50);
    assert.equal(Object.hasOwn(review, "nextCursor"), false);
    assert.equal(owner.getSnapshot(), shown); assert.equal(listCalls(f), 1, "selection does not fetch more");
    const history = selectReviewedBenefitHistory(shown.entries, "history", REVIEW_NOW)!;
    assert.deepEqual(history.records.map((row) => row.record.benefitId), Array.from({ length: 50 }, (_, i) => id(i)));

    const next = begin(owner);
    assert.deepEqual(next.request.cursor, firstPage.nextCursor);
    assert.equal(owner.settle(next.ticket, projectReviewedBenefitPage(success(await f.service.list(next.request)))), true);
    const end = snapshot(owner);
    assert.equal(end.phase, "end_observed"); assert.equal(end.pagesAccepted, 2);
    assert.equal(end.pageRowsObserved, 52); assert.equal(listCalls(f), 2);
    const selected = selectReviewedBenefitHistory(end.entries, "review", REVIEW_NOW)!;
    assert.deepEqual(selected.records.map((row) => row.record.benefitId), [id(50), id(51)]);
    assert.deepEqual(selected.records.map((row) => row.record.content.values.remainingAmount), [null, 0]);
    assert.deepEqual(selected.records.map((row) => row.reason), ["expiry_unknown", "expiry_future"]);
    assert.equal(selected.totalLiveCount, 52); assert.equal(selected.historyCount, 50);
    assert.equal(selected.records[1]!.record.content.valueOrigins.remainingAmount, "user-corrected");
    assert.equal(selected.records[1]!.record.content.currentBalanceProof, "not-established");
    assert.equal(owner.begin(end.lease, end), null);
    assert.deepEqual(f.store.snapshot(), before, "listing/classifying never writes or purges expired records");
  } finally { owner.dispose(); }
});

test("a real deletion between pages conflicts, preserves prior observations and then applies its receipt tombstone", async () => {
  const f = fixture(), owner = createReviewedBenefitListOwner();
  try {
    const firstRecord = await add(f, id(0), elapsed());
    for (let index = 1; index < 51; index++) await add(f, id(index), elapsed());
    const lease = owner.activate(1); assert.ok(lease);
    const first = begin(owner);
    const firstPage = projectReviewedBenefitPage(success(await f.service.list(first.request)));
    assert.equal(owner.settle(first.ticket, firstPage), true);
    const prior = snapshot(owner), next = begin(owner);
    const removed = projectReviewReceipt(success(await f.service.remove(firstRecord.remove)));
    const afterDelete = f.store.snapshot();
    const calls = listCalls(f);
    const conflict = await f.service.list(next.request);
    assert.deepEqual(conflict, { ok: false, code: "REVIEW_CONFLICT" });
    assert.equal(listCalls(f), calls, "stale collection revision rejects before row-list port");
    assert.equal(owner.fail(next.ticket, "conflict"), true);
    const conflicted = snapshot(owner);
    assert.equal(conflicted.phase, "restart_required");
    assert.equal(conflicted.entries, prior.entries, "conflict alone is not a deletion observation");
    assert.equal(selectReviewedBenefitHistory(conflicted.entries, "history", REVIEW_NOW)?.historyCount, 50);
    assert.equal(owner.begin(lease, conflicted), null);

    assert.equal(owner.observe(lease, removed), "updated");
    const withTombstone = snapshot(owner), tombstone = withTombstone.entries[0]!;
    assert.equal(withTombstone.phase, "restart_required");
    assert.equal(tombstone.benefitId, id(0)); assert.equal(tombstone.outcome, "deleted");
    assert.equal(tombstone.content, null); assert.equal(withTombstone.entries.length, 50);
    const history = selectReviewedBenefitHistory(withTombstone.entries, "history", REVIEW_NOW)!;
    assert.equal(history.totalLiveCount, 49); assert.equal(history.historyCount, 49);
    assert.equal(history.records.some((row) => row.record.benefitId === id(0)), false);
    assert.equal(owner.settle(next.ticket, firstPage), false, "already consumed traversal cannot republish an old page");
    assert.equal(owner.observe(lease, projectReviewReceipt(firstRecord.saved)), "unchanged");
    assert.equal(snapshot(owner).entries[0], tombstone, "an old saved receipt cannot resurrect a tombstone");
    assert.deepEqual(f.store.snapshot(), afterDelete);

    const replacement = owner.activate(1); assert.ok(replacement); assert.notEqual(replacement, lease);
    assert.deepEqual(snapshot(owner).entries, []);
    const restart = begin(owner); assert.equal(restart.request.cursor, null);
    assert.equal(owner.settle(restart.ticket, projectReviewedBenefitPage(success(await f.service.list(restart.request)))), true);
    const refreshed = snapshot(owner);
    assert.equal(refreshed.phase, "end_observed"); assert.equal(refreshed.entries.length, 50);
    assert.deepEqual(refreshed.entries.map((row) => row.benefitId), Array.from({ length: 50 }, (_, i) => id(i + 1)));
    assert.equal(refreshed.benefitCollectionRevision, firstPage.benefitCollectionRevision + 1);
    assert.deepEqual(f.store.snapshot(), afterDelete);
  } finally { owner.dispose(); }
});

for (const generation of [1, 2]) test(`a successfully produced page delayed across logout cannot publish into fresh generation ${generation}`, async () => {
  const f = fixture(), owner = createReviewedBenefitListOwner();
  await add(f, id(0), elapsed());
  const oldLease = owner.activate(1); assert.ok(oldLease);
  const oldAttempt = begin(owner), delivered = deferred<void>(), gate = deferred<void>();
  // A valid service response has completed before logout, but its consumer
  // delivery is withheld. This is not a claimed network cancellation or DB race.
  const late = f.service.list(oldAttempt.request).then(async (result) => {
    const page = projectReviewedBenefitPage(success(result));
    delivered.resolve();
    await gate.promise;
    return owner.settle(oldAttempt.ticket, page);
  });
  void late.catch(delivered.reject);
  let preserved: ReturnType<Owner["getSnapshot"]> = null;
  let notifications = 0, atReplacement = 0;
  owner.subscribe(() => { notifications++; });
  try {
    await delivered.promise;
    f.store.controls.authority = null;
    owner.deactivate(oldLease);
    assert.equal(owner.getSnapshot(), null);
    f.store.controls.authority = reviewAuthority({ dataGeneration: generation,
      sessionId: "synthetic-fresh-session", sessionRevision: 2 });
    if (generation === 2) {
      f.store.rows.services.set(SERVICE_ID, serviceRow({ dataGeneration: generation }));
      await add(f, "synthetic-fresh-benefit", reviewValues(), generation);
    }
    const lease = owner.activate(generation); assert.ok(lease); assert.notEqual(lease, oldLease);
    const attempt = begin(owner);
    assert.equal(owner.settle(attempt.ticket, projectReviewedBenefitPage(success(await f.service.list(attempt.request)))), true);
    preserved = snapshot(owner); atReplacement = notifications;
    assert.equal(preserved.dataGeneration, generation);
    assert.deepEqual(preserved.entries.map((row) => row.benefitId), [generation === 2 ? "synthetic-fresh-benefit" : id(0)]);
    gate.resolve();
    assert.equal(await late, false);
    assert.equal(owner.getSnapshot(), preserved); assert.equal(notifications, atReplacement);
    assert.equal(owner.fail(oldAttempt.ticket, "authority"), false);
    assert.equal(owner.cancel(oldLease, oldAttempt.ticket), false);
    owner.deactivate(oldLease);
    assert.equal(owner.getSnapshot(), preserved);
    assert.equal(listCalls(f), 2, "old delivery does not retry or read another page");
  } finally {
    gate.resolve();
    await late;
    owner.dispose();
  }
});
