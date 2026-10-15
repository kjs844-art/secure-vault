import type { RunAuthority } from "../mail/run-analysis";
import { failReview, objectFields, parseId, parseRevision } from "../review/validation";
import { MAX_PENDING_WINDOW_MS, STAGING_POLICY, type CandidateBatchRow, type CandidateStagingGrant } from "./contracts";

export function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 253402300799999) {
    return failReview();
  }
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value
    || value.startsWith("0000-")) return failReview();
  return value;
}

export function parseStagingGrant(value: unknown, source: RunAuthority, extractedAt: string, now: number): CandidateStagingGrant {
  timestamp(now);
  const raw = objectFields(value, ["id", "revision", "ownerId", "sessionId", "sessionRevision", "dataGeneration",
    "analysisOperationId", "mailboxBindingId", "recipientId", "analysisGrantId", "analysisGrantRevision",
    "policyVersion", "allowCandidateStorage", "expiresAt", "pendingAccessUntil"]);
  const expiresAt = timestamp(raw.expiresAt);
  const pendingAccessUntil = timestamp(raw.pendingAccessUntil);
  const extractedTime = Date.parse(instant(extractedAt));
  if (raw.ownerId !== source.ownerId || raw.sessionId !== source.sessionId
    || raw.sessionRevision !== source.sessionRevision || raw.dataGeneration !== source.dataGeneration
    || raw.analysisOperationId !== source.operationId || raw.mailboxBindingId !== source.mailboxBindingId
    || raw.recipientId !== source.recipientId || raw.analysisGrantId !== source.grantId
    || raw.analysisGrantRevision !== source.grantRevision || raw.policyVersion !== STAGING_POLICY
    || raw.allowCandidateStorage !== true || expiresAt <= now || pendingAccessUntil <= now
    || extractedTime > now || pendingAccessUntil > extractedTime + MAX_PENDING_WINDOW_MS) return failReview();
  return Object.freeze({ id: parseId(raw.id), revision: parseRevision(raw.revision),
    ownerId: source.ownerId, sessionId: source.sessionId, sessionRevision: source.sessionRevision,
    dataGeneration: source.dataGeneration, analysisOperationId: source.operationId,
    mailboxBindingId: source.mailboxBindingId, recipientId: source.recipientId,
    analysisGrantId: source.grantId, analysisGrantRevision: source.grantRevision,
    policyVersion: STAGING_POLICY, allowCandidateStorage: true, expiresAt, pendingAccessUntil });
}

export function parseBatch(value: unknown): CandidateBatchRow {
  const raw = objectFields(value, ["ownerId", "dataGeneration", "analysisOperationId", "mailboxBindingId",
    "extractedAt", "pendingAccessUntil", "fingerprint", "candidateIds"]);
  if (typeof raw.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(raw.fingerprint)
    || raw.fingerprint.length !== 64 || !Array.isArray(raw.candidateIds)
    || Object.getPrototypeOf(raw.candidateIds) !== Array.prototype) return failReview();
  const descriptors = Object.getOwnPropertyDescriptors(raw.candidateIds as object);
  const length = descriptors.length?.value as unknown;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 100
    || Reflect.ownKeys(descriptors).length !== length + 1) return failReview();
  const ids: string[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return failReview();
    const id = parseId(descriptor.value as unknown);
    if (ids.includes(id)) return failReview();
    ids.push(id);
  }
  const extractedAt = instant(raw.extractedAt);
  const pendingAccessUntil = timestamp(raw.pendingAccessUntil);
  if (pendingAccessUntil <= Date.parse(extractedAt)
    || pendingAccessUntil > Date.parse(extractedAt) + MAX_PENDING_WINDOW_MS) return failReview();
  return Object.freeze({ ownerId: parseId(raw.ownerId), dataGeneration: parseRevision(raw.dataGeneration),
    analysisOperationId: parseId(raw.analysisOperationId), mailboxBindingId: parseId(raw.mailboxBindingId),
    extractedAt, pendingAccessUntil, fingerprint: raw.fingerprint, candidateIds: Object.freeze(ids) });
}

export function parseListBatch(value: unknown) {
  const raw = objectFields(value, ["analysisOperationId"]);
  return Object.freeze({ analysisOperationId: parseId(raw.analysisOperationId) });
}
export function parseDiscard(value: unknown) {
  const raw = objectFields(value, ["candidateId", "expectedRevision", "decision"]);
  if (raw.decision !== "discard") return failReview();
  return Object.freeze({ candidateId: parseId(raw.candidateId), expectedRevision: parseRevision(raw.expectedRevision),
    decision: "discard" as const });
}
