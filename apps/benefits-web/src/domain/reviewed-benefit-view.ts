/**
 * Browser-safe reviewed observations, not live balances or active-account proof.
 * This module has no server, vault, provider, authentication or storage imports.
 * Keep day/offset precision and nulls; never cast these records to BenefitRecord.
 */
export const REVIEWED_BENEFIT_VIEW_SCHEMA = "keyatlas.reviewed-benefit-view.v1" as const;
export const MAX_REVIEWED_BENEFIT_ENTRIES = 1000;

const KINDS = ["membership", "trial", "coupon", "credit", "point", "storage", "receipt", "expiration", "other"] as const;
const VALUE_KEYS = ["name", "kind", "unit", "grantedAmount", "remainingAmount", "trialDaysStated",
  "remainingDaysStated", "expiresAt", "observedAt"] as const;
const REASONS = ["USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED",
  "RECEIVED_DATE_UNKNOWN", "OBSERVATION_DATE_UNKNOWN", "PARTIAL_MAIL_TEXT"] as const;

export type ReviewedBenefitKind = typeof KINDS[number];
export type ReviewedBenefitReason = typeof REASONS[number];
export type ReviewedValueOrigin = "email-extracted" | "user-corrected";
export interface ReviewedBenefitValues {
  readonly name: string;
  readonly kind: ReviewedBenefitKind;
  readonly unit: string | null;
  readonly grantedAmount: number | null;
  readonly remainingAmount: number | null;
  readonly trialDaysStated: number | null;
  readonly remainingDaysStated: number | null;
  readonly expiresAt: string | null;
  readonly observedAt: string | null;
}
export interface ReviewedBenefitContent {
  readonly serviceId: string;
  readonly serviceNameAtReview: string;
  readonly values: ReviewedBenefitValues;
  readonly valueOrigins: Readonly<Record<keyof ReviewedBenefitValues, ReviewedValueOrigin>>;
  readonly receivedAt: string | null;
  readonly extractedAt: string;
  // Original email observation, distinct from the user's reviewed values.observedAt.
  readonly sourceObservedAt: string | null;
  readonly reviewedAt: string;
  readonly reviewReasons: readonly ReviewedBenefitReason[];
  readonly reviewStatus: "accepted-by-user";
  readonly accountProof: "not-established";
  readonly currentBalanceProof: "not-established";
}
interface ViewIdentity {
  readonly schema: typeof REVIEWED_BENEFIT_VIEW_SCHEMA;
  readonly dataGeneration: number;
  readonly benefitId: string;
  readonly benefitRevision: number;
}
export type ReviewedBenefitView = ViewIdentity & (
  | { readonly outcome: "saved"; readonly content: ReviewedBenefitContent }
  | { readonly outcome: "deleted"; readonly content: null }
);
export interface ReviewedBenefitViewState {
  // Client-generated opaque namespace per authenticated view. Not a credential.
  readonly viewScope: string;
  readonly dataGeneration: number;
  // Tombstones count toward the cap: evicting one could allow a late resurrection.
  readonly entries: readonly ReviewedBenefitView[];
}
export type ReviewedBenefitViewEvent =
  | { readonly type: "response"; readonly capturedScope: string; readonly payload: unknown }
  | { readonly type: "reset"; readonly viewScope: string; readonly dataGeneration: number };

