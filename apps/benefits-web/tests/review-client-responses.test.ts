import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeReviewError, decodeReviewSuccess } from "../src/domain/review-client/responses.ts";
import { createReviewPreviewRequest, createReviewConfirmRequest, createReviewGetRequest,
  createReviewDeleteRequest, createReviewRejectRequest, createReviewListRequest,
  type ReviewRequest } from "../src/domain/review-client/requests.ts";
import { decodeReviewPreviewView } from "../src/domain/review-preview-view.ts";
import { REVIEWED_BENEFIT_PAGE_SCHEMA } from "../src/domain/reviewed-benefit-page.ts";
import { REVIEWED_BENEFIT_VIEW_SCHEMA, type ReviewedBenefitValues, type ReviewedBenefitView }
  from "../src/domain/reviewed-benefit-view.ts";
import { projectReviewPreview } from "../src/server/review/preview-presentation.ts";
import { projectReviewedBenefit, projectReviewReceipt } from "../src/server/review/presentation.ts";
import { projectReviewedBenefitPage } from "../src/server/review/page-presentation.ts";
import { REVIEW_SCHEMA, type ReviewResult } from "../src/server/review/contracts.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import { candidateContent, CANDIDATE_ID, createReviewMemoryStore, REVIEW_NOW,
  reviewValues, SERVICE_ID } from "./support/review-memory-store.ts";

// Synthetic decoded JSON only. No transport byte limit, authentication, source
// authenticity, view lifetime, DB/browser evidence or whole-list freshness.
const PREVIEW_ID = "synthetic-preview", BENEFIT_ID = "synthetic-benefit-001";
const VALUE_KEYS = ["name", "kind", "unit", "grantedAmount", "remainingAmount", "trialDaysStated",
  "remainingDaysStated", "expiresAt", "observedAt"] as const;
