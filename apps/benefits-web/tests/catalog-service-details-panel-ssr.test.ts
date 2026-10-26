import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { CatalogServiceDetailsPanel } from "../src/components/review-workspace/CatalogServiceDetailsPanel.tsx";
import { CatalogServiceDetails } from "../src/components/review-workspace/CatalogServiceDetails.tsx";
import { createCatalogSelectionSource, type CatalogSelectionSource } from "../src/domain/catalog-client/selection-source.ts";
import { CATALOG_VIEW_SCHEMA, decodeCatalogSuccess, type CatalogServiceProfileView, type CatalogServiceView } from "../src/domain/catalog-client/responses.ts";
import { createReviewWorkspace, type ReviewWorkspace } from "../src/domain/review-client/workspace.ts";
import { createReviewGetRequest } from "../src/domain/review-client/requests.ts";

// SSR and pure renderer evidence only. Hydration, synchronous revocation,
// keyboard/focus and native lifecycle require separate actual-browser evidence.
const CONTEXT = Object.freeze({ bindingId: "synthetic-service-detail-scope", dataGeneration: 1 });
const PROFILE: CatalogServiceProfileView = Object.freeze({ name: "SYNTHETIC_DETAIL_SERVICE_NAME",
  provider: "SYNTHETIC_DETAIL_PROVIDER", planName: "SYNTHETIC_DETAIL_PLAN", accountLabel: "SYNTHETIC_DETAIL_ACCOUNT",
  timezone: "Asia/Seoul", subscriptionStatus: "unknown", trialEndsAt: "2028-02-29", notes: "SYNTHETIC_DETAIL_NOTES\nSECOND_SYNTHETIC_LINE" });
