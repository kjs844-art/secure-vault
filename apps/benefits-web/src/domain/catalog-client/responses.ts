/**
 * Catalog response validation from unknown JSON. Types are validated from
 * unknown, never trusted from declarations. No server imports.
 */
export const CATALOG_VIEW_SCHEMA = "keyatlas.service-catalog.v1" as const;

export type CatalogSubscriptionStatus = "active" | "trial" | "trial_ended" | "paused" | "cancelled" | "unknown";
export interface CatalogServiceProfileView {
  readonly name: string;
  readonly provider: string | null;
  readonly planName: string | null;
  readonly accountLabel: string | null;
  readonly timezone: string | null;
  readonly subscriptionStatus: CatalogSubscriptionStatus;
  readonly trialEndsAt: string | null;
  readonly notes: string | null;
}
export interface CatalogServiceView {
  readonly schema: typeof CATALOG_VIEW_SCHEMA;
  readonly dataGeneration: number;
  readonly serviceId: string;
  readonly serviceRevision: number;
  readonly state: "live" | "deleted";
  readonly profile: CatalogServiceProfileView | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly provenance: "user-reported";
  readonly accountProof: "not-established";
}
export interface CatalogReceiptView {
  readonly operationId: string;
  readonly replayed: boolean;
  readonly service: CatalogServiceView;
}
export interface CatalogCursorView {
  readonly afterId: string;
  readonly catalogRevision: number;
  readonly dataGeneration: number;
}
export interface CatalogPageView {
  readonly schema: typeof CATALOG_VIEW_SCHEMA;
  readonly dataGeneration: number;
  readonly catalogRevision: number;
  readonly services: readonly CatalogServiceView[];
  readonly nextCursor: CatalogCursorView | null;
}
export type CatalogSuccess =
  | { readonly kind: "receipt"; readonly receipt: CatalogReceiptView }
  | { readonly kind: "view"; readonly view: CatalogServiceView }
  | { readonly kind: "page"; readonly page: CatalogPageView };

export type CatalogHttpErrorCode =
  | "API_NOT_FOUND" | "API_METHOD_NOT_ALLOWED" | "API_REQUEST_REJECTED" | "API_MEDIA_TYPE"
  | "API_BODY_TOO_LARGE" | "API_INPUT_INVALID" | "API_AUTH_REQUIRED" | "API_SESSION_CHANGED"
  | "API_RATE_LIMITED" | "API_CONFLICT" | "API_UNAVAILABLE" | "API_TIMEOUT" | "API_ABORTED";

const ERRORS: readonly CatalogHttpErrorCode[] = ["API_NOT_FOUND", "API_METHOD_NOT_ALLOWED", "API_REQUEST_REJECTED",
  "API_MEDIA_TYPE", "API_BODY_TOO_LARGE", "API_INPUT_INVALID", "API_AUTH_REQUIRED", "API_SESSION_CHANGED",
  "API_RATE_LIMITED", "API_CONFLICT", "API_UNAVAILABLE", "API_TIMEOUT", "API_ABORTED"];
const PROFILE_KEYS = ["name", "provider", "planName", "accountLabel", "timezone", "subscriptionStatus", "trialEndsAt", "notes"];
const STATUSES: readonly CatalogSubscriptionStatus[] = ["active", "trial", "trial_ended", "paused", "cancelled", "unknown"];

