import {
  CATALOG_CREDENTIAL_TYPES_V1,
  type CatalogCredentialTypeV1,
} from "../../bridge/catalogProtocol";

/**
 * 제공자 공개 metadata v1.
 * 누구나 볼 수 있는 공식 문서 정보만 담는다. 사용자 계정·조직·프로젝트,
 * key prefix 예시, Secret 값은 절대 넣지 않는다.
 */
export const PROVIDER_CATEGORIES_V1 = [
  "source_control", "cloud", "ai_api", "payments", "messaging",
] as const;
export type ProviderCategoryV1 = (typeof PROVIDER_CATEGORIES_V1)[number];

export const PROVIDER_DOC_LINK_KINDS_V1 = ["credentials", "api_overview"] as const;
export type ProviderDocLinkKindV1 = (typeof PROVIDER_DOC_LINK_KINDS_V1)[number];

export interface ProviderDocLinkV1 {
  readonly kind: ProviderDocLinkKindV1;
  readonly url: string;
}

/**
 * 링크 확인 증거. `PASS`는 해당 날짜의 HTTP 도달 여부만 뜻하며 문서 내용의
 * 정확성 검토가 아니다. 증거가 없으면 `UNKNOWN`이다.
 */
export type ProviderLinkCheckV1 =
  | { readonly result: "PASS"; readonly scope: "http_reachability"; readonly checkedOn: string }
  | { readonly result: "UNKNOWN"; readonly scope: "http_reachability"; readonly checkedOn: null };

export interface ProviderMetadataV1 {
  readonly id: string;
  readonly displayName: string;
  readonly category: ProviderCategoryV1;
  readonly officialHosts: readonly string[];
  readonly credentialTypes: readonly CatalogCredentialTypeV1[];
  readonly docLinks: readonly ProviderDocLinkV1[];
  readonly linkCheck: ProviderLinkCheckV1;
}

const PROVIDER_KEYS = [
  "id", "displayName", "category", "officialHosts", "credentialTypes", "docLinks", "linkCheck",
] as const;
const DOC_LINK_KEYS = ["kind", "url"] as const;
const LINK_CHECK_KEYS = ["result", "scope", "checkedOn"] as const;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DISPLAY_NAME_LENGTH = 64;

export type ProviderMetadataIssueV1 =
  | "DUPLICATE_ID" | "UNSORTED_IDS" | "INVALID_ID" | "INVALID_DISPLAY_NAME"
  | "INVALID_CATEGORY" | "INVALID_HOSTS" | "INVALID_CREDENTIAL_TYPES"
  | "INVALID_DOC_LINK" | "DOC_LINK_OFF_HOST" | "DUPLICATE_DOC_LINK_KIND"
  | "INVALID_LINK_CHECK" | "UNEXPECTED_FIELD";

export interface ProviderMetadataIssueReportV1 {
  readonly index: number;
  readonly issue: ProviderMetadataIssueV1;
}

