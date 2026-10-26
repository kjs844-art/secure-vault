import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttentionList } from "../src/components/mvp-demo/AttentionList.tsx";
import { BenefitCard } from "../src/components/mvp-demo/BenefitCard.tsx";
import { DemoExperience, demoSummaryStats } from "../src/components/mvp-demo/DemoExperience.tsx";
import { ServiceList } from "../src/components/mvp-demo/ServiceList.tsx";
import {
  buildDemoDataWithHistory, getDemoBenefitHistoryReason, selectDemoHistoryView,
} from "../src/lib/demo-benefit-history.ts";
import {
  buildDemoData, collectAttention, daysUntil, DEMO_DATASET_STAMP, DEMO_NOTICE, getDemoBenefitReviewReason, STATUS_LABELS,
  type DemoBenefit, type DemoDataset, type DemoService,
} from "../src/lib/mvp-demo-data.ts";

// 합성 SSR 마크업과 순수 함수만 확인한다. 원본 Claude checkout의 브라우저
// 보고서는 별도 근거이며, 이 선별 이식에 클릭·포커스·레이아웃 검증은 포함하지 않는다.
const REFERENCE = Date.parse("2026-10-15T03:00:00.000Z"); // 한국 시간 10월 15일 낮.
const DAY = 86_400_000;
const iso = (offset: number) => new Date(REFERENCE + offset).toISOString();
const render = (element: ReactElement) => renderToStaticMarkup(element);
const visibleText = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const articles = (markup: string) => [...markup.matchAll(/<article\b[\s\S]*?<\/article>/g)].map((match) => match[0]);
const expanded = () => buildDemoDataWithHistory(REFERENCE);
const historyView = () => selectDemoHistoryView(expanded(), "history", REFERENCE);
const reviewView = () => selectDemoHistoryView(expanded(), "review", REFERENCE);
const renderList = (dataset: DemoDataset, history: boolean) => render(createElement(ServiceList, {
  dataset, selectedId: dataset.services[0]?.id ?? null, onSelect: () => {}, historyView: history, referenceTime: REFERENCE,
}));
const dataset = (services: DemoService[], benefits: DemoBenefit[]): DemoDataset => ({
  dataset: DEMO_DATASET_STAMP, notice: DEMO_NOTICE, services, benefits,
});

test("history summary counts past records as records, not as current benefits or review items", () => {
  const history = historyView();
  const stats = demoSummaryStats("history", history, 0);
  const text = stats.map(({ label, value, detail }) => `${label} ${value} ${detail}`).join(" | ");
  assert.ok(stats.some(({ label, value }) => label === "지난 기록" && value === `${history.benefits.length}`), text);
  assert.match(text, /현재 사용할 수 있는 혜택이 아님/);
  assert.doesNotMatch(text, /샘플 혜택|살펴볼 항목|만료·모름·잔량/);
});

test("review summary keeps the original three labels and counts", () => {
  const review = reviewView();
  assert.deepEqual(demoSummaryStats("review", review, 5), [
    { label: "샘플 서비스", value: "4", detail: "모두 합성 예시" },
    { label: "샘플 혜택", value: "6", detail: "서로 다른 혜택의 잔량은 합산하지 않음" },
    { label: "살펴볼 항목", value: "5", detail: "만료·모름·잔량 0" },
  ]);
});

test("every history card is individually labelled past with no spendable wording or meter", () => {
  const cards = articles(renderList(historyView(), true));
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.match(card, /<strong>지난 기록<\/strong>/);
    assert.match(visibleText(card), /기록 당시 잔량/);
    assert.match(visibleText(card), /현재 잔액을 조회한 값이 아닙니다/);
    assert.doesNotMatch(visibleText(card), /(?:^|\s)남음\s/);
    assert.doesNotMatch(card, /role="meter"|aria-valuenow|비율을 계산할 수 없습니다/);
  }
});

test("history service headers never claim a current subscription state", () => {
  const history = historyView();
  const text = visibleText(renderList(history, true));
  for (const label of Object.values(STATUS_LABELS)) assert.ok(!text.includes(label), label);
  assert.equal(text.split("현재 계정 상태 미조회").length - 1, history.services.length);
});

test("review markup never carries past-record labels or recorded-at-the-time amounts", () => {
  for (const markup of [renderList(reviewView(), false),
    render(createElement(DemoExperience, { referenceTime: REFERENCE }))]) {
    assert.doesNotMatch(markup, /<strong>지난 기록<\/strong>|기록 당시 잔량|demo-b-history-/);
  }
});

