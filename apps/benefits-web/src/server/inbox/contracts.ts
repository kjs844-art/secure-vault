import type { RunAuthority } from "../mail/run-analysis";
import type { CandidateContent, CandidateRow, ReviewAuthority, ReviewTransaction } from "../review/contracts";

export const INBOX_SCHEMA = "keyatlas.candidate-inbox.v1" as const;
export const STAGING_POLICY = "keyatlas.candidate-staging.v1" as const;
// Technical ceiling only. A real grant must explicitly choose a shorter/equal
// access window; this does not schedule physical deletion or set a legal policy.
export const MAX_PENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Trusted server authorization, independent of mailbox/AI-analysis consent. */
export interface CandidateStagingGrant {
  readonly id: string;
  readonly revision: number;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly dataGeneration: number;
  readonly analysisOperationId: string;
  readonly mailboxBindingId: string;
  readonly recipientId: string;
  readonly analysisGrantId: string;
  readonly analysisGrantRevision: number;
  readonly policyVersion: typeof STAGING_POLICY;
  readonly allowCandidateStorage: true;
  readonly expiresAt: number;
  readonly pendingAccessUntil: number;
}

/** Minimal private replay metadata, not a cached success payload. */
export interface CandidateBatchRow {
  readonly ownerId: string;
  readonly dataGeneration: number;
  readonly analysisOperationId: string;
  readonly mailboxBindingId: string;
  readonly extractedAt: string;
  readonly pendingAccessUntil: number;
  // SHA256 is for equality, NOT anonymization or authenticity.
  readonly fingerprint: string;
  readonly candidateIds: readonly string[];
}

export interface CandidateInboxTransaction extends ReviewTransaction {
  /** Register immutable expected grants; recheck BOTH atomically at commit. */
  requireCandidateStaging(analysis: RunAuthority, grant: CandidateStagingGrant): void;
  getCandidateBatch(analysisOperationId: string): Promise<CandidateBatchRow | null>;
  // Unique (ownerId, analysisOperationId), including empty completed batches.
  insertCandidateBatch(row: CandidateBatchRow): Promise<boolean>;
  // Unique ID AND (ownerId, analysisOperationId, candidateIndex), tombstones kept.
  insertCandidate(row: CandidateRow): Promise<boolean>;
}

export interface CandidateInboxDependencies {
  readAuthority(): Promise<unknown>;
  // Verify the exact captured analysis authority against current server state.
  // A true value based only on this argument is NOT an implementation.
  isAnalysisAuthorized(expected: RunAuthority): Promise<boolean>;
  readStagingGrant(expected: RunAuthority): Promise<unknown>;
  // ALL operations (including list/discard) recheck app owner/session revision/
  // generation/expiry atomically at entry AND commit, with serializable CAS and
  // unique constraints. Callback failure rolls back all writes. Return only
  // after committed completion. Stage adds its two grant predicates as well.
  transaction<T>(authority: ReviewAuthority, action: (tx: CandidateInboxTransaction) => Promise<T>): Promise<T>;
  newId(): string;
  now(): number;
}

export interface CandidateView {
  readonly id: string;
  readonly revision: number;
  readonly state: "pending" | "accepted" | "deleted" | "expired";
  readonly expiresAt: number;
  // Never replay an accepted/deleted/expired candidate's old payload.
  readonly content: CandidateContent | null;
}
export interface CandidateBatchView {
  readonly schema: typeof INBOX_SCHEMA;
  readonly dataGeneration: number;
  readonly analysisOperationId: string;
  readonly replayed: boolean;
  readonly candidates: readonly CandidateView[];
}
export interface CandidateDiscardReceipt {
  readonly schema: typeof INBOX_SCHEMA;
  readonly dataGeneration: number;
  readonly candidateId: string;
  readonly revision: number;
  readonly state: "deleted";
  readonly content: null;
  readonly replayed: boolean;
}
