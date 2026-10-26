import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { CatalogServiceDeletePanel } from "../src/components/review-workspace/CatalogServiceDeletePanel.tsx";
import { createReviewWorkspace, type ReviewWorkspace } from "../src/domain/review-client/workspace.ts";
import { createReviewGetRequest } from "../src/domain/review-client/requests.ts";
import { createCatalogSelectionSource, type CatalogSelectionSource } from "../src/domain/catalog-client/selection-source.ts";
import type { CatalogViewControllerConfig } from "../src/domain/catalog-client/view-controller.ts";
import { CATALOG_VIEW_SCHEMA } from "../src/domain/catalog-client/responses.ts";

// SSR only. Native selection/focus, hydration, deletion, reconciliation and
// transaction races require separate browser/server evidence; none is implied.
const CONTEXT = Object.freeze({ bindingId: "synthetic-delete-panel-binding", dataGeneration: 1 });
const ROW = Object.freeze({ schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, serviceId: "synthetic-delete-service",
  serviceRevision: 3, state: "live", createdAt: 1790000000000, updatedAt: 1790000000001,
  provenance: "user-reported", accountProof: "not-established", profile: Object.freeze({
    name: "SYNTHETIC_DELETE_NAME", provider: "SYNTHETIC_DELETE_PROVIDER", planName: "SYNTHETIC_DELETE_PLAN",
    accountLabel: "SYNTHETIC_DELETE_ACCOUNT", timezone: "Asia/Seoul", subscriptionStatus: "unknown",
    trialEndsAt: "2027-01-02", notes: "SYNTHETIC_DELETE_NOTES",
  }) });
