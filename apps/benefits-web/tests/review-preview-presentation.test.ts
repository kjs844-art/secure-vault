import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeReviewPreviewView, REVIEW_PREVIEW_VIEW_SCHEMA } from "../src/domain/review-preview-view.ts";
import { projectReviewPreview } from "../src/server/review/preview-presentation.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import { PREVIEW_TTL_MS, type PreviewView, type ReviewValues } from "../src/server/review/contracts.ts";
import { CANDIDATE_ID, REVIEW_NOW, SERVICE_ID, candidateContent, createReviewMemoryStore, reviewAuthority, reviewValues } from "./support/review-memory-store.ts";

const VALUE_KEYS = ["name", "kind", "unit", "grantedAmount", "remainingAmount", "trialDaysStated",
  "remainingDaysStated", "expiresAt", "observedAt"] as const;
function internal(values: Partial<ReviewValues> = {}): PreviewView {
  return { id: "synthetic-preview", dataGeneration: 7, revision: 1, expiresAt: REVIEW_NOW + PREVIEW_TTL_MS,
    content: { candidateId: CANDIDATE_ID, candidateRevision: 1, serviceId: SERVICE_ID, serviceRevision: 3,
      serviceName: "합성 서비스 😀", values: reviewValues(values), source: candidateContent() },
    accountProof: "not-established", currentBalanceProof: "not-established" };
}
function frozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}
function draft(values = reviewValues()) {
  return { candidateId: CANDIDATE_ID, candidateRevision: 1, serviceId: SERVICE_ID, serviceRevision: 1, values };
}

test("preview projection excludes internal bindings and exposes exact frozen pending-review fields", () => {
  const input = internal({ remainingAmount: 0 });
  const result = projectReviewPreview(input);
  assert.deepEqual(Object.keys(result).sort(), ["schema", "dataGeneration", "previewId", "previewRevision", "expiresAt", "content"].sort());
  assert.deepEqual(Object.keys(result.content).sort(), ["serviceId", "serviceRevision", "serviceName", "values", "valueOrigins", "receivedAt",
    "extractedAt", "sourceObservedAt", "reviewReasons", "evidenceAvailability", "reviewStatus", "accountProof", "currentBalanceProof"].sort());
  assert.equal(result.schema, REVIEW_PREVIEW_VIEW_SCHEMA); assert.equal(result.previewId, input.id);
  assert.equal(result.dataGeneration, 7); assert.equal(result.previewRevision, 1); assert.equal(result.expiresAt, input.expiresAt);
  assert.equal(result.content.values.remainingAmount, 0); assert.equal(result.content.values.observedAt, null);
  assert.equal(result.content.receivedAt, null); assert.equal(result.content.sourceObservedAt, null);
  assert.equal(result.content.valueOrigins.remainingAmount, "user-corrected");
  assert.equal(result.content.reviewStatus, "pending-review"); assert.equal(result.content.evidenceAvailability, "not-retained");
  assert.equal(result.content.accountProof, "not-established"); assert.equal(result.content.currentBalanceProof, "not-established");
  const serialized = JSON.stringify(result);
  for (const key of ["ownerId", "sessionId", "sessionRevision", "candidateId", "candidateRevision", "candidateIndex", "analysisOperationId",
    "mailboxBindingId", "operationId", "source", "extractionConfidence", "quote", "body", "fingerprint", "policyVersion"]) {
    assert.ok(!serialized.includes(`"${key}"`), key);
  }
  for (const value of [input.content.candidateId, input.content.source.analysisOperationId, input.content.source.mailboxBindingId]) {
    assert.ok(!serialized.includes(value), value);
  }
  frozen(result);
  assert.notEqual(result.content.values, input.content.values); assert.notEqual(result.content.reviewReasons, input.content.source.reviewReasons);
  assert.deepEqual(decodeReviewPreviewView(JSON.parse(serialized)), result);
});

