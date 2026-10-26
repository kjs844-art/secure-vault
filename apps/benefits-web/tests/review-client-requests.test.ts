import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewPreviewRequest, createReviewConfirmRequest, createReviewRejectRequest, createReviewDeleteRequest,
  createReviewGetRequest, createReviewListRequest, snapshotReviewRequest, type ReviewRequest } from "../src/domain/review-client/requests.ts";
import { parseDraft, parseConfirm, parseRevoke, parseDelete, parseBenefitRead, parseBenefitList } from "../src/server/review/validation.ts";

// Only tests import the server semantic parsers. No network, session, DB or live
// endpoint proof; reflection-error containment is not a sandbox for Proxy traps.
type Fields = Record<string, unknown>;
const error = { name: "Error", message: "REVIEW_INPUT_INVALID" };
const fixtureValues = (): Fields => ({ name: "합성 크레딧 Café 🚀", kind: "credit", unit: "credits",
  grantedAmount: 100.25, remainingAmount: 0, trialDaysStated: null, remainingDaysStated: 0,
  expiresAt: "2028-02-29", observedAt: "2026-09-27T12:34:56.123456789+09:00" });
const fixtureCursor = (): Fields => ({ afterId: "synthetic-benefit:1", benefitCollectionRevision: 3, dataGeneration: 2 });
const fixtures: Record<ReviewRequest["action"], () => Fields> = {
  preview: () => ({ candidateId: "synthetic-candidate", candidateRevision: 1, serviceId: "synthetic-service",
    serviceRevision: 2, values: fixtureValues() }),
  confirm: () => ({ previewId: "synthetic-preview", operationId: "synthetic-confirm", decision: "confirm" }),
  reject: () => ({ previewId: "synthetic-preview", expectedRevision: 1, decision: "reject" }),
  delete: () => ({ benefitId: "synthetic-benefit", expectedRevision: 2, operationId: "synthetic-delete", decision: "delete" }),
  get: () => ({ benefitId: "synthetic-benefit" }), list: () => ({ limit: 50, cursor: fixtureCursor() }),
};
const parsers = { preview: parseDraft, confirm: parseConfirm, reject: parseRevoke,
  delete: parseDelete, get: parseBenefitRead, list: parseBenefitList };
function build(action: ReviewRequest["action"], body: Fields): ReviewRequest {
  switch (action) {
    case "preview": return createReviewPreviewRequest(body.candidateId, body.candidateRevision, body.serviceId, body.serviceRevision, body.values);
    case "confirm": return createReviewConfirmRequest(body.previewId, body.operationId);
    case "reject": return createReviewRejectRequest(body.previewId, body.expectedRevision);
    case "delete": return createReviewDeleteRequest(body.benefitId, body.expectedRevision, body.operationId);
    case "get": return createReviewGetRequest(body.benefitId);
    case "list": return createReviewListRequest(body.limit, body.cursor);
  }
}
function frozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    assert.ok(Object.hasOwn(descriptor, "value")); frozen(descriptor.value);
  }
}
function parity(action: ReviewRequest["action"], body: unknown, valid: boolean): void {
  if (valid) {
    const expected = parsers[action](body), result = snapshotReviewRequest({ action, body });
    assert.deepEqual(result.body, expected); frozen(result);
    assert.deepEqual(build(action, body as Fields).body, expected);
    assert.deepEqual(snapshotReviewRequest(result), result);
  } else {
    assert.throws(() => parsers[action](body), { message: "REVIEW_INPUT_INVALID" });
    assert.throws(() => snapshotReviewRequest({ action, body }), error);
  }
}
const kinds = ["membership", "trial", "coupon", "credit", "point", "storage", "receipt", "expiration", "other"];
const actions = Object.keys(fixtures) as ReviewRequest["action"][];

for (const action of actions) test(`${action}: builder and snapshot match the server with detached deep-frozen output`, () => {
  const input = fixtures[action](), original = structuredClone(input), request = { action, body: input };
  const output = snapshotReviewRequest(request), built = build(action, input);
  assert.deepEqual(output, { action, body: original }); assert.deepEqual(built, output);
  assert.notEqual(output, request); assert.notEqual(output.body, input);
  if (action === "preview") {
    assert.notEqual((output as Extract<ReviewRequest, { action: "preview" }>).body.values, input.values);
    (input.values as Fields).name = "changed synthetic label";
  }
  if (action === "list") {
    assert.notEqual((output as Extract<ReviewRequest, { action: "list" }>).body.cursor, input.cursor);
    (input.cursor as Fields).afterId = "changed-synthetic-benefit";
  }
  for (const key of Object.keys(input)) input[key] = "changed";
  request.action = "get";
  assert.deepEqual(output, { action, body: original }); assert.deepEqual(built, output);
  assert.deepEqual(parsers[action](output.body), output.body); frozen(output); frozen(built);
  assert.throws(() => { (output as unknown as Fields).action = "changed"; }, TypeError);
});