function fixture() {
  let transportCalls = 0, clockCalls = 0, callbackCalls = 0;
  const client: CatalogViewControllerConfig = Object.freeze({ origin: "https://synthetic.invalid", fetch: async () => {
    transportCalls++;
    return new Response(JSON.stringify({ ok: true, value: { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1,
      catalogRevision: 1, services: [ROW], nextCursor: null } }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } });
  const workspace = createReviewWorkspace({ client, clocks: () => {
    clockCalls++; return { wall: 1790000000000, monotonic: 1 };
  } });
  const source = createCatalogSelectionSource(client);
  const rejectCallback = () => { callbackCalls++; throw Error("NO_SSR_CALLBACK"); };
  return { workspace, source, client, rejectCallback, counts: () => ({ transportCalls, clockCalls, callbackCalls }),
    dispose() { source.dispose(); workspace.dispose(); } };
}
function observed<T extends ReviewWorkspace | CatalogSelectionSource>(owner: T) {
  const calls: string[] = [];
  const wrapped = Object.fromEntries(Object.entries(owner).map(([key, method]) => [key, (...args: unknown[]) => {
    calls.push(key); return Reflect.apply(method as (...args: unknown[]) => unknown, owner, args);
  }])) as T;
  return { wrapped, calls };
}
function element(f: ReturnType<typeof fixture>, workspace: ReviewWorkspace, source: CatalogSelectionSource,
  context: unknown = CONTEXT, client = f.client) {
  return createElement(CatalogServiceDeletePanel, { workspace, source, context, client,
    createOperationId: f.rejectCallback, onCatalogInvalidated: f.rejectCallback, onAuthorityRejected: f.rejectCallback });
}
function closed(html: string) {
  assert.match(html, /data-testid="catalog-service-delete-panel"/);
  assert.match(html, /data-phase="closed"/);
  assert.match(html, /서비스 기록 삭제/);
  assert.doesNotMatch(html, /<(?:input|textarea|select|button)\b/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /data-testid="catalog-service-delete-(?:content|preview|result)"/);
  for (const marker of [CONTEXT.bindingId, ROW.serviceId, ...Object.values(ROW.profile)]) {
    if (typeof marker === "string") assert.equal(html.includes(marker), false, "SSR disclosed synthetic row/context data");
  }
}

test("delete SSR is closed and performs no owner queries, callbacks, timers, clocks, IDs or HTTP", (t) => {
  const f = fixture(), workspace = observed(f.workspace), source = observed(f.source);
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_SSR_TIMER"); });
  t.mock.method(globalThis, "setInterval", () => { throw Error("NO_SSR_INTERVAL"); });
  t.mock.method(globalThis, "fetch", () => { throw Error("NO_SSR_FETCH"); });
  t.mock.method(Date, "now", () => { throw Error("NO_SSR_CLOCK"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_SSR_UUID"); });
  closed(renderToString(createElement(StrictMode, null, element(f, workspace.wrapped, source.wrapped))));
  assert.deepEqual(workspace.calls, []); assert.deepEqual(source.calls, []);
  assert.deepEqual(f.counts(), { transportCalls: 0, clockCalls: 0, callbackCalls: 0 });
  assert.equal(f.workspace.getSnapshot(), null); assert.equal(f.source.getSnapshot(), null); f.dispose();
});

test("delete SSR hides loaded data and preserves an active review lease and prepared benefit command", async (t) => {
  const f = fixture(), lease = f.workspace.activate(CONTEXT); assert.ok(lease);
  const page = f.source.activate({ lease, context: CONTEXT }); assert.ok(page);
  assert.equal(await f.source.next(page), true);
  assert.equal(f.source.getSnapshot()?.services[0]?.profile?.name, ROW.profile.name);
  const command = f.workspace.prepare(lease, createReviewGetRequest("synthetic-held-benefit"));
  assert.equal(command.kind, "prepared");
  const beforeWorkspace = f.workspace.getSnapshot(), beforeSource = f.source.getSnapshot(), counts = f.counts();
  const workspace = observed(f.workspace), source = observed(f.source);
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_SSR_TIMER"); });
  t.mock.method(Date, "now", () => { throw Error("NO_SSR_CLOCK"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_SSR_UUID"); });
  closed(renderToString(element(f, workspace.wrapped, source.wrapped)));
  assert.deepEqual(workspace.calls, []); assert.deepEqual(source.calls, []);
  assert.equal(f.workspace.getSnapshot(), beforeWorkspace); assert.equal(f.source.getSnapshot(), beforeSource);
  assert.deepEqual(f.counts(), counts); f.dispose();
});

test("delete SSR invalid contexts remain closed and do not invoke ordinary context getters", () => {
  const f = fixture(), workspace = observed(f.workspace), source = observed(f.source); let reads = 0;
  const getter = Object.defineProperty({ dataGeneration: 1 }, "bindingId", {
    enumerable: true, get() { reads++; throw Error("NO_CONTEXT_GETTER"); },
  });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const context of [null, undefined, {}, [], getter, revoked.proxy, Object.create(CONTEXT),
    { ...CONTEXT, dataGeneration: 0 }, { ...CONTEXT, bindingId: " padded " }, { ...CONTEXT, extra: true }]) {
    closed(renderToString(element(f, workspace.wrapped, source.wrapped, context)));
  }
  assert.equal(reads, 0); assert.deepEqual(workspace.calls, []); assert.deepEqual(source.calls, []);
  assert.deepEqual(f.counts(), { transportCalls: 0, clockCalls: 0, callbackCalls: 0 }); f.dispose();
});

test("delete SSR A-B-A/source/client identities cannot activate or retire existing owners", () => {
  const a = fixture(), b = fixture(), aWorkspace = observed(a.workspace), bWorkspace = observed(b.workspace);
  const aSource = observed(a.source), bSource = observed(b.source);
  a.workspace.activate(CONTEXT); b.workspace.activate({ bindingId: "synthetic-delete-b", dataGeneration: 2 });
  const aBefore = a.workspace.getSnapshot(), bBefore = b.workspace.getSnapshot(), aCounts = a.counts(), bCounts = b.counts();
  for (const [workspace, source, client] of [[aWorkspace.wrapped, aSource.wrapped, a.client],
    [bWorkspace.wrapped, bSource.wrapped, b.client], [aWorkspace.wrapped, bSource.wrapped, b.client],
    [aWorkspace.wrapped, aSource.wrapped, a.client]] as const) {
    closed(renderToString(element(a, workspace, source, CONTEXT, client)));
  }
  assert.deepEqual([...aWorkspace.calls, ...bWorkspace.calls, ...aSource.calls, ...bSource.calls], []);
  assert.equal(a.workspace.getSnapshot(), aBefore); assert.equal(b.workspace.getSnapshot(), bBefore);
  assert.deepEqual(a.counts(), aCounts); assert.deepEqual(b.counts(), bCounts); a.dispose(); b.dispose();
});

test("two closed delete panels have distinct accessible heading IDs and inert status text", () => {
  const f = fixture();
  const html = renderToString(createElement(StrictMode, null,
    element(f, f.workspace, f.source), element(f, f.workspace, f.source)));
  closed(html);
  const labels = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(labels.length, 2); assert.equal(new Set(labels).size, 2);
  for (const label of labels) assert.equal(html.includes(`id="${label}"`), true);
  assert.equal([...html.matchAll(/role="status" aria-live="polite" aria-atomic="true"/g)].length, 2);
  assert.deepEqual(f.counts(), { transportCalls: 0, clockCalls: 0, callbackCalls: 0 }); f.dispose();
});

test("closed delete guidance distinguishes local deletion, missing list evidence and uncertain close", () => {
  const f = fixture(), html = renderToString(element(f, f.workspace, f.source));
  closed(html);
  assert.match(html, /외부 계정·구독·원본 메일·메일 후보를 삭제하지 않습니다/);
  assert.match(html, /지난 혜택도 자동으로 지우지 않으며/);
  assert.match(html, /목록에 보이지 않는다고 삭제 가능한 것은 아닙니다/);
  assert.match(html, /이미 보낸 삭제를 되돌리지 않습니다/);
  assert.match(html, /새 화면에서는 기존 기록을 먼저 확인하세요/);
  assert.deepEqual(f.counts(), { transportCalls: 0, clockCalls: 0, callbackCalls: 0 }); f.dispose();
});
