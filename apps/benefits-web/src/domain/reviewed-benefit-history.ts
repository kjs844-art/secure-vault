import {
  decodeReviewedBenefitView, MAX_REVIEWED_BENEFIT_ENTRIES, type ReviewedBenefitView,
} from "./reviewed-benefit-view";

export type ReviewedBenefitHistoryMode = "review" | "history";
export type ReviewedBenefitHistoryReason =
  | "expiry_elapsed" | "expiry_future" | "expiry_day_precision" | "expiry_unknown";
export interface ClassifiedReviewedBenefit {
  readonly bucket: ReviewedBenefitHistoryMode;
  readonly reason: ReviewedBenefitHistoryReason;
  readonly record: Extract<ReviewedBenefitView, { readonly outcome: "saved" }>;
}
export type ReviewedBenefitHistoryClassification = ClassifiedReviewedBenefit | { readonly bucket: "deleted" };
export interface ReviewedBenefitHistorySelection {
  readonly mode: ReviewedBenefitHistoryMode;
  readonly referenceMs: number;
  /** Counts only the supplied observations, never a server-wide total. */
  readonly totalLiveCount: number;
  readonly reviewCount: number;
  readonly historyCount: number;
  readonly records: readonly ClassifiedReviewedBenefit[];
}

const DELETED = Object.freeze({ bucket: "deleted" as const });
function reference(input: unknown): number | null {
  return typeof input === "number" && Number.isSafeInteger(input) && !Object.is(input, -0)
    && input >= 0 && input <= 253402300799999 ? input : null;
}
function classify(record: ReviewedBenefitView, referenceMs: number): ReviewedBenefitHistoryClassification {
  if (record.outcome === "deleted") return DELETED;
  const expiry = record.content.values.expiresAt;
  if (expiry === null) return Object.freeze({ bucket: "review", reason: "expiry_unknown", record });
  // The row decoder has already checked calendars, offsets and 1..9 fractional
  // digits. A stated day is not midnight in an invented local/UTC time zone.
  const exact = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(expiry);
  if (!exact) return Object.freeze({ bucket: "review", reason: "expiry_day_precision", record });
  // Parse only the exact whole second, then add the preserved fractional part.
  // Date.parse(expiry) alone truncates sub-ms precision and can expire early.
  const wholeMs = Date.parse(`${exact[1]}.000${exact[3]}`);
  const nanoseconds = BigInt(wholeMs) * 1_000_000n + BigInt((exact[2] ?? "").padEnd(9, "0"));
  const elapsed = nanoseconds <= BigInt(referenceMs) * 1_000_000n;
  return Object.freeze({ bucket: elapsed ? "history" : "review",
    reason: elapsed ? "expiry_elapsed" : "expiry_future", record });
}

/**
 * Display classification of a reviewed observation, not current availability,
 * balance/account proof, authorization or server freshness. No service status,
 * stated trial length, observation time or receipt time invents an expiry.
 * Observation after expiry is possible and does not override the recorded date.
 */
export function classifyReviewedBenefitHistory(input: unknown, referenceMs: unknown): ReviewedBenefitHistoryClassification | null {
  const time = reference(referenceMs);
  if (time === null) return null;
  try {
    const record = decodeReviewedBenefitView(input);
    return record ? classify(record, time) : null;
  } catch { return null; }
}

/**
 * Filters ONLY the bounded observations supplied by the caller. Counts are not
 * collection totals; an empty selection is not a terminal page or deletion
 * evidence. Keep cursors, scope/generation/revision and tombstone fences in the
 * owning consumer. The original records/state are never modified or purged.
 */
export function selectReviewedBenefitHistory(
  entries: unknown, mode: unknown, referenceMs: unknown,
): ReviewedBenefitHistorySelection | null {
  const time = reference(referenceMs);
  if (time === null || (mode !== "review" && mode !== "history")) return null;
  try {
    if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(entries, "length");
    const length = lengthDescriptor?.value as unknown;
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || typeof length !== "number"
      || !Number.isSafeInteger(length) || length < 0 || length > MAX_REVIEWED_BENEFIT_ENTRIES) return null;
    // Bound length before enumerating descriptors or inspecting any record.
    const descriptors = Object.getOwnPropertyDescriptors(entries as object);
    if (Reflect.ownKeys(descriptors).length !== length + 1) return null;
    const seen = new Set<string>();
    let generation: number | null = null, reviewCount = 0, historyCount = 0;
    const records: ClassifiedReviewedBenefit[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return null;
      const record = decodeReviewedBenefitView(descriptor.value as unknown);
      if (!record || seen.has(record.benefitId) || (generation !== null && generation !== record.dataGeneration)) return null;
      generation = record.dataGeneration;
      seen.add(record.benefitId); // Tombstones also reserve their IDs.
      const classified = classify(record, time);
      if (classified.bucket === "deleted") continue;
      if (classified.bucket === "history") historyCount++;
      else reviewCount++;
      if (classified.bucket === mode) records.push(classified);
    }
    return Object.freeze({ mode, referenceMs: time, totalLiveCount: reviewCount + historyCount,
      reviewCount, historyCount, records: Object.freeze(records) });
  } catch { return null; }
}
