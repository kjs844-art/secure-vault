import { CATALOG_STATUSES_V1, type LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";

export type SyntheticConnectionId = 0 | 1 | 2;

export const SYNTHETIC_CONNECTION_OPTIONS = Object.freeze([
  Object.freeze({ id: 0, label: "Example MCP", consumerType: "mcp_server", description: "MCP 서버" } as const),
  Object.freeze({ id: 1, label: "Example CLI", consumerType: "cli", description: "명령줄 도구" } as const),
  Object.freeze({ id: 2, label: "Example CI", consumerType: "ci_cd", description: "CI/CD 자동화" } as const),
] as const);

/**
 * Local UI prefill hint only, never editing authority or proof of fixture origin.
 * Rust still authenticates every revision and validates hidden semantics/rotation.
 * Unsupported projections return null, distinctly from a known empty selection.
 */
export function seedSyntheticConnectionEdit(entry: LocalCatalogEntryV1): readonly SyntheticConnectionId[] | null {
  try {
    const knownItem = (entry.providerName === "Example AI Workshop"
      && (entry.itemName === "Example Workshop API Credential" || entry.itemName === "Example Workshop Registered API Key"))
      || (entry.providerName === "Example Cloud Lab" && entry.itemName === "Example Cloud Lab Registered API Key");
    if (!knownItem || entry.credentialType !== "api_key" || entry.status === "rotating"
        || !CATALOG_STATUSES_V1.includes(entry.status)
        || !Number.isSafeInteger(entry.reference) || entry.reference < 0 || entry.reference > 127
        || !Number.isSafeInteger(entry.connectionCount) || entry.connectionCount < 0 || entry.connectionCount > 3
        || !Number.isSafeInteger(entry.mcpConnectionCount) || entry.mcpConnectionCount < 0
        || !Array.isArray(entry.connections) || entry.connections.length !== entry.connectionCount) return null;

    const ids: SyntheticConnectionId[] = [];
    for (let index = 0; index < entry.connectionCount; index += 1) {
      const connection = entry.connections[index];
      if (!connection) return null;
      const option = SYNTHETIC_CONNECTION_OPTIONS.find((candidate) => (
        candidate.label === connection.label && candidate.consumerType === connection.consumerType
      ));
      if (!option || ids.includes(option.id)) return null;
      ids.push(option.id);
    }
    if (entry.mcpConnectionCount !== (ids.includes(0) ? 1 : 0)) return null;
    return Object.freeze(ids);
  } catch {
    // An unavailable/malformed projection is not an empty editable selection.
    return null;
  }
}

export function sameSyntheticConnectionOrder(
  left: readonly SyntheticConnectionId[], right: readonly SyntheticConnectionId[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
