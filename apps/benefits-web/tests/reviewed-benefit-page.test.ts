import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeReviewedBenefitPage, MAX_REVIEWED_BENEFIT_PAGE_ROWS, REVIEWED_BENEFIT_PAGE_SCHEMA,
} from "../src/domain/reviewed-benefit-page.ts";
import { projectReviewedBenefitPage } from "../src/server/review/page-presentation.ts";
import { projectReviewedBenefit } from "../src/server/review/presentation.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import { REVIEW_SCHEMA, type ReviewedBenefitPage, type ReviewedBenefitSnapshot, type ReviewResult } from "../src/server/review/contracts.ts";
import {
  candidateContent, candidateRow, createReviewMemoryStore, REVIEW_NOW, SERVICE_ID, reviewValues,
} from "./support/review-memory-store.ts";

// Public synthetic records only. Decoder shape checks are not caller authority,
// request binding, pagination freshness, durable storage or a connected screen.
function internalBenefit(id = "synthetic-benefit-01"): ReviewedBenefitSnapshot {
  const values = reviewValues({ remainingAmount: 0, expiresAt: "2028-02-29",
    observedAt: "2026-09-27T12:34:56.123456789+09:00" });
  return { schema: REVIEW_SCHEMA, dataGeneration: 1, benefitId: id, benefitRevision: 1, outcome: "saved",
    content: { schema: REVIEW_SCHEMA, serviceId: SERVICE_ID, serviceNameAtReview: "Synthetic Studio",
      candidateId: "synthetic-private-candidate", candidateRevision: 1, values,
      valueOrigins: { name: "email-extracted", kind: "email-extracted", unit: "email-extracted",
        grantedAmount: "email-extracted", remainingAmount: "user-corrected", trialDaysStated: "email-extracted",
        remainingDaysStated: "email-extracted", expiresAt: "user-corrected", observedAt: "user-corrected" },
      source: candidateContent(), reviewedAt: new Date(REVIEW_NOW).toISOString(),
      reviewStatus: "accepted-by-user", accountProof: "not-established", currentBalanceProof: "not-established" } };
}
function internalPage(count = 1): ReviewedBenefitPage {
  return { schema: REVIEW_SCHEMA, dataGeneration: 1, benefitCollectionRevision: 3,
    benefits: Array.from({ length: count }, (_, index) => internalBenefit(`synthetic-benefit-${String(index).padStart(3, "0")}`)),
    nextCursor: null };
}
interface MutablePage {
  schema: string;
  dataGeneration: number;
  benefitCollectionRevision: number;
  benefits: unknown[];
  nextCursor: unknown;
}
function page(count = 1): MutablePage {
  const source = internalPage(count);
  return { schema: REVIEWED_BENEFIT_PAGE_SCHEMA, dataGeneration: source.dataGeneration,
    benefitCollectionRevision: source.benefitCollectionRevision,
    benefits: source.benefits.map(projectReviewedBenefit), nextCursor: null };
}
function cursor(afterId = "synthetic-benefit-000") {
  return { afterId, benefitCollectionRevision: 3, dataGeneration: 1 };
}
function success<T>(result: ReviewResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}
function frozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}
async function setup() {
  const store = createReviewMemoryStore();
  const service = createReviewService(store.dependencies);
  const saved = [];
  for (let index = 0; index < 2; index++) {
    const id = `synthetic-page-candidate-${index}`;
    store.rows.candidates.set(id, candidateRow({ id }));
    const preview = success(await service.preview({ candidateId: id, candidateRevision: 1,
      serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues({ remainingAmount: index === 0 ? null : 0,
        expiresAt: "2028-02-29" }) }));
    saved.push(success(await service.confirm({ previewId: preview.id,
      operationId: `synthetic-page-confirm-${index}`, decision: "confirm" })));
  }
  return { store, service, saved };
}

