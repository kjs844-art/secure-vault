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
 * 이 값은 사람이 기록한 주장이다. validator는 HTTP 요청을 보내지 않으므로
 * HTTP 200을 증명하지 못하고, 형태·날짜의 일관성만 검사한다.
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
const MAX_CATALOG_ENTRIES = 2_048;
const MAX_ID_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_OFFICIAL_HOSTS = 32;
const MAX_DOC_LINKS = PROVIDER_DOC_LINK_KINDS_V1.length;
const MAX_DOC_LINK_URL_LENGTH = 4_096;
const MAX_CREDENTIAL_TYPE_LENGTH = Math.max(...CATALOG_CREDENTIAL_TYPES_V1.map((type) => type.length));

// Curated identity pins are independent of catalog entries. A catalog author
// cannot make an arbitrary documentation host trusted by editing officialHosts.
const PINNED_OFFICIAL_HOSTS_V1: Readonly<Record<string, readonly string[]>> = Object.freeze({
  anthropic: Object.freeze(["anthropic.com", "claude.com"]),
  aws: Object.freeze(["aws.amazon.com"]),
  github: Object.freeze(["github.com"]),
  "google-cloud": Object.freeze(["cloud.google.com"]),
  openai: Object.freeze(["openai.com"]),
  slack: Object.freeze(["slack.com", "slack.dev"]),
  stripe: Object.freeze(["stripe.com"]),
});

// Full documentation URLs are pinned separately too: an official site's
// user-controlled path is not automatically reviewed product documentation.
const PINNED_DOC_URLS_V1: Readonly<Record<string, readonly string[]>> = Object.freeze({
  anthropic: Object.freeze(["https://platform.claude.com/docs/en/api/overview"]),
  aws: Object.freeze(["https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html"]),
  github: Object.freeze(["https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"]),
  "google-cloud": Object.freeze(["https://docs.cloud.google.com/docs/authentication/api-keys"]),
  openai: Object.freeze([]),
  slack: Object.freeze(["https://docs.slack.dev/authentication/tokens/"]),
  stripe: Object.freeze(["https://docs.stripe.com/keys"]),
});

export type ProviderMetadataIssueV1 =
  | "INVALID_CATALOG" | "INVALID_ENTRY"
  | "DUPLICATE_ID" | "UNSORTED_IDS" | "INVALID_ID" | "INVALID_DISPLAY_NAME"
  | "INVALID_CATEGORY" | "INVALID_HOSTS" | "INVALID_CREDENTIAL_TYPES"
  | "INVALID_DOC_LINK" | "DOC_LINK_OFF_HOST" | "DUPLICATE_DOC_LINK_KIND"
  | "INVALID_LINK_CHECK" | "UNEXPECTED_FIELD"
  | "UNTRUSTED_PROVIDER" | "UNTRUSTED_HOSTS" | "UNTRUSTED_DOC_LINK"
  | "UNTRUSTED_METADATA";

/**
 * `index`는 문제가 된 catalog 원소 위치다. catalog 자체가 배열이 아니면
 * 가리킬 원소가 없으므로 `null`이며, 이때 issue는 항상 `INVALID_CATALOG`다.
 */
export interface ProviderMetadataIssueReportV1 {
  readonly index: number | null;
  readonly issue: ProviderMetadataIssueV1;
}

export interface ProviderMetadataValidationOptionsV1 {
  /** 미래 날짜 판정 기준 시각. 테스트 재현성을 위해 주입할 수 있다. 기본값은 현재 시각. */
  readonly now?: Date;
}

type PlainRecord = Readonly<Record<string, unknown>>;

// null·primitive·array·Date/Map 같은 특수 객체는 record로 인정하지 않는다.
function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(value: PlainRecord, allowed: readonly string[]): boolean {
  // JSON.parse objects have enumerable fields. Reject oversized or unknown
  // ones before Reflect.ownKeys allocates an array of every own property.
  let enumerableCount = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    enumerableCount += 1;
    if (enumerableCount > allowed.length || !allowed.includes(key)) return false;
  }
  // Keep Reflect for Symbol and non-enumerable own fields in non-JSON callers.
  const keys = Reflect.ownKeys(value);
  return keys.length === allowed.length &&
    keys.every((key) => typeof key === "string" && allowed.includes(key));
}

