import type { VaultItemMetadata } from "../domain/vault";

export const aiSafeInventoryVersion = 1 as const;

export interface AiSafeVaultItem {
  readonly reference: string;
  readonly serviceName: string;
  readonly kind: VaultItemMetadata["kind"];
  readonly environment: VaultItemMetadata["environment"];
  readonly status: VaultItemMetadata["status"];
  readonly privilegeLevel: VaultItemMetadata["privilegeLevel"];
  readonly createdAt: string;
  readonly lastRotatedAt: string | null;
  readonly expiresAt: string | null;
  readonly connectionCount: number;
}

export interface AiSafeInventory {
  readonly schemaVersion: typeof aiSafeInventoryVersion;
  readonly entries: readonly AiSafeVaultItem[];
}

/**
 * Converts vault items with an explicit allowlist. Secret material, account
 * hints, arbitrary notes, URLs, tags, and connection names are not copied.
 */
export function toAiSafeInventory(
  vaultItems: readonly VaultItemMetadata[],
): AiSafeInventory {
  return {
    schemaVersion: aiSafeInventoryVersion,
    entries: vaultItems.map((metadata, index) => ({
      reference: `entry-${index + 1}`,
      serviceName: metadata.serviceName,
      kind: metadata.kind,
      environment: metadata.environment,
      status: metadata.status,
      privilegeLevel: metadata.privilegeLevel,
      createdAt: metadata.createdAt,
      lastRotatedAt: metadata.lastRotatedAt,
      expiresAt: metadata.expiresAt,
      connectionCount: metadata.connectionLabels.length,
    })),
  };
}
