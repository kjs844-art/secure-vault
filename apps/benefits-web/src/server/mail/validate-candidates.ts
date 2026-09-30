import {
  MAIL_LIMITS,
  type BenefitEvidenceKind, type CandidateValidationResult, type EmailCandidate,
  type LinkedClaim, type PreparedMail,
} from "./contracts";

const SCHEMA = "keyatlas.gmail-candidates.v1";
const KINDS: readonly BenefitEvidenceKind[] = [
  "membership", "trial", "coupon", "credit", "point", "storage", "receipt", "expiration", "other",
];
const FIELDS = [
  "evidence_message_index", "confidence", "benefit_kind", "service_name", "benefit_name",
  "unit", "granted_amount", "remaining_amount", "trial_days", "remaining_days", "expires_at", "observed_at",
] as const;
type FailureCode = Extract<CandidateValidationResult, { ok: false }>["code"];

class InvalidCandidate extends Error {
  constructor(readonly code: FailureCode) { super(code); }
}

function fail(code: FailureCode = "CANDIDATE_INPUT_INVALID"): never {
  throw new InvalidCandidate(code);
}

function objectWithKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return fail();
  return record;
}

function label(value: unknown, max: number): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > max
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || /[\uD800-\uDFFF]/u.test(value)) return fail();
  return value;
}

function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0
    || value > Number.MAX_SAFE_INTEGER) return fail();
  return value;
}

function days(value: unknown): number {
  const number = amount(value);
  if (!Number.isSafeInteger(number)) return fail();
  return number;
}

function recordedDate(value: unknown): string {
  if (typeof value !== "string" || value.length > 40) return fail();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return fail();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > (monthDays[month - 1] ?? 0)) return fail();
  if (match[4] !== undefined) {
    if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return fail();
    const zone = match[8]!;
    if (zone !== "Z") {
      const hour = Number(zone.slice(1, 3));
      const minute = Number(zone.slice(4));
      // -00:00 denotes an unknown offset in RFC 3339; do not turn it into known UTC.
      if (zone === "-00:00" || hour > 14 || minute > 59 || (hour === 14 && minute !== 0)) return fail();
    }
  }
  return value;
}

function claim<T>(input: unknown, mail: PreparedMail, validate: (value: unknown) => T): LinkedClaim<T> | null {
  if (input === null) return null;
  const raw = objectWithKeys(input, ["value", "part", "quote"]);
  const value = validate(raw.value);
  if (raw.part !== "subject" && raw.part !== "body") return fail("CANDIDATE_EVIDENCE_INVALID");
  if (typeof raw.quote !== "string" || !raw.quote.trim() || raw.quote.length > MAIL_LIMITS.quoteChars
    || /[\uD800-\uDFFF]/u.test(raw.quote)) return fail("CANDIDATE_EVIDENCE_INVALID");
  const content = mail[raw.part];
  const start = content.indexOf(raw.quote);
  // Require an unambiguous exact quote in the normalized message from this batch.
  if (start < 0 || content.indexOf(raw.quote, start + 1) !== -1) return fail("CANDIDATE_EVIDENCE_INVALID");
  return Object.freeze({
    value,
    evidence: Object.freeze({ messageIndex: mail.index, part: raw.part, start, end: start + raw.quote.length }),
    verification: "unverified",
  });
}

