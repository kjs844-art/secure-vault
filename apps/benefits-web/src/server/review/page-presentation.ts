import {
  decodeReviewedBenefitPage, MAX_REVIEWED_BENEFIT_PAGE_ROWS, REVIEWED_BENEFIT_PAGE_SCHEMA,
  type ReviewedBenefitPageView,
} from "../../domain/reviewed-benefit-page";
import { REVIEW_SCHEMA, type ReviewedBenefitPage } from "./contracts";
import { projectReviewedBenefit } from "./presentation";

/**
 * Trusted successful service snapshot only, AFTER owner/authority checks.
 * Not an auth validator, anonymizer, or durable/full-list freshness proof.
 * No source/candidate/mailbox/operation bindings cross this projection.
 */
export function projectReviewedBenefitPage(page: ReviewedBenefitPage): ReviewedBenefitPageView {
  try {
    if (page.schema !== REVIEW_SCHEMA || !Array.isArray(page.benefits)
      || Object.getPrototypeOf(page.benefits) !== Array.prototype) throw new Error();
    const length = Object.getOwnPropertyDescriptor(page.benefits, "length")?.value as unknown;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0
      || length > MAX_REVIEWED_BENEFIT_PAGE_ROWS) throw new Error();
    // Bound before enumeration or projection, and never invoke an array mapper.
    const descriptors = Object.getOwnPropertyDescriptors(page.benefits as object);
    if (Reflect.ownKeys(descriptors).length !== length + 1) throw new Error();
    const benefits = [];
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new Error();
      benefits.push(projectReviewedBenefit(descriptor.value));
    }
    const projected = decodeReviewedBenefitPage({ schema: REVIEWED_BENEFIT_PAGE_SCHEMA,
      dataGeneration: page.dataGeneration, benefitCollectionRevision: page.benefitCollectionRevision,
      benefits, nextCursor: page.nextCursor });
    if (!projected) throw new Error();
    return projected;
  } catch { throw new Error("REVIEW_PAGE_PRESENTATION_INVALID"); }
}