function record(profile: CatalogServiceProfileView = PROFILE, timestamps = { createdAt: 0, updatedAt: 1790000000001 }): CatalogServiceView {
  const decoded = decodeCatalogSuccess("get", { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1,
    serviceId: "synthetic-detail-service", serviceRevision: 3, state: "live", ...timestamps,
    provenance: "user-reported", accountProof: "not-established", profile });
  assert.equal(decoded?.kind, "view");
  if (decoded?.kind !== "view") throw Error("SYNTHETIC_DETAIL_FIXTURE_INVALID");
  return decoded.view;
}
function fixture() {
  const row = record(); let transport = 0, clocks = 0;
  const client = Object.freeze({ origin: "https://synthetic.invalid", fetch: async () => {
    transport++;
    return new Response(JSON.stringify({ ok: true, value: { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1,
      catalogRevision: 1, services: [row], nextCursor: null } }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } });
  const workspace = createReviewWorkspace({ client, clocks: () => { clocks++; return { wall: 1790000000000, monotonic: 1 }; } });
  const source = createCatalogSelectionSource(client);
  return { row, workspace, source, counts: () => ({ transport, clocks }),
    dispose() { source.dispose(); workspace.dispose(); } };
}
function observed<T extends ReviewWorkspace | CatalogSelectionSource>(owner: T) {
  const calls: string[] = [];
  const wrapped = Object.fromEntries(Object.entries(owner).map(([key, method]) => [key, (...args: unknown[]) => {
    calls.push(key); return Reflect.apply(method as (...args: unknown[]) => unknown, owner, args);
  }])) as T;
  return { calls, wrapped };
}
function panel(workspace: ReviewWorkspace, source: CatalogSelectionSource, context: unknown = CONTEXT) {
  return createElement(CatalogServiceDetailsPanel, { workspace, source, context });
}
function closed(html: string) {
  assert.match(html, /data-testid="catalog-service-details-panel" data-phase="closed" data-open="no"/);
  assert.match(html, /불러온 서비스 기록 상세/);
  assert.doesNotMatch(html, /<(?:input|textarea|select|button|fieldset|dl)\b|\sstyle=|\sdata-service-id=/i);
  assert.doesNotMatch(html, /data-testid="catalog-service-(?:details-content|detail-disclosure|detail-toggle|details)"/);
  assert.doesNotMatch(html, /catalog-service-details-search|불러온 서비스에서 찾기|검색어 지우기/);
  for (const marker of [CONTEXT.bindingId, "synthetic-detail-service", ...Object.values(PROFILE)]) {
    if (typeof marker === "string") assert.equal(html.includes(marker), false, "No loaded service fields in SSR HTML");
  }
}

test("closed SSR does not read owners or run requests, clocks, timers or identifiers", (t) => {
  const f = fixture(), workspace = observed(f.workspace), source = observed(f.source);
  t.mock.method(globalThis, "fetch", () => { throw Error("NO_DETAIL_SSR_FETCH"); });
  t.mock.method(Date, "now", () => { throw Error("NO_DETAIL_SSR_CLOCK"); });
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_DETAIL_SSR_TIMER"); });
  t.mock.method(globalThis, "setInterval", () => { throw Error("NO_DETAIL_SSR_INTERVAL"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_DETAIL_SSR_ID"); });
  closed(renderToString(createElement(StrictMode, null, panel(workspace.wrapped, source.wrapped))));
  assert.deepEqual(workspace.calls, []); assert.deepEqual(source.calls, []);
  assert.deepEqual(f.counts(), { transport: 0, clocks: 0 }); f.dispose();
});

test("populated source and active workspace remain private and untouched during SSR", async (t) => {
  const f = fixture(), lease = f.workspace.activate(CONTEXT); assert.ok(lease);
  const initial = f.source.activate({ lease, context: CONTEXT }); assert.ok(initial);
  assert.equal(await f.source.next(initial), true);
  assert.equal(f.source.getSnapshot()?.services[0]?.profile?.name, PROFILE.name);
  const command = f.workspace.prepare(lease, createReviewGetRequest("synthetic-held-detail-read"));
  assert.equal(command.kind, "prepared");
  const beforeWorkspace = f.workspace.getSnapshot(), beforeSource = f.source.getSnapshot(), counts = f.counts();
  const workspace = observed(f.workspace), source = observed(f.source);
  t.mock.method(Date, "now", () => { throw Error("NO_POPULATED_SSR_CLOCK"); });
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_POPULATED_SSR_TIMER"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_POPULATED_SSR_ID"); });
  for (const context of [CONTEXT, null, { ...CONTEXT, bindingId: "synthetic-other-detail-scope" }, { ...CONTEXT, dataGeneration: 2 }])
    closed(renderToString(createElement(StrictMode, null, panel(workspace.wrapped, source.wrapped, context))));
  assert.deepEqual(workspace.calls, []); assert.deepEqual(source.calls, []);
  assert.equal(f.workspace.getSnapshot(), beforeWorkspace); assert.equal(f.source.getSnapshot(), beforeSource);
  assert.deepEqual(f.counts(), counts);
  // No release/prepare/cancel/deactivate owner methods ran while rendering.
  t.mock.restoreAll(); f.dispose();
});

test("malformed contexts remain closed without invoking accessors or conversions", () => {
  const f = fixture(), workspace = observed(f.workspace), source = observed(f.source); let getters = 0;
  const getter = Object.defineProperty({ dataGeneration: 1 }, "bindingId", { enumerable: true,
    get() { getters++; throw Error("NO_DETAIL_CONTEXT_GETTER"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const context of [undefined, null, {}, [], getter, revoked.proxy, Object.create(CONTEXT),
    { ...CONTEXT, bindingId: " padded " }, { ...CONTEXT, dataGeneration: 0 }, { ...CONTEXT, extra: true }])
    closed(renderToString(panel(workspace.wrapped, source.wrapped, context)));
  assert.equal(getters, 0); assert.deepEqual(workspace.calls, []); assert.deepEqual(source.calls, []);
  assert.deepEqual(f.counts(), { transport: 0, clocks: 0 }); f.dispose();
});

test("multiple SSR panels keep heading IDs distinct without sharing owner state", () => {
  const a = fixture(), b = fixture();
  const html = renderToString(createElement(StrictMode, null, panel(a.workspace, a.source), panel(b.workspace, b.source)));
  closed(html);
  const headings = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(headings.length, 2); assert.equal(new Set(headings).size, 2);
  for (const id of headings) assert.ok(html.includes(`id="${id}"`));
  assert.deepEqual(a.counts(), { transport: 0, clocks: 0 }); assert.deepEqual(b.counts(), { transport: 0, clocks: 0 });
  a.dispose(); b.dispose();
});

test("pure renderer shows all eight existing fields and exact epoch timestamp units", () => {
  const row = record(), html = renderToString(createElement(CatalogServiceDetails, { record: row }));
  assert.equal((html.match(/data-testid="catalog-service-detail-value-/g) ?? []).length, 8);
  for (const field of Object.keys(PROFILE)) assert.ok(html.includes(`data-testid="catalog-service-detail-value-${field}"`));
  assert.match(html, /detail-createdAt">0<\/dd>/);
  assert.match(html, /detail-updatedAt">1790000000001<\/dd>/);
  assert.equal((html.match(/Unix epoch 밀리초/g) ?? []).length, 2);
  assert.match(html, /detail-value-trialEndsAt"[^>]*>2028-02-29<\/dd>/);
  assert.match(html, /detail-value-timezone"[^>]*>Asia\/Seoul<\/dd>/);
  assert.match(html, /사용자 진술 \(user-reported\)/);
  assert.match(html, /확인되지 않음 \(not-established\)/);
  assert.match(html, /현재 상태나 만료 여부를 추론하지 않습니다/);
});

test("nulls remain unknown and dated offsets/nanoseconds are not reformatted", () => {
  for (const trialEndsAt of [null, "2028-02-29", "2028-02-29T01:02:03.123456789+09:00"]) {
    const row = record({ ...PROFILE, provider: null, planName: null, accountLabel: null, timezone: null, notes: null, trialEndsAt });
    const html = renderToString(createElement(CatalogServiceDetails, { record: row }));
    for (const field of ["provider", "planName", "accountLabel", "timezone"])
      assert.match(html, new RegExp(`detail-value-${field}"[^>]*>모름 \\(null\\)</dd>`));
    const displayedDate = /detail-value-trialEndsAt"[^>]*>([^<]*)<\/dd>/.exec(html)?.[1];
    assert.equal(displayedDate, trialEndsAt ?? "모름 (null)");
    assert.match(html, /detail-value-notes"[^>]*>모름 \(null\)<\/dd>/);
  }
});

test("notes preserve line breaks and HTML-like profile values remain escaped text", () => {
  const row = record({ ...PROFILE, name: "Synthetic <script>alert(1)</script>",
    provider: 'Synthetic <img src=x onerror="alert(1)">', notes: "Synthetic <b>line one</b>\n<&> line two" });
  const html = renderToString(createElement(CatalogServiceDetails, { record: row }));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /Synthetic &lt;b&gt;line one&lt;\/b&gt;\n&lt;&amp;&gt; line two/);
  assert.match(html, /white-space:pre-wrap/);
  assert.doesNotMatch(html, /<(?:script|img|iframe|b|input|select|textarea)\b/i);
});

test("all profile values preserve repeated internal spaces visually and as text", () => {
  const profile = { ...PROFILE, name: "Synthetic  service", provider: "Synthetic  provider",
    planName: "Synthetic  plan", accountLabel: "Synthetic  account" };
  const html = renderToString(createElement(CatalogServiceDetails, { record: record(profile) }));
  const values = [...html.matchAll(/data-testid="catalog-service-detail-value-([A-Za-z]+)"([^>]*)>([^]*?)<\/dd>/g)];
  assert.equal(values.length, 8);
  for (const [, field, attributes, text] of values) {
    assert.match(attributes!, /white-space:pre-wrap/);
    assert.match(attributes!, /overflow-wrap:anywhere/);
    if (["name", "provider", "planName", "accountLabel"].includes(field!))
      assert.equal(text, profile[field as "name" | "provider" | "planName" | "accountLabel"]);
  }
});

test("definition list uses only consistent div groups containing one dt and one dd", () => {
  const html = renderToString(createElement(CatalogServiceDetails, { record: record() }));
  const dl = /<dl>([\s\S]*?)<\/dl>/.exec(html)?.[1]; assert.ok(dl);
  const groups = [...dl.matchAll(/<div><dt>[^]*?<\/dt><dd\b[^]*?<\/dd><\/div>/g)];
  assert.equal(groups.length, 14);
  assert.equal(groups.map((group) => group[0]).join(""), dl);
  for (const [group] of groups) {
    assert.equal((group.match(/<dt>/g) ?? []).length, 1);
    assert.equal((group.match(/<dd\b/g) ?? []).length, 1);
  }
});

test("deleted/null-profile rows render nothing and cannot resurrect former profile values", () => {
  const live = record();
  const deleted = decodeCatalogSuccess("get", { ...live, state: "deleted", profile: null });
  assert.equal(deleted?.kind, "view"); if (deleted?.kind !== "view") throw Error("SYNTHETIC_DELETED_DETAIL_INVALID");
  assert.equal(renderToString(createElement(CatalogServiceDetails, { record: deleted.view })), "");
  assert.equal(renderToString(createElement(CatalogServiceDetails, { record: { ...live, profile: null } })), "");
});

test("pure renderer is inert and leaves frozen DTO unchanged", (t) => {
  const row = record(), before = JSON.stringify(row);
  t.mock.method(Date, "now", () => { throw Error("NO_RENDERER_CLOCK"); });
  t.mock.method(globalThis, "fetch", () => { throw Error("NO_RENDERER_FETCH"); });
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_RENDERER_TIMER"); });
  t.mock.method(globalThis, "setInterval", () => { throw Error("NO_RENDERER_INTERVAL"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_RENDERER_ID"); });
  assert.match(renderToString(createElement(CatalogServiceDetails, { record: row })), /SYNTHETIC_DETAIL_SERVICE_NAME/);
  assert.equal(JSON.stringify(row), before);
});
