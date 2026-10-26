import {
  REVIEW_SCHEMA,
  type CandidateContent, type CandidateRow, type PreviewRow, type ReviewedBenefitRow,
  type ReviewAuthority, type ReviewDependencies, type ReviewOperation,
  type ReviewServiceRow, type ReviewValues,
} from "../../src/server/review/contracts.ts";
import { STAGING_POLICY, type CandidateBatchRow, type CandidateInboxDependencies,
  type CandidateStagingGrant } from "../../src/server/inbox/contracts.ts";
import type { CandidateBatchMapping, CandidateBatchReferenceDependencies, CandidateBatchReferenceRow,
  CandidateReferenceTransaction } from "../../src/server/inbox/batch-reference-contracts.ts";
import { parseBatch } from "../../src/server/inbox/validation.ts";
import { objectFields, parseId, parseRevision } from "../../src/server/review/validation.ts";
import { MAIL_ANALYSIS_POLICY, type RunAuthority } from "../../src/server/mail/run-analysis.ts";
import { DELETED_SERVICE_NAME, type CatalogDependencies, type CatalogOperation,
  type CatalogServiceRow, type CatalogTransaction } from "../../src/server/catalog/contracts.ts";

// SYNTHETIC TEST SUPPORT ONLY. A serialized in-memory snapshot is not a real DB,
// durable persistence, transaction-isolation evidence, RLS, or verified auth.
export const REVIEW_NOW = Date.parse("2026-09-28T00:00:00.000Z");
export const SYNTHETIC_PRIVATE = "SYNTHETIC_REVIEW_PRIVATE_ADAPTER_DETAIL";
export const REVIEW_OWNER = "synthetic-owner";
export const CANDIDATE_ID = "synthetic-candidate";
export const SERVICE_ID = "synthetic-service";

export function reviewAuthority(patch: Partial<ReviewAuthority> = {}): ReviewAuthority {
  return { ownerId: REVIEW_OWNER, sessionId: "synthetic-session", sessionRevision: 1,
    dataGeneration: 1, expiresAt: REVIEW_NOW + 600000, ...patch };
}

export function reviewValues(patch: Partial<ReviewValues> = {}): ReviewValues {
  return { name: "Synthetic credits", kind: "credit", unit: "credits", grantedAmount: 100,
    remainingAmount: null, trialDaysStated: null, remainingDaysStated: null,
    expiresAt: null, observedAt: null, ...patch };
}

export function candidateContent(patch: Partial<CandidateContent> = {}): CandidateContent {
  return { schema: REVIEW_SCHEMA, analysisOperationId: "synthetic-analysis-operation",
    mailboxBindingId: "synthetic-mailbox", candidateIndex: 0,
    policyVersion: "keyatlas.gmail-review.v1", extractedAt: new Date(REVIEW_NOW).toISOString(),
    receivedAt: null, serviceName: "Synthetic Studio", extractionConfidence: "high",
    reviewReasons: ["USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED",
      "RECEIVED_DATE_UNKNOWN", "OBSERVATION_DATE_UNKNOWN"],
    values: reviewValues(), evidenceAvailability: "not-retained", ...patch };
}

export function candidateRow(patch: Partial<CandidateRow> = {}): CandidateRow {
  return { id: CANDIDATE_ID, ownerId: REVIEW_OWNER, dataGeneration: 1, revision: 1,
    expiresAt: REVIEW_NOW + 86400000, state: "pending", content: candidateContent(), ...patch };
}

export function analysisAuthority(patch: Partial<RunAuthority> = {}): RunAuthority {
  return { ownerId: REVIEW_OWNER, sessionId: "synthetic-session", sessionRevision: 1, dataGeneration: 1,
    sessionExpiresAt: REVIEW_NOW + 600000, mailboxBindingId: "synthetic-mailbox", grantId: "synthetic-analysis-grant",
    grantRevision: 1, grantExpiresAt: REVIEW_NOW + 600000, operationId: "synthetic-analysis-operation",
    recipientId: "synthetic-analyzer", policyVersion: MAIL_ANALYSIS_POLICY.version,
    mailRead: true, externalAnalysis: true, ...patch };
}

