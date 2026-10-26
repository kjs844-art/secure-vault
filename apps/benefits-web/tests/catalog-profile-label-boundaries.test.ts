import assert from "node:assert/strict";
import { test } from "node:test";
import { createCatalogUpdateRequest, type CatalogServiceProfileInput } from "../src/domain/catalog-client/requests.ts";
import { CATALOG_VIEW_SCHEMA, decodeCatalogSuccess, decodeCatalogSuccessForRequest,
  type CatalogServiceProfileView } from "../src/domain/catalog-client/responses.ts";

// Synthetic, pure value-boundary regressions for the existing two optional label
// fields. No product rule changes, browser/UI, HTTP, authority or storage proof.
// Existing builder tests cover record descriptors; server tests cover server-side
// ASCII ceilings. These cases check client builder/decoder agreement and exact
// update acknowledgement, including Unicode and untouched profile fields.
const LABELS = ["planName", "accountLabel"] as const;
const OPERATION = "synthetic-label-update", SERVICE = "synthetic-label-service";
const INPUT_ERROR = { name: "Error", message: "CATALOG_INPUT_INVALID" };
function profile(): CatalogServiceProfileView {
  return { name: "합성 서비스 Café", provider: "합성 제공자 🚀", planName: "합성 기본 요금제",
    accountLabel: "합성 개인 계정", timezone: "Asia/Seoul", subscriptionStatus: "trial",
    trialEndsAt: "2028-02-29T23:59:59.123456789+09:00", notes: "합성 메모 첫 줄\n둘째 줄  가운데 공백\n끝 🚀" };
}
function update(value: CatalogServiceProfileInput) {
  return createCatalogUpdateRequest(SERVICE, 7, OPERATION, value);
}
function service(value: unknown, revision = 8) {
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, serviceId: SERVICE, serviceRevision: revision,
    state: "live", profile: value, createdAt: 1, updatedAt: 2,
    provenance: "user-reported", accountProof: "not-established" };
}
function receipt(value: unknown, revision = 8, replayed = false) {
  return { operationId: OPERATION, replayed, service: service(value, revision) };
}
function accepted(value: CatalogServiceProfileView) {
  const request = update(value);
  assert.deepEqual(request.body.profile, value);
  assert.notEqual(request.body.profile, value);
  const decoded = decodeCatalogSuccess("get", service(value));
  assert.ok(decoded?.kind === "view");
  assert.deepEqual(decoded.view.profile, value);
  assert.notEqual(decoded.view.profile, value);
  const acknowledgement = decodeCatalogSuccessForRequest(request, receipt(value));
  assert.ok(acknowledgement?.kind === "receipt");
  assert.deepEqual(acknowledgement.receipt.service.profile, value);
  assert.ok(Object.isFrozen(request.body.profile));
  assert.ok(Object.isFrozen(decoded.view.profile));
  return request;
}
function rejected(value: CatalogServiceProfileInput) {
  assert.throws(() => update(value), INPUT_ERROR);
  assert.equal(decodeCatalogSuccess("get", service(value)), null);
  assert.equal(decodeCatalogSuccess("update", receipt(value)), null);
}

test("label updates preserve independent null/value choices and every unedited profile value exactly", () => {
  for (const planName of [null, "합성 Pro 요금제 🚀"]) {
    for (const accountLabel of [null, "합성 업무 계정"]) {
      const original = profile(), edited = { ...original, planName, accountLabel };
      const request = accepted(edited);
      assert.deepEqual(request.body, { serviceId: SERVICE, expectedRevision: 7, operationId: OPERATION,
        decision: "update", profile: edited });
      // Explicitly protect the fields that the label editor must not rewrite.
      for (const field of ["name", "provider", "timezone", "subscriptionStatus", "trialEndsAt", "notes"] as const) {
        assert.equal(request.body.profile[field], original[field], field);
      }
      assert.equal(request.body.profile.trialEndsAt, "2028-02-29T23:59:59.123456789+09:00");
      assert.equal(request.body.profile.notes, "합성 메모 첫 줄\n둘째 줄  가운데 공백\n끝 🚀");
      const replacement = { ...edited, planName: "나중에 바뀐 합성 요금제", accountLabel: "나중에 바뀐 합성 계정" };
      Object.assign(edited, replacement);
      assert.equal(request.body.profile.planName, planName);
      assert.equal(request.body.profile.accountLabel, accountLabel);
    }
  }
});

