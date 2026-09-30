import assert from "node:assert/strict";
import { test } from "node:test";
import { MAIL_LIMITS, type PreparedMail } from "../src/server/mail/contracts.ts";
import { validateGmailCandidatesJson } from "../src/server/mail/validate-candidates.ts";

const mail: PreparedMail = Object.freeze({
  index: 0, receivedAt: "2026-09-28T00:00:00.000Z",
  subject: "Synthetic Studio notice",
  body: "Synthetic Studio grants 100 credits. Balance is 0 credits. Trial 7 days. Expires 2026-10-01. Observed 2026-09-27.",
  bodySource: "plain", warnings: Object.freeze([]),
});
const fact = (value: unknown, quote: string, part = "body") => ({ value, quote, part });
const make = (patch: Record<string, unknown> = {}) => ({
  evidence_message_index: 0, confidence: "high", benefit_kind: "credit",
  service_name: fact("Synthetic Studio", "Synthetic Studio", "subject"),
  benefit_name: null, unit: fact("credits", "grants 100 credits"),
  granted_amount: fact(100, "grants 100 credits"), remaining_amount: null,
  trial_days: null, remaining_days: null, expires_at: null, observed_at: null,
  ...patch,
});
function run(patch: Record<string, unknown> = {}, messages: readonly PreparedMail[] = [mail]) {
  return validateGmailCandidatesJson(JSON.stringify({
    schema: "keyatlas.gmail-candidates.v1", discoveries: [make(patch)],
  }), messages);
}
const invalid = (patch: Record<string, unknown>, code = "CANDIDATE_INPUT_INVALID") =>
  assert.deepEqual(run(patch), { ok: false, code });

test("high confidence is still a pending candidate, never a confirmed BenefitRecord", () => {
  const result = run();
  assert.ok(result.ok);
  const candidate = result.candidates[0]!;
  assert.equal(candidate.reviewStatus, "pending-review");
  assert.equal(candidate.extractionConfidence, "high");
  assert.equal(candidate.grantedAmount!.value, 100);
  assert.equal(candidate.remainingAmount, null);
  assert.equal(candidate.observedAt, null);
  assert.ok(candidate.reviewReasons.includes("EXPIRY_CONFIRMATION_NEEDED"));
  assert.ok(candidate.reviewReasons.includes("NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF"));
  assert.equal(candidate.serviceName.verification, "unverified");
  assert.ok(!("confirmedAt" in candidate));
  assert.ok(!("userId" in candidate));
  assert.ok(!("source_kind" in candidate));
});

test("explicit zero remains zero; receipt time never fills observation time", () => {
  const result = run({ remaining_amount: fact(0, "Balance is 0 credits") });
  assert.ok(result.ok);
  assert.equal(result.candidates[0]!.remainingAmount!.value, 0);
  assert.equal(result.candidates[0]!.observedAt, null);
  assert.equal(result.candidates[0]!.receivedAt, mail.receivedAt);
});

test("missing date is null, not processing time; partial mail forces review", () => {
  const result = run({}, [{ ...mail, receivedAt: null, bodySource: "snippet", warnings: ["DATE_UNKNOWN", "SNIPPET_ONLY"] }]);
  assert.ok(result.ok);
  assert.equal(result.candidates[0]!.receivedAt, null);
  assert.ok(result.candidates[0]!.reviewReasons.includes("RECEIVED_DATE_UNKNOWN"));
  assert.ok(result.candidates[0]!.reviewReasons.includes("PARTIAL_MAIL_TEXT"));
});

test("date-only expiry and observation preserve their precision", () => {
  const result = run({
    expires_at: fact("2026-10-01", "Expires 2026-10-01"),
    observed_at: fact("2026-09-27", "Observed 2026-09-27"),
  });
  assert.ok(result.ok);
  assert.equal(result.candidates[0]!.expiresAt!.value, "2026-10-01");
  assert.equal(result.candidates[0]!.observedAt!.value, "2026-09-27");
  assert.ok(!result.candidates[0]!.reviewReasons.includes("OBSERVATION_DATE_UNKNOWN"));
});

