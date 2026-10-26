import { decodeReviewedBenefitPage, REVIEWED_BENEFIT_PAGE_SCHEMA, type ReviewedBenefitPageView } from "../domain/reviewed-benefit-page";
import { REVIEWED_BENEFIT_VIEW_SCHEMA } from "../domain/reviewed-benefit-view";

const DAY = 86_400_000;
export const REVIEWED_LIST_DEMO_LAST_FIRST_PAGE_ID = "synthetic-list-049";
export const REVIEWED_LIST_DEMO_REVISION = 54;

/** Public synthetic records only; no service, user input, token or persistence. */
export function createReviewedBenefitListDemoPage(page: "first" | "last", referenceMs: number): ReviewedBenefitPageView {
  if ((page !== "first" && page !== "last") || !Number.isSafeInteger(referenceMs)
    || referenceMs < DAY || referenceMs > 253402300799999 - DAY) throw Error("SYNTHETIC_LIST_INVALID");
  const observed = new Date(referenceMs).toISOString();
  const expired = new Date(referenceMs - DAY).toISOString(), future = new Date(referenceMs + DAY).toISOString();
  const start = page === "first" ? 0 : 50, length = page === "first" ? 50 : 3;
  const benefits = Array.from({ length }, (_, offset) => {
    const index = start + offset;
    const values = { name: index < 50 ? `지난 합성 혜택 ${index + 1}` : ["만료일 모름 예시", "날짜만 있는 예시", "미래 만료 예시"][index - 50],
      kind: "credit", unit: "credits", grantedAmount: 100, remainingAmount: index === 50 ? null : 0,
      trialDaysStated: null, remainingDaysStated: null,
      expiresAt: index < 50 ? expired : index === 50 ? null : index === 51 ? expired.slice(0, 10) : future,
      observedAt: null };
    return { schema: REVIEWED_BENEFIT_VIEW_SCHEMA, dataGeneration: 1, benefitId: `synthetic-list-${String(index).padStart(3, "0")}`,
      benefitRevision: 1, outcome: "saved", content: { serviceId: "synthetic-list-service", serviceNameAtReview: "합성 서비스",
        values, valueOrigins: Object.fromEntries(Object.keys(values).map((key) => [key, "email-extracted"])),
        receivedAt: null, extractedAt: observed, sourceObservedAt: null, reviewedAt: observed,
        reviewReasons: ["USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED",
          "RECEIVED_DATE_UNKNOWN", "OBSERVATION_DATE_UNKNOWN"],
        reviewStatus: "accepted-by-user", accountProof: "not-established", currentBalanceProof: "not-established" } };
  });
  const result = decodeReviewedBenefitPage({ schema: REVIEWED_BENEFIT_PAGE_SCHEMA, dataGeneration: 1,
    benefitCollectionRevision: REVIEWED_LIST_DEMO_REVISION, benefits,
    nextCursor: page === "last" ? null : { afterId: REVIEWED_LIST_DEMO_LAST_FIRST_PAGE_ID,
      benefitCollectionRevision: REVIEWED_LIST_DEMO_REVISION, dataGeneration: 1 } });
  if (!result) throw Error("SYNTHETIC_LIST_INVALID");
  return result;
}
