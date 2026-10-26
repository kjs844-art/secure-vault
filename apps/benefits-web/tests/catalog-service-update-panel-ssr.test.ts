import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { CatalogServiceUpdatePanel } from "../src/components/review-workspace/CatalogServiceUpdatePanel.tsx";
import { createReviewWorkspace, type ReviewWorkspace } from "../src/domain/review-client/workspace.ts";
import { createReviewGetRequest } from "../src/domain/review-client/requests.ts";
import { createCatalogSelectionSource, type CatalogSelectionSource } from "../src/domain/catalog-client/selection-source.ts";
import type { CatalogViewControllerConfig } from "../src/domain/catalog-client/view-controller.ts";
import { CATALOG_VIEW_SCHEMA, type CatalogServiceProfileView } from "../src/domain/catalog-client/responses.ts";

// Server rendering only, not hydration, source-notification, actual focus,
// HTTP persistence, authority, async CAS or native lifecycle evidence. Optional
// input labels/maxLength/disabled states require client rendering: SSR stays closed.
const CONTEXT = Object.freeze({ bindingId: "synthetic-update-panel-binding", dataGeneration: 1 });
const ROW = Object.freeze({ schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, serviceId: "synthetic-update-service",
  serviceRevision: 3, state: "live", createdAt: 1790000000000, updatedAt: 1790000000001,
  provenance: "user-reported", accountProof: "not-established", profile: Object.freeze({
    name: "SYNTHETIC_UPDATE_NAME", provider: "SYNTHETIC_UPDATE_PROVIDER", planName: "SYNTHETIC_UPDATE_PLAN",
    accountLabel: "SYNTHETIC_UPDATE_ACCOUNT", timezone: "Asia/Seoul", subscriptionStatus: "unknown",
    trialEndsAt: "2027-01-02", notes: "SYNTHETIC_UPDATE_NOTES",
  }) });