function candidate(input: unknown, index: number, messages: readonly PreparedMail[]): EmailCandidate {
  const raw = objectWithKeys(input, FIELDS);
  if (!Number.isSafeInteger(raw.evidence_message_index)) return fail("CANDIDATE_EVIDENCE_INVALID");
  const mailIndex = raw.evidence_message_index as number;
  const mail = messages[mailIndex];
  if (mailIndex < 0 || !mail || mail.index !== mailIndex) return fail("CANDIDATE_EVIDENCE_INVALID");
  if (raw.confidence !== "high" && raw.confidence !== "medium" && raw.confidence !== "low") return fail();
  if (!KINDS.includes(raw.benefit_kind as BenefitEvidenceKind)) return fail();
  const serviceName = claim(raw.service_name, mail, (value) => label(value, MAIL_LIMITS.labelChars));
  if (serviceName === null) return fail();
  const benefitName = claim(raw.benefit_name, mail, (value) => label(value, MAIL_LIMITS.labelChars));
  const unit = claim(raw.unit, mail, (value) => label(value, MAIL_LIMITS.unitChars));
  const grantedAmount = claim(raw.granted_amount, mail, amount);
  const remainingAmount = claim(raw.remaining_amount, mail, amount);
  const trialDaysStated = claim(raw.trial_days, mail, days);
  const remainingDaysStated = claim(raw.remaining_days, mail, days);
  const expiresAt = claim(raw.expires_at, mail, recordedDate);
  const observedAt = claim(raw.observed_at, mail, recordedDate);
  if ((grantedAmount !== null || remainingAmount !== null) && unit === null) return fail();
  // A receipt/account/expiry event is not automatically a grant or balance claim.
  if (["membership", "receipt", "expiration"].includes(raw.benefit_kind as string)
    && (grantedAmount !== null || remainingAmount !== null)) return fail();
  const reviewReasons: Array<EmailCandidate["reviewReasons"][number]> = [
    "USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED",
  ];
  if (mail.receivedAt === null) reviewReasons.push("RECEIVED_DATE_UNKNOWN");
  if (observedAt === null) reviewReasons.push("OBSERVATION_DATE_UNKNOWN");
  if (mail.bodySource !== "plain" || mail.warnings.some((warning) =>
    warning === "BODY_TRUNCATED" || warning === "SUBJECT_TRUNCATED")) reviewReasons.push("PARTIAL_MAIL_TEXT");
  return Object.freeze({
    index, evidenceMessageIndex: mailIndex, receivedAt: mail.receivedAt,
    reviewStatus: "pending-review", reviewReasons: Object.freeze(reviewReasons),
    extractionConfidence: raw.confidence, benefitKind: raw.benefit_kind as BenefitEvidenceKind,
    serviceName, benefitName, unit, grantedAmount, remainingAmount,
    trialDaysStated, remainingDaysStated, expiresAt, observedAt,
  });
}

/**
 * Server-internal, ephemeral batch validator. messages must come from our normalizer,
 * never an HTTP caller's evidence map. No ownership/authentication/persistence claim.
 * Exact spans prove only a quote's presence, not factual accuracy or personal-data removal.
 * Reject the whole batch on any invalid item: never silently drop malformed evidence.
 */
export function validateGmailCandidatesJson(
  input: string, messages: readonly PreparedMail[],
): CandidateValidationResult {
  try {
    if (typeof input !== "string") return fail();
    if (input.length > MAIL_LIMITS.candidateJsonBytes
      || new TextEncoder().encode(input).byteLength > MAIL_LIMITS.candidateJsonBytes) return fail("CANDIDATE_LIMIT_EXCEEDED");
    if (!Array.isArray(messages) || messages.length > MAIL_LIMITS.messages) return fail("CANDIDATE_EVIDENCE_INVALID");
    const raw = objectWithKeys(JSON.parse(input) as unknown, ["schema", "discoveries"]);
    if (raw.schema !== SCHEMA || !Array.isArray(raw.discoveries)) return fail();
    if (raw.discoveries.length > MAIL_LIMITS.candidates) return fail("CANDIDATE_LIMIT_EXCEEDED");
    const candidates = raw.discoveries.map((item: unknown, index: number) => candidate(item, index, messages));
    // Keep distinct observations; no name-based merging, balance summing or record overwrites.
    return Object.freeze({ ok: true, candidates: Object.freeze(candidates) });
  } catch (error) {
    return Object.freeze({ ok: false, code: error instanceof InvalidCandidate ? error.code : "CANDIDATE_INPUT_INVALID" });
  }
}
