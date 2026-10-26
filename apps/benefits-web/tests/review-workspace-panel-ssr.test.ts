import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { ReviewWorkspacePanel } from "../src/components/review-workspace/ReviewWorkspacePanel.tsx";
import { createReviewWorkspace, type ReviewWorkspace } from "../src/domain/review-client/workspace.ts";
import { createReviewGetRequest, createReviewPreviewRequest } from "../src/domain/review-client/requests.ts";
import { createReviewPreviewDemoData } from "../src/lib/review-preview-demo-data.ts";
import { createReviewedBenefitListDemoPage } from "../src/lib/reviewed-benefit-list-demo-data.ts";

// Real component server-render evidence only. This does not exercise hydration,
// native visibility, keyboard/focus, a real session, browser Fetch or persistence.
const NOW = 1790000000000;
const CONTEXT = Object.freeze({ bindingId: "synthetic-panel-ssr-binding", dataGeneration: 1 });
const MARKERS = ["SYNTHETIC_PANEL_PREVIEW_VALUE", "SYNTHETIC_PANEL_ROW_VALUE", "SYNTHETIC_PANEL_DRAFT_VALUE",
  "synthetic-panel-preview-id", "synthetic-panel-candidate-id", "synthetic-panel-service-id",
  "synthetic-list-050", "synthetic-panel-ssr-binding"] as const;

