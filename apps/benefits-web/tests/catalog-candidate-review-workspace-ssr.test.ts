import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { CatalogCandidateReviewWorkspace } from "../src/components/review-workspace/CatalogCandidateReviewWorkspace.tsx";
import { createReviewWorkspace, type ReviewWorkspace } from "../src/domain/review-client/workspace.ts";
import { createReviewGetRequest, createReviewPreviewRequest } from "../src/domain/review-client/requests.ts";
import { createReviewPreviewDemoData } from "../src/lib/review-preview-demo-data.ts";
import { createReviewedBenefitListDemoPage } from "../src/lib/reviewed-benefit-list-demo-data.ts";

// Actual composed component, server rendering only. These tests do not exercise
// hydration, native lifecycle, pagination, actual authentication or persistence.
const NOW = 1790000000000, ORIGIN = "https://synthetic.invalid";
const CONTEXT = Object.freeze({ bindingId: "synthetic-catalog-ssr-view", dataGeneration: 1 });
const REFERENCE = "synthetic-catalog-ssr-batch";
const PREVIEW_MARKER = "SYNTHETIC_CATALOG_SSR_PRIVATE_PREVIEW";
const ROW_MARKER = "SYNTHETIC_CATALOG_SSR_PRIVATE_ROW";
const ZERO = { clocks: 0, reviewFetches: 0, readFetches: 0, readClocks: 0, ids: 0 };

