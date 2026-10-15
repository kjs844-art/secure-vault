import assert from "node:assert/strict";
import { test } from "node:test";
import { MAIL_LIMITS, type EmailCandidate, type LinkedClaim } from "../src/server/mail/contracts.ts";
import { normalizeGmailMessagesJson } from "../src/server/mail/normalize-gmail.ts";
import { validateGmailCandidatesJson } from "../src/server/mail/validate-candidates.ts";
import {
  REVIEW_SCHEMA, type CandidateContent, type ReviewErrorCode, type ReviewValues,
} from "../src/server/review/contracts.ts";
import {
  ReviewFailure, failReview, makeCandidateContent, parseAuthority, parseCandidateContent,
  parseConfirm, parseDelete, parseDraft, parseId, parseRevision, parseRevoke, parseValues,
} from "../src/server/review/validation.ts";

const INSTANT = "2026-09-28T00:00:00.000Z";
const BASE_VALUES: ReviewValues = Object.freeze({
  name: "Synthetic benefit 😀", kind: "credit", unit: "credits", grantedAmount: 0,
  remainingAmount: 1.25, trialDaysStated: null, remainingDaysStated: 0,
  expiresAt: "2028-02-29", observedAt: null,
});
const REQUIRED_REASONS: EmailCandidate["reviewReasons"] = Object.freeze([
  "USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED",
]);
const UNKNOWN_DATE_REASONS: EmailCandidate["reviewReasons"] = Object.freeze([
  ...REQUIRED_REASONS, "RECEIVED_DATE_UNKNOWN", "OBSERVATION_DATE_UNKNOWN",
]);
const BINDING = Object.freeze({
  analysisOperationId: "synthetic-analysis", mailboxBindingId: "synthetic-mailbox", extractedAt: INSTANT,
});

function content(): CandidateContent {
  return {
    schema: REVIEW_SCHEMA, ...BINDING, candidateIndex: 0, policyVersion: "keyatlas.gmail-review.v1",
    receivedAt: null, serviceName: "Synthetic service", extractionConfidence: "medium",
    reviewReasons: [...UNKNOWN_DATE_REASONS], values: { ...BASE_VALUES, name: null },
    evidenceAvailability: "not-retained",
  };
}

function claim<T>(value: T): LinkedClaim<T> {
  return { value, verification: "unverified", evidence: { messageIndex: 0, part: "body", start: 0, end: 1 } };
}

function candidate(): EmailCandidate {
  return {
    index: 0, evidenceMessageIndex: 0, receivedAt: null, reviewStatus: "pending-review",
    reviewReasons: [...UNKNOWN_DATE_REASONS, "PARTIAL_MAIL_TEXT"], extractionConfidence: "low",
    benefitKind: "credit", serviceName: claim("Synthetic service"), benefitName: null,
    unit: claim("credits"), grantedAmount: claim(2), remainingAmount: null,
    trialDaysStated: null, remainingDaysStated: null, expiresAt: null, observedAt: null,
  };
}

function invalid(action: () => unknown, code: ReviewErrorCode = "REVIEW_INPUT_INVALID", context?: string): void {
  assert.throws(action, (error: unknown) => error instanceof ReviewFailure && error.code === code
    && error.message === code, context);
}

test("IDs use the bounded mail-runner alphabet without coercion or trailing line breaks", () => {
  for (const id of ["A", "synthetic:owner-1.test_ok", "a".repeat(128)]) assert.equal(parseId(id), id);
  for (const id of ["", "a".repeat(129), "a\n", "a\r", " a", "/a", "a/b", "합성", null, 1]) {
    invalid(() => parseId(id));
  }
});