test("both labels use the existing 160 UTF-16-unit ceiling, not a Unicode code-point count", () => {
  for (const field of LABELS) {
    for (const value of ["가".repeat(160), "🚀".repeat(80), "가".repeat(158) + "🚀"]) {
      assert.equal(value.length, 160);
      assert.equal(accepted({ ...profile(), [field]: value }).body.profile[field], value);
    }
    for (const value of ["가".repeat(161), "🚀".repeat(81), "가".repeat(159) + "🚀"]) {
      assert.ok(value.length > 160);
      rejected({ ...profile(), [field]: value });
    }
  }
});

test("label null is explicit absence; blank, undefined and nonstring values are not silently converted", () => {
  for (const field of LABELS) {
    for (const value of ["", undefined, 0, false, [], {}, new String("합성 라벨")]) {
      rejected({ ...profile(), [field]: value });
    }
  }
});

test("label builder and decoder reject embedded control, bidi and lone-surrogate characters", () => {
  const forbidden = ["\u0000", "\t", "\n", "\r", "\u001f", "\u007f", "\u0085", "\u009f",
    "\u061c", "\u200e", "\u200f", "\u202a", "\u202e", "\u2066", "\u2069",
    "\ud800", "\udbff", "\udc00", "\udfff", "\ud83d_\ude80"];
  for (const field of LABELS) for (const marker of forbidden) {
    rejected({ ...profile(), [field]: `합성${marker}라벨` });
  }
});

test("label edge and whitespace-only values are rejected while middle whitespace is preserved", () => {
  for (const field of LABELS) {
    for (const whitespace of [" ", "\u00a0", "\u3000", "\ufeff"]) {
      for (const value of [whitespace + "합성", "합성" + whitespace, whitespace, whitespace.repeat(3)]) {
        rejected({ ...profile(), [field]: value });
      }
      const value = `합성${whitespace}${whitespace}라벨`;
      assert.equal(accepted({ ...profile(), [field]: value }).body.profile[field], value);
    }
  }
});

test("labels are not Unicode-normalized and normalized acknowledgement substitutions are rejected", () => {
  for (const field of LABELS) {
    for (const [value, normalized] of [["Cafe\u0301", "Café"], ["ＡI 요금제", "AI 요금제"], ["합성 ﬁ 계정", "합성 fi 계정"]]) {
      assert.ok(value !== undefined && normalized !== undefined);
      assert.notEqual(value, normalized);
      const original = { ...profile(), [field]: value }, request = accepted(original);
      assert.equal(request.body.profile[field], value);
      const replaced = { ...original, [field]: normalized };
      // Both spellings are valid data; only exact request correlation rejects
      // substitution. Do not invent a ban on either canonical spelling.
      assert.ok(decodeCatalogSuccess("get", service(replaced)));
      assert.equal(decodeCatalogSuccessForRequest(request, receipt(replaced)), null);
      assert.equal(decodeCatalogSuccessForRequest(request, receipt(replaced, 8, true)), null);
    }
  }
});

test("same-revision update receipts bind both nullable labels, while later replay may truthfully differ", () => {
  for (const field of LABELS) {
    for (const originalValue of [null, "합성 원래 라벨"]) {
      const original = { ...profile(), [field]: originalValue }, request = update(original);
      const changed = { ...original, [field]: originalValue === null ? "합성 나중 라벨" : null };
      for (const replayed of [false, true]) {
        assert.equal(decodeCatalogSuccessForRequest(request, receipt(changed, 8, replayed)), null);
      }
      assert.equal(decodeCatalogSuccessForRequest(request, receipt(changed, 9, false)), null);
      const replay = decodeCatalogSuccessForRequest(request, receipt(changed, 9, true));
      assert.ok(replay?.kind === "receipt");
      assert.deepEqual(replay.receipt.service.profile, changed);
    }
  }
});
