import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeReviewPreviewView } from "../src/domain/review-preview-view.ts";
import { createReviewPreviewDemoData, DEMO_PREVIEW_LIFETIME_MS, type ReviewPreviewDemoSample } from "../src/lib/review-preview-demo-data.ts";

const NOW = 1792281600000;
function frozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}

test("two public examples are strict immutable browser DTOs with different explicit IDs", () => {
  const original = createReviewPreviewDemoData("original", NOW, 1);
  const corrected = createReviewPreviewDemoData("corrected-zero", NOW, 2);
  for (const value of [original, corrected]) {
    assert.deepEqual(decodeReviewPreviewView(value), value); frozen(value);
    assert.equal(value.dataGeneration, 1); assert.equal(value.previewRevision, 1);
    assert.equal(value.content.reviewStatus, "pending-review");
    assert.equal(value.content.accountProof, "not-established"); assert.equal(value.content.currentBalanceProof, "not-established");
    assert.equal(value.content.evidenceAvailability, "not-retained");
  }
  assert.notEqual(original.previewId, corrected.previewId);
  assert.equal(original.content.values.remainingAmount, null);
  assert.equal(corrected.content.values.remainingAmount, 0);
  assert.equal(original.content.valueOrigins.remainingAmount, "email-extracted");
  assert.equal(corrected.content.valueOrigins.remainingAmount, "user-corrected");
});

test("only remaining amount and its origin change, never source observations or warnings", () => {
  const original = createReviewPreviewDemoData("original", NOW, 5);
  const corrected = createReviewPreviewDemoData("corrected-zero", NOW, 6);
  const expected = structuredClone(original);
  Object.assign(expected, { previewId: corrected.previewId });
  Object.assign(expected.content.values, { remainingAmount: 0 });
  Object.assign(expected.content.valueOrigins, { remainingAmount: "user-corrected" });
  assert.deepEqual(corrected, expected);
  for (const key of ["trialDaysStated", "remainingDaysStated", "expiresAt", "observedAt"] as const) {
    assert.equal(corrected.content.values[key], null);
  }
  assert.equal(corrected.content.sourceObservedAt, null); assert.equal(corrected.content.receivedAt, null);
  assert.equal(Object.keys(corrected.content.values).length, 9);
  assert.equal(Object.keys(corrected.content.valueOrigins).length, 9);
});

test("explicit reference time determines screen-only lifetime without ambient clocks", (t) => {
  t.mock.method(Date, "now", () => { throw Error("ambient time must not be read"); });
  const value = createReviewPreviewDemoData("original", NOW, 1);
  assert.equal(DEMO_PREVIEW_LIFETIME_MS, 10_000);
  assert.equal(value.expiresAt, NOW + 10_000);
  assert.equal(value.content.extractedAt, new Date(NOW).toISOString());
  assert.deepEqual(createReviewPreviewDemoData("original", NOW, 1), value);
});

for (const referenceTime of [0, 1, 253402300799999 - DEMO_PREVIEW_LIFETIME_MS]) {
  test(`explicit timestamp boundary remains canonical: ${referenceTime}`, () => {
    const value = createReviewPreviewDemoData("original", referenceTime, Number.MAX_SAFE_INTEGER);
    assert.ok(decodeReviewPreviewView(value));
    assert.equal(value.expiresAt, referenceTime + DEMO_PREVIEW_LIFETIME_MS);
  });
}

for (const referenceTime of [-0, -1, 1.5, NaN, Infinity, 253402300799999 - DEMO_PREVIEW_LIFETIME_MS + 1, "0", null]) {
  test(`invalid timestamp cannot invent or repair a clock: ${String(referenceTime)}`, () => {
    assert.throws(() => createReviewPreviewDemoData("original", referenceTime as number, 1),
      { message: "REVIEW_PREVIEW_DEMO_INPUT_INVALID" });
  });
}

for (const sequence of [0, -0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
  test(`invalid sequence never generates fallback identity: ${String(sequence)}`, () => {
    assert.throws(() => createReviewPreviewDemoData("original", NOW, sequence as number),
      { message: "REVIEW_PREVIEW_DEMO_INPUT_INVALID" });
  });
}

test("only fixed samples are accepted without coercing an arbitrary object", () => {
  let calls = 0;
  for (const sample of ["", "ORIGINAL", "corrected", null, { toString() { calls++; return "original"; } }]) {
    assert.throws(() => createReviewPreviewDemoData(sample as ReviewPreviewDemoSample, NOW, 1),
      { message: "REVIEW_PREVIEW_DEMO_INPUT_INVALID" });
  }
  assert.equal(calls, 0);
});

test("required uncertainty is retained without server or source bindings", () => {
  const example = createReviewPreviewDemoData("corrected-zero", NOW, 1);
  assert.deepEqual(example.content.reviewReasons, ["USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF",
    "EXPIRY_CONFIRMATION_NEEDED", "RECEIVED_DATE_UNKNOWN", "OBSERVATION_DATE_UNKNOWN"]);
  const text = JSON.stringify(example);
  for (const key of ["ownerId", "sessionId", "candidateId", "candidateRevision", "mailboxBindingId", "analysisOperationId",
    "operationId", "body", "quote", "source"]) assert.equal(text.includes(`"${key}"`), false, key);
});

test("demo data imports no server, changes no server TTL and performs no ambient I/O", () => {
  const source = readFileSync(new URL("../src/lib/review-preview-demo-data.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:server|node:|provider|vault)[^"']*["']/);
  assert.doesNotMatch(source, /\b(?:fetch|localStorage|sessionStorage|indexedDB|XMLHttpRequest|Worker|Date\.now)\s*[.(]/);
  assert.doesNotMatch(source, /PREVIEW_TTL_MS/);
});