export function stagingGrant(patch: Partial<CandidateStagingGrant> = {}): CandidateStagingGrant {
  const analysis = analysisAuthority();
  return { id: "synthetic-staging-grant", revision: 1, ownerId: analysis.ownerId,
    sessionId: analysis.sessionId, sessionRevision: analysis.sessionRevision, dataGeneration: analysis.dataGeneration,
    analysisOperationId: analysis.operationId, mailboxBindingId: analysis.mailboxBindingId,
    recipientId: analysis.recipientId, analysisGrantId: analysis.grantId, analysisGrantRevision: analysis.grantRevision,
    policyVersion: STAGING_POLICY, allowCandidateStorage: true,
    expiresAt: REVIEW_NOW + 600000, pendingAccessUntil: REVIEW_NOW + 86400000, ...patch };
}

export function serviceRow(patch: Partial<ReviewServiceRow> = {}): ReviewServiceRow {
  return { id: SERVICE_ID, ownerId: REVIEW_OWNER, dataGeneration: 1, revision: 1,
    state: "live", name: "Synthetic Studio", ...patch };
}

export interface MemoryRows {
  candidates: Map<string, CandidateRow>;
  services: Map<string, ReviewServiceRow>;
  previews: Map<string, PreviewRow>;
  benefits: Map<string, ReviewedBenefitRow>;
  operations: Map<string, ReviewOperation>;
  batches: Map<string, CandidateBatchRow>;
  batchReferences: Map<string, CandidateBatchReferenceRow>;
  // Global-reference uniqueness and owner/operation uniqueness survive retirement.
  batchReferenceSlots: Map<string, string>;
  // Synthetic unique-index metadata survives candidate payload erasure.
  candidateSlots: Map<string, string>;
  catalogOperations: Map<string, CatalogOperation>;
  catalogRevisions: Map<string, number>;
  benefitsRevisions: Map<string, number>;
}
type MemoryTransaction = CandidateReferenceTransaction & CatalogTransaction;
type Method = keyof MemoryTransaction;
type ConditionalMethod = "insertPreview" | "insertBenefit" | "insertOperation"
  | "updateCandidate" | "updatePreview" | "updateBenefit" | "insertCandidate" | "insertCandidateBatch"
  | "insertCatalogService" | "updateCatalogService" | "insertCatalogOperation" | "advanceCatalogRevision"
  | "advanceBenefitCollectionRevision" | "insertBatchReference" | "retireBatchReference";
export interface MemoryControls {
  authority: unknown;
  now: number;
  authorityReads: number;
  transactions: number;
  commits: number;
  rollbacks: number;
  trace: string[];
  analysisAuthority: unknown;
  stagingGrant: unknown;
  analysisChecks: number;
  stagingGrantReads: number;
  isAnalysisAuthorized?: (expected: RunAuthority, call: number) => boolean | Promise<boolean>;
  readStagingGrant?: (expected: RunAuthority, call: number) => unknown | Promise<unknown>;
  falseMethod?: ConditionalMethod;
  readAuthority?: (call: number) => unknown | Promise<unknown>;
  beforeMethod?: (method: Method) => void | Promise<void>;
  afterMethod?: (method: Method) => void | Promise<void>;
  beforeEntry?: () => void | Promise<void>;
  beforeCommit?: () => void | Promise<void>;
  afterCommit?: () => void | Promise<void>;
}

export const operationKey = (ownerId: string, operationId: string) => JSON.stringify([ownerId, operationId]);
export const catalogRevisionKey = (ownerId: string, dataGeneration: number) => JSON.stringify([ownerId, dataGeneration]);
export const benefitCollectionRevisionKey = (ownerId: string, dataGeneration: number) => JSON.stringify([ownerId, dataGeneration]);
const clone = <T>(value: T): T => structuredClone(value);