function hasExactKeys(value: object, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isOnOfficialHost(hostname: string, officialHosts: readonly string[]): boolean {
  return officialHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function isValidDocLink(link: ProviderDocLinkV1): URL | null {
  if (!hasExactKeys(link, DOC_LINK_KEYS)) return null;
  if (!(PROVIDER_DOC_LINK_KINDS_V1 as readonly string[]).includes(link.kind)) return null;
  let url: URL;
  try {
    url = new URL(link.url);
  } catch {
    return null;
  }
  // 인증정보·port·query·fragment가 섞인 링크는 추적·유출 경로가 될 수 있어 거부한다.
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
      url.port !== "" || url.search !== "" || url.hash !== "" || url.href !== link.url) {
    return null;
  }
  return url;
}

function isValidLinkCheck(check: ProviderLinkCheckV1, linkCount: number): boolean {
  if (!hasExactKeys(check, LINK_CHECK_KEYS) || check.scope !== "http_reachability") return false;
  if (check.result === "UNKNOWN") return check.checkedOn === null;
  if (check.result !== "PASS" || linkCount === 0) return false;
  if (typeof check.checkedOn !== "string" || !DATE_PATTERN.test(check.checkedOn)) return false;
  const parsed = new Date(`${check.checkedOn}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(check.checkedOn);
}

/** 오류가 없으면 빈 배열을 돌려준다. 입력은 신뢰하지 않는 값으로 다룬다. */
export function validateProviderMetadataCatalogV1(
  catalog: readonly ProviderMetadataV1[],
): readonly ProviderMetadataIssueReportV1[] {
  const issues: ProviderMetadataIssueReportV1[] = [];
  const report = (index: number, issue: ProviderMetadataIssueV1) => issues.push({ index, issue });
  const seenIds = new Set<string>();

  catalog.forEach((entry, index) => {
    if (!hasExactKeys(entry, PROVIDER_KEYS)) {
      report(index, "UNEXPECTED_FIELD");
      return;
    }
    if (!ID_PATTERN.test(entry.id)) report(index, "INVALID_ID");
    if (seenIds.has(entry.id)) report(index, "DUPLICATE_ID");
    seenIds.add(entry.id);
    const previous = catalog[index - 1];
    if (previous !== undefined && previous.id >= entry.id) report(index, "UNSORTED_IDS");

    const name = entry.displayName;
    if (typeof name !== "string" || name.length === 0 || name.trim() !== name ||
        name.length > MAX_DISPLAY_NAME_LENGTH) {
      report(index, "INVALID_DISPLAY_NAME");
    }
    if (!(PROVIDER_CATEGORIES_V1 as readonly string[]).includes(entry.category)) {
      report(index, "INVALID_CATEGORY");
    }
    if (entry.officialHosts.length === 0 || !isUniqueStrings(entry.officialHosts) ||
        !entry.officialHosts.every((host) => HOST_PATTERN.test(host))) {
      report(index, "INVALID_HOSTS");
    }
    if (entry.credentialTypes.length === 0 || !isUniqueStrings(entry.credentialTypes) ||
        !entry.credentialTypes.every((type) =>
          (CATALOG_CREDENTIAL_TYPES_V1 as readonly string[]).includes(type))) {
      report(index, "INVALID_CREDENTIAL_TYPES");
    }

    entry.docLinks.forEach((link) => {
      const url = isValidDocLink(link);
      if (url === null) report(index, "INVALID_DOC_LINK");
      else if (!isOnOfficialHost(url.hostname, entry.officialHosts)) report(index, "DOC_LINK_OFF_HOST");
    });
    if (!isUniqueStrings(entry.docLinks.map((link) => link.kind))) {
      report(index, "DUPLICATE_DOC_LINK_KIND");
    }
    if (!isValidLinkCheck(entry.linkCheck, entry.docLinks.length)) report(index, "INVALID_LINK_CHECK");
  });

  return issues;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const CHECKED_ON = "2026-09-24";

/** id 오름차순. 링크는 위 날짜에 HTTP 200을 확인한 최종 redirect URL만 둔다. */
export const PROVIDER_METADATA_V1: readonly ProviderMetadataV1[] = deepFreeze([
  {
    id: "anthropic",
    displayName: "Anthropic",
    category: "ai_api",
    officialHosts: ["anthropic.com", "claude.com"],
    credentialTypes: ["api_key"],
    docLinks: [{ kind: "api_overview", url: "https://platform.claude.com/docs/en/api/overview" }],
    linkCheck: { result: "PASS", scope: "http_reachability", checkedOn: CHECKED_ON },
  },
  {
    id: "aws",
    displayName: "Amazon Web Services",
    category: "cloud",
    officialHosts: ["aws.amazon.com"],
    credentialTypes: ["cloud_access_key"],
    docLinks: [{
      kind: "credentials",
      url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
    }],
    linkCheck: { result: "PASS", scope: "http_reachability", checkedOn: CHECKED_ON },
  },
  {
    id: "github",
    displayName: "GitHub",
    category: "source_control",
    officialHosts: ["github.com"],
    credentialTypes: ["token", "oauth_client"],
    docLinks: [{
      kind: "credentials",
      url: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    }],
    linkCheck: { result: "PASS", scope: "http_reachability", checkedOn: CHECKED_ON },
  },
  {
    id: "google-cloud",
    displayName: "Google Cloud",
    category: "cloud",
    officialHosts: ["cloud.google.com"],
    credentialTypes: ["api_key", "oauth_client", "cloud_access_key"],
    docLinks: [{ kind: "credentials", url: "https://docs.cloud.google.com/docs/authentication/api-keys" }],
    linkCheck: { result: "PASS", scope: "http_reachability", checkedOn: CHECKED_ON },
  },
  {
    // 공식 문서가 자동 요청에 403을 반환해 링크를 확인하지 못했다.
    id: "openai",
    displayName: "OpenAI",
    category: "ai_api",
    officialHosts: ["openai.com"],
    credentialTypes: ["api_key"],
    docLinks: [],
    linkCheck: { result: "UNKNOWN", scope: "http_reachability", checkedOn: null },
  },
  {
    id: "slack",
    displayName: "Slack",
    category: "messaging",
    officialHosts: ["slack.com", "slack.dev"],
    credentialTypes: ["token", "oauth_client"],
    docLinks: [{ kind: "credentials", url: "https://docs.slack.dev/authentication/tokens/" }],
    linkCheck: { result: "PASS", scope: "http_reachability", checkedOn: CHECKED_ON },
  },
  {
    id: "stripe",
    displayName: "Stripe",
    category: "payments",
    officialHosts: ["stripe.com"],
    credentialTypes: ["api_key"],
    docLinks: [{ kind: "credentials", url: "https://docs.stripe.com/keys" }],
    linkCheck: { result: "PASS", scope: "http_reachability", checkedOn: CHECKED_ON },
  },
] satisfies ProviderMetadataV1[]);

export function findProviderMetadataV1(id: string): ProviderMetadataV1 | undefined {
  return PROVIDER_METADATA_V1.find((entry) => entry.id === id);
}