test("actual synthetic confirm/list/projection roundtrip yields bounded ordered minimal pages", async () => {
  const f = await setup();
  const before = f.store.snapshot();
  const first = projectReviewedBenefitPage(success(await f.service.list({ cursor: null, limit: 1 })));
  assert.equal(first.benefits.length, 1);
  assert.equal(first.benefitCollectionRevision, 3);
  assert.equal(first.benefits[0]!.benefitId, f.saved[0]!.benefitId);
  assert.equal(first.benefits[0]!.content.values.remainingAmount, null);
  assert.ok(first.nextCursor);
  const second = projectReviewedBenefitPage(success(await f.service.list({ cursor: first.nextCursor, limit: 1 })));
  assert.equal(second.benefits.length, 1);
  assert.equal(second.benefits[0]!.benefitId, f.saved[1]!.benefitId);
  assert.equal(second.benefits[0]!.content.values.remainingAmount, 0);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(decodeReviewedBenefitPage(JSON.parse(JSON.stringify(first))), first);
  assert.deepEqual(f.store.snapshot(), before);
  frozen(first); frozen(second);
});

test("actual list omits deleted rows without changing their get tombstone", async () => {
  const f = await setup();
  const saved = f.saved[0]!;
  success(await f.service.remove({ benefitId: saved.benefitId, expectedRevision: saved.benefitRevision,
    operationId: "synthetic-page-delete", decision: "delete" }));
  const result = projectReviewedBenefitPage(success(await f.service.list({ cursor: null, limit: 50 })));
  assert.equal(result.benefitCollectionRevision, 4);
  assert.deepEqual(result.benefits.map((row) => row.benefitId), [f.saved[1]!.benefitId]);
  assert.equal(success(await f.service.get({ benefitId: saved.benefitId })).outcome, "deleted");
});

test("actual empty list projects an empty terminal observation", async () => {
  const store = createReviewMemoryStore();
  const output = projectReviewedBenefitPage(success(await createReviewService(store.dependencies).list({ cursor: null, limit: 50 })));
  assert.equal(output.benefitCollectionRevision, 1);
  assert.deepEqual(output.benefits, []);
  assert.equal(output.nextCursor, null);
  frozen(output);
});

test("projection preserves null, measured zero, date-only and explicit nanosecond offset strings", () => {
  const result = projectReviewedBenefitPage(internalPage());
  const value = result.benefits[0]!.content;
  assert.equal(value.values.remainingAmount, 0);
  assert.equal(value.values.trialDaysStated, null);
  assert.equal(value.values.expiresAt, "2028-02-29");
  assert.equal(value.values.observedAt, "2026-09-27T12:34:56.123456789+09:00");
  assert.equal(value.sourceObservedAt, null);
  assert.equal(value.valueOrigins.observedAt, "user-corrected");
  assert.equal(value.accountProof, "not-established");
  assert.equal(value.currentBalanceProof, "not-established");
  assert.equal(value.reviewStatus, "accepted-by-user");
  assert.ok(value.reviewReasons.includes("OBSERVATION_DATE_UNKNOWN"));
});

test("projection removes private source and candidate bindings from every row", () => {
  const source = internalPage(2);
  const result = projectReviewedBenefitPage(source);
  const serialized = JSON.stringify(result);
  for (const key of ["ownerId", "sessionId", "operationId", "replayed", "candidateId", "candidateRevision",
    "mailboxBindingId", "analysisOperationId", "candidateIndex", "source", "body", "quote", "deletedAt"]) {
    assert.equal(serialized.includes(`"${key}"`), false, key);
  }
  for (const row of source.benefits) {
    assert.equal(serialized.includes(row.content!.candidateId), false);
    assert.equal(serialized.includes(row.content!.source.mailboxBindingId), false);
    assert.equal(serialized.includes(row.content!.source.analysisOperationId), false);
  }
  assert.deepEqual(Object.keys(result).sort(), ["schema", "dataGeneration", "benefitCollectionRevision", "benefits", "nextCursor"].sort());
});

test("decoder detaches and deeply freezes exact page, rows and cursor", () => {
  const input = page(); input.nextCursor = cursor();
  const output = decodeReviewedBenefitPage(input)!;
  assert.ok(output); frozen(output);
  assert.notEqual(output.benefits, input.benefits);
  assert.notEqual(output.benefits[0], input.benefits[0]);
  assert.notEqual(output.nextCursor, input.nextCursor);
  input.benefits.length = 0;
  (input.nextCursor as ReturnType<typeof cursor>).afterId = "changed";
  assert.equal(output.benefits.length, 1);
  assert.equal(output.nextCursor!.afterId, "synthetic-benefit-000");
});

