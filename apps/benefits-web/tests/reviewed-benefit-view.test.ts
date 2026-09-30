import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createReviewedBenefitViewState, decodeReviewedBenefitView, MAX_REVIEWED_BENEFIT_ENTRIES,
  reduceReviewedBenefitView, REVIEWED_BENEFIT_VIEW_SCHEMA,
  type ReviewedBenefitView, type ReviewedBenefitViewState,
} from "../src/domain/reviewed-benefit-view.ts";
import { projectReviewReceipt } from "../src/server/review/presentation.ts";
import { REVIEW_SCHEMA, type BenefitContent, type ReviewReceipt, type ReviewValues } from "../src/server/review/contracts.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import { CANDIDATE_ID, REVIEW_NOW, SERVICE_ID, candidateContent, createReviewMemoryStore, reviewValues } from "./support/review-memory-store.ts";

// Synthetic DTO/reducer checks only. No browser, authenticated route, provider,
// persistence, active account, real-time balance or aggregation is implemented.
const INSTANT = new Date(REVIEW_NOW).toISOString();
function receipt(patch: Partial<ReviewValues> = {}, sourceObservedAt: string | null = null): ReviewReceipt {
  const values = reviewValues(patch);
  const source = candidateContent({ values: reviewValues({ observedAt: sourceObservedAt }), reviewReasons: [
    "USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED", "RECEIVED_DATE_UNKNOWN",
    ...(sourceObservedAt === null ? ["OBSERVATION_DATE_UNKNOWN" as const] : []), "PARTIAL_MAIL_TEXT",
  ] });
  const keys = Object.keys(values) as Array<keyof ReviewValues>;
  const valueOrigins = Object.fromEntries(keys.map((key) => [key,
    values[key] === source.values[key] ? "email-extracted" : "user-corrected",
  ])) as BenefitContent["valueOrigins"];
  return { schema: REVIEW_SCHEMA, dataGeneration: 1, operationId: "synthetic-private-operation",
    outcome: "saved", benefitId: "synthetic-benefit", benefitRevision: 1, replayed: false,
    content: { schema: REVIEW_SCHEMA, serviceId: SERVICE_ID, serviceNameAtReview: "Synthetic reviewed service",
      candidateId: "synthetic-private-candidate", candidateRevision: 1, values, valueOrigins, source,
      reviewedAt: INSTANT, reviewStatus: "accepted-by-user", accountProof: "not-established", currentBalanceProof: "not-established" } };
}
function saved(revision = 1, patch: Partial<ReviewValues> = {}) {
  const projected = projectReviewReceipt({ ...receipt(patch), benefitRevision: revision });
  assert.ok(projected.outcome === "saved");
  return projected;
}
function deleted(revision = 2, benefitId = "synthetic-benefit", dataGeneration = 1): ReviewedBenefitView {
  return { schema: REVIEWED_BENEFIT_VIEW_SCHEMA, dataGeneration, benefitId, benefitRevision: revision, outcome: "deleted", content: null };
}
function response(state: ReviewedBenefitViewState, payload: unknown, capturedScope = state.viewScope) {
  return reduceReviewedBenefitView(state, { type: "response", capturedScope, payload });
}
function frozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozenTree(child);
}

