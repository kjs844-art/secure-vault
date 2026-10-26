import { decodeReviewPreviewView, REVIEW_PREVIEW_VIEW_SCHEMA, type ReviewPreviewView } from "../../domain/review-preview-view";
import { REVIEW_SCHEMA, type PreviewView } from "./contracts";

const VALUE_KEYS = ["name", "kind", "unit", "grantedAmount", "remainingAmount", "trialDaysStated",
  "remainingDaysStated", "expiresAt", "observedAt"] as const;

/**
 * Trusted internal preview AFTER createReviewService's authority/expiry guards.
 * Not an input validator, fresh authorization check, clock or saved receipt.
 * No owner/session/candidate/mailbox/analysis identifiers leave this projection.
 * Names, values and the remaining IDs can still be personal, not anonymized.
 */
export function projectReviewPreview(preview: PreviewView): ReviewPreviewView {
  try {
    const { content } = preview;
    const source = content.source;
    if (source.schema !== REVIEW_SCHEMA || source.evidenceAvailability !== "not-retained") throw new Error();
    const projected = decodeReviewPreviewView({
      schema: REVIEW_PREVIEW_VIEW_SCHEMA, dataGeneration: preview.dataGeneration,
      previewId: preview.id, previewRevision: preview.revision, expiresAt: preview.expiresAt,
      content: {
        serviceId: content.serviceId, serviceRevision: content.serviceRevision, serviceName: content.serviceName,
        values: {
          name: content.values.name, kind: content.values.kind, unit: content.values.unit,
          grantedAmount: content.values.grantedAmount, remainingAmount: content.values.remainingAmount,
          trialDaysStated: content.values.trialDaysStated, remainingDaysStated: content.values.remainingDaysStated,
          expiresAt: content.values.expiresAt, observedAt: content.values.observedAt,
        },
        valueOrigins: Object.fromEntries(VALUE_KEYS.map((key) => [key,
          content.values[key] === source.values[key] ? "email-extracted" : "user-corrected",
        ])),
        receivedAt: source.receivedAt, extractedAt: source.extractedAt, sourceObservedAt: source.values.observedAt,
        reviewReasons: source.reviewReasons.map((reason) => reason), evidenceAvailability: source.evidenceAvailability,
        reviewStatus: "pending-review", accountProof: preview.accountProof, currentBalanceProof: preview.currentBalanceProof,
      },
    });
    if (projected === null) throw new Error();
    return projected;
  } catch { throw new Error("REVIEW_PREVIEW_PRESENTATION_INVALID"); }
}
