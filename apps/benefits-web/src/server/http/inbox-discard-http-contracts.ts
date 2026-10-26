import type { CandidateBatchReferenceDependencies } from "../inbox/batch-reference-contracts";
import type { ReviewAuthority } from "../review/contracts";
import type { InboxHttpDependencies } from "./inbox-http-contracts";
import type { CatalogHttpError } from "./catalog-http-contracts";

export const INBOX_DISCARD_HTTP_PATH = "/api/inbox/discard";
export const INBOX_DISCARD_REQUEST_HEADER = "candidate-inbox-discard-v1";
export const MAX_INBOX_DISCARD_REQUEST_BYTES = 1024;
export const MAX_INBOX_DISCARD_RESPONSE_BYTES = 2048;
export const MAX_INBOX_DISCARD_REQUEST_MS = 10000;

export interface InboxDiscardAdmissionRequest {
  readonly surface: typeof INBOX_DISCARD_REQUEST_HEADER;
  readonly requestId: string;
  readonly action: "discard";
  readonly authority: ReviewAuthority;
  readonly notAfter: number;
}
export type InboxDiscardAdmission =
  | { readonly allowed: true; readonly surface: typeof INBOX_DISCARD_REQUEST_HEADER;
      readonly requestId: string; readonly action: "discard";
      readonly authority: ReviewAuthority; readonly expiresAt: number }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/** Separate mutation admission; a read permit never authorizes discarding.
 * No real session, database or public route is supplied by this contract. */
export interface InboxDiscardHttpDependencies extends
  Pick<InboxHttpDependencies, "trustedOrigin" | "requestTimeoutMs" | "readSession" | "resolveBatch" | "now" | "newId"> {
  admit(request: InboxDiscardAdmissionRequest, signal: AbortSignal): Promise<unknown>;
  // Serializable write transaction: current authority, deadline and exact active
  // alias/backing immutable batch at entry AND commit. Roll back all writes on
  // callback failure; acknowledge only committed completion. Pending -> deleted
  // and preview erasure are atomic. Do not expose this port to a read-only host.
  transaction: CandidateBatchReferenceDependencies["transaction"];
}
export type InboxDiscardHttpError = CatalogHttpError;
