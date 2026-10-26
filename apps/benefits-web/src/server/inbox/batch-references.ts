/**
 * Internal reference issuance/recovery. References are independent opaque lookup
 * aliases, never authorization capabilities. This module mounts no route and
 * supplies no authentication, randomness or durable database implementation.
 */
import { getVerifiedAnalysisHandoff } from "../mail/run-analysis";
import type { ReviewAuthority, ReviewResult } from "../review/contracts";
import { failReview, objectFields, parseAuthority, parseId, parseRevision, ReviewFailure } from "../review/validation";
import { createCandidateInbox } from "./candidate-inbox";
import type { CandidateBatchRow } from "./contracts";
import { parseBatch, parseStagingGrant, timestamp } from "./validation";
import type { CandidateBatchLocator, CandidateBatchMapping, CandidateBatchReferenceDependencies,
  CandidateBatchReferenceRow, CandidateBatchResolutionRequest, CandidateBatchRetirement,
  CandidateReferenceTransaction } from "./batch-reference-contracts";

const AUTHORITY_KEYS = ["ownerId", "sessionId", "sessionRevision", "dataGeneration", "expiresAt"] as const;
const CONFIG_KEYS = ["readAuthority", "isAnalysisAuthorized", "readStagingGrant", "transaction",
  "newId", "now", "newReference", "readReference"] as const;
const sameAuthority = (a: ReviewAuthority, b: ReviewAuthority) => a.ownerId === b.ownerId
  && a.sessionId === b.sessionId && a.sessionRevision === b.sessionRevision
  && a.dataGeneration === b.dataGeneration && a.expiresAt === b.expiresAt;
const sameRow = (a: CandidateBatchReferenceRow, b: CandidateBatchReferenceRow) => a.batchReference === b.batchReference
  && a.ownerId === b.ownerId && a.dataGeneration === b.dataGeneration && a.analysisOperationId === b.analysisOperationId
  && a.state === b.state && a.revision === b.revision;

function stored<T>(action: () => T): T {
  try { return action(); } catch { return failReview("REVIEW_STORE_UNAVAILABLE"); }
}
function parseReference(input: unknown): CandidateBatchReferenceRow {
  return stored(() => {
    const raw = objectFields(input, ["batchReference", "ownerId", "dataGeneration", "analysisOperationId", "state", "revision"]);
    const batchReference = parseId(raw.batchReference), ownerId = parseId(raw.ownerId);
    const dataGeneration = parseRevision(raw.dataGeneration), analysisOperationId = parseId(raw.analysisOperationId);
    if ((raw.state !== "active" || raw.revision !== 1) && (raw.state !== "retired" || raw.revision !== 2)) return failReview();
    // Equality checks catch direct private-ID substitution, not arbitrary
    // encodings. Independent CSPRNG issuance remains a trusted port contract.
    if (batchReference === ownerId || batchReference === analysisOperationId) return failReview();
    return Object.freeze({ batchReference, ownerId, dataGeneration, analysisOperationId,
      state: raw.state, revision: raw.revision });
  });
}
function mapping(row: CandidateBatchReferenceRow): CandidateBatchMapping {
  return Object.freeze({ batchReference: row.batchReference, ownerId: row.ownerId,
    dataGeneration: row.dataGeneration, analysisOperationId: row.analysisOperationId });
}
function locator(row: CandidateBatchReferenceRow): CandidateBatchLocator {
  return Object.freeze({ batchReference: row.batchReference, dataGeneration: row.dataGeneration });
}
function own(row: CandidateBatchReferenceRow, auth: ReviewAuthority): void {
  if (row.ownerId !== auth.ownerId || row.dataGeneration !== auth.dataGeneration) return failReview("REVIEW_NOT_FOUND");
}
function errorResult(error: unknown): ReviewResult<never> {
  return Object.freeze({ ok: false, code: error instanceof ReviewFailure ? error.code : "REVIEW_STORE_UNAVAILABLE" });
}
function clockPort(now: () => number) {
  let last = -1;
  return () => {
    try {
      const time = timestamp(now());
      if (time < last) return failReview();
      last = time; return time;
    } catch { return failReview("REVIEW_AUTHORITY_CHANGED"); }
  };
}

