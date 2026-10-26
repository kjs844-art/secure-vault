import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { ReviewedBenefitDetails } from "../src/components/review-workspace/ReviewedBenefitDetails.tsx";
import { ReviewWorkspacePanel } from "../src/components/review-workspace/ReviewWorkspacePanel.tsx";
import { decodeReviewedBenefitView, type ReviewedBenefitView } from "../src/domain/reviewed-benefit-view.ts";
import { createReviewedBenefitListDemoPage } from "../src/lib/reviewed-benefit-list-demo-data.ts";
import { createReviewWorkspace } from "../src/domain/review-client/workspace.ts";

const NOW = 1790000000000;
type Saved = Extract<ReviewedBenefitView, { readonly outcome: "saved" }>;
function fixture(): Saved {
  const row = createReviewedBenefitListDemoPage("last", NOW).benefits[0]!;
  const record = decodeReviewedBenefitView({ ...row, content: { ...row.content,
    serviceNameAtReview: "SYNTHETIC_DETAIL_SERVICE",
    values: { ...row.content.values, name: "SYNTHETIC_DETAIL_NAME", grantedAmount: 0, remainingAmount: null,
      trialDaysStated: 0, remainingDaysStated: null, expiresAt: "2028-02-29",
      observedAt: "2026-09-27T12:34:56.123456789+09:00" },
    valueOrigins: { ...row.content.valueOrigins, remainingAmount: "user-corrected", observedAt: "user-corrected" },
    receivedAt: "2026-09-26T01:02:03.123Z", extractedAt: "2026-09-28T00:00:00.000Z",
    sourceObservedAt: null, reviewedAt: "2026-09-28T04:05:06.000Z",
    reviewReasons: [...row.content.reviewReasons, "PARTIAL_MAIL_TEXT"],
  } });
  assert.equal(record?.outcome, "saved");
  if (record?.outcome !== "saved") throw Error("SYNTHETIC_DETAIL_FIXTURE_INVALID");
  return record;
}
function render(record = fixture()) {
  return renderToString(createElement(ReviewedBenefitDetails, { record }));
}

