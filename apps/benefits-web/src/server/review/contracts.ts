import type { BenefitEvidenceKind, EmailCandidate } from "../mail/contracts";

export const REVIEW_SCHEMA = "keyatlas.benefit-review.v1" as const;
export const PREVIEW_TTL_MS = 5 * 60 * 1000;

/** Verified server state, never copied from HTTP input. */
export interface ReviewAuthority {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly dataGeneration: number;
  readonly expiresAt: number;
}

export interface ReviewValues {
  readonly name: string;
  readonly kind: BenefitEvidenceKind;
  readonly unit: string | null;
  readonly grantedAmount: number | null;
  readonly remainingAmount: number | null;
  readonly trialDaysStated: number | null;
  readonly remainingDaysStated: number | null;
  readonly expiresAt: string | null;
  readonly observedAt: string | null;
}
export type ExtractedValues = Omit<ReviewValues, "name"> & { readonly name: string | null };

/** Original mail text, Gmail IDs and quotes are deliberately absent. */
export interface CandidateContent {
  readonly schema: typeof REVIEW_SCHEMA;
  readonly analysisOperationId: string;
  readonly mailboxBindingId: string;
  readonly candidateIndex: number;
  readonly policyVersion: "keyatlas.gmail-review.v1";
  readonly extractedAt: string;
  readonly receivedAt: string | null;
  readonly serviceName: string;
  readonly extractionConfidence: EmailCandidate["extractionConfidence"];
  readonly reviewReasons: EmailCandidate["reviewReasons"];
  readonly values: ExtractedValues;
  readonly evidenceAvailability: "not-retained";
}

interface OwnedRow {
  readonly id: string;
  readonly ownerId: string;
  readonly dataGeneration: number;
  readonly revision: number;
}
export interface CandidateRow extends OwnedRow {
  // Access deadline for pending proposals, not a promise of physical erasure.
  // Immutable after insert. Accepted benefits are not expired by this deadline.
  readonly expiresAt: number;
  // Trusted pipeline creates/updates pending proposals only. Accepted/deleted
  // candidate IDs are never reused or turned back into pending on reanalysis.
  readonly state: "pending" | "accepted" | "deleted";
  readonly content: CandidateContent | null;
}
export interface ReviewServiceRow extends OwnedRow {
  // This is app-record liveness, NOT subscription/account status.
  readonly state: "live" | "deleted";
  readonly name: string;
}
export interface ReviewDraft {
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly serviceId: string;
  readonly serviceRevision: number;
  readonly values: ReviewValues;
}
export interface PreviewContent extends ReviewDraft {
  readonly serviceName: string;
  readonly source: CandidateContent;
}
export interface PreviewRow extends OwnedRow {
  // Pending content is immutable at revision 1. Editing any preview parameter
  // requires a NEW preview ID; never change the content behind an approved ID.
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly expiresAt: number;
  readonly state: "pending" | "consumed" | "revoked" | "deleted";
  readonly candidateId: string;
  readonly content: PreviewContent | null;
}
export interface BenefitContent {
  readonly schema: typeof REVIEW_SCHEMA;
  readonly serviceId: string;
  readonly serviceNameAtReview: string;
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly values: ReviewValues;
  readonly valueOrigins: Readonly<Record<keyof ReviewValues, "email-extracted" | "user-corrected">>;
  readonly source: CandidateContent;
  readonly reviewedAt: string;
  readonly reviewStatus: "accepted-by-user";
  readonly accountProof: "not-established";
  readonly currentBalanceProof: "not-established";
}
export interface ReviewedBenefitRow extends OwnedRow {
  readonly state: "live" | "deleted";
  readonly candidateId: string;
  readonly content: BenefitContent | null;
  readonly deletedAt: string | null;
}
export interface ReviewOperation {
  readonly ownerId: string;
  readonly operationId: string;
  readonly dataGeneration: number;
  readonly kind: "confirm" | "delete";
  // Canonical ID-only request. It is still private metadata, not a bearer capability.
  readonly requestKey: string;
  readonly benefitId: string;
}

/**
 * All reads must be owner-scoped. Conditional writes must return false on CAS or
 * uniqueness failure. Throwing from the callback MUST roll back every write.
 * Implementations must prevent phantoms while erasing previews for a candidate.
 */
export interface ReviewTransaction {
  // Tighten the adapter's commit deadline; a commit at/after it must not succeed.
  limitCommitTime(notAfter: number): void;
  getCandidate(id: string): Promise<CandidateRow | null>;
  getService(id: string): Promise<ReviewServiceRow | null>;
  getPreview(id: string): Promise<PreviewRow | null>;
  getBenefit(id: string): Promise<ReviewedBenefitRow | null>;
  getOperation(operationId: string): Promise<ReviewOperation | null>;
  insertPreview(row: PreviewRow): Promise<boolean>;
  insertBenefit(row: ReviewedBenefitRow): Promise<boolean>;
  insertOperation(row: ReviewOperation): Promise<boolean>;
  // Updates preserve IDs, owner and generation. They never revive a tombstone.
  updateCandidate(row: CandidateRow, expectedRevision: number): Promise<boolean>;
  // Content is immutable except nulling it on revoke/delete. Normal transition:
  // pending -> consumed/revoked, followed only by deletion; no return to pending.
  updatePreview(row: PreviewRow, expectedRevision: number): Promise<boolean>;
  updateBenefit(row: ReviewedBenefitRow, expectedRevision: number): Promise<boolean>;
  // Remove preview payloads for this candidate, retaining minimal replay fences.
  eraseCandidatePreviews(candidateId: string): Promise<void>;
}
export interface ReviewDependencies {
  readAuthority(): Promise<unknown>;
  /**
   * Atomically recheck authority at entry AND commit, including session expiry,
   * revision and owner data generation. Return only after committed completion.
   * Serializability/locks/constraints are the actual adapter's responsibility.
   */
  transaction<T>(authority: ReviewAuthority, action: (tx: ReviewTransaction) => Promise<T>): Promise<T>;
  newId(): string;
  now(): number;
}

export type ReviewErrorCode =
  | "REVIEW_INPUT_INVALID" | "REVIEW_AUTH_REQUIRED" | "REVIEW_AUTHORITY_CHANGED"
  | "REVIEW_NOT_FOUND" | "REVIEW_CONFLICT" | "REVIEW_PREVIEW_EXPIRED"
  | "REVIEW_PREVIEW_UNAVAILABLE" | "REVIEW_OPERATION_CONFLICT" | "REVIEW_STORE_UNAVAILABLE";
export type ReviewResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ReviewErrorCode };
export interface PreviewView {
  readonly id: string;
  readonly revision: number;
  readonly expiresAt: number;
  readonly content: PreviewContent;
  readonly accountProof: "not-established";
  readonly currentBalanceProof: "not-established";
}
export interface ReviewReceipt {
  readonly schema: typeof REVIEW_SCHEMA;
  readonly dataGeneration: number;
  readonly operationId: string;
  readonly outcome: "saved" | "deleted";
  readonly benefitId: string;
  readonly benefitRevision: number;
  readonly replayed: boolean;
  readonly content: BenefitContent | null;
}
