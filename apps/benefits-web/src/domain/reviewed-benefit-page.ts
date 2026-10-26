import { decodeReviewedBenefitView, type ReviewedBenefitView } from "./reviewed-benefit-view";

export const REVIEWED_BENEFIT_PAGE_SCHEMA = "keyatlas.reviewed-benefit-page.v1" as const;
export const MAX_REVIEWED_BENEFIT_PAGE_ROWS = 50;

export interface ReviewedBenefitPageCursor {
  readonly afterId: string;
  readonly benefitCollectionRevision: number;
  readonly dataGeneration: number;
}
export interface ReviewedBenefitPageView {
  readonly schema: typeof REVIEWED_BENEFIT_PAGE_SCHEMA;
  readonly dataGeneration: number;
  readonly benefitCollectionRevision: number;
  readonly benefits: readonly Extract<ReviewedBenefitView, { readonly outcome: "saved" }>[];
  readonly nextCursor: ReviewedBenefitPageCursor | null;
}

function invalid(): never { throw new Error("REVIEWED_BENEFIT_PAGE_INVALID"); }
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) return invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return invalid();
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function revision(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) return invalid();
  return input;
}
function id(input: unknown): string {
  if (typeof input !== "string" || input.trim() !== input
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)) return invalid();
  return input;
}
function rows(input: unknown, generation: number): ReviewedBenefitPageView["benefits"] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return invalid();
  // Check the single length descriptor BEFORE enumerating descriptors/indices.
  // Byte limits and arbitrary Proxy execution remain transport/caller concerns.
  const lengthProperty = Object.getOwnPropertyDescriptor(input, "length");
  const length = lengthProperty?.value as unknown;
  if (!lengthProperty || !Object.hasOwn(lengthProperty, "value") || typeof length !== "number"
    || !Number.isSafeInteger(length) || length < 0 || length > MAX_REVIEWED_BENEFIT_PAGE_ROWS) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input as object);
  if (Reflect.ownKeys(descriptors).length !== length + 1) return invalid();
  const result: Extract<ReviewedBenefitView, { readonly outcome: "saved" }>[] = [];
  let previous = "";
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return invalid();
    const row = decodeReviewedBenefitView(descriptor.value as unknown);
    if (!row || row.outcome !== "saved" || row.dataGeneration !== generation || id(row.benefitId) <= previous) return invalid();
    previous = row.benefitId;
    result.push(row);
  }
  return Object.freeze(result);
}

/**
 * Strict decoded-JSON shape only, not authentication, request/response binding,
 * freshness, completeness or permission to remove absent rows. A null cursor
 * merely reports the observed page end. Keep scope/revision/tombstone fences
 * outside this decoder and bound the transport body before JSON parsing.
 */
export function decodeReviewedBenefitPage(input: unknown): ReviewedBenefitPageView | null {
  try {
    const raw = fields(input, ["schema", "dataGeneration", "benefitCollectionRevision", "benefits", "nextCursor"]);
    if (raw.schema !== REVIEWED_BENEFIT_PAGE_SCHEMA) return null;
    const dataGeneration = revision(raw.dataGeneration);
    const benefitCollectionRevision = revision(raw.benefitCollectionRevision);
    const benefits = rows(raw.benefits, dataGeneration);
    let nextCursor: ReviewedBenefitPageCursor | null = null;
    if (raw.nextCursor !== null) {
      const cursor = fields(raw.nextCursor, ["afterId", "benefitCollectionRevision", "dataGeneration"]);
      const afterId = id(cursor.afterId);
      if (benefits.length === 0 || afterId !== benefits[benefits.length - 1]!.benefitId
        || revision(cursor.dataGeneration) !== dataGeneration
        || revision(cursor.benefitCollectionRevision) !== benefitCollectionRevision) return null;
      nextCursor = Object.freeze({ afterId, benefitCollectionRevision, dataGeneration });
    }
    return Object.freeze({ schema: REVIEWED_BENEFIT_PAGE_SCHEMA, dataGeneration,
      benefitCollectionRevision, benefits, nextCursor });
  } catch { return null; }
}