test("the synthetic demo notice and no-lookup disclaimer precede every benefit card", () => {
  const markup = render(createElement(DemoExperience, { referenceTime: REFERENCE }));
  const firstCard = markup.indexOf("<article");
  assert.ok(firstCard > 0);
  for (const disclosure of [DEMO_NOTICE, "실제 메일·키·로그인을 요청하지 않습니다",
    "실제 가입 내역을 조회한 결과가 아닙니다", "현재 잔액·이용 가능 여부는 실제 조회한 것이 아닙니다"]) {
    const at = markup.indexOf(disclosure);
    assert.ok(at >= 0 && at < firstCard, disclosure);
  }
});

test("past-record markup makes no live-lookup, sync or full-mailbox claim", () => {
  const text = visibleText(renderList(historyView(), true));
  assert.doesNotMatch(text, /실시간|조회 완료|조회했습니다|연동 완료|연결됨|동기화|전체 메일|모든 메일|받은편지함/);
  assert.match(text, /합성/);
});

test("a non-canonical recorded date renders as 날짜 확인 필요, never raw or invalid", () => {
  const base = buildDemoData(REFERENCE).benefits[2]!;
  for (const value of ["", "2026-10-14", "2026-10-14T12:00:00+09:00", "2026-02-30T00:00:00.000Z", "not-a-date"]) {
    const text = visibleText(render(createElement(BenefitCard, {
      benefit: { ...base, expires_at: value, observed_at: value },
    })));
    assert.match(text, /기록 기준 날짜 확인 필요/);
    assert.match(text, /기록된 만료일 날짜 확인 필요/);
    assert.doesNotMatch(text, /Invalid Date|NaN/);
    if (value) assert.ok(!text.includes(value), value);
  }
});

test("every unknown remaining amount in the review view surfaces as a 확인 필요 attention item", () => {
  const review = reviewView();
  const attention = collectAttention(review, new Date(REFERENCE));
  const unknown = review.benefits.filter(({ remaining_amount }) => remaining_amount === null);
  assert.ok(unknown.length > 0);
  for (const benefit of unknown) {
    const item = attention.find(({ id }) => id === `review-${benefit.id}`);
    assert.ok(item, benefit.id);
    assert.equal(item.kind, "needs_review");
    assert.match(item.title, /확인 필요$/);
  }
  assert.ok(attention.every(({ id }) => !id.includes("history")));
  assert.match(visibleText(render(createElement(AttentionList, { items: attention, onFocusService: () => {} }))), /확인 필요/);
});


// QA 보고서 §5-1·§5-2의 재현 테스트. 처음에는 todo로 남겼고, lib의
// getDemoBenefitReviewReason을 추가한 뒤 일반 테스트로 바꿨다.
// 고정 합성 데이터에는 이런 행이 없지만, 실제 데이터 어댑터가 연결되면 나타날 수 있다.
const futureTrial: DemoService = {
  ...buildDemoData(REFERENCE).services[1]!, id: "qa-conflict-service",
  subscription_status: "trial", trial_ends_at: iso(DAY),
};
const pastExpiryTrial: DemoBenefit = {
  ...buildDemoData(REFERENCE).benefits[5]!, id: "qa-conflict-benefit", service_id: futureTrial.id,
  benefit_kind: "trial", granted_amount: 14, remaining_amount: 5, expires_at: iso(-DAY),
};

test("a trial benefit past its recorded expiry should not look spendable in the review view", () => {
  const source = dataset([futureTrial], [pastExpiryTrial]);
  const review = selectDemoHistoryView(source, "review", REFERENCE);
  assert.deepEqual(review.benefits.map(({ id }) => id), [pastExpiryTrial.id]);
  const markup = renderList(review, false);
  const attention = collectAttention(review, new Date(REFERENCE));
  const flagged = /확인 필요/.test(visibleText(articles(markup)[0] ?? ""))
    || attention.some(({ id, kind }) => id.includes(pastExpiryTrial.id) && kind === "needs_review");
  assert.ok(flagged, "expired-but-conflicting record is shown without a 확인 필요 label");
  assert.doesNotMatch(markup, /role="meter"/);
});

test("an ambiguous recorded expiry should be counted as a 확인 필요 item", () => {
  const owner = buildDemoData(REFERENCE).services[0]!;
  const ambiguous: DemoBenefit = { ...buildDemoData(REFERENCE).benefits[0]!, id: "qa-ambiguous-expiry",
    benefit_kind: "credit", remaining_amount: 2, expires_at: "2026-10-14" };
  const review = selectDemoHistoryView(dataset([owner], [ambiguous]), "review", REFERENCE);
  assert.deepEqual(review.benefits.map(({ id }) => id), [ambiguous.id]);
  const attention = collectAttention(review, new Date(REFERENCE));
  assert.ok(attention.some(({ id }) => id.includes(ambiguous.id)), "ambiguous expiry is not in the attention list");
});

