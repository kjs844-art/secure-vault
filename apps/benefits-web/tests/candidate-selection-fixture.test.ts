import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCandidateBatchDisplay } from "../src/domain/candidate-batch-view.ts";
import { createServiceCatalog } from "../src/server/catalog/service-catalog.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import type { ReviewResult } from "../src/server/review/contracts.ts";
import { createCandidateSelectionFixture } from "./support/candidate-selection-fixture.ts";
import { REVIEW_NOW, analysisAuthority } from "./support/review-memory-store.ts";

// Real server controller composition, not real provider/auth/DB/browser evidence.
function success<T>(result: ReviewResult<T>): T {
  assert.ok(result.ok, result.ok ? undefined : result.code);
  return result.value;
}
function frozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozenTree(child);
}

test("unseeded catalog still completes the real synthetic analysis and permits one explicit service creation", async () => {
  const fixture = await createCandidateSelectionFixture(REVIEW_NOW, 86400000, () => "synthetic-empty-catalog-batch", false);
  assert.equal(fixture.store.rows.services.size, 0);
  assert.equal(fixture.store.rows.catalogOperations.size, 0);
  assert.deepEqual(fixture.services, []);
  assert.equal(fixture.batch.candidates.length, 2);
  assert.deepEqual(fixture.readAnalysisCounts(), { quota: 1, mailbox: 1, analysis: 1 });
  assert.equal(fixture.completionReceipt.batchReference, "synthetic-empty-catalog-batch");
  const catalog = createServiceCatalog(fixture.store.catalogDependencies);
  const created = success(await catalog.create({ operationId: "synthetic-first-explicit-service", decision: "create",
    profile: { name: "First synthetic service", provider: null, planName: null, accountLabel: null,
      timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null } }));
  assert.equal(created.replayed, false);
  assert.equal(created.service.accountProof, "not-established");
  assert.equal(fixture.store.rows.services.size, 1);
  assert.equal(fixture.store.rows.catalogOperations.size, 1);
  assert.equal(fixture.store.rows.benefits.size, 0);
  assert.deepEqual(await fixture.refresh(), fixture.batch);
  assert.deepEqual(fixture.readAnalysisCounts(), { quota: 1, mailbox: 1, analysis: 1 });
});

test("fixture seed mode rejects truthy non-booleans rather than silently seeding services", async () => {
  await assert.rejects(createCandidateSelectionFixture(REVIEW_NOW, 86400000, undefined, "false" as unknown as boolean),
    { message: "CANDIDATE_SELECTION_FIXTURE_SEED_INVALID" });
});

test("actual runner handoff stages two distinct candidates and creates two live catalog services", async () => {
  const fixture = await createCandidateSelectionFixture();
  const [first, second] = fixture.batch.candidates;
  assert.ok(first?.state === "pending" && second?.state === "pending");
  assert.equal(first.content.values.name, null);
  assert.equal(first.content.values.remainingAmount, null);
  assert.equal(first.content.values.grantedAmount, 100);
  assert.equal(second.content.values.name, "Synthetic trial offer");
  assert.equal(second.content.values.trialDaysStated, 14);
  assert.notEqual(first.candidateId, second.candidateId);
  assert.deepEqual(fixture.services.map((service) => service.profile?.name), ["Synthetic Service", "Synthetic Service Plus"]);
  assert.notEqual(fixture.services[0]!.serviceId, fixture.services[1]!.serviceId);
  for (const service of fixture.services) {
    assert.equal(service.state, "live");
    assert.equal(service.serviceRevision, 1);
    assert.equal(service.provenance, "user-reported");
    assert.equal(service.accountProof, "not-established");
  }
  assert.equal(fixture.store.rows.candidates.size, 2);
  assert.equal(fixture.store.rows.services.size, 2);
  assert.equal(fixture.store.rows.batches.size, 1);
  assert.equal(fixture.store.rows.catalogOperations.size, 2);
  assert.equal(fixture.store.rows.benefits.size, 0);
  assert.equal(fixture.store.controls.trace.filter((entry) => entry === "insertCandidate").length, 2);
  assert.ok(fixture.store.controls.trace.includes("requireCandidateStaging"));
  assert.ok(fixture.store.controls.trace.includes("getCandidateBatch"));
  assert.ok(Object.isFrozen(fixture));
  frozenTree(fixture.batch); frozenTree(fixture.services);
});