// Renderer/SSR evidence only; native open/close, focus and lifecycle are checked
// separately in the parent-owned actual-browser runner.
test("detail renderer exposes all nine recorded fields and their exact value origins", () => {
  const record = fixture(), html = render(record);
  for (const [field, value] of Object.entries(record.content.values)) {
    const printed = value === null ? "모름" : String(value);
    assert.ok(html.includes(`data-testid="reviewed-benefit-detail-value-${field}">${printed}</dd>`), field);
    const origin = record.content.valueOrigins[field as keyof typeof record.content.values] === "user-corrected"
      ? "사용자가 수정한 값" : "메일에서 추출된 값";
    assert.ok(html.includes(`data-testid="reviewed-benefit-detail-origin-${field}">${origin}</dd>`), field);
  }
  assert.equal((html.match(/data-testid="reviewed-benefit-detail-value-/g) ?? []).length, 9);
  assert.match(html, /SYNTHETIC_DETAIL_SERVICE/);
});

test("detail description list uses uniform div groups for fields and metadata", () => {
  const lists = [...render().matchAll(/<dl>([\s\S]*?)<\/dl>/g)];
  assert.equal(lists.length, 1);
  const contents = lists[0]![1]!;
  // This renderer emits text-only terms/descriptions, not arbitrary HTML. Check
  // the rendered structure without adding a DOM dependency or claiming AT QA.
  const group = /<div><dt>[^<]*<\/dt>(?:<dd(?: [^>]*)?>[^<]*<\/dd>)+<\/div>/g;
  assert.equal([...contents.matchAll(group)].length, 14,
    "service, nine recorded fields and four timestamps must each form a div group");
  assert.equal(contents.replace(group, ""), "",
    "a div-grouped dl must not also contain direct dt/dd children");
});

test("detail renderer preserves null versus zero and exact date precision without expiry inference", () => {
  const html = render();
  assert.match(html, /detail-value-grantedAmount">0<\/dd>/);
  assert.match(html, /detail-value-remainingAmount">모름<\/dd>/);
  assert.match(html, /detail-value-trialDaysStated">0<\/dd>/);
  assert.match(html, /detail-value-expiresAt">2028-02-29<\/dd>/);
  assert.match(html, /detail-value-observedAt">2026-09-27T12:34:56\.123456789\+09:00<\/dd>/);
  assert.match(html, /detail-receivedAt">2026-09-26T01:02:03\.123Z<\/dd>/);
  assert.match(html, /detail-sourceObservedAt">모름<\/dd>/);
  assert.match(html, /detail-extractedAt">2026-09-28T00:00:00\.000Z<\/dd>/);
  assert.match(html, /detail-reviewedAt">2026-09-28T04:05:06\.000Z<\/dd>/);
});

test("detail renderer keeps review reasons and not-established warnings after user review", () => {
  const record = fixture(), html = render(record);
  for (const reason of record.content.reviewReasons) assert.ok(html.includes(`data-review-reason="${reason}">${reason}</li>`));
  assert.match(html, /PARTIAL_MAIL_TEXT/);
  assert.match(html, /계정 보유 여부: 확인되지 않음/);
  assert.match(html, /현재 잔액: 확인되지 않음/);
  assert.match(html, /사용자 검토는 사실 인증이 아닙니다/);
  assert.match(html, /원문 메일은 이 상세에 포함되지 않습니다/);
});

test("detail renderer preserves an original offset observation separately from received time", () => {
  const original = fixture(), timestamp = "2026-09-27T12:34:56.123456789+09:00";
  const record = decodeReviewedBenefitView({ ...original, content: { ...original.content,
    receivedAt: null, sourceObservedAt: timestamp,
    valueOrigins: { ...original.content.valueOrigins, observedAt: "email-extracted" },
  } });
  assert.equal(record?.outcome, "saved");
  if (record?.outcome !== "saved") throw Error("SYNTHETIC_SOURCE_OBSERVATION_INVALID");
  const html = render(record);
  assert.ok(html.includes(`data-testid="reviewed-benefit-detail-sourceObservedAt">${timestamp}</dd>`));
  assert.match(html, /detail-receivedAt">모름<\/dd>/);
  assert.match(html, /detail-origin-observedAt">메일에서 추출된 값<\/dd>/);
});

test("detail renderer renders markup as text rather than active elements", () => {
  const original = fixture();
  const record = decodeReviewedBenefitView({ ...original, content: { ...original.content,
    serviceNameAtReview: 'Synthetic <img src=x onerror="alert(1)">',
    values: { ...original.content.values, name: "Synthetic <script>alert(1)</script>", unit: "<&>" },
  } });
  assert.equal(record?.outcome, "saved");
  if (record?.outcome !== "saved") throw Error("SYNTHETIC_MARKUP_FIXTURE_INVALID");
  const html = render(record);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;&amp;&gt;/);
  assert.doesNotMatch(html, /<(?:script|img|iframe|input|textarea|select)\b/i);
});

test("detail renderer is inert: no clocks, requests, timers, identifiers or mutation", (t) => {
  const record = fixture(), before = JSON.stringify(record);
  t.mock.method(Date, "now", () => { throw Error("NO_DETAIL_CLOCK"); });
  t.mock.method(globalThis, "fetch", () => { throw Error("NO_DETAIL_FETCH"); });
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_DETAIL_TIMER"); });
  t.mock.method(globalThis, "setInterval", () => { throw Error("NO_DETAIL_INTERVAL"); });
  t.mock.method(globalThis.crypto, "randomUUID", () => { throw Error("NO_DETAIL_ID"); });
  assert.match(render(record), /SYNTHETIC_DETAIL_NAME/);
  assert.equal(JSON.stringify(record), before);
});

test("parent SSR omits detail controls and protected content even with a populated live workspace", async (t) => {
  const record = fixture(), context = { bindingId: "synthetic-detail-ssr", dataGeneration: 1 };
  let calls = 0;
  const workspace = createReviewWorkspace({ client: { origin: "https://synthetic.invalid", fetch: async () => {
    calls++;
    return new Response(JSON.stringify({ ok: true, value: { ...createReviewedBenefitListDemoPage("last", NOW), benefits: [record] } }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } }, clocks: () => ({ wall: NOW, monotonic: 1 }) });
  const lease = workspace.activate(context); assert.ok(lease);
  assert.equal((await workspace.nextPage(lease)).kind, "success");
  const before = workspace.getSnapshot(), count = calls;
  t.mock.method(Date, "now", () => { throw Error("NO_PARENT_SSR_CLOCK"); });
  t.mock.method(globalThis, "setTimeout", () => { throw Error("NO_PARENT_SSR_TIMER"); });
  t.mock.method(globalThis, "fetch", () => { throw Error("NO_PARENT_SSR_FETCH"); });
  for (const current of [context, null, { ...context, bindingId: "synthetic-other-scope" }]) {
    const html = renderToString(createElement(StrictMode, null, createElement(ReviewWorkspacePanel, {
      workspace, context: current, draft: null, referenceTime: NOW,
      createOperationId: () => { throw Error("NO_PARENT_SSR_ID"); },
    })));
    assert.match(html, /data-open="no"/);
    assert.doesNotMatch(html, /reviewed-benefit-detail|review-record-details|review-detail-toggle|SYNTHETIC_DETAIL_|PARTIAL_MAIL_TEXT|2026-09-27T12:34:56/);
  }
  assert.equal(calls, count); assert.equal(workspace.getSnapshot(), before);
  t.mock.restoreAll(); workspace.dispose();
});
