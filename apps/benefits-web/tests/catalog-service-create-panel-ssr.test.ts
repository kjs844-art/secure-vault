import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { CatalogServiceCreatePanel } from "../src/components/review-workspace/CatalogServiceCreatePanel.tsx";
import { createReviewWorkspace, type ReviewWorkspace } from "../src/domain/review-client/workspace.ts";
import { createReviewGetRequest } from "../src/domain/review-client/requests.ts";
import type { CatalogViewControllerConfig } from "../src/domain/catalog-client/view-controller.ts";

// SSR-only evidence. Hydration, async acknowledgement reconciliation, native
// lifecycle events and keyboard/focus are covered by the separate real browser
// harness; renderToString cannot establish those properties. SSR remains closed,
// so active optional-input labels, maxLength and disabled states are not asserted.
const CONTEXT = Object.freeze({ bindingId: "synthetic-create-panel-binding", dataGeneration: 1 });
function fixture() {
  let transportCalls = 0, clockCalls = 0, callbackCalls = 0;
  const client: CatalogViewControllerConfig = Object.freeze({
    origin: "https://synthetic.invalid",
    fetch: async () => { transportCalls++; throw Error("NO_SSR_TRANSPORT"); },
  });
  const workspace = createReviewWorkspace({ client, clocks: () => {
    clockCalls++; return { wall: 1790000000000, monotonic: 1 };
  } });
  const rejectCallback = () => { callbackCalls++; throw Error("NO_SSR_CALLBACK"); };
  return { workspace, client, rejectCallback, counts: () => ({ transportCalls, clockCalls, callbackCalls }) };
}
function observed(workspace: ReviewWorkspace) {
  const calls: string[] = [];
  const wrapped = Object.fromEntries(Object.entries(workspace).map(([key, method]) => [key, (...args: unknown[]) => {
    calls.push(key);
    return Reflect.apply(method as (...args: unknown[]) => unknown, workspace, args);
  }])) as unknown as ReviewWorkspace;
  return { wrapped, calls };
}
function render(f: ReturnType<typeof fixture>, workspace: ReviewWorkspace, context: unknown = CONTEXT) {
  return renderToString(createElement(StrictMode, null, createElement(CatalogServiceCreatePanel, {
    workspace, client: f.client, context, createOperationId: f.rejectCallback,
    onCatalogInvalidated: f.rejectCallback, onAuthorityRejected: f.rejectCallback,
  })));
}
function closed(html: string) {
  assert.match(html, /data-testid="catalog-service-create-panel"/);
  assert.match(html, /data-phase="closed"/);
  assert.match(html, /서비스 직접 등록/);
  assert.match(html, /계정 보유를 확인하지 않습니다/);
  assert.doesNotMatch(html, /<(?:input|textarea|select|button)\b/i);
  // Public closed SSR must also respect the existing style-src 'self' policy;
  // no inline style is needed until a browser-owned review lease is active.
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /data-testid="catalog-service-create-(?:content|preview|result)"/);
  assert.doesNotMatch(html, /catalog-service-create-notes|(?:id|for)="[^"]*-(?:notes|notes-hint)"/);
  assert.doesNotMatch(html, /aria-required=|(?:id|aria-describedby)="[^"]*-name-hint"|서비스 이름은 필수입니다/);
  assert.doesNotMatch(html, /catalog-service-create-(?:timezone|subscription-status|trial-ends-at)/);
  assert.doesNotMatch(html, /(?:id|for)="[^"]*-(?:timezone|subscriptionStatus|trialEndsAt|manual-facts-hint|timezone-hint|subscription-status-hint|trial-ends-at-hint)"/);
  assert.doesNotMatch(html, /synthetic-create-panel-binding|synthetic-held-service/);
}