function fixture(timeoutMs?: number) {
  let clocks = 0, reviewFetches = 0, readFetches = 0, readClocks = 0, ids = 0;
  const preview = structuredClone(createReviewPreviewDemoData("corrected-zero", NOW, 1));
  (preview.content.values as { name: string }).name = PREVIEW_MARKER;
  const page = structuredClone(createReviewedBenefitListDemoPage("last", NOW));
  for (const row of page.benefits) (row.content.values as { name: string }).name = ROW_MARKER;
  const time = () => { clocks++; return { wall: NOW, monotonic: 1 }; };
  const workspace = createReviewWorkspace({ client: { origin: ORIGIN, fetch: async (request) => {
    reviewFetches++;
    const action = new URL(request.url).pathname.split("/").at(-1);
    const value = action === "preview" ? preview : action === "list" ? page : page.benefits[0];
    return new Response(JSON.stringify({ ok: true, value }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } }, clocks: time });
  const client = Object.freeze({ origin: ORIGIN,
    fetch: async () => { readFetches++; throw Error("NO_SSR_CATALOG_OR_CANDIDATE_FETCH"); },
    now: () => { readClocks++; return NOW; }, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const render = (context: unknown = CONTEXT, batchReference: unknown = REFERENCE, target = workspace) =>
    renderToString(createElement(StrictMode, null, createElement(CatalogCandidateReviewWorkspace, {
      workspace: target, context, batchReference: batchReference as string, client,
      referenceTime: NOW, clocks: time, createOperationId: () => { ids++; throw Error("NO_SSR_OPERATION_ID"); },
    })));
  return { workspace, preview, page, render,
    counts: () => ({ clocks, reviewFetches, readFetches, readClocks, ids }) };
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
  assert.match(html, /data-testid="catalog-candidate-workspace"/);
  assert.match(html, /data-testid="catalog-selection" data-phase="closed" data-pages="0" data-rows="0"/);
  assert.match(html, /data-testid="candidate-loader" data-phase="closed"/);
  assert.match(html, /data-testid="catalog-service-details-panel" data-phase="closed" data-open="no"/);
  assert.doesNotMatch(html, /data-testid="catalog-service-details"|data-testid="catalog-service-detail-disclosure"/);
  assert.match(html, /data-open="no"/); assert.match(html, /data-preview="closed"/); assert.match(html, /data-list="closed"/);
  for (const label of ["서비스 다음 목록 불러오기", "서비스 목록 처음부터 다시 확인", "서비스 조회 취소",
    "후보 불러오기·새로 확인", "후보 조회 취소"])
    assert.match(html, new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`));
  assert.doesNotMatch(html, /data-testid="candidate-picker"|<(?:input|select|textarea)\b|data-(?:benefit|preview|candidate|service)-id=/i);
  for (const marker of [CONTEXT.bindingId, REFERENCE, PREVIEW_MARKER, ROW_MARKER, "Synthetic Service", "Synthetic trial offer"])
    assert.equal(html.includes(marker), false, "No synthetic private observation is serialized into server HTML");
}

test("catalog-candidate SSR creates inert owners without workspace reads, requests, clocks, UUIDs or timers", (t) => {
  const f = fixture(), observed = observe(f.workspace);
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_SSR_TIMER"); });
  t.mock.method(globalThis, "setInterval", () => { throw Error("NO_SSR_INTERVAL"); });
  t.mock.method(globalThis, "fetch", () => { throw Error("NO_SSR_FETCH"); });
  t.mock.method(Date, "now", () => { throw Error("NO_SSR_WALL_CLOCK"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_SSR_UUID"); });
  closed(f.render(CONTEXT, REFERENCE, observed.wrapped));
  assert.equal(observed.calls.size, 0); assert.deepEqual(f.counts(), ZERO);
  assert.equal(f.workspace.getSnapshot(), null); f.workspace.dispose();
});

test("populated preview and saved rows remain hidden without changing the workspace or consuming an original command", async (t) => {
  const f = fixture(5000), lease = f.workspace.activate(CONTEXT); assert.ok(lease);
  const prepared = f.workspace.prepare(lease, createReviewPreviewRequest("synthetic-catalog-ssr-candidate", 1,
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
  for (const context of [CONTEXT, null, { ...CONTEXT, bindingId: "another-view" }, { ...CONTEXT, dataGeneration: 2 }])
    closed(f.render(context, REFERENCE, observed.wrapped));
  assert.equal(observed.calls.size, 0); assert.equal(f.workspace.getSnapshot(), before); assert.deepEqual(f.counts(), counts);
  t.mock.restoreAll();
  assert.equal((await f.workspace.execute(lease, held.command)).kind, "success");
  assert.equal(f.counts().reviewFetches, counts.reviewFetches + 1); f.workspace.dispose();
});

test("unmatched and malformed contexts cannot inspect source snapshots or invoke accessors during SSR", () => {
  const f = fixture(), observed = observe(f.workspace); let accessors = 0;
  const accessor = Object.defineProperty({ dataGeneration: 1 }, "bindingId", { enumerable: true,
    get() { accessors++; throw Error("NO_CONTEXT_GETTER"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const context of [null, undefined, [], {}, accessor, revoked.proxy, Object.create(CONTEXT),
    { ...CONTEXT, bindingId: "x\n" }, { ...CONTEXT, dataGeneration: 0 }, { ...CONTEXT, extra: true }])
    closed(f.render(context, REFERENCE, observed.wrapped));
  assert.equal(accessors, 0); assert.equal(observed.calls.size, 0); assert.deepEqual(f.counts(), ZERO); f.workspace.dispose();
});

test("malformed batch references do not convert values, leak raw strings or trigger catalog/candidate reads on SSR", () => {
  const f = fixture(), observed = observe(f.workspace); let conversions = 0;
  const hostile = { toString() { conversions++; throw Error("NO_REFERENCE_CONVERSION"); } };
  const marker = "SYNTHETIC_PRIVATE_REFERENCE";
  for (const reference of [null, undefined, 1, Symbol(marker), hostile, "", `${marker}\n`, `${marker} padded`,
    "x".repeat(129), `https://outside.invalid/${marker}`]) {
    const html = f.render(CONTEXT, reference, observed.wrapped); closed(html); assert.equal(html.includes(marker), false);
  }
  assert.equal(conversions, 0); assert.equal(observed.calls.size, 0); assert.deepEqual(f.counts(), ZERO); f.workspace.dispose();
});

test("SSR accepts plain frozen and null-prototype contexts without activating either read owner", () => {
  for (const timeout of [undefined, 5000]) {
    const f = fixture(timeout), observed = observe(f.workspace);
    for (const context of [CONTEXT, Object.assign(Object.create(null), CONTEXT), Object.freeze({ ...CONTEXT })])
      closed(f.render(context, REFERENCE, observed.wrapped));
    assert.equal(observed.calls.size, 0); assert.deepEqual(f.counts(), ZERO); f.workspace.dispose();
  }
});

test("repeated server renders with distinct owner instances do not share or activate a session", () => {
  const a = fixture(), b = fixture(), left = observe(a.workspace), right = observe(b.workspace);
  for (const [f, observed] of [[a, left], [b, right], [a, left]] as const)
    closed(f.render(CONTEXT, REFERENCE, observed.wrapped));
  assert.equal(left.calls.size, 0); assert.equal(right.calls.size, 0);
  assert.deepEqual(a.counts(), ZERO); assert.deepEqual(b.counts(), ZERO);
  assert.equal(a.workspace.getSnapshot(), null); assert.equal(b.workspace.getSnapshot(), null);
  a.workspace.dispose(); b.workspace.dispose();
});
