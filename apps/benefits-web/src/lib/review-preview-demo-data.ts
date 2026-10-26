import { decodeReviewPreviewView, REVIEW_PREVIEW_VIEW_SCHEMA, type ReviewPreviewView } from "../domain/review-preview-view";

/** Screen-only demonstration duration, NOT the review service's five-minute TTL. */
export const DEMO_PREVIEW_LIFETIME_MS = 10_000;
export type ReviewPreviewDemoSample = "original" | "corrected-zero";
const VALUE_KEYS = ["name", "kind", "unit", "grantedAmount", "remainingAmount", "trialDaysStated",
  "remainingDaysStated", "expiresAt", "observedAt"] as const;

/** Public fixed examples only. No user input, mailbox, clock, ID generation or storage. */
export function createReviewPreviewDemoData(
  sample: ReviewPreviewDemoSample, referenceTime: number, sequence: number,
): ReviewPreviewView {
  if ((sample !== "original" && sample !== "corrected-zero")
    || typeof referenceTime !== "number" || !Number.isSafeInteger(referenceTime)
    || Object.is(referenceTime, -0) || referenceTime < 0 || referenceTime > 253402300799999 - DEMO_PREVIEW_LIFETIME_MS
    || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("REVIEW_PREVIEW_DEMO_INPUT_INVALID");
  }
  const corrected = sample === "corrected-zero";
  const result = decodeReviewPreviewView({
    schema: REVIEW_PREVIEW_VIEW_SCHEMA, dataGeneration: 1,
    previewId: `synthetic-review-preview:${sequence}`, previewRevision: 1,
    expiresAt: referenceTime + DEMO_PREVIEW_LIFETIME_MS,
    content: {
      serviceId: "synthetic-preview-service", serviceRevision: 1, serviceName: "합성 예시 서비스",
      values: {
        name: "합성 크레딧 안내", kind: "credit", unit: "credits", grantedAmount: 20,
        remainingAmount: corrected ? 0 : null, trialDaysStated: null, remainingDaysStated: null,
        expiresAt: null, observedAt: null,
      },
      valueOrigins: Object.fromEntries(VALUE_KEYS.map((key) => [key,
        corrected && key === "remainingAmount" ? "user-corrected" : "email-extracted"])),
      receivedAt: null, extractedAt: new Date(referenceTime).toISOString(), sourceObservedAt: null,
      reviewReasons: ["USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED",
        "RECEIVED_DATE_UNKNOWN", "OBSERVATION_DATE_UNKNOWN"],
      evidenceAvailability: "not-retained", reviewStatus: "pending-review",
      accountProof: "not-established", currentBalanceProof: "not-established",
    },
  });
  if (result === null) throw new Error("REVIEW_PREVIEW_DEMO_INPUT_INVALID");
  return result;
}
