import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { CandidateReviewWorkspace } from "../src/components/review-workspace/CandidateReviewWorkspace.tsx";
import { ReviewWorkspacePanel } from "../src/components/review-workspace/ReviewWorkspacePanel.tsx";
import { createReviewWorkspace } from "../src/domain/review-client/workspace.ts";
import { createCandidateSelectionFixture } from "./support/candidate-selection-fixture.ts";
import { REVIEW_NOW } from "./support/review-memory-store.ts";

const context = Object.freeze({ bindingId: "synthetic-selection-ssr", dataGeneration: 1 });
function fixture() {
  let clockCalls = 0, fetchCalls = 0, ids = 0;
  const clocks = () => { clockCalls++; return { wall: REVIEW_NOW, monotonic: 1 }; };
  const workspace = createReviewWorkspace({ client: { origin: "https://synthetic.invalid",
    fetch: async () => { fetchCalls++; throw Error("NO_SSR_REQUEST"); } }, clocks });
  const render = (source: unknown, expected: unknown = context) => renderToString(createElement(StrictMode, null,
    createElement(CandidateReviewWorkspace, { workspace, context: expected, source, referenceTime: REVIEW_NOW, clocks,
      createOperationId: () => { ids++; throw Error("NO_SSR_ID"); } })));
  return { workspace, render, counts: () => ({ clockCalls, fetchCalls, ids }) };
}
function closed(html: string) {
  assert.match(html, /data-open="no"/);
  assert.doesNotMatch(html, /data-testid="candidate-picker"|<(?:select|input|textarea)\b/i);
  assert.doesNotMatch(html, /synthetic-selection-ssr|Synthetic Service|Synthetic trial offer/);
}
test("candidate composition SSR hides actual projected candidates/services without activation, clocks or fetch", async (t) => {
  const f = fixture(), data = await createCandidateSelectionFixture();
  t.mock.method(Date, "now", () => { throw Error("NO_SSR_CLOCK"); });
  t.mock.method(globalThis, "setInterval", () => { throw Error("NO_SSR_TIMER"); });
  closed(f.render({ ...context, batch: data.batch, services: data.services }));
  assert.deepEqual(f.counts(), { clockCalls: 0, fetchCalls: 0, ids: 0 });
  assert.equal(f.workspace.getSnapshot(), null); f.workspace.dispose();
});
test("candidate composition SSR never inspects even hostile or revoked source envelopes", () => {
  const f = fixture(); let reads = 0;
  const hostile = new Proxy({}, { get() { reads++; throw Error("NO_SOURCE_READ"); },
    ownKeys() { reads++; throw Error("NO_SOURCE_READ"); }, getPrototypeOf() { reads++; throw Error("NO_SOURCE_READ"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const getter = Object.defineProperty({ ...context }, "batch", { enumerable: true,
    get() { reads++; throw Error("NO_SOURCE_READ"); } });
  for (const input of [hostile, revoked.proxy, getter, null, undefined, {}, []]) closed(f.render(input));
  assert.equal(reads, 0); assert.deepEqual(f.counts(), { clockCalls: 0, fetchCalls: 0, ids: 0 }); f.workspace.dispose();
});
test("SSR populated workspace remains untouched and hidden even with valid selection source", async () => {
  const f = fixture(), data = await createCandidateSelectionFixture();
  assert.ok(f.workspace.activate(context));
  const before = f.workspace.getSnapshot(), counts = f.counts();
  closed(f.render({ ...context, batch: data.batch, services: data.services }));
  assert.equal(f.workspace.getSnapshot(), before); assert.deepEqual(f.counts(), counts); f.workspace.dispose();
});
test("closed review panel never renders supplied child or calls draft guard", () => {
  const f = fixture(); let children = 0, guards = 0;
  const Child = () => { children++; return createElement("p", null, "SYNTHETIC_PRIVATE_CHILD"); };
  const html = renderToString(createElement(ReviewWorkspacePanel, { workspace: f.workspace, context,
    draft: null, referenceTime: REVIEW_NOW, createOperationId: () => "synthetic-unused",
    validateDraft: () => { guards++; return true; }, children: createElement(Child) }));
  closed(html); assert.equal(html.includes("SYNTHETIC_PRIVATE_CHILD"), false);
  assert.equal(children, 0); assert.equal(guards, 0); f.workspace.dispose();
});
test("malformed expected context cannot make SSR selection content visible", () => {
  const f = fixture(); let calls = 0;
  const getter = Object.defineProperty({ dataGeneration: 1 }, "bindingId", { enumerable: true,
    get() { calls++; return context.bindingId; } });
  for (const expected of [null, {}, [], getter, { ...context, dataGeneration: 0 }, { ...context, extra: true }]) {
    closed(f.render({ ...context, batch: "SYNTHETIC_PRIVATE_CHILD", services: [] }, expected));
  }
  assert.equal(calls, 0); assert.deepEqual(f.counts(), { clockCalls: 0, fetchCalls: 0, ids: 0 }); f.workspace.dispose();
});
