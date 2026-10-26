import type { CandidateInboxDependencies, CandidateInboxTransaction } from "./contracts";
import type { ReviewAuthority } from "../review/contracts";

/** Private immutable lookup mapping, never an authentication/consent capability. */
export interface CandidateBatchMapping {
  readonly batchReference: string;
  readonly ownerId: string;
  readonly dataGeneration: number;
  readonly analysisOperationId: string;
}
export interface CandidateBatchReferenceRow extends CandidateBatchMapping {
  readonly state: "active" | "retired";
  /** Active is exactly 1, terminal retired is exactly 2. No resurrection. */
  readonly revision: 1 | 2;
}
/** Public locator only; contains no candidate content or private operation ID. */
export interface CandidateBatchLocator {
  readonly batchReference: string;
  readonly dataGeneration: number;
}
export interface CandidateBatchRetirement extends CandidateBatchLocator {
  readonly state: "retired";
  readonly revision: 2;
}
export interface CandidateBatchResolutionRequest {
  readonly batchReference: string;
  readonly authority: ReviewAuthority;
}
export interface CandidateReferenceTransaction extends CandidateInboxTransaction {
  getBatchReference(batchReference: string): Promise<CandidateBatchReferenceRow | null>;
  getBatchReferenceByOperation(analysisOperationId: string): Promise<CandidateBatchReferenceRow | null>;
  /** Globally unique reference and unique (ownerId, analysisOperationId), even
   * across generations/retirement. Existing same-scope batch required. All writes
   * join staging's transaction. A collision returns false, never overwrites. */
  insertBatchReference(row: CandidateBatchReferenceRow): Promise<boolean>;
  /** Exact immutable binding + active revision 1 CAS, retired revision 2 only.
   * Recheck against current committed rows, not just a stale snapshot. */
  retireBatchReference(row: CandidateBatchReferenceRow, expectedRevision: 1): Promise<boolean>;
  /** Register exact active mapping at entry AND commit. Read paths must not
   * rely only on repeated resolver observations. No write or implicit renewal. */
  requireBatchReference(expected: CandidateBatchMapping): void;
}
export interface CandidateBatchReferenceDependencies extends Omit<CandidateInboxDependencies, "transaction"> {
  /** Trusted CSPRNG-generated independent opaque ID, not encoded private data.
   * Deterministic values are only for synthetic tests. This is not a credential. */
  newReference(): string;
  /** Direct read port, not a nested transaction. HTTP also resolves while its
   * inbox transaction is open. Respect the signal; never echo adapter errors. */
  readReference(batchReference: string, signal: AbortSignal): Promise<unknown>;
  /** Serializable/CAS+unique, current authority/deadline at entry+commit and
   * acknowledgement before return. Preserve retired uniqueness tombstones.
   * Failed callback rolls back candidates, batches and references together. */
  transaction<T>(authority: ReviewAuthority, action: (tx: CandidateReferenceTransaction) => Promise<T>): Promise<T>;
}