test("only minimal projected batch/services are browser inputs, with private source data excluded", async () => {
  const fixture = await createCandidateSelectionFixture();
  const browserInput = { batch: fixture.batch, services: fixture.services };
  const serialized = JSON.stringify(browserInput);
  for (const excluded of ["analysisOperationId", "mailboxBindingId", "candidateIndex", "ownerId", "sessionId",
    "grantId", "fingerprint", '"quote"', '"evidence"', "synthetic-analysis-operation", "synthetic-mailbox",
    "synthetic-selection-mail-not-retained", "Synthetic Service grants 100 credits.",
    "Synthetic Service Plus offers Synthetic trial offer for 14 days."]) {
    assert.ok(!serialized.includes(excluded), `excluded field/marker: ${excluded}`);
  }
  assert.deepEqual(decodeCandidateBatchDisplay(JSON.parse(JSON.stringify(fixture.batch)) as unknown), fixture.batch);
  assert.deepEqual(Object.keys(fixture.batch).sort(), ["candidates", "dataGeneration", "schema"]);
  const before = fixture.store.snapshot();
  const forgedHandoff = await fixture.inbox.stage(JSON.parse(JSON.stringify(fixture.batch)) as unknown);
  assert.deepEqual(forgedHandoff, { ok: false, code: "REVIEW_INPUT_INVALID" });
  assert.deepEqual(fixture.store.snapshot(), before);
});

test("missing name needs a user value; explicit confirm binds the chosen similar service and refresh hides accepted content", async () => {
  const fixture = await createCandidateSelectionFixture();
  const first = fixture.batch.candidates[0]!, other = fixture.batch.candidates[1]!;
  assert.equal(first.state, "pending");
  assert.ok(first.content);
  const selected = fixture.services[1]!;
  const review = createReviewService(fixture.store.dependencies);
  const base = { candidateId: first.candidateId, candidateRevision: first.candidateRevision,
    serviceId: selected.serviceId, serviceRevision: selected.serviceRevision };
  const before = fixture.store.snapshot();
  assert.deepEqual(await review.preview({ ...base, values: first.content.values }), { ok: false, code: "REVIEW_INPUT_INVALID" });
  assert.deepEqual(fixture.store.snapshot(), before);
  const preview = success(await review.preview({ ...base,
    values: { ...first.content.values, name: "사용자가 정한 합성 혜택", remainingAmount: 0 } }));
  assert.equal(fixture.store.rows.benefits.size, 0);
  const saved = success(await review.confirm({ previewId: preview.id, operationId: "synthetic-selection-confirm", decision: "confirm" }));
  assert.equal(saved.content?.serviceId, selected.serviceId);
  assert.equal(saved.content?.serviceNameAtReview, "Synthetic Service Plus");
  assert.equal(saved.content?.values.remainingAmount, 0);
  assert.equal(saved.content?.valueOrigins.name, "user-corrected");
  assert.equal(saved.content?.valueOrigins.remainingAmount, "user-corrected");
  assert.equal(saved.content?.source.values.name, null);
  assert.equal(saved.content?.source.values.remainingAmount, null);
  const refreshed = await fixture.refresh();
  assert.deepEqual(refreshed.candidates[0], { candidateId: first.candidateId,
    candidateRevision: first.candidateRevision + 1, state: "accepted", accessExpiresAt: first.accessExpiresAt, content: null });
  assert.deepEqual(refreshed.candidates[1], other);
  assert.equal(first.state, "pending", "previous browser observation is not silently mutated");
  frozenTree(refreshed);
  const removed = success(await review.remove({ benefitId: saved.benefitId, expectedRevision: saved.benefitRevision,
    operationId: "synthetic-selection-remove", decision: "delete" }));
  assert.equal(removed.outcome, "deleted");
  const afterDelete = await fixture.refresh();
  assert.equal(afterDelete.candidates[0]!.state, "deleted");
  assert.equal(afterDelete.candidates[0]!.content, null);
  assert.deepEqual(afterDelete.candidates[1], other);
});

