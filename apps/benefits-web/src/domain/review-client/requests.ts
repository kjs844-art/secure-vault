/**
 * Browser-only command values. This is validation, not authority or a transport.
 * Keep semantic parity with review/validation through the request parity tests.
 * No server imports, credentials, storage, clocks or identifier generation.
 */
export interface ReviewRequestValues {
  readonly name: string;
  readonly kind: "membership" | "trial" | "coupon" | "credit" | "point" | "storage" | "receipt" | "expiration" | "other";
  readonly unit: string | null;
  readonly grantedAmount: number | null;
  readonly remainingAmount: number | null;
  readonly trialDaysStated: number | null;
  readonly remainingDaysStated: number | null;
  readonly expiresAt: string | null;
  readonly observedAt: string | null;
}
export interface ReviewRequestCursor {
  readonly afterId: string;
  readonly benefitCollectionRevision: number;
  readonly dataGeneration: number;
}
export interface ReviewPreviewRequest {
  readonly action: "preview";
  readonly body: { readonly candidateId: string; readonly candidateRevision: number;
    readonly serviceId: string; readonly serviceRevision: number; readonly values: ReviewRequestValues };
}
export interface ReviewConfirmRequest {
  readonly action: "confirm";
  readonly body: { readonly previewId: string; readonly operationId: string; readonly decision: "confirm" };
}
export interface ReviewRejectRequest {
  readonly action: "reject";
  readonly body: { readonly previewId: string; readonly expectedRevision: number; readonly decision: "reject" };
}
export interface ReviewDeleteRequest {
  readonly action: "delete";
  readonly body: { readonly benefitId: string; readonly expectedRevision: number;
    readonly operationId: string; readonly decision: "delete" };
}
export interface ReviewGetRequest {
  readonly action: "get";
  readonly body: { readonly benefitId: string };
}
export interface ReviewListRequest {
  readonly action: "list";
  readonly body: { readonly limit: number; readonly cursor: ReviewRequestCursor | null };
}
export type ReviewRequest = ReviewPreviewRequest | ReviewConfirmRequest | ReviewRejectRequest
  | ReviewDeleteRequest | ReviewGetRequest | ReviewListRequest;
export type ReviewRequestFailure = "REVIEW_INPUT_INVALID";

function fail(): never { throw new Error("REVIEW_INPUT_INVALID"); }
function exactFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(descriptors);
    if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) return fail();
    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return fail();
      fields[key] = descriptor.value as unknown;
    }
    return fields;
  } catch {
    // Reflection can run Proxy traps. Normalize exceptions, not a JS sandbox.
    return fail();
  }
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return fail();
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return fail();
  return value;
}
function label(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > maximum
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || /[\uD800-\uDFFF]/u.test(value)) return fail();
  return value;
}
function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return fail();
  return value;
}
function days(value: unknown): number {
  const parsed = amount(value);
  if (!Number.isSafeInteger(parsed)) return fail();
  return parsed;
}
/** Preserve a stated day or explicit offset and all 1..9 fractional digits. */
function recordedDate(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length > 40) return fail();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return fail();
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > (monthDays[month - 1] ?? 0)) return fail();
  if (match[4] !== undefined) {
    if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return fail();
    const zone = match[8]!;
    if (zone !== "Z") {
      const hour = Number(zone.slice(1, 3)), minute = Number(zone.slice(4));
      if (zone === "-00:00" || hour > 14 || minute > 59 || (hour === 14 && minute !== 0)) return fail();
    }
  }
  return value;
}
function nullable<T>(value: unknown, parse: (input: unknown) => T): T | null {
  return value === null ? null : parse(value);
}
const VALUE_KEYS = ["name", "kind", "unit", "grantedAmount", "remainingAmount", "trialDaysStated",
  "remainingDaysStated", "expiresAt", "observedAt"] as const;
const KINDS: readonly ReviewRequestValues["kind"][] = ["membership", "trial", "coupon", "credit", "point",
  "storage", "receipt", "expiration", "other"];