test("revisions require positive safe integers; failure messages contain only fixed codes", () => {
  assert.equal(parseRevision(1), 1);
  assert.equal(parseRevision(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  for (const revision of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
    invalid(() => parseRevision(revision));
  }
  invalid(() => failReview());
  invalid(() => failReview("REVIEW_CONFLICT"), "REVIEW_CONFLICT");
});

const strictParsers: ReadonlyArray<{
  name: string; parse: (value: unknown) => unknown; input: () => Record<string, unknown>;
}> = [
  { name: "values", parse: parseValues, input: () => ({ ...BASE_VALUES }) },
  { name: "draft", parse: parseDraft, input: () => ({
    candidateId: "candidate", candidateRevision: 1, serviceId: "service", serviceRevision: 1, values: { ...BASE_VALUES },
  }) },
  { name: "confirm", parse: parseConfirm, input: () => ({ previewId: "preview", operationId: "operation", decision: "confirm" }) },
  { name: "delete", parse: parseDelete, input: () => ({
    benefitId: "benefit", expectedRevision: 1, operationId: "operation", decision: "delete",
  }) },
  { name: "revoke", parse: parseRevoke, input: () => ({ previewId: "preview", expectedRevision: 1, decision: "reject" }) },
  { name: "candidate content", parse: parseCandidateContent, input: () => ({ ...content() }) },
];

for (const parser of strictParsers) {
  test(`${parser.name} requires the exact own enumerable data properties and never calls getters`, () => {
    assert.ok(parser.parse(parser.input()));
    assert.ok(parser.parse(Object.assign(Object.create(null) as Record<string, unknown>, parser.input())));
    for (const input of [null, [], "synthetic", 1, Object.create(parser.input()),
      { ...parser.input(), extra: "synthetic" }, { ...parser.input(), [Symbol("extra")]: "synthetic" }]) {
      invalid(() => parser.parse(input));
    }
    for (const key of Object.keys(parser.input())) {
      const missing = parser.input();
      delete missing[key];
      invalid(() => parser.parse(missing), "REVIEW_INPUT_INVALID", `missing ${key}`);
      invalid(() => parser.parse({ ...parser.input(), [key]: undefined }), "REVIEW_INPUT_INVALID", `undefined ${key}`);
      let getterCalls = 0;
      const accessor = parser.input();
      Object.defineProperty(accessor, key, { enumerable: true, get() { getterCalls++; throw new Error("SYNTHETIC_GETTER"); } });
      invalid(() => parser.parse(accessor));
      assert.equal(getterCalls, 0, `getter ${key} must not execute`);
      const hidden = parser.input();
      Object.defineProperty(hidden, key, { value: hidden[key], enumerable: false });
      invalid(() => parser.parse(hidden));
    }
    const hiddenExtra = parser.input();
    Object.defineProperty(hiddenExtra, "extra", { value: "synthetic", enumerable: false });
    invalid(() => parser.parse(hiddenExtra));
  });
}

test("unknown values must be explicit null and zero is preserved as a known amount or day count", () => {
  const allUnknown = { ...BASE_VALUES, unit: null, grantedAmount: null, remainingAmount: null,
    trialDaysStated: null, remainingDaysStated: null, expiresAt: null, observedAt: null };
  assert.deepEqual(parseValues(allUnknown), allUnknown);
  const zero = { ...BASE_VALUES, grantedAmount: 0, remainingAmount: 0, trialDaysStated: 0, remainingDaysStated: 0 };
  assert.deepEqual(parseValues(zero), zero);
  invalid(() => parseValues({ ...zero, unit: null }));
  invalid(() => parseValues({ ...allUnknown, name: null }));
  assert.equal(parseCandidateContent(content()).values.name, null);
});

test("labels reject controls, bidi markers and lone surrogates while retaining valid emoji", () => {
  for (const name of ["", " a", "a ", "a\n", "a\u0000", "a\u0085", "a\u061c", "a\u200e",
    "a\u200f", "a\u202e", "a\u2066", "a\u2069", "\ud800", "\udfff", "a".repeat(161)]) {
    invalid(() => parseValues({ ...BASE_VALUES, name }));
    invalid(() => parseCandidateContent({ ...content(), serviceName: name }));
  }
  for (const name of ["합성 서비스 😀", "Synthetic 👩‍💻", "a".repeat(160)]) {
    assert.equal(parseValues({ ...BASE_VALUES, name }).name, name);
    assert.equal(parseCandidateContent({ ...content(), serviceName: name }).serviceName, name);
  }
  assert.equal(parseValues({ ...BASE_VALUES, unit: "🪙" }).unit, "🪙");
  assert.equal(parseValues({ ...BASE_VALUES, unit: "x".repeat(40) }).unit?.length, 40);
  for (const unit of ["x".repeat(41), "\ud800", "\u202e", "", " credit"]) invalid(() => parseValues({ ...BASE_VALUES, unit }));
});

test("amounts permit bounded finite fractions while stated days must remain integers", () => {
  for (const amount of [0, 0.25, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parseValues({ ...BASE_VALUES, grantedAmount: amount }).grantedAmount, amount);
    assert.equal(parseValues({ ...BASE_VALUES, remainingAmount: amount }).remainingAmount, amount);
  }
  for (const key of ["grantedAmount", "remainingAmount", "trialDaysStated", "remainingDaysStated"]) {
    for (const value of [-1, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) {
      invalid(() => parseValues({ ...BASE_VALUES, [key]: value }));
    }
  }
  for (const key of ["trialDaysStated", "remainingDaysStated"]) {
    invalid(() => parseValues({ ...BASE_VALUES, [key]: 1.5 }));
    assert.equal(parseValues({ ...BASE_VALUES, [key]: Number.MAX_SAFE_INTEGER })[key as keyof ReviewValues], Number.MAX_SAFE_INTEGER);
  }
});

test("known amounts require a unit and account, receipt or expiry events never become balances", () => {
  for (const field of ["grantedAmount", "remainingAmount"]) {
    invalid(() => parseValues({ ...BASE_VALUES, unit: null, grantedAmount: null, remainingAmount: null, [field]: 0 }));
    for (const kind of ["membership", "receipt", "expiration"]) {
      invalid(() => parseValues({ ...BASE_VALUES, kind, grantedAmount: null, remainingAmount: null, [field]: 0 }));
    }
  }
  for (const kind of ["membership", "receipt", "expiration"]) {
    assert.equal(parseValues({ ...BASE_VALUES, kind, unit: null, grantedAmount: null, remainingAmount: null }).kind, kind);
  }
  invalid(() => parseValues({ ...BASE_VALUES, kind: "unknown" }));
});

test("stated dates preserve calendar precision, explicit offsets and up to nine fractional digits", () => {
  for (const date of ["0001-01-01", "2024-02-29", "2026-01-01T23:59:59Z", "2026-01-01T00:00:00+00:00",
    "2026-01-01T00:00:00-14:00", "2026-01-01T23:59:59.123456789+14:00"]) {
    const parsed = parseValues({ ...BASE_VALUES, expiresAt: date, observedAt: date });
    assert.equal(parsed.expiresAt, date);
    assert.equal(parsed.observedAt, date);
  }
});

test("stated dates reject rollover, unknown time zones, out-of-range offsets and implicit times", () => {
  for (const date of ["2025-02-29", "1900-02-29", "0000-01-01", "2026-13-01", "2026-04-31", "2026-01-00",
    "2026-01-01\n", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:60Z",
    "2026-01-01T00:00:00-00:00", "2026-01-01T00:00:00+14:01", "2026-01-01T00:00:00-15:00",
    "2026-01-01T00:00:00+09:60", "2026-01-01T00:00:00", "2026-01-01T00:00:00.1234567890Z", "tomorrow"]) {
    invalid(() => parseValues({ ...BASE_VALUES, expiresAt: date }));
    invalid(() => parseValues({ ...BASE_VALUES, observedAt: date }));
  }
});

test("received and extracted instants require canonical UTC milliseconds; only received may be null", () => {
  assert.equal(parseCandidateContent(content()).receivedAt, null);
  assert.equal(parseCandidateContent({ ...content(), receivedAt: INSTANT }).receivedAt, INSTANT);
  invalid(() => parseCandidateContent({ ...content(), extractedAt: null }));
  for (const field of ["receivedAt", "extractedAt"]) {
    for (const date of ["2026-09-28", "2026-09-28T00:00:00Z", "2026-09-28T00:00:00.00Z",
      "2026-09-28T00:00:00.0000Z", "2026-09-28T00:00:00.000+00:00", "2026-02-30T00:00:00.000Z",
      "2026-09-28T00:00:00.000Z\n", undefined]) invalid(() => parseCandidateContent({ ...content(), [field]: date }));
  }
});

test("candidate metadata is closed to unsupported schema, policy, confidence and retention claims", () => {
  for (const patch of [{ schema: "old" }, { policyVersion: "other" }, { evidenceAvailability: "retained" },
    { extractionConfidence: "verified" }, { serviceName: null }, { values: { ...BASE_VALUES, rawQuote: "synthetic" } }]) {
    invalid(() => parseCandidateContent({ ...content(), ...patch }));
  }
  for (const candidateIndex of [-1, 100, 1.5, "0", NaN]) invalid(() => parseCandidateContent({ ...content(), candidateIndex }));
  for (const candidateIndex of [0, 99]) assert.equal(parseCandidateContent({ ...content(), candidateIndex }).candidateIndex, candidateIndex);
  for (const extractionConfidence of ["high", "medium", "low"]) {
    assert.equal(parseCandidateContent({ ...content(), extractionConfidence }).extractionConfidence, extractionConfidence);
  }
});

test("candidate review reasons retain partial-mail warnings and require every applicable uncertainty", () => {
  const allReasons: EmailCandidate["reviewReasons"] = [...UNKNOWN_DATE_REASONS, "PARTIAL_MAIL_TEXT"];
  const parsed = parseCandidateContent({ ...content(), reviewReasons: allReasons });
  assert.deepEqual(parsed.reviewReasons, allReasons);
  assert.notEqual(parsed.reviewReasons, allReasons);
  assert.ok(Object.isFrozen(parsed.reviewReasons));
  const knownDates = { ...content(), receivedAt: INSTANT, values: { ...BASE_VALUES, observedAt: "2026-09-27" } };
  assert.deepEqual(parseCandidateContent({ ...knownDates, reviewReasons: REQUIRED_REASONS }).reviewReasons, REQUIRED_REASONS);
  for (const reason of REQUIRED_REASONS) {
    invalid(() => parseCandidateContent({ ...knownDates, reviewReasons: REQUIRED_REASONS.filter((entry) => entry !== reason) }));
  }
  for (const reason of ["RECEIVED_DATE_UNKNOWN", "OBSERVATION_DATE_UNKNOWN"]) {
    invalid(() => parseCandidateContent({ ...content(), reviewReasons: UNKNOWN_DATE_REASONS.filter((entry) => entry !== reason) }));
  }
});

test("reason arrays reject missing, duplicate, unknown, sparse and accessor entries without invoking them", () => {
  for (const reviewReasons of [null, undefined, "USER_REVIEW_REQUIRED", [], ["USER_REVIEW_REQUIRED"],
    [...UNKNOWN_DATE_REASONS, "UNKNOWN"], [...UNKNOWN_DATE_REASONS, "USER_REVIEW_REQUIRED"],
    [...UNKNOWN_DATE_REASONS, "PARTIAL_MAIL_TEXT", "USER_REVIEW_REQUIRED"]]) {
    invalid(() => parseCandidateContent({ ...content(), reviewReasons }));
  }
  const sparse = [...UNKNOWN_DATE_REASONS];
  delete sparse[0];
  invalid(() => parseCandidateContent({ ...content(), reviewReasons: sparse }));
  const symbolic = Object.assign([...UNKNOWN_DATE_REASONS], { [Symbol("extra")]: "synthetic" });
  invalid(() => parseCandidateContent({ ...content(), reviewReasons: symbolic }));
  const extended = Object.assign([...UNKNOWN_DATE_REASONS], { extra: "synthetic" });
  invalid(() => parseCandidateContent({ ...content(), reviewReasons: extended }));
  let getterCalls = 0;
  const accessor = [...UNKNOWN_DATE_REASONS];
  Object.defineProperty(accessor, "0", { enumerable: true, get() { getterCalls++; throw new Error("SYNTHETIC_REASON_GETTER"); } });
  invalid(() => parseCandidateContent({ ...content(), reviewReasons: accessor }));
  assert.equal(getterCalls, 0);
});

test("authority is a frozen five-field projection that drops extra adapter data and never invokes getters", () => {
  const authority = { ownerId: "synthetic-owner", sessionId: "synthetic-session", sessionRevision: 1, dataGeneration: 1, expiresAt: 2000 };
  const raw = { ...authority, adapterData: "SYNTHETIC_NOT_FOR_REVIEW" };
  let extraGetterCalls = 0;
  Object.defineProperty(raw, "unused", { enumerable: true, get() { extraGetterCalls++; throw new Error("SYNTHETIC_UNUSED_GETTER"); } });
  const parsed = parseAuthority(raw, 1000);
  assert.deepEqual(parsed, authority);
  assert.ok(Object.isFrozen(parsed));
  assert.equal(extraGetterCalls, 0);
  for (const key of Object.keys(authority)) {
    let requiredGetterCalls = 0;
    const accessor = { ...authority };
    Object.defineProperty(accessor, key, { enumerable: true, get() { requiredGetterCalls++; throw new Error("SYNTHETIC_AUTH_GETTER"); } });
    invalid(() => parseAuthority(accessor, 1000), "REVIEW_AUTH_REQUIRED");
    assert.equal(requiredGetterCalls, 0);
  }
});

test("authority rejects invalid, expired or unrepresentable timestamps and nonpositive revision generations", () => {
  const authority = { ownerId: "synthetic-owner", sessionId: "synthetic-session", sessionRevision: 1, dataGeneration: 1, expiresAt: 2000 };
  for (const raw of [null, [], Object.create(authority), { ...authority, ownerId: "bad\n" },
    { ...authority, sessionRevision: 0 }, { ...authority, dataGeneration: 0 }, { ...authority, expiresAt: 1000 },
    { ...authority, expiresAt: -1 }, { ...authority, expiresAt: 1.5 }, { ...authority, expiresAt: 253402300800000 }]) {
    invalid(() => parseAuthority(raw, 1000), "REVIEW_AUTH_REQUIRED");
  }
  for (const now of [-1, NaN, Infinity, 0.5, 253402300800000]) invalid(() => parseAuthority(authority, now), "REVIEW_AUTH_REQUIRED");
  assert.equal(parseAuthority({ ...authority, expiresAt: 1 }, 0).expiresAt, 1);
  assert.equal(parseAuthority({ ...authority, expiresAt: 253402300799999 }, 253402300799998).expiresAt, 253402300799999);
});

test("draft snapshots are nested-frozen and do not retain mutable input values", () => {
  const values = { ...BASE_VALUES };
  const raw = { candidateId: "candidate", candidateRevision: 1, serviceId: "service", serviceRevision: 1, values };
  const parsed = parseDraft(raw);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.values));
  assert.notEqual(parsed.values, values);
  values.name = "Synthetic changed later";
  assert.equal(parsed.values.name, BASE_VALUES.name);
  invalid(() => parseDraft({ ...raw, candidateRevision: 0 }));
  invalid(() => parseDraft({ ...raw, serviceRevision: 0 }));
});

test("decisions are explicit action literals with frozen ID-only request projections", () => {
  assert.ok(Object.isFrozen(parseConfirm({ previewId: "preview", operationId: "operation", decision: "confirm" })));
  assert.ok(Object.isFrozen(parseDelete({ benefitId: "benefit", expectedRevision: 1, operationId: "operation", decision: "delete" })));
  assert.ok(Object.isFrozen(parseRevoke({ previewId: "preview", expectedRevision: 1, decision: "reject" })));
  invalid(() => parseConfirm({ previewId: "preview", operationId: "operation", decision: "delete" }));
  invalid(() => parseDelete({ benefitId: "benefit", expectedRevision: 1, operationId: "operation", decision: "confirm" }));
  invalid(() => parseDelete({ benefitId: "benefit", expectedRevision: 0, operationId: "operation", decision: "delete" }));
  invalid(() => parseRevoke({ previewId: "preview", expectedRevision: 1, decision: "confirm" }));
  invalid(() => parseRevoke({ previewId: "preview", expectedRevision: 0, decision: "reject" }));
});

test("trusted candidate projection retains scalar claims and uncertainty but no source text, IDs, quotes or spans", () => {
  const raw = {
    ...candidate(), gmailMessageId: "synthetic-provider-message-id", subject: "Synthetic private title",
    body: "Synthetic private body", serviceName: { ...claim("Synthetic service"), quote: "Synthetic raw quote" },
  };
  const parsed = makeCandidateContent(raw, { ...BINDING, adapterData: "SYNTHETIC_PRIVATE_ADAPTER_DATA" } as typeof BINDING);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "schema", "analysisOperationId", "mailboxBindingId", "candidateIndex", "policyVersion", "extractedAt",
    "receivedAt", "serviceName", "extractionConfidence", "reviewReasons", "values", "evidenceAvailability",
  ].sort());
  assert.equal(parsed.values.name, null);
  assert.equal(parsed.values.grantedAmount, 2);
  assert.equal(parsed.values.observedAt, null);
  assert.equal(parsed.receivedAt, null);
  assert.deepEqual(parsed.reviewReasons, raw.reviewReasons);
  assert.ok(parsed.reviewReasons.includes("PARTIAL_MAIL_TEXT"));
  assert.equal(parsed.evidenceAvailability, "not-retained");
  for (const value of [parsed, parsed.values, parsed.reviewReasons]) assert.ok(Object.isFrozen(value));
  const serialized = JSON.stringify(parsed);
  for (const absent of [raw.gmailMessageId, raw.subject, raw.body, raw.serviceName.quote, "messageIndex", "evidenceMessageIndex",
    '"quote"', '"start"', '"end"', "SYNTHETIC_PRIVATE_ADAPTER_DATA"]) assert.ok(!serialized.includes(absent));
  assert.notEqual(parsed.reviewReasons, raw.reviewReasons);
  assert.deepEqual(parseCandidateContent(parsed), parsed);
});