test("the explicit values/origins allowlist matches all nine current review contract keys", () => {
  const result = projectReviewPreview(internal());
  assert.deepEqual([...VALUE_KEYS].sort(), Object.keys(reviewValues()).sort());
  assert.deepEqual(Object.keys(result.content.values).sort(), [...VALUE_KEYS].sort());
  assert.deepEqual(Object.keys(result.content.valueOrigins).sort(), [...VALUE_KEYS].sort());
  assert.ok(Object.values(result.content.valueOrigins).every((origin) => origin === "email-extracted"));
});

test("each corrected field retains its origin without replacing original observations", () => {
  const input = internal({ name: "선택한 합성 이름", kind: "point", unit: "points", grantedAmount: 0,
    remainingAmount: 0, trialDaysStated: 7, remainingDaysStated: 0, expiresAt: "2026-12-31", observedAt: "2026-09-27T10:20:30.123456789+09:00" });
  const result = projectReviewPreview(input);
  assert.ok(Object.values(result.content.valueOrigins).every((origin) => origin === "user-corrected"));
  assert.deepEqual(result.content.values, input.content.values);
  assert.equal(result.content.sourceObservedAt, null);
  assert.ok(result.content.reviewReasons.includes("OBSERVATION_DATE_UNKNOWN"));
});

test("original offset/day precision, null source name and partial-mail warning are not rewritten", () => {
  const input = internal({ observedAt: "2026-09-27" });
  Object.assign(input.content, { source: candidateContent({ values: { ...reviewValues(), name: null,
    observedAt: "2026-09-26T10:00:00.120+09:00" }, reviewReasons: [...candidateContent().reviewReasons, "PARTIAL_MAIL_TEXT"] }) });
  const result = projectReviewPreview(input);
  assert.equal(result.content.values.observedAt, "2026-09-27");
  assert.equal(result.content.sourceObservedAt, "2026-09-26T10:00:00.120+09:00");
  assert.equal(result.content.valueOrigins.name, "user-corrected");
  assert.equal(result.content.valueOrigins.observedAt, "user-corrected");
  assert.ok(result.content.reviewReasons.includes("PARTIAL_MAIL_TEXT"));
});

test("detached projection never changes when a trusted caller later changes its mutable fixture", () => {
  const input = internal(); const before = structuredClone(input); const result = projectReviewPreview(input);
  assert.deepEqual(input, before);
  Object.assign(input.content.values, { name: "Changed", observedAt: "2026-10-18" });
  Object.assign(input.content, { serviceName: "Changed", source: candidateContent({ reviewReasons: [] }) });
  assert.equal(result.content.values.name, before.content.values.name);
  assert.equal(result.content.values.observedAt, null); assert.equal(result.content.serviceName, before.content.serviceName);
  assert.equal(result.content.reviewReasons.length, 5);
});

test("projection emits one fixed error for malformed internal data, never adapter text or a saved receipt", () => {
  const inputs: unknown[] = [null, {}, { outcome: "saved", content: null },
    { ...internal(), dataGeneration: undefined }, { ...internal(), revision: 2 }, { ...internal(), expiresAt: -0 },
    { ...internal(), accountProof: "verified" }, { ...internal(), currentBalanceProof: "verified" }];
  const badSource = internal(); Object.assign(badSource.content.source, { schema: "unknown", evidenceAvailability: "retained" }); inputs.push(badSource);
  const throwing = internal(); Object.defineProperty(throwing.content, "source", { get() { throw Error("SYNTHETIC_PRIVATE_EXCEPTION"); } }); inputs.push(throwing);
  for (const input of inputs) {
    assert.throws(() => projectReviewPreview(input as PreviewView), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message, "REVIEW_PREVIEW_PRESENTATION_INVALID");
      assert.equal(error.cause, undefined); return true;
    });
  }
});