test("decoder accepts plain, null-prototype and frozen own-data page and cursor records", () => {
  for (const prototype of [Object.prototype, null]) {
    const input = Object.assign(Object.create(prototype), page());
    input.nextCursor = Object.assign(Object.create(prototype), cursor());
    Object.freeze(input.nextCursor); Object.freeze(input.benefits); Object.freeze(input);
    assert.ok(decodeReviewedBenefitPage(input));
  }
});

test("decoder accepts exactly fifty ordered rows and rejects fifty-one", () => {
  assert.equal(MAX_REVIEWED_BENEFIT_PAGE_ROWS, 50);
  assert.equal(decodeReviewedBenefitPage(page(50))!.benefits.length, 50);
  assert.equal(decodeReviewedBenefitPage(page(51)), null);
});

test("overlarge arrays are rejected before descriptor enumeration or row access", () => {
  let enumerations = 0, rowReads = 0;
  const rows = new Array(51);
  Object.defineProperty(rows, "0", { enumerable: true, get: () => { rowReads++; return null; } });
  const trapped = new Proxy(rows, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); } });
  const input = page(); input.benefits = trapped;
  assert.equal(decodeReviewedBenefitPage(input), null);
  assert.throws(() => projectReviewedBenefitPage({ ...internalPage(), benefits: trapped }), /^Error: REVIEW_PAGE_PRESENTATION_INVALID$/);
  assert.equal(enumerations, 0); assert.equal(rowReads, 0);
});

for (const [name, mutate] of [
  ["foreign schema", (value: MutablePage) => { value.schema = REVIEW_SCHEMA; }],
  ["page generation mismatch", (value: MutablePage) => { value.dataGeneration = 2; }],
  ["duplicate IDs", (value: MutablePage) => { value.benefits.push(value.benefits[0]); }],
  ["descending IDs", (value: MutablePage) => { value.benefits = page(2).benefits.reverse(); }],
  ["deleted row", (value: MutablePage) => { value.benefits[0] = { ...(value.benefits[0] as object), outcome: "deleted", content: null }; }],
  ["extra row field", (value: MutablePage) => { value.benefits[0] = { ...(value.benefits[0] as object), ownerId: "synthetic-private" }; }],
  ["non-ASCII ID", (value: MutablePage) => { value.benefits[0] = { ...(value.benefits[0] as object), benefitId: "혜택" }; }],
  ["newline ID", (value: MutablePage) => { value.benefits[0] = { ...(value.benefits[0] as object), benefitId: "synthetic\n" }; }],
  ["missing cursor", (value: MutablePage) => { Reflect.deleteProperty(value, "nextCursor"); }],
  ["undefined cursor", (value: MutablePage) => { value.nextCursor = undefined; }],
  ["cursor not last row", (value: MutablePage) => { value.nextCursor = cursor("synthetic-other"); }],
  ["cursor wrong generation", (value: MutablePage) => { value.nextCursor = { ...cursor(), dataGeneration: 2 }; }],
  ["cursor wrong collection revision", (value: MutablePage) => { value.nextCursor = { ...cursor(), benefitCollectionRevision: 2 }; }],
  ["cursor extra field", (value: MutablePage) => { value.nextCursor = { ...cursor(), ownerId: "synthetic-private" }; }],
  ["cursor with empty page", (value: MutablePage) => { value.benefits = []; value.nextCursor = cursor(); }],
] as const) test(`decoder rejects ${name}`, () => {
  const input = page(); mutate(input);
  assert.equal(decodeReviewedBenefitPage(input), null);
});

