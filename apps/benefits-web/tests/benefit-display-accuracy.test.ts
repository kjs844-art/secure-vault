import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceList } from "../src/components/mvp-demo/ServiceList.tsx";
import { selectDemoHistoryView } from "../src/lib/demo-benefit-history.ts";
import { buildDemoData, collectAttention, daysUntil } from "../src/lib/mvp-demo-data.ts";

// These regressions use existing public display APIs, so the pre-fix failures
// demonstrate contradictory output rather than missing newly added exports.
const NOW = Date.parse("2026-02-28T00:00:00.000Z");
const instant = (offset: number) => new Date(NOW + offset).toISOString();
// The current visual meter has inline styles, not a benefit-meter class.
// Check its actual element independently of accessibility attributes.
const VISUAL_METER = /class="[^"]*\bbenefit-meter\b|<div\b[^>]*style="[^"]*\bheight:0\.4rem(?:;|")/;

test("impossible calendar dates cannot turn into a trial countdown", () => {
  assert.equal(daysUntil("2026-02-30T00:00:00.000Z", new Date(NOW)), null);
});

for (const [name, benefitExpiry, trialExpiry] of [
  ["past benefit with future service trial", instant(-1), instant(1)],
  ["future benefit with ended service trial", instant(1), instant(-1)],
  ["date-only benefit expiry", "2026-02-28", instant(1)],
] as const) {
  test(`${name} remains reviewable without claiming spendable balance`, () => {
    const source = buildDemoData(NOW);
    const owner = { ...source.services[1]!, trial_ends_at: trialExpiry };
    const row = { ...source.benefits[0]!, service_id: owner.id,
      benefit_kind: "trial" as const, expires_at: benefitExpiry, granted_amount: 14, remaining_amount: 5 };
    const dataset = { ...source, services: [owner], benefits: [row] };
    const before = structuredClone(dataset);
    const review = selectDemoHistoryView(dataset, "review", NOW);
    assert.deepEqual(review.benefits, [row]);
    assert.deepEqual(selectDemoHistoryView(dataset, "history", NOW).benefits, []);
    const markup = renderToStaticMarkup(createElement(ServiceList, {
      dataset: review, selectedId: owner.id, onSelect: () => {}, referenceTime: NOW,
    }));
    assert.match(markup, /<strong>확인 필요<\/strong>/);
    assert.match(markup, /기록된 잔량/);
    assert.doesNotMatch(markup, /role="meter"|aria-valuenow|기록 당시 잔량/);
    assert.doesNotMatch(markup, VISUAL_METER);
    assert.equal(collectAttention(review, new Date(NOW))
      .filter(({ id, kind }) => id === `expiry-${row.id}` && kind === "needs_review").length, 1);
    assert.deepEqual(dataset, before);
  });
}
