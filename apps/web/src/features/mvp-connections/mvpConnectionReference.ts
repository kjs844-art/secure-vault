import { CatalogAdapterError } from "../../bridge/catalogProtocol";

/**
 * M03 — 서비스·API 사용처 관계의 합성 연결 참조 계약.
 *
 * 폐쇄된 합성 fixture 식별자만 다룬다. 실제 서비스 슬러그·계정·키·토큰·
 * 비밀번호·URL query는 어떤 형태로도 입력받지 않는다.
 */

/** 공개 서비스 슬러그 allowlist. 실제 서비스 연동이나 식별이 아니다. */
export const MVP_CONNECTION_PROVIDER_SLUGS_V1 = [
  "openai",
  "anthropic",
  "claude",
  "gemini",
  "grok",
  "meta",
  "supabase",
  "github",
  "custom",
] as const;

export type MvpConnectionProviderSlugV1 = (typeof MVP_CONNECTION_PROVIDER_SLUGS_V1)[number];

/** 불투명 record 참조: 합성 스냅숏 안에서만 유효한 정수이다. */
export const MVP_CONNECTION_MAX_REFERENCE_V1 = 127;

/** 연결 사용처 종류. 폐쇄 집합이며 사용자 자유 텍스트가 아니다. */
export const MVP_CONNECTION_USAGE_KINDS_V1 = [
  "app",
  "cli",
  "mcp_server",
  "plugin",
  "ide",
  "ci_cd",
  "other",
] as const;

export type MvpConnectionUsageKindV1 = (typeof MVP_CONNECTION_USAGE_KINDS_V1)[number];

/** 확인됨/후보/확인 필요 — 실제 소유자 확인 상태의 축소 표현. */
export const MVP_CONNECTION_VERIFICATION_STATES_V1 = [
  "verified",
  "candidate",
  "needs_confirmation",
] as const;

export type MvpConnectionVerificationStateV1 = (typeof MVP_CONNECTION_VERIFICATION_STATES_V1)[number];

export const MVP_CONNECTION_MAX_USAGE_NOTE_LENGTH_V1 = 64;

export const MVP_CONNECTION_ERROR_CODES_V1 = [
  "INVALID_SHAPE",
  "UNKNOWN_PROVIDER",
  "UNKNOWN_USAGE_KIND",
  "UNKNOWN_REFERENCE",
  "OVERSIZED_INPUT",
  "DUPLICATE_USAGE",
  "CONFIRMATION_REQUIRED",
  "UNSUPPORTED_CONFIRMATION",
] as const;

export type MvpConnectionErrorCodeV1 = (typeof MVP_CONNECTION_ERROR_CODES_V1)[number];

export class MvpConnectionContractError extends Error {
  readonly code: MvpConnectionErrorCodeV1;

  constructor(code: MvpConnectionErrorCodeV1) {
    super(code);
    this.name = "MvpConnectionContractError";
    this.code = code;
  }
}

/** 합성 연결 참조. 슬러그는 공개 allowlist, note는 검증된 짧은 표시문이며 비밀값이 아니다. */
export interface MvpConnectionReferenceV1 {
  readonly providerSlug: MvpConnectionProviderSlugV1;
  readonly usage: MvpConnectionUsageKindV1;
  readonly recordReference: number;
  readonly verification: MvpConnectionVerificationStateV1;
  readonly usageNote: string;
  readonly confirmationAcknowledged: boolean;
}

const VERIFICATION_REQUIRES_ACKNOWLEDGEMENT: Readonly<
  Record<MvpConnectionVerificationStateV1, boolean>
> = Object.freeze({
  verified: false,
  candidate: true,
  needs_confirmation: true,
});

