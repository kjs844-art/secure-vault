import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeReviewPreviewView, REVIEW_PREVIEW_VIEW_SCHEMA } from "../src/domain/review-preview-view.ts";

// Synthetic DTO validation only: not real authentication, expiry authorization,
// UI ownership, network/JSON byte limits, browser execution or persistence.
const VALUE_KEYS = ["name", "kind", "unit", "grantedAmount", "remainingAmount", "trialDaysStated",
  "remainingDaysStated", "expiresAt", "observedAt"] as const;
function raw() {
  return {
    schema: REVIEW_PREVIEW_VIEW_SCHEMA, dataGeneration: 4, previewId: "synthetic-preview", previewRevision: 1,
    expiresAt: 1792281900000,
    content: {
      serviceId: "synthetic-service", serviceRevision: 3, serviceName: "합성 서비스 α 😀",
      values: { name: "합성 혜택", kind: "credit", unit: "credits", grantedAmount: 10, remainingAmount: null,
        trialDaysStated: null, remainingDaysStated: null, expiresAt: null, observedAt: null },
      valueOrigins: Object.fromEntries(VALUE_KEYS.map((key) => [key, "email-extracted"])),
      receivedAt: null, extractedAt: "2026-10-18T00:00:00.000Z", sourceObservedAt: null,
      reviewReasons: ["USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED",
        "RECEIVED_DATE_UNKNOWN", "OBSERVATION_DATE_UNKNOWN", "PARTIAL_MAIL_TEXT"],
      evidenceAvailability: "not-retained", reviewStatus: "pending-review", accountProof: "not-established", currentBalanceProof: "not-established",
    },
  };
}
function frozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}
function records(input: ReturnType<typeof raw>): object[] {
  return [input, input.content, input.content.values, input.content.valueOrigins];
}

test("decodes a detached deep-frozen pending preview without asserting a current balance", () => {
  const input = raw();
  const result = decodeReviewPreviewView(input);
  assert.ok(result);
  assert.deepEqual(result, input);
  assert.equal(result.content.reviewStatus, "pending-review");
  assert.equal(result.content.currentBalanceProof, "not-established");
  assert.equal(result.content.values.remainingAmount, null);
  assert.equal(result.content.sourceObservedAt, null);
  frozen(result);
  assert.notEqual(result.content, input.content);
  assert.notEqual(result.content.values, input.content.values);
  assert.notEqual(result.content.valueOrigins, input.content.valueOrigins);
  assert.notEqual(result.content.reviewReasons, input.content.reviewReasons);
  input.content.serviceName = "Changed synthetic service";
  input.content.valueOrigins.name = "user-corrected";
  input.content.reviewReasons.length = 0;
  assert.equal(result.content.serviceName, "합성 서비스 α 😀");
  assert.equal(result.content.valueOrigins.name, "email-extracted");
  assert.equal(result.content.reviewReasons.length, 6);
});

test("accepts null-prototype data records and never normalizes zero into unknown", () => {
  const input = raw();
  for (const record of records(input)) Object.setPrototypeOf(record, null);
  Object.assign(input.content.values, { remainingAmount: 0, trialDaysStated: 0, remainingDaysStated: 0 });
  const result = decodeReviewPreviewView(input);
  assert.ok(result);
  assert.equal(result.content.values.remainingAmount, 0);
  assert.equal(result.content.values.trialDaysStated, 0);
});

for (const date of ["2024-02-29", "2026-10-18T10:20:30+09:00", "2026-10-18T10:20:30.123456789-04:00", "0001-01-01", "9999-12-31"]) {
  test(`preserves source and corrected observation precision: ${date}`, () => {
    const input = raw();
    Object.assign(input.content.values, { observedAt: date, expiresAt: date });
    input.content.valueOrigins.observedAt = "user-corrected";
    const result = decodeReviewPreviewView(input);
    assert.ok(result);
    assert.equal(result.content.values.observedAt, date);
    assert.equal(result.content.values.expiresAt, date);
    assert.equal(result.content.sourceObservedAt, null);
    Object.assign(input.content, { sourceObservedAt: date });
    input.content.valueOrigins.observedAt = "email-extracted";
    assert.equal(decodeReviewPreviewView(input)?.content.sourceObservedAt, date);
  });
}

test("does not use ambient time or treat syntactically valid expiry as authorization", (t) => {
  t.mock.method(Date, "now", () => { throw Error("ambient time forbidden"); });
  for (const expiresAt of [0, 1, 253402300799999]) {
    const input = raw(); input.expiresAt = expiresAt;
    assert.equal(decodeReviewPreviewView(input)?.expiresAt, expiresAt);
  }
});

test("supports bounded identifiers, names, units and revisions without inventing IDs", () => {
  const input = raw();
  input.previewId = "a".repeat(128); input.content.serviceId = "b".repeat(128);
  input.dataGeneration = Number.MAX_SAFE_INTEGER; input.content.serviceRevision = Number.MAX_SAFE_INTEGER;
  input.content.serviceName = "가".repeat(160); input.content.values.name = "나".repeat(160); input.content.values.unit = "u".repeat(40);
  assert.ok(decodeReviewPreviewView(input));
});