// 위 두 재현보다 엄격한 확인: 카드 메모의 "확인 필요" 문구가 아니라 표시 라벨과 집계 항목을 직접 본다.
const ambiguousOwner = buildDemoData(REFERENCE).services[0]!;
const ambiguousExpiry: DemoBenefit = { ...buildDemoData(REFERENCE).benefits[0]!, id: "qa-ambiguous-expiry",
  benefit_kind: "credit", remaining_amount: 2, expires_at: "2026-10-14" };
const conflictingReview = () => selectDemoHistoryView(
  dataset([futureTrial, ambiguousOwner], [pastExpiryTrial, ambiguousExpiry]), "review", REFERENCE);

test("the review reason flags a conflicting past trial expiry and every non-canonical expiry", () => {
  assert.match(getDemoBenefitReviewReason(pastExpiryTrial, futureTrial, REFERENCE) ?? "", /확인 필요/);
  // 혜택 만료 시각이 기준 시각과 같아도 지난 것으로 본다(지난 기록 규칙과 같은 경계).
  assert.match(getDemoBenefitReviewReason({ ...pastExpiryTrial, expires_at: iso(0) }, futureTrial, REFERENCE) ?? "", /확인 필요/);
  for (const value of ["", "2026-10-14", "2026-10-14T12:00:00+09:00", "2026-02-30T00:00:00.000Z", "not-a-date"]) {
    assert.match(getDemoBenefitReviewReason({ ...ambiguousExpiry, expires_at: value }, ambiguousOwner, REFERENCE) ?? "",
      /확인 필요/, JSON.stringify(value));
  }
});

test("ordinary current rows and past records get no review reason", () => {
  const ordinary = buildDemoData(REFERENCE);
  for (const row of ordinary.benefits) {
    assert.equal(getDemoBenefitReviewReason(row, ordinary.services.find(({ id }) => id === row.service_id), REFERENCE), null);
  }
  assert.equal(getDemoBenefitReviewReason({ ...pastExpiryTrial, expires_at: iso(1) }, futureTrial, REFERENCE), null);
  assert.equal(getDemoBenefitReviewReason({ ...pastExpiryTrial, expires_at: null }, futureTrial, REFERENCE), null);
  // 과거 만료 크레딧, 이미 끝난 체험, 짝이 없는 체험은 지난 기록으로 가므로 확인 사유가 없다.
  assert.equal(getDemoBenefitReviewReason({ ...pastExpiryTrial, benefit_kind: "credit" }, futureTrial, REFERENCE), null);
  assert.equal(getDemoBenefitReviewReason(pastExpiryTrial, { ...futureTrial, trial_ends_at: iso(0) }, REFERENCE), null);
  assert.equal(getDemoBenefitReviewReason(pastExpiryTrial, undefined, REFERENCE), null);
  assert.equal(getDemoBenefitReviewReason(pastExpiryTrial, { ...futureTrial, id: "other" }, REFERENCE), null);
});

test("a row never carries both a history reason and a review reason", () => {
  const services = [futureTrial, { ...futureTrial, trial_ends_at: iso(-DAY) }, { ...futureTrial, subscription_status: "trial_ended" as const },
    { ...futureTrial, trial_ends_at: null }, ambiguousOwner];
  const rows = [...expanded().benefits, pastExpiryTrial, ambiguousExpiry,
    ...[iso(-DAY), iso(0), iso(1), "2026-10-14", null].map((expires_at) => ({ ...pastExpiryTrial, expires_at }))];
  for (const service of services) {
    for (const row of rows) {
      const owner = { ...service, id: row.service_id };
      assert.ok(getDemoBenefitHistoryReason(row, owner, REFERENCE) === null
        || getDemoBenefitReviewReason(row, owner, REFERENCE) === null, `${row.id} ${row.expires_at}`);
    }
  }
});

test("each review reason becomes one needs_review attention item for its service", () => {
  const review = conflictingReview();
  assert.deepEqual(review.benefits.map(({ id }) => id), [pastExpiryTrial.id, ambiguousExpiry.id]);
  const attention = collectAttention(review, new Date(REFERENCE));
  const expiryItems = attention.filter(({ id }) => id.startsWith("expiry-"));
  assert.deepEqual(expiryItems.map(({ id, kind, serviceId, detail }) => ({ id, kind, serviceId, detail })), [
    { id: `expiry-${pastExpiryTrial.id}`, kind: "needs_review", serviceId: futureTrial.id,
      detail: getDemoBenefitReviewReason(pastExpiryTrial, futureTrial, REFERENCE) },
    { id: `expiry-${ambiguousExpiry.id}`, kind: "needs_review", serviceId: ambiguousOwner.id,
      detail: getDemoBenefitReviewReason(ambiguousExpiry, ambiguousOwner, REFERENCE) },
  ]);
  for (const item of expiryItems) assert.match(item.title, /확인 필요$/);
  assert.equal(new Set(attention.map(({ id }) => id)).size, attention.length);
});