function fixture() {
  let clockCalls = 0, fetchCalls = 0;
  const preview = structuredClone(createReviewPreviewDemoData("corrected-zero", NOW, 1));
  const mutablePreview = preview as unknown as { previewId: string; content: {
    serviceId: string; serviceName: string; values: { name: string } } };
  mutablePreview.previewId = MARKERS[3]; mutablePreview.content.serviceId = MARKERS[5];
  mutablePreview.content.serviceName = "SYNTHETIC_PANEL_SERVICE_NAME";
  mutablePreview.content.values.name = MARKERS[0];
  const page = structuredClone(createReviewedBenefitListDemoPage("last", NOW));
  for (const row of page.benefits) {
    (row.content.values as { name: string }).name = MARKERS[1];
  }
  const workspace = createReviewWorkspace({ client: {
    origin: "https://synthetic.invalid",
    fetch: async (request) => {
      fetchCalls++;
      const action = new URL(request.url).pathname.split("/").at(-1);
      const value = action === "preview" ? preview : action === "list" ? page : page.benefits[0];
      return new Response(JSON.stringify({ ok: true, value }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    },
  }, clocks: () => { clockCalls++; return { wall: NOW, monotonic: 1 }; } });
  const draft = Object.freeze({ ...CONTEXT, request: createReviewPreviewRequest(MARKERS[4], 1, MARKERS[5], 1,
    { ...preview.content.values, name: MARKERS[2] }) });
  return { workspace, preview, page, draft, counts: () => ({ clockCalls, fetchCalls }) };
}

function observed(workspace: ReviewWorkspace) {
  const calls = new Map<string, number>();
  const wrapped = Object.fromEntries(Object.entries(workspace).map(([key, method]) => [key, (...args: unknown[]) => {
    calls.set(key, (calls.get(key) ?? 0) + 1);
    return Reflect.apply(method as (...args: unknown[]) => unknown, workspace, args);
  }])) as unknown as ReviewWorkspace;
  return { wrapped, calls };
}
function render(workspace: ReviewWorkspace, draft: unknown, context: unknown = CONTEXT,
  createOperationId = (): string => { throw Error("NO_SSR_OPERATION_ID"); }) {
  return renderToString(createElement(StrictMode, null, createElement(ReviewWorkspacePanel, {
    workspace, context, draft, referenceTime: NOW, createOperationId,
  })));
}
function closed(html: string) {
  assert.match(html, /data-testid="review-workspace-panel"/);
  assert.match(html, /data-open="no"/);
  assert.match(html, /data-preview="closed"/);
  assert.match(html, /data-list="closed"/);
  assert.doesNotMatch(html, /<(?:input|textarea|select)\b/i);
  assert.doesNotMatch(html, /data-(?:benefit|preview|candidate|service)-id=/);
  for (const marker of MARKERS) assert.equal(html.includes(marker), false, `unexpected synthetic marker: ${marker}`);
  assert.equal(html.includes("SYNTHETIC_PANEL_SERVICE_NAME"), false);
}

test("panel SSR is closed with no draft fields, workspace calls, UUIDs, wall clock, timers, operation IDs or HTTP", (t) => {
  const f = fixture(), view = observed(f.workspace); let operationIds = 0;
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_SSR_TIMER"); });
  t.mock.method(globalThis, "setInterval", () => { throw Error("NO_SSR_INTERVAL"); });
  t.mock.method(globalThis, "fetch", () => { throw Error("NO_SSR_HTTP"); });
  t.mock.method(Date, "now", () => { throw Error("NO_SSR_WALL_CLOCK"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_SSR_UUID"); });
  closed(render(view.wrapped, f.draft, CONTEXT, () => { operationIds++; throw Error("NO_SSR_OPERATION_ID"); }));
  assert.equal(operationIds, 0); assert.equal(view.calls.size, 0);
  assert.deepEqual(f.counts(), { clockCalls: 0, fetchCalls: 0 });
  assert.equal(f.workspace.getSnapshot(), null); f.workspace.dispose();
});

test("panel SSR cannot disclose or mutate a populated workspace or release its prepared command", async (t) => {
  const f = fixture(), lease = f.workspace.activate(CONTEXT); assert.ok(lease);
  const command = f.workspace.prepare(lease, createReviewPreviewRequest(MARKERS[4], 1,
    f.preview.content.serviceId, f.preview.content.serviceRevision, f.preview.content.values));
  assert.equal(command.kind, "prepared"); if (command.kind !== "prepared") throw Error("SYNTHETIC_PREVIEW_SETUP");
  assert.equal((await f.workspace.execute(lease, command.command)).kind, "success");
  assert.equal((await f.workspace.nextPage(lease)).kind, "success");
  const held = f.workspace.prepare(lease, createReviewGetRequest(f.page.benefits[0]!.benefitId));
  assert.equal(held.kind, "prepared"); if (held.kind !== "prepared") throw Error("SYNTHETIC_GET_SETUP");
  const before = f.workspace.getSnapshot(), counts = f.counts(), view = observed(f.workspace);
  assert.equal(before?.preview.phase, "ready"); assert.equal(before?.preview.preview?.content.values.name, MARKERS[0]);
  assert.equal(before?.list.entries.length, 3); assert.equal(before?.list.phase, "end_observed");
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_SSR_TIMER"); });
  t.mock.method(Date, "now", () => { throw Error("NO_SSR_WALL_CLOCK"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_SSR_UUID"); });
  closed(render(view.wrapped, f.draft));
  assert.equal(view.calls.size, 0); assert.equal(f.workspace.getSnapshot(), before); assert.deepEqual(f.counts(), counts);
  t.mock.restoreAll();
  assert.equal((await f.workspace.execute(lease, held.command)).kind, "success");
  assert.equal(f.counts().fetchCalls, counts.fetchCalls + 1); f.workspace.dispose();
});

test("closed panel SSR does not inspect even revoked, getter-backed or hostile Proxy drafts", () => {
  const f = fixture(), view = observed(f.workspace); let reads = 0;
  const getter = Object.defineProperty({ ...CONTEXT }, "request", { enumerable: true,
    get() { reads++; throw Error("NO_SSR_DRAFT_ACCESS"); } });
  const nested = Object.freeze({ ...CONTEXT, request: new Proxy({}, {
    getPrototypeOf() { reads++; throw Error("NO_SSR_DRAFT_REFLECTION"); },
    ownKeys() { reads++; throw Error("NO_SSR_DRAFT_REFLECTION"); },
    get() { reads++; throw Error("NO_SSR_DRAFT_ACCESS"); },
  }) });
  const outer = new Proxy({}, {
    getPrototypeOf() { reads++; throw Error("NO_SSR_DRAFT_REFLECTION"); },
    ownKeys() { reads++; throw Error("NO_SSR_DRAFT_REFLECTION"); },
    getOwnPropertyDescriptor() { reads++; throw Error("NO_SSR_DRAFT_REFLECTION"); },
    get() { reads++; throw Error("NO_SSR_DRAFT_ACCESS"); },
  });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const draft of [null, undefined, {}, [], "SYNTHETIC_PANEL_DRAFT_VALUE", getter, nested, outer, revoked.proxy]) {
    closed(render(view.wrapped, draft));
  }
  assert.equal(reads, 0); assert.equal(view.calls.size, 0);
  assert.deepEqual(f.counts(), { clockCalls: 0, fetchCalls: 0 }); f.workspace.dispose();
});

test("malformed SSR contexts do not execute accessors or expose a matching-looking draft", () => {
  const f = fixture(), view = observed(f.workspace); let reads = 0;
  const getter = Object.defineProperty({ dataGeneration: 1 }, "bindingId", { enumerable: true,
    get() { reads++; return CONTEXT.bindingId; } });
  for (const context of [null, undefined, {}, [], getter, Object.create(CONTEXT),
    { ...CONTEXT, dataGeneration: 0 }, { ...CONTEXT, bindingId: " padded " }, { ...CONTEXT, extra: true }]) {
    closed(render(view.wrapped, f.draft, context));
  }
  assert.equal(reads, 0); assert.equal(view.calls.size, 0);
  assert.deepEqual(f.counts(), { clockCalls: 0, fetchCalls: 0 }); f.workspace.dispose();
});

test("SSR remains closed across plain/null-prototype/frozen contexts and alternating workspace owners", () => {
  const a = fixture(), b = fixture(), observedA = observed(a.workspace), observedB = observed(b.workspace);
  const contexts = [CONTEXT, Object.freeze({ ...CONTEXT }), Object.assign(Object.create(null), CONTEXT),
    { bindingId: "synthetic-panel-other", dataGeneration: 2 }];
  for (const workspace of [observedA.wrapped, observedB.wrapped, observedA.wrapped]) for (const context of contexts) {
    closed(render(workspace, a.draft, context));
  }
  assert.equal(observedA.calls.size, 0); assert.equal(observedB.calls.size, 0);
  assert.deepEqual(a.counts(), { clockCalls: 0, fetchCalls: 0 }); assert.deepEqual(b.counts(), { clockCalls: 0, fetchCalls: 0 });
  a.workspace.dispose(); b.workspace.dispose();
});
