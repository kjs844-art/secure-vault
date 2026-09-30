import assert from "node:assert/strict";
import { test } from "node:test";
import { MAIL_LIMITS } from "../src/server/mail/contracts.ts";
import { normalizeGmailMessagesJson } from "../src/server/mail/normalize-gmail.ts";
import { validateGmailCandidatesJson } from "../src/server/mail/validate-candidates.ts";

const source = (id: string, text: string) => ({
  id, internalDate: "0", payload: {
    mimeType: "text/plain",
    headers: [{ name: "Subject", value: "합성 Studio" }],
    body: { data: Buffer.from(text).toString("base64url") },
  },
});
const discovery = {
  evidence_message_index: 1, confidence: "high", benefit_kind: "credit",
  service_name: { value: "합성 Studio", part: "subject", quote: "합성 Studio" },
  benefit_name: null, unit: { value: "credits", part: "body", quote: "0 credits" },
  granted_amount: null, remaining_amount: { value: 0, part: "body", quote: "0 credits" },
  trial_days: null, remaining_days: null, expires_at: null, observed_at: null,
};
const output = (patch: Record<string, unknown> = {}) => JSON.stringify({
  schema: "keyatlas.gmail-candidates.v1", discoveries: [{ ...discovery, ...patch }],
});

test("normalized two-message batch links UTF-16 evidence only to its selected mail", () => {
  const mail = normalizeGmailMessagesJson(JSON.stringify([
    source("synthetic-one", "Different earlier observation"),
    source("synthetic-two", "합성 😀 0 credits"),
  ]));
  assert.ok(mail.ok);
  const result = validateGmailCandidatesJson(output(), mail.messages);
  assert.ok(result.ok);
  const candidate = result.candidates[0]!;
  assert.equal(candidate.remainingAmount!.value, 0);
  assert.equal(candidate.reviewStatus, "pending-review");
  const span = candidate.remainingAmount!.evidence;
  assert.equal(span.messageIndex, 1);
  assert.equal(mail.messages[1]![span.part].slice(span.start, span.end), "0 credits");
  assert.equal(candidate.observedAt, null);
  assert.ok(!JSON.stringify(result).includes("synthetic-two"));
  assert.deepEqual(validateGmailCandidatesJson(output({ evidence_message_index: 0 }), mail.messages),
    { ok: false, code: "CANDIDATE_EVIDENCE_INVALID" });
});

test("text truncated out of the normalized batch cannot support a claim", () => {
  const mail = normalizeGmailMessagesJson(JSON.stringify([
    source("synthetic-long", "x".repeat(MAIL_LIMITS.bodyChars) + "0 credits"),
  ]));
  assert.ok(mail.ok);
  assert.ok(mail.messages[0]!.warnings.includes("BODY_TRUNCATED"));
  assert.deepEqual(validateGmailCandidatesJson(output({ evidence_message_index: 0 }), mail.messages),
    { ok: false, code: "CANDIDATE_EVIDENCE_INVALID" });
});

test("HTML-only mail without snippet cannot become a body-backed candidate", () => {
  const message = source("synthetic-html", "<b>0 credits</b>");
  message.payload.mimeType = "text/html";
  const mail = normalizeGmailMessagesJson(JSON.stringify([message]));
  assert.ok(mail.ok);
  assert.equal(mail.messages[0]!.bodySource, "none");
  assert.deepEqual(validateGmailCandidatesJson(output({ evidence_message_index: 0 }), mail.messages),
    { ok: false, code: "CANDIDATE_EVIDENCE_INVALID" });
});

test("at-limit candidate batches work without adding persistence or summing balances", () => {
  const mail = normalizeGmailMessagesJson(JSON.stringify([source("synthetic-batch", "0 credits")]));
  assert.ok(mail.ok);
  const input = JSON.stringify({ schema: "keyatlas.gmail-candidates.v1", discoveries:
    Array.from({ length: MAIL_LIMITS.candidates }, () => ({ ...discovery, evidence_message_index: 0 })),
  });
  const result = validateGmailCandidatesJson(input, mail.messages);
  assert.ok(result.ok);
  assert.equal(result.candidates.length, MAIL_LIMITS.candidates);
  assert.ok(result.candidates.every((candidate) => candidate.reviewStatus === "pending-review" && candidate.remainingAmount?.value === 0));
});