function values() {
  return reviewValues({ remainingAmount: 0, expiresAt: "2026-09-28",
    observedAt: "2026-09-27T12:34:56.123456789+09:00" });
}
function previewRequest() { return createReviewPreviewRequest(CANDIDATE_ID, 1, SERVICE_ID, 1, values()); }
function preview() {
  return structuredClone(projectReviewPreview({ dataGeneration: 1, id: PREVIEW_ID, revision: 1,
    expiresAt: REVIEW_NOW + 300000, content: { ...previewRequest().body, serviceName: "Synthetic Studio",
      source: candidateContent() }, accountProof: "not-established", currentBalanceProof: "not-established" }));
}
function saved(id = BENEFIT_ID, revision = 1) {
  const source = candidateContent(), reviewed = values();
  const valueOrigins = Object.fromEntries(VALUE_KEYS.map((key) => [key,
    reviewed[key] === source.values[key] ? "email-extracted" : "user-corrected",
  ])) as Record<keyof ReviewedBenefitValues, "email-extracted" | "user-corrected">;
  const result = projectReviewedBenefit({ schema: REVIEW_SCHEMA, dataGeneration: 1, benefitId: id,
    benefitRevision: revision, outcome: "saved", content: { schema: REVIEW_SCHEMA, serviceId: SERVICE_ID,
      serviceNameAtReview: "Synthetic Studio", candidateId: CANDIDATE_ID, candidateRevision: 1,
      values: reviewed, valueOrigins, source, reviewedAt: new Date(REVIEW_NOW).toISOString(),
      reviewStatus: "accepted-by-user", accountProof: "not-established", currentBalanceProof: "not-established" } });
  assert.ok(result.outcome === "saved"); return structuredClone(result);
}
function deleted(id = BENEFIT_ID, revision = 2): ReviewedBenefitView {
  return { schema: REVIEWED_BENEFIT_VIEW_SCHEMA, dataGeneration: 1, benefitId: id,
    benefitRevision: revision, outcome: "deleted", content: null };
}
function page(count = 2, more = false) {
  const benefits = Array.from({ length: count }, (_, i) => saved(`synthetic-benefit-${String(i + 1).padStart(3, "0")}`));
  return { schema: REVIEWED_BENEFIT_PAGE_SCHEMA, dataGeneration: 1, benefitCollectionRevision: 7,
    benefits, nextCursor: more ? { afterId: benefits[count - 1]!.benefitId, benefitCollectionRevision: 7, dataGeneration: 1 } : null };
}
function envelope(value: unknown) { return { ok: true, value }; }
function decode(value: unknown, request: ReviewRequest, generation = 1, now = REVIEW_NOW) {
  return decodeReviewSuccess(envelope(value), request, generation, now);
}
function frozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value)); for (const child of Object.values(value)) frozen(child);
}
function success<T>(result: ReviewResult<T>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
function cases(): Array<{ request: ReviewRequest; value: unknown; kind: string }> {
  return [
    { request: previewRequest(), value: preview(), kind: "preview" },
    { request: createReviewConfirmRequest(PREVIEW_ID, "synthetic-confirm"), value: saved(), kind: "view" },
    { request: createReviewGetRequest(BENEFIT_ID), value: saved(), kind: "view" },
    { request: createReviewDeleteRequest(BENEFIT_ID, 1, "synthetic-delete"), value: deleted(), kind: "view" },
    { request: createReviewListRequest(2, null), value: page(), kind: "page" },
    { request: createReviewRejectRequest(PREVIEW_ID, 1), value: { previewId: PREVIEW_ID, state: "revoked" }, kind: "rejected" },
  ];
}

test("all six success envelopes yield detached frozen browser outputs with explicit proof/precision", () => {
  for (const item of cases()) {
    const before = structuredClone(item.value), result = decode(item.value, item.request);
    assert.ok(result); assert.equal(result.kind, item.kind); frozen(result);
    assert.deepEqual(item.value, before);
    if (result.kind === "preview") {
      assert.notEqual(result.preview, item.value);
      assert.equal(result.preview.content.values.remainingAmount, 0);
      assert.equal(result.preview.content.sourceObservedAt, null);
      assert.equal(result.preview.content.values.observedAt, values().observedAt);
      assert.equal(result.preview.content.currentBalanceProof, "not-established");
    }
  }
});

for (const [key, changed] of [
  ["name", "Other synthetic benefit"], ["kind", "point"], ["unit", "points"],
  ["grantedAmount", 101], ["remainingAmount", null], ["trialDaysStated", 0],
  ["remainingDaysStated", 0], ["expiresAt", "2026-09-29"], ["observedAt", "2026-09-27"],
] as const) test(`preview must echo requested ${key} exactly, not just a valid DTO`, () => {
  const input = preview(); Object.assign(input.content.values, { [key]: changed });
  assert.ok(decodeReviewPreviewView(input), "semantic mismatch fixture itself is structurally valid");
  assert.equal(decode(input, previewRequest()), null);
});

test("preview binds service ID/revision and captured generation but cannot invent an omitted candidate binding", () => {
  for (const patch of [{ serviceId: "synthetic-other" }, { serviceRevision: 2 }]) {
    const input = preview(); Object.assign(input.content, patch);
    assert.equal(decode(input, previewRequest()), null);
  }
  assert.equal(decode({ ...preview(), dataGeneration: 2 }, previewRequest()), null);
  const samePublicFields = createReviewPreviewRequest("synthetic-other-candidate", 20, SERVICE_ID, 1, values());
  assert.ok(decode(preview(), samePublicFields), "candidate IDs are deliberately absent from the DTO, not verified here");
});

test("preview is checked at the explicit consumer time, with equality expired and no invented maximum TTL", () => {
  const input = preview();
  assert.ok(decode(input, previewRequest(), 1, input.expiresAt - 1));
  assert.equal(decode(input, previewRequest(), 1, input.expiresAt), null);
  assert.equal(decode(input, previewRequest(), 1, input.expiresAt + 1), null);
  assert.ok(decode({ ...input, expiresAt: 253402300799999 }, previewRequest(), 1, 0));
});

test("get binds the benefit ID while preserving current saved and deleted states", () => {
  const request = createReviewGetRequest(BENEFIT_ID);
  assert.ok(decode(saved(), request)); assert.ok(decode(deleted(), request));
  assert.equal(decode(saved("synthetic-other"), request), null);
  assert.equal(decode(deleted("synthetic-other"), request), null);
});

test("delete requires its ID, a tombstone and a strictly newer safe revision including current replay", () => {
  const request = createReviewDeleteRequest(BENEFIT_ID, 4, "synthetic-delete");
  for (const revision of [5, 6, Number.MAX_SAFE_INTEGER]) assert.ok(decode(deleted(BENEFIT_ID, revision), request));
  for (const revision of [1, 4]) assert.equal(decode(deleted(BENEFIT_ID, revision), request), null);
  assert.equal(decode(saved(BENEFIT_ID, 5), request), null);
  assert.equal(decode(deleted("synthetic-other", 5), request), null);
  assert.equal(decode(deleted(BENEFIT_ID, Number.MAX_SAFE_INTEGER),
    createReviewDeleteRequest(BENEFIT_ID, Number.MAX_SAFE_INTEGER, "synthetic-overflow")), null);
});

test("confirm accepts current saved/tombstone replay without pretending the DTO echoes operation or preview identity", () => {
  const command = createReviewConfirmRequest(PREVIEW_ID, "synthetic-confirm");
  for (const item of [saved(), saved("synthetic-current", 7), deleted(), deleted("synthetic-current", 8)]) {
    const result = decode(item, command, 1, 253402300799999);
    assert.ok(result && result.kind === "view"); assert.deepEqual(result.view, item);
    assert.equal(Object.hasOwn(result.view, "operationId"), false); assert.equal(Object.hasOwn(result.view, "previewId"), false);
  }
  assert.equal(decode({ ...deleted(), dataGeneration: 2 }, command), null);
});

test("reject requires exact preview/state and discloses neither extra fields nor an invented generation", () => {
  const request = createReviewRejectRequest(PREVIEW_ID, 1);
  assert.deepEqual(decode({ previewId: PREVIEW_ID, state: "revoked" }, request), { kind: "rejected", previewId: PREVIEW_ID });
  for (const value of [null, { previewId: "synthetic-other", state: "revoked" },
    { previewId: PREVIEW_ID, state: "deleted" }, { previewId: PREVIEW_ID, state: "revoked", dataGeneration: 1 },
    { previewId: PREVIEW_ID, state: "revoked", expectedRevision: 1 }]) assert.equal(decode(value, request), null);
  assert.ok(decode({ previewId: PREVIEW_ID, state: "revoked" }, request, 2),
    "reject acknowledgement has no generation: caller must fence the captured view");
});

test("all DTO-bearing successes reject a mismatched captured generation", () => {
  for (const item of cases().filter((entry) => entry.request.action !== "reject")) assert.equal(decode(item.value, item.request, 2), null);
});

test("list binds limit/full nonterminal page without turning an empty terminal observation into completeness", () => {
  assert.ok(decode(page(2, true), createReviewListRequest(2, null)));
  assert.ok(decode(page(1, false), createReviewListRequest(2, null)));
  assert.ok(decode(page(0, false), createReviewListRequest(2, null)));
  assert.equal(decode(page(2), createReviewListRequest(1, null)), null);
  assert.equal(decode(page(1, true), createReviewListRequest(2, null)), null);
  const result = decode(page(0), createReviewListRequest(50, null));
  assert.ok(result && result.kind === "page"); assert.equal(Object.hasOwn(result.page, "complete"), false);
});

test("list follow-up requires the same collection/generation and strictly later IDs", () => {
  const cursor = { afterId: "synthetic-benefit-000", benefitCollectionRevision: 7, dataGeneration: 1 };
  assert.ok(decode(page(), createReviewListRequest(2, cursor)));
  assert.ok(decode(page(0), createReviewListRequest(2, cursor)));
  for (const patch of [{ benefitCollectionRevision: 6 }, { benefitCollectionRevision: 8 }, { dataGeneration: 2 },
    { afterId: BENEFIT_ID }, { afterId: "synthetic-benefit-999" }]) {
    assert.equal(decode(page(), createReviewListRequest(2, { ...cursor, ...patch })), null);
  }
  assert.equal(decode({ ...page(0), benefitCollectionRevision: 8 }, createReviewListRequest(2, cursor)), null);
});

test("strict row/page decoders still reject private extras, tombstones, duplicate IDs, holes and getters", () => {
  const list = createReviewListRequest(50, null);
  let calls = 0;
  const input = page(); Object.defineProperty(input.benefits, "0", { enumerable: true, get() { calls++; return saved(); } });
  for (const value of [input, { ...page(), benefits: [saved(), saved()] },
    { ...page(), benefits: [deleted()] }, { ...page(), benefits: new Array(2) },
    { ...page(), benefits: [Object.assign(saved(), { ownerId: "synthetic-private" })] }]) assert.equal(decode(value, list), null);
  assert.equal(calls, 0);
  let enumerations = 0;
  const oversized = new Proxy(new Array(51), { ownKeys(target) { enumerations++; return Reflect.ownKeys(target); } });
  assert.equal(decode({ ...page(), benefits: oversized }, list), null); assert.equal(enumerations, 0);
  assert.ok(decode(page(50), list));
});

for (const invalid of [-0, -1, 0.5, NaN, Infinity, 253402300800000, "0", null, undefined]) {
  test(`invalid explicit now ${String(invalid)} never falls back to an ambient clock`, () => {
    for (const item of cases()) assert.equal(decodeReviewSuccess(envelope(item.value), item.request, 1, invalid as number), null);
  });
}
test("invalid generation/time is rejected before reflecting payload or request", () => {
  let reads = 0;
  const hostile = new Proxy({}, { getPrototypeOf() { reads++; throw new Error("synthetic-private"); } });
  for (const generation of [0, -0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(decodeReviewSuccess(hostile, hostile as ReviewRequest, generation, REVIEW_NOW), null);
  }
  assert.equal(decodeReviewSuccess(hostile, hostile as ReviewRequest, 1, -0), null); assert.equal(reads, 0);
});

test("all success envelopes require exact own enumerable data fields without hooks", () => {
  for (const item of cases()) for (const mutation of ["getter", "extra", "missing", "hidden", "symbol", "prototype", "toJSON"]) {
    const body = envelope(item.value); let callbacks = 0;
    if (mutation === "getter") Object.defineProperty(body, "value", { get() { callbacks++; return item.value; }, enumerable: true });
    if (mutation === "extra") Object.assign(body, { ownerId: "synthetic-private" });
    if (mutation === "missing") Reflect.deleteProperty(body, "ok");
    if (mutation === "hidden") Object.defineProperty(body, "ok", { enumerable: false });
    if (mutation === "symbol") Object.assign(body, { [Symbol("extra")]: 1 });
    if (mutation === "prototype") Object.setPrototypeOf(body, { extra: 1 });
    if (mutation === "toJSON") Object.assign(body, { toJSON() { callbacks++; return {}; } });
    assert.equal(decodeReviewSuccess(body, item.request, 1, REVIEW_NOW), null, `${item.request.action}/${mutation}`);
    assert.equal(callbacks, 0);
  }
});

test("plain, null-prototype and frozen exact envelopes are accepted; raw value alone is not an envelope", () => {
  for (const item of cases()) {
    assert.ok(decodeReviewSuccess(Object.freeze(envelope(item.value)), item.request, 1, REVIEW_NOW));
    assert.ok(decodeReviewSuccess(Object.assign(Object.create(null), envelope(item.value)), item.request, 1, REVIEW_NOW));
    assert.equal(decodeReviewSuccess(item.value, item.request, 1, REVIEW_NOW), null);
    for (const ok of [false, "true", 1, null]) assert.equal(decodeReviewSuccess({ ok, value: item.value }, item.request, 1, REVIEW_NOW), null);
  }
});

test("caller request is defensively snapshotted without invoking accessors and before payload reflection", () => {
  let reads = 0;
  const getter = { action: "get", body: { get benefitId() { reads++; return BENEFIT_ID; } } };
  assert.equal(decode(saved(), getter as ReviewRequest), null); assert.equal(reads, 0);
  const request = { action: "get" as const, body: { benefitId: BENEFIT_ID } };
  const payload = new Proxy(envelope(saved()), { getPrototypeOf(target) {
    request.body.benefitId = "synthetic-other"; return Reflect.getPrototypeOf(target);
  } });
  assert.ok(decodeReviewSuccess(payload, request, 1, REVIEW_NOW), "payload trap cannot rewrite the already captured command");
  const invalid = { action: "get", body: { benefitId: BENEFIT_ID, ownerId: "synthetic-private" } };
  assert.equal(decode(saved(), invalid as ReviewRequest), null);
});

test("decoder exceptions fail closed, unknown actions do not dispatch and no ambient Date.now is used", (context) => {
  context.mock.method(Date, "now", () => { throw new Error("synthetic-ambient-time"); });
  assert.ok(decode(preview(), previewRequest()));
  const hostile = new Proxy({}, { ownKeys() { throw new Error("synthetic-private-detail"); } });
  assert.equal(decodeReviewSuccess(hostile, createReviewGetRequest(BENEFIT_ID), 1, REVIEW_NOW), null);
  assert.equal(decode(saved(), { action: "unknown", body: {} } as unknown as ReviewRequest), null);
  assert.equal(decodeReviewError(hostile), null);
});

const ERROR_STATUS = {
  API_NOT_FOUND: 404, API_METHOD_NOT_ALLOWED: 405, API_REQUEST_REJECTED: 403,
  API_MEDIA_TYPE: 415, API_BODY_TOO_LARGE: 413, API_INPUT_INVALID: 400,
  API_AUTH_REQUIRED: 401, API_SESSION_CHANGED: 403, API_RATE_LIMITED: 429,
  API_CONFLICT: 409, API_UNAVAILABLE: 503, API_TIMEOUT: 408, API_ABORTED: 408,
} as const;
for (const [code, status] of Object.entries(ERROR_STATUS)) test(`error ${code} requires its exact HTTP status ${status}`, () => {
  assert.equal(decodeReviewError({ ok: false, code }), code);
  assert.equal(decodeReviewError({ ok: false, code }, status), code);
  for (const wrong of [200, 201, 302, 0, -0, NaN, Infinity, status + 1, String(status)]) {
    assert.equal(decodeReviewError({ ok: false, code }, wrong as number), null);
  }
});

test("error envelope rejects unknown/prototype names, details, non-false flags and accessors", () => {
  let getters = 0;
  for (const body of [null, [], { ok: true, code: "API_CONFLICT" }, { ok: 0, code: "API_CONFLICT" },
    { ok: false, code: "API_CONFLICT", details: "synthetic-private" }, { ok: false, code: "constructor" },
    { ok: false, code: "toString" }, { ok: false, code: "__proto__" }, { ok: false, code: "api_conflict" },
    { ok: false, get code() { getters++; return "API_CONFLICT"; } }]) assert.equal(decodeReviewError(body), null);
  assert.equal(getters, 0);
  const body = { ok: false, code: "API_CONFLICT" };
  assert.equal(decodeReviewError(Object.assign(Object.create(null), body), 409), "API_CONFLICT");
  Object.defineProperty(body, "code", { enumerable: false }); assert.equal(decodeReviewError(body), null);
});

test("error symbols, inherited fields and serialization hooks cannot bypass the exact envelope", () => {
  let calls = 0;
  for (const body of [
    { ok: false, code: "API_CONFLICT", [Symbol("extra")]: 1 },
    Object.assign(Object.create({ inherited: true }), { ok: false, code: "API_CONFLICT" }),
    { ok: false, code: "API_CONFLICT", toJSON() { calls++; return { ok: false, code: "API_CONFLICT" }; } },
  ]) assert.equal(decodeReviewError(body, 409), null);
  assert.equal(calls, 0);
});

test("actual synthetic service preview/confirm/list/get/delete/replay/reject projections bind without internal wire fields", async () => {
  const store = createReviewMemoryStore(), service = createReviewService(store.dependencies);
  const pRequest = previewRequest(), p = success(await service.preview(pRequest.body));
  const pDecoded = decode(projectReviewPreview(p), pRequest); assert.ok(pDecoded && pDecoded.kind === "preview");
  const cRequest = createReviewConfirmRequest(pDecoded.preview.previewId, "synthetic-response-confirm");
  const confirmed = success(await service.confirm(cRequest.body));
  const view = decode(projectReviewReceipt(confirmed), cRequest); assert.ok(view && view.kind === "view");
  const getRequest = createReviewGetRequest(view.view.benefitId);
  assert.deepEqual(decode(projectReviewedBenefit(success(await service.get(getRequest.body))), getRequest), view);
  const listRequest = createReviewListRequest(50, null);
  const listing = decode(projectReviewedBenefitPage(success(await service.list(listRequest.body))), listRequest);
  assert.ok(listing && listing.kind === "page"); assert.deepEqual(listing.page.benefits, [view.view]);
  const deleteRequest = createReviewDeleteRequest(view.view.benefitId, view.view.benefitRevision, "synthetic-response-delete");
  const deletedView = decode(projectReviewReceipt(success(await service.remove(deleteRequest.body))), deleteRequest);
  assert.ok(deletedView && deletedView.kind === "view" && deletedView.view.outcome === "deleted");
  assert.deepEqual(decode(projectReviewReceipt(success(await service.confirm(cRequest.body))), cRequest), deletedView);

  // A fresh store keeps the reject path independent from the deleted candidate.
  const other = createReviewService(createReviewMemoryStore().dependencies);
  const rejectedPreview = success(await other.preview(pRequest.body));
  const rejectRequest = createReviewRejectRequest(rejectedPreview.id, rejectedPreview.revision);
  const rejected = success(await other.reject(rejectRequest.body));
  assert.deepEqual(decode({ previewId: rejected.previewId, state: rejected.state }, rejectRequest),
    { kind: "rejected", previewId: rejectedPreview.id });
});

test("response module has no server/runtime side-effect imports", () => {
  const source = readFileSync(new URL("../src/domain/review-client/responses.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:server|node:|react|storage)[^"']*["']/);
  assert.doesNotMatch(source, /\b(?:fetch|localStorage|sessionStorage|Date\.now)\s*\(/);
});
