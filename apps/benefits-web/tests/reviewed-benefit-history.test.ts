import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyReviewedBenefitHistory, selectReviewedBenefitHistory,
} from "../src/domain/reviewed-benefit-history.ts";
import {
  MAX_REVIEWED_BENEFIT_ENTRIES, REVIEWED_BENEFIT_VIEW_SCHEMA,
  type ReviewedBenefitValues, type ReviewedBenefitView,
} from "../src/domain/reviewed-benefit-view.ts";
import { projectReviewedBenefitPage } from "../src/server/review/page-presentation.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import type { ReviewResult } from "../src/server/review/contracts.ts";
import {
  CANDIDATE_ID, SERVICE_ID, REVIEW_NOW, createReviewMemoryStore, reviewValues,
} from "./support/review-memory-store.ts";

// Decoded synthetic observations only; no current provider balance, real user
// history, authorization, transport, persistence or whole-list freshness proof.
const REFERENCE = Date.parse("2026-10-18T00:00:00.123Z");
type Saved = Extract<ReviewedBenefitView, { readonly outcome: "saved" }>;
function saved(id = "synthetic-benefit", patch: Partial<ReviewedBenefitValues> = {}, sourceObservedAt: string | null = null): Saved {
  const values = reviewValues(patch);
  return { schema: REVIEWED_BENEFIT_VIEW_SCHEMA, dataGeneration: 1, benefitId: id, benefitRevision: 1,
    outcome: "saved", content: { serviceId: SERVICE_ID, serviceNameAtReview: "Synthetic reviewed service", values,
      valueOrigins: { name: "email-extracted", kind: "email-extracted", unit: "email-extracted",
        grantedAmount: "email-extracted", remainingAmount: "email-extracted", trialDaysStated: "email-extracted",
        remainingDaysStated: "email-extracted", expiresAt: "email-extracted",
        observedAt: values.observedAt === sourceObservedAt ? "email-extracted" : "user-corrected" },
      receivedAt: null, extractedAt: "2026-09-28T00:00:00.000Z", sourceObservedAt,
      reviewedAt: "2026-09-28T00:00:00.000Z", reviewReasons: ["USER_REVIEW_REQUIRED",
        "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED", "RECEIVED_DATE_UNKNOWN",
        ...(sourceObservedAt === null ? ["OBSERVATION_DATE_UNKNOWN" as const] : []), "PARTIAL_MAIL_TEXT"],
      reviewStatus: "accepted-by-user", accountProof: "not-established", currentBalanceProof: "not-established" } };
}
function deleted(id = "synthetic-deleted", generation = 1): ReviewedBenefitView {
  return { schema: REVIEWED_BENEFIT_VIEW_SCHEMA, dataGeneration: generation, benefitId: id,
    benefitRevision: 2, outcome: "deleted", content: null };
}
function classified(expiry: string | null, reference = REFERENCE) {
  const result = classifyReviewedBenefitHistory(saved("synthetic-benefit", { expiresAt: expiry }), reference);
  assert.ok(result && result.bucket !== "deleted");
  return result;
}
function frozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}
function success<T>(result: ReviewResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

test("explicit expiry before/equal/after the reference has distinct recorded-history semantics", () => {
  for (const [expiry, bucket, reason] of [
    ["2026-10-18T00:00:00.122Z", "history", "expiry_elapsed"],
    ["2026-10-18T00:00:00.123Z", "history", "expiry_elapsed"],
    ["2026-10-18T00:00:00.124Z", "review", "expiry_future"],
  ] as const) {
    const result = classified(expiry);
    assert.equal(result.bucket, bucket); assert.equal(result.reason, reason);
    assert.equal(result.record.content.values.expiresAt, expiry);
  }
});

test("different explicit offsets representing the same instant classify identically", () => {
  for (const expiry of ["2026-10-18T09:00:00.123+09:00", "2026-10-17T10:00:00.123-14:00",
    "2026-10-18T14:00:00.123+14:00", "2026-10-18T00:00:00.123+00:00", "2026-10-17T23:59:00.123-00:01"]) {
    assert.equal(classified(expiry).bucket, "history", expiry);
    assert.equal(classified(expiry, REFERENCE - 1).bucket, "review", expiry);
  }
});

for (const [fraction, bucket] of [
  ["1", "history"], ["12", "history"], ["123", "history"], ["1230", "history"],
  ["12300", "history"], ["123000", "history"], ["1230000", "history"], ["12300000", "history"],
  ["123000000", "history"], ["123000001", "review"], ["12300001", "review"],
  ["123001", "review"], ["12301", "review"], ["1231", "review"], ["122999999", "history"],
] as const) test(`fraction .${fraction} retains sub-ms boundary as ${bucket}`, () => {
  const expiry = `2026-10-18T09:00:00.${fraction}+09:00`;
  const result = classified(expiry);
  assert.equal(result.bucket, bucket);
  assert.equal(result.record.content.values.expiresAt, expiry);
});

test("whole seconds and dates near epoch/year bounds are handled without rounding or 1900 remapping", () => {
  assert.equal(classified("1970-01-01T00:00:00Z", 0).bucket, "history");
  assert.equal(classified("1970-01-01T00:00:00.000000001Z", 0).bucket, "review");
  assert.equal(classified("1969-12-31T23:59:59.999999999Z", 0).bucket, "history");
  assert.equal(classified("0001-01-01T00:00:00Z", 0).bucket, "history");
  assert.equal(classified("0099-12-31T23:59:59.999999999Z", 0).bucket, "history");
  assert.equal(classified("9999-12-31T23:59:59.999Z", 253402300799999).bucket, "history");
  assert.equal(classified("9999-12-31T23:59:59.999000001Z", 253402300799999).bucket, "review");
  assert.equal(classified("9999-12-31T23:59:59-14:00", 253402300799999).bucket, "review");
});

test("stated day precision stays review even when the calendar day looks long past", () => {
  for (const expiry of ["2000-01-01", "2026-10-18", "9999-12-31"]) {
    const result = classified(expiry);
    assert.equal(result.bucket, "review"); assert.equal(result.reason, "expiry_day_precision");
    assert.equal(result.record.content.values.expiresAt, expiry);
  }
});

test("null expiry stays unknown rather than becoming zero, midnight or a trial-derived date", () => {
  const result = classifyReviewedBenefitHistory(saved("synthetic-trial", {
    kind: "trial", expiresAt: null, observedAt: "2020-01-01", trialDaysStated: 14,
    remainingDaysStated: 0, remainingAmount: 0,
  }), REFERENCE);
  assert.ok(result && result.bucket === "review");
  assert.equal(result.reason, "expiry_unknown");
  assert.equal(result.record.content.values.expiresAt, null);
  assert.equal(result.record.content.values.remainingDaysStated, 0);
});

test("observation after expiry is not automatically a contradiction or evidence of renewal", () => {
  const input = saved("synthetic-past-observation", { expiresAt: "2026-09-01T00:00:00Z",
    observedAt: "2026-10-01T12:34:56.123456789+09:00", remainingAmount: 80 }, "2026-09-30");
  const result = classifyReviewedBenefitHistory(input, REFERENCE);
  assert.ok(result && result.bucket === "history");
  assert.equal(result.record.content.values.observedAt, input.content.values.observedAt);
  assert.equal(result.record.content.sourceObservedAt, "2026-09-30");
  assert.equal(result.record.content.values.remainingAmount, 80);
  assert.equal(result.record.content.currentBalanceProof, "not-established");
});

test("corrected expiry and observed fields keep their own provenance and original source", () => {
  const original = saved("synthetic-corrected", { expiresAt: "2026-10-17T12:34:56.987654321Z",
    observedAt: "2026-10-18" }, "2020-01-01");
  const input = { ...original, content: { ...original.content, valueOrigins: {
    ...original.content.valueOrigins, expiresAt: "user-corrected" as const,
  } } };
  const before = structuredClone(input);
  const result = classifyReviewedBenefitHistory(input, REFERENCE);
  assert.ok(result && result.bucket === "history");
  assert.deepEqual(result.record, input); assert.notEqual(result.record, input);
  assert.deepEqual(input, before); frozen(result);
});

test("null and zero amounts keep distinct values without changing expiry classification", () => {
  for (const remainingAmount of [null, 0, 80]) {
    const input = saved("synthetic-null-zero", { remainingAmount });
    const result = classifyReviewedBenefitHistory(input, REFERENCE);
    assert.ok(result && result.bucket === "review");
    assert.equal(result.reason, "expiry_unknown");
    assert.equal(result.record.content.values.remainingAmount, remainingAmount);
    assert.deepEqual(result.record.content.reviewReasons, input.content.reviewReasons);
    assert.equal(result.record.content.accountProof, "not-established");
  }
});

for (const input of [-0, -1, 0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER,
  253402300800000, "0", null, undefined, {}, new Date(REFERENCE)]) {
  test(`invalid explicit reference ${String(input)} never falls back to now`, () => {
    assert.equal(classifyReviewedBenefitHistory(saved(), input), null);
    assert.equal(selectReviewedBenefitHistory([saved()], "review", input), null);
  });
}

test("mode/reference validation happens before reflecting an untrusted row or collection", () => {
  let reflections = 0;
  const hostile = new Proxy({}, { getPrototypeOf() { reflections++; throw new Error("private"); } });
  assert.equal(classifyReviewedBenefitHistory(hostile, -0), null);
  assert.equal(selectReviewedBenefitHistory(hostile, "all", REFERENCE), null);
  assert.equal(selectReviewedBenefitHistory(hostile, "review", -0), null);
  assert.equal(reflections, 0);
});

test("selection is explicit, preserves input order and counts loaded live observations only", () => {
  const entries = [saved("synthetic-z", { expiresAt: "2000-01-01T00:00:00Z" }), deleted(),
    saved("synthetic-a"), saved("synthetic-m", { expiresAt: "2026-10-18" }),
    saved("synthetic-b", { expiresAt: "2001-01-01T00:00:00Z" })];
  const before = structuredClone(entries);
  const review = selectReviewedBenefitHistory(entries, "review", REFERENCE)!;
  const history = selectReviewedBenefitHistory(entries, "history", REFERENCE)!;
  assert.ok(review && history);
  assert.deepEqual(review.records.map((row) => row.record.benefitId), ["synthetic-a", "synthetic-m"]);
  assert.deepEqual(history.records.map((row) => row.record.benefitId), ["synthetic-z", "synthetic-b"]);
  for (const selection of [review, history]) {
    assert.equal(selection.totalLiveCount, 4); assert.equal(selection.reviewCount, 2); assert.equal(selection.historyCount, 2);
    assert.equal(selection.referenceMs, REFERENCE); frozen(selection);
    assert.deepEqual(Object.keys(selection).sort(), ["mode", "referenceMs", "totalLiveCount", "reviewCount", "historyCount", "records"].sort());
  }
  assert.deepEqual(entries, before);
});

test("deleted observations are excluded without mutating or purging input tombstones", () => {
  const input = deleted(); const before = structuredClone(input);
  const result = classifyReviewedBenefitHistory(input, REFERENCE);
  assert.deepEqual(result, { bucket: "deleted" }); frozen(result);
  const selected = selectReviewedBenefitHistory([input], "history", REFERENCE)!;
  assert.equal(selected.totalLiveCount, 0); assert.equal(selected.historyCount, 0); assert.equal(selected.reviewCount, 0);
  assert.deepEqual(selected.records, []); assert.deepEqual(input, before);
});

test("empty loaded arrays are valid for both modes and do not invent a completion flag", () => {
  for (const mode of ["review", "history"]) {
    const result = selectReviewedBenefitHistory([], mode, 0)!;
    assert.ok(result); assert.deepEqual(result.records, []);
    assert.equal(result.totalLiveCount, 0); assert.equal(Object.hasOwn(result, "complete"), false);
    assert.equal(Object.hasOwn(result, "nextCursor"), false);
  }
});

test("a page filtered to zero rows retains its original nonterminal cursor outside the selector", () => {
  const page = { benefits: [saved("synthetic-future", { expiresAt: "2027-01-01T00:00:00Z" })],
    nextCursor: Object.freeze({ afterId: "synthetic-future", benefitCollectionRevision: 5, dataGeneration: 1 }) };
  const cursor = page.nextCursor;
  const result = selectReviewedBenefitHistory(page.benefits, "history", REFERENCE)!;
  assert.deepEqual(result.records, []); assert.equal(result.reviewCount, 1);
  assert.equal(page.nextCursor, cursor); assert.equal(Object.hasOwn(result, "nextCursor"), false);
});

test("duplicate IDs, including live/deleted pairs, are rejected as a whole selection", () => {
  for (const entries of [[saved(), saved()], [saved(), deleted("synthetic-benefit")],
    [deleted(), deleted()], [deleted("synthetic-benefit"), saved()]]) {
    assert.equal(selectReviewedBenefitHistory(entries, "review", REFERENCE), null);
  }
});

test("generation agreement includes deleted observations and applies before filtering", () => {
  const foreign = { ...saved("synthetic-other"), dataGeneration: 2 };
  for (const entries of [[saved(), foreign], [saved(), deleted("synthetic-deleted", 2)],
    [deleted(), foreign]]) assert.equal(selectReviewedBenefitHistory(entries, "history", REFERENCE), null);
  assert.ok(selectReviewedBenefitHistory([{ ...saved(), dataGeneration: 2 }, deleted("synthetic-deleted", 2)], "review", REFERENCE));
});

test("only exact mode strings are accepted without coercion", () => {
  let coercions = 0;
  for (const mode of [undefined, null, "all", "Review", " history", 0, { toString() { coercions++; return "review"; } }]) {
    assert.equal(selectReviewedBenefitHistory([saved()], mode, REFERENCE), null);
  }
  assert.equal(coercions, 0);
});

test("a normal frozen dense array of 1000 rows is accepted but larger arrays reject before enumeration", () => {
  const entries = Object.freeze(Array.from({ length: MAX_REVIEWED_BENEFIT_ENTRIES }, (_, index) => saved(`synthetic-${index}`)));
  const result = selectReviewedBenefitHistory(entries, "review", REFERENCE)!;
  assert.equal(result.records.length, 1000); assert.equal(result.totalLiveCount, 1000);
  let enumerations = 0, reads = 0;
  const tooLarge = new Array(MAX_REVIEWED_BENEFIT_ENTRIES + 1);
  Object.defineProperty(tooLarge, "0", { enumerable: true, get() { reads++; return saved(); } });
  const proxy = new Proxy(tooLarge, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); } });
  assert.equal(selectReviewedBenefitHistory(proxy, "review", REFERENCE), null);
  assert.equal(enumerations, 0); assert.equal(reads, 0);
});

