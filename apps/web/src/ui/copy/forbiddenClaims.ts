/**
 * Phrases KeyAtlas copy must never use. They overstate what the product has
 * verified: a recorded connection is not a live connection, and KeyAtlas does
 * not discover every service or every place a key is used.
 *
 * Matching is case-insensitive and ignores whitespace differences.
 */

export interface ForbiddenClaim {
  readonly phrase: string;
  readonly reason: string;
}

export const forbiddenClaims: readonly ForbiddenClaim[] = Object.freeze([
  { phrase: "모든 가입 서비스를 찾", reason: "가입 서비스를 자동으로 모두 찾지 않습니다." },
  { phrase: "모든 키 사용처를 확인", reason: "사용자가 기록한 연결처만 압니다." },
  { phrase: "모든 사용처", reason: "기록하지 않은 사용처는 알 수 없습니다." },
  { phrase: "연결이 살아", reason: "연결 기록은 현재 연결 상태를 검증한 결과가 아닙니다." },
  { phrase: "연결됨을 확인", reason: "연결 기록은 현재 연결 상태를 검증한 결과가 아닙니다." },
  { phrase: "계정도 삭제됩니다", reason: "소셜 연결 해제가 대상 서비스 계정 삭제를 뜻하지 않습니다." },
  { phrase: "해킹 불가", reason: "보안을 절대적으로 보장하지 않습니다." },
  { phrase: "100% 안전", reason: "보안을 절대적으로 보장하지 않습니다." },
  { phrase: "완벽하게 안전", reason: "보안을 절대적으로 보장하지 않습니다." },
  { phrase: "all your services", reason: "KeyAtlas does not discover every service." },
  { phrase: "everywhere your key is used", reason: "Only recorded connection targets are known." },
  { phrase: "connection verified", reason: "A recorded connection is not a verified live connection." },
  { phrase: "connection is active", reason: "A recorded connection is not a verified live connection." },
  { phrase: "unhackable", reason: "Security is never guaranteed absolutely." },
  { phrase: "100% secure", reason: "Security is never guaranteed absolutely." },
  { phrase: "military-grade", reason: "Marketing claim with no verifiable meaning." },
  { phrase: "production-ready", reason: "The current build is synthetic-data only." },
].map((claim) => Object.freeze(claim)));

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Returns the forbidden claims present in `text`.
 */
export function findForbiddenClaims(text: string): readonly ForbiddenClaim[] {
  const haystack = normalize(text);
  return forbiddenClaims.filter((claim) => haystack.includes(normalize(claim.phrase)));
}
