import type { ReviewedBenefitKind, ReviewedBenefitReason, ReviewedBenefitValues, ReviewedValueOrigin } from "./reviewed-benefit-view";

/** Format boundary only: no server, authentication, clock, transport or storage. */
export const REVIEW_PREVIEW_VIEW_SCHEMA = "keyatlas.review-preview-view.v1" as const;
const VALUE_KEYS = ["name", "kind", "unit", "grantedAmount", "remainingAmount", "trialDaysStated",
  "remainingDaysStated", "expiresAt", "observedAt"] as const;
const KINDS = ["membership", "trial", "coupon", "credit", "point", "storage", "receipt", "expiration", "other"] as const;
const REASONS = ["USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED",
  "RECEIVED_DATE_UNKNOWN", "OBSERVATION_DATE_UNKNOWN", "PARTIAL_MAIL_TEXT"] as const;

export interface ReviewPreviewContent {
  readonly serviceId: string;
  readonly serviceRevision: number;
  readonly serviceName: string;
  readonly values: ReviewedBenefitValues;
  readonly valueOrigins: Readonly<Record<keyof ReviewedBenefitValues, ReviewedValueOrigin>>;
  readonly receivedAt: string | null;
  readonly extractedAt: string;
  readonly sourceObservedAt: string | null;
  readonly reviewReasons: readonly ReviewedBenefitReason[];
  readonly evidenceAvailability: "not-retained";
  readonly reviewStatus: "pending-review";
  readonly accountProof: "not-established";
  readonly currentBalanceProof: "not-established";
}
export interface ReviewPreviewView {
  readonly schema: typeof REVIEW_PREVIEW_VIEW_SCHEMA;
  readonly dataGeneration: number;
  readonly previewId: string;
  readonly previewRevision: 1;
  /** Canonical epoch milliseconds. Decode success does NOT mean still unexpired. */
  readonly expiresAt: number;
  readonly content: ReviewPreviewContent;
}

function invalid(): never { throw new Error("REVIEW_PREVIEW_VIEW_INVALID"); }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) return invalid();
  const copied: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return invalid();
    copied[key] = descriptor.value as unknown;
  }
  return copied;
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
  const number = amount(value);
  if (!Number.isSafeInteger(number)) return invalid();
  return number;
}
function nullable<T>(value: unknown, parse: (input: unknown) => T): T | null {
  return value === null ? null : parse(value);
}
/** Preserve day/offset/sub-millisecond precision; do not normalize observations. */
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
  const date = recordedDate(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date)
    || new Date(date).toISOString() !== date) return invalid();
  return date;
}
function values(value: unknown): ReviewedBenefitValues {
  const raw = fields(value, VALUE_KEYS);
  if (!KINDS.includes(raw.kind as ReviewedBenefitKind)) return invalid();
  const parsed = Object.freeze({ name: label(raw.name, 160), kind: raw.kind as ReviewedBenefitKind,
    unit: nullable(raw.unit, (input) => label(input, 40)),
    grantedAmount: nullable(raw.grantedAmount, amount), remainingAmount: nullable(raw.remainingAmount, amount),
    trialDaysStated: nullable(raw.trialDaysStated, days), remainingDaysStated: nullable(raw.remainingDaysStated, days),
    expiresAt: nullable(raw.expiresAt, recordedDate), observedAt: nullable(raw.observedAt, recordedDate) });
  if ((parsed.grantedAmount !== null || parsed.remainingAmount !== null)
    && (parsed.unit === null || ["membership", "receipt", "expiration"].includes(parsed.kind))) return invalid();
  return parsed;
}
function origins(value: unknown): ReviewPreviewContent["valueOrigins"] {
  const raw = fields(value, VALUE_KEYS);
  return Object.freeze(Object.fromEntries(VALUE_KEYS.map((key) => {
    const origin = raw[key];
    if (origin !== "email-extracted" && origin !== "user-corrected") return invalid();
    return [key, origin];
  })) as Record<keyof ReviewedBenefitValues, ReviewedValueOrigin>);
}
function reasons(value: unknown, receivedAt: string | null, sourceObservedAt: string | null): readonly ReviewedBenefitReason[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const size = Object.getOwnPropertyDescriptor(value, "length");
  const length: unknown = size && Object.hasOwn(size, "value") ? size.value : undefined;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 3 || length > REASONS.length) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  if (Reflect.ownKeys(descriptors).length !== length + 1) return invalid();
  const parsed: ReviewedBenefitReason[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return invalid();
    const reason = descriptor.value as ReviewedBenefitReason;
    if (!REASONS.includes(reason) || parsed.includes(reason)) return invalid();
    parsed.push(reason);
  }
  if (!parsed.includes("USER_REVIEW_REQUIRED") || !parsed.includes("NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF")
    || !parsed.includes("EXPIRY_CONFIRMATION_NEEDED") || (receivedAt === null && !parsed.includes("RECEIVED_DATE_UNKNOWN"))
    || (sourceObservedAt === null && !parsed.includes("OBSERVATION_DATE_UNKNOWN"))) return invalid();
  return Object.freeze(parsed);
}
function content(value: unknown): ReviewPreviewContent {
  const raw = fields(value, ["serviceId", "serviceRevision", "serviceName", "values", "valueOrigins", "receivedAt",
    "extractedAt", "sourceObservedAt", "reviewReasons", "evidenceAvailability", "reviewStatus", "accountProof", "currentBalanceProof"]);
  if (raw.reviewStatus !== "pending-review" || raw.evidenceAvailability !== "not-retained"
    || raw.accountProof !== "not-established" || raw.currentBalanceProof !== "not-established") return invalid();
  const reviewed = values(raw.values), provenance = origins(raw.valueOrigins);
  const receivedAt = nullable(raw.receivedAt, instant), sourceObservedAt = nullable(raw.sourceObservedAt, recordedDate);
  // Only the original observation is exposed. Other origin claims still depend
  // on the trusted server projection; this decoder cannot authenticate them.
  if (provenance.observedAt !== (reviewed.observedAt === sourceObservedAt ? "email-extracted" : "user-corrected")) return invalid();
  return Object.freeze({ serviceId: id(raw.serviceId), serviceRevision: revision(raw.serviceRevision), serviceName: label(raw.serviceName, 160),
    values: reviewed, valueOrigins: provenance, receivedAt, extractedAt: instant(raw.extractedAt), sourceObservedAt,
    reviewReasons: reasons(raw.reviewReasons, receivedAt, sourceObservedAt), evidenceAvailability: "not-retained",
    reviewStatus: "pending-review", accountProof: "not-established", currentBalanceProof: "not-established" });
}

/**
 * Unknown already-decoded JSON, not a transport parser or authority verifier.
 * Callers must limit bytes, fence the original account/view scope, and check
 * expiry/confirmation on the server. No clock or account is invented here.
 * Reflection may execute Proxy traps; exceptions fail closed, not sandboxed.
 */
export function decodeReviewPreviewView(input: unknown): ReviewPreviewView | null {
  try {
    const raw = fields(input, ["schema", "dataGeneration", "previewId", "previewRevision", "expiresAt", "content"]);
    if (raw.schema !== REVIEW_PREVIEW_VIEW_SCHEMA || raw.previewRevision !== 1) return null;
    return Object.freeze({ schema: REVIEW_PREVIEW_VIEW_SCHEMA, dataGeneration: revision(raw.dataGeneration),
      previewId: id(raw.previewId), previewRevision: 1, expiresAt: timestamp(raw.expiresAt), content: content(raw.content) });
  } catch { return null; }
}