/** 모든 원소가 문자열이고 길이 제한 이내인 배열이면 복사본을, 아니면 null을 돌려준다. */
function readStringArray(value: unknown, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxLength) return null;
  const strings: string[] = [];
  // for 루프로 돌아 sparse array의 빈 칸도 undefined로 검사한다.
  for (let i = 0; i < value.length; i += 1) {
    const item: unknown = value[i];
    if (typeof item !== "string") return null;
    strings.push(item);
  }
  return strings;
}

function isUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function isOnOfficialHost(hostname: string, officialHosts: readonly string[]): boolean {
  return officialHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function isValidDocLink(link: unknown): URL | null {
  if (!isPlainRecord(link) || !hasExactKeys(link, DOC_LINK_KEYS)) return null;
  if (!isOneOf(link.kind, PROVIDER_DOC_LINK_KINDS_V1)) return null;
  const raw = link.url;
  if (typeof raw !== "string" || raw.length > MAX_DOC_LINK_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // 인증정보·port·query·fragment가 섞인 링크는 추적·유출 경로가 될 수 있어 거부한다.
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
      url.port !== "" || url.search !== "" || url.hash !== "" || url.href !== raw) {
    return null;
  }
  return url;
}

/** 오늘(UTC) 00:00 시각. `now`가 유효하지 않으면 null을 돌려 PASS 날짜를 모두 거부하게 한다. */
function startOfUtcDay(now: Date): number | null {
  const time = now.getTime();
  if (Number.isNaN(time)) return null;
  const day = new Date(time);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

function isValidLinkCheck(check: unknown, linkCount: number, todayUtc: number | null): boolean {
  if (!isPlainRecord(check) || !hasExactKeys(check, LINK_CHECK_KEYS)) return false;
  if (check.scope !== "http_reachability") return false;
  if (check.result === "UNKNOWN") return check.checkedOn === null;
  if (check.result !== "PASS" || linkCount === 0) return false;
  const checkedOn = check.checkedOn;
  if (typeof checkedOn !== "string" || checkedOn.length !== 10 || !DATE_PATTERN.test(checkedOn)) return false;
  const parsed = new Date(`${checkedOn}T00:00:00Z`);
  // 달력에 없는 날짜(2026-02-30 등)는 Date가 다음 달로 넘기므로 왕복 비교로 거부한다.
  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(checkedOn)) return false;
  // 아직 오지 않은 날짜(UTC 기준)에 확인했다는 기록은 증거가 될 수 없다.
  return todayUtc !== null && parsed.getTime() <= todayUtc;
}

/**
 * 오류가 없으면 빈 배열을 돌려준다. 입력은 TypeScript 타입과 무관하게 신뢰하지 않는
 * `unknown`으로 다루며, 형태가 틀리면 예외 대신 fail-closed 오류 목록을 돌려준다.
 * JSON parse 후 검사 비용은 catalog 2,048개 항목, 공식 호스트 32개, 문서 링크 종류 수,
 * URL 문자열 4,096자, ID 64자로 제한한다. JSON.parse 자체의 입력 메모리 사용량은 이 함수의
 * 보호 범위가 아니다.
 *
 * 보장 범위: JSON.parse 결과처럼 JSON-compatible한 값(plain object·array·string·number·
 * boolean·null)과 undefined에 한정한다. 접근 시 예외를 던지거나 값을 바꾸는 악의적인
 * Proxy·getter 객체까지 안전하다고 보장하지 않는다.
 *
 * 이 함수는 네트워크 요청을 하지 않는다. `linkCheck`의 PASS가 실제 HTTP 200이었는지는
 * 증명하지 못하며, 날짜·형태가 증거 규칙과 맞는지만 확인한다.
 */
export function validateProviderMetadataCatalogV1(
  catalog: unknown,
  options: ProviderMetadataValidationOptionsV1 = {},
): readonly ProviderMetadataIssueReportV1[] {
  if (!Array.isArray(catalog) || catalog.length > MAX_CATALOG_ENTRIES) {
    return [{ index: null, issue: "INVALID_CATALOG" }];
  }

  const issues: ProviderMetadataIssueReportV1[] = [];
  const report = (index: number, issue: ProviderMetadataIssueV1) => issues.push({ index, issue });
  const seenIds = new Set<string>();
  const todayUtc = startOfUtcDay(options.now ?? new Date());
  // 앞에서 마지막으로 본 문자열 id. 형태가 깨진 원소를 사이에 둬도 정렬 위반을 놓치지 않는다.
  let previousId: string | null = null;

  for (let index = 0; index < catalog.length; index += 1) {
    const entry: unknown = catalog[index];
    if (!isPlainRecord(entry)) {
      report(index, "INVALID_ENTRY");
      continue;
    }
    if (!hasExactKeys(entry, PROVIDER_KEYS)) {
      report(index, "UNEXPECTED_FIELD");
      continue;
    }

    const rawId = entry.id;
    if (typeof rawId !== "string" || rawId.length > MAX_ID_LENGTH) {
      report(index, "INVALID_ID");
    } else {
      if (!ID_PATTERN.test(rawId)) report(index, "INVALID_ID");
      if (seenIds.has(rawId)) report(index, "DUPLICATE_ID");
      seenIds.add(rawId);
      if (previousId !== null && previousId >= rawId) report(index, "UNSORTED_IDS");
      previousId = rawId;
    }

    const name = entry.displayName;
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_DISPLAY_NAME_LENGTH ||
        name.trim() !== name) {
      report(index, "INVALID_DISPLAY_NAME");
    }
    if (!isOneOf(entry.category, PROVIDER_CATEGORIES_V1)) report(index, "INVALID_CATEGORY");

    const hosts = readStringArray(entry.officialHosts, MAX_OFFICIAL_HOSTS);
    if (hosts === null || hosts.length === 0 ||
        !hosts.every((host) => host.length <= MAX_HOSTNAME_LENGTH && HOST_PATTERN.test(host)) ||
        !isUniqueStrings(hosts)) {
      report(index, "INVALID_HOSTS");
    }
    const credentialTypes = readStringArray(entry.credentialTypes, CATALOG_CREDENTIAL_TYPES_V1.length);
    if (credentialTypes === null || credentialTypes.length === 0 ||
        !credentialTypes.every((type) => type.length <= MAX_CREDENTIAL_TYPE_LENGTH &&
          isOneOf(type, CATALOG_CREDENTIAL_TYPES_V1)) || !isUniqueStrings(credentialTypes)) {
      report(index, "INVALID_CREDENTIAL_TYPES");
    }

    const docLinks: unknown = entry.docLinks;
    let linkCount = 0;
    if (!Array.isArray(docLinks)) {
      report(index, "INVALID_DOC_LINK");
    } else {
      linkCount = docLinks.length;
      if (docLinks.length > MAX_DOC_LINKS) {
        report(index, "INVALID_DOC_LINK");
      } else {
        const kinds: string[] = [];
        for (let i = 0; i < docLinks.length; i += 1) {
          const link: unknown = docLinks[i];
          const url = isValidDocLink(link);
          if (url === null) report(index, "INVALID_DOC_LINK");
          // host 목록 자체가 문자열 배열이 아니면 대조할 기준이 없어 INVALID_HOSTS로만 보고한다.
          else if (hosts !== null && !isOnOfficialHost(url.hostname, hosts)) report(index, "DOC_LINK_OFF_HOST");
          if (isPlainRecord(link) && typeof link.kind === "string") kinds.push(link.kind);
        }
        if (!isUniqueStrings(kinds)) report(index, "DUPLICATE_DOC_LINK_KIND");
      }
    }
    // docLinks가 배열이 아니면 확인된 링크가 0개이므로 PASS 증거도 거부된다.
    if (!isValidLinkCheck(entry.linkCheck, linkCount, todayUtc)) report(index, "INVALID_LINK_CHECK");
  }

  return issues;
}