function fixture(profileOverrides: Partial<Pick<CatalogServiceProfileView,
  "planName" | "accountLabel" | "notes" | "timezone" | "subscriptionStatus" | "trialEndsAt">> = ROW.profile) {
  let transportCalls = 0, clockCalls = 0, callbackCalls = 0;
  const row = Object.freeze({ ...ROW, profile: Object.freeze({ ...ROW.profile, ...profileOverrides }) });
  const client: CatalogViewControllerConfig = Object.freeze({ origin: "https://synthetic.invalid", fetch: async () => {
    transportCalls++;
    return new Response(JSON.stringify({ ok: true, value: { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1,
      catalogRevision: 1, services: [row], nextCursor: null } }), {
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
  return createElement(CatalogServiceUpdatePanel, { workspace, source, context, client,
    createOperationId: f.rejectCallback, onCatalogInvalidated: f.rejectCallback, onAuthorityRejected: f.rejectCallback });
}
function closed(html: string) {
  assert.match(html, /data-testid="catalog-service-update-panel"/);
  assert.match(html, /data-phase="closed"/);
  assert.match(html, /서비스 기록 수정/);
  assert.doesNotMatch(html, /<(?:input|textarea|select|button)\b/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /data-testid="catalog-service-update-(?:content|preview|result)"/);
  assert.doesNotMatch(html, /catalog-service-update-notes|(?:id|for)="[^"]*-(?:notes|notes-hint)"/);
  assert.doesNotMatch(html, /aria-required=|(?:id|aria-describedby)="[^"]*-name-hint"|서비스 이름은 필수입니다/);
  assert.doesNotMatch(html, /catalog-service-update-(?:timezone|subscription-status|trial-ends-at)/);
  assert.doesNotMatch(html, /(?:id|for)="[^"]*-(?:timezone|subscriptionStatus|trialEndsAt|manual-facts-hint|timezone-hint|subscription-status-hint|trial-ends-at-hint)"/);
  for (const marker of [CONTEXT.bindingId, ROW.serviceId, ...Object.values(ROW.profile)]) {
    if (typeof marker === "string") assert.equal(html.includes(marker), false, "SSR disclosed synthetic row/context data");
  }
}

test("update SSR starts closed without querying either owner or running callbacks, transport, timers, clocks or IDs", (t) => {
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

test("SSR cannot disclose loaded service fields or invalidate an active review lease and its prepared command", async (t) => {
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

test("SSR invalid and accessor contexts are closed without invoking ordinary getters", () => {
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

test("separate SSR A-B-A/source/client identities do not activate, retire or reconfigure live owners", () => {
  const a = fixture(), b = fixture(), aWorkspace = observed(a.workspace), bWorkspace = observed(b.workspace);
  const aSource = observed(a.source), bSource = observed(b.source);
  a.workspace.activate(CONTEXT); b.workspace.activate({ bindingId: "synthetic-update-b", dataGeneration: 2 });
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

test("two closed SSR update panels use distinct accessible heading IDs and expose no source content", () => {
  const f = fixture();
  const html = renderToString(createElement(StrictMode, null,
    element(f, f.workspace, f.source), element(f, f.workspace, f.source)));
  closed(html);
  const labels = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(labels.length, 2); assert.equal(new Set(labels).size, 2);
  for (const label of labels) assert.equal(html.includes(`id="${label}"`), true);
  assert.deepEqual(f.counts(), { transportCalls: 0, clockCalls: 0, callbackCalls: 0 }); f.dispose();
});

test("closed SSR describes manual profile editing without authentication or provider-change claims", () => {
  const f = fixture();
  try {
    const html = renderToString(element(f, f.workspace, f.source));
    closed(html);
    assert.match(html, /서비스 이름·제공자·요금제 이름·계정 표시 이름을 고칩니다/);
    assert.match(html, /사용자 진술이며 로그인·계정 인증이나 실제 가입·요금제·구독 변경이 아닙니다/);
    assert.match(html, /이미 검토한 혜택의 당시 서비스 이름은 보존됩니다/);
    assert.match(html, /서비스 메모도 합성 기록 정리용입니다/);
    assert.match(html, /실제 개인정보·비밀번호·API 키를 입력하지 마세요/);
    assert.match(html, /시간대·구독 상태·체험 종료일도 사용자가 직접 적는 기록입니다/);
    assert.match(html, /제공자의 실제 상태를 확인하거나 변경하지 않으며/);
    assert.match(html, /기기 시간대나 다른 입력으로 자동 추론하지 않습니다/);
    assert.match(html, /수정하지 않은 값은 원래 관찰 그대로 보존합니다/);
    assert.doesNotMatch(html, /<(?:option|select)\b|UTC|trial_ended|2028-02-29/);
    assert.doesNotMatch(html, /<(?:form|fieldset|label)\b|\s(?:disabled|maxLength|autocomplete)=/i);
    assert.deepEqual(f.counts(), { transportCalls: 0, clockCalls: 0, callbackCalls: 0 });
  } finally { f.dispose(); }
});

test("loaded null, maximal and multiline notes remain absent from closed SSR without owner calls", async () => {
  for (const notes of [null, "SYNTHETIC_NOTES_MAX_".padEnd(2048, "N"), "SYNTHETIC  <b>NOTES</b>\nSECOND  LINE"]) {
    const f = fixture({ notes });
    try {
      const lease = f.workspace.activate(CONTEXT); assert.ok(lease);
      const page = f.source.activate({ lease, context: CONTEXT }); assert.ok(page);
      assert.equal(await f.source.next(page), true);
      const beforeSource = f.source.getSnapshot(), beforeWorkspace = f.workspace.getSnapshot(), counts = f.counts();
      assert.equal(beforeSource?.services[0]?.profile?.notes, notes);
      const workspace = observed(f.workspace), source = observed(f.source);
      const html = renderToString(element(f, workspace.wrapped, source.wrapped));
      closed(html);
      assert.doesNotMatch(html, /<(?:textarea|b)\b|SYNTHETIC_NOTES_MAX_|SYNTHETIC  |SECOND  LINE/);
      if (notes !== null) {
        assert.equal(html.includes(notes), false);
        const escaped = notes.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        assert.equal(html.includes(escaped), false);
      }
      assert.deepEqual(workspace.calls, []); assert.deepEqual(source.calls, []);
      assert.equal(f.workspace.getSnapshot(), beforeWorkspace); assert.equal(f.source.getSnapshot(), beforeSource);
      assert.deepEqual(f.counts(), counts);
    } finally { f.dispose(); }
  }
});

test("loaded optional label nulls, maximum lengths and HTML-like values never become SSR fields or hidden defaults", async () => {
  const variants = [
    { planName: null, accountLabel: null },
    { planName: "SYNTHETIC_PLAN_".padEnd(160, "P"), accountLabel: "SYNTHETIC_ACCOUNT_".padEnd(160, "A") },
    { planName: "<b>SYNTHETIC_OPTIONAL_PLAN</b>", accountLabel: "<i>SYNTHETIC_OPTIONAL_ACCOUNT</i>" },
  ];
  for (const optionalLabels of variants) {
    const f = fixture(optionalLabels);
    try {
      const lease = f.workspace.activate(CONTEXT); assert.ok(lease);
      const page = f.source.activate({ lease, context: CONTEXT }); assert.ok(page);
      assert.equal(await f.source.next(page), true);
      const beforeSource = f.source.getSnapshot(), beforeWorkspace = f.workspace.getSnapshot();
      const loaded = beforeSource?.services[0]?.profile; assert.ok(loaded);
      assert.equal(loaded.planName, optionalLabels.planName);
      assert.equal(loaded.accountLabel, optionalLabels.accountLabel);
      const counts = f.counts(), workspace = observed(f.workspace), source = observed(f.source);
      const html = renderToString(element(f, workspace.wrapped, source.wrapped));
      closed(html);
      assert.doesNotMatch(html, /<(?:form|fieldset|label|b|i)\b|\s(?:value|defaultValue|hidden)=/i);
      assert.doesNotMatch(html, /(?:id|for)="[^"]*-(?:planName|accountLabel|label-hint)"/);
      for (const value of Object.values(optionalLabels)) {
        if (value !== null) {
          assert.equal(html.includes(value), false, "SSR disclosed an optional label");
          const escaped = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
          assert.equal(html.includes(escaped), false, "SSR disclosed an escaped optional label");
        }
      }
      assert.deepEqual(workspace.calls, []); assert.deepEqual(source.calls, []);
      assert.equal(f.workspace.getSnapshot(), beforeWorkspace); assert.equal(f.source.getSnapshot(), beforeSource);
      assert.deepEqual(f.counts(), counts);
    } finally { f.dispose(); }
  }
});

test("loaded manual timezone, all six statuses and literal trial dates stay private during closed SSR", async () => {
  const variants = [
    { timezone: null, subscriptionStatus: "unknown", trialEndsAt: null },
    { timezone: "Asia/Seoul", subscriptionStatus: "trial", trialEndsAt: "2028-02-29" },
    { timezone: "UTC", subscriptionStatus: "active", trialEndsAt: "2028-02-29T12:34:56.123456789+09:00" },
    { timezone: "America/New_York", subscriptionStatus: "trial_ended", trialEndsAt: "2028-02-29T12:34:56Z" },
    { timezone: "Europe/London", subscriptionStatus: "paused", trialEndsAt: "2028-02-29T12:34:56-05:00" },
    { timezone: null, subscriptionStatus: "cancelled", trialEndsAt: "2028-02-29T12:34:56.000000001+14:00" },
  ] as const;
  for (const facts of variants) {
    const f = fixture(facts);
    try {
      const lease = f.workspace.activate(CONTEXT); assert.ok(lease);
      const page = f.source.activate({ lease, context: CONTEXT }); assert.ok(page);
      assert.equal(await f.source.next(page), true);
      const beforeSource = f.source.getSnapshot(), beforeWorkspace = f.workspace.getSnapshot();
      const loaded = beforeSource?.services[0]?.profile; assert.ok(loaded);
      assert.equal(loaded.timezone, facts.timezone);
      assert.equal(loaded.subscriptionStatus, facts.subscriptionStatus);
      assert.equal(loaded.trialEndsAt, facts.trialEndsAt);
      const counts = f.counts(), workspace = observed(f.workspace), source = observed(f.source);
      const html = renderToString(element(f, workspace.wrapped, source.wrapped));
      closed(html);
      assert.doesNotMatch(html, /<(?:form|fieldset|label|option)\b|\s(?:value|defaultValue|hidden|selected)=/i);
      for (const value of Object.values(facts)) {
        if (value !== null) assert.equal(html.includes(value), false, "SSR disclosed a manual profile fact");
      }
      assert.deepEqual(workspace.calls, []); assert.deepEqual(source.calls, []);
      assert.equal(f.workspace.getSnapshot(), beforeWorkspace); assert.equal(f.source.getSnapshot(), beforeSource);
      assert.deepEqual(f.counts(), counts);
    } finally { f.dispose(); }
  }
});
