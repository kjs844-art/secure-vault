import type { SubscriptionStatus } from "../../domain/benefits";
import { MAX_SERVICE_PAGE, type CatalogCursor, type ServiceProfile } from "./contracts";
import {
  failReview, label, objectFields, parseId, parseRevision, recordedDate,
} from "../review/validation";

const STATUSES: readonly SubscriptionStatus[] = [
  "active", "trial", "trial_ended", "paused", "cancelled", "unknown",
];
const PROFILE_KEYS = [
  "name", "provider", "planName", "accountLabel", "timezone", "subscriptionStatus", "trialEndsAt", "notes",
];
function nullableLabel(value: unknown): string | null {
  return value === null ? null : label(value, 160);
}
function timezone(value: unknown): string | null {
  if (value === null) return null;
  const result = label(value, 64);
  // Validate only; never substitute a machine zone or normalize an unknown zone.
  try { new Intl.DateTimeFormat("en", { timeZone: result }); }
  catch { return failReview(); }
  return result;
}
function notes(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 2048
    || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || /[\uD800-\uDFFF]/u.test(value)) return failReview();
  return value;
}
/** Bounded text is NOT a secret detector, HTML sanitizer, or account verification. */
export function parseServiceProfile(value: unknown): ServiceProfile {
  const raw = objectFields(value, PROFILE_KEYS);
  if (!STATUSES.includes(raw.subscriptionStatus as SubscriptionStatus)) return failReview();
  return Object.freeze({
    name: label(raw.name, 160), provider: nullableLabel(raw.provider),
    planName: nullableLabel(raw.planName), accountLabel: nullableLabel(raw.accountLabel),
    timezone: timezone(raw.timezone), subscriptionStatus: raw.subscriptionStatus as SubscriptionStatus,
    trialEndsAt: raw.trialEndsAt === null ? null : recordedDate(raw.trialEndsAt), notes: notes(raw.notes),
  });
}
export function parseCreate(value: unknown) {
  const raw = objectFields(value, ["operationId", "decision", "profile"]);
  if (raw.decision !== "create") return failReview();
  return Object.freeze({ operationId: parseId(raw.operationId), decision: "create" as const,
    profile: parseServiceProfile(raw.profile) });
}
export function parseUpdate(value: unknown) {
  const raw = objectFields(value, ["serviceId", "expectedRevision", "operationId", "decision", "profile"]);
  if (raw.decision !== "update") return failReview();
  return Object.freeze({ serviceId: parseId(raw.serviceId), expectedRevision: parseRevision(raw.expectedRevision),
    operationId: parseId(raw.operationId), decision: "update" as const, profile: parseServiceProfile(raw.profile) });
}
export function parseRemove(value: unknown) {
  const raw = objectFields(value, ["serviceId", "expectedRevision", "operationId", "decision"]);
  if (raw.decision !== "delete") return failReview();
  return Object.freeze({ serviceId: parseId(raw.serviceId), expectedRevision: parseRevision(raw.expectedRevision),
    operationId: parseId(raw.operationId), decision: "delete" as const });
}
export function parseGet(value: unknown) {
  const raw = objectFields(value, ["serviceId"]);
  return Object.freeze({ serviceId: parseId(raw.serviceId) });
}
export function parseList(value: unknown) {
  const raw = objectFields(value, ["limit", "cursor"]);
  if (typeof raw.limit !== "number" || !Number.isSafeInteger(raw.limit)
    || raw.limit < 1 || raw.limit > MAX_SERVICE_PAGE) return failReview();
  let cursor: CatalogCursor | null = null;
  if (raw.cursor !== null) {
    const fields = objectFields(raw.cursor, ["afterId", "catalogRevision", "dataGeneration"]);
    cursor = Object.freeze({ afterId: parseId(fields.afterId), catalogRevision: parseRevision(fields.catalogRevision),
      dataGeneration: parseRevision(fields.dataGeneration) });
  }
  return Object.freeze({ limit: raw.limit, cursor });
}