test("server receipt projection exposes only reviewed UI fields, not private source bindings", () => {
  const original = receipt({ remainingAmount: 0 });
  const projected = projectReviewReceipt(original);
  assert.ok(projected.outcome === "saved");
  assert.deepEqual(Object.keys(projected).sort(), ["schema", "dataGeneration", "benefitId", "benefitRevision", "outcome", "content"].sort());
  assert.deepEqual(Object.keys(projected.content).sort(), ["serviceId", "serviceNameAtReview", "values", "valueOrigins", "receivedAt",
    "extractedAt", "sourceObservedAt", "reviewedAt", "reviewReasons", "reviewStatus", "accountProof", "currentBalanceProof"].sort());
  assert.equal(projected.content.values.remainingAmount, 0);
  assert.equal(projected.content.values.observedAt, null);
  assert.equal(projected.content.sourceObservedAt, null);
  assert.equal(projected.content.receivedAt, null);
  assert.equal(projected.content.extractedAt, INSTANT);
  assert.equal(projected.content.reviewStatus, "accepted-by-user");
  assert.equal(projected.content.accountProof, "not-established");
  assert.equal(projected.content.currentBalanceProof, "not-established");
  const serialized = JSON.stringify(projected);
  for (const key of ["ownerId", "sessionId", "sessionRevision", "grantId", "mailboxBindingId", "analysisOperationId", "operationId",
    "candidateId", "candidateRevision", "candidateIndex", "source", "quote", "body", "fingerprint", "replayed", "observed_at"]) {
    assert.ok(!serialized.includes(`"${key}"`), key);
  }
  for (const privateValue of [original.operationId, original.content!.candidateId,
    original.content!.source.analysisOperationId, original.content!.source.mailboxBindingId]) assert.ok(!serialized.includes(privateValue));
  frozenTree(projected);
  assert.notEqual(projected.content.values, original.content!.values);
  assert.notEqual(projected.content.valueOrigins, original.content!.valueOrigins);
  assert.notEqual(projected.content.reviewReasons, original.content!.source.reviewReasons);
});

test("projection preserves original and corrected observation precision independently without inventing dates", () => {
  const corrected = projectReviewReceipt(receipt({ observedAt: "2026-09-27" }));
  assert.ok(corrected.outcome === "saved");
  assert.equal(corrected.content.sourceObservedAt, null);
  assert.equal(corrected.content.values.observedAt, "2026-09-27");
  assert.equal(corrected.content.valueOrigins.observedAt, "user-corrected");
  assert.ok(corrected.content.reviewReasons.includes("OBSERVATION_DATE_UNKNOWN"));
  assert.ok(corrected.content.reviewReasons.includes("PARTIAL_MAIL_TEXT"));
  const precise = "2026-09-27T12:34:56.123456789+09:00";
  const observed = projectReviewReceipt(receipt({ observedAt: precise, expiresAt: "2028-02-29" }, "2026-09-27"));
  assert.ok(observed.outcome === "saved");
  assert.equal(observed.content.sourceObservedAt, "2026-09-27");
  assert.equal(observed.content.values.observedAt, precise);
  assert.equal(observed.content.values.expiresAt, "2028-02-29");
  assert.equal(observed.content.valueOrigins.observedAt, "user-corrected");
});

test("deleted receipts project a minimal content-null tombstone and inconsistent trusted input fails generically", () => {
  assert.deepEqual(projectReviewReceipt({ ...receipt(), outcome: "deleted", benefitRevision: 2, content: null }), deleted());
  for (const invalid of [{ ...receipt(), content: null }, { ...receipt(), outcome: "deleted" },
    { ...receipt(), schema: "old" }, { ...receipt(), dataGeneration: 0 }]) {
    assert.throws(() => projectReviewReceipt(invalid as unknown as ReviewReceipt), { message: "REVIEW_PRESENTATION_INVALID" });
  }
});

test("a genuine synthetic service receipt projects without casting to the legacy required-observation record", async () => {
  const store = createReviewMemoryStore();
  const service = createReviewService(store.dependencies);
  const preview = await service.preview({ candidateId: CANDIDATE_ID, candidateRevision: 1,
    serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues({ remainingAmount: 0 }) });
  assert.ok(preview.ok);
  const result = await service.confirm({ previewId: preview.value.id, operationId: "synthetic-projection-confirm", decision: "confirm" });
  assert.ok(result.ok);
  const projected = projectReviewReceipt(result.value);
  assert.ok(projected.outcome === "saved");
  assert.equal(projected.content.values.observedAt, null);
  assert.equal(projected.content.sourceObservedAt, null);
  assert.equal(projected.content.valueOrigins.remainingAmount, "user-corrected");
  assert.deepEqual(decodeReviewedBenefitView(JSON.parse(JSON.stringify(projected)) as unknown), projected);
});