const validRecords: Array<[string, (fields: Fields) => Fields]> = [
  ["plain", (f) => f], ["null-prototype", (f) => Object.assign(Object.create(null) as Fields, f)],
  ["frozen", (f) => Object.freeze(f)], ["sealed", (f) => Object.seal(f)],
  ["readonly", (f) => { for (const key of Object.keys(f)) Object.defineProperty(f, key, { writable: false, configurable: false }); return f; }],
];
for (const [label, transform] of validRecords) test(`all levels accept exact ${label} data records`, () => {
  for (const action of actions) {
    const expected = fixtures[action](), input = fixtures[action]();
    if (action === "preview") input.values = transform(input.values as Fields);
    if (action === "list") input.cursor = transform(input.cursor as Fields);
    const result = snapshotReviewRequest(transform({ action, body: transform(input) }));
    assert.deepEqual(result, { action, body: expected }); frozen(result);
    assert.deepEqual(build(action, input), result);
  }
});

type Boundary = { name: string; fields: () => Fields; parse: (input: unknown) => unknown };
const boundaries: Boundary[] = [
  ...actions.flatMap((action) => [
    { name: `${action} envelope`, fields: () => ({ action, body: fixtures[action]() }), parse: snapshotReviewRequest },
    { name: `${action} body`, fields: fixtures[action], parse: (body: unknown) => snapshotReviewRequest({ action, body }) },
  ]),
  { name: "preview values snapshot", fields: fixtureValues, parse: (values) => snapshotReviewRequest({ action: "preview", body: { ...fixtures.preview(), values } }) },
  { name: "preview values builder", fields: fixtureValues, parse: (values) => createReviewPreviewRequest("synthetic-candidate", 1, "synthetic-service", 1, values) },
  { name: "list cursor snapshot", fields: fixtureCursor, parse: (cursor) => snapshotReviewRequest({ action: "list", body: { limit: 1, cursor } }) },
  { name: "list cursor builder", fields: fixtureCursor, parse: (cursor) => createReviewListRequest(1, cursor) },
];
for (const boundary of boundaries) {
  test(`${boundary.name}: rejects hidden, symbol, extra, missing, inherited and nonrecord fields`, () => {
    const fields = boundary.fields();
    class SyntheticRecord { constructor() { Object.assign(this, fields); } }
    for (const input of [undefined, true, 1, "record", [], Object.assign([], fields), new SyntheticRecord(),
      Object.create(fields), Object.assign(Object.create({ inherited: true }) as Fields, fields),
      { ...fields, extra: true }, { ...fields, [Symbol("extra")]: true },
      Object.defineProperty({ ...fields }, "hidden", { value: true })]) assert.throws(() => boundary.parse(input), error);
    // A null cursor is specifically allowed, unlike null objects at other levels.
    if (!boundary.name.startsWith("list cursor")) assert.throws(() => boundary.parse(null), error);
    for (const key of Object.keys(fields)) {
      const missing = { ...fields }; delete missing[key];
      assert.throws(() => boundary.parse(missing), error);
      assert.throws(() => boundary.parse(Object.defineProperty({ ...fields }, key, { enumerable: false })), error);
    }
  });
  test(`${boundary.name}: never executes ordinary getters, setters or serialization hooks`, () => {
    let calls = 0;
    const fields = boundary.fields();
    for (const key of Object.keys(fields)) for (const variant of ["get", "set", "throw"] as const) {
      const input = Object.defineProperty({ ...fields }, key, variant === "set"
        ? { enumerable: true, set() { calls++; } }
        : { enumerable: true, get() { calls++; if (variant === "throw") throw Error("SYNTHETIC_PRIVATE_GETTER"); return fields[key]; } });
      assert.throws(() => boundary.parse(input), error); assert.equal(calls, 0);
    }
    assert.throws(() => boundary.parse({ ...fields, toJSON() { calls++; return {}; } }), error);
    assert.throws(() => boundary.parse({ ...fields, [Symbol.toPrimitive]() { calls++; return "record"; } }), error);
    assert.equal(calls, 0);
  });
  test(`${boundary.name}: reflection failures are normalized without exposing Proxy exception details`, () => {
    for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const) {
      const input = new Proxy(boundary.fields(), { [trap]() { throw Error("SYNTHETIC_PRIVATE_PROXY"); } });
      assert.throws(() => boundary.parse(input), error);
    }
    const revoked = Proxy.revocable(boundary.fields(), {}); revoked.revoke();
    assert.throws(() => boundary.parse(revoked.proxy), error);
  });
}

