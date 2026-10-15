import assert from "node:assert/strict";
import { test } from "node:test";
import { PREVIEW_TTL_MS, type CandidateRow, type ReviewErrorCode, type ReviewResult } from "../src/server/review/contracts.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import {
  CANDIDATE_ID, REVIEW_NOW, SERVICE_ID, SYNTHETIC_PRIVATE,
  candidateRow, createReviewMemoryStore, reviewAuthority, reviewValues,
} from "./support/review-memory-store.ts";

// Controlled synthetic clocks and in-memory rollback only. These checks do not
// establish production DB isolation, physical deletion scheduling or real auth.
const draft = () => ({ candidateId: CANDIDATE_ID, candidateRevision: 1,
  serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues() });
const confirm = (previewId: string) => ({ previewId, operationId: "synthetic-expiry-confirm", decision: "confirm" });
function fixture(expiresAt = REVIEW_NOW + 60000) {
  const store = createReviewMemoryStore();
  store.rows.candidates.set(CANDIDATE_ID, candidateRow({ expiresAt }));
  return { store, controls: store.controls, service: createReviewService(store.dependencies) };
}
function success<T>(result: ReviewResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}
function failure(result: ReviewResult<unknown>, code: ReviewErrorCode): void {
  assert.deepEqual(result, { ok: false, code });
  assert.ok(Object.isFrozen(result));
  assert.ok(!JSON.stringify(result).includes(SYNTHETIC_PRIVATE));
}

for (const offset of [-1, 0]) {
  test(`candidate expiry at now ${offset} prevents preview without changing any rows`, async () => {
    const f = fixture(REVIEW_NOW + offset);
    const before = f.store.snapshot();
    failure(await f.service.preview(draft()), "REVIEW_CONFLICT");
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(f.controls.commits, 0);
    assert.equal(f.controls.rollbacks, 1);
    assert.ok(!f.controls.trace.includes("insertPreview"));
  });
}

for (const limit of [
  { name: "candidate", candidate: 30000, authority: 600000, expected: 30000 },
  { name: "authority", candidate: 600000, authority: 20000, expected: 20000 },
  { name: "preview TTL", candidate: 900000, authority: 600000, expected: PREVIEW_TTL_MS },
]) {
  test(`preview expiry is the minimum of candidate access, session authority and TTL: ${limit.name}`, async () => {
    const f = fixture(REVIEW_NOW + limit.candidate);
    f.controls.authority = reviewAuthority({ expiresAt: REVIEW_NOW + limit.authority });
    const view = success(await f.service.preview(draft()));
    assert.equal(view.expiresAt, REVIEW_NOW + limit.expected);
    assert.equal(f.store.rows.previews.get(view.id)!.expiresAt, view.expiresAt);
    assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.expiresAt, REVIEW_NOW + limit.candidate);
    assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.state, "pending");
    assert.equal(f.store.rows.benefits.size, 0);
  });
}

for (const offset of [0, 1]) {
  test(`confirmation cannot consume a candidate at its expired access deadline plus ${offset}`, async () => {
    const deadline = REVIEW_NOW + 60000;
    const f = fixture(deadline);
    const view = success(await f.service.preview(draft()));
    const before = f.store.snapshot();
    f.controls.now = deadline + offset;
    failure(await f.service.confirm(confirm(view.id)), "REVIEW_PREVIEW_EXPIRED");
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(f.store.rows.benefits.size, 0);
    assert.equal(f.store.rows.operations.size, 0);
    assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.state, "pending");
  });
}

