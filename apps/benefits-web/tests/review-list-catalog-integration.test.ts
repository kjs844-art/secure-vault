import assert from "node:assert/strict";
import { test } from "node:test";
import { createServiceCatalog } from "../src/server/catalog/service-catalog.ts";
import type { ServiceProfile } from "../src/server/catalog/contracts.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import type { ReviewResult } from "../src/server/review/contracts.ts";
import { candidateRow, createReviewMemoryStore, reviewValues } from "./support/review-memory-store.ts";

// Real internal controllers, synthetic memory adapter. Not a production database
// or service-account integration. Catalog live means record existence, not access.
function success<T>(result: ReviewResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}
const profile: ServiceProfile = { name: "Synthetic original", provider: null, planName: null,
  accountLabel: null, timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null };

async function fixture() {
  const store = createReviewMemoryStore();
  store.rows.services.clear();
  const catalog = createServiceCatalog(store.catalogDependencies);
  const review = createReviewService(store.dependencies);
  const service = success(await catalog.create({ operationId: "synthetic-create-catalog",
    decision: "create", profile })).service;
  const saved = [];
  for (const index of [1, 2]) {
    const candidateId = `synthetic-page-candidate-${index}`;
    store.rows.candidates.set(candidateId, candidateRow({ id: candidateId }));
    const preview = success(await review.preview({ candidateId, candidateRevision: 1,
      serviceId: service.serviceId, serviceRevision: service.serviceRevision,
      values: reviewValues({ remainingAmount: index === 1 ? null : 0, expiresAt: "2020-01-01" }) }));
    const command = { previewId: preview.id, operationId: `synthetic-confirm-page-${index}`, decision: "confirm" };
    saved.push({ receipt: success(await review.confirm(command)), command });
  }
  return { store, catalog, review, service, saved };
}

test("catalog edits do not reinterpret saved observations or invalidate their independent page revision", async () => {
  const f = await fixture();
  const first = success(await f.review.list({ limit: 1, cursor: null }));
  assert.ok(first.nextCursor);
  assert.equal(first.benefitCollectionRevision, 3);
  const benefitsBefore = f.store.snapshot().benefits;
  const catalogBefore = success(await f.catalog.list({ limit: 1, cursor: null }));
  const updated = success(await f.catalog.update({ serviceId: f.service.serviceId,
    expectedRevision: f.service.serviceRevision, operationId: "synthetic-rename-during-page", decision: "update",
    profile: { ...profile, name: "Synthetic renamed", subscriptionStatus: "trial_ended", trialEndsAt: "2020-01-01" } }));
  assert.equal(updated.service.profile!.subscriptionStatus, "trial_ended");
  const second = success(await f.review.list({ limit: 1, cursor: first.nextCursor }));
  assert.equal(second.benefitCollectionRevision, first.benefitCollectionRevision);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(f.store.snapshot().benefits, benefitsBefore);
  assert.equal(success(await f.catalog.list({ limit: 1, cursor: null })).catalogRevision, catalogBefore.catalogRevision + 1);
  const rows = [...first.benefits, ...second.benefits];
  assert.equal(rows.length, 2, "expired records remain live records, not deleted tombstones");
  assert.deepEqual(rows.map((row) => row.content!.values.remainingAmount), [null, 0]);
  for (const row of rows) {
    assert.equal(row.content!.serviceNameAtReview, profile.name);
    assert.equal(row.content!.values.expiresAt, "2020-01-01");
    assert.equal(row.content!.accountProof, "not-established");
    assert.equal(row.content!.currentBalanceProof, "not-established");
  }
});

test("catalog deletion stays blocked until all live benefits are deleted and cannot revive old page records", async () => {
  const f = await fixture();
  const first = success(await f.review.list({ limit: 1, cursor: null }));
  assert.ok(first.nextCursor);
  const catalogDelete = { serviceId: f.service.serviceId, expectedRevision: f.service.serviceRevision,
    operationId: "synthetic-delete-catalog", decision: "delete" };
  const remove = async (index: number) => {
    const row = f.saved[index]!.receipt;
    return success(await f.review.remove({ benefitId: row.benefitId, expectedRevision: row.benefitRevision,
      operationId: `synthetic-delete-benefit-${index}`, decision: "delete" }));
  };
  for (let index = 0; index < 2; index++) {
    const before = f.store.snapshot();
    assert.deepEqual(await f.catalog.remove(catalogDelete), { ok: false, code: "REVIEW_CONFLICT" });
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal((await remove(index)).content, null);
    assert.deepEqual(await f.review.list({ limit: 1, cursor: first.nextCursor }),
      { ok: false, code: "REVIEW_CONFLICT" });
  }
  assert.equal(success(await f.catalog.remove(catalogDelete)).service.state, "deleted");
  const beforeReplay = f.store.snapshot();
  const empty = success(await f.review.list({ limit: 1, cursor: null }));
  assert.equal(empty.benefitCollectionRevision, 5);
  assert.deepEqual(empty.benefits, []);
  assert.equal(empty.nextCursor, null);
  for (const { receipt, command } of f.saved) {
    const replay = success(await f.review.confirm(command));
    assert.equal(replay.replayed, true);
    assert.equal(replay.outcome, "deleted");
    assert.equal(replay.content, null);
    assert.equal(success(await f.review.get({ benefitId: receipt.benefitId })).outcome, "deleted");
  }
  assert.deepEqual(f.store.snapshot(), beforeReplay);
});
