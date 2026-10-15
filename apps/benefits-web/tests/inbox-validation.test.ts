import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PENDING_WINDOW_MS, STAGING_POLICY, type CandidateBatchRow } from "../src/server/inbox/contracts.ts";
import { parseBatch, parseDiscard, parseListBatch, parseStagingGrant } from "../src/server/inbox/validation.ts";
import { ReviewFailure } from "../src/server/review/validation.ts";
import { REVIEW_NOW, analysisAuthority, stagingGrant } from "./support/review-memory-store.ts";

// Pure synthetic validation only. SOURCE models an already validated private
// runner handoff; parsing a caller-supplied authority is not this API's role.
const SOURCE = Object.freeze(analysisAuthority());
const EXTRACTED_AT = new Date(REVIEW_NOW).toISOString();
const FINGERPRINT = "0123456789abcdef".repeat(4);
function batch(): CandidateBatchRow {
  return { ownerId: SOURCE.ownerId, dataGeneration: SOURCE.dataGeneration,
    analysisOperationId: SOURCE.operationId, mailboxBindingId: SOURCE.mailboxBindingId,
    extractedAt: EXTRACTED_AT, pendingAccessUntil: REVIEW_NOW + 86400000,
    fingerprint: FINGERPRINT, candidateIds: ["synthetic-one", "synthetic-two"] };
}
function grant(input: unknown) {
  return parseStagingGrant(input, SOURCE, EXTRACTED_AT, REVIEW_NOW);
}
function invalid(action: () => unknown, context?: string): void {
  assert.throws(action, (error: unknown) => error instanceof ReviewFailure
    && error.code === "REVIEW_INPUT_INVALID" && error.message === "REVIEW_INPUT_INVALID", context);
}

const strictParsers: ReadonlyArray<{
  name: string; parse: (input: unknown) => unknown; input: () => Record<string, unknown>;
}> = [
  { name: "batch", parse: parseBatch, input: () => ({ ...batch() }) },
  { name: "staging grant", parse: grant, input: () => ({ ...stagingGrant() }) },
  { name: "discard", parse: parseDiscard, input: () => ({ candidateId: "synthetic-one", expectedRevision: 1, decision: "discard" }) },
  { name: "list batch", parse: parseListBatch, input: () => ({ analysisOperationId: SOURCE.operationId }) },
];
for (const parser of strictParsers) {
  test(`inbox ${parser.name} requires exact own enumerable data properties without executing getters`, () => {
    assert.ok(parser.parse(parser.input()));
    assert.ok(parser.parse(Object.assign(Object.create(null) as Record<string, unknown>, parser.input())));
    for (const input of [null, undefined, [], "synthetic", false, Object.create(parser.input()),
      { ...parser.input(), extra: true }, { ...parser.input(), [Symbol("extra")]: true }]) invalid(() => parser.parse(input));
    for (const key of Object.keys(parser.input())) {
      const missing = parser.input();
      delete missing[key];
      invalid(() => parser.parse(missing), `missing ${key}`);
      for (const value of [undefined, null]) invalid(() => parser.parse({ ...parser.input(), [key]: value }), `invalid ${key}`);
      let getterCalls = 0;
      const accessor = parser.input();
      Object.defineProperty(accessor, key, { enumerable: true, get() { getterCalls++; throw new Error("SYNTHETIC_GETTER"); } });
      invalid(() => parser.parse(accessor));
      assert.equal(getterCalls, 0);
      const hidden = parser.input();
      Object.defineProperty(hidden, key, { enumerable: false, value: hidden[key] });
      invalid(() => parser.parse(hidden));
    }
    const hiddenExtra = parser.input();
    Object.defineProperty(hiddenExtra, "extra", { enumerable: false, value: true });
    invalid(() => parser.parse(hiddenExtra));
  });
}

test("batch supports empty and exactly 100 distinct IDs while freezing a detached ordered list", () => {
  for (const candidateIds of [[], Array.from({ length: 100 }, (_, index) => `synthetic-${index}`), ["synthetic-z", "synthetic-a"]]) {
    const parsed = parseBatch({ ...batch(), candidateIds });
    assert.deepEqual(parsed.candidateIds, candidateIds);
    assert.notEqual(parsed.candidateIds, candidateIds);
    assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.candidateIds));
    candidateIds.push("synthetic-later");
    assert.ok(!parsed.candidateIds.includes("synthetic-later"));
  }
  invalid(() => parseBatch({ ...batch(), candidateIds: Array.from({ length: 101 }, (_, index) => `synthetic-${index}`) }));
  invalid(() => parseBatch({ ...batch(), candidateIds: ["synthetic-one", "synthetic-one"] }));
});

