import type { CandidateBatchMapping, CandidateBatchReferenceDependencies,
  CandidateBatchResolutionRequest } from "../inbox/batch-reference-contracts";
import type { ReviewAuthority } from "../review/contracts";
import type { CatalogHttpError } from "./catalog-http-contracts";

export const INBOX_HTTP_PATH = "/api/inbox/batch";
export const INBOX_REQUEST_HEADER = "candidate-inbox-v1";
export const MAX_INBOX_REQUEST_BYTES = 1024;
export const MAX_INBOX_RESPONSE_BYTES = 1048576;
export const MAX_INBOX_REQUEST_MS = 10000;

export interface InboxSessionContext { readonly cookie: string | null }
export interface InboxAdmissionRequest {
  readonly surface: typeof INBOX_REQUEST_HEADER;
  readonly requestId: string;
  readonly action: "batch";
  readonly authority: ReviewAuthority;
  readonly notAfter: number;
}
export type InboxAdmission =
  | { readonly allowed: true; readonly surface: typeof INBOX_REQUEST_HEADER;
      readonly requestId: string; readonly action: "batch";
      readonly authority: ReviewAuthority; readonly expiresAt: number }
  | { readonly allowed: false; readonly retryAfterSeconds: number };
export type InboxBatchResolutionRequest = CandidateBatchResolutionRequest;
/** Private mapping. An opaque alias is NOT an authorization capability. */
export type InboxBatchMapping = CandidateBatchMapping;
export interface InboxHttpDependencies {
  readonly trustedOrigin: string;
  readonly requestTimeoutMs?: number;
  readSession(context: InboxSessionContext, signal: AbortSignal): Promise<unknown>;
  admit(request: InboxAdmissionRequest, signal: AbortSignal): Promise<unknown>;
  // Trusted, owner/generation-scoped lookup. Issuance is outside this handler.
  // Mappings must be immutable, durable where required, and retired aliases
  // must never be reassigned. Must not start a nested transaction: this port is
  // also called inside the inbox transaction. Repeated reads are not isolation;
  // requireBatchReference separately enforces exact active mapping at commit.
  // No analysis/staging grant is needed to read one's existing batch.
  resolveBatch(request: InboxBatchResolutionRequest, signal: AbortSignal): Promise<unknown>;
  // Enforce current app authority and deadline at entry AND commit; return only
  // after acknowledgement. This read must not stage, discard or mutate rows.
  transaction: CandidateBatchReferenceDependencies["transaction"];
  now(): number;
  newId(): string;
}
export type InboxHttpError = CatalogHttpError;