function fail(code: MvpConnectionErrorCodeV1): never {
  throw new MvpConnectionContractError(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isProviderSlug(value: unknown): value is MvpConnectionProviderSlugV1 {
  return (
    typeof value === "string" &&
    (MVP_CONNECTION_PROVIDER_SLUGS_V1 as readonly string[]).includes(value)
  );
}

function isUsageKind(value: unknown): value is MvpConnectionUsageKindV1 {
  return typeof value === "string" && (MVP_CONNECTION_USAGE_KINDS_V1 as readonly string[]).includes(value);
}

function isVerificationState(value: unknown): value is MvpConnectionVerificationStateV1 {
  return (
    typeof value === "string" &&
    (MVP_CONNECTION_VERIFICATION_STATES_V1 as readonly string[]).includes(value)
  );
}

function hasOwnPropertyDescriptor(object: Record<string, unknown>, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true;
}

/**
 * 폐쇄 계약 검증기. getter 실행·프로토타입 상속·추가 필드·심볼 키·
 * 배열 hole·중복 usage·미확인 confirmation을 모두 거절한다.
 */
export function parseMvpConnectionReferenceV1(value: unknown): MvpConnectionReferenceV1 {
  if (!isPlainObject(value)) fail("INVALID_SHAPE");
  const record = value;
  let fieldCount = 0;
  try {
    fieldCount = Reflect.ownKeys(record).length;
  } catch {
    fail("INVALID_SHAPE");
  }
  if (fieldCount !== 6) fail("INVALID_SHAPE");
  for (const key of ["providerSlug", "usage", "recordReference", "verification", "usageNote", "confirmationAcknowledged"]) {
    if (!hasOwnPropertyDescriptor(record, key)) fail("INVALID_SHAPE");
  }
  const providerSlug: unknown = record.providerSlug;
  const usage: unknown = record.usage;
  const recordReference: unknown = record.recordReference;
  const verification: unknown = record.verification;
  const usageNote: unknown = record.usageNote;
  const confirmationAcknowledged: unknown = record.confirmationAcknowledged;

  if (!isProviderSlug(providerSlug) || !isCanonicalLowercase(providerSlug)) {
    fail("UNKNOWN_PROVIDER");
  }
  if (!isUsageKind(usage)) fail("UNKNOWN_USAGE_KIND");
  if (
    typeof recordReference !== "number" ||
    !Number.isSafeInteger(recordReference) ||
    recordReference < 0 ||
    recordReference > MVP_CONNECTION_MAX_REFERENCE_V1
  ) {
    fail("UNKNOWN_REFERENCE");
  }
  if (!isVerificationState(verification)) {
    fail("CONFIRMATION_REQUIRED");
  }
  if (typeof usageNote !== "string") fail("INVALID_SHAPE");
  if (usageNote.length > MVP_CONNECTION_MAX_USAGE_NOTE_LENGTH_V1) fail("OVERSIZED_INPUT");

  const acknowledged = readConfirmation(confirmationAcknowledged);
  if (!acknowledged && VERIFICATION_REQUIRES_ACKNOWLEDGEMENT[verification]) {
    fail("CONFIRMATION_REQUIRED");
  }
  if (acknowledged && !VERIFICATION_REQUIRES_ACKNOWLEDGEMENT[verification]) {
    fail("UNSUPPORTED_CONFIRMATION");
  }

  return Object.freeze({
    providerSlug,
    usage,
    recordReference,
    verification,
    usageNote,
    confirmationAcknowledged: acknowledged,
  });
}

function readConfirmation(value: unknown): boolean {
  if (typeof value !== "boolean") throw new MvpConnectionContractError("INVALID_SHAPE");
  return value;
}

function isCanonicalLowercase(value: string): boolean {
  return value === value.toLowerCase();
}

/** 중복 사용처(같은 provider+usage+record 조합)를 포함하는지 검사한다. */
export function hasDuplicateMvpConnectionUsageV1(
  references: readonly MvpConnectionReferenceV1[],
): boolean {
  const seen = new Set<string>();
  for (const reference of references) {
    const compositeKey = `${reference.providerSlug}\u0000${reference.usage}\u0000${reference.recordReference}`;
    if (seen.has(compositeKey)) return true;
    seen.add(compositeKey);
  }
  return false;
}

/** UI 정렬용 표시 라벨. 새로운 검색 필드를 자동으로 추가하지 않는다. */
export const mvpConnectionUsageLabelsV1: Readonly<Record<MvpConnectionUsageKindV1, string>> =
  Object.freeze({
    app: "앱",
    cli: "CLI 도구",
    mcp_server: "MCP 서버",
    plugin: "플러그인",
    ide: "개발 환경",
    ci_cd: "CI/CD",
    other: "기타",
  });

export const mvpConnectionVerificationLabelsV1: Readonly<
  Record<MvpConnectionVerificationStateV1, string>
> = Object.freeze({
  verified: "확인됨",
  candidate: "후보",
  needs_confirmation: "확인 필요",
});

export const mvpConnectionProviderLabelsV1: Readonly<Record<MvpConnectionProviderSlugV1, string>> =
  Object.freeze({
    openai: "OpenAI",
    anthropic: "Anthropic",
    claude: "Claude",
    gemini: "Gemini",
    grok: "Grok",
    meta: "Meta",
    supabase: "Supabase",
    github: "GitHub",
    custom: "사용자 정의",
  });
