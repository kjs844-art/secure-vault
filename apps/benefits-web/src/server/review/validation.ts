import type { BenefitEvidenceKind, EmailCandidate } from "../mail/contracts";
import {
  REVIEW_SCHEMA,
  type CandidateContent, type ExtractedValues, type ReviewAuthority, type ReviewDraft,
  type ReviewErrorCode, type ReviewValues,
} from "./contracts";

const VALUE_KEYS = [
  "name", "kind", "unit", "grantedAmount", "remainingAmount", "trialDaysStated",
  "remainingDaysStated", "expiresAt", "observedAt",
] as const;
const KINDS: readonly BenefitEvidenceKind[] = [
  "membership", "trial", "coupon", "credit", "point", "storage", "receipt", "expiration", "other",
];
const MAIL_REVIEW_POLICY = "keyatlas.gmail-review.v1";
const MAX_TIMESTAMP = 253402300799999;
const REVIEW_REASONS: EmailCandidate["reviewReasons"] = [
  "USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED",
  "RECEIVED_DATE_UNKNOWN", "OBSERVATION_DATE_UNKNOWN", "PARTIAL_MAIL_TEXT",
];

export class ReviewFailure extends Error {
  constructor(readonly code: ReviewErrorCode) {
    super(code);
    this.name = "ReviewFailure";
  }
}

export function failReview(code: ReviewErrorCode = "REVIEW_INPUT_INVALID"): never {
  throw new ReviewFailure(code);
}

/** Snapshot own data properties only; never invoke caller-supplied accessors. */
function objectFields(value: unknown, keys: readonly string[], exact = true): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return failReview();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return failReview();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(descriptors);
    if (exact && (actual.length !== keys.length || actual.some((key) =>
      typeof key !== "string" || !keys.includes(key)))) return failReview();
    const projected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return failReview();
      projected[key] = descriptor.value as unknown;
    }
    return projected;
  } catch {
    return failReview();
  }
}

export function parseId(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return failReview();
  return value;
}

export function parseRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return failReview();
  return value;
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP) {
    return failReview();
  }
  return value;
}

/** Input is verified server state, not an HTTP principal or an authentication implementation. */
export function parseAuthority(value: unknown, now: number): ReviewAuthority {
  try {
    const raw = objectFields(value, ["ownerId", "sessionId", "sessionRevision", "dataGeneration", "expiresAt"], false);
    const authority = Object.freeze({
      ownerId: parseId(raw.ownerId), sessionId: parseId(raw.sessionId),
      sessionRevision: parseRevision(raw.sessionRevision), dataGeneration: parseRevision(raw.dataGeneration),
      expiresAt: timestamp(raw.expiresAt),
    });
    if (authority.expiresAt <= timestamp(now)) return failReview();
    return authority;
  } catch {
    return failReview("REVIEW_AUTH_REQUIRED");
  }
}

function label(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > maximum
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
    // Unicode mode matches lone surrogate code points but preserves valid emoji pairs.
    || /[\uD800-\uDFFF]/u.test(value)) return failReview();
  return value;
}

function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    return failReview();
  }
  return value;
}

function days(value: unknown): number {
  const result = amount(value);
  if (!Number.isSafeInteger(result)) return failReview();
  return result;
}

/** Preserve stated day precision and explicit offsets; never infer an unstated zone. */
function recordedDate(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length > 40) return failReview();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return failReview();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > (monthDays[month - 1] ?? 0)) return failReview();
  if (match[4] !== undefined) {
    if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return failReview();
    const zone = match[8]!;
    if (zone !== "Z") {
      const hour = Number(zone.slice(1, 3));
      const minute = Number(zone.slice(4));
      if (zone === "-00:00" || hour > 14 || minute > 59 || (hour === 14 && minute !== 0)) return failReview();
    }
  }
  return value;
}

function utcInstant(value: unknown): string {
  const result = recordedDate(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    || new Date(result).toISOString() !== result) return failReview();
  return result;
}

