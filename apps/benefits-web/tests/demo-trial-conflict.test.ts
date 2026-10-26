import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceList } from "../src/components/mvp-demo/ServiceList.tsx";
import { getDemoBenefitHistoryReason, selectDemoHistoryView } from "../src/lib/demo-benefit-history.ts";
import { buildDemoData, collectAttention, getDemoBenefitReviewReason, type DemoService } from "../src/lib/mvp-demo-data.ts";

// Synthetic display facts only. A recorded future expiry is not proof that an
// explicitly ended service trial can still be used.
const now = Date.parse("2026-10-18T00:00:00.000Z");
const iso = (offset: number) => new Date(now + offset).toISOString();
const base = buildDemoData(now);
const service: DemoService = { ...base.services[1]!, trial_ends_at: iso(-1) };
const benefit = { ...base.benefits[0]!, service_id: service.id,
  benefit_kind: "trial" as const, expires_at: iso(1), remaining_amount: 5, granted_amount: 14 };

for (const owner of [service, { ...service, trial_ends_at: iso(0) },
  { ...service, subscription_status: "trial_ended" as const },
  { ...service, subscription_status: "trial_ended" as const, trial_ends_at: null }]) {
  test(`future benefit with ended service stays visibly unconfirmed: ${owner.subscription_status}/${owner.trial_ends_at}`, () => {
    const source = { ...base, services: [owner], benefits: [benefit] };
    const before = structuredClone(source);
    assert.equal(getDemoBenefitHistoryReason(benefit, owner, now), null);
    assert.deepEqual(selectDemoHistoryView(source, "history", now).benefits, []);
    const review = selectDemoHistoryView(source, "review", now);
    const reason = getDemoBenefitReviewReason(benefit, owner, now);
    assert.match(reason ?? "", /확인 필요/);
    const attention = collectAttention(review, new Date(now));
    assert.equal(attention.filter(({ id }) => id === `expiry-${benefit.id}`).length, 1);
    assert.equal(attention.find(({ id }) => id === `expiry-${benefit.id}`)!.detail, reason);
    const markup = renderToStaticMarkup(createElement(ServiceList, { dataset: review,
      selectedId: owner.id, onSelect: () => {}, referenceTime: now }));
    assert.match(markup, /<strong>확인 필요<\/strong>/);
    assert.match(markup, /기록된 잔량/);
    assert.doesNotMatch(markup, /role="meter"|기록 당시 잔량/);
    assert.deepEqual(source, before);
  });
}

test("ended-trial conflict does not apply to unrelated service, credit or unknown service facts", () => {
  for (const owner of [undefined, { ...service, id: "synthetic-other" },
    { ...service, subscription_status: "active" as const },
    { ...service, trial_ends_at: iso(1) }, { ...service, trial_ends_at: null },
    { ...service, trial_ends_at: "2026-10-17" },
    { ...service, subscription_status: "trial_ended" as const, trial_ends_at: "2026-02-30T00:00:00.000Z" },
    { ...service, subscription_status: "trial_ended" as const, trial_ends_at: iso(1) }]) {
    assert.equal(getDemoBenefitReviewReason(benefit, owner, now), null);
  }
  assert.equal(getDemoBenefitReviewReason({ ...benefit, benefit_kind: "credit" }, service, now), null);
  for (const reference of [NaN, Infinity, 9e20]) {
    assert.equal(getDemoBenefitReviewReason(benefit, service, reference), null);
  }
});

test("matching canonical expiry still moves to history exactly at the benefit deadline", () => {
  const ended = { ...benefit, expires_at: iso(0) };
  assert.equal(getDemoBenefitReviewReason(ended, service, now), null);
  assert.match(getDemoBenefitHistoryReason(ended, service, now) ?? "", /기록상 만료/);
  assert.equal(getDemoBenefitReviewReason(benefit, service, now + 1), null);
  assert.match(getDemoBenefitHistoryReason(benefit, service, now + 1) ?? "", /기록상 만료/);
});
