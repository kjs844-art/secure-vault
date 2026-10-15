export const secretKinds = [
  "password",
  "api_key",
  "mcp_credential",
  "recovery_code",
] as const;

export type SecretKind = (typeof secretKinds)[number];
export type VaultEnvironment = "development" | "test" | "production";
export type VaultItemStatus = "active" | "rotation_due" | "revoked";
export type PrivilegeLevel = "read_only" | "read_write" | "admin" | "unknown";

export interface VaultItemMetadata {
  readonly id: string;
  readonly serviceName: string;
  readonly accountHint: string;
  readonly kind: SecretKind;
  readonly environment: VaultEnvironment;
  readonly status: VaultItemStatus;
  readonly privilegeLevel: PrivilegeLevel;
  readonly createdAt: string;
  readonly lastRotatedAt: string | null;
  readonly expiresAt: string | null;
  readonly connectionLabels: readonly string[];
  readonly notes: string;
  readonly sourceUrl: string;
}

/**
 * Hackathon fixtures only. This wrapper deliberately avoids implicit string or
 * JSON conversion so raw values cannot leak through routine logging.
 */
export class SyntheticSecret {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static fromFixture(value: string): SyntheticSecret {
    if (!value.startsWith("DEMO_VALUE_ONLY_")) {
      throw new Error(
        "Synthetic secrets must use the DEMO_VALUE_ONLY_ marker.",
      );
    }

    return new SyntheticSecret(value);
  }

  toJSON(): string {
    return "[REDACTED_SYNTHETIC_SECRET]";
  }

  toString(): string {
    return "[REDACTED_SYNTHETIC_SECRET]";
  }
}

export interface SyntheticVaultItem {
  readonly metadata: VaultItemMetadata;
  readonly secret: SyntheticSecret;
}