test("create panel SSR is inert and closed: no transport, timers, UUID, clocks, IDs or host callbacks", (t) => {
  const f = fixture(), view = observed(f.workspace);
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_SSR_TIMER"); });
  t.mock.method(globalThis, "setInterval", () => { throw Error("NO_SSR_INTERVAL"); });
  t.mock.method(globalThis, "fetch", () => { throw Error("NO_SSR_FETCH"); });
  t.mock.method(Date, "now", () => { throw Error("NO_SSR_CLOCK"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_SSR_UUID"); });
  closed(render(f, view.wrapped));
  assert.deepEqual(view.calls, []);
  assert.deepEqual(f.counts(), { transportCalls: 0, clockCalls: 0, callbackCalls: 0 });
  assert.equal(f.workspace.getSnapshot(), null);
  f.workspace.dispose();
});

test("SSR keeps an already active review workspace and its prepared command untouched", () => {
  const f = fixture(), lease = f.workspace.activate(CONTEXT); assert.ok(lease);
  const prepared = f.workspace.prepare(lease, createReviewGetRequest("synthetic-held-service"));
  assert.equal(prepared.kind, "prepared");
  const before = f.workspace.getSnapshot(), counts = f.counts(), view = observed(f.workspace);
  closed(render(f, view.wrapped));
  assert.equal(f.workspace.getSnapshot(), before);
  assert.deepEqual(view.calls, []);
  assert.deepEqual(f.counts(), counts);
  // No component lifetime is attached during SSR; parent remains authoritative.
  assert.equal(f.workspace.getSnapshot()?.lease, lease);
  f.workspace.dispose();
});

test("malformed contexts fail closed without executing ordinary property getters", () => {
  const f = fixture(), view = observed(f.workspace); let reads = 0;
  const getter = Object.defineProperty({ dataGeneration: 1 }, "bindingId", {
    enumerable: true, get() { reads++; throw Error("NO_CONTEXT_GETTER"); },
  });
  for (const context of [null, undefined, {}, [], getter, Object.create(CONTEXT),
    { ...CONTEXT, dataGeneration: 0 }, { ...CONTEXT, bindingId: " padded " }, { ...CONTEXT, extra: true }]) {
    closed(render(f, view.wrapped, context));
  }
  assert.equal(reads, 0); assert.deepEqual(view.calls, []);
  assert.deepEqual(f.counts(), { transportCalls: 0, clockCalls: 0, callbackCalls: 0 });
  f.workspace.dispose();
});

test("revoked and throwing-reflection contexts remain closed instead of leaking an exception", () => {
  const f = fixture(), view = observed(f.workspace);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const hostile = new Proxy({}, { getPrototypeOf() { throw Error("SYNTHETIC_CONTEXT_REFLECTION"); } });
  closed(render(f, view.wrapped, revoked.proxy)); closed(render(f, view.wrapped, hostile));
  assert.deepEqual(view.calls, []);
  assert.deepEqual(f.counts(), { transportCalls: 0, clockCalls: 0, callbackCalls: 0 });
  f.workspace.dispose();
});

test("separate SSR render contexts including A-B-A, another generation and disposed owner never open controls", () => {
  const a = fixture(), b = fixture(), aView = observed(a.workspace), bView = observed(b.workspace);
  a.workspace.activate(CONTEXT); b.workspace.activate({ bindingId: "synthetic-other-owner", dataGeneration: 2 });
  const countsA = a.counts(), countsB = b.counts();
  const contexts = [CONTEXT, Object.assign(Object.create(null), CONTEXT),
    { bindingId: "synthetic-create-other", dataGeneration: 2 }, CONTEXT];
  for (const context of contexts) { closed(render(a, aView.wrapped, context)); closed(render(b, bView.wrapped, context)); }
  assert.deepEqual(aView.calls, []); assert.deepEqual(bView.calls, []);
  assert.deepEqual(a.counts(), countsA); assert.deepEqual(b.counts(), countsB);
  a.workspace.dispose(); b.workspace.dispose();
  closed(render(a, aView.wrapped)); assert.deepEqual(aView.calls, []);
});

test("closed SSR explains manually recorded profile facts without authentication claims or editable defaults", () => {
  const f = fixture(), view = observed(f.workspace);
  try {
    const html = render(f, view.wrapped);
    closed(html);
    assert.match(html, /서비스 이름·제공자·요금제 이름·계정 표시 이름은 사용자가 적는 기록용 이름/);
    assert.match(html, /로그인·계정 인증이나 제공자의 실제 요금제 변경이 아닙니다/);
    assert.match(html, /서비스 메모도 합성 기록 정리용입니다/);
    assert.match(html, /실제 개인정보·비밀번호·API 키를 입력하지 마세요/);
    assert.match(html, /시간대·구독 상태·체험 종료일도 사용자가 직접 적는 기록입니다/);
    assert.match(html, /제공자의 실제 상태를 확인하거나 변경하지 않으며/);
    assert.match(html, /기기 시간대나 다른 입력으로 자동 추론하지 않습니다/);
    assert.doesNotMatch(html, /<(?:option|select)\b|Asia\/Seoul|UTC|unknown|trial_ended|2028-02-29/);
    assert.doesNotMatch(html, /<(?:form|fieldset|label)\b|\s(?:value|defaultValue|disabled|maxLength|autocomplete)=/i);
    assert.doesNotMatch(html, /(?:id|for)="[^"]*-(?:planName|accountLabel|label-hint)"/);
    assert.deepEqual(view.calls, []);
    assert.deepEqual(f.counts(), { transportCalls: 0, clockCalls: 0, callbackCalls: 0 });
    assert.equal(f.workspace.getSnapshot(), null);
  } finally { f.workspace.dispose(); }
});