for (const location of ["root", "content", "values", "valueOrigins"] as const) {
  test(`decoder requires exact own enumerable data properties at ${location} without executing getters`, () => {
    const attempt = (mutate: (object: Record<string, unknown>) => void) => {
      const input = structuredClone(saved());
      const object = (location === "root" ? input : location === "content" ? input.content : input.content[location]) as unknown as Record<string, unknown>;
      mutate(object);
      assert.equal(decodeReviewedBenefitView(input), null);
    };
    const original = saved();
    const object = location === "root" ? original : location === "content" ? original.content : original.content[location];
    for (const key of Object.keys(object)) {
      attempt((raw) => { delete raw[key]; });
      attempt((raw) => { raw[key] = undefined; });
      attempt((raw) => { Object.defineProperty(raw, key, { enumerable: false, value: raw[key] }); });
      let getterCalls = 0;
      attempt((raw) => { Object.defineProperty(raw, key, { enumerable: true, get() { getterCalls++; throw new Error("SYNTHETIC_GETTER"); } }); });
      assert.equal(getterCalls, 0);
    }
    attempt((raw) => { raw.ownerId = "synthetic-private-owner"; });
    attempt((raw) => { Object.defineProperty(raw, Symbol("extra"), { value: true }); });
    attempt((raw) => { Object.defineProperty(raw, "extra", { value: true, enumerable: false }); });
    attempt((raw) => { Object.setPrototypeOf(raw, { inherited: true }); });
  });
}

test("decoder copies and freezes every container while leaving input ownership unchanged", () => {
  const input = structuredClone(saved());
  const parsed = decodeReviewedBenefitView(input);
  assert.ok(parsed?.outcome === "saved");
  frozenTree(parsed);
  Object.assign(input.content.values, { name: "Synthetic later mutation" });
  assert.notEqual(parsed.content.values.name, input.content.values.name);
  assert.notEqual(parsed.content.reviewReasons, input.content.reviewReasons);
  assert.ok(!Object.isFrozen(input));
  for (const invalid of [undefined, null, [], "synthetic", true, Object.create(saved()), { ...saved(), schema: "old" },
    { ...saved(), outcome: "deleted" }, { ...saved(), content: null }, { ...deleted(), content: saved().content }]) {
    assert.equal(decodeReviewedBenefitView(invalid), null);
  }
});

test("decoder bounds labels, scalar IDs, amounts, days and positive safe revisions without coercion", () => {
  for (const name of ["", " synthetic", "synthetic\n", "synthetic\u200f", "\ud800", "x".repeat(161)]) {
    const input = structuredClone(saved());
    Object.assign(input.content.values, { name });
    assert.equal(decodeReviewedBenefitView(input), null);
  }
  for (const name of ["합성 😀 👩‍💻", "x".repeat(160)]) assert.ok(decodeReviewedBenefitView(saved(1, { name })));
  for (const field of ["dataGeneration", "benefitRevision"]) {
    for (const value of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      assert.equal(decodeReviewedBenefitView({ ...saved(), [field]: value }), null);
    }
  }
  for (const benefitId of ["", "synthetic\n", "synthetic\r\n", " synthetic", "x".repeat(129)]) {
    assert.equal(decodeReviewedBenefitView({ ...saved(), benefitId }), null);
  }
  for (const field of ["grantedAmount", "remainingAmount", "trialDaysStated", "remainingDaysStated"]) {
    for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      const input = structuredClone(saved());
      Object.assign(input.content.values, { [field]: value });
      assert.equal(decodeReviewedBenefitView(input), null);
    }
  }
  for (const patch of [{ trialDaysStated: 0.5 }, { remainingDaysStated: 0.5 }, { unit: "x".repeat(41) },
    { unit: null }, { kind: "membership" }, { kind: "receipt" }, { kind: "expiration" }]) {
    const input = structuredClone(saved());
    Object.assign(input.content.values, patch);
    assert.equal(decodeReviewedBenefitView(input), null);
  }
  assert.ok(decodeReviewedBenefitView(saved(Number.MAX_SAFE_INTEGER, { grantedAmount: Number.MAX_SAFE_INTEGER, remainingAmount: 0.25 })));
});