for (const value of ["2025-02-29", "2026-04-31", "0000-01-01", "2026-13-01", "2026-01-00",
  "2026-01-01T24:00:00Z", "2026-01-01T23:59:60Z", "2026-01-01T00:00:00", "2026-01-01T00:00:00-00:00",
  "2026-01-01T00:00:00+14:01", "2026-01-01T00:00:00+10:60", "tomorrow"]) {
  test("invalid/ambiguous date is rejected: " + value, () => invalid({ expires_at: fact(value, "Expires 2026-10-01") }));
}

test("explicit offsets, leap dates and DB sub-millisecond precision stay unchanged", () => {
  for (const value of ["2024-02-29", "2026-09-27T00:00:00+09:00", "2026-09-27T00:00:00.123456Z"]) {
    const result = run({ observed_at: fact(value, "Observed 2026-09-27") });
    assert.ok(result.ok);
    assert.equal(result.candidates[0]!.observedAt!.value, value);
    assert.equal(result.candidates[0]!.observedAt!.verification, "unverified");
  }
});

test("quote linkage does not claim semantic correctness of AI values", () => {
  // Presence of the words is proved; whether 999 follows from them is not.
  const result = run({ remaining_amount: fact(999, "Balance is 0 credits") });
  assert.ok(result.ok);
  assert.equal(result.candidates[0]!.remainingAmount!.verification, "unverified");
  assert.equal(result.candidates[0]!.reviewStatus, "pending-review");
});

for (const value of [-1, "100", Number.MAX_SAFE_INTEGER + 1]) {
  test("amount is not coerced or accepted out of range: " + value, () => invalid({ granted_amount: fact(value, "grants 100 credits") }));
}

test("overflow to Infinity after JSON parse is rejected; days must be integers", () => {
  const input = JSON.stringify({ schema: "keyatlas.gmail-candidates.v1", discoveries: [make()] });
  assert.deepEqual(validateGmailCandidatesJson(input.replace('"value":100', '"value":1e999'), [mail]),
    { ok: false, code: "CANDIDATE_INPUT_INVALID" });
  invalid({ trial_days: fact(1.5, "Trial 7 days") });
  const result = run({ trial_days: fact(7, "Trial 7 days"), remaining_days: fact(0, "Balance is 0 credits") });
  assert.ok(result.ok);
  assert.equal(result.candidates[0]!.trialDaysStated!.value, 7);
  assert.equal(result.candidates[0]!.remainingDaysStated!.value, 0);
});

test("a unit is required for known numeric amounts", () => {
  invalid({ unit: null });
  invalid({ granted_amount: null, remaining_amount: fact(0, "Balance is 0 credits"), unit: null });
  assert.equal(run({ granted_amount: null, unit: null }).ok, true);
});

test("account/receipt/expiry events are not automatically grant/balance records", () => {
  for (const kind of ["membership", "receipt", "expiration"]) {
    invalid({ benefit_kind: kind });
    const result = run({ benefit_kind: kind, granted_amount: null, unit: null });
    assert.ok(result.ok);
    assert.equal(result.candidates[0]!.reviewStatus, "pending-review");
  }
});

test("missing, out-of-batch or fractional evidence is an explicit failure", () => {
  for (const index of [-1, 1, 0.5, "0", null]) invalid({ evidence_message_index: index }, "CANDIDATE_EVIDENCE_INVALID");
  assert.deepEqual(run({}, []), { ok: false, code: "CANDIDATE_EVIDENCE_INVALID" });
  assert.deepEqual(run({}, [{ ...mail, index: 1 }]), { ok: false, code: "CANDIDATE_EVIDENCE_INVALID" });
});

test("quote must be exact, in the specified segment and unambiguous", () => {
  for (const proof of [fact(1, "absent"), fact(1, "grants 100 credits", "subject"),
    fact(1, "credits"), fact(1, ""), fact(1, "x".repeat(501)), fact(1, "Balance is 0 credits", "html")]) {
    invalid({ remaining_amount: proof }, "CANDIDATE_EVIDENCE_INVALID");
  }
});

test("only bounded well-formed non-control labels are accepted", () => {
  for (const name of ["", " Synthetic", "Synthetic\nStudio", "x".repeat(161), "Synthetic\u202e", "\ud800"]) {
    invalid({ service_name: fact(name, "Synthetic Studio", "subject") });
  }
  const result = run({ service_name: fact("합성 서비스 😀", "Synthetic Studio", "subject") });
  assert.ok(result.ok);
  invalid({ unit: fact("x".repeat(41), "grants 100 credits") });
});

