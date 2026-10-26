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
const PROFILE_FIELDS = ["name", "provider", "planName", "accountLabel", "timezone", "subscriptionStatus", "trialEndsAt", "notes"] as const;
function profile(input: CatalogServiceProfileInput): Record<string, unknown> {
  const fields = exactFields(input, PROFILE_FIELDS);
  return Object.freeze({ name: text(fields.name, 160), provider: nullableText(fields.provider, 160),
    planName: nullableText(fields.planName, 160), accountLabel: nullableText(fields.accountLabel, 160),
    timezone: timezone(fields.timezone), subscriptionStatus: status(fields.subscriptionStatus),
    trialEndsAt: trialEndsAt(fields.trialEndsAt), notes: notes(fields.notes) });
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
    const raw = exactFields(cursor, ["afterId", "catalogRevision", "dataGeneration"]);
    parsed = Object.freeze({ afterId: identifier(raw.afterId), catalogRevision: revisionNumber(raw.catalogRevision),
      dataGeneration: revisionNumber(raw.dataGeneration) });
  }
  return Object.freeze({ action: "list", body: Object.freeze({ limit, cursor: parsed }) });
}

function exactFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(descriptors);
    if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) fail();
    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail();
      fields[key] = descriptor.value as unknown;
    }
    return fields;
  } catch {
    // Reflection can execute Proxy traps. Do not echo their exceptions; this
    // validates data records, not a sandbox for arbitrary JavaScript objects.
    return fail();
  }
}

/** Detach before transport; plain-object getters/toJSON hooks are not invoked. */
export function snapshotCatalogRequest(input: unknown): CatalogRequest {
  const request = exactFields(input, ["action", "body"]);
  const snapshotProfile = (value: unknown) => exactFields(value, PROFILE_FIELDS) as unknown as CatalogServiceProfileInput;
  switch (request.action) {
    case "create": {
      const body = exactFields(request.body, ["operationId", "decision", "profile"]);
      if (body.decision !== "create") fail();
      return createCatalogCreateRequest(body.operationId, snapshotProfile(body.profile));
    }
    case "update": {
      const body = exactFields(request.body, ["serviceId", "expectedRevision", "operationId", "decision", "profile"]);
      if (body.decision !== "update") fail();
      return createCatalogUpdateRequest(body.serviceId, body.expectedRevision, body.operationId, snapshotProfile(body.profile));
    }
    case "delete": {
      const body = exactFields(request.body, ["serviceId", "expectedRevision", "operationId", "decision"]);
      if (body.decision !== "delete") fail();
      return createCatalogDeleteRequest(body.serviceId, body.expectedRevision, body.operationId);
    }
    case "get": {
      const body = exactFields(request.body, ["serviceId"]);
      return createCatalogGetRequest(body.serviceId);
    }
    case "list": {
      const body = exactFields(request.body, ["limit", "cursor"]);
      const cursor = body.cursor === null ? null : exactFields(body.cursor, ["afterId", "catalogRevision", "dataGeneration"]);
      return createCatalogListRequest(body.limit, cursor);
    }
    default: return fail();
  }
}