for (const value of [0, -0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
  test(`page/cursor revisions reject ${String(value)} ${Object.is(value, -0) ? "negative-zero" : ""}`, () => {
    for (const field of ["dataGeneration", "benefitCollectionRevision"] as const) {
      const input = page(); Object.defineProperty(input, field, { value, enumerable: true });
      assert.equal(decodeReviewedBenefitPage(input), null);
      const inputCursor = page(); inputCursor.nextCursor = { ...cursor(), [field]: value };
      assert.equal(decodeReviewedBenefitPage(inputCursor), null);
    }
  });
}

test("strict ASCII ID ordering is code-unit ordering rather than locale sorting", () => {
  const source = internalPage();
  const output = projectReviewedBenefitPage({ ...source,
    benefits: ["A-1", "Z-1", "a-1", "z-1"].map(internalBenefit),
    nextCursor: { afterId: "z-1", dataGeneration: 1, benefitCollectionRevision: 3 } });
  assert.deepEqual(output.benefits.map((row) => row.benefitId), ["A-1", "Z-1", "a-1", "z-1"]);
});

test("top-level and cursor accessors are rejected without invocation", () => {
  let calls = 0;
  for (const field of ["schema", "dataGeneration", "benefitCollectionRevision", "benefits", "nextCursor"]) {
    const input = page();
    Object.defineProperty(input, field, { enumerable: true, get: () => { calls++; throw new Error("private"); } });
    assert.equal(decodeReviewedBenefitPage(input), null);
  }
  for (const field of ["afterId", "dataGeneration", "benefitCollectionRevision"]) {
    const nextCursor = cursor();
    Object.defineProperty(nextCursor, field, { enumerable: true, get: () => { calls++; throw new Error("private"); } });
    assert.equal(decodeReviewedBenefitPage({ ...page(), nextCursor }), null);
  }
  assert.equal(calls, 0);
});

test("record extras, symbols, hidden fields, inherited records and serialization hooks are rejected", () => {
  let hooks = 0;
  const malformed: unknown[] = [];
  malformed.push(Object.assign(Object.create({ inherited: true }), page()));
  malformed.push({ ...page(), toJSON: () => { hooks++; return page(); } });
  for (const key of ["extra", Symbol("private")]) {
    const input = page(); Object.defineProperty(input, key, { value: true, enumerable: false }); malformed.push(input);
  }
  const hidden = page(); Object.defineProperty(hidden, "schema", { value: hidden.schema, enumerable: false }); malformed.push(hidden);
  for (const input of malformed) assert.equal(decodeReviewedBenefitPage(input), null);
  assert.equal(hooks, 0);
});

test("sparse, hidden, getter, inherited and extra-property arrays are rejected without getters", () => {
  let calls = 0;
  const malformed: unknown[] = [new Array(1), Object.assign(Object.create(Array.prototype), { length: 1 })];
  const accessor = [null]; Object.defineProperty(accessor, "0", { enumerable: true, get: () => { calls++; return null; } });
  malformed.push(accessor);
  const hidden = [...page().benefits]; Object.defineProperty(hidden, "0", { value: hidden[0], enumerable: false }); malformed.push(hidden);
  const inherited = [...page().benefits]; Object.setPrototypeOf(inherited, null); malformed.push(inherited);
  for (const key of ["extra", Symbol("extra")]) {
    const value = [...page().benefits]; Object.defineProperty(value, key, { value: true }); malformed.push(value);
  }
  for (const benefits of malformed) assert.equal(decodeReviewedBenefitPage({ ...page(), benefits }), null);
  assert.equal(calls, 0);
});

test("reflection failures become null without exposing adapter exceptions", () => {
  for (const traps of [
    { getPrototypeOf() { throw new Error("synthetic-private-reflection"); } },
    { ownKeys() { throw new Error("synthetic-private-reflection"); } },
    { getOwnPropertyDescriptor() { throw new Error("synthetic-private-reflection"); } },
  ]) assert.equal(decodeReviewedBenefitPage(new Proxy(page(), traps)), null);
});

test("projection rejects invalid internal shapes with one fixed error", () => {
  const source = internalPage();
  for (const invalid of [
    { ...source, schema: "invalid" },
    { ...source, benefits: new Array(1) },
    { ...source, benefits: [null] },
    { ...source, benefits: [{ ...source.benefits[0], outcome: "deleted", content: null }] },
    { ...source, benefits: [{ ...source.benefits[0], dataGeneration: 2 }] },
    { ...source, nextCursor: { ...cursor(), afterId: "wrong" } },
    { ...source, benefits: [source.benefits[0], source.benefits[0]] },
  ]) assert.throws(() => projectReviewedBenefitPage(invalid as ReviewedBenefitPage), /^Error: REVIEW_PAGE_PRESENTATION_INVALID$/);
});

test("decoder preserves date strings without inventing request binding or completeness claims", () => {
  const input = page(); input.nextCursor = cursor();
  const output = decodeReviewedBenefitPage(input)!;
  assert.ok(output);
  assert.equal(Object.hasOwn(output, "requestId"), false);
  assert.equal(Object.hasOwn(output, "viewScope"), false);
  assert.equal(Object.hasOwn(output, "complete"), false);
  assert.equal(Object.hasOwn(output, "accountProof"), false);
  assert.equal(output.benefits[0]!.content.values.expiresAt, "2028-02-29");
});
