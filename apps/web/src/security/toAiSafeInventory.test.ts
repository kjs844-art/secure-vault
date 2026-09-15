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

  it("does not read or serialize newly projected private issuer fields", () => {
    const privateFields = ["issuerAccountIdentifier", "issuerOrganizationOrWorkspace", "issuerProject", "issuerEnvironment"];
    const metadata = { ...vaultItems[0]! };
    for (const field of privateFields) {
      Object.defineProperty(metadata, field, { enumerable: true, get() { throw new Error("PRIVATE_ISSUER_GETTER_READ"); } });
    }
    expect(toAiSafeInventory([metadata])).toEqual(toAiSafeInventory([vaultItems[0]!]));
    const withValues = { ...vaultItems[0]!, issuerAccountIdentifier: "PRIVATE_ACCOUNT_FIXTURE",
      issuerOrganizationOrWorkspace: "PRIVATE_WORKSPACE_FIXTURE", issuerProject: "PRIVATE_PROJECT_FIXTURE",
      issuerEnvironment: "PRIVATE_ENVIRONMENT_FIXTURE" };
    const serialized = JSON.stringify(toAiSafeInventory([withValues]));
    for (const field of privateFields) expect(serialized).not.toContain(field);
    expect(serialized).not.toContain("PRIVATE_");
    // Legacy fixture environment remains its existing reviewed field; do not
    // substitute the private issuerEnvironment into it.
    expect(toAiSafeInventory([withValues]).entries[0]?.environment).toBe(vaultItems[0]!.environment);
  });
});