for (const value of [null, undefined, false, 1, "synthetic", [], new Date(0)]) {
  test(`rejects a non-record root: ${String(value)}`, () => assert.equal(decodeReviewPreviewView(value), null));
}
test("requires exact own data fields at every record boundary without executing accessors/hooks", () => {
  for (let location = 0; location < 4; location++) {
    for (const alteration of ["extra", "missing", "hidden", "symbol", "inherited", "getter", "toJSON"]) {
      const input = raw(); const object = records(input)[location]!;
      const key = Object.keys(object)[0]!;
      let calls = 0;
      if (alteration === "extra") Object.assign(object, { ownerId: "synthetic-private-owner" });
      if (alteration === "missing") Reflect.deleteProperty(object, key);
      if (alteration === "hidden") Object.defineProperty(object, key, { enumerable: false });
      if (alteration === "symbol") Object.defineProperty(object, Symbol("private"), { value: 1 });
      if (alteration === "inherited") Object.setPrototypeOf(object, { unrelated: true });
      if (alteration === "getter") Object.defineProperty(object, key, { enumerable: true, get() { calls++; return "synthetic"; } });
      if (alteration === "toJSON") Object.assign(object, { toJSON() { calls++; return {}; } });
      assert.equal(decodeReviewPreviewView(input), null, `${location}/${alteration}`);
      assert.equal(calls, 0);
    }
  }
});

test("unknown internal identifiers, raw source and proof upgrades are never accepted", () => {
  for (const key of ["ownerId", "sessionId", "candidateId", "candidateRevision", "candidateIndex", "analysisOperationId", "mailboxBindingId", "source", "body", "quote"]) {
    const input = raw(); Object.assign(input.content, { [key]: "synthetic-private-detail" });
    assert.equal(decodeReviewPreviewView(input), null, key);
  }
  for (const [key, value] of [["reviewStatus", "accepted-by-user"], ["accountProof", "verified"],
    ["currentBalanceProof", "verified"], ["evidenceAvailability", "retained"]]) {
    const input = raw(); Object.assign(input.content, { [key!]: value });
    assert.equal(decodeReviewPreviewView(input), null);
  }
});

test("reflection failures become null without inspecting hostile thrown objects", () => {
  let reads = 0;
  const exception = new Proxy({}, { get() { reads++; throw Error("do not read exceptions"); } });
  for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const) {
    assert.equal(decodeReviewPreviewView(new Proxy(raw(), { [trap]() { throw exception; } })), null);
    const input = raw(); Object.assign(input.content, { values: new Proxy(input.content.values, { [trap]() { throw exception; } }) });
    assert.equal(decodeReviewPreviewView(input), null);
  }
  assert.equal(reads, 0);
});