/**
 * Curated-only gate. The structural validator accepts arbitrary provider IDs
 * for synthetic tests; this one matches every entry against reviewed code
 * metadata, plus separately pinned hosts and exact documentation URLs.
 * It does not fetch URLs or prove their content, and raw import bytes still need
 * a separate size limit before JSON.parse.
 */
export function validateCuratedProviderMetadataCatalogV1(
  catalog: unknown,
  options: ProviderMetadataValidationOptionsV1 = {},
): readonly ProviderMetadataIssueReportV1[] {
  const structuralIssues = validateProviderMetadataCatalogV1(catalog, options);
  if (structuralIssues.length > 0) return structuralIssues;

  // An empty structural report establishes the shape within this function's
  // documented JSON-compatible input boundary.
  const entries = catalog as readonly ProviderMetadataV1[];
  const issues: ProviderMetadataIssueReportV1[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (!Object.hasOwn(PINNED_OFFICIAL_HOSTS_V1, entry.id)) {
      issues.push({ index, issue: "UNTRUSTED_PROVIDER" });
      continue;
    }
    const pinned = PINNED_OFFICIAL_HOSTS_V1[entry.id]!;
    const pinnedUrls = PINNED_DOC_URLS_V1[entry.id]!;
    const reviewed = findProviderMetadataV1(entry.id);
    if (reviewed === undefined) {
      issues.push({ index, issue: "UNTRUSTED_PROVIDER" });
      continue;
    }
    if (entry.officialHosts.length !== pinned.length ||
        !entry.officialHosts.every((host) => pinned.includes(host))) {
      issues.push({ index, issue: "UNTRUSTED_HOSTS" });
    }
    for (const link of entry.docLinks) {
      if (!isOnOfficialHost(new URL(link.url).hostname, pinned)) {
        issues.push({ index, issue: "DOC_LINK_OFF_HOST" });
      }
      if (!pinnedUrls.includes(link.url)) {
        issues.push({ index, issue: "UNTRUSTED_DOC_LINK" });
      }
    }
    if (entry.displayName !== reviewed.displayName || entry.category !== reviewed.category ||
        entry.credentialTypes.length !== reviewed.credentialTypes.length ||
        entry.credentialTypes.some((type, at) => type !== reviewed.credentialTypes[at]) ||
        entry.docLinks.length !== reviewed.docLinks.length ||
        entry.docLinks.some((link, at) => link.kind !== reviewed.docLinks[at]?.kind ||
          link.url !== reviewed.docLinks[at]?.url) ||
        entry.linkCheck.result !== reviewed.linkCheck.result ||
        entry.linkCheck.scope !== reviewed.linkCheck.scope ||
        entry.linkCheck.checkedOn !== reviewed.linkCheck.checkedOn) {
      issues.push({ index, issue: "UNTRUSTED_METADATA" });
    }
  }
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

/**
 * id 오름차순. 링크는 위 날짜에 HTTP 200을 확인했다고 기록한 최종 redirect URL만 둔다.
 * 이 기록은 작성 시점의 수동 확인이며 validator나 테스트가 재현·증명하지 않는다.
 */
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

export const PROVIDER_METADATA_JSON_MAX_BYTES_V1 = 64 * 1_024;

export type ParsedCuratedProviderMetadataV1 =
  | { readonly ok: true; readonly entries: readonly ProviderMetadataV1[] }
  | { readonly ok: false; readonly issues: readonly ProviderMetadataIssueReportV1[] };

/**
 * Bounded entry point for a future JSON import. Never return parsed objects to
 * consumers: after exact curated validation, return only frozen code-owned
 * entries selected by the input IDs. This does not enable network imports.
 */
export function parseCuratedProviderMetadataJsonV1(
  raw: unknown,
  options: ProviderMetadataValidationOptionsV1 = {},
): ParsedCuratedProviderMetadataV1 {
  const invalidCatalog = (): ParsedCuratedProviderMetadataV1 => ({
    ok: false, issues: [{ index: null, issue: "INVALID_CATALOG" }],
  });
  if (typeof raw !== "string" || raw.length > PROVIDER_METADATA_JSON_MAX_BYTES_V1 ||
      new TextEncoder().encode(raw).byteLength > PROVIDER_METADATA_JSON_MAX_BYTES_V1) {
    return invalidCatalog();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return invalidCatalog(); }
  const issues = validateCuratedProviderMetadataCatalogV1(parsed, options);
  if (issues.length > 0) return { ok: false, issues };
  const ids = new Set((parsed as readonly ProviderMetadataV1[]).map((entry) => entry.id));
  return { ok: true, entries: Object.freeze(PROVIDER_METADATA_V1.filter((entry) => ids.has(entry.id))) };
}