test("decoder preserves null and stated precision but rejects impossible calendars and noncanonical provenance instants", () => {
  for (const date of ["2025-02-29", "0000-01-01", "2026-13-01", "2026-01-01\n", "2026-01-01T24:00:00Z",
    "2026-01-01T00:00:00", "2026-01-01T00:00:00-00:00", "2026-01-01T00:00:00+14:01"]) {
    const input = structuredClone(saved());
    Object.assign(input.content.values, { expiresAt: date });
    assert.equal(decodeReviewedBenefitView(input), null);
  }
  for (const field of ["receivedAt", "extractedAt", "reviewedAt"]) {
    for (const date of ["2026-09-28", "2026-09-28T00:00:00Z", "2026-09-28T00:00:00.000+00:00", INSTANT + "\n",
      "2026-02-30T00:00:00.000Z", "2026-13-01T00:00:00.000Z"]) {
      const input = structuredClone(saved());
      Object.assign(input.content, { [field]: date });
      assert.equal(decodeReviewedBenefitView(input), null);
    }
  }
  for (const field of ["extractedAt", "reviewedAt"]) {
    const input = structuredClone(saved());
    Object.assign(input.content, { [field]: null });
    assert.equal(decodeReviewedBenefitView(input), null);
  }
  assert.ok(decodeReviewedBenefitView(saved(1, { unit: null, grantedAmount: null, remainingAmount: null,
    expiresAt: null, observedAt: null, trialDaysStated: null, remainingDaysStated: null })));
});

test("proof labels and value origins remain explicit and original observation uncertainty cannot disappear", () => {
  for (const patch of [{ accountProof: "active" }, { currentBalanceProof: "verified" }, { reviewStatus: "confirmed-live" },
    { reviewReasons: [] }, { reviewReasons: ["USER_REVIEW_REQUIRED"] }, { reviewReasons: [...saved().content.reviewReasons, "UNKNOWN"] },
    { reviewReasons: [...saved().content.reviewReasons, "USER_REVIEW_REQUIRED"] }]) {
    const input = structuredClone(saved());
    Object.assign(input.content, patch);
    assert.equal(decodeReviewedBenefitView(input), null);
  }
  for (const reason of saved().content.reviewReasons.filter((entry) => entry !== "PARTIAL_MAIL_TEXT")) {
    const input = structuredClone(saved());
    Object.assign(input.content, { reviewReasons: input.content.reviewReasons.filter((entry) => entry !== reason) });
    assert.equal(decodeReviewedBenefitView(input), null);
  }
  const inconsistent = structuredClone(saved());
  Object.assign(inconsistent.content.valueOrigins, { observedAt: "user-corrected" });
  assert.equal(decodeReviewedBenefitView(inconsistent), null);
  let getterCalls = 0;
  const accessor = structuredClone(saved());
  Object.defineProperty(accessor.content.reviewReasons, "0", { enumerable: true, get() { getterCalls++; return "USER_REVIEW_REQUIRED"; } });
  assert.equal(decodeReviewedBenefitView(accessor), null);
  assert.equal(getterCalls, 0);
});

test("state scopes are explicit opaque namespaces and malformed initialization never supplies fallback identity", () => {
  for (const scope of ["", "synthetic\n", "a".repeat(129)]) {
    assert.throws(() => createReviewedBenefitViewState(scope, 1), { message: "REVIEWED_BENEFIT_VIEW_INVALID" });
  }
  for (const generation of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createReviewedBenefitViewState("view-A", generation), { message: "REVIEWED_BENEFIT_VIEW_INVALID" });
  }
  frozenTree(createReviewedBenefitViewState("view-A", 1));
});

test("scope is checked before payload inspection and a late account-A response cannot populate account-B generation one", () => {
  const a = response(createReviewedBenefitViewState("view-A", 1), saved());
  const capturedAtRequest = a.viewScope;
  const b = reduceReviewedBenefitView(a, { type: "reset", viewScope: "view-B", dataGeneration: 1 });
  assert.equal(b.entries.length, 0);
  assert.equal(response(b, saved(2), capturedAtRequest), b);
  let payloadReads = 0;
  const poison = new Proxy({}, { ownKeys() { payloadReads++; throw new Error("SYNTHETIC_WRONG_SCOPE_PAYLOAD"); } });
  assert.equal(response(b, poison, capturedAtRequest), b);
  assert.equal(payloadReads, 0);
  assert.equal(response(b, saved()).entries.length, 1);
});

