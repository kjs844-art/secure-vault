import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCatalogCreateRequest, createCatalogUpdateRequest, createCatalogListRequest,
  type CatalogServiceProfileInput,
} from "../src/domain/catalog-client/requests.ts";

// Synthetic public-builder checks only. The client/controller already validate
// raw commands before transport. These tests cover the earlier builder boundary,
// not authentication, a secret detector, or a sandbox for arbitrary Proxy traps.
const profile = () => ({
  name: "합성 서비스 Café", provider: null, planName: "Synthetic free tier", accountLabel: null,
  timezone: "Asia/Seoul", subscriptionStatus: "trial", trialEndsAt: "2028-02-29T12:34:56+09:00",
  notes: "합성 메모\n두 번째 줄",
});
const cursor = () => ({ afterId: "synthetic-service-1", catalogRevision: 7, dataGeneration: 2 });
const profileKeys = Object.keys(profile());
const cursorKeys = Object.keys(cursor());
const inputError = { name: "Error", message: "CATALOG_INPUT_INVALID" };
type Fields = Record<string, unknown>;

function asInput(value: unknown): CatalogServiceProfileInput {
  return value as CatalogServiceProfileInput;
}

const profileBuilders = [
  { name: "create", build: (value: unknown) => createCatalogCreateRequest("synthetic-operation", asInput(value)) },
  { name: "update", build: (value: unknown) =>
    createCatalogUpdateRequest("synthetic-service-1", 3, "synthetic-operation", asInput(value)) },
];

const validRecords: { name: string; make: (fields: Fields) => Fields }[] = [
  { name: "plain", make: (fields) => fields },
  { name: "null prototype", make: (fields) => Object.assign(Object.create(null) as Fields, fields) },
  { name: "frozen", make: (fields) => Object.freeze(fields) },
  { name: "sealed", make: (fields) => Object.seal(fields) },
  { name: "readonly data", make: (fields) => {
    for (const key of Object.keys(fields)) Object.defineProperty(fields, key, { writable: false, configurable: false });
    return fields;
  } },
];

function invalidRecords(fields: Fields): unknown[] {
  class SyntheticRecord { constructor() { Object.assign(this, fields); } }
  const hiddenField = { ...fields };
  Object.defineProperty(hiddenField, Object.keys(fields)[0]!, { enumerable: false });
  return [
    null, undefined, [], Object.assign([], fields), new SyntheticRecord(),
    Object.create(fields), Object.assign(Object.create({ inherited: true }) as Fields, fields),
    { ...fields, extra: true }, { ...fields, [Symbol("synthetic-extra")]: true },
    Object.defineProperty({ ...fields }, "hidden", { value: true }), hiddenField,
  ];
}

for (const { name, build } of profileBuilders) {
  test(`${name} builder preserves exact plain/null-prototype/frozen profile values`, () => {
    for (const record of validRecords) {
      const expected = profile();
      const input = record.make({ ...expected });
      const result = build(input);
      assert.deepEqual(result.body.profile, expected, record.name);
      assert.notEqual(result.body.profile, input, record.name);
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen(result.body));
      assert.ok(Object.isFrozen(result.body.profile));
      assert.equal(result.body.operationId, "synthetic-operation");
      assert.equal(result.action, name);
    }
    const original = profile();
    const result = build(original);
    original.name = "Changed synthetic input";
    original.notes = "Changed synthetic note";
    assert.equal(result.body.profile.name, "합성 서비스 Café");
    assert.equal(result.body.profile.notes, "합성 메모\n두 번째 줄");
  });

  test(`${name} builder rejects malformed or non-exact profile records`, () => {
    for (const input of invalidRecords(profile())) assert.throws(() => build(input), inputError);
    for (const key of profileKeys) {
      const missing: Fields = profile();
      delete missing[key];
      assert.throws(() => build(missing), inputError);
    }
  });

  test(`${name} builder never executes profile accessors or serialization hooks`, () => {
    let calls = 0;
    for (const key of profileKeys) {
      for (const accessor of ["getter", "setter", "throwing getter"] as const) {
        const input: Fields = profile();
        const value = input[key];
        Object.defineProperty(input, key, accessor === "setter"
          ? { enumerable: true, set() { calls++; } }
          : { enumerable: true, get() {
            calls++;
            if (accessor === "throwing getter") throw new Error("SYNTHETIC_PRIVATE_ACCESSOR");
            return value;
          } });
        assert.throws(() => build(input), inputError);
        assert.equal(calls, 0);
      }
    }
    const hook = { ...profile(), toJSON() { calls++; return {}; } };
    assert.throws(() => build(hook), inputError);
    assert.equal(calls, 0);
  });

  test(`${name} builder preserves existing null/date/text validation rules`, () => {
    assert.equal(build({ ...profile(), name: "Synthetic 🚀" }).body.profile.name, "Synthetic 🚀");
    for (const date of [null, "2028-02-29", "2028-02-29T12:34:56.123+09:00"]) {
      const input = { ...profile(), provider: null, planName: null, accountLabel: null,
        timezone: null, trialEndsAt: date, notes: null };
      assert.deepEqual(build(input).body.profile, input);
    }
    for (const patch of [{ name: " padded " }, { name: "bad\ud800" },
      { notes: "bad\u0000note" }, { notes: "bad\tnote" },
      { trialEndsAt: "2027-02-29" }, { trialEndsAt: "2028-02-29T12:34:56-00:00" },
      { timezone: "Synthetic/InvalidZone" }, { subscriptionStatus: "synthetic-invalid" }]) {
      assert.throws(() => build({ ...profile(), ...patch }), inputError);
    }
  });
}