function fail(): never { throw new Error("CATALOG_RESPONSE_INVALID"); }
function objectFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) fail();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail();
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > maximum
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || /[\uD800-\uDFFF]/u.test(value)) fail();
  return value;
}
function nullableText(value: unknown, maximum: number): string | null {
  return value === null ? null : text(value, maximum);
}
function notes(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 2048
    || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || /[\uD800-\uDFFF]/u.test(value)) fail();
  return value;
}
function timezone(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value, 64);
  try { new Intl.DateTimeFormat("en", { timeZone: result }); } catch { fail(); }
  return result;
}
function trialEndsAt(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() !== value || value.length > 40) fail();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) fail();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > (monthDays[month - 1] ?? 0)) fail();
  if (match[4] !== undefined) {
    if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) fail();
    const zone = match[8]!;
    if (zone !== "Z") {
      const zoneHour = Number(zone.slice(1, 3));
      const zoneMinute = Number(zone.slice(4));
      if (zone === "-00:00" || zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) fail();
    }
  }
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail();
  return value;
}
function revisionNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail();
  return value;
}
function epoch(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 253402300799999) fail();
  return value;
}
function profile(value: unknown): CatalogServiceProfileView {
  const raw = objectFields(value, PROFILE_KEYS);
  if (!STATUSES.includes(raw.subscriptionStatus as CatalogSubscriptionStatus)) fail();
  return Object.freeze({ name: text(raw.name, 160), provider: nullableText(raw.provider, 160),
    planName: nullableText(raw.planName, 160), accountLabel: nullableText(raw.accountLabel, 160),
    timezone: timezone(raw.timezone), subscriptionStatus: raw.subscriptionStatus as CatalogSubscriptionStatus,
    trialEndsAt: trialEndsAt(raw.trialEndsAt), notes: notes(raw.notes) });
}
function serviceView(value: unknown): CatalogServiceView {
  const raw = objectFields(value, ["schema", "dataGeneration", "serviceId", "serviceRevision", "state", "profile",
    "createdAt", "updatedAt", "provenance", "accountProof"]);
  if (raw.schema !== CATALOG_VIEW_SCHEMA || (raw.state !== "live" && raw.state !== "deleted")
    || raw.provenance !== "user-reported" || raw.accountProof !== "not-established") fail();
  if (raw.state === "deleted" && raw.profile !== null) fail();
  return Object.freeze({ schema: CATALOG_VIEW_SCHEMA, dataGeneration: revisionNumber(raw.dataGeneration),
    serviceId: identifier(raw.serviceId), serviceRevision: revisionNumber(raw.serviceRevision), state: raw.state,
    profile: raw.profile === null ? null : profile(raw.profile), createdAt: epoch(raw.createdAt),
    updatedAt: epoch(raw.updatedAt), provenance: "user-reported", accountProof: "not-established" });
}
function cursor(value: unknown): CatalogCursorView {
  const raw = objectFields(value, ["afterId", "catalogRevision", "dataGeneration"]);
  return Object.freeze({ afterId: identifier(raw.afterId), catalogRevision: revisionNumber(raw.catalogRevision),
    dataGeneration: revisionNumber(raw.dataGeneration) });
}
function receipt(value: unknown): CatalogReceiptView {
  const raw = objectFields(value, ["operationId", "replayed", "service"]);
  if (typeof raw.replayed !== "boolean") fail();
  return Object.freeze({ operationId: identifier(raw.operationId), replayed: raw.replayed,
    service: serviceView(raw.service) });
}
function singleView(value: unknown): CatalogServiceView {
  return serviceView(value);
}
function page(value: unknown): CatalogPageView {
  const raw = objectFields(value, ["schema", "dataGeneration", "catalogRevision", "services", "nextCursor"]);
  if (raw.schema !== CATALOG_VIEW_SCHEMA) fail();
  if (!Array.isArray(raw.services) || Object.getPrototypeOf(raw.services) !== Array.prototype
    || raw.services.length > 50) fail();
  const descriptors = Object.getOwnPropertyDescriptors(raw.services);
  if (Reflect.ownKeys(descriptors).length !== raw.services.length + 1) fail();
  const services = raw.services.map((entry) => serviceView(entry));
  for (let index = 1; index < services.length; index++) {
    if (services[index]!.serviceId <= services[index - 1]!.serviceId) fail();
  }
  return Object.freeze({ schema: CATALOG_VIEW_SCHEMA, dataGeneration: revisionNumber(raw.dataGeneration),
    catalogRevision: revisionNumber(raw.catalogRevision), services: Object.freeze(services),
    nextCursor: raw.nextCursor === null ? null : cursor(raw.nextCursor) });
}

/** Validate one catalog success payload from unknown decoded JSON. */
export function decodeCatalogSuccess(action: "create" | "update" | "delete" | "get" | "list",
  payload: unknown): CatalogSuccess | null {
  try {
    if (action === "create" || action === "update" || action === "delete") {
      return Object.freeze({ kind: "receipt", receipt: receipt(payload) });
    }
    if (action === "get") return Object.freeze({ kind: "view", view: singleView(payload) });
    return Object.freeze({ kind: "page", page: page(payload) });
  } catch {
    return null;
  }
}

/** Validate one fixed catalog error envelope from unknown decoded JSON. */
export function decodeCatalogError(payload: unknown): CatalogHttpErrorCode | null {
  try {
    const raw = objectFields(payload, ["ok", "code"]);
    if (raw.ok !== false || typeof raw.code !== "string") return null;
    return ERRORS.includes(raw.code as CatalogHttpErrorCode) ? raw.code as CatalogHttpErrorCode : null;
  } catch {
    return null;
  }
}
