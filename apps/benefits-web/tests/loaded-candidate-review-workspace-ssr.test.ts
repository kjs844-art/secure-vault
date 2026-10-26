import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { LoadedCandidateReviewWorkspace } from "../src/components/review-workspace/LoadedCandidateReviewWorkspace.tsx";
import { createReviewWorkspace, type ReviewWorkspace } from "../src/domain/review-client/workspace.ts";
import { createReviewGetRequest, createReviewPreviewRequest } from "../src/domain/review-client/requests.ts";
import { createReviewPreviewDemoData } from "../src/lib/review-preview-demo-data.ts";
import { createReviewedBenefitListDemoPage } from "../src/lib/reviewed-benefit-list-demo-data.ts";
import { createCandidateSelectionFixture } from "./support/candidate-selection-fixture.ts";
import { CandidateReviewFixture } from "../scripts/fixtures/candidate-review-fixture.tsx";

// Actual component SSR only. No hydration/effect replay, DOM interaction, native
// navigation, real authentication, provider or persistence is verified here.
const NOW = 1790000000000, ORIGIN = "https://synthetic.invalid";
const CONTEXT = Object.freeze({ bindingId: "synthetic-loader-ssr-view", dataGeneration: 1 });
const REFERENCE = "synthetic-loader-ssr-batch-reference";
const PREVIEW_MARKER = "SYNTHETIC_LOADER_PREVIEW_PRIVATE", ROW_MARKER = "SYNTHETIC_LOADER_ROW_PRIVATE";
function fixture() {
  let clocks = 0, reviewFetches = 0, candidateFetches = 0, candidateClocks = 0, ids = 0;
  const preview = structuredClone(createReviewPreviewDemoData("corrected-zero", NOW, 1));
  (preview.content.values as { name: string }).name = PREVIEW_MARKER;
  const page = structuredClone(createReviewedBenefitListDemoPage("last", NOW));
  for (const row of page.benefits) (row.content.values as { name: string }).name = ROW_MARKER;
  const time = () => { clocks++; return { wall: NOW, monotonic: 1 }; };
  const workspace = createReviewWorkspace({ client: { origin: ORIGIN, fetch: async (request) => {
    reviewFetches++;
    const action = new URL(request.url).pathname.split("/").at(-1);
    return new Response(JSON.stringify({ ok: true, value: action === "preview" ? preview : action === "list" ? page : page.benefits[0] }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } }, clocks: time });
  const client = Object.freeze({ origin: ORIGIN,
    fetch: async () => { candidateFetches++; throw Error("NO_SSR_CANDIDATE_FETCH"); },
    now: () => { candidateClocks++; return NOW; } });
  const render = (services: unknown, expected: unknown = CONTEXT, reference: unknown = REFERENCE, target = workspace) =>
    renderToString(createElement(StrictMode, null, createElement(LoadedCandidateReviewWorkspace, {
      workspace: target, context: expected, services, batchReference: reference as string,
      client, referenceTime: NOW, clocks: time, createOperationId: () => { ids++; throw Error("NO_SSR_OPERATION_ID"); },
    })));
  return { workspace, preview, page, render, counts: () => ({ clocks, reviewFetches, candidateFetches, candidateClocks, ids }) };
}
function observe(workspace: ReviewWorkspace) {
  const calls = new Map<string, number>();
  const wrapped = Object.fromEntries(Object.entries(workspace).map(([key, method]) => [key, (...args: unknown[]) => {
    calls.set(key, (calls.get(key) ?? 0) + 1);
    return Reflect.apply(method as (...args: unknown[]) => unknown, workspace, args);
  }])) as unknown as ReviewWorkspace;
  return { calls, wrapped };
}
function closed(html: string) {
  assert.match(html, /data-testid="candidate-loader" data-phase="closed"/);
  assert.match(html, /data-open="no"/); assert.match(html, /data-preview="closed"/); assert.match(html, /data-list="closed"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>후보 불러오기·새로 확인<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>후보 조회 취소<\/button>/);
  assert.match(html, /<p tabindex="-1" data-testid="candidate-loader-status" role="status" aria-live="polite" aria-atomic="true">검토 화면을 먼저 열어 주세요\.<\/p>/);
  assert.doesNotMatch(html, /data-testid="candidate-picker"|<(?:input|select|textarea)\b|data-(?:benefit|preview|candidate|service)-id=/i);
  for (const value of [CONTEXT.bindingId, REFERENCE, PREVIEW_MARKER, ROW_MARKER, "Synthetic trial offer", "Synthetic Service"])
    assert.equal(html.includes(value), false, "synthetic data is not part of the server HTML");
}
const zero = { clocks: 0, reviewFetches: 0, candidateFetches: 0, candidateClocks: 0, ids: 0 };

test("loaded candidate SSR is inert across workspace methods, source inspection, transport, clocks, IDs and timers", (t) => {
  const f = fixture(), observed = observe(f.workspace); let reads = 0;
  const source = new Proxy({}, { get() { reads++; throw Error("NO_SOURCE_ACCESS"); },
    ownKeys() { reads++; throw Error("NO_SOURCE_REFLECTION"); }, getPrototypeOf() { reads++; throw Error("NO_SOURCE_REFLECTION"); } });
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_SSR_TIMER"); });
  t.mock.method(globalThis, "setInterval", () => { throw Error("NO_SSR_INTERVAL"); });
  t.mock.method(globalThis, "fetch", () => { throw Error("NO_SSR_FETCH"); });
  t.mock.method(Date, "now", () => { throw Error("NO_SSR_WALL_CLOCK"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_SSR_UUID"); });
  closed(f.render(source, CONTEXT, REFERENCE, observed.wrapped));
  assert.equal(reads, 0); assert.equal(observed.calls.size, 0); assert.deepEqual(f.counts(), zero);
  assert.equal(f.workspace.getSnapshot(), null); f.workspace.dispose();
});
test("actual projected catalog observations are hidden and not inspected by SSR", async () => {
  const f = fixture(), data = await createCandidateSelectionFixture(), observed = observe(f.workspace); let reads = 0;
  const services = Object.freeze({ ...CONTEXT, services: data.services });
  const source = new Proxy(services, { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); },
    ownKeys(target) { reads++; return Reflect.ownKeys(target); }, getPrototypeOf(target) { reads++; return Reflect.getPrototypeOf(target); } });
  closed(f.render(source, CONTEXT, REFERENCE, observed.wrapped));
  assert.equal(reads, 0); assert.equal(observed.calls.size, 0); assert.deepEqual(f.counts(), zero); f.workspace.dispose();
});
test("SSR hides populated preview/list, preserves exact workspace snapshot and leaves original prepared command usable", async (t) => {
  const f = fixture(), lease = f.workspace.activate(CONTEXT); assert.ok(lease);
  const prepared = f.workspace.prepare(lease, createReviewPreviewRequest("synthetic-loader-candidate", 1,
    f.preview.content.serviceId, f.preview.content.serviceRevision, f.preview.content.values));
  assert.equal(prepared.kind, "prepared"); if (prepared.kind !== "prepared") throw Error("SYNTHETIC_SETUP_FAILED");
  assert.equal((await f.workspace.execute(lease, prepared.command)).kind, "success");
  assert.equal((await f.workspace.nextPage(lease)).kind, "success");
  const held = f.workspace.prepare(lease, createReviewGetRequest(f.page.benefits[0]!.benefitId));
  assert.equal(held.kind, "prepared"); if (held.kind !== "prepared") throw Error("SYNTHETIC_SETUP_FAILED");
  const before = f.workspace.getSnapshot(), counts = f.counts(), observed = observe(f.workspace);
  assert.equal(before?.preview.preview?.content.values.name, PREVIEW_MARKER);
  assert.equal(before?.list.entries.length, 3); assert.equal(before?.list.phase, "end_observed");
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_SSR_TIMER"); });
  t.mock.method(Date, "now", () => { throw Error("NO_SSR_CLOCK"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_SSR_UUID"); });
  for (const expected of [CONTEXT, null, { ...CONTEXT, bindingId: "another-view" }, { ...CONTEXT, dataGeneration: 2 }])
    closed(f.render({ ...CONTEXT, services: [] }, expected, REFERENCE, observed.wrapped));
  assert.equal(observed.calls.size, 0); assert.equal(f.workspace.getSnapshot(), before); assert.deepEqual(f.counts(), counts);
  t.mock.restoreAll();
  assert.equal((await f.workspace.execute(lease, held.command)).kind, "success");
  assert.equal(f.counts().reviewFetches, counts.reviewFetches + 1); f.workspace.dispose();
});
test("closed/malformed contexts never inspect source getters, revoked proxies or call workspace ports", () => {
  const f = fixture(), observed = observe(f.workspace); let getters = 0;
  const source = Object.defineProperty({ ...CONTEXT }, "services", { enumerable: true,
    get() { getters++; throw Error("NO_SSR_SOURCE_GETTER"); } });
  const badContext = Object.defineProperty({ dataGeneration: 1 }, "bindingId", { enumerable: true,
    get() { getters++; return CONTEXT.bindingId; } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const expected of [null, undefined, [], {}, badContext, Object.create(CONTEXT), { ...CONTEXT, dataGeneration: 0 },
    { ...CONTEXT, bindingId: "padded " }, { ...CONTEXT, extra: true }, revoked.proxy])
    for (const input of [source, revoked.proxy, null, undefined, {}]) closed(f.render(input, expected, REFERENCE, observed.wrapped));
  assert.equal(getters, 0); assert.equal(observed.calls.size, 0); assert.deepEqual(f.counts(), zero); f.workspace.dispose();
});
test("malformed batch references remain closed with no conversion hook, request or raw value in SSR HTML", () => {
  const f = fixture(), observed = observe(f.workspace); let conversions = 0;
  const hostile = { toString() { conversions++; throw Error("NO_REFERENCE_CONVERSION"); } };
  for (const reference of [null, undefined, 1, Symbol("synthetic-reference"), hostile, "", " padded", "x\n",
    "x".repeat(129), "has space", "x/../../other", "https://outside.invalid"]) {
    closed(f.render({ ...CONTEXT, services: [] }, CONTEXT, reference, observed.wrapped));
  }
  assert.equal(conversions, 0); assert.equal(observed.calls.size, 0); assert.deepEqual(f.counts(), zero); f.workspace.dispose();
});
test("repeated SSR for distinct workspace/client owners has no shared activation or retained observation", () => {
  const a = fixture(), b = fixture(), left = observe(a.workspace), right = observe(b.workspace);
  for (const [f, observed] of [[a, left], [b, right], [a, left]] as const)
    for (const expected of [CONTEXT, Object.assign(Object.create(null), CONTEXT), Object.freeze({ ...CONTEXT })])
      closed(f.render({ ...CONTEXT, services: [] }, expected, REFERENCE, observed.wrapped));
  assert.equal(left.calls.size, 0); assert.equal(right.calls.size, 0);
  assert.deepEqual(a.counts(), zero); assert.deepEqual(b.counts(), zero); a.workspace.dispose(); b.workspace.dispose();
});
test("native-browser fixture server render stays unhydrated and closed without service/candidate fetch or ambient time", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw Error("NO_FIXTURE_SSR_FETCH"); });
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_FIXTURE_SSR_TIMER"); });
  t.mock.method(globalThis, "setInterval", () => { throw Error("NO_FIXTURE_SSR_INTERVAL"); });
  t.mock.method(Date, "now", () => { throw Error("NO_FIXTURE_SSR_CLOCK"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_FIXTURE_SSR_UUID"); });
  const html = renderToString(createElement(StrictMode, null, createElement(CandidateReviewFixture, { origin: ORIGIN })));
  assert.match(html, /data-hydrated="no" data-loads="0"/); closed(html);
});