test("candidate ID arrays reject sparse, accessor, symbol, excess and inherited array metadata", () => {
  const sparse = ["synthetic-one", "synthetic-two"];
  delete sparse[0];
  class SubclassedIds extends Array<string> {}
  const hidden = ["synthetic-one"];
  Object.defineProperty(hidden, "0", { enumerable: false, value: "synthetic-one" });
  for (const candidateIds of [sparse, hidden, new SubclassedIds("synthetic-one"),
    Object.assign(["synthetic-one"], { extra: true }), Object.assign(["synthetic-one"], { [Symbol("extra")]: true }),
    Object.create(["synthetic-one"]), { 0: "synthetic-one", length: 1 }]) invalid(() => parseBatch({ ...batch(), candidateIds }));
  let getterCalls = 0;
  const accessor = ["synthetic-one"];
  Object.defineProperty(accessor, "0", { enumerable: true, get() { getterCalls++; throw new Error("SYNTHETIC_ID_GETTER"); } });
  invalid(() => parseBatch({ ...batch(), candidateIds: accessor }));
  assert.equal(getterCalls, 0);
  for (const id of [null, undefined, "", " synthetic", "synthetic\n", "synthetic\r", "x".repeat(129), 1]) {
    invalid(() => parseBatch({ ...batch(), candidateIds: [id] }));
  }
});

test("fingerprints require exactly 64 lowercase hex characters, not a claim of authenticity", () => {
  assert.equal(parseBatch({ ...batch(), fingerprint: "0".repeat(64) }).fingerprint, "0".repeat(64));
  assert.equal(parseBatch({ ...batch(), fingerprint: FINGERPRINT }).fingerprint, FINGERPRINT);
  for (const fingerprint of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64),
    FINGERPRINT + "\n", FINGERPRINT + "\r", " " + FINGERPRINT, null, 123]) invalid(() => parseBatch({ ...batch(), fingerprint }));
});

test("batch bindings and discard/list IDs reject coercion, malformed IDs and trailing newlines", () => {
  for (const field of ["ownerId", "analysisOperationId", "mailboxBindingId"]) {
    for (const value of ["synthetic\n", "synthetic\r", "bad id", "", 1]) invalid(() => parseBatch({ ...batch(), [field]: value }));
  }
  for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    invalid(() => parseBatch({ ...batch(), dataGeneration: value }));
    invalid(() => parseDiscard({ candidateId: "synthetic-one", expectedRevision: value, decision: "discard" }));
  }
  assert.equal(parseBatch({ ...batch(), dataGeneration: Number.MAX_SAFE_INTEGER }).dataGeneration, Number.MAX_SAFE_INTEGER);
  for (const value of ["synthetic\n", "synthetic\r", "", 1, null]) {
    invalid(() => parseListBatch({ analysisOperationId: value }));
    invalid(() => parseDiscard({ candidateId: value, expectedRevision: 1, decision: "discard" }));
  }
  for (const decision of [undefined, null, true, "delete", "reject", "discard\n"]) {
    invalid(() => parseDiscard({ candidateId: "synthetic-one", expectedRevision: 1, decision }));
  }
  assert.ok(Object.isFrozen(parseDiscard({ candidateId: "synthetic-one", expectedRevision: 1, decision: "discard" })));
  assert.ok(Object.isFrozen(parseListBatch({ analysisOperationId: SOURCE.operationId })));
});

test("batch and staging extraction instants require a valid canonical UTC calendar instant", () => {
  for (const extractedAt of ["1970-01-01T00:00:00.000Z", "2000-02-29T12:34:56.789Z", EXTRACTED_AT]) {
    const extractedTime = Date.parse(extractedAt);
    assert.equal(parseBatch({ ...batch(), extractedAt, pendingAccessUntil: extractedTime + 1 }).extractedAt, extractedAt);
    assert.ok(parseStagingGrant(stagingGrant({ expiresAt: extractedTime + 1, pendingAccessUntil: extractedTime + 1 }),
      SOURCE, extractedAt, extractedTime));
  }
  for (const extractedAt of ["0000-01-01T00:00:00.000Z", "1900-02-29T00:00:00.000Z", "2026-13-01T00:00:00.000Z",
    "2026-01-32T00:00:00.000Z", "2026-02-30T00:00:00.000Z", "2026-09-28T24:00:00.000Z",
    "2026-09-28T00:00:60.000Z", "2026-09-28", "2026-09-28T00:00:00Z", "2026-09-28T00:00:00.00Z",
    "2026-09-28T00:00:00.0000Z", "2026-09-28T00:00:00.000+00:00", EXTRACTED_AT + "\n", EXTRACTED_AT + "\r", "tomorrow"]) {
    invalid(() => parseBatch({ ...batch(), extractedAt }), extractedAt);
    invalid(() => parseStagingGrant(stagingGrant(), SOURCE, extractedAt, REVIEW_NOW), extractedAt);
  }
});

