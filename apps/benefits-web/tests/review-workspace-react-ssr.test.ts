import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { createReviewWorkspace, type ReviewWorkspace } from "../src/domain/review-client/workspace.ts";
import { createReviewGetRequest, createReviewPreviewRequest } from "../src/domain/review-client/requests.ts";
import { useReviewWorkspace, type ReviewWorkspaceReactView } from "../src/hooks/useReviewWorkspace.ts";
import { createReviewPreviewDemoData } from "../src/lib/review-preview-demo-data.ts";

// Server-render-only evidence. This does not exercise hydration, StrictMode's
// browser effect replay, native visibility/bfcache, timers or actual auth/DB.
const NOW = 1790000000000;
const CONTEXT = Object.freeze({ bindingId: "synthetic-workspace-ssr", dataGeneration: 1 });
const PRIVATE_MARKER = "SYNTHETIC_WORKSPACE_SSR_PRIVATE";
function Screen({ workspace, context, inspect }: { workspace: ReviewWorkspace; context: unknown;
  inspect?: (view: ReviewWorkspaceReactView) => void }) {
  const view = useReviewWorkspace(workspace, context); inspect?.(view);
  return createElement("output", null, view.snapshot === null ? "inactive" : JSON.stringify(view.snapshot));
}
function fixture() {
  let clocks = 0, fetches = 0;
  const preview = structuredClone(createReviewPreviewDemoData("corrected-zero", NOW, 1));
  const mutableValues = preview.content.values as { name: string };
  mutableValues.name = PRIVATE_MARKER;
  const workspace = createReviewWorkspace({
    client: { origin: "https://synthetic.invalid", fetch: async (request) => {
      fetches++;
      const action = new URL(request.url).pathname.split("/").at(-1);
      const value = action === "preview" ? preview
        : action === "list" ? { schema: "keyatlas.reviewed-benefit-page.v1", dataGeneration: 1,
          benefitCollectionRevision: 1, benefits: [], nextCursor: null }
          : { schema: "keyatlas.reviewed-benefit-view.v1", dataGeneration: 1,
            benefitId: "synthetic-benefit", benefitRevision: 2, outcome: "deleted", content: null };
      return new Response(JSON.stringify({ ok: true, value }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } },
    clocks: () => { clocks++; return { wall: NOW, monotonic: 1 }; },
  });
  return { workspace, preview, counts: () => ({ clocks, fetches }) };
}
function observe(workspace: ReviewWorkspace) {
  const counts = new Map<string, number>();
  const wrapped = Object.fromEntries(Object.entries(workspace).map(([key, method]) => [key, (...args: unknown[]) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return Reflect.apply(method as (...args: unknown[]) => unknown, workspace, args);
  }])) as unknown as ReviewWorkspace;
  return { wrapped, counts };
}
function inert(view: ReviewWorkspaceReactView, input: unknown = {}, command: unknown = {}) {
  assert.ok(Object.isFrozen(view)); assert.equal(view.snapshot, null);
  assert.deepEqual(view.prepare(input), { kind: "inactive" });
  assert.equal(view.cancelPreview(), false); assert.equal(view.cancelPage(), false); assert.equal(view.restartList(), false);
  view.release(command); view.clear();
  return Promise.all([view.execute(command).then((result) => assert.deepEqual(result, { kind: "stale" })),
    view.nextPage().then((result) => assert.deepEqual(result, { kind: "unavailable" }))]);
}

test("SSR is inert across all workspace ports, timers, clocks, transport and UUID generation", async (t) => {
  const first = fixture(), second = fixture();
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_SSR_TIMER"); });
  t.mock.method(globalThis, "setInterval", () => { throw Error("NO_SSR_INTERVAL"); });
  t.mock.method(globalThis, "fetch", () => { throw Error("NO_SSR_FETCH"); });
  t.mock.method(Date, "now", () => { throw Error("NO_SSR_CLOCK"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_SSR_UUID"); });
  for (const f of [first, second]) {
    const observed = observe(f.workspace), pending: Promise<unknown>[] = [];
    const html = renderToString(createElement(StrictMode, null, createElement(Screen, { workspace: observed.wrapped,
      context: CONTEXT, inspect: (view) => { pending.push(inert(view)); } })));
    assert.equal(html, "<output>inactive</output>"); await Promise.all(pending);
    assert.equal(observed.counts.size, 0); assert.deepEqual(f.counts(), { clocks: 0, fetches: 0 });
    assert.equal(f.workspace.getSnapshot(), null); f.workspace.dispose();
  }
});

test("SSR does not expose or mutate a populated preview/list workspace or consume a prepared command", async (t) => {
  const f = fixture(), lease = f.workspace.activate(CONTEXT); assert.ok(lease);
  const prepared = f.workspace.prepare(lease, createReviewPreviewRequest("synthetic-candidate", 1,
    f.preview.content.serviceId, f.preview.content.serviceRevision, f.preview.content.values));
  assert.equal(prepared.kind, "prepared"); if (prepared.kind !== "prepared") throw Error("fixture-preview");
  assert.equal((await f.workspace.execute(lease, prepared.command)).kind, "success");
  assert.equal((await f.workspace.nextPage(lease)).kind, "success");
  const held = f.workspace.prepare(lease, createReviewGetRequest("synthetic-benefit"));
  assert.equal(held.kind, "prepared"); if (held.kind !== "prepared") throw Error("fixture-command");
  const before = f.workspace.getSnapshot(), beforeCounts = f.counts(), observed = observe(f.workspace);
  assert.equal(before?.preview.preview?.content.values.name, PRIVATE_MARKER);
  assert.equal(before?.list.phase, "end_observed");
  const pending: Promise<unknown>[] = [];
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_SSR_TIMER"); });
  t.mock.method(Date, "now", () => { throw Error("NO_SSR_CLOCK"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_SSR_UUID"); });
  const html = renderToString(createElement(Screen, { workspace: observed.wrapped, context: CONTEXT,
    inspect: (view) => { pending.push(inert(view, createReviewGetRequest("synthetic-benefit"), held.command)); } }));
  assert.equal(html, "<output>inactive</output>"); assert.equal(html.includes(PRIVATE_MARKER), false);
  await Promise.all(pending); assert.equal(observed.counts.size, 0);
  assert.equal(f.workspace.getSnapshot(), before); assert.deepEqual(f.counts(), beforeCounts);
  t.mock.restoreAll();
  assert.equal((await f.workspace.execute(lease, held.command)).kind, "success");
  assert.equal(f.counts().fetches, beforeCounts.fetches + 1); f.workspace.dispose();
});

test("malformed SSR contexts do not execute ordinary accessors or workspace methods", async () => {
  let getters = 0;
  const f = fixture(), observed = observe(f.workspace);
  const getter = Object.defineProperty({ dataGeneration: 1 }, "bindingId", {
    enumerable: true, get() { getters++; return "synthetic"; },
  });
  const setter = Object.defineProperty({ ...CONTEXT }, "dataGeneration", { enumerable: true, set() { getters++; } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const contexts = [null, undefined, "synthetic", [], {}, Object.create(CONTEXT), getter, setter,
    { ...CONTEXT, bindingId: "padded " }, { ...CONTEXT, bindingId: "synthetic\n" },
    { ...CONTEXT, dataGeneration: 0 }, { ...CONTEXT, dataGeneration: 1.5 }, { ...CONTEXT, dataGeneration: NaN },
    { ...CONTEXT, dataGeneration: Number.MAX_SAFE_INTEGER + 1 }, { ...CONTEXT, dataGeneration: "1" },
    { ...CONTEXT, ownerId: "synthetic" }, { ...CONTEXT, [Symbol("extra")]: 1 },
    Object.defineProperty({ ...CONTEXT }, "hidden", { value: true }),
    Object.defineProperty({ ...CONTEXT }, "bindingId", { enumerable: false }),
    new Proxy({}, { getPrototypeOf() { throw Error("synthetic-private-reflection"); } }), revoked.proxy];
  for (const context of contexts) {
    const pending: Promise<unknown>[] = [];
    assert.equal(renderToString(createElement(Screen, { workspace: observed.wrapped, context,
      inspect: (view) => { pending.push(inert(view)); } })), "<output>inactive</output>");
    await Promise.all(pending);
  }
  assert.equal(getters, 0); assert.equal(observed.counts.size, 0);
  assert.deepEqual(f.counts(), { clocks: 0, fetches: 0 }); f.workspace.dispose();
});

test("SSR callbacks never inspect unknown commands/requests or acquire a later live lifetime", async () => {
  const f = fixture(), observed = observe(f.workspace); let retained!: ReviewWorkspaceReactView, reflections = 0;
  const hostile = new Proxy({}, { getPrototypeOf() { reflections++; throw Error("NO_SSR_DECODE"); },
    ownKeys() { reflections++; throw Error("NO_SSR_DECODE"); }, get() { reflections++; throw Error("NO_SSR_DECODE"); } });
  assert.equal(renderToString(createElement(Screen, { workspace: observed.wrapped, context: CONTEXT,
    inspect: (view) => { retained = view; } })), "<output>inactive</output>");
  await inert(retained, hostile, hostile);
  const lease = f.workspace.activate(CONTEXT); assert.ok(lease);
  const before = f.workspace.getSnapshot(); await inert(retained, hostile, hostile);
  assert.equal(reflections, 0); assert.equal(observed.counts.size, 0); assert.equal(f.workspace.getSnapshot(), before);
  assert.equal(f.counts().fetches, 0); f.workspace.dispose();
});

test("plain/null-prototype/frozen contexts and alternating owners stay isolated at SSR null snapshot", async () => {
  const first = fixture(), second = fixture(), a = observe(first.workspace), b = observe(second.workspace);
  const contexts = [CONTEXT, Object.assign(Object.create(null), CONTEXT), Object.freeze({ ...CONTEXT }),
    { bindingId: "synthetic-other", dataGeneration: 2 }];
  for (const workspace of [a.wrapped, b.wrapped, a.wrapped]) for (const context of contexts) {
    let view!: ReviewWorkspaceReactView;
    assert.equal(renderToString(createElement(StrictMode, null, createElement(Screen, { workspace, context,
      inspect: (current) => { view = current; } }))), "<output>inactive</output>");
    await inert(view);
  }
  assert.equal(a.counts.size, 0); assert.equal(b.counts.size, 0);
  assert.deepEqual(first.counts(), { clocks: 0, fetches: 0 }); assert.deepEqual(second.counts(), { clocks: 0, fetches: 0 });
  first.workspace.dispose(); second.workspace.dispose();
});
