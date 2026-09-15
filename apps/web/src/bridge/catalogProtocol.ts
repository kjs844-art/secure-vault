/** Local UI metadata only; not suitable for AI, analytics, or logs. */
export const CATALOG_CREDENTIAL_TYPES_V1 = [
  "password", "api_key", "oauth_client", "cloud_access_key",
  "token", "recovery_code", "custom",
] as const;
export const CATALOG_STATUSES_V1 = [
  "active", "rotation_due", "rotating", "expired",
  "compromised", "revoked", "disabled", "unknown",
] as const;
export type CatalogCredentialTypeV1 = (typeof CATALOG_CREDENTIAL_TYPES_V1)[number];
export type CatalogStatusV1 = (typeof CATALOG_STATUSES_V1)[number];

export const CATALOG_CONNECTION_TYPES_V1 = [
  "app", "browser_extension", "plugin", "mcp_server", "cli", "server",
  "ci_cd", "cloud_project", "custom",
] as const;
export type CatalogConnectionTypeV1 = (typeof CATALOG_CONNECTION_TYPES_V1)[number];
/** Private relationship labels: local display only, never AI or analytics. */
export interface LocalCatalogConnectionV1 {
  readonly label: string;
  readonly consumerType: CatalogConnectionTypeV1;
}

/** reference belongs to this snapshot only and is never an authorization token. */
export interface LocalCatalogEntryV1 {
  readonly reference: number;
  readonly itemName: string;
  readonly providerName: string;
  readonly credentialType: CatalogCredentialTypeV1;
  readonly status: CatalogStatusV1;
  readonly connectionCount: number;
  readonly secretFieldCount: number;
  readonly mcpConnectionCount: number;
  readonly connections: readonly LocalCatalogConnectionV1[];
}

/** Structural contract of the generated Rust WasmCatalogV1 class. */
export interface WasmCatalogV1 {
  length(): number;
  isLocked(): boolean;
  lock(): void;
  free(): void;
  itemName(reference: number): string;
  providerName(reference: number): string;
  credentialType(reference: number): string;
  status(reference: number): string;
  connectionCount(reference: number): number;
  secretFieldCount(reference: number): number;
  mcpConnectionCount(reference: number): number;
  connectionLabel(reference: number, index: number): string;
  connectionType(reference: number, index: number): string;
}

/** Each invocation transfers exclusive ownership of a fresh handle. */
export type WasmCatalogFactory = () => WasmCatalogV1 | Promise<WasmCatalogV1>;

export const CATALOG_ERROR_CODES_V1 = [
  "LOCKED", "INVALID_REFERENCE", "LIMITS_EXCEEDED", "AUTHENTICATION_FAILED",
  "UPGRADE_REQUIRED", "CRYPTO_FAILURE", "INVALID_CATALOG", "CANCELLED",
  "DISPOSED", "CLEANUP_FAILED", "BRIDGE_FAILURE", "INVALID_ARCHIVE",
] as const;
export type CatalogErrorCodeV1 = (typeof CATALOG_ERROR_CODES_V1)[number];

export const SYNTHETIC_TOOL_ERROR_CODES_V1 = [
  "VAULT_LOCKED", "INVALID_TOOL", "INVALID_PAYLOAD", "LIMIT_EXCEEDED", "OPERATION_FAILED",
] as const;
export type SyntheticToolErrorCodeV1 = (typeof SYNTHETIC_TOOL_ERROR_CODES_V1)[number];

export const SYNTHETIC_TOOL_QUERY_MAX_BYTES = 128;
export const SYNTHETIC_TOOL_MAX_RESULTS = 500;
export const SYNTHETIC_TOOL_FILTERS_V1 = ["all", "no_connection", "mcp_connection"] as const;
export type SyntheticToolFilterV1 = (typeof SYNTHETIC_TOOL_FILTERS_V1)[number];

export interface SyntheticSearchCatalogActionV1 {
  readonly op: "search_catalog";
  readonly query: string;
  readonly maxResults?: number;
}

export interface SyntheticFilterCatalogActionV1 {
  readonly op: "filter_catalog";
  readonly filter: SyntheticToolFilterV1;
}

export interface SyntheticLockVaultActionV1 {
  readonly op: "lock_vault";
}

export type SyntheticToolActionV1 =
  | SyntheticSearchCatalogActionV1
  | SyntheticFilterCatalogActionV1
  | SyntheticLockVaultActionV1;

export type SyntheticToolResultKindV1 = "catalog" | "ok" | "error";

export interface SyntheticCatalogToolCatalogResultV1 {
  readonly kind: "catalog";
  readonly entries: readonly LocalCatalogEntryV1[];
  readonly query: string;
  readonly filter: SyntheticToolFilterV1;
  readonly count: number;
}

export interface SyntheticCatalogToolOkResultV1 {
  readonly kind: "ok";
  readonly action: "lock_vault";
}

export interface SyntheticCatalogToolErrorResultV1 {
  readonly kind: "error";
  readonly code: SyntheticToolErrorCodeV1;
}

export type SyntheticCatalogToolResultV1 =
  | SyntheticCatalogToolCatalogResultV1
  | SyntheticCatalogToolOkResultV1
  | SyntheticCatalogToolErrorResultV1;

/** Untrusted thrown values never become UI messages or Error.cause. */
export class CatalogAdapterError extends Error {
  readonly code: CatalogErrorCodeV1;
  constructor(code: CatalogErrorCodeV1) {
    super(code);
    this.name = "CatalogAdapterError";
    this.code = code;
  }
}