test("rejects malformed schema, identity, immutable revision and canonical expiry", () => {
  for (const schema of [null, "keyatlas.review-preview-view.v2", "keyatlas.reviewed-benefit-view.v1"]) {
    assert.equal(decodeReviewPreviewView({ ...raw(), schema }), null);
  }
  for (const bad of [null, "1", 0, -0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(decodeReviewPreviewView({ ...raw(), dataGeneration: bad }), null);
    const input = raw(); Object.assign(input.content, { serviceRevision: bad });
    assert.equal(decodeReviewPreviewView(input), null);
  }
  for (const previewRevision of [0, 2, 1.5, "1", null, NaN]) assert.equal(decodeReviewPreviewView({ ...raw(), previewRevision }), null);
  for (const expiresAt of [-0, -1, 0.5, NaN, Infinity, "2026-10-18T00:00:00.000Z", null, 253402300800000]) {
    assert.equal(decodeReviewPreviewView({ ...raw(), expiresAt }), null);
  }
  for (const bad of ["", " synthetic", "synthetic ", "synthetic\n", "synthetic\r", "synthetic\u2028", "x@y", "https://synthetic.invalid", "a".repeat(129), null, 1]) {
    assert.equal(decodeReviewPreviewView({ ...raw(), previewId: bad }), null);
    const input = raw(); Object.assign(input.content, { serviceId: bad }); assert.equal(decodeReviewPreviewView(input), null);
  }
});

test("rejects malformed labels but keeps ordinary multilingual text and markup inert", () => {
  for (const bad of ["", " padded", "padded ", "a\n", "x\u061cy", "x\u200ey", "x\u200fy", "x\u202ey", "x\u2066y", "\ud800", "x".repeat(161)]) {
    const input = raw(); input.content.serviceName = bad; assert.equal(decodeReviewPreviewView(input), null);
    const other = raw(); other.content.values.name = bad; assert.equal(decodeReviewPreviewView(other), null);
  }
  const input = raw(); input.content.values.name = "<b>합성 예시</b>";
  assert.equal(decodeReviewPreviewView(input)?.content.values.name, input.content.values.name);
  // A future renderer must render this string as text, not trusted HTML.
  input.content.values.unit = "u".repeat(41); assert.equal(decodeReviewPreviewView(input), null);
});

test("rejects invalid amounts, days and amount/kind/unit combinations", () => {
  for (const key of ["grantedAmount", "remainingAmount", "trialDaysStated", "remainingDaysStated"]) {
    for (const bad of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) {
      const input = raw(); Object.assign(input.content.values, { [key]: bad }); assert.equal(decodeReviewPreviewView(input), null);
    }
  }
  for (const key of ["trialDaysStated", "remainingDaysStated"]) {
    const input = raw(); Object.assign(input.content.values, { [key]: 0.5 }); assert.equal(decodeReviewPreviewView(input), null);
  }
  for (const patch of [{ kind: "unknown" }, { unit: null }, { kind: "membership" }, { kind: "receipt" }, { kind: "expiration" }]) {
    const input = raw(); Object.assign(input.content.values, patch); assert.equal(decodeReviewPreviewView(input), null);
  }
  const input = raw(); Object.assign(input.content.values, { grantedAmount: 0.5, remainingAmount: 0.25 });
  assert.equal(decodeReviewPreviewView(input)?.content.values.remainingAmount, 0.25);
});

test("rejects impossible or ambiguous dates without repairing precision", () => {
  for (const bad of ["2026-02-29", "2026-02-30", "0000-01-01", "2026-13-01", "2026-10-18T24:00:00Z",
    "2026-10-18T00:60:00Z", "2026-10-18T00:00:60Z", "2026-10-18T00:00:00", "2026-10-18T00:00:00-00:00",
    "2026-10-18T00:00:00+14:01", "2026-10-18T00:00:00.1234567890Z", " 2026-10-18", "2026-10-18\n"]) {
    const input = raw(); Object.assign(input.content.values, { expiresAt: bad }); assert.equal(decodeReviewPreviewView(input), null, bad);
  }
  for (const bad of ["2026-10-18", "2026-10-18T00:00:00Z", "2026-10-18T00:00:00.000+00:00", "2026-10-18T00:00:00.0000Z", null]) {
    const input = raw(); Object.assign(input.content, { extractedAt: bad }); assert.equal(decodeReviewPreviewView(input), null);
    if (bad !== null) { const other = raw(); Object.assign(other.content, { receivedAt: bad }); assert.equal(decodeReviewPreviewView(other), null); }
  }
});

test("requires exact origins and consistent original/corrected observation, without inventing source values", () => {
  for (const origin of ["verified", "manual", null, undefined]) {
    const input = raw(); input.content.valueOrigins.name = origin as string; assert.equal(decodeReviewPreviewView(input), null);
  }
  const input = raw(); input.content.valueOrigins.observedAt = "user-corrected";
  assert.equal(decodeReviewPreviewView(input), null);
  Object.assign(input.content.values, { observedAt: "2026-10-17" });
  assert.ok(decodeReviewPreviewView(input));
  input.content.valueOrigins.observedAt = "email-extracted";
  assert.equal(decodeReviewPreviewView(input), null);
});

test("preserves warning requirements and rejects sparse/accessor/extra/duplicate reason arrays", () => {
  for (const reason of raw().content.reviewReasons.slice(0, 5)) {
    const input = raw(); input.content.reviewReasons = input.content.reviewReasons.filter((item) => item !== reason);
    assert.equal(decodeReviewPreviewView(input), null, reason);
  }
  for (const alteration of ["duplicate", "unknown", "hole", "extra", "symbol", "getter", "prototype", "over-limit"]) {
    const input = raw(); const reasons = input.content.reviewReasons; let calls = 0;
    if (alteration === "duplicate") reasons[5] = reasons[0]!;
    if (alteration === "unknown") reasons[5] = "AUTOMATICALLY_VERIFIED";
    if (alteration === "hole") Reflect.deleteProperty(reasons, "5");
    if (alteration === "extra") Object.assign(reasons, { note: "synthetic-private-detail" });
    if (alteration === "symbol") Object.defineProperty(reasons, Symbol("note"), { value: 1 });
    if (alteration === "getter") Object.defineProperty(reasons, "0", { enumerable: true, get() { calls++; return "USER_REVIEW_REQUIRED"; } });
    if (alteration === "prototype") Object.setPrototypeOf(reasons, null);
    if (alteration === "over-limit") reasons.push("PARTIAL_MAIL_TEXT");
    assert.equal(decodeReviewPreviewView(input), null, alteration); assert.equal(calls, 0);
  }
});

test("browser decoder source imports no server or ambient I/O implementation", () => {
  const source = readFileSync(new URL("../src/domain/review-preview-view.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:server|node:|provider|vault)[^"']*["']/);
  assert.doesNotMatch(source, /\b(?:fetch|localStorage|sessionStorage|indexedDB|XMLHttpRequest|Worker)\s*[.(]/);
});
