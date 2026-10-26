import type { ReviewAuthority, ReviewDependencies } from "../review/contracts";
import type { CatalogHttpError } from "./catalog-http-contracts";

export const REVIEW_HTTP_PREFIX = "/api/review/";
export const REVIEW_HTTP_ACTIONS = ["preview", "confirm", "reject", "delete", "get", "list"] as const;
export type ReviewHttpAction = typeof REVIEW_HTTP_ACTIONS[number];
export const REVIEW_REQUEST_HEADER = "review-v1";
export const MAX_REVIEW_REQUEST_BYTES = 16384;
export const MAX_REVIEW_RESPONSE_BYTES = 1048576;
export const MAX_REVIEW_REQUEST_MS = 10000;

/** Private credential input to a trusted adapter, never client-supplied authority. */
export interface ReviewSessionContext { readonly cookie: string | null }
export interface ReviewAdmissionRequest {
  readonly surface: typeof REVIEW_REQUEST_HEADER;
  readonly requestId: string;
  readonly action: ReviewHttpAction;
  readonly authority: ReviewAuthority;
  readonly notAfter: number;
}
export type ReviewAdmission =
  | { readonly allowed: true; readonly surface: typeof REVIEW_REQUEST_HEADER;
      readonly requestId: string; readonly action: ReviewHttpAction;
      readonly authority: ReviewAuthority; readonly expiresAt: number }
  | { readonly allowed: false; readonly retryAfterSeconds: number };
export interface ReviewHttpDependencies {
  readonly trustedOrigin: string;
  readonly requestTimeoutMs?: number;
  readSession(context: ReviewSessionContext, signal: AbortSignal): Promise<unknown>;
  // Shared atomic attempt limit, bound to this surface/request/action/session.
  // A replay still requires a permit. No live limiter/edge policy is provided.
  admit(request: ReviewAdmissionRequest, signal: AbortSignal): Promise<unknown>;
  // Actual adapter must enforce entry/commit authority, deadlines, uniqueness,
  // collection revision and reference predicates; return only after acknowledgement.
  transaction: ReviewDependencies["transaction"];
  now(): number;
  newId(): string;
}
// Shared fixed HTTP error vocabulary; no internal row/source/operation metadata.
export type ReviewHttpError = CatalogHttpError;