test("sparse/accessor/hidden/extra/inherited array properties reject without getter execution", () => {
  let getters = 0;
  const arrays: unknown[] = [new Array(1), { 0: saved(), length: 1 }];
  const accessor = [saved()]; Object.defineProperty(accessor, "0", { enumerable: true, get() { getters++; return saved(); } }); arrays.push(accessor);
  const hidden = [saved()]; Object.defineProperty(hidden, "0", { value: hidden[0], enumerable: false }); arrays.push(hidden);
  const inherited = [saved()]; Object.setPrototypeOf(inherited, Object.create(Array.prototype)); arrays.push(inherited);
  const nullPrototype = [saved()]; Object.setPrototypeOf(nullPrototype, null); arrays.push(nullPrototype);
  for (const key of ["extra", Symbol("extra")]) {
    const extra = [saved()]; Object.defineProperty(extra, key, { value: 1 }); arrays.push(extra);
  }
  for (const entries of arrays) assert.equal(selectReviewedBenefitHistory(entries, "review", REFERENCE), null);
  assert.equal(getters, 0);
});

test("invalid row anywhere rejects the whole array without partial results or getter execution", () => {
  let getters = 0;
  const malformed = saved("synthetic-malformed");
  Object.defineProperty(malformed.content.values, "expiresAt", { enumerable: true, get() { getters++; return "2000-01-01T00:00:00Z"; } });
  assert.equal(classifyReviewedBenefitHistory(malformed, REFERENCE), null);
  assert.equal(selectReviewedBenefitHistory([saved(), malformed], "review", REFERENCE), null);
  assert.equal(getters, 0);
  for (const expiry of ["2026-02-30T00:00:00Z", "2026-10-18T00:00:00", "2026-10-18T00:00:00-00:00"])
    assert.equal(classifyReviewedBenefitHistory(saved("synthetic-invalid-date", { expiresAt: expiry }), REFERENCE), null);
});

