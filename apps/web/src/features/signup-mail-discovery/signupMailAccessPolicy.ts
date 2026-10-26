export type MailMetadataProvider = "synthetic_fixture" | "gmail" | "microsoft_graph";

export type MailDiscoveryErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_VERSION"
  | "UNSUPPORTED_PROVIDER"
  | "EXCESSIVE_PERMISSION"
  | "LIVE_PROVIDER_UNAVAILABLE"
  | "INVALID_METADATA"
  | "SCAN_LIMIT_EXCEEDED"
  | "CONSENT_REQUIRED"
  | "STALE_PREVIEW"
  | "INVALID_STATE"
  | "SESSION_EXPIRED"
  | "SESSION_CLOSED";

/** Error messages contain fixed codes, never input or mail-provider errors. */
export class MailDiscoveryError extends Error {
  constructor(readonly code: MailDiscoveryErrorCode) {
    super(code);
    this.name = "MailDiscoveryError";
  }
}

export interface MailMetadataAccessPolicy {
  readonly provider: MailMetadataProvider;
  readonly scopes: readonly string[];
  readonly fields: readonly ["senderDomain", "subject", "receivedAt"];
  readonly processing: "local";
  readonly bodyAccess: false;
  readonly attachmentAccess: false;
  readonly fullTextQuery: false;
  readonly mailboxWrites: false;
  readonly adapterAvailable: boolean;
}

const REQUIRED_SCOPES: Readonly<Record<MailMetadataProvider, readonly string[]>> = Object.freeze({
  synthetic_fixture: Object.freeze([]),
  gmail: Object.freeze(["https://www.googleapis.com/auth/gmail.metadata"]),
  microsoft_graph: Object.freeze(["Mail.ReadBasic"]),
});

/**
 * Proposed provider policy, not proof of a token's granted privileges.
 * Live adapters remain unavailable. Gmail metadata does not allow `q` search.
 */
export function mailMetadataAccessPolicy(provider: unknown, scopes: unknown): MailMetadataAccessPolicy {
  try {
    return metadataPolicy(provider, scopes);
  } catch (error) {
    throw error instanceof MailDiscoveryError ? error : new MailDiscoveryError("EXCESSIVE_PERMISSION");
  }
}

function metadataPolicy(provider: unknown, scopes: unknown): MailMetadataAccessPolicy {
  if (provider !== "synthetic_fixture" && provider !== "gmail" && provider !== "microsoft_graph") {
    throw new MailDiscoveryError("UNSUPPORTED_PROVIDER");
  }
  const required = REQUIRED_SCOPES[provider];
  if (!Array.isArray(scopes) || Object.getPrototypeOf(scopes) !== Array.prototype || scopes.length !== required.length) {
    throw new MailDiscoveryError("EXCESSIVE_PERMISSION");
  }
  for (let i = 0; i < required.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(scopes, String(i));
    if (!descriptor || !("value" in descriptor) || descriptor.value !== required[i]) {
      throw new MailDiscoveryError("EXCESSIVE_PERMISSION");
    }
  }
  if (Reflect.ownKeys(scopes).length !== scopes.length + 1) {
    throw new MailDiscoveryError("EXCESSIVE_PERMISSION");
  }
  return Object.freeze({
    provider,
    scopes: required,
    fields: Object.freeze(["senderDomain", "subject", "receivedAt"] as const),
    processing: "local",
    bodyAccess: false,
    attachmentAccess: false,
    fullTextQuery: false,
    mailboxWrites: false,
    adapterAvailable: provider === "synthetic_fixture",
  });
}
