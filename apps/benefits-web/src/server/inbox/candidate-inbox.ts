import { getVerifiedAnalysisHandoff, type VerifiedAnalysisHandoff } from "../mail/run-analysis";
import type { CandidateRow, ReviewAuthority, ReviewResult } from "../review/contracts";
import { ReviewFailure, failReview, makeCandidateContent, parseAuthority, parseCandidateContent,
  parseId, parseRevision } from "../review/validation";
import { INBOX_SCHEMA, type CandidateBatchRow, type CandidateBatchView, type CandidateDiscardReceipt,
  type CandidateInboxDependencies, type CandidateInboxTransaction, type CandidateView } from "./contracts";
import { parseBatch, parseDiscard, parseListBatch, parseStagingGrant, timestamp } from "./validation";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function persisted<T>(read: () => T): T {
  try { return read(); } catch { return failReview("REVIEW_STORE_UNAVAILABLE"); }
}
function nextRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) return failReview("REVIEW_CONFLICT");
  return value + 1;
}
function verified(result: unknown): VerifiedAnalysisHandoff {
  // No HTTP input, JSON clone, or hand-made typed envelope can cross this boundary.
  const handoff = getVerifiedAnalysisHandoff(result);
  if (!handoff) return failReview();
  return handoff;
}
function bindPrincipal(source: VerifiedAnalysisHandoff["authority"], current: ReviewAuthority, now: number) {
  if (source.ownerId !== current.ownerId || source.sessionId !== current.sessionId
    || source.sessionRevision !== current.sessionRevision || source.dataGeneration !== current.dataGeneration
    || source.sessionExpiresAt !== current.expiresAt || source.sessionExpiresAt <= now || source.grantExpiresAt <= now) {
    return failReview("REVIEW_AUTHORITY_CHANGED");
  }
}
function ownedCandidate(row: CandidateRow | null, id: string, auth: ReviewAuthority): CandidateRow {
  if (!row || row.ownerId !== auth.ownerId || row.id !== id || row.dataGeneration !== auth.dataGeneration) {
    return failReview("REVIEW_NOT_FOUND");
  }
  return persisted(() => {
    if (!["pending", "accepted", "deleted"].includes(row.state)
      || (row.state === "deleted" ? row.content !== null : row.content === null)) return failReview();
    return Object.freeze({ id, ownerId: auth.ownerId, dataGeneration: auth.dataGeneration,
      revision: parseRevision(row.revision), expiresAt: timestamp(row.expiresAt), state: row.state,
      content: row.content === null ? null : parseCandidateContent(row.content) });
  });
}
// Hash only bounded canonical projection. This digest is private replay metadata,
// not a password hash, an anonymization method, or proof of source authenticity.
async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function hideExpired(view: CandidateBatchView, now: number): CandidateBatchView {
  return Object.freeze({ ...view, candidates: Object.freeze(view.candidates.map((row) =>
    row.state === "pending" && row.expiresAt <= now
      ? Object.freeze({ ...row, state: "expired" as const, content: null }) : row)) });
}

