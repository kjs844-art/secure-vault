import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";

function entry(
  reference: number,
  providerName: string,
  itemName: string,
  account: string | null,
  organization: string | null,
  project: string | null,
  environment: string | null,
  credentialType: LocalCatalogEntryV1["credentialType"],
  status: LocalCatalogEntryV1["status"],
  connections: LocalCatalogEntryV1["connections"],
): LocalCatalogEntryV1 {
  return Object.freeze({
    reference,
    providerName,
    itemName,
    issuerAccountIdentifier: account,
    issuerOrganizationOrWorkspace: organization,
    issuerProject: project,
    issuerEnvironment: environment,
    credentialType,
    status,
    secretFieldCount: 1,
    connectionCount: connections.length,
    mcpConnectionCount: connections.filter((connection) => connection.consumerType === "mcp_server").length,
    connections: Object.freeze(connections.map((connection) => Object.freeze(connection))),
  });
}

/** Closed synthetic demo graph. No real accounts, secrets, or discovery results. */
export const SYNTHETIC_IDENTITY_MAP_ENTRIES: readonly LocalCatalogEntryV1[] = Object.freeze([
  entry(
    0,
    "Example AI Workshop",
    "Workshop API Credential",
    "demo-workshop-owner",
    "Demo Workshop Org",
    "demo-assistants",
    "demo",
    "api_key",
    "active",
    [
      { label: "Example MCP", consumerType: "mcp_server" },
      { label: "Example CLI", consumerType: "cli" },
    ],
  ),
  entry(
    1,
    "Example AI Workshop",
    "Workshop Recovery Envelope",
    "demo-workshop-owner",
    "Demo Workshop Org",
    "demo-assistants",
    "demo",
    "recovery_code",
    "rotation_due",
    [],
  ),
  entry(
    2,
    "Example Cloud Lab",
    "Lab Deploy Token",
    "demo-lab-owner",
    "Demo Lab Workspace",
    "demo-deploy",
    "staging",
    "token",
    "active",
    [
      { label: "Example CI", consumerType: "ci_cd" },
      { label: "Example Server", consumerType: "server" },
    ],
  ),
  entry(
    3,
    "Example Cloud Lab",
    "Lab Unconnected Password",
    null,
    null,
    null,
    "demo",
    "password",
    "unknown",
    [],
  ),
]);