function nullable<T>(value: unknown, parse: (input: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function extractedValues(value: unknown): ExtractedValues {
  const raw = objectFields(value, VALUE_KEYS);
  if (!KINDS.includes(raw.kind as BenefitEvidenceKind)) return failReview();
  const result = Object.freeze({
    name: nullable(raw.name, (input) => label(input, 160)),
    kind: raw.kind as BenefitEvidenceKind,
    unit: nullable(raw.unit, (input) => label(input, 40)),
    grantedAmount: nullable(raw.grantedAmount, amount), remainingAmount: nullable(raw.remainingAmount, amount),
    trialDaysStated: nullable(raw.trialDaysStated, days), remainingDaysStated: nullable(raw.remainingDaysStated, days),
    expiresAt: nullable(raw.expiresAt, recordedDate), observedAt: nullable(raw.observedAt, recordedDate),
  });
  const hasAmount = result.grantedAmount !== null || result.remainingAmount !== null;
  if (hasAmount && (result.unit === null || ["membership", "receipt", "expiration"].includes(result.kind))) {
    return failReview();
  }
  return result;
}

export function parseValues(value: unknown): ReviewValues {
  const parsed = extractedValues(value);
  if (parsed.name === null) return failReview();
  return Object.freeze({ ...parsed, name: parsed.name });
}

export function parseDraft(value: unknown): ReviewDraft {
  const raw = objectFields(value, ["candidateId", "candidateRevision", "serviceId", "serviceRevision", "values"]);
  return Object.freeze({
    candidateId: parseId(raw.candidateId), candidateRevision: parseRevision(raw.candidateRevision),
    serviceId: parseId(raw.serviceId), serviceRevision: parseRevision(raw.serviceRevision),
    values: parseValues(raw.values),
  });
}

export function parseConfirm(value: unknown): Readonly<{
  previewId: string; operationId: string; decision: "confirm";
}> {
  const raw = objectFields(value, ["previewId", "operationId", "decision"]);
  if (raw.decision !== "confirm") return failReview();
  return Object.freeze({ previewId: parseId(raw.previewId), operationId: parseId(raw.operationId), decision: "confirm" });
}

export function parseDelete(value: unknown): Readonly<{
  benefitId: string; expectedRevision: number; operationId: string; decision: "delete";
}> {
  const raw = objectFields(value, ["benefitId", "expectedRevision", "operationId", "decision"]);
  if (raw.decision !== "delete") return failReview();
  return Object.freeze({
    benefitId: parseId(raw.benefitId), expectedRevision: parseRevision(raw.expectedRevision),
    operationId: parseId(raw.operationId), decision: "delete",
  });
}

export function parseRevoke(value: unknown): Readonly<{
  previewId: string; expectedRevision: number; decision: "reject";
}> {
  const raw = objectFields(value, ["previewId", "expectedRevision", "decision"]);
  if (raw.decision !== "reject") return failReview();
  return Object.freeze({
    previewId: parseId(raw.previewId), expectedRevision: parseRevision(raw.expectedRevision), decision: "reject",
  });
}

function parseReviewReasons(
  value: unknown, receivedAt: string | null, observedAt: string | null,
): EmailCandidate["reviewReasons"] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return failReview();
    const descriptors = Object.getOwnPropertyDescriptors(value as object);
    const length = descriptors.length?.value as unknown;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 1 || length > REVIEW_REASONS.length
      || Reflect.ownKeys(descriptors).length !== length + 1) return failReview();
    const reasons: Array<EmailCandidate["reviewReasons"][number]> = [];
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable
        || !REVIEW_REASONS.includes(descriptor.value as EmailCandidate["reviewReasons"][number])) return failReview();
      const reason = descriptor.value as EmailCandidate["reviewReasons"][number];
      if (reasons.includes(reason)) return failReview();
      reasons.push(reason);
    }
    if (!reasons.includes("USER_REVIEW_REQUIRED") || !reasons.includes("NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF")
      || !reasons.includes("EXPIRY_CONFIRMATION_NEEDED")
      || (receivedAt === null && !reasons.includes("RECEIVED_DATE_UNKNOWN"))
      || (observedAt === null && !reasons.includes("OBSERVATION_DATE_UNKNOWN"))) return failReview();
    return Object.freeze(reasons);
  } catch {
    return failReview();
  }
}