test("service revision changes require reselection instead of accepting a stale service observation", async () => {
  const fixture = await createCandidateSelectionFixture();
  const candidate = fixture.batch.candidates[1]!, old = fixture.services[0]!;
  assert.ok(candidate.content && old.profile);
  const catalog = createServiceCatalog(fixture.store.catalogDependencies);
  const updated = success(await catalog.update({ serviceId: old.serviceId, expectedRevision: old.serviceRevision,
    operationId: "synthetic-selection-rename", decision: "update", profile: { ...old.profile, name: "Synthetic Service renamed" } })).service;
  const review = createReviewService(fixture.store.dependencies);
  const draft = { candidateId: candidate.candidateId, candidateRevision: candidate.candidateRevision,
    serviceId: old.serviceId, serviceRevision: old.serviceRevision, values: candidate.content.values };
  assert.deepEqual(await review.preview(draft), { ok: false, code: "REVIEW_CONFLICT" });
  assert.equal(fixture.store.rows.previews.size, 0);
  const preview = success(await review.preview({ ...draft, serviceRevision: updated.serviceRevision }));
  assert.equal(preview.content.serviceName, "Synthetic Service renamed");
  assert.equal(fixture.store.rows.benefits.size, 0);
});

test("explicit current epoch consistently moves session, analysis/staging deadlines and extracted times", async () => {
  const now = Date.parse("2026-10-18T12:34:56.789Z");
  const fixture = await createCandidateSelectionFixture(now);
  const first = fixture.batch.candidates[0]!;
  assert.ok(first.content);
  assert.equal(first.content.extractedAt, new Date(now).toISOString());
  assert.equal(first.accessExpiresAt, now + 86400000);
  assert.equal(fixture.services[0]!.createdAt, now);
  assert.equal(fixture.store.controls.now, now);
  fixture.store.controls.now = now + 1000;
  assert.deepEqual(await fixture.refresh(), fixture.batch);
});

test("refresh uses current app authority, without asking mailbox/analysis/staging permission again", async () => {
  const fixture = await createCandidateSelectionFixture(REVIEW_NOW);
  const checks = fixture.store.controls.analysisChecks, grants = fixture.store.controls.stagingGrantReads;
  fixture.store.controls.analysisAuthority = null;
  fixture.store.controls.stagingGrant = null;
  assert.deepEqual(await fixture.refresh(), fixture.batch);
  assert.equal(fixture.store.controls.analysisChecks, checks);
  assert.equal(fixture.store.controls.stagingGrantReads, grants);
  fixture.store.controls.authority = null;
  await assert.rejects(fixture.refresh(), { message: "CANDIDATE_SELECTION_FIXTURE_REVIEW_AUTH_REQUIRED" });
  assert.equal(fixture.store.rows.batches.size, 1);
  assert.equal(fixture.store.rows.batches.values().next().value?.analysisOperationId, analysisAuthority().operationId);
});

for (const now of [NaN, Infinity, -1, -0, REVIEW_NOW + 0.5, 253402214400000]) {
  test(`fixture refuses invalid/out-of-deadline-range epoch ${String(now)}`, async () => {
    await assert.rejects(createCandidateSelectionFixture(now), { message: "CANDIDATE_SELECTION_FIXTURE_CLOCK_INVALID" });
  });
}

test("a shorter explicit staging grant creates immutable matching batch/candidate deadlines before stage", async () => {
  const fixture = await createCandidateSelectionFixture(REVIEW_NOW, 2000);
  assert.ok(fixture.store.controls.trace.includes("requireCandidateStaging"));
  assert.equal(fixture.store.rows.batches.values().next().value?.pendingAccessUntil, REVIEW_NOW + 2000);
  for (const row of fixture.store.rows.candidates.values()) assert.equal(row.expiresAt, REVIEW_NOW + 2000);
  fixture.store.controls.now = REVIEW_NOW + 1999;
  assert.ok((await fixture.refresh()).candidates.every((row) => row.state === "pending"));
  fixture.store.controls.now = REVIEW_NOW + 2000;
  assert.ok((await fixture.refresh()).candidates.every((row) => row.state === "expired" && row.content === null));
  assert.ok([...fixture.store.rows.candidates.values()].every((row) => row.state === "pending" && row.content !== null));
});
for (const window of [0, -1, NaN, Infinity, 0.5, 86400001]) {
  test(`fixture rejects invalid pending window ${String(window)}`, async () => {
    await assert.rejects(createCandidateSelectionFixture(REVIEW_NOW, window), { message: "CANDIDATE_SELECTION_FIXTURE_WINDOW_INVALID" });
  });
}
