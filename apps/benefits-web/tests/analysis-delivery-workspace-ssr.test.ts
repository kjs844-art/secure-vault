import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { DeliveredCandidateReviewWorkspace } from "../src/components/review-workspace/DeliveredCandidateReviewWorkspace.tsx";
import { createReviewWorkspace } from "../src/domain/review-client/workspace.ts";

const ORIGIN = "https://synthetic.invalid", NOW = 1790000000000;
const CONTEXT = Object.freeze({ bindingId: "synthetic-delivery-private-binding", dataGeneration: 1 });
function fixture() {
  let effects = 0, clocks = 0;
  const forbidden = (): never => { effects++; throw Error("SSR_EFFECT_FORBIDDEN"); };
  const workspace = createReviewWorkspace({ client: { origin: ORIGIN, fetch: forbidden },
    clocks: () => { clocks++; return { wall: NOW, monotonic: 1 }; } });
  const render = (context: unknown = CONTEXT) => renderToString(createElement(StrictMode, null,
    createElement(DeliveredCandidateReviewWorkspace, { workspace, context, referenceTime: NOW,
      client: { origin: ORIGIN, fetch: forbidden }, clocks: forbidden, createOperationId: forbidden,
      readCompletion: forbidden })));
  return { workspace, render, effects: () => effects, clocks: () => clocks };
}
function closed(html: string) {
  assert.match(html, /data-testid="analysis-delivery" data-phase="closed"/);
  assert.match(html, /data-testid="candidate-loader" data-phase="closed"/);
  assert.match(html, /data-open="no"/);
  for (const label of ["저장 결과 받기·다시 확인", "결과 확인 취소", "이 후보 묶음 검토하기"])
    assert.match(html, new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`));
  assert.doesNotMatch(html, /synthetic-delivery-private-binding|data-testid="candidate-picker"|<input|<select/);
}

test("delivery SSR is closed and creates no request, timer, clock or random identifier", (t) => {
  const f = fixture();
  t.mock.method(globalThis, "setTimeout", () => { throw Error("SSR_TIMER"); });
  t.mock.method(globalThis, "fetch", () => { throw Error("SSR_FETCH"); });
  t.mock.method(Date, "now", () => { throw Error("SSR_CLOCK"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("SSR_RANDOM"); });
  closed(f.render()); assert.equal(f.effects(), 0); assert.equal(f.workspace.getSnapshot(), null);
  assert.equal(f.clocks(), 0);
});

test("delivery SSR preserves a preexisting active workspace without clocks or I/O", () => {
  const f = fixture(), lease = f.workspace.activate(CONTEXT); assert.ok(lease);
  const previous = f.workspace.getSnapshot(), clocks = f.clocks();
  for (const context of [CONTEXT, null, { ...CONTEXT, dataGeneration: 2 }]) closed(f.render(context));
  assert.equal(f.effects(), 0); assert.equal(f.clocks(), clocks);
  assert.equal(f.workspace.getSnapshot(), previous); f.workspace.dispose();
});

test("delivery SSR rejects malformed context without accessing user getters or serializing inputs", () => {
  const f = fixture(); let reads = 0;
  const getter = Object.defineProperty({ dataGeneration: 1 }, "bindingId", { enumerable: true,
    get() { reads++; return CONTEXT.bindingId; } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const context of [null, [], {}, revoked.proxy, getter, { ...CONTEXT, private: "SYNTHETIC_PRIVATE" }]) {
    const html = f.render(context); closed(html); assert.equal(html.includes("SYNTHETIC_PRIVATE"), false);
  }
  assert.equal(reads, 0); assert.equal(f.effects(), 0);
});

test("repeated delivery SSR does not share state across owners", () => {
  const a = fixture(), b = fixture();
  closed(a.render()); closed(b.render()); closed(a.render());
  assert.equal(a.effects(), 0); assert.equal(b.effects(), 0);
  assert.equal(a.workspace.getSnapshot(), null); assert.equal(b.workspace.getSnapshot(), null);
});

test("delivery status is a non-tabbable explicit-focus target without SSR autofocus", () => {
  const f = fixture(), html = f.render();
  const status = html.match(/<p\b[^>]*data-testid="analysis-delivery-status"[^>]*>/)?.[0];
  assert.ok(status); assert.match(status, /\brole="status"/); assert.match(status, /\btabindex="-1"/);
  assert.doesNotMatch(html, /\bautofocus(?:\s|=|>)/i);
  closed(html); assert.equal(f.effects(), 0); assert.equal(f.clocks(), 0);
  // SSR can establish markup/inertness only. Native focus and synchronous
  // focus-listener revocation require the separate actual browser regression.
});
