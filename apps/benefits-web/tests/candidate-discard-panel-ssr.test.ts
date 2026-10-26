import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { CandidateDiscardPanel } from "../src/components/review-workspace/CandidateDiscardPanel.tsx";
import { createReviewWorkspace } from "../src/domain/review-client/workspace.ts";
import { createCandidateBatchReader } from "../src/domain/candidate-batch-reader.ts";
import { createCandidateSelectionFixture } from "./support/candidate-selection-fixture.ts";

const ORIGIN = "https://synthetic.invalid", CONTEXT = { bindingId: "synthetic-discard-ssr", dataGeneration: 1 };
test("discard SSR remains closed and inert even with populated private workspace/batch owners", async (t) => {
  const data = await createCandidateSelectionFixture();
  let calls = 0;
  const forbidden = () => { calls++; throw Error("SYNTHETIC_SSR_PORT_FORBIDDEN"); };
  let forbidClocks = false;
  const workspace = createReviewWorkspace({ client: { origin: ORIGIN, fetch: forbidden },
    clocks: () => forbidClocks ? forbidden() : { wall: 1790000000000, monotonic: 1 } });
  const lease = workspace.activate(CONTEXT); assert.ok(lease);
  forbidClocks = true;
  const context = { ...CONTEXT, batchReference: data.locator.batchReference };
  const reader = createCandidateBatchReader(async () => ({ kind: "success", context, batch: data.batch }));
  const start = reader.activate({ lease, context }); assert.ok(start); assert.equal(await reader.read(start), true);
  const before = { workspace: workspace.getSnapshot(), reader: reader.getSnapshot() };
  t.mock.method(globalThis, "fetch", forbidden); t.mock.method(globalThis, "setTimeout", forbidden);
  t.mock.method(globalThis, "setInterval", forbidden); t.mock.method(Date, "now", forbidden);
  const html = renderToString(createElement(StrictMode, null, createElement(CandidateDiscardPanel, {
    workspace, reader, context: CONTEXT, batchReference: context.batchReference,
    client: { origin: ORIGIN, fetch: forbidden, now: forbidden },
  })));
  assert.match(html, /data-testid="candidate-discard" data-phase="closed"/);
  assert.doesNotMatch(html, /<(?:input|select|textarea)\b|data-testid="candidate-discard-(?:target|receipt)"/);
  for (const candidate of data.batch.candidates) assert.equal(html.includes(candidate.candidateId), false);
  for (const marker of [context.batchReference, CONTEXT.bindingId, "Synthetic trial offer", "Synthetic Service"])
    assert.equal(html.includes(marker), false);
  assert.equal(calls, 0); assert.equal(workspace.getSnapshot(), before.workspace); assert.equal(reader.getSnapshot(), before.reader);
  reader.dispose(); workspace.dispose();
});

test("discard SSR does not inspect snapshots or malformed candidate context values", (t) => {
  let calls = 0;
  const forbidden = () => { calls++; throw Error("SYNTHETIC_SSR_PORT_FORBIDDEN"); };
  const workspace = createReviewWorkspace({ client: { origin: ORIGIN, fetch: forbidden }, clocks: forbidden });
  const reader = createCandidateBatchReader(forbidden);
  const wrappedWorkspace = { ...workspace, getSnapshot: forbidden, subscribe: forbidden };
  const wrappedReader = { ...reader, getSnapshot: forbidden, subscribe: forbidden };
  const getter = Object.defineProperty({ dataGeneration: 1 }, "bindingId", { enumerable: true, get: forbidden });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  t.mock.method(globalThis, "fetch", forbidden); t.mock.method(globalThis, "setTimeout", forbidden);
  for (const context of [null, {}, getter, revoked.proxy, { ...CONTEXT, dataGeneration: 0 }]) {
    const html = renderToString(createElement(CandidateDiscardPanel, { workspace: wrappedWorkspace, reader: wrappedReader,
      context, batchReference: "synthetic-discard-reference", client: { origin: ORIGIN, fetch: forbidden } }));
    assert.match(html, /data-phase="closed"/); assert.doesNotMatch(html, /<(?:input|select|textarea)\b/);
  }
  assert.equal(calls, 0); reader.dispose(); workspace.dispose();
});
