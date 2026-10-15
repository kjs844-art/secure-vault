import type { CatalogDependencies } from "../catalog/contracts";
import type { ReviewAuthority } from "../review/contracts";

export const CATALOG_HTTP_PREFIX = "/api/catalog/";
export const CATALOG_HTTP_ACTIONS = ["create", "update", "delete", "get", "list"] as const;
export type CatalogHttpAction = typeof CATALOG_HTTP_ACTIONS[number];
export const CATALOG_REQUEST_HEADER = "catalog-v1";
export const MAX_CATALOG_REQUEST_BYTES = 16384;
export const MAX_CATALOG_RESPONSE_BYTES = 1048576;
export const MAX_CATALOG_REQUEST_MS = 10000;

/** Credential context for a trusted session adapter, never an HTTP principal. */
export interface CatalogSessionContext {
  readonly cookie: string | null;
}
export interface CatalogAdmissionRequest {
  readonly requestId: string;
  readonly action: CatalogHttpAction;
  readonly authority: ReviewAuthority;
  readonly notAfter: number;
}
export type CatalogAdmission =
  | { readonly allowed: true; readonly requestId: string; readonly action: CatalogHttpAction;
      readonly authority: ReviewAuthority; readonly expiresAt: number }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface CatalogHttpDependencies {
  // Operator-configured exact origin. Never infer this from Host/Forwarded/body.
  readonly trustedOrigin: string;
  // Internal/test configuration only, positive integer <= MAX_CATALOG_REQUEST_MS.
  readonly requestTimeoutMs?: number;
  // Verify the actual server-side session, not a user/role supplied in JSON.
  // Repeated reads must observe revocation/revision/generation/expiry changes.
  readSession(context: CatalogSessionContext, signal: AbortSignal): Promise<unknown>;
  // Atomic shared attempt limiter. The matching permit is request/action/session
  // bound; a repeated operationId does not bypass request limits. No live adapter
  // is supplied here. Unauthenticated edge/IP limits remain deployment work.
  admit(request: CatalogAdmissionRequest, signal: AbortSignal): Promise<unknown>;
  // Enforce app auth, deadline, unique/CAS/reference predicates at entry+commit.
  // Must not return before commit acknowledgement. Failure can follow a commit.
  transaction: CatalogDependencies["transaction"];
  now(): number;
  newId(): string;
}
export type CatalogHttpError =
  | "API_NOT_FOUND" | "API_METHOD_NOT_ALLOWED" | "API_REQUEST_REJECTED"
  | "API_MEDIA_TYPE" | "API_BODY_TOO_LARGE" | "API_INPUT_INVALID"
  | "API_AUTH_REQUIRED" | "API_SESSION_CHANGED" | "API_RATE_LIMITED"
  | "API_CONFLICT" | "API_UNAVAILABLE" | "API_TIMEOUT" | "API_ABORTED";