function values(input: unknown): ReviewRequestValues {
  const raw = exactFields(input, VALUE_KEYS);
  if (!KINDS.includes(raw.kind as ReviewRequestValues["kind"])) return fail();
  const parsed = Object.freeze({ name: label(raw.name, 160), kind: raw.kind as ReviewRequestValues["kind"],
    unit: nullable(raw.unit, (input) => label(input, 40)),
    grantedAmount: nullable(raw.grantedAmount, amount), remainingAmount: nullable(raw.remainingAmount, amount),
    trialDaysStated: nullable(raw.trialDaysStated, days), remainingDaysStated: nullable(raw.remainingDaysStated, days),
    expiresAt: nullable(raw.expiresAt, recordedDate), observedAt: nullable(raw.observedAt, recordedDate) });
  if ((parsed.grantedAmount !== null || parsed.remainingAmount !== null)
    && (parsed.unit === null || ["membership", "receipt", "expiration"].includes(parsed.kind))) return fail();
  return parsed;
}

export function createReviewPreviewRequest(candidateId: unknown, candidateRevision: unknown, serviceId: unknown,
  serviceRevision: unknown, inputValues: unknown): ReviewPreviewRequest {
  return Object.freeze({ action: "preview", body: Object.freeze({ candidateId: identifier(candidateId),
    candidateRevision: revision(candidateRevision), serviceId: identifier(serviceId), serviceRevision: revision(serviceRevision),
    values: values(inputValues) }) });
}
export function createReviewConfirmRequest(previewId: unknown, operationId: unknown): ReviewConfirmRequest {
  return Object.freeze({ action: "confirm", body: Object.freeze({ previewId: identifier(previewId),
    operationId: identifier(operationId), decision: "confirm" }) });
}
export function createReviewRejectRequest(previewId: unknown, expectedRevision: unknown): ReviewRejectRequest {
  return Object.freeze({ action: "reject", body: Object.freeze({ previewId: identifier(previewId),
    expectedRevision: revision(expectedRevision), decision: "reject" }) });
}
export function createReviewDeleteRequest(benefitId: unknown, expectedRevision: unknown, operationId: unknown): ReviewDeleteRequest {
  return Object.freeze({ action: "delete", body: Object.freeze({ benefitId: identifier(benefitId),
    expectedRevision: revision(expectedRevision), operationId: identifier(operationId), decision: "delete" }) });
}
export function createReviewGetRequest(benefitId: unknown): ReviewGetRequest {
  return Object.freeze({ action: "get", body: Object.freeze({ benefitId: identifier(benefitId) }) });
}
export function createReviewListRequest(limit: unknown, inputCursor: unknown): ReviewListRequest {
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return fail();
  let cursor: ReviewRequestCursor | null = null;
  if (inputCursor !== null) {
    const raw = exactFields(inputCursor, ["afterId", "benefitCollectionRevision", "dataGeneration"]);
    cursor = Object.freeze({ afterId: identifier(raw.afterId), benefitCollectionRevision: revision(raw.benefitCollectionRevision),
      dataGeneration: revision(raw.dataGeneration) });
  }
  return Object.freeze({ action: "list", body: Object.freeze({ limit, cursor }) });
}

/** Detach all own enumerable data fields before a caller may transport a command. */
export function snapshotReviewRequest(input: unknown): ReviewRequest {
  const request = exactFields(input, ["action", "body"]);
  switch (request.action) {
    case "preview": {
      const body = exactFields(request.body, ["candidateId", "candidateRevision", "serviceId", "serviceRevision", "values"]);
      return createReviewPreviewRequest(body.candidateId, body.candidateRevision, body.serviceId, body.serviceRevision, body.values);
    }
    case "confirm": {
      const body = exactFields(request.body, ["previewId", "operationId", "decision"]);
      if (body.decision !== "confirm") return fail();
      return createReviewConfirmRequest(body.previewId, body.operationId);
    }
    case "reject": {
      const body = exactFields(request.body, ["previewId", "expectedRevision", "decision"]);
      if (body.decision !== "reject") return fail();
      return createReviewRejectRequest(body.previewId, body.expectedRevision);
    }
    case "delete": {
      const body = exactFields(request.body, ["benefitId", "expectedRevision", "operationId", "decision"]);
      if (body.decision !== "delete") return fail();
      return createReviewDeleteRequest(body.benefitId, body.expectedRevision, body.operationId);
    }
    case "get": {
      const body = exactFields(request.body, ["benefitId"]);
      return createReviewGetRequest(body.benefitId);
    }
    case "list": {
      const body = exactFields(request.body, ["limit", "cursor"]);
      return createReviewListRequest(body.limit, body.cursor);
    }
    default: return fail();
  }
}