test("unknown credential/owner/review/status fields are rejected, not silently stripped", () => {
  for (const field of ["password", "api_key", "token", "account_email", "ownerId", "confirmed_at", "review_status", "id", "revision"]) {
    invalid({ [field]: "SYNTHETIC_REJECTED_FIELD" });
  }
  invalid({ confidence: "verified" });
  invalid({ benefit_kind: "password" });
  invalid({ service_name: null });
  invalid({ unit: undefined });
  invalid({ service_name: { ...fact("Synthetic Studio", "Synthetic Studio", "subject"), secret: "SYNTHETIC" } });
});

test("results contain spans, not source titles, bodies, provider IDs or raw quotes", () => {
  const result = run();
  assert.ok(result.ok);
  const claim = result.candidates[0]!.grantedAmount!;
  assert.deepEqual(claim.evidence, { messageIndex: 0, part: "body", start: 17, end: 35 });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(mail.subject));
  assert.ok(!serialized.includes(mail.body));
  assert.ok(!serialized.includes("grants 100 credits"));
  // Labels still come from model input and can be personal. This is not redaction.
});

test("all result containers and nested claims/spans are immutable", () => {
  const result = run();
  assert.ok(result.ok);
  const candidate = result.candidates[0]!;
  for (const value of [result, result.candidates, candidate, candidate.reviewReasons, candidate.serviceName, candidate.serviceName.evidence]) {
    assert.ok(Object.isFrozen(value));
  }
});

test("multiple observations or renamed benefits are neither summed nor auto-merged", () => {
  const items = [make(), make({ benefit_name: fact("Another name", "Trial 7 days") }), make()];
  const input = JSON.stringify({ schema: "keyatlas.gmail-candidates.v1", discoveries: items });
  const result = validateGmailCandidatesJson(input, [mail]);
  assert.ok(result.ok);
  assert.deepEqual(result.candidates.map((entry) => entry.grantedAmount?.value), [100, 100, 100]);
  assert.deepEqual(result.candidates.map((entry) => entry.index), [0, 1, 2]);
  assert.deepEqual(validateGmailCandidatesJson(input, [mail]), result);
  // Batch-local repeatability, not cross-run persistence idempotency.
});

test("one bad discovery rejects the entire batch without partial accepted output", () => {
  const input = JSON.stringify({ schema: "keyatlas.gmail-candidates.v1", discoveries: [make(), make({ evidence_message_index: 4 })] });
  assert.deepEqual(validateGmailCandidatesJson(input, [mail]), { ok: false, code: "CANDIDATE_EVIDENCE_INVALID" });
});

test("strict versioned shape, JSON and count limits", () => {
  for (const input of ["{", "null", "[]", '{"schema":"old","discoveries":[]}',
    '{"schema":"keyatlas.gmail-candidates.v1","discoveries":[],"warnings":["SYNTHETIC_DETAIL"]}']) {
    assert.deepEqual(validateGmailCandidatesJson(input, [mail]), { ok: false, code: "CANDIDATE_INPUT_INVALID" });
  }
  const input = JSON.stringify({ schema: "keyatlas.gmail-candidates.v1", discoveries: Array.from({ length: MAIL_LIMITS.candidates + 1 }, () => make()) });
  assert.deepEqual(validateGmailCandidatesJson(input, [mail]), { ok: false, code: "CANDIDATE_LIMIT_EXCEEDED" });
  const empty = validateGmailCandidatesJson('{"schema":"keyatlas.gmail-candidates.v1","discoveries":[]}', []);
  assert.deepEqual(empty, { ok: true, candidates: [] });
});

test("UTF8 bytes are bounded before JSON parsing, including multibyte input", () => {
  for (const input of ["x".repeat(MAIL_LIMITS.candidateJsonBytes + 1), "한".repeat(Math.floor(MAIL_LIMITS.candidateJsonBytes / 3) + 1)]) {
    assert.deepEqual(validateGmailCandidatesJson(input, [mail]), { ok: false, code: "CANDIDATE_LIMIT_EXCEEDED" });
  }
});
