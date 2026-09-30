import { decodeReviewedBenefitView, REVIEWED_BENEFIT_VIEW_SCHEMA, type ReviewedBenefitView } from "../../domain/reviewed-benefit-view";
import { REVIEW_SCHEMA, type ReviewReceipt } from "./contracts";

/**
 * Trusted internal receipt projection only, never authentication or a public
 * receipt validator. Call AFTER the service/adapter verifies the current owner.
 * These labels and reviewed values may still be personal; projection is not
 * anonymization. It supplies no live balance, account status, provider or UI link.
 */
export function projectReviewReceipt(receipt: ReviewReceipt): ReviewedBenefitView {
  try {
    if (receipt.schema !== REVIEW_SCHEMA) throw new Error("REVIEW_PRESENTATION_INVALID");
    const source = receipt.content;
    if ((receipt.outcome === "saved" && source === null) || (receipt.outcome === "deleted" && source !== null)) {
      throw new Error("REVIEW_PRESENTATION_INVALID");
    }
    const projected = decodeReviewedBenefitView({
      schema: REVIEWED_BENEFIT_VIEW_SCHEMA, dataGeneration: receipt.dataGeneration,
      benefitId: receipt.benefitId, benefitRevision: receipt.benefitRevision, outcome: receipt.outcome,
      content: source === null ? null : {
        serviceId: source.serviceId, serviceNameAtReview: source.serviceNameAtReview,
        values: {
          name: source.values.name, kind: source.values.kind, unit: source.values.unit,
          grantedAmount: source.values.grantedAmount, remainingAmount: source.values.remainingAmount,
          trialDaysStated: source.values.trialDaysStated, remainingDaysStated: source.values.remainingDaysStated,
          expiresAt: source.values.expiresAt, observedAt: source.values.observedAt,
        },
        valueOrigins: {
          name: source.valueOrigins.name, kind: source.valueOrigins.kind, unit: source.valueOrigins.unit,
          grantedAmount: source.valueOrigins.grantedAmount, remainingAmount: source.valueOrigins.remainingAmount,
          trialDaysStated: source.valueOrigins.trialDaysStated, remainingDaysStated: source.valueOrigins.remainingDaysStated,
          expiresAt: source.valueOrigins.expiresAt, observedAt: source.valueOrigins.observedAt,
        },
        receivedAt: source.source.receivedAt, extractedAt: source.source.extractedAt,
        sourceObservedAt: source.source.values.observedAt, reviewedAt: source.reviewedAt,
        reviewReasons: source.source.reviewReasons.map((reason) => reason), reviewStatus: source.reviewStatus,
        accountProof: source.accountProof, currentBalanceProof: source.currentBalanceProof,
      },
    });
    if (projected === null) throw new Error("REVIEW_PRESENTATION_INVALID");
    return projected;
  } catch {
    throw new Error("REVIEW_PRESENTATION_INVALID");
  }
}
