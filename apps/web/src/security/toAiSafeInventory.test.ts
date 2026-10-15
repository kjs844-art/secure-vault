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

  it("does not dereference excluded metadata or connection-label values", () => {
    const metadata = { ...vaultItems[0]! };
    const failIfRead = () => {
      throw new Error("EXCLUDED_METADATA_READ");
    };

    for (const field of ["id", "accountHint", "notes", "sourceUrl"] as const) {
      Object.defineProperty(metadata, field, {
        configurable: true,
        enumerable: true,
        get: failIfRead,
      });
    }

    const connectionLabels = ["SYNTHETIC_CONNECTION_DO_NOT_COPY"];
    Object.defineProperty(connectionLabels, 0, {
      configurable: true,
      enumerable: true,
      get: failIfRead,
    });
    Object.defineProperty(metadata, "connectionLabels", {
      configurable: true,
      enumerable: true,
      value: connectionLabels,
    });

    const result = toAiSafeInventory([metadata]);

    expect(result.entries[0]?.connectionCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_CONNECTION_DO_NOT_COPY");
  });

  it("does not read or serialize projected private credential and issuer fields", () => {
    const privateFields = [
      "issuerAccountIdentifier",
      "issuerOrganizationOrWorkspace",
      "issuerProject",
      "issuerEnvironment",
      "apiKey",
      "password",
      "secretKey",
      "oauthRefreshToken",
      "mcpAuthorization",
      "recoveryCode",
    ];
    const metadata = { ...vaultItems[0]! };
    for (const field of privateFields) {
      Object.defineProperty(metadata, field, { enumerable: true, get() { throw new Error("PRIVATE_ISSUER_GETTER_READ"); } });
    }
    expect(toAiSafeInventory([metadata])).toEqual(toAiSafeInventory([vaultItems[0]!]));
    const syntheticCredentialValues = {
      first: "DEMO_VALUE_ONLY_API_KEY_SHOULD_NOT_APPEAR",
      second: "DEMO_VALUE_ONLY_PASSWORD_SHOULD_NOT_APPEAR",
      third: "DEMO_VALUE_ONLY_SECRET_KEY_SHOULD_NOT_APPEAR",
      fourth: "DEMO_VALUE_ONLY_REFRESH_TOKEN_SHOULD_NOT_APPEAR",
      fifth: "DEMO_VALUE_ONLY_MCP_AUTH_SHOULD_NOT_APPEAR",
      sixth: "DEMO_VALUE_ONLY_RECOVERY_CODE_SHOULD_NOT_APPEAR",
    };
    const withValues = {
      ...vaultItems[0]!,
      issuerAccountIdentifier: "PRIVATE_ACCOUNT_FIXTURE",
      issuerOrganizationOrWorkspace: "PRIVATE_WORKSPACE_FIXTURE",
      issuerProject: "PRIVATE_PROJECT_FIXTURE",
      issuerEnvironment: "PRIVATE_ENVIRONMENT_FIXTURE",
      apiKey: syntheticCredentialValues.first,
      password: syntheticCredentialValues.second,
      secretKey: syntheticCredentialValues.third,
      oauthRefreshToken: syntheticCredentialValues.fourth,
      mcpAuthorization: syntheticCredentialValues.fifth,
      recoveryCode: syntheticCredentialValues.sixth,
    };
    const serialized = JSON.stringify(toAiSafeInventory([withValues]));
    for (const field of privateFields) expect(serialized).not.toContain(field);
    expect(serialized).not.toContain("PRIVATE_");
    expect(serialized).not.toContain("DEMO_VALUE_ONLY_");
    // Legacy fixture environment remains its existing reviewed field; do not
    // substitute the private issuerEnvironment into it.
    expect(toAiSafeInventory([withValues]).entries[0]?.environment).toBe(vaultItems[0]!.environment);
  });
});