/** Native signal cancellation settles a direct read even if a port ignores it.
 * This cannot destroy that port's physical resources and is not a timeout. */
function cancellation(signal: AbortSignal) {
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
  try { getter.call(signal); } catch { return failReview(); }
  let stopped = false, reject!: (reason: ReviewFailure) => void;
  const stop = new Promise<never>((_resolve, fail) => { reject = fail; });
  void stop.catch(() => undefined);
  const onAbort = () => {
    if (stopped) return;
    stopped = true; reject(new ReviewFailure("REVIEW_AUTHORITY_CHANGED"));
  };
  const check = () => {
    if (getter.call(signal) === true) onAbort();
    if (stopped) return failReview("REVIEW_AUTHORITY_CHANGED");
  };
  EventTarget.prototype.addEventListener.call(signal, "abort", onAbort, { once: true });
  return {
    check,
    async run<T>(action: () => Promise<T>): Promise<T> {
      check();
      const result = await Promise.race([action(), stop]);
      check(); return result;
    },
    finish: () => { EventTarget.prototype.removeEventListener.call(signal, "abort", onAbort); },
  };
}

export function createCandidateBatchReferences(input: CandidateBatchReferenceDependencies) {
  let deps: CandidateBatchReferenceDependencies;
  try {
    const raw = objectFields(input, CONFIG_KEYS);
    if (CONFIG_KEYS.some((key) => typeof raw[key] !== "function")) throw new Error();
    deps = Object.freeze(raw) as unknown as CandidateBatchReferenceDependencies;
  } catch { throw new Error("CANDIDATE_BATCH_REFERENCE_CONFIG_INVALID"); }

  async function scope(clock: () => number, run = <T>(action: () => Promise<T>) => action()) {
    const initial = await run(() => deps.readAuthority());
    let auth: ReviewAuthority;
    try { auth = parseAuthority(objectFields(initial, AUTHORITY_KEYS), clock()); }
    catch (error) {
      if (error instanceof ReviewFailure && error.code === "REVIEW_AUTHORITY_CHANGED") throw error;
      return failReview("REVIEW_AUTH_REQUIRED");
    }
    const guard = async () => {
      try {
        const raw = await run(() => deps.readAuthority());
        if (!sameAuthority(auth, parseAuthority(objectFields(raw, AUTHORITY_KEYS), clock()))) return failReview();
      } catch { return failReview("REVIEW_AUTHORITY_CHANGED"); }
    };
    const finalClock = () => {
      const now = clock();
      if (auth.expiresAt <= now) return failReview("REVIEW_AUTHORITY_CHANGED");
      return now;
    };
    return { auth, guard, finalClock };
  }
  async function batch(tx: CandidateReferenceTransaction, auth: ReviewAuthority, operationId: string): Promise<CandidateBatchRow> {
    const raw = await tx.getCandidateBatch(operationId);
    if (raw === null) return failReview("REVIEW_NOT_FOUND");
    const value = stored(() => parseBatch(raw));
    if (value.ownerId !== auth.ownerId || value.dataGeneration !== auth.dataGeneration
      || value.analysisOperationId !== operationId) return failReview("REVIEW_NOT_FOUND");
    return value;
  }
  async function byOperation(tx: CandidateReferenceTransaction, auth: ReviewAuthority, operationId: string) {
    const raw = await tx.getBatchReferenceByOperation(operationId);
    if (raw === null) return null;
    const row = parseReference(raw); own(row, auth);
    if (row.analysisOperationId !== operationId) return failReview("REVIEW_STORE_UNAVAILABLE");
    const indexed = await tx.getBatchReference(row.batchReference);
    if (indexed === null || !sameRow(row, parseReference(indexed))) return failReview("REVIEW_STORE_UNAVAILABLE");
    return row;
  }
  async function ensureInTransaction(tx: CandidateReferenceTransaction, auth: ReviewAuthority, operationId: string,
    otherPrivateIds: readonly string[] = []) {
    const persistedBatch = await batch(tx, auth, operationId);
    const privateIds = [auth.ownerId, auth.sessionId, operationId, persistedBatch.mailboxBindingId,
      persistedBatch.fingerprint, ...persistedBatch.candidateIds, ...otherPrivateIds];
    let row = await byOperation(tx, auth, operationId);
    if (row?.state === "retired") return failReview("REVIEW_CONFLICT");
    if (row === null) {
      const reference = stored(() => parseId(deps.newReference()));
      if (privateIds.includes(reference)) return failReview("REVIEW_STORE_UNAVAILABLE");
      row = Object.freeze({ batchReference: reference, ownerId: auth.ownerId, dataGeneration: auth.dataGeneration,
        analysisOperationId: operationId, state: "active", revision: 1 });
      if (!await tx.insertBatchReference(row)) return failReview("REVIEW_CONFLICT");
      // Read both unique indexes under the same transaction; a success boolean
      // alone is not evidence that the exact immutable association was stored.
      const inserted = await byOperation(tx, auth, operationId);
      if (inserted === null || !sameRow(inserted, row)) return failReview("REVIEW_STORE_UNAVAILABLE");
    }
    if (privateIds.includes(row.batchReference)) return failReview("REVIEW_STORE_UNAVAILABLE");
    tx.requireBatchReference(mapping(row));
    return locator(row);
  }

  async function stage(original: unknown): Promise<ReviewResult<CandidateBatchLocator>> {
    try {
      const handoff = getVerifiedAnalysisHandoff(original);
      if (handoff === null) return failReview();
      const clock = clockPort(deps.now), source = handoff.authority;
      let issued: CandidateBatchLocator | null = null, stageDeadline = -1;
      const privateIds = new Set([source.grantId, source.recipientId]);
      // Invocation-local state is essential: two overlapping stages must never
      // share a last-reference variable. The core still verifies the original.
      const inbox = createCandidateInbox({ readAuthority: deps.readAuthority, now: clock, newId: deps.newId,
        isAnalysisAuthorized: deps.isAnalysisAuthorized,
        readStagingGrant: async (expected) => {
          const raw = await deps.readStagingGrant(expected);
          const grant = parseStagingGrant(raw, source, handoff.result.extractedAt, clock());
          privateIds.add(grant.id);
          stageDeadline = Math.min(source.sessionExpiresAt, source.grantExpiresAt, grant.expiresAt, grant.pendingAccessUntil);
          return raw;
        },
        transaction: (auth, action) => deps.transaction(auth, async (tx) => {
          const result = await action(tx);
          // The real core action has already registered its current app/grant
          // predicates and deadline. Reference writes join that SAME commit.
          if (auth.ownerId !== source.ownerId || auth.dataGeneration !== source.dataGeneration) return failReview("REVIEW_AUTHORITY_CHANGED");
          issued = await ensureInTransaction(tx, auth, source.operationId, [...privateIds]);
          return result;
        }),
      });
      const result = await inbox.stage(original);
      if (!result.ok) return Object.freeze({ ok: false, code: result.code });
      // No candidate payload is returned, and a late acknowledgement is never
      // turned into success after the original staging authority expired.
      if (clock() >= stageDeadline) return failReview("REVIEW_AUTHORITY_CHANGED");
      if (issued === null) return failReview("REVIEW_STORE_UNAVAILABLE");
      return Object.freeze({ ok: true, value: issued });
    } catch (error) { return errorResult(error); }
  }
  async function ensure(input: unknown): Promise<ReviewResult<CandidateBatchLocator>> {
    try {
      const operationId = parseId(objectFields(input, ["analysisOperationId"]).analysisOperationId);
      const clock = clockPort(deps.now), current = await scope(clock);
      const value = await deps.transaction(current.auth, async (tx) => {
        tx.limitCommitTime(current.auth.expiresAt); await current.guard();
        const result = await ensureInTransaction(tx, current.auth, operationId);
        await current.guard(); current.finalClock(); return result;
      });
      await current.guard(); current.finalClock();
      return Object.freeze({ ok: true, value });
    } catch (error) { return errorResult(error); }
  }
  async function retire(input: unknown): Promise<ReviewResult<CandidateBatchRetirement>> {
    try {
      const raw = objectFields(input, ["batchReference", "expectedRevision", "decision"]);
      const reference = parseId(raw.batchReference), expected = parseRevision(raw.expectedRevision);
      if (raw.decision !== "retire") return failReview();
      if (expected !== 1) return failReview("REVIEW_CONFLICT");
      const clock = clockPort(deps.now), current = await scope(clock);
      const value = await deps.transaction(current.auth, async (tx) => {
        tx.limitCommitTime(current.auth.expiresAt); await current.guard();
        const storedRow = await tx.getBatchReference(reference);
        if (storedRow === null) return failReview("REVIEW_NOT_FOUND");
        const row = parseReference(storedRow); own(row, current.auth);
        if (row.batchReference !== reference) return failReview("REVIEW_STORE_UNAVAILABLE");
        const indexed = await byOperation(tx, current.auth, row.analysisOperationId);
        if (indexed === null || !sameRow(row, indexed)) return failReview("REVIEW_STORE_UNAVAILABLE");
        if (row.state === "active") {
          const retired = Object.freeze({ ...row, state: "retired" as const, revision: 2 as const });
          if (!await tx.retireBatchReference(retired, 1)) return failReview("REVIEW_CONFLICT");
          const updated = await byOperation(tx, current.auth, row.analysisOperationId);
          if (updated === null || !sameRow(updated, retired)) return failReview("REVIEW_STORE_UNAVAILABLE");
        }
        await current.guard(); current.finalClock();
        return Object.freeze({ batchReference: reference, dataGeneration: current.auth.dataGeneration,
          state: "retired" as const, revision: 2 as const });
      });
      await current.guard(); current.finalClock();
      return Object.freeze({ ok: true, value });
    } catch (error) { return errorResult(error); }
  }
  async function resolve(input: CandidateBatchResolutionRequest, signal: AbortSignal): Promise<CandidateBatchMapping | null> {
    let lifetime: ReturnType<typeof cancellation> | undefined;
    try {
      lifetime = cancellation(signal); lifetime.check();
      const raw = objectFields(input, ["batchReference", "authority"]), reference = parseId(raw.batchReference);
      const clock = clockPort(deps.now);
      const expected = parseAuthority(objectFields(raw.authority, AUTHORITY_KEYS), clock());
      const current = await scope(clock, lifetime.run);
      if (!sameAuthority(expected, current.auth)) return failReview("REVIEW_AUTHORITY_CHANGED");
      const rawRow = await lifetime.run(() => deps.readReference(reference, signal));
      current.finalClock(); lifetime.check();
      let result: CandidateBatchMapping | null = null;
      if (rawRow !== null) {
        const row = parseReference(rawRow);
        if (row.batchReference !== reference) return failReview("REVIEW_STORE_UNAVAILABLE");
        if (row.ownerId === current.auth.ownerId && row.dataGeneration === current.auth.dataGeneration && row.state === "active") {
          result = mapping(row);
        }
      }
      await current.guard();
      // Descriptor/proxy reflection is not a sandbox. Recheck our observational
      // clock and native cancellation after decoding, without another await.
      current.finalClock(); lifetime.check(); return result;
    } catch (error) {
      lifetime?.check();
      if (error instanceof ReviewFailure) throw error;
      return failReview("REVIEW_STORE_UNAVAILABLE");
    } finally { lifetime?.finish(); }
  }
  return Object.freeze({ stage, ensure, retire, resolve });
}
