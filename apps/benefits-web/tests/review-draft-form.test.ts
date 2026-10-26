import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReviewDraftFields, toReviewDraftFields, type ReviewDraftFields } from "../src/domain/review-draft-form.ts";
import { createReviewPreviewRequest, type ReviewRequestValues } from "../src/domain/review-client/requests.ts";

const values = (): ReviewRequestValues => ({ name: "공개 합성 크레딧 Café 🚀", kind: "credit", unit: "credits",
  grantedAmount: 100.25, remainingAmount: 0, trialDaysStated: null, remainingDaysStated: 0,
  expiresAt: "2028-02-29", observedAt: "2026-09-27T12:34:56.123456789+09:00" });
const fields = (): ReviewDraftFields => ({ name: "공개 합성 크레딧 Café 🚀", kind: "credit", unit: "credits",
  grantedAmount: "100.25", remainingAmount: "0", trialDaysStated: "", remainingDaysStated: "0",
  expiresAt: "2028-02-29", observedAt: "2026-09-27T12:34:56.123456789+09:00" });
const invalid = (input: unknown) => assert.deepEqual(parseReviewDraftFields(input), { kind: "invalid" });
const valid = (input: unknown) => {
  const result = parseReviewDraftFields(input); assert.equal(result.kind, "valid");
  if (result.kind !== "valid") throw new Error("TEST_VALID_EXPECTED");
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.values));
  return result.values;
};

test("all nine fields roundtrip, preserve date strings and zero versus unknown, and detach frozen output", () => {
  const input = values(), output = toReviewDraftFields(input);
  assert.deepEqual(output, fields()); assert.ok(Object.isFrozen(output));
  assert.deepEqual(valid(output), input);
  assert.notEqual(valid(output), input);
  assert.deepEqual(input, values());
});
test("blank nullable fields stay null and unit is only required by the existing amount contract", () => {
  const parsed = valid({ ...fields(), unit: "", grantedAmount: "", remainingAmount: "",
    remainingDaysStated: "", expiresAt: "", observedAt: "" });
  assert.deepEqual(parsed, { ...values(), unit: null, grantedAmount: null, remainingAmount: null,
    remainingDaysStated: null, expiresAt: null, observedAt: null });
  invalid({ ...fields(), unit: "" });
  invalid({ ...fields(), name: "" }); invalid({ ...fields(), kind: "" });
});
test("formatting normalizes existing numeric negative zero, never accepts textual negative zero", () => {
  const output = toReviewDraftFields({ ...values(), remainingAmount: -0, remainingDaysStated: -0 });
  assert.ok(output); assert.equal(output.remainingAmount, "0"); assert.equal(output.remainingDaysStated, "0");
  const parsed = valid(output); assert.ok(!Object.is(parsed.remainingAmount, -0));
  invalid({ ...fields(), remainingAmount: "-0" });
});
test("plain, null-prototype and frozen data records are accepted without mutating caller data", () => {
  for (const input of [fields(), Object.assign(Object.create(null), fields()), Object.freeze(fields())]) {
    assert.deepEqual(valid(input), values());
  }
  assert.deepEqual(toReviewDraftFields(Object.assign(Object.create(null), values())), fields());
});