export function parseCandidateContent(value: unknown): CandidateContent {
  const raw = objectFields(value, [
    "schema", "analysisOperationId", "mailboxBindingId", "candidateIndex", "policyVersion",
    "extractedAt", "receivedAt", "serviceName", "extractionConfidence", "reviewReasons", "values", "evidenceAvailability",
  ]);
  if (raw.schema !== REVIEW_SCHEMA || raw.policyVersion !== MAIL_REVIEW_POLICY
    || raw.evidenceAvailability !== "not-retained"
    || typeof raw.candidateIndex !== "number" || !Number.isSafeInteger(raw.candidateIndex)
    || raw.candidateIndex < 0 || raw.candidateIndex > 99
    || (raw.extractionConfidence !== "high" && raw.extractionConfidence !== "medium" && raw.extractionConfidence !== "low")) {
    return failReview();
  }
  const receivedAt = nullable(raw.receivedAt, utcInstant);
  const values = extractedValues(raw.values);
  return Object.freeze({
    schema: REVIEW_SCHEMA,
    analysisOperationId: parseId(raw.analysisOperationId), mailboxBindingId: parseId(raw.mailboxBindingId),
    candidateIndex: raw.candidateIndex, policyVersion: MAIL_REVIEW_POLICY,
    extractedAt: utcInstant(raw.extractedAt), receivedAt,
    serviceName: label(raw.serviceName, 160), extractionConfidence: raw.extractionConfidence,
    reviewReasons: parseReviewReasons(raw.reviewReasons, receivedAt, values.observedAt),
    values, evidenceAvailability: "not-retained",
  });
}

function claimValue(value: unknown): unknown {
  return value === null ? null : objectFields(value, ["value"], false).value;
}

/**
 * Trusted mail-pipeline handoff only. Not a request-body parser or proof of mail
 * ownership: the service still supplies authority and owned persistence bindings.
 * Project scalar claims only; never retain mail text, Gmail IDs, quotes or spans.
 */
export function makeCandidateContent(
  candidate: EmailCandidate,
  binding: { analysisOperationId: string; mailboxBindingId: string; extractedAt: string },
): CandidateContent {
  const raw = objectFields(candidate, [
    "index", "receivedAt", "reviewStatus", "reviewReasons", "extractionConfidence", "benefitKind", "serviceName", "benefitName",
    "unit", "grantedAmount", "remainingAmount", "trialDaysStated", "remainingDaysStated", "expiresAt", "observedAt",
  ], false);
  if (raw.reviewStatus !== "pending-review") return failReview();
  const source = objectFields(binding, ["analysisOperationId", "mailboxBindingId", "extractedAt"], false);
  return parseCandidateContent({
    schema: REVIEW_SCHEMA,
    analysisOperationId: source.analysisOperationId, mailboxBindingId: source.mailboxBindingId,
    candidateIndex: raw.index, policyVersion: MAIL_REVIEW_POLICY,
    extractedAt: source.extractedAt, receivedAt: raw.receivedAt,
    serviceName: claimValue(raw.serviceName), extractionConfidence: raw.extractionConfidence,
    reviewReasons: raw.reviewReasons,
    values: {
      name: claimValue(raw.benefitName), kind: raw.benefitKind, unit: claimValue(raw.unit),
      grantedAmount: claimValue(raw.grantedAmount), remainingAmount: claimValue(raw.remainingAmount),
      trialDaysStated: claimValue(raw.trialDaysStated), remainingDaysStated: claimValue(raw.remainingDaysStated),
      expiresAt: claimValue(raw.expiresAt), observedAt: claimValue(raw.observedAt),
    },
    evidenceAvailability: "not-retained",
  });
}