test("projection does not claim current authority, recheck expiry or consume the preview", () => {
  const input = internal(); Object.assign(input, { expiresAt: 0 });
  const result = projectReviewPreview(input);
  assert.equal(result.expiresAt, 0); assert.equal(result.content.reviewStatus, "pending-review");
  // Trusted service guards and the eventual consumer own freshness; decode is format-only.
});

test("real review.preview -> projection carries server generation and does not create a benefit", async () => {
  const store = createReviewMemoryStore();
  store.controls.authority = reviewAuthority({ dataGeneration: 9 });
  for (const row of store.rows.candidates.values()) Object.assign(row, { dataGeneration: 9 });
  for (const row of store.rows.services.values()) Object.assign(row, { dataGeneration: 9 });
  const service = createReviewService(store.dependencies);
  const result = await service.preview(draft(reviewValues({ name: "합성 사용자 수정", remainingAmount: 0 })));
  assert.ok(result.ok);
  const projected = projectReviewPreview(result.value);
  assert.equal(projected.dataGeneration, 9); assert.equal(projected.previewId, result.value.id);
  assert.equal(projected.expiresAt, REVIEW_NOW + PREVIEW_TTL_MS);
  assert.equal(projected.content.serviceRevision, 1);
  assert.equal(projected.content.valueOrigins.name, "user-corrected");
  assert.equal(projected.content.valueOrigins.remainingAmount, "user-corrected");
  assert.equal(store.rows.benefits.size, 0); assert.equal(store.rows.operations.size, 0);
  assert.equal(store.rows.previews.get(projected.previewId)?.state, "pending");
  assert.deepEqual(projected.content.values, store.rows.previews.get(projected.previewId)?.content?.values);
  const confirmation = await service.confirm({ previewId: projected.previewId, operationId: "synthetic-preview-view-confirm", decision: "confirm" });
  assert.ok(confirmation.ok); assert.deepEqual(confirmation.value.content?.values, projected.content.values);
  assert.equal(confirmation.value.content?.accountProof, "not-established");
  assert.equal(projected.content.reviewStatus, "pending-review"); // Retained views are not auto-updated or revoked.
});

test("new edited previews keep distinct IDs while the old displayed snapshot stays immutable", async () => {
  const store = createReviewMemoryStore(); const service = createReviewService(store.dependencies);
  const first = await service.preview(draft()); assert.ok(first.ok);
  const shown = projectReviewPreview(first.value);
  const next = await service.preview(draft(reviewValues({ remainingAmount: 0 }))); assert.ok(next.ok);
  const replacement = projectReviewPreview(next.value);
  assert.notEqual(shown.previewId, replacement.previewId);
  assert.equal(shown.content.values.remainingAmount, null); assert.equal(replacement.content.values.remainingAmount, 0);
  assert.equal(shown.previewRevision, 1); assert.equal(replacement.previewRevision, 1);
  const confirmed = await service.confirm({ previewId: shown.previewId, operationId: "synthetic-original-preview-confirm", decision: "confirm" });
  assert.ok(confirmed.ok); assert.equal(confirmed.value.content?.values.remainingAmount, null);
});

test("server expiry and authority failure remain failures, with no projection or rollback claim", async () => {
  for (const kind of ["expiry", "authority"] as const) {
    const store = createReviewMemoryStore(); const service = createReviewService(store.dependencies);
    store.controls.afterCommit = () => {
      if (kind === "expiry") store.controls.now = REVIEW_NOW + PREVIEW_TTL_MS;
      else store.controls.authority = reviewAuthority({ dataGeneration: 2 });
    };
    const result = await service.preview(draft());
    assert.ok(!result.ok);
    assert.equal(result.code, kind === "expiry" ? "REVIEW_PREVIEW_EXPIRED" : "REVIEW_AUTHORITY_CHANGED");
    assert.equal(store.rows.previews.size, 1); assert.equal(store.controls.commits, 1); assert.equal(store.controls.rollbacks, 0);
  }
});
