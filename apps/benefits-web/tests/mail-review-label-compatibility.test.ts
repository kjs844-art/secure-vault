import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeGmailMessagesJson } from "../src/server/mail/normalize-gmail.ts";
import { validateGmailCandidatesJson } from "../src/server/mail/validate-candidates.ts";
import { makeCandidateContent } from "../src/server/review/validation.ts";

// Synthetic composition only: no provider, auth, database or saved inbox.
const binding = Object.freeze({
  analysisOperationId: "synthetic-label-operation",
  mailboxBindingId: "synthetic-label-mailbox",
  extractedAt: "2026-10-18T00:00:00.000Z",
});

function fixture(label: string) {
  const normalized = normalizeGmailMessagesJson(JSON.stringify([{
    id: "synthetic-label-message", internalDate: "0", payload: {
      mimeType: "text/plain", headers: [{ name: "Subject", value: label }],
      body: { data: Buffer.from("Synthetic benefit notice").toString("base64url") },
    },
  }]));
  assert.ok(normalized.ok);
  const claim = (value: string) => ({ value, part: "subject", quote: label });
  const candidate = {
    evidence_message_index: 0, confidence: "low", benefit_kind: "trial",
    service_name: claim(label), benefit_name: claim(label), unit: claim(label),
    granted_amount: null, remaining_amount: null, trial_days: null,
    remaining_days: null, expires_at: null, observed_at: null,
  };
  const validate = (discoveries: readonly unknown[]) => validateGmailCandidatesJson(JSON.stringify({
    schema: "keyatlas.gmail-candidates.v1", discoveries,
  }), normalized.messages);
  return { candidate, claim, validate };
}

for (const [language, label] of [
  ["Korean", "합성 혜택"],
  ["Arabic", "خدمة تجريبية"],
  ["Hebrew", "שירות לדוגמה"],
  ["emoji", "Synthetic 😀 🧑‍💻"],
] as const) {
  test(`${language} labels pass unchanged from normalized mail candidates to review content`, () => {
    const { candidate, validate } = fixture(label);
    const result = validate([candidate]);
    assert.ok(result.ok);
    assert.equal(result.candidates.length, 1);
    const pending = result.candidates[0]!;
    assert.equal(pending.serviceName.value, label);
    assert.equal(pending.benefitName?.value, label);
    assert.equal(pending.unit?.value, label);
    assert.equal(pending.reviewStatus, "pending-review");
    assert.equal(pending.serviceName.verification, "unverified");

    const content = makeCandidateContent(pending, binding);
    assert.equal(content.serviceName, label);
    assert.equal(content.values.name, label);
    assert.equal(content.values.unit, label);
    assert.ok(content.reviewReasons.includes("USER_REVIEW_REQUIRED"));
    assert.ok(content.reviewReasons.includes("NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF"));
  });
}

for (const field of ["service_name", "benefit_name", "unit"] as const) {
  for (const [name, marker] of [
    ["ARABIC LETTER MARK U+061C", "\u061c"],
    ["LEFT-TO-RIGHT MARK U+200E", "\u200e"],
    ["RIGHT-TO-LEFT MARK U+200F", "\u200f"],
  ] as const) {
    test(`${field} rejects ${name} without returning a partial batch`, () => {
      const { candidate, claim, validate } = fixture("Synthetic Studio");
      const invalid = { ...candidate, [field]: claim(`Synthetic${marker} Studio`) };
      for (const discoveries of [[invalid], [candidate, invalid], [invalid, candidate]]) {
        const result = validate(discoveries);
        assert.equal(result.ok, false, "the upstream label boundary must reject before review content creation");
        assert.deepEqual(result, { ok: false, code: "CANDIDATE_INPUT_INVALID" });
      }
    });
  }
}