test("unknown action and missing or wrong decisions cannot be silently replaced", () => {
  for (const action of ["revoke", "remove", "Preview", "", null, undefined, {}, ["get"]]) {
    assert.throws(() => snapshotReviewRequest({ action, body: fixtures.get() }), error);
  }
  for (const action of ["confirm", "reject", "delete"] as const) {
    for (const decision of [undefined, null, true, "", "confirmed", ...actions.filter((other) => other !== action)]) {
      parity(action, { ...fixtures[action](), decision }, false);
    }
    const noDecision = fixtures[action](); delete noDecision.decision; parity(action, noDecision, false);
  }
});

test("all identifier slots retain the server ASCII grammar and 128-character ceiling", () => {
  const slots: Array<[ReviewRequest["action"], string]> = [["preview", "candidateId"], ["preview", "serviceId"],
    ["confirm", "previewId"], ["confirm", "operationId"], ["reject", "previewId"], ["delete", "benefitId"],
    ["delete", "operationId"], ["get", "benefitId"]];
  for (const [action, key] of slots) {
    for (const id of ["A", "1a._:-Z", "a".repeat(128)]) parity(action, { ...fixtures[action](), [key]: id }, true);
    for (const id of [null, undefined, 1, "", " synthetic", "synthetic ", "a".repeat(129), "한글", "a/b", "a?b", ".start", "a\n", "a\ud800"]) {
      const body = { ...fixtures[action](), [key]: id }; parity(action, body, false); assert.throws(() => build(action, body), error);
    }
  }
  for (const afterId of ["A", "b:2", "x".repeat(128)]) parity("list", { limit: 1, cursor: { ...fixtureCursor(), afterId } }, true);
  for (const afterId of ["", null, "x".repeat(129), "../a", "x/y"]) parity("list", { limit: 1, cursor: { ...fixtureCursor(), afterId } }, false);
});

test("revision, collection generation and page limits have exact numeric parity", () => {
  for (const [action, key] of [["preview", "candidateRevision"], ["preview", "serviceRevision"], ["reject", "expectedRevision"],
    ["delete", "expectedRevision"]] as Array<[ReviewRequest["action"], string]>) {
    for (const revision of [1, 2, Number.MAX_SAFE_INTEGER]) parity(action, { ...fixtures[action](), [key]: revision }, true);
    for (const revision of [0, -0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null, undefined]) {
      const body = { ...fixtures[action](), [key]: revision }; parity(action, body, false); assert.throws(() => build(action, body), error);
    }
  }
  for (const key of ["benefitCollectionRevision", "dataGeneration"]) {
    for (const revision of [1, Number.MAX_SAFE_INTEGER]) parity("list", { limit: 50, cursor: { ...fixtureCursor(), [key]: revision } }, true);
    for (const revision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      const cursor = { ...fixtureCursor(), [key]: revision };
      parity("list", { limit: 1, cursor }, false); assert.throws(() => createReviewListRequest(1, cursor), error);
    }
  }
  for (const limit of [1, 50]) parity("list", { limit, cursor: null }, true);
  for (const limit of [0, 51, -1, 1.5, NaN, Infinity, "1", null, undefined]) {
    parity("list", { limit, cursor: null }, false); assert.throws(() => createReviewListRequest(limit, null), error);
  }
});

