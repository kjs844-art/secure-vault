// Pure, ephemeral processing contracts. Not an authenticated or persistent record.
export const MAIL_LIMITS = Object.freeze({
  jsonBytes: 2 * 1024 * 1024,
  messages: 30,
  mimeDepth: 8,
  mimeParts: 128,
  headersPerPart: 64,
  headerChars: 2048,
  encodedPartChars: 131072,
  decodedBytesPerMessage: 98304,
  subjectChars: 240,
  bodyChars: 3000,
  analysisChars: 100000,
  candidateJsonBytes: 256 * 1024,
  candidates: 100,
  labelChars: 160,
  unitChars: 40,
  quoteChars: 500,
});

export type MailWarning =
  | "DATE_UNKNOWN" | "SUBJECT_TRUNCATED" | "BODY_TRUNCATED"
  | "SNIPPET_ONLY" | "NO_TEXT";

export interface PreparedMail {
  readonly index: number;
  readonly receivedAt: string | null;
  readonly subject: string;
  readonly body: string;
  readonly bodySource: "plain" | "snippet" | "none";
  readonly warnings: readonly MailWarning[];
}

export type MailNormalizationResult =
  | { readonly ok: true; readonly messages: readonly PreparedMail[] }
  | { readonly ok: false; readonly code: "MAIL_INPUT_INVALID" | "MAIL_LIMIT_EXCEEDED" };

export interface EvidenceSpan {
  readonly messageIndex: number;
  readonly part: "subject" | "body";
  // UTF-16 offsets into this ephemeral normalized batch, not the raw Gmail bytes.
  readonly start: number;
  readonly end: number;
}

export interface LinkedClaim<T> {
  readonly value: T;
  readonly evidence: EvidenceSpan;
  // An exact quote link is not semantic verification of the claim or its value.
  readonly verification: "unverified";
}

export type BenefitEvidenceKind =
  | "membership" | "trial" | "coupon" | "credit" | "point"
  | "storage" | "receipt" | "expiration" | "other";

export interface EmailCandidate {
  // Index is batch-local only. Persistence/reanalysis must supply owned revision IDs.
  readonly index: number;
  readonly evidenceMessageIndex: number;
  readonly receivedAt: string | null;
  readonly reviewStatus: "pending-review";
  readonly reviewReasons: readonly (
    "USER_REVIEW_REQUIRED" | "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF"
    | "RECEIVED_DATE_UNKNOWN" | "OBSERVATION_DATE_UNKNOWN"
    | "EXPIRY_CONFIRMATION_NEEDED" | "PARTIAL_MAIL_TEXT"
  )[];
  readonly extractionConfidence: "high" | "medium" | "low";
  readonly benefitKind: BenefitEvidenceKind;
  readonly serviceName: LinkedClaim<string>;
  readonly benefitName: LinkedClaim<string> | null;
  readonly unit: LinkedClaim<string> | null;
  readonly grantedAmount: LinkedClaim<number> | null;
  readonly remainingAmount: LinkedClaim<number> | null;
  readonly trialDaysStated: LinkedClaim<number> | null;
  readonly remainingDaysStated: LinkedClaim<number> | null;
  // Day-only strings stay day-only. A date/time must carry its explicit UTC offset.
  readonly expiresAt: LinkedClaim<string> | null;
  readonly observedAt: LinkedClaim<string> | null;
}

export type CandidateValidationResult =
  | { readonly ok: true; readonly candidates: readonly EmailCandidate[] }
  | { readonly ok: false; readonly code:
    "CANDIDATE_INPUT_INVALID" | "CANDIDATE_LIMIT_EXCEEDED" | "CANDIDATE_EVIDENCE_INVALID" };