test("candidate projection rejects nonpending, malformed claims and stripped review reasons", () => {
  invalid(() => makeCandidateContent({ ...candidate(), reviewStatus: "accepted" } as unknown as EmailCandidate, BINDING));
  invalid(() => makeCandidateContent({ ...candidate(), serviceName: null } as unknown as EmailCandidate, BINDING));
  invalid(() => makeCandidateContent({ ...candidate(), benefitName: undefined } as unknown as EmailCandidate, BINDING));
  invalid(() => makeCandidateContent({ ...candidate(), reviewReasons: [] }, BINDING));
  let getterCalls = 0;
  const raw = candidate();
  Object.defineProperty(raw.serviceName, "value", { enumerable: true, get() { getterCalls++; throw new Error("SYNTHETIC_CLAIM_GETTER"); } });
  invalid(() => makeCandidateContent(raw, BINDING));
  assert.equal(getterCalls, 0);
});

test("the existing mail pipeline preserves nulls, names, zero and partial-mail flags through synthetic review projection", () => {
  const serviceName = "합성 Studio 😀";
  const body = "0 credits " + "x".repeat(MAIL_LIMITS.bodyChars);
  const normalized = normalizeGmailMessagesJson(JSON.stringify([{
    id: "synthetic-pipeline-provider-message", payload: {
      mimeType: "text/plain", headers: [{ name: "Subject", value: serviceName }],
      body: { data: Buffer.from(body, "utf8").toString("base64url") },
    },
  }]));
  assert.ok(normalized.ok);
  assert.equal(normalized.messages[0]!.receivedAt, null);
  assert.ok(normalized.messages[0]!.warnings.includes("BODY_TRUNCATED"));
  const validated = validateGmailCandidatesJson(JSON.stringify({
    schema: "keyatlas.gmail-candidates.v1", discoveries: [{
      evidence_message_index: 0, confidence: "high", benefit_kind: "credit",
      service_name: { value: serviceName, part: "subject", quote: serviceName }, benefit_name: null,
      unit: { value: "credits", part: "body", quote: "0 credits" },
      granted_amount: null, remaining_amount: { value: 0, part: "body", quote: "0 credits" },
      trial_days: null, remaining_days: null, expires_at: null, observed_at: null,
    }],
  }), normalized.messages);
  assert.ok(validated.ok);
  const source = validated.candidates[0]!;
  assert.equal(source.reviewStatus, "pending-review");
  const projected = makeCandidateContent(source, BINDING);
  assert.equal(projected.serviceName, serviceName);
  assert.equal(projected.values.name, null);
  assert.equal(projected.values.unit, "credits");
  assert.equal(projected.values.remainingAmount, 0);
  assert.equal(projected.values.grantedAmount, null);
  assert.equal(projected.values.expiresAt, null);
  assert.equal(projected.values.observedAt, null);
  assert.equal(projected.receivedAt, null);
  assert.equal(projected.extractedAt, INSTANT);
  assert.deepEqual(projected.reviewReasons, source.reviewReasons);
  for (const reason of [...UNKNOWN_DATE_REASONS, "PARTIAL_MAIL_TEXT"]) {
    assert.ok(projected.reviewReasons.includes(reason as EmailCandidate["reviewReasons"][number]));
  }
  assert.ok(Object.isFrozen(projected) && Object.isFrozen(projected.values) && Object.isFrozen(projected.reviewReasons));
  const serialized = JSON.stringify(projected);
  for (const absent of ["synthetic-pipeline-provider-message", body, "0 credits", "evidenceMessageIndex", '"evidence"']) {
    assert.ok(!serialized.includes(absent));
  }
  assert.deepEqual(parseCandidateContent(projected), projected);
});