test("the fixed synthetic review still has exactly five attention items and no expiry item", () => {
  const attention = collectAttention(reviewView(), new Date(REFERENCE));
  assert.equal(attention.length, 5);
  assert.ok(attention.every(({ id }) => !id.startsWith("expiry-")));
  assert.ok(collectAttention(expanded(), new Date(REFERENCE)).every(({ id }) => !id.startsWith("expiry-")));
});

test("review cards with a review reason show a 확인 필요 label without spendable wording or a meter", () => {
  const cards = articles(renderList(conflictingReview(), false));
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.match(card, /<strong>확인 필요<\/strong>/);
    assert.match(visibleText(card), /기록된 잔량/);
    assert.doesNotMatch(visibleText(card), /(?:^|\s)남음\s/);
    assert.doesNotMatch(card, /role="meter"|aria-valuenow/);
    assert.doesNotMatch(card, /<strong>지난 기록<\/strong>|기록 당시 잔량/);
  }
});

test("ordinary review cards keep 남음 wording and their meter", () => {
  const cards = articles(renderList(reviewView(), false));
  assert.equal(cards.length, 6);
  assert.ok(cards.some((card) => /role="meter"/.test(card)));
  assert.ok(cards.every((card) => !/<strong>확인 필요<\/strong>/.test(card) && /(?:^|\s)남음\s/.test(visibleText(card))));
});

// Integration regression: service-level expiry must use the same strict instant
// policy as history, not Date's normalization of an impossible calendar date.
const INVALID_SERVICE_ENDS = [
  "2026-02-30T00:00:00.000Z", "2025-02-29T00:00:00.000Z",
  "2026-03-01", "2026-03-01T00:00:00", "2026-03-01T00:00:00Z",
  "2026-03-01T00:00:00.000+00:00", "2026-03-01T09:00:00.000+09:00",
  "2026-03-01T24:00:00.000Z", " 2026-03-01T00:00:00.000Z",
  "2026-03-01T00:00:00.000Z\n",
];

for (const value of INVALID_SERVICE_ENDS) {
  test(`non-canonical service trial expiry never becomes a countdown: ${JSON.stringify(value)}`, () => {
    const reference = Date.parse("2026-02-28T00:00:00.000Z");
    const owner = { ...futureTrial, trial_ends_at: value };
    const row = { ...pastExpiryTrial, expires_at: null, extra_limit_note: null };
    const source = dataset([owner], [row]);
    const before = structuredClone(source);
    const review = selectDemoHistoryView(source, "review", reference);
    assert.deepEqual(selectDemoHistoryView(source, "history", reference).benefits, []);
    assert.deepEqual(review.benefits, [row]);
    assert.equal(daysUntil(value, new Date(reference)), null);
    const items = collectAttention(review, new Date(reference));
    assert.equal(items.length, 1);
    assert.equal(items[0]!.id, `trial-${owner.id}`);
    assert.equal(items[0]!.kind, "needs_review");
    assert.doesNotMatch(items[0]!.detail, /\d+일 남음/);
    assert.deepEqual(source, before);
  });
}

test("a canonical service trial expiry keeps its explicit countdown and exact boundary", () => {
  const reference = Date.parse("2026-02-28T00:00:00.000Z");
  const owner = { ...futureTrial, trial_ends_at: "2026-03-02T00:00:00.000Z" };
  const row = { ...pastExpiryTrial, expires_at: null, extra_limit_note: null };
  const source = dataset([owner], [row]);
  assert.equal(daysUntil(owner.trial_ends_at, new Date(reference)), 2);
  const upcoming = collectAttention(selectDemoHistoryView(source, "review", reference), new Date(reference));
  assert.equal(upcoming[0]!.kind, "expiring");
  assert.equal(upcoming[0]!.detail, "2일 남음");
  assert.equal(daysUntil(owner.trial_ends_at, new Date(Date.parse(owner.trial_ends_at))), 0);
  assert.deepEqual(selectDemoHistoryView(source, "history", Date.parse(owner.trial_ends_at)).benefits, [row]);
});