test("list builder preserves null and exact detached frozen cursor values", () => {
  assert.deepEqual(createCatalogListRequest(1, null).body, { limit: 1, cursor: null });
  for (const record of validRecords) {
    const expected = cursor();
    const input = record.make({ ...expected });
    const result = createCatalogListRequest(50, input);
    assert.deepEqual(result.body.cursor, expected, record.name);
    assert.notEqual(result.body.cursor, input, record.name);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.body));
    assert.ok(Object.isFrozen(result.body.cursor));
  }
  const original = cursor();
  const result = createCatalogListRequest(1, original);
  original.afterId = "synthetic-changed";
  original.catalogRevision = 100;
  original.dataGeneration = 100;
  assert.deepEqual(result.body.cursor, cursor());
});

test("list builder rejects non-exact cursor containers and accessors without invoking them", () => {
  for (const input of invalidRecords(cursor()).filter((value) => value !== null)) {
    assert.throws(() => createCatalogListRequest(1, input), inputError);
  }
  let calls = 0;
  for (const key of cursorKeys) {
    const missing: Fields = cursor();
    delete missing[key];
    assert.throws(() => createCatalogListRequest(1, missing), inputError);
    for (const accessor of ["getter", "setter", "throwing getter"] as const) {
      const input: Fields = cursor();
      const value = input[key];
      Object.defineProperty(input, key, accessor === "setter"
        ? { enumerable: true, set() { calls++; } }
        : { enumerable: true, get() {
          calls++;
          if (accessor === "throwing getter") throw new Error("SYNTHETIC_PRIVATE_ACCESSOR");
          return value;
        } });
      assert.throws(() => createCatalogListRequest(1, input), inputError);
      assert.equal(calls, 0);
    }
  }
  const hook = { ...cursor(), toJSON() { calls++; return {}; } };
  assert.throws(() => createCatalogListRequest(1, hook), inputError);
  assert.equal(calls, 0);
});

test("list builder keeps existing limits and cursor field semantics", () => {
  for (const limit of [0, 51, 1.5, "1", null]) assert.throws(() => createCatalogListRequest(limit, null), inputError);
  for (const patch of [{ afterId: " padded " }, { afterId: "../synthetic" },
    { catalogRevision: 0 }, { catalogRevision: 1.5 }, { dataGeneration: 0 },
    { dataGeneration: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => createCatalogListRequest(1, { ...cursor(), ...patch }), inputError);
  }
});

test("builders normalize reflection failures instead of exposing Proxy trap errors", () => {
  for (const { build, fields } of [
    ...profileBuilders.map(({ build }) => ({ build, fields: profile })),
    { build: (input: unknown) => createCatalogListRequest(1, input), fields: cursor },
  ]) {
    for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const) {
      const input = new Proxy(fields(), { [trap]: () => { throw new Error("SYNTHETIC_PRIVATE_PROXY"); } });
      assert.throws(() => build(input), inputError);
    }
    const revoked = Proxy.revocable(fields(), {});
    revoked.revoke();
    assert.throws(() => build(revoked.proxy), inputError);
  }
});