test("pending batch access is strictly after extraction and cannot exceed the inclusive technical window", () => {
  for (const offset of [1, MAX_PENDING_WINDOW_MS]) {
    assert.equal(parseBatch({ ...batch(), pendingAccessUntil: REVIEW_NOW + offset }).pendingAccessUntil, REVIEW_NOW + offset);
  }
  for (const pendingAccessUntil of [REVIEW_NOW - 1, REVIEW_NOW, REVIEW_NOW + MAX_PENDING_WINDOW_MS + 1,
    -1, REVIEW_NOW + 0.5, NaN, Infinity, 253402300800000, "1"]) invalid(() => parseBatch({ ...batch(), pendingAccessUntil }));
});

test("staging grant must match every captured analysis binding and the explicit storage policy", () => {
  for (const field of ["ownerId", "sessionId", "analysisOperationId", "mailboxBindingId", "recipientId", "analysisGrantId"]) {
    invalid(() => grant({ ...stagingGrant(), [field]: "synthetic-other" }), field);
  }
  for (const field of ["sessionRevision", "dataGeneration", "analysisGrantRevision"]) {
    for (const value of [2, 0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, "1"]) invalid(() => grant({ ...stagingGrant(), [field]: value }), field);
  }
  for (const policyVersion of ["keyatlas.gmail-review.v1", "old", STAGING_POLICY + "\n"]) {
    invalid(() => grant({ ...stagingGrant(), policyVersion }));
  }
  for (const allowCandidateStorage of [false, undefined, null, 1, "true"]) invalid(() => grant({ ...stagingGrant(), allowCandidateStorage }));
  const parsed = grant(stagingGrant());
  assert.deepEqual(parsed, stagingGrant());
  assert.ok(Object.isFrozen(parsed));
});

test("staging grant IDs and revisions require exact bounded IDs and positive safe integers", () => {
  for (const id of ["", "synthetic\n", "a".repeat(129), null, 1]) invalid(() => grant({ ...stagingGrant(), id }));
  for (const revision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) invalid(() => grant({ ...stagingGrant(), revision }));
  assert.equal(grant({ ...stagingGrant(), revision: Number.MAX_SAFE_INTEGER }).revision, Number.MAX_SAFE_INTEGER);
});

test("staging grant expiry and pending access reject elapsed, invalid and overlong windows", () => {
  for (const field of ["expiresAt", "pendingAccessUntil"]) {
    for (const value of [REVIEW_NOW - 1, REVIEW_NOW, -1, NaN, Infinity, REVIEW_NOW + 0.5, 253402300800000, "1"]) {
      invalid(() => grant({ ...stagingGrant(), [field]: value }));
    }
  }
  invalid(() => grant({ ...stagingGrant(), pendingAccessUntil: REVIEW_NOW + MAX_PENDING_WINDOW_MS + 1 }));
  assert.equal(grant({ ...stagingGrant(), pendingAccessUntil: REVIEW_NOW + MAX_PENDING_WINDOW_MS }).pendingAccessUntil,
    REVIEW_NOW + MAX_PENDING_WINDOW_MS);
  invalid(() => parseStagingGrant(stagingGrant(), SOURCE, new Date(REVIEW_NOW + 1).toISOString(), REVIEW_NOW));
  const oldExtraction = new Date(REVIEW_NOW - MAX_PENDING_WINDOW_MS).toISOString();
  invalid(() => parseStagingGrant(stagingGrant(), SOURCE, oldExtraction, REVIEW_NOW));
});

test("staging deadline comparisons never accept an invalid injected clock", () => {
  for (const now of [NaN, Infinity, -Infinity, -1, REVIEW_NOW + 0.5, 253402300800000]) {
    invalid(() => parseStagingGrant(stagingGrant(), SOURCE, EXTRACTED_AT, now));
  }
});
