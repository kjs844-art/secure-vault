import type { ReviewedBenefitKind, ReviewedBenefitReason, ReviewedBenefitValues } from "./reviewed-benefit-view";

/** Format boundary only. No provider, server, clock, authority, transport or storage. */
export const CANDIDATE_BATCH_VIEW_SCHEMA = "keyatlas.candidate-batch-view.v1" as const;
export const MAX_CANDIDATE_BATCH_DISPLAY = 100;
const VALUE_KEYS = ["name", "kind", "unit", "grantedAmount", "remainingAmount", "trialDaysStated",
  "remainingDaysStated", "expiresAt", "observedAt"] as const;
const KINDS = ["membership", "trial", "coupon", "credit", "point", "storage", "receipt", "expiration", "other"] as const;
const REASONS = ["USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED",
  "RECEIVED_DATE_UNKNOWN", "OBSERVATION_DATE_UNKNOWN", "PARTIAL_MAIL_TEXT"] as const;

export type CandidateDisplayValues = Omit<ReviewedBenefitValues, "name"> & { readonly name: string | null };
export interface CandidateDisplayContent {
  /** Extracted text, not an owned catalog service ID or verified service match. */
  readonly serviceName: string;
  readonly extractionConfidence: "high" | "medium" | "low";
  readonly values: CandidateDisplayValues;
  readonly receivedAt: string | null;
  readonly extractedAt: string;
  readonly reviewReasons: readonly ReviewedBenefitReason[];
  readonly evidenceAvailability: "not-retained";
  readonly reviewStatus: "pending-review";
  readonly accountProof: "not-established";
  readonly currentBalanceProof: "not-established";
}
interface CandidateIdentity {
  readonly candidateId: string;
  readonly candidateRevision: number;
  /** Pending access deadline, NOT the benefit's recorded values.expiresAt. */
  readonly accessExpiresAt: number;
}
export type CandidateDisplay = CandidateIdentity & (
  | { readonly state: "pending"; readonly content: CandidateDisplayContent }
  | { readonly state: "accepted" | "deleted" | "expired"; readonly content: null }
);
export interface CandidateBatchDisplay {
  readonly schema: typeof CANDIDATE_BATCH_VIEW_SCHEMA;
  readonly dataGeneration: number;
  /** One bounded batch observation, not a complete inbox or server-wide total. */
  readonly candidates: readonly CandidateDisplay[];
}