test("reflection errors are fixed null results rather than thrown private details", () => {
  const entries = new Proxy([saved()], { ownKeys() { throw new Error("synthetic-private"); } });
  assert.equal(selectReviewedBenefitHistory(entries, "history", REFERENCE), null);
  const record = new Proxy(saved(), { getPrototypeOf() { throw new Error("synthetic-private"); } });
  assert.equal(classifyReviewedBenefitHistory(record, REFERENCE), null);
});

test("neither classification nor selection reads ambient Date.now", (context) => {
  context.mock.method(Date, "now", () => { throw new Error("ambient time forbidden"); });
  const input = saved("synthetic-clock", { expiresAt: "2026-10-18T00:00:00.123000001Z" });
  assert.equal(classifyReviewedBenefitHistory(input, REFERENCE)?.bucket, "review");
  assert.equal(selectReviewedBenefitHistory([input], "history", REFERENCE)?.records.length, 0);
});

test("real synthetic preview/confirm/list/projection feeds history without legacy casts", async () => {
  const store = createReviewMemoryStore();
  const service = createReviewService(store.dependencies);
  const preview = success(await service.preview({ candidateId: CANDIDATE_ID, candidateRevision: 1,
    serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues({
      expiresAt: "2026-09-27T23:59:59.999999999Z", observedAt: "2026-09-28", remainingAmount: 0,
    }) }));
  const confirmed = success(await service.confirm({ previewId: preview.id,
    operationId: "synthetic-history-confirm", decision: "confirm" }));
  const before = store.snapshot();
  const page = projectReviewedBenefitPage(success(await service.list({ cursor: null, limit: 50 })));
  const selection = selectReviewedBenefitHistory(page.benefits, "history", REVIEW_NOW)!;
  assert.equal(selection.totalLiveCount, 1); assert.equal(selection.historyCount, 1);
  assert.equal(selection.records[0]!.record.benefitId, confirmed.benefitId);
  assert.equal(selection.records[0]!.record.content.values.observedAt, "2026-09-28");
  assert.equal(selection.records[0]!.record.content.values.remainingAmount, 0);
  assert.deepEqual(store.snapshot(), before); frozen(selection);
});
