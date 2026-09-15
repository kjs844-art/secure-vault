import type {
  CatalogConnectionTypeV1, CatalogCredentialTypeV1, CatalogStatusV1, LocalCatalogEntryV1,
} from "../../bridge/catalogProtocol";

export const MAX_LOCAL_QUERY_LENGTH = 256;
export type ConnectionFilter = "all" | "connected" | "unconnected" | "mcp";

export const consumerLabels: Readonly<Record<CatalogConnectionTypeV1, string>> = Object.freeze({
  app: "앱", browser_extension: "브라우저 확장", plugin: "플러그인",
  mcp_server: "MCP 서버", cli: "CLI 도구", server: "서버", ci_cd: "CI/CD",
  cloud_project: "클라우드 프로젝트", custom: "기타",
});
export const credentialLabels: Readonly<Record<CatalogCredentialTypeV1, string>> = Object.freeze({
  password: "비밀번호", api_key: "API 키", oauth_client: "OAuth 클라이언트",
  cloud_access_key: "클라우드 접근 키", token: "토큰", recovery_code: "복구 코드", custom: "사용자 정의",
});
export const statusLabels: Readonly<Record<CatalogStatusV1, string>> = Object.freeze({
  active: "사용 중", rotation_due: "교체 필요", rotating: "교체 중", expired: "만료됨",
  compromised: "노출 의심", revoked: "폐기됨", disabled: "비활성", unknown: "상태 미확인",
});

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko");
}

/** Search only an already validated, unlocked display snapshot. No cache or I/O. */
export function searchLocalCatalog(
  entries: readonly LocalCatalogEntryV1[], query: string, filter: ConnectionFilter = "all",
): readonly LocalCatalogEntryV1[] {
  // Do not silently truncate into a different (possibly much broader) query.
  if (query.length > MAX_LOCAL_QUERY_LENGTH) return [];
  if (!["all", "connected", "unconnected", "mcp"].includes(filter)) return [];
  const words = normalize(query).trim().split(/\s+/u).filter(Boolean);
  return entries.filter((entry) => {
    if (filter === "connected" && entry.connections.length === 0) return false;
    if (filter === "unconnected" && entry.connections.length !== 0) return false;
    if (filter === "mcp" && !entry.connections.some((connection) => connection.consumerType === "mcp_server")) return false;
    // Explicit allowlist. Never stringify the object: extra future properties
    // (notes, URLs, secrets) must not become searchable automatically. The four
    // reviewed issuer fields remain local-only, never AI inventory fields.
    const fields = [entry.providerName, entry.itemName, entry.credentialType,
      ...[entry.issuerAccountIdentifier, entry.issuerOrganizationOrWorkspace,
        entry.issuerProject, entry.issuerEnvironment].filter((value): value is string => value !== null),
      credentialLabels[entry.credentialType], entry.status, statusLabels[entry.status],
      ...entry.connections.flatMap((connection) => [connection.label,
        connection.consumerType, consumerLabels[connection.consumerType]]),
    ].map(normalize);
    return words.every((word) => fields.some((field) => field.includes(word)));
  });
}