test("an older oversized stored preview still cannot bypass the candidate's own access deadline", async () => {
  const deadline = REVIEW_NOW + 1000;
  const f = fixture(deadline);
  const view = success(await f.service.preview(draft()));
  const stored = f.store.rows.previews.get(view.id)!;
  // Model an old or incorrect adapter's persisted fixture, not an allowed update.
  f.store.rows.previews.set(view.id, { ...stored, expiresAt: deadline + 1000 });
  f.controls.now = deadline;
  const before = f.store.snapshot();
  failure(await f.service.confirm(confirm(view.id)), "REVIEW_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(f.store.rows.benefits.size, 0);
});

test("candidate expiry while awaiting confirmation reads prevents writes and rolls back", async () => {
  const deadline = REVIEW_NOW + 1000;
  const f = fixture(deadline);
  const view = success(await f.service.preview(draft()));
  const before = f.store.snapshot();
  f.controls.trace.length = 0;
  f.controls.afterMethod = (method) => { if (method === "getCandidate") f.controls.now = deadline; };
  failure(await f.service.confirm(confirm(view.id)), "REVIEW_PREVIEW_EXPIRED");
  assert.deepEqual(f.store.snapshot(), before);
  assert.ok(!f.controls.trace.includes("insertBenefit"));
  assert.equal(f.controls.rollbacks, 1);
});

for (const expiresAt of [undefined, null, -1, NaN, Infinity, 1.5, 253402300800000]) {
  test(`malformed persisted candidate expiry is a redacted storage failure: ${String(expiresAt)}`, async () => {
    const f = fixture();
    f.store.rows.candidates.set(CANDIDATE_ID, { ...candidateRow(), expiresAt } as unknown as CandidateRow);
    const before = f.store.snapshot();
    failure(await f.service.preview(draft()), "REVIEW_STORE_UNAVAILABLE");
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(f.controls.commits, 0);
  });
}

for (const action of ["preview", "confirm"] as const) {
  for (const offset of [0, 1]) {
    test(`${action} crossing the candidate deadline at synthetic commit plus ${offset} rolls back every write`, async () => {
      const deadline = REVIEW_NOW + 1000;
      const f = fixture(deadline);
      const previewId = action === "confirm" ? success(await f.service.preview(draft())).id : null;
      const before = f.store.snapshot();
      const committedBefore = f.controls.commits;
      const rolledBackBefore = f.controls.rollbacks;
      f.controls.beforeCommit = () => { f.controls.now = deadline + offset; };
      const result = action === "preview" ? await f.service.preview(draft()) : await f.service.confirm(confirm(previewId!));
      failure(result, "REVIEW_STORE_UNAVAILABLE");
      assert.deepEqual(f.store.snapshot(), before);
      assert.equal(f.controls.commits, committedBefore);
      assert.equal(f.controls.rollbacks, rolledBackBefore + 1);
      assert.equal(f.store.rows.benefits.size, 0);
      assert.equal(f.store.rows.operations.size, 0);
      assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.state, "pending");
    });
  }
  test(`${action} may commit one millisecond before the candidate deadline`, async () => {
    const deadline = REVIEW_NOW + 1000;
    const f = fixture(deadline);
    const previewId = action === "confirm" ? success(await f.service.preview(draft())).id : null;
    f.controls.beforeCommit = () => { f.controls.now = deadline - 1; };
    if (action === "preview") {
      const result = success(await f.service.preview(draft()));
      assert.equal(result.expiresAt, deadline);
      assert.equal(f.store.rows.benefits.size, 0);
    } else {
      const result = success(await f.service.confirm(confirm(previewId!)));
      assert.equal(result.outcome, "saved");
      assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.state, "accepted");
    }
    assert.equal(f.controls.rollbacks, 0);
  });
}

test("a committed preview that expires during acknowledgement returns no payload without claiming rollback", async () => {
  const deadline = REVIEW_NOW + 1000;
  const f = fixture(deadline);
  f.controls.afterCommit = () => { f.controls.now = deadline; };
  failure(await f.service.preview(draft()), "REVIEW_PREVIEW_EXPIRED");
  assert.equal(f.controls.commits, 1);
  assert.equal(f.controls.rollbacks, 0);
  assert.equal(f.store.rows.previews.size, 1, "the synthetic transaction committed before the late response was blocked");
  const stored = [...f.store.rows.previews.values()][0]!;
  assert.equal(stored.expiresAt, deadline);
  assert.equal(stored.state, "pending");
  assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.state, "pending");
  assert.equal(f.store.rows.benefits.size, 0);
  assert.equal(f.store.rows.operations.size, 0);
});

test("an accepted benefit is not expired when its pending candidate deadline passes after commit", async () => {
  const deadline = REVIEW_NOW + 1000;
  const f = fixture(deadline);
  const view = success(await f.service.preview(draft()));
  f.controls.afterCommit = () => { f.controls.now = deadline; };
  const receipt = success(await f.service.confirm(confirm(view.id)));
  assert.equal(receipt.outcome, "saved");
  assert.equal(receipt.content!.reviewStatus, "accepted-by-user");
  assert.equal(f.controls.commits, 2);
  assert.equal(f.controls.rollbacks, 0);
  assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.state, "accepted");
  assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.expiresAt, deadline);
  assert.equal(f.store.rows.benefits.get(receipt.benefitId)!.state, "live");
  assert.equal(f.store.rows.previews.get(view.id)!.state, "consumed");
});

for (const offset of [0, 1]) {
  test(`an accepted benefit remains explicitly removable after candidate access expires plus ${offset}`, async () => {
    const deadline = REVIEW_NOW + 60000;
    const f = fixture(deadline);
    const view = success(await f.service.preview(draft()));
    const saved = success(await f.service.confirm(confirm(view.id)));
    f.controls.now = deadline + offset;
    assert.equal(f.store.rows.benefits.get(saved.benefitId)!.state, "live", "pending access expiry is not automatic benefit deletion");
    const request = { benefitId: saved.benefitId, expectedRevision: saved.benefitRevision,
      operationId: "synthetic-expiry-delete", decision: "delete" };
    const deleted = success(await f.service.remove(request));
    assert.equal(deleted.outcome, "deleted");
    assert.equal(deleted.content, null);
    assert.equal(deleted.replayed, false);
    assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.expiresAt, deadline);
    assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.state, "deleted");
    assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.content, null);
    assert.equal(f.store.rows.benefits.get(saved.benefitId)!.content, null);
    assert.equal(f.store.rows.previews.get(view.id)!.content, null);
    assert.equal(success(await f.service.remove(request)).replayed, true);
  });
}