test("generation changes never happen through responses or same-scope resets", () => {
  const initial = response(createReviewedBenefitViewState("view-A", 1), saved());
  assert.equal(response(initial, { ...saved(2), dataGeneration: 2 }), initial);
  assert.equal(reduceReviewedBenefitView(initial, { type: "reset", viewScope: "view-A", dataGeneration: 2 }), initial);
  assert.equal(reduceReviewedBenefitView(initial, { type: "reset", viewScope: "view-A", dataGeneration: 1 }), initial);
  const reset = reduceReviewedBenefitView(initial, { type: "reset", viewScope: "view-A-new", dataGeneration: 2 });
  assert.equal(reset.dataGeneration, 2);
  assert.equal(reset.entries.length, 0);
  assert.equal(response(reset, saved()), reset);
  assert.equal(response(reset, { ...saved(), dataGeneration: 2 }, "view-A"), reset);
  assert.equal(response(reset, { ...saved(), dataGeneration: 2 }).entries.length, 1);
});

test("lower or equal revisions never overwrite state, including contradictory equal-revision deletion", () => {
  const current = response(createReviewedBenefitViewState("view-A", 1), saved(3, { name: "Synthetic current value" }));
  for (const input of [saved(1), saved(2), saved(3), deleted(3), structuredClone(current.entries[0])]) {
    assert.equal(response(current, input), current);
  }
  const next = response(current, saved(4, { name: "Synthetic next value" }));
  assert.notEqual(next, current);
  assert.equal(next.entries[0]!.benefitRevision, 4);
  assert.equal(current.entries[0]!.benefitRevision, 3);
  frozenTree(next);
});

test("deleted tombstones forbid resurrection even by later saved revisions and equal conflicts", () => {
  const live = response(createReviewedBenefitViewState("view-A", 1), saved());
  const tombstone = response(live, deleted(2));
  assert.equal(tombstone.entries[0]!.content, null);
  for (const revision of [1, 2, 3, Number.MAX_SAFE_INTEGER]) assert.equal(response(tombstone, saved(revision)), tombstone);
  assert.equal(response(tombstone, deleted(2)), tombstone);
  const advanced = response(tombstone, deleted(3));
  assert.equal(advanced.entries[0]!.outcome, "deleted");
  assert.equal(advanced.entries[0]!.benefitRevision, 3);
  assert.ok(!JSON.stringify(advanced).includes("Synthetic reviewed service"));
  assert.equal(live.entries[0]!.outcome, "saved");
});

test("invalid events or revision overflow preserve the exact previous state", () => {
  const state = response(createReviewedBenefitViewState("view-A", 1), saved());
  for (const event of [undefined, null, [], {}, { type: "other" },
    { type: "response", capturedScope: "view-A", payload: saved(), extra: true },
    { type: "response", capturedScope: "view-A" }, { type: "reset", viewScope: "view-B", dataGeneration: 0 },
    { type: "reset", viewScope: "view-B", dataGeneration: 1, extra: true }]) assert.equal(reduceReviewedBenefitView(state, event), state);
  assert.equal(response(state, { ...saved(), benefitRevision: Number.MAX_SAFE_INTEGER + 1 }), state);
  let getterCalls = 0;
  const accessor = { capturedScope: "view-A", payload: saved(), get type() { getterCalls++; return "response"; } };
  assert.equal(reduceReviewedBenefitView(state, accessor), state);
  assert.equal(getterCalls, 0);
});

test("the 1000-entry ceiling includes tombstones and never evicts a stale-response fence", () => {
  let state = createReviewedBenefitViewState("view-A", 1);
  for (let index = 0; index < MAX_REVIEWED_BENEFIT_ENTRIES; index++) state = response(state, deleted(2, `synthetic-${index}`));
  assert.equal(state.entries.length, 1000);
  assert.equal(response(state, deleted(2, "synthetic-overflow")), state);
  assert.equal(response(state, { ...saved(), benefitId: "synthetic-new-live" }), state);
  assert.equal(response(state, { ...saved(3), benefitId: "synthetic-0" }), state);
  const updated = response(state, deleted(3, "synthetic-0"));
  assert.equal(updated.entries.length, 1000);
  assert.equal(updated.entries[0]!.benefitRevision, 3);
  assert.equal(state.entries[0]!.benefitRevision, 2);
  frozenTree(updated);
});

test("the browser-safe domain has no imports or server runtime dependency", () => {
  const source = readFileSync(new URL("../src/domain/reviewed-benefit-view.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\b(?:require|fetch)\s*\(/);
});