function invalid(): never { throw new Error("REVIEWED_BENEFIT_VIEW_INVALID"); }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
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
function id(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return invalid();
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return invalid();
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
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}
function recordedDate(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length > 40) return invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return invalid();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > (monthDays[month - 1] ?? 0)) return invalid();
  if (match[4] !== undefined) {
    if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return invalid();
    const zone = match[8]!;
    if (zone !== "Z") {
      const hour = Number(zone.slice(1, 3));
      const minute = Number(zone.slice(4));
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
function values(value: unknown): ReviewedBenefitValues {
  const raw = fields(value, VALUE_KEYS);
  if (!KINDS.includes(raw.kind as ReviewedBenefitKind)) return invalid();
  const result = Object.freeze({ name: label(raw.name, 160), kind: raw.kind as ReviewedBenefitKind,
    unit: nullable(raw.unit, (input) => label(input, 40)),
    grantedAmount: nullable(raw.grantedAmount, amount), remainingAmount: nullable(raw.remainingAmount, amount),
    trialDaysStated: nullable(raw.trialDaysStated, days), remainingDaysStated: nullable(raw.remainingDaysStated, days),
    expiresAt: nullable(raw.expiresAt, recordedDate), observedAt: nullable(raw.observedAt, recordedDate) });
  if ((result.grantedAmount !== null || result.remainingAmount !== null)
    && (result.unit === null || ["membership", "receipt", "expiration"].includes(result.kind))) return invalid();
  return result;
}
function origins(value: unknown): ReviewedBenefitContent["valueOrigins"] {
  const raw = fields(value, VALUE_KEYS);
  const parsed = VALUE_KEYS.map((key) => {
    const origin = raw[key];
    if (origin !== "email-extracted" && origin !== "user-corrected") return invalid();
    return [key, origin] as const;
  });
  return Object.freeze(Object.fromEntries(parsed) as Record<keyof ReviewedBenefitValues, ReviewedValueOrigin>);
}
function reasons(value: unknown, receivedAt: string | null, sourceObservedAt: string | null): readonly ReviewedBenefitReason[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  const length = descriptors.length?.value as unknown;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 3 || length > REASONS.length
    || Reflect.ownKeys(descriptors).length !== length + 1) return invalid();
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
function content(value: unknown): ReviewedBenefitContent {
  const raw = fields(value, ["serviceId", "serviceNameAtReview", "values", "valueOrigins", "receivedAt", "extractedAt",
    "sourceObservedAt", "reviewedAt", "reviewReasons", "reviewStatus", "accountProof", "currentBalanceProof"]);
  if (raw.reviewStatus !== "accepted-by-user" || raw.accountProof !== "not-established"
    || raw.currentBalanceProof !== "not-established") return invalid();
  const reviewedValues = values(raw.values);
  const valueOrigins = origins(raw.valueOrigins);
  const receivedAt = nullable(raw.receivedAt, instant);
  const sourceObservedAt = nullable(raw.sourceObservedAt, recordedDate);
  if (valueOrigins.observedAt !== (reviewedValues.observedAt === sourceObservedAt ? "email-extracted" : "user-corrected")) return invalid();
  return Object.freeze({ serviceId: id(raw.serviceId), serviceNameAtReview: label(raw.serviceNameAtReview, 160),
    values: reviewedValues, valueOrigins, receivedAt, extractedAt: instant(raw.extractedAt), sourceObservedAt,
    reviewedAt: instant(raw.reviewedAt), reviewReasons: reasons(raw.reviewReasons, receivedAt, sourceObservedAt),
    reviewStatus: "accepted-by-user", accountProof: "not-established", currentBalanceProof: "not-established" });
}

/** Unknown decoded JSON only; callers still need transport byte limits and authenticated transport. */
export function decodeReviewedBenefitView(input: unknown): ReviewedBenefitView | null {
  try {
    const raw = fields(input, ["schema", "dataGeneration", "benefitId", "benefitRevision", "outcome", "content"]);
    if (raw.schema !== REVIEWED_BENEFIT_VIEW_SCHEMA || (raw.outcome !== "saved" && raw.outcome !== "deleted")) return null;
    const identity: ViewIdentity = { schema: REVIEWED_BENEFIT_VIEW_SCHEMA, dataGeneration: revision(raw.dataGeneration),
      benefitId: id(raw.benefitId), benefitRevision: revision(raw.benefitRevision) };
    if (raw.outcome === "deleted") {
      if (raw.content !== null) return null;
      return Object.freeze({ ...identity, outcome: "deleted", content: null });
    }
    return Object.freeze({ ...identity, outcome: "saved", content: content(raw.content) });
  } catch {
    return null;
  }
}

/** UI wiring must create a fresh opaque namespace for each explicit authenticated-view reset. */
export function createReviewedBenefitViewState(viewScope: string, dataGeneration: number): ReviewedBenefitViewState {
  return Object.freeze({ viewScope: id(viewScope), dataGeneration: revision(dataGeneration), entries: Object.freeze([]) });
}

/**
 * State must come from this constructor/reducer, not unvalidated local storage.
 * Capture state.viewScope when issuing a request and carry that captured string
 * with its response. NEVER attach the current authenticated scope after awaiting
 * a response: users A and B can both have dataGeneration=1. Scope is only a local
 * stale-response fence, not authorization. Never reuse old scopes on reset.
 * No actual UI/authentication wiring or network/storage side effects live here.
 */
export function reduceReviewedBenefitView(state: ReviewedBenefitViewState, event: unknown): ReviewedBenefitViewState {
  try {
    if (typeof event !== "object" || event === null) return state;
    const descriptor = Object.getOwnPropertyDescriptor(event, "type");
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return state;
    if (descriptor.value === "reset") {
      const raw = fields(event, ["type", "viewScope", "dataGeneration"]);
      // Even a generation change needs an explicit fresh scope; same-scope
      // clearing could erase deletion fences while earlier requests still exist.
      if (raw.viewScope === state.viewScope) return state;
      return createReviewedBenefitViewState(id(raw.viewScope), revision(raw.dataGeneration));
    }
    if (descriptor.value !== "response") return state;
    const raw = fields(event, ["type", "capturedScope", "payload"]);
    // Check namespace BEFORE inspecting payload, even when generations match.
    if (raw.capturedScope !== state.viewScope) return state;
    const incoming = decodeReviewedBenefitView(raw.payload);
    if (!incoming || incoming.dataGeneration !== state.dataGeneration) return state;
    const index = state.entries.findIndex((entry) => entry.benefitId === incoming.benefitId);
    if (index >= 0) {
      const existing = state.entries[index]!;
      // Equal revisions are either idempotent or conflicting; neither replaces
      // existing data. A deleted ID can never return to saved at ANY revision.
      if (incoming.benefitRevision <= existing.benefitRevision
        || (existing.outcome === "deleted" && incoming.outcome === "saved")) return state;
    } else if (state.entries.length >= MAX_REVIEWED_BENEFIT_ENTRIES) return state;
    const entries = [...state.entries];
    if (index < 0) entries.push(incoming);
    else entries[index] = incoming;
    return Object.freeze({ viewScope: state.viewScope, dataGeneration: state.dataGeneration, entries: Object.freeze(entries) });
  } catch {
    return state;
  }
}
