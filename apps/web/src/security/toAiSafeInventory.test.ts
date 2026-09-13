import { describe, expect, it } from "vitest";

import { SyntheticVaultCatalogRepository } from "../repositories/SyntheticVaultCatalogRepository";
import { toAiSafeInventory } from "./toAiSafeInventory";

describe("toAiSafeInventory", () => {
  const vaultItems = new SyntheticVaultCatalogRepository().list();

  it("emits only the reviewed allowlist fields", () => {
    const result = toAiSafeInventory(vaultItems);

    expect(Object.keys(result)).toEqual(["schemaVersion", "entries"]);
    expect(Object.keys(result.entries[0] ?? {})).toEqual([
      "reference",
      "serviceName",
      "kind",
      "environment",
      "status",
      "privilegeLevel",
      "createdAt",
      "lastRotatedAt",
      "expiresAt",
      "connectionCount",
    ]);
  });

  it("never serializes secrets or local-only metadata", () => {
    const serialized = JSON.stringify(toAiSafeInventory(vaultItems));

    for (const metadata of vaultItems) {
      expect(serialized).not.toContain(metadata.accountHint);
      expect(serialized).not.toContain(metadata.notes);
      expect(serialized).not.toContain(metadata.sourceUrl);

      for (const connectionLabel of metadata.connectionLabels) {
        expect(serialized).not.toContain(connectionLabel);
      }
    }

    expect(serialized).not.toContain("DEMO_VALUE_ONLY_");
  });
});