for (const number of [0, 0.1, 0.000001, 0.0000001, 1.2345678901234567, 1e-100, Number.MIN_VALUE,
  9007199254740990, Number.MAX_SAFE_INTEGER]) test(`String(number) roundtrip: ${number}`, () => {
  const input = { ...values(), grantedAmount: number, remainingAmount: number };
  const output = toReviewDraftFields(input); assert.ok(output);
  assert.deepEqual(valid(output), input);
});
for (const [source, expected] of [["0.0", 0], ["0e999", 0], ["100.2500", 100.25], ["1e3", 1000],
  ["1.00e-1", 0.1], ["100e-2", 1], ["0.0000001", 1e-7], ["5.0e-324", Number.MIN_VALUE]] as const) {
  test(`exact decimal equivalent is allowed: ${source}`, () => {
    assert.equal(valid({ ...fields(), remainingAmount: source }).remainingAmount, expected);
  });
}
for (const source of [" ", " 0", "0 ", "0\n", "\t0", "+0", "-1", "Infinity", "NaN", "0x10", "0b10",
  "0o10", "1_000", "1,000", "1px", ".5", "1.", "01", "00.1", "1E3", "1e+3", "1e03", "1e", "1e--3",
  "1e309", "1e-999", "0.10000000000000001", "9007199254740990.5", "9007199254740992", "9007199254740991.1",
  "9".repeat(65), "０", "١"]) test(`malformed, lossy or out-of-range numeric text is rejected: ${JSON.stringify(source)}`, () => {
  invalid({ ...fields(), grantedAmount: source }); invalid({ ...fields(), remainingAmount: source });
});
test("day fields permit only safe integer values after exact decimal parsing", () => {
  for (const source of ["1.5", "0.1", "1e-7", "9007199254740992"]) {
    invalid({ ...fields(), trialDaysStated: source }); invalid({ ...fields(), remainingDaysStated: source });
  }
  assert.equal(valid({ ...fields(), trialDaysStated: "1.000e3", remainingDaysStated: "9007199254740991" }).trialDaysStated, 1000);
});
test("text bounds are checked before conversion and current text rules still apply", () => {
  valid({ ...fields(), name: "가".repeat(160), unit: "u".repeat(40) });
  for (const changed of [{ name: "a".repeat(161) }, { unit: "u".repeat(41) }, { kind: "membershipx" },
    { name: " padded" }, { name: "padded " }, { name: "\u0000" }, { name: "\u202e" }, { name: "\ud800" },
    { unit: " " }, { unit: " credits" }, { kind: "credit " }, { kind: "unknown" }, { observedAt: "x".repeat(41) }]) invalid({ ...fields(), ...changed });
});
for (const date of ["0001-01-01", "2028-02-29", "9999-12-31", "2026-10-18T01:02:03Z",
  "2026-10-18T01:02:03.1Z", "2026-10-18T01:02:03.123456789-14:00", "2026-10-18T01:02:03.000000001+14:00",
  "2026-10-18T01:02:03.1200+09:30"]) test(`date precision and offset remain unchanged: ${date}`, () => {
  const input = { ...fields(), expiresAt: date, observedAt: date }, parsed = valid(input);
  assert.equal(parsed.expiresAt, date); assert.equal(parsed.observedAt, date);
  assert.deepEqual(toReviewDraftFields(parsed), input);
});
test("every allowed fractional precision from one through nine digits roundtrips", () => {
  for (let count = 1; count <= 9; count++) {
    const date = `2026-10-18T01:02:03.${"123456789".slice(0, count)}+09:00`;
    assert.equal(valid({ ...fields(), expiresAt: date }).expiresAt, date);
  }
});
for (const date of ["2026-02-29", "2026-04-31", "0000-01-01", "2026-10-18T01:02:03", "2026-10-18T24:00:00Z",
  "2026-10-18T01:02:60Z", "2026-10-18T01:02:03.1234567890Z", "2026-10-18T01:02:03-00:00",
  "2026-10-18T01:02:03+14:01", "2026-10-18 "]) test(`invalid date is rejected without normalization: ${date}`, () => {
  invalid({ ...fields(), expiresAt: date }); invalid({ ...fields(), observedAt: date });
});
test("existing kind/unit semantics are reused instead of inventing form-specific benefit policy", () => {
  for (const kind of ["membership", "trial", "coupon", "credit", "point", "storage", "receipt", "expiration", "other"] as const) {
    const input = { ...fields(), kind, grantedAmount: "", remainingAmount: "" };
    const parsed = valid(input);
    assert.deepEqual(parsed, createReviewPreviewRequest("synthetic-candidate", 1, "synthetic-service", 1, parsed).body.values);
  }
  for (const kind of ["membership", "receipt", "expiration"]) invalid({ ...fields(), kind });
});
test("extra, missing, symbol, inherited and accessor fields are rejected without calling getters", () => {
  let calls = 0;
  for (const key of Object.keys(fields())) {
    const accessor = Object.defineProperty({ ...fields() }, key, { enumerable: true, get() { calls++; return "0"; } });
    invalid(accessor);
    const hidden = Object.defineProperty({ ...fields() }, key, { enumerable: false, value: "0" }); invalid(hidden);
    const missing: Record<string, unknown> = { ...fields() }; delete missing[key]; invalid(missing);
  }
  invalid({ ...fields(), extra: "public" }); invalid({ ...fields(), [Symbol("extra")]: "public" });
  invalid(Object.create(fields())); invalid(Object.assign(Object.create({}), fields()));
  assert.equal(calls, 0);
});
test("non-string fields and conversion hooks are rejected without executing value hooks", () => {
  let calls = 0;
  const malicious = { toString() { calls++; return "0"; }, valueOf() { calls++; return 0; }, toJSON() { calls++; return "0"; } };
  for (const key of Object.keys(fields())) for (const input of [null, undefined, 0, true, malicious, ["0"]]) {
    invalid({ ...fields(), [key]: input });
  }
  assert.equal(calls, 0);
});
test("reflection failures and invalid outer inputs return content-free failures", () => {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const throwing = new Proxy(fields(), { ownKeys() { throw new Error("public synthetic trap detail"); } });
  for (const input of [null, undefined, true, "public", 0, [], new Date(0), revoked.proxy, throwing]) {
    invalid(input); assert.equal(toReviewDraftFields(input), null);
  }
});
test("formatter validates values strictly, never reads value accessors, and never normalizes dates", () => {
  let calls = 0;
  const accessor = Object.defineProperty({ ...values() }, "name", { enumerable: true, get() { calls++; return "public"; } });
  for (const input of [accessor, { ...values(), extra: "public" }, { ...values(), remainingAmount: NaN },
    { ...values(), remainingAmount: Infinity }, { ...values(), remainingDaysStated: 1.5 },
    { ...values(), expiresAt: "2026-02-29" }, { ...values(), remainingAmount: "0" }, { ...values(), unit: null }]) {
    assert.equal(toReviewDraftFields(input), null);
  }
  assert.equal(calls, 0);
});