/** Internal, provider-independent inbox. No routes, DB or real-mail adapters. */
export function createCandidateInbox(deps: CandidateInboxDependencies) {
  async function execute<I, O>(input: unknown, parse: (value: unknown) => I,
    act: (auth: ReviewAuthority, request: I, clock: () => number,
      guard: () => Promise<void>) => Promise<O>, finalize: (value: O, now: number) => O = (value) => value): Promise<ReviewResult<O>> {
    try {
      const request = parse(input);
      let lastTime = -1;
      const clock = () => {
        const time = timestamp(deps.now());
        if (time < lastTime) return failReview("REVIEW_AUTHORITY_CHANGED");
        lastTime = time;
        return time;
      };
      const auth = parseAuthority(await deps.readAuthority(), clock());
      const guard = async () => {
        try {
          if (!same(auth, parseAuthority(await deps.readAuthority(), clock()))) return failReview();
        } catch { return failReview("REVIEW_AUTHORITY_CHANGED"); }
      };
      const value = await act(auth, request, clock, guard);
      // A commit can already have happened. Suppress late unauthorized payloads,
      // but do not report an unknown acknowledgement as rollback success.
      await guard();
      return Object.freeze({ ok: true as const, value: finalize(value, clock()) });
    } catch (error) {
      return Object.freeze({ ok: false as const,
        code: error instanceof ReviewFailure ? error.code : "REVIEW_STORE_UNAVAILABLE" });
    }
  }
  async function getBatch(tx: CandidateInboxTransaction, auth: ReviewAuthority, id: string) {
    const raw = await tx.getCandidateBatch(id);
    if (raw === null) return null;
    if (raw.ownerId !== auth.ownerId || raw.dataGeneration !== auth.dataGeneration || raw.analysisOperationId !== id) {
      return failReview("REVIEW_NOT_FOUND");
    }
    return persisted(() => parseBatch(raw));
  }
  async function batchView(tx: CandidateInboxTransaction, auth: ReviewAuthority, batch: CandidateBatchRow,
    replayed: boolean, clock: () => number): Promise<CandidateBatchView> {
    const candidates: CandidateView[] = [];
    for (const [index, id] of batch.candidateIds.entries()) {
      const row = ownedCandidate(await tx.getCandidate(id), id, auth);
      if (row.expiresAt !== batch.pendingAccessUntil || (row.content !== null
        && (row.content.analysisOperationId !== batch.analysisOperationId
          || row.content.mailboxBindingId !== batch.mailboxBindingId
          || row.content.extractedAt !== batch.extractedAt || row.content.candidateIndex !== index))) {
        return failReview("REVIEW_STORE_UNAVAILABLE");
      }
      const state = row.state === "pending" && row.expiresAt <= clock() ? "expired" as const : row.state;
      candidates.push(Object.freeze({ id, revision: row.revision, expiresAt: row.expiresAt,
        state, content: state === "pending" ? row.content : null }));
    }
    return Object.freeze({ schema: INBOX_SCHEMA, dataGeneration: auth.dataGeneration,
      analysisOperationId: batch.analysisOperationId, replayed, candidates: Object.freeze(candidates) });
  }

  return Object.freeze({
    stage(result: unknown): Promise<ReviewResult<CandidateBatchView>> {
      let responseDeadline = -1;
      return execute(result, verified, async (auth, handoff, clock, guard) => {
        const source = handoff.authority;
        bindPrincipal(source, auth, clock());
        const readGrant = async () => {
          try {
            bindPrincipal(source, auth, clock());
            if (await deps.isAnalysisAuthorized(source) !== true) return failReview();
            const grant = parseStagingGrant(await deps.readStagingGrant(source), source, handoff.result.extractedAt, clock());
            // An authorization lookup can be delayed past the analysis deadline.
            bindPrincipal(source, auth, clock());
            return grant;
          } catch { return failReview("REVIEW_AUTHORITY_CHANGED"); }
        };
        const grant = await readGrant();
        responseDeadline = Math.min(auth.expiresAt, source.grantExpiresAt, grant.expiresAt, grant.pendingAccessUntil);
        const checkGrants = async () => {
          await guard();
          if (!same(grant, await readGrant())) return failReview("REVIEW_AUTHORITY_CHANGED");
        };
        const contents = handoff.result.candidates.map((candidate, index) => {
          if (candidate.index !== index) return failReview("REVIEW_STORE_UNAVAILABLE");
          return makeCandidateContent(candidate, { analysisOperationId: source.operationId,
            mailboxBindingId: source.mailboxBindingId, extractedAt: handoff.result.extractedAt });
        });
        const digest = await fingerprint({ source, grant, contents });
        await checkGrants();
        const value = await deps.transaction(auth, async (tx) => {
          tx.limitCommitTime(responseDeadline);
          tx.requireCandidateStaging(source, grant);
          await checkGrants();
          let batch = await getBatch(tx, auth, source.operationId);
          const replayed = batch !== null;
          if (batch !== null) {
            if (batch.fingerprint !== digest) return failReview("REVIEW_OPERATION_CONFLICT");
          } else {
            const ids: string[] = [];
            for (const content of contents) {
              const id = parseId(deps.newId());
              if (ids.includes(id)) return failReview("REVIEW_CONFLICT");
              ids.push(id);
              if (!await tx.insertCandidate(Object.freeze({ id, ownerId: auth.ownerId,
                dataGeneration: auth.dataGeneration, revision: 1, expiresAt: grant.pendingAccessUntil,
                state: "pending", content }))) return failReview("REVIEW_CONFLICT");
            }
            batch = Object.freeze({ ownerId: auth.ownerId, dataGeneration: auth.dataGeneration,
              analysisOperationId: source.operationId, mailboxBindingId: source.mailboxBindingId,
              extractedAt: handoff.result.extractedAt, pendingAccessUntil: grant.pendingAccessUntil,
              fingerprint: digest, candidateIds: Object.freeze(ids) });
            if (!await tx.insertCandidateBatch(batch)) return failReview("REVIEW_CONFLICT");
          }
          const view = await batchView(tx, auth, batch, replayed, clock);
          await checkGrants();
          return view;
        });
        await checkGrants();
        return value;
      }, (view, now) => {
        // Even the final app-authority lookup can cross an analysis/staging
        // deadline after commit; it must not return a stale stage receipt.
        if (now >= responseDeadline) return failReview("REVIEW_AUTHORITY_CHANGED");
        return hideExpired(view, now);
      });
    },
    listBatch(input: unknown): Promise<ReviewResult<CandidateBatchView>> {
      return execute(input, parseListBatch, async (auth, request, clock, guard) =>
        deps.transaction(auth, async (tx) => {
          tx.limitCommitTime(auth.expiresAt);
          await guard();
          const batch = await getBatch(tx, auth, request.analysisOperationId);
          if (batch === null) return failReview("REVIEW_NOT_FOUND");
          const view = await batchView(tx, auth, batch, false, clock);
          await guard();
          return view;
        }), hideExpired);
    },
    discard(input: unknown): Promise<ReviewResult<CandidateDiscardReceipt>> {
      return execute(input, parseDiscard, async (auth, request, _clock, guard) =>
        deps.transaction(auth, async (tx) => {
          tx.limitCommitTime(auth.expiresAt);
          await guard();
          const row = ownedCandidate(await tx.getCandidate(request.candidateId), request.candidateId, auth);
          const next = nextRevision(request.expectedRevision);
          const replayed = row.state === "deleted" && row.revision === next;
          if (!replayed) {
            if (row.state !== "pending" || row.revision !== request.expectedRevision) return failReview("REVIEW_CONFLICT");
            if (!await tx.updateCandidate(Object.freeze({ ...row, state: "deleted", content: null,
              revision: next }), row.revision)) return failReview("REVIEW_CONFLICT");
            await tx.eraseCandidatePreviews(row.id);
          }
          await guard();
          return Object.freeze({ schema: INBOX_SCHEMA, dataGeneration: auth.dataGeneration,
            candidateId: row.id, revision: next, state: "deleted", content: null, replayed });
        }));
    },
  });
}