export function createReviewMemoryStore() {
  let rows: MemoryRows = {
    candidates: new Map([[CANDIDATE_ID, candidateRow()]]),
    services: new Map([[SERVICE_ID, serviceRow()]]), previews: new Map(), benefits: new Map(), operations: new Map(),
    batches: new Map(), batchReferences: new Map(), batchReferenceSlots: new Map(), candidateSlots: new Map(),
    catalogOperations: new Map(), catalogRevisions: new Map(), benefitsRevisions: new Map(),
  };
  const controls: MemoryControls = { authority: reviewAuthority(), now: REVIEW_NOW,
    authorityReads: 0, transactions: 0, commits: 0, rollbacks: 0, trace: [],
    analysisAuthority: analysisAuthority(), stagingGrant: stagingGrant(), analysisChecks: 0, stagingGrantReads: 0 };
  let serial = Promise.resolve();
  let idSequence = 0;
  let referenceSequence = 0;

  function assertAuthority(expected: ReviewAuthority) {
    // This models a trusted adapter's atomic entry/commit predicate only.
    const raw = controls.authority as ReviewAuthority | null;
    if (!raw || raw.ownerId !== expected.ownerId || raw.sessionId !== expected.sessionId
      || raw.sessionRevision !== expected.sessionRevision || raw.dataGeneration !== expected.dataGeneration
      || raw.expiresAt !== expected.expiresAt || raw.expiresAt <= controls.now) {
      throw new Error(SYNTHETIC_PRIVATE);
    }
  }

  function matches(current: unknown, expected: object): boolean {
    return typeof current === "object" && current !== null
      && Object.entries(expected).every(([key, value]) => (current as Record<string, unknown>)[key] === value);
  }
  function analysisAllowed(expected: RunAuthority): boolean {
    return matches(controls.analysisAuthority, expected) && expected.sessionExpiresAt > controls.now
      && expected.grantExpiresAt > controls.now;
  }
  function assertStaging(authority: ReviewAuthority, analysis: RunAuthority, grant: CandidateStagingGrant) {
    if (!analysisAllowed(analysis) || !matches(controls.stagingGrant, grant)
      || grant.ownerId !== authority.ownerId || grant.sessionId !== authority.sessionId
      || grant.sessionRevision !== authority.sessionRevision || grant.dataGeneration !== authority.dataGeneration
      || analysis.ownerId !== authority.ownerId || analysis.sessionId !== authority.sessionId
      || analysis.sessionRevision !== authority.sessionRevision || analysis.dataGeneration !== authority.dataGeneration
      || grant.analysisOperationId !== analysis.operationId || grant.mailboxBindingId !== analysis.mailboxBindingId
      || grant.recipientId !== analysis.recipientId || grant.analysisGrantId !== analysis.grantId
      || grant.analysisGrantRevision !== analysis.grantRevision || grant.allowCandidateStorage !== true
      || grant.policyVersion !== STAGING_POLICY || grant.expiresAt <= controls.now || grant.pendingAccessUntil <= controls.now) {
      throw new Error(SYNTHETIC_PRIVATE);
    }
  }
  interface CommitRequirements {
    notAfter: number;
    staging: Array<{ analysis: RunAuthority; grant: CandidateStagingGrant }>;
    services: Array<{ id: string; revision: number }>;
    noLiveBenefits: string[];
    references: CandidateBatchMapping[];
    insertedReferences: Set<string>;
    referenceBatches: Map<string, { before: CandidateBatchRow | null; expected: CandidateBatchRow }>;
  }
  function sameMapping(left: CandidateBatchMapping, right: CandidateBatchMapping): boolean {
    return left.batchReference === right.batchReference && left.ownerId === right.ownerId
      && left.dataGeneration === right.dataGeneration && left.analysisOperationId === right.analysisOperationId;
  }
  function sameReference(left: CandidateBatchReferenceRow, right: CandidateBatchReferenceRow): boolean {
    return validReference(left) && validReference(right) && sameMapping(left, right)
      && left.state === right.state && left.revision === right.revision;
  }
  function validReference(row: CandidateBatchReferenceRow): boolean {
    try {
      const fields = objectFields(row, ["batchReference", "ownerId", "dataGeneration", "analysisOperationId", "state", "revision"]);
      parseId(fields.batchReference); parseId(fields.ownerId); parseId(fields.analysisOperationId); parseRevision(fields.dataGeneration);
      return fields.state === "active" && fields.revision === 1 || fields.state === "retired" && fields.revision === 2;
    } catch { return false; }
  }
  function sameMap<T>(left: Map<string, T>, right: Map<string, T>, equal: (a: T, b: T) => boolean): boolean {
    return left.size === right.size && [...left].every(([key, value]) => right.has(key) && equal(value, right.get(key)!));
  }
  const sameBatch = (left: CandidateBatchRow, right: CandidateBatchRow): boolean =>
    JSON.stringify(parseBatch(left)) === JSON.stringify(parseBatch(right));
  function assertActiveReference(data: MemoryRows, authority: ReviewAuthority, expected: CandidateBatchMapping): void {
    const row = data.batchReferences.get(expected.batchReference);
    if (!row || !validReference(row) || row.state !== "active" || row.revision !== 1 || !sameMapping(row, expected)
      || row.ownerId !== authority.ownerId || row.dataGeneration !== authority.dataGeneration
      || data.batchReferenceSlots.get(operationKey(row.ownerId, row.analysisOperationId)) !== row.batchReference) {
      throw new Error(SYNTHETIC_PRIVATE);
    }
  }
  function assertService(data: MemoryRows, authority: ReviewAuthority, id: string, revision: number) {
    const row = data.services.get(id);
    if (!row || row.ownerId !== authority.ownerId || row.dataGeneration !== authority.dataGeneration
      || row.state !== "live" || row.revision !== revision) throw new Error(SYNTHETIC_PRIVATE);
  }
  function transactionView(snapshot: MemoryRows, authority: ReviewAuthority, deadline: CommitRequirements,
    baseBatches: Map<string, CandidateBatchRow>): MemoryTransaction {
    async function operation<T>(method: Method, action: () => T): Promise<T> {
      controls.trace.push(method);
      await controls.beforeMethod?.(method);
      const result = action();
      await controls.afterMethod?.(method);
      return result;
    }
    function scoped<T extends { ownerId: string }>(value: T | undefined): T | null {
      return value?.ownerId === authority.ownerId ? clone(value) : null;
    }
    function allowed(row: { ownerId: string; dataGeneration: number }) {
      return row.ownerId === authority.ownerId && row.dataGeneration === authority.dataGeneration;
    }
    function requireBackingBatch(mapping: CandidateBatchMapping): boolean {
      const key = operationKey(mapping.ownerId, mapping.analysisOperationId), raw = snapshot.batches.get(key);
      if (!raw || !allowed(raw) || raw.analysisOperationId !== mapping.analysisOperationId
        || raw.ownerId !== mapping.ownerId || raw.dataGeneration !== mapping.dataGeneration) return false;
      try {
        const expected = parseBatch(raw), before = baseBatches.get(key) ?? null;
        if (before !== null && !sameBatch(before, expected)) return false;
        const previous = deadline.referenceBatches.get(key);
        if (previous && !sameBatch(previous.expected, expected)) return false;
        deadline.referenceBatches.set(key, { before: clone(before), expected: clone(expected) });
        return true;
      } catch { return false; }
    }
    function insert<T extends { id: string; ownerId: string; dataGeneration: number; revision: number }>(
      method: ConditionalMethod, map: Map<string, T>, row: T,
    ) {
      if (controls.falseMethod === method || !allowed(row) || row.revision !== 1 || map.has(row.id)) return false;
      map.set(row.id, clone(row));
      return true;
    }
    function update<T extends { id: string; ownerId: string; dataGeneration: number; revision: number }>(
      method: ConditionalMethod, map: Map<string, T>, row: T, expectedRevision: number,
    ) {
      const existing = map.get(row.id);
      if (controls.falseMethod === method || !existing || !allowed(existing) || !allowed(row)
        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
        || !Number.isSafeInteger(row.revision) || existing.revision !== expectedRevision
        || row.revision !== expectedRevision + 1) return false;
      if (method === "updateCandidate") {
        const before = existing as unknown as CandidateRow;
        const after = row as unknown as CandidateRow;
        if (before.expiresAt !== after.expiresAt || (before.state !== "pending" && after.state === "pending")
          || (before.state === "deleted" && (after.state !== "deleted" || after.content !== null))) return false;
      }
      if (method === "updatePreview") {
        const before = existing as unknown as PreviewRow;
        const after = row as unknown as PreviewRow;
        if (before.candidateId !== after.candidateId || before.sessionId !== after.sessionId
          || before.sessionRevision !== after.sessionRevision || before.expiresAt !== after.expiresAt
          || (before.state !== "pending" && after.state === "pending")
          || (before.state === "deleted" && (after.state !== "deleted" || after.content !== null))
          || (before.state === "revoked" && after.state !== "revoked" && after.state !== "deleted")
          || ((after.state === "pending" || after.state === "consumed")
            && JSON.stringify(before.content) !== JSON.stringify(after.content))) return false;
      }
      if (method === "updateBenefit") {
        const before = existing as unknown as ReviewedBenefitRow;
        const after = row as unknown as ReviewedBenefitRow;
        if (before.state === "deleted" && (after.state !== "deleted" || after.content !== null)) return false;
      }
      if (method === "updateCatalogService") {
        const before = existing as unknown as CatalogServiceRow;
        const after = row as unknown as CatalogServiceRow;
        if (before.state === "deleted" || before.createdAt !== after.createdAt || after.updatedAt < before.updatedAt
          || (after.state === "deleted" ? after.profile !== null || after.name !== DELETED_SERVICE_NAME
            : after.profile === null || after.name !== after.profile.name)) return false;
        if (after.state === "deleted" && [...snapshot.benefits.values()].some((benefit) => allowed(benefit)
          && benefit.state === "live" && benefit.content?.serviceId === after.id)) return false;
      }
      map.set(row.id, clone(row));
      return true;
    }
    return {
      getBatchReference: (reference) => operation("getBatchReference", () => scoped(snapshot.batchReferences.get(reference))),
      getBatchReferenceByOperation: (id) => operation("getBatchReferenceByOperation", () => {
        const reference = snapshot.batchReferenceSlots.get(operationKey(authority.ownerId, id));
        if (reference === undefined) return null;
        const row = snapshot.batchReferences.get(reference);
        // An absent slot is only absence; an existing dangling/misdirected slot
        // is observable corruption, not permission to allocate a replacement.
        if (!row || !validReference(row) || row.batchReference !== reference
          || row.ownerId !== authority.ownerId || row.analysisOperationId !== id) throw new Error(SYNTHETIC_PRIVATE);
        return clone(row);
      }),
      insertBatchReference: (row) => operation("insertBatchReference", () => {
        const slot = operationKey(row.ownerId, row.analysisOperationId);
        if (controls.falseMethod === "insertBatchReference" || !validReference(row) || !allowed(row)
          || row.state !== "active" || row.revision !== 1 || snapshot.batchReferences.has(row.batchReference)
          || snapshot.batchReferenceSlots.has(slot) || [...snapshot.batchReferences.values()].some((existing) =>
            existing.ownerId === row.ownerId && existing.analysisOperationId === row.analysisOperationId)
          || !requireBackingBatch(row)) return false;
        snapshot.batchReferences.set(row.batchReference, clone(row));
        snapshot.batchReferenceSlots.set(slot, row.batchReference);
        deadline.insertedReferences.add(row.batchReference);
        return true;
      }),
      retireBatchReference: (row, expectedRevision) => operation("retireBatchReference", () => {
        const previous = snapshot.batchReferences.get(row.batchReference);
        if (controls.falseMethod === "retireBatchReference" || !validReference(row) || !allowed(row)
          || row.state !== "retired" || row.revision !== 2 || expectedRevision !== 1 || !previous
          || !validReference(previous) || previous.state !== "active" || previous.revision !== 1
          || !sameMapping(previous, row)
          || snapshot.batchReferenceSlots.get(operationKey(row.ownerId, row.analysisOperationId)) !== row.batchReference
          || !requireBackingBatch(row)) return false;
        snapshot.batchReferences.set(row.batchReference, clone(row));
        return true;
      }),
      requireBatchReference: (expected) => {
        controls.trace.push("requireBatchReference");
        assertActiveReference(snapshot, authority, expected);
        if (!requireBackingBatch(expected)) throw new Error(SYNTHETIC_PRIVATE);
        deadline.references.push(clone(expected));
      },
      requireServiceVersion: (id, revision) => {
        controls.trace.push("requireServiceVersion");
        assertService(snapshot, authority, id, revision);
        deadline.services.push({ id, revision });
      },
      getCatalogService: (id) => operation("getCatalogService", () => scoped(snapshot.services.get(id)) as CatalogServiceRow | null),
      listCatalogServices: (afterId, take) => operation("listCatalogServices", () => [...snapshot.services.values()]
        .filter((row) => allowed(row) && row.state === "live" && (afterId === null || row.id > afterId))
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        .slice(0, take).map((row) => clone(row) as CatalogServiceRow)),
      getCatalogRevision: () => operation("getCatalogRevision", () =>
        snapshot.catalogRevisions.get(catalogRevisionKey(authority.ownerId, authority.dataGeneration)) ?? 1),
      advanceCatalogRevision: (expected) => operation("advanceCatalogRevision", () => {
        const key = catalogRevisionKey(authority.ownerId, authority.dataGeneration);
        if (controls.falseMethod === "advanceCatalogRevision" || !Number.isSafeInteger(expected)
          || expected < 1 || expected >= Number.MAX_SAFE_INTEGER || (snapshot.catalogRevisions.get(key) ?? 1) !== expected) return false;
        snapshot.catalogRevisions.set(key, expected + 1);
        return true;
      }),
      insertCatalogService: (row) => operation("insertCatalogService", () => insert("insertCatalogService", snapshot.services, row)),
      updateCatalogService: (row, revision) => operation("updateCatalogService", () =>
        update("updateCatalogService", snapshot.services, row, revision)),
      getCatalogOperation: (id) => operation("getCatalogOperation", () => scoped(snapshot.catalogOperations.get(operationKey(authority.ownerId, id)))),
      insertCatalogOperation: (row) => operation("insertCatalogOperation", () => {
        const key = operationKey(row.ownerId, row.operationId);
        if (controls.falseMethod === "insertCatalogOperation" || !allowed(row) || snapshot.catalogOperations.has(key)) return false;
        snapshot.catalogOperations.set(key, clone(row));
        return true;
      }),
      hasLiveServiceBenefits: (id) => operation("hasLiveServiceBenefits", () => {
        const found = [...snapshot.benefits.values()].some((row) => allowed(row) && row.state === "live" && row.content?.serviceId === id);
        if (!found) deadline.noLiveBenefits.push(id);
        return found;
      }),
      eraseServicePreviews: (id, scope) => operation("eraseServicePreviews", () => {
        for (const [previewId, row] of snapshot.previews) {
          if (allowed(row) && row.content?.serviceId === id && (scope === "all" || row.state === "pending")) {
            if (!Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision >= Number.MAX_SAFE_INTEGER) throw new Error(SYNTHETIC_PRIVATE);
            snapshot.previews.set(previewId, { ...row, state: scope === "pending" ? "revoked" : "deleted",
              content: null, revision: row.revision + 1 });
          }
        }
      }),
      requireCandidateStaging: (analysis, grant) => {
        controls.trace.push("requireCandidateStaging");
        assertStaging(authority, analysis, grant);
        deadline.staging.push({ analysis: clone(analysis), grant: clone(grant) });
      },
      getCandidateBatch: (id) => operation("getCandidateBatch", () => scoped(snapshot.batches.get(operationKey(authority.ownerId, id)))),
      insertCandidateBatch: (row) => operation("insertCandidateBatch", () => {
        const key = operationKey(row.ownerId, row.analysisOperationId);
        if (controls.falseMethod === "insertCandidateBatch" || !allowed(row) || snapshot.batches.has(key)
          || !deadline.staging.some(({ analysis, grant }) => row.analysisOperationId === analysis.operationId
            && row.mailboxBindingId === analysis.mailboxBindingId && row.pendingAccessUntil === grant.pendingAccessUntil)) return false;
        snapshot.batches.set(key, clone(row));
        return true;
      }),
      insertCandidate: (row) => operation("insertCandidate", () => {
        if (!row.content || row.state !== "pending" || !Number.isSafeInteger(row.expiresAt)
          || row.expiresAt <= controls.now || !deadline.staging.some(({ analysis, grant }) =>
            row.content!.analysisOperationId === analysis.operationId && row.content!.mailboxBindingId === analysis.mailboxBindingId
            && row.expiresAt === grant.pendingAccessUntil)) return false;
        const key = JSON.stringify([row.ownerId, row.content.analysisOperationId, row.content.candidateIndex]);
        if (snapshot.candidateSlots.has(key) || [...snapshot.candidates.values()].some((existing) =>
          existing.ownerId === row.ownerId && existing.content?.analysisOperationId === row.content!.analysisOperationId
          && existing.content.candidateIndex === row.content!.candidateIndex)) return false;
        if (!insert("insertCandidate", snapshot.candidates, row)) return false;
        snapshot.candidateSlots.set(key, row.id);
        return true;
      }),
      limitCommitTime: (notAfter) => {
        controls.trace.push("limitCommitTime");
        if (!Number.isSafeInteger(notAfter) || notAfter < 0) throw new Error(SYNTHETIC_PRIVATE);
        deadline.notAfter = Math.min(deadline.notAfter, notAfter);
      },
      getCandidate: (id) => operation("getCandidate", () => scoped(snapshot.candidates.get(id))),
      getService: (id) => operation("getService", () => scoped(snapshot.services.get(id))),
      getPreview: (id) => operation("getPreview", () => scoped(snapshot.previews.get(id))),
      getBenefit: (id) => operation("getBenefit", () => scoped(snapshot.benefits.get(id))),
      // Synthetic snapshot only. Every production benefit writer must advance
      // this revision atomically with its row and operation-ledger mutations.
      getBenefitCollectionRevision: () => operation("getBenefitCollectionRevision", () =>
        snapshot.benefitsRevisions.get(benefitCollectionRevisionKey(authority.ownerId, authority.dataGeneration)) ?? 1),
      listReviewedBenefits: (afterId, take) => operation("listReviewedBenefits", () => [...snapshot.benefits.values()]
        .filter((row) => allowed(row) && row.state === "live" && (afterId === null || row.id > afterId))
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        .slice(0, take).map((row) => clone(row))),
      advanceBenefitCollectionRevision: (expected) => operation("advanceBenefitCollectionRevision", () => {
        const key = benefitCollectionRevisionKey(authority.ownerId, authority.dataGeneration);
        if (controls.falseMethod === "advanceBenefitCollectionRevision" || !Number.isSafeInteger(expected)
          || expected < 1 || expected >= Number.MAX_SAFE_INTEGER || (snapshot.benefitsRevisions.get(key) ?? 1) !== expected) return false;
        snapshot.benefitsRevisions.set(key, expected + 1);
        return true;
      }),
      getOperation: (id) => operation("getOperation", () => scoped(snapshot.operations.get(operationKey(authority.ownerId, id)))),
      insertPreview: (row) => operation("insertPreview", () => insert("insertPreview", snapshot.previews, row)),
      insertBenefit: (row) => operation("insertBenefit", () => {
        const serviceId = row.content?.serviceId;
        const required = deadline.services.find((service) => service.id === serviceId);
        if (!required) return false;
        assertService(snapshot, authority, required.id, required.revision);
        if ([...snapshot.benefits.values()].some((existing) => existing.ownerId === authority.ownerId
          && existing.candidateId === row.candidateId)) return false;
        return insert("insertBenefit", snapshot.benefits, row);
      }),
      insertOperation: (row) => operation("insertOperation", () => {
        const key = operationKey(row.ownerId, row.operationId);
        if (controls.falseMethod === "insertOperation" || !allowed(row) || snapshot.operations.has(key)) return false;
        snapshot.operations.set(key, clone(row));
        return true;
      }),
      updateCandidate: (row, revision) => operation("updateCandidate", () => update("updateCandidate", snapshot.candidates, row, revision)),
      updatePreview: (row, revision) => operation("updatePreview", () => update("updatePreview", snapshot.previews, row, revision)),
      updateBenefit: (row, revision) => operation("updateBenefit", () => update("updateBenefit", snapshot.benefits, row, revision)),
      eraseCandidatePreviews: (candidateId) => operation("eraseCandidatePreviews", () => {
        for (const [id, row] of snapshot.previews) {
          if (row.ownerId === authority.ownerId && row.candidateId === candidateId) {
            if (!Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision >= Number.MAX_SAFE_INTEGER) {
              throw new Error(SYNTHETIC_PRIVATE);
            }
            snapshot.previews.set(id, { ...row, state: "deleted", content: null, revision: row.revision + 1 });
          }
        }
      }),
    };
  }

  const readAuthority = async () => {
    controls.authorityReads++;
    controls.trace.push("readAuthority");
    return clone(controls.readAuthority ? await controls.readAuthority(controls.authorityReads) : controls.authority);
  };
  const transaction = async <T>(authority: ReviewAuthority, action: (tx: MemoryTransaction) => Promise<T>): Promise<T> => {
    let release!: () => void;
    const previous = serial;
    serial = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    controls.transactions++;
    let committed = false;
    try {
      await controls.beforeEntry?.();
      assertAuthority(authority);
      const snapshot = clone(rows);
      const baseReferences = clone(rows.batchReferences), baseSlots = clone(rows.batchReferenceSlots), baseBatches = clone(rows.batches);
      const deadline: CommitRequirements = { notAfter: authority.expiresAt, staging: [], services: [], noLiveBenefits: [],
        references: [], insertedReferences: new Set(), referenceBatches: new Map() };
      const result = await action(transactionView(snapshot, authority, deadline, baseBatches));
      await controls.beforeCommit?.();
      assertAuthority(authority);
      if (controls.now >= deadline.notAfter) throw new Error(SYNTHETIC_PRIVATE);
      // The test store replaces its whole snapshot, including on read-only
      // transactions. Conservatively reject external reference/index changes so
      // even an unrelated read cannot overwrite a concurrent retirement.
      if (!sameMap(baseReferences, rows.batchReferences, sameReference)
        || !sameMap(baseSlots, rows.batchReferenceSlots, (left, right) => left === right)) throw new Error(SYNTHETIC_PRIVATE);
      for (const [key, required] of deadline.referenceBatches) {
        const live = rows.batches.get(key), final = snapshot.batches.get(key);
        if ((required.before === null ? live !== undefined : live === undefined || !sameBatch(required.before, live))
          || !final || !sameBatch(required.expected, final)) throw new Error(SYNTHETIC_PRIVATE);
      }
      for (const expected of deadline.references) {
        // A newly staged batch/alias can be checked in the same transaction;
        // the global absence/index predicates above still guard its insertion.
        assertActiveReference(deadline.insertedReferences.has(expected.batchReference) ? snapshot : rows, authority, expected);
      }
      for (const expected of deadline.staging) assertStaging(authority, expected.analysis, expected.grant);
      for (const service of deadline.services) {
        assertService(rows, authority, service.id, service.revision);
      }
      for (const serviceId of deadline.noLiveBenefits) {
        if ([...rows.benefits.values()].some((row) => row.ownerId === authority.ownerId
          && row.dataGeneration === authority.dataGeneration && row.state === "live" && row.content?.serviceId === serviceId)) {
          throw new Error(SYNTHETIC_PRIVATE);
        }
      }
      rows = snapshot;
      controls.commits++;
      committed = true;
      await controls.afterCommit?.();
      return result;
    } catch (error) {
      if (!committed) controls.rollbacks++;
      throw error;
    } finally {
      release();
    }
  };
  const common = { readAuthority, now: () => controls.now, newId: () => `synthetic-generated-${++idSequence}` };
  const dependencies: ReviewDependencies = { ...common, transaction };
  const inboxDependencies: CandidateInboxDependencies = { ...common, transaction,
    isAnalysisAuthorized: async (expected) => {
      controls.analysisChecks++;
      controls.trace.push("isAnalysisAuthorized");
      return controls.isAnalysisAuthorized ? controls.isAnalysisAuthorized(expected, controls.analysisChecks) : analysisAllowed(expected);
    },
    readStagingGrant: async (expected) => {
      controls.stagingGrantReads++;
      controls.trace.push("readStagingGrant");
      return clone(controls.readStagingGrant ? await controls.readStagingGrant(expected, controls.stagingGrantReads) : controls.stagingGrant);
    },
  };
  const catalogDependencies: CatalogDependencies = { ...common, transaction };
  const referenceDependencies: CandidateBatchReferenceDependencies = { ...inboxDependencies, transaction,
    newReference: () => `synthetic-batch-reference-${++referenceSequence}`,
    readReference: async (reference, signal) => {
      controls.trace.push("readReference");
      if (signal.aborted) throw new Error(SYNTHETIC_PRIVATE);
      // Direct committed read: must not enqueue a nested serial transaction.
      return clone(rows.batchReferences.get(reference) ?? null);
    },
  };
  return { dependencies, inboxDependencies, catalogDependencies, referenceDependencies, controls,
    get rows() { return rows; }, snapshot: () => clone(rows) };
}