function invalid(): never { throw new Error("CANDIDATE_BATCH_VIEW_INVALID"); }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) return invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return invalid();
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const size = Object.getOwnPropertyDescriptor(value, "length");
  const length: unknown = size && Object.hasOwn(size, "value") ? size.value : undefined;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maximum) return invalid();
  // Check the bound before enumeration or any element/iterator access.
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  if (Reflect.ownKeys(descriptors).length !== length + 1) return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return invalid();
    result.push(descriptor.value as unknown);
  }
  return result;
}
function id(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return invalid();
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return invalid();
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)
    || value < 0 || value > 253402300799999) return invalid();
  return value;
}
function label(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > maximum
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || /[\uD800-\uDFFF]/u.test(value)) return invalid();
  return value;
}
function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return invalid();
  return value;
}
function days(value: unknown): number {
  const parsed = amount(value);
  if (!Number.isSafeInteger(parsed)) return invalid();
  return parsed;
}
function nullable<T>(value: unknown, parse: (input: unknown) => T): T | null {
  return value === null ? null : parse(value);
}
/** Keep original day/offset/sub-ms precision. No invented timezone or rounding. */
function recordedDate(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length > 40) return invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return invalid();
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const limits = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > (limits[month - 1] ?? 0)) return invalid();
  if (match[4] !== undefined) {
    if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return invalid();
    const zone = match[8]!;
    if (zone !== "Z") {
      const hour = Number(zone.slice(1, 3)), minute = Number(zone.slice(4));
      if (zone === "-00:00" || hour > 14 || minute > 59 || (hour === 14 && minute !== 0)) return invalid();
    }
  }
  return value;
}
function instant(value: unknown): string {
  const parsed = recordedDate(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)
    || new Date(parsed).toISOString() !== parsed) return invalid();
  return parsed;
}
function values(value: unknown): CandidateDisplayValues {
  const raw = fields(value, VALUE_KEYS);
  if (!KINDS.includes(raw.kind as ReviewedBenefitKind)) return invalid();
  const result = Object.freeze({ name: nullable(raw.name, (input) => label(input, 160)), kind: raw.kind as ReviewedBenefitKind,
    unit: nullable(raw.unit, (input) => label(input, 40)),
    grantedAmount: nullable(raw.grantedAmount, amount), remainingAmount: nullable(raw.remainingAmount, amount),
    trialDaysStated: nullable(raw.trialDaysStated, days), remainingDaysStated: nullable(raw.remainingDaysStated, days),
    expiresAt: nullable(raw.expiresAt, recordedDate), observedAt: nullable(raw.observedAt, recordedDate) });
  if ((result.grantedAmount !== null || result.remainingAmount !== null)
    && (result.unit === null || ["membership", "receipt", "expiration"].includes(result.kind))) return invalid();
  return result;
}
function reasons(value: unknown, receivedAt: string | null, observedAt: string | null): readonly ReviewedBenefitReason[] {
  const parsed: ReviewedBenefitReason[] = [];
  for (const item of array(value, REASONS.length)) {
    const reason = item as ReviewedBenefitReason;
    if (!REASONS.includes(reason) || parsed.includes(reason)) return invalid();
    parsed.push(reason);
  }
  if (!parsed.includes("USER_REVIEW_REQUIRED") || !parsed.includes("NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF")
    || !parsed.includes("EXPIRY_CONFIRMATION_NEEDED") || (receivedAt === null && !parsed.includes("RECEIVED_DATE_UNKNOWN"))
    || (observedAt === null && !parsed.includes("OBSERVATION_DATE_UNKNOWN"))) return invalid();
  return Object.freeze(parsed);
}
function content(value: unknown): CandidateDisplayContent {
  const raw = fields(value, ["serviceName", "extractionConfidence", "values", "receivedAt", "extractedAt", "reviewReasons",
    "evidenceAvailability", "reviewStatus", "accountProof", "currentBalanceProof"]);
  if (raw.evidenceAvailability !== "not-retained" || raw.reviewStatus !== "pending-review"
    || raw.accountProof !== "not-established" || raw.currentBalanceProof !== "not-established"
    || (raw.extractionConfidence !== "high" && raw.extractionConfidence !== "medium" && raw.extractionConfidence !== "low")) return invalid();
  const extracted = values(raw.values), receivedAt = nullable(raw.receivedAt, instant);
  return Object.freeze({ serviceName: label(raw.serviceName, 160), extractionConfidence: raw.extractionConfidence,
    values: extracted, receivedAt, extractedAt: instant(raw.extractedAt),
    reviewReasons: reasons(raw.reviewReasons, receivedAt, extracted.observedAt), evidenceAvailability: "not-retained",
    reviewStatus: "pending-review", accountProof: "not-established", currentBalanceProof: "not-established" });
}
function candidate(value: unknown): CandidateDisplay {
  const raw = fields(value, ["candidateId", "candidateRevision", "state", "accessExpiresAt", "content"]);
  const identity = { candidateId: id(raw.candidateId), candidateRevision: revision(raw.candidateRevision), accessExpiresAt: timestamp(raw.accessExpiresAt) };
  if (raw.state === "pending") return Object.freeze({ ...identity, state: "pending", content: content(raw.content) });
  if ((raw.state !== "accepted" && raw.state !== "deleted" && raw.state !== "expired") || raw.content !== null) return invalid();
  return Object.freeze({ ...identity, state: raw.state, content: null });
}

/**
 * Unknown decoded JSON only. Does not establish authenticity, current authority,
 * unexpired access or completeness. The consumer must fence scope/requests and
 * expiry; the server must recheck candidate/service versions before confirmation.
 * Reflection can run Proxy traps; fixed failure is not a JavaScript sandbox.
 */
export function decodeCandidateBatchDisplay(input: unknown): CandidateBatchDisplay | null {
  try {
    const raw = fields(input, ["schema", "dataGeneration", "candidates"]);
    if (raw.schema !== CANDIDATE_BATCH_VIEW_SCHEMA) return null;
    const generation = revision(raw.dataGeneration), seen = new Set<string>(), candidates: CandidateDisplay[] = [];
    for (const item of array(raw.candidates, MAX_CANDIDATE_BATCH_DISPLAY)) {
      const parsed = candidate(item);
      if (seen.has(parsed.candidateId)) return null;
      seen.add(parsed.candidateId); candidates.push(parsed);
    }
    return Object.freeze({ schema: CANDIDATE_BATCH_VIEW_SCHEMA, dataGeneration: generation, candidates: Object.freeze(candidates) });
  } catch { return null; }
}
