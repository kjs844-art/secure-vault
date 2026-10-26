import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCatalogCreateRequest, createCatalogUpdateRequest,
  type CatalogServiceProfileInput,
} from "../src/domain/catalog-client/requests.ts";

// Synthetic public-builder contracts only. These do not execute the manual-input
// UI or establish provider/account truth, timezone conversion, authentication or
// persistence. Exact-empty UI-to-null mapping belongs to the component checks.
// The notes consumer suite already verifies the complete original eight-field
// body through 503 -> newer get -> same-command retry; do not duplicate it here.
function profile() {
  return {
    name: "합성 수동 기록", provider: "Synthetic provider", planName: "Synthetic plan",
    accountLabel: "Synthetic account", timezone: "Asia/Seoul", subscriptionStatus: "trial",
    trialEndsAt: "2028-02-29T12:34:56.123456789+09:00", notes: "보존할  합성 메모\n둘째 줄 🌱",
  };
}

const inputError = { name: "Error", message: "CATALOG_INPUT_INVALID" };
const builders = [
  { name: "create", build: (input: CatalogServiceProfileInput) =>
    createCatalogCreateRequest("synthetic-manual-facts-operation", input) },
  { name: "update", build: (input: CatalogServiceProfileInput) =>
    createCatalogUpdateRequest("synthetic-manual-facts-service", 7, "synthetic-manual-facts-operation", input) },
] as const;

for (const { name, build } of builders) {
  test(`${name} manual trial dates retain date-only, explicit offsets and all nine fractional digits`, () => {
    for (const trialEndsAt of [
      "0001-01-01", "2028-02-29", "9999-12-31",
      "2028-02-29T12:34:56Z", "2028-02-29T12:34:56+09:00", "2028-02-29T12:34:56-05:30",
      "2028-02-29T12:34:56+14:00", "2028-02-29T12:34:56-14:00",
      "2028-02-29T12:34:56.1Z", "2028-02-29T12:34:56.000000000Z",
      "2028-02-29T12:34:56.123456789+09:00",
    ]) {
      const input = { ...profile(), trialEndsAt };
      assert.deepEqual(build(input).body.profile, input);
    }
  });

  test(`${name} manual timezone and trial date clear only with explicit null, not empty input`, () => {
    for (const timezone of [null, "UTC", "Etc/UTC", "Asia/Seoul", "America/New_York"]) {
      const input = { ...profile(), timezone, trialEndsAt: null };
      assert.deepEqual(build(input).body.profile, input);
    }
    for (const timezone of ["", " ", " UTC", "UTC ", "UTC\n", "Asia/Seoul\u0000",
      "Synthetic/InvalidZone", undefined, false, 0]) {
      assert.throws(() => build({ ...profile(), timezone }), inputError);
    }
    for (const trialEndsAt of ["", " ", undefined, false, 0]) {
      assert.throws(() => build({ ...profile(), trialEndsAt }), inputError);
    }
  });

  test(`${name} manual subscription status accepts exactly six explicit states including unknown`, () => {
    for (const subscriptionStatus of ["active", "trial", "trial_ended", "paused", "cancelled", "unknown"]) {
      const input = { ...profile(), subscriptionStatus };
      assert.deepEqual(build(input).body.profile, input);
    }
    for (const subscriptionStatus of [null, "", " ", "UNKNOWN", "Active", "active ", " trial",
      "expired", "canceled", "trial-ended", "synthetic-status", undefined, false, 0]) {
      assert.throws(() => build({ ...profile(), subscriptionStatus }), inputError);
    }
  });

  test(`${name} manual trial dates reject invalid calendar, zoneless, offset and precision values`, () => {
    for (const trialEndsAt of [
      "0000-01-01", "2027-02-29", "2028-13-01", "2028-00-01", "2028-04-31", "2028-02-00",
      "2028-02-29T12:34:56", "2028-02-29T12:34Z", "2028-02-29 12:34:56Z",
      "2028-02-29T24:00:00Z", "2028-02-29T12:60:00Z", "2028-02-29T12:34:60Z",
      "2028-02-29T12:34:56-00:00", "2028-02-29T12:34:56+14:01", "2028-02-29T12:34:56+15:00",
      "2028-02-29T12:34:56+09:60", "2028-02-29T12:34:56+0900", "2028-02-29T12:34:56Z+09:00",
      "2028-02-29T12:34:56.1234567890Z", "2028-02-29T12:34:56.Z", "2028-02-29T12:34:56z",
      " 2028-02-29", "2028-02-29 ", "2028-02-29\n", "2028-02-29\u202e",
    ]) {
      assert.throws(() => build({ ...profile(), trialEndsAt }), inputError);
    }
  });

  test(`${name} manual facts remain independent user reports instead of inferred current subscription facts`, () => {
    const input = { ...profile(), timezone: "UTC", subscriptionStatus: "active", trialEndsAt: "1999-01-01" };
    assert.deepEqual(build(input).body.profile, input);
    const unknown = { ...profile(), timezone: null, subscriptionStatus: "unknown", trialEndsAt: "2099-01-01T00:00:00+09:00" };
    assert.deepEqual(build(unknown).body.profile, unknown);
    const cleared = { ...profile(), timezone: null, subscriptionStatus: "unknown", trialEndsAt: null };
    assert.deepEqual(build(cleared).body.profile, cleared);
  });
}

const profileKeys = ["name", "provider", "planName", "accountLabel", "timezone", "subscriptionStatus", "trialEndsAt", "notes"] as const;
const manualChanges: readonly {
  key: "timezone" | "subscriptionStatus" | "trialEndsAt";
  values: readonly unknown[];
}[] = [
  { key: "timezone", values: ["UTC", null] },
  { key: "subscriptionStatus", values: ["paused", "unknown"] },
  { key: "trialEndsAt", values: ["2028-02-29", "2028-02-29T12:34:56.000000001Z", null] },
];

for (const { key, values } of manualChanges) {
  test(`manual ${key}-only update preserves the exact other seven fields, notes and CAS target`, () => {
    const original = profile();
    for (const value of values) {
      const input = { ...original, [key]: value };
      const request = createCatalogUpdateRequest("synthetic-manual-facts-service", 7,
        "synthetic-manual-facts-operation", input);
      assert.deepEqual(request.body, {
        serviceId: "synthetic-manual-facts-service", expectedRevision: 7,
        operationId: "synthetic-manual-facts-operation", decision: "update", profile: input,
      });
      for (const other of profileKeys.filter((field) => field !== key)) {
        assert.equal(request.body.profile[other], original[other], other);
      }
      assert.equal(request.body.profile.notes, "보존할  합성 메모\n둘째 줄 🌱");
      assert.deepEqual(original, profile());
    }
  });
}