test("all benefit kinds preserve amount/unit combinations, null, zero and fractional amounts", () => {
  for (const kind of kinds) for (const unit of [null, "credits"]) for (const grantedAmount of [null, 0, 2.5]) {
    const values = { ...fixtureValues(), kind, unit, grantedAmount, remainingAmount: null };
    const valid = grantedAmount === null || (unit !== null && !["membership", "receipt", "expiration"].includes(kind));
    parity("preview", { ...fixtures.preview(), values }, valid);
  }
  for (const remainingAmount of [null, 0, -0, 0.125, Number.MAX_SAFE_INTEGER]) {
    const values = { ...fixtureValues(), grantedAmount: null, remainingAmount };
    parity("preview", { ...fixtures.preview(), values }, true);
    const output = createReviewPreviewRequest("a", 1, "b", 1, values);
    assert.ok(Object.is(output.body.values.remainingAmount, remainingAmount));
  }
  for (const key of ["grantedAmount", "remainingAmount"]) for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0", undefined]) {
    parity("preview", { ...fixtures.preview(), values: { ...fixtureValues(), [key]: value } }, false);
  }
  for (const key of ["trialDaysStated", "remainingDaysStated"]) {
    for (const value of [null, 0, 1, Number.MAX_SAFE_INTEGER]) parity("preview", { ...fixtures.preview(), values: { ...fixtureValues(), [key]: value } }, true);
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0", undefined]) {
      parity("preview", { ...fixtures.preview(), values: { ...fixtureValues(), [key]: value } }, false);
    }
  }
  for (const kind of [null, undefined, "", "Credit", "unknown", {}, 1]) parity("preview", { ...fixtures.preview(), values: { ...fixtureValues(), kind } }, false);
});

test("label parity preserves ordinary multilingual text and rejects control, bidi and lone surrogate characters", () => {
  for (const key of ["name", "unit"]) {
    const max = key === "name" ? 160 : 40;
    for (const value of ["한글 합성", "عربي", "עברית", "Café 🚀", "a".repeat(max)]) {
      parity("preview", { ...fixtures.preview(), values: { ...fixtureValues(), [key]: value } }, true);
    }
    for (const value of ["", " padded ", "a".repeat(max + 1), 123, undefined,
      ...["\u0000", "\n", "\t", "\u007f", "\u0080", "\u061c", "\u200e", "\u200f", "\u202a", "\u202e", "\u2066", "\u2069", "\ud800", "\udfff"].map((v) => `a${v}b`)]) {
      parity("preview", { ...fixtures.preview(), values: { ...fixtureValues(), [key]: value } }, false);
    }
  }
  parity("preview", { ...fixtures.preview(), values: { ...fixtureValues(), name: null } }, false);
  parity("preview", { ...fixtures.preview(), values: { ...fixtureValues(), unit: null, grantedAmount: null, remainingAmount: null } }, true);
});

test("dates preserve day precision, all fractional digits and explicit offsets with server parity", () => {
  const valid = [null, "0001-01-01", "9999-12-31", "2000-02-29", "2028-02-29", "2026-01-01T00:00:00Z",
    "2026-01-01T23:59:59+14:00", "2026-01-01T23:59:59-14:00", "2026-01-01T23:59:59+00:00", "2026-01-01T23:59:59-00:30",
    ...Array.from({ length: 9 }, (_, i) => `2026-01-01T12:34:56.${"123456789".slice(0, i + 1)}+09:00`)];
  const invalid = [undefined, 123, "", " 2026-01-01", "2026-01-01 ", "0000-01-01", "1900-02-29", "2027-02-29",
    "2026-00-01", "2026-13-01", "2026-01-00", "2026-04-31", "2026-01-01T00:00:00", "2026-01-01T00:00:00z",
    "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:60Z", "2026-01-01T00:00:00-00:00",
    "2026-01-01T00:00:00+14:01", "2026-01-01T00:00:00+15:00", "2026-01-01T00:00:00+01:60", "2026-01-01T00:00:00.1234567890Z"];
  for (const key of ["expiresAt", "observedAt"]) {
    for (const date of valid) parity("preview", { ...fixtures.preview(), values: { ...fixtureValues(), [key]: date } }, true);
    for (const date of invalid) parity("preview", { ...fixtures.preview(), values: { ...fixtureValues(), [key]: date } }, false);
  }
});

test("scalar wrappers and coercion hooks never execute or become identifiers or numbers", () => {
  let calls = 0;
  const malicious = { toString() { calls++; return "synthetic"; }, valueOf() { calls++; return 1; },
    [Symbol.toPrimitive]() { calls++; return "synthetic"; } };
  for (const value of [malicious, new String("synthetic"), new Number(1)]) {
    assert.throws(() => createReviewGetRequest(value), error);
    assert.throws(() => createReviewListRequest(value, null), error);
    assert.throws(() => createReviewPreviewRequest("a", 1, "b", 1, { ...fixtureValues(), name: value }), error);
  }
  assert.equal(calls, 0);
});
