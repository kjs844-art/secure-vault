/**
 * Catalog request value construction. Unknown-origin input is converted to
 * request bodies or rejected before any transport is involved.
 * No server imports, no storage, no cookies, no logging.
 */
export interface CatalogServiceProfileInput {
  readonly name: unknown;
  readonly provider: unknown;
  readonly planName: unknown;
  readonly accountLabel: unknown;
  readonly timezone: unknown;
  readonly subscriptionStatus: unknown;
  readonly trialEndsAt: unknown;
  readonly notes: unknown;
}

export interface CatalogCreateRequest {
  readonly action: "create";
  readonly body: { readonly operationId: string; readonly decision: "create"; readonly profile: Record<string, unknown> };
}
export interface CatalogUpdateRequest {
  readonly action: "update";
  readonly body: { readonly serviceId: string; readonly expectedRevision: number; readonly operationId: string;
    readonly decision: "update"; readonly profile: Record<string, unknown> };
}
export interface CatalogDeleteRequest {
  readonly action: "delete";
  readonly body: { readonly serviceId: string; readonly expectedRevision: number; readonly operationId: string;
    readonly decision: "delete" };
}
export interface CatalogGetRequest {
  readonly action: "get";
  readonly body: { readonly serviceId: string };
}
export interface CatalogListRequest {
  readonly action: "list";
  readonly body: { readonly limit: number; readonly cursor: { readonly afterId: string; readonly catalogRevision: number;
    readonly dataGeneration: number } | null };
}
export type CatalogRequest =
  | CatalogCreateRequest | CatalogUpdateRequest | CatalogDeleteRequest | CatalogGetRequest | CatalogListRequest;

export type CatalogRequestFailure =
  | "CATALOG_INPUT_INVALID";

function fail(): never { throw new Error("CATALOG_INPUT_INVALID"); }
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
function status(value: unknown): string {
  if (!["active", "trial", "trial_ended", "paused", "cancelled", "unknown"].includes(value as string)) fail();
  return value as string;
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
function profile(input: CatalogServiceProfileInput): Record<string, unknown> {
  return Object.freeze({ name: text(input.name, 160), provider: nullableText(input.provider, 160),
    planName: nullableText(input.planName, 160), accountLabel: nullableText(input.accountLabel, 160),
    timezone: timezone(input.timezone), subscriptionStatus: status(input.subscriptionStatus),
    trialEndsAt: trialEndsAt(input.trialEndsAt), notes: notes(input.notes) });
}

export function createCatalogCreateRequest(operationId: unknown, input: CatalogServiceProfileInput): CatalogCreateRequest {
  return Object.freeze({ action: "create", body: Object.freeze({ operationId: identifier(operationId),
    decision: "create", profile: profile(input) }) });
}
export function createCatalogUpdateRequest(serviceId: unknown, expectedRevision: unknown, operationId: unknown,
  input: CatalogServiceProfileInput): CatalogUpdateRequest {
  return Object.freeze({ action: "update", body: Object.freeze({ serviceId: identifier(serviceId),
    expectedRevision: revisionNumber(expectedRevision), operationId: identifier(operationId),
    decision: "update", profile: profile(input) }) });
}
export function createCatalogDeleteRequest(serviceId: unknown, expectedRevision: unknown,
  operationId: unknown): CatalogDeleteRequest {
  return Object.freeze({ action: "delete", body: Object.freeze({ serviceId: identifier(serviceId),
    expectedRevision: revisionNumber(expectedRevision), operationId: identifier(operationId),
    decision: "delete" }) });
}
export function createCatalogGetRequest(serviceId: unknown): CatalogGetRequest {
  return Object.freeze({ action: "get", body: Object.freeze({ serviceId: identifier(serviceId) }) });
}
export function createCatalogListRequest(limit: unknown,
  cursor: unknown): CatalogListRequest {
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail();
  let parsed: CatalogListRequest["body"]["cursor"] = null;
  if (cursor !== null) {
    if (typeof cursor !== "object") fail();
    const keys = Object.keys(cursor).sort();
    if (keys.length !== 3 || !keys.includes("afterId") || !keys.includes("catalogRevision")
      || !keys.includes("dataGeneration")) fail();
    const raw = cursor as Record<string, unknown>;
    parsed = Object.freeze({ afterId: identifier(raw.afterId), catalogRevision: revisionNumber(raw.catalogRevision),
      dataGeneration: revisionNumber(raw.dataGeneration) });
  }
  return Object.freeze({ action: "list", body: Object.freeze({ limit, cursor: parsed }) });
}
