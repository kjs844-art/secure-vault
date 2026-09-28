import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttentionList } from "../src/components/mvp-demo/AttentionList.tsx";
import { BenefitCard } from "../src/components/mvp-demo/BenefitCard.tsx";
import { DemoExperience } from "../src/components/mvp-demo/DemoExperience.tsx";
import { DemoNotice } from "../src/components/mvp-demo/DemoNotice.tsx";
import { EmptyState } from "../src/components/mvp-demo/EmptyState.tsx";
import { ErrorState } from "../src/components/mvp-demo/ErrorState.tsx";
import { ServiceList } from "../src/components/mvp-demo/ServiceList.tsx";
import { buildDemoData, collectAttention, DEMO_NOTICE, type DemoBenefit } from "../src/lib/mvp-demo-data.ts";

// Synthetic server-rendered markup only. No DOM, browser clicks, keyboard event
// dispatch, focus/scroll, hydration, screen reader, or mobile layout is exercised.
// These checks do not replace the separate browser verification or prove an
// account, a current balance, provider access, authentication, or persistence.
const REFERENCE = Date.parse("2026-09-27T23:30:00.000Z"); // September 28 in Korea.
const render = (element: ReactElement) => renderToStaticMarkup(element);
const visibleText = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const demo = () => render(createElement(DemoExperience, { referenceTime: REFERENCE }));
function fixtureBenefit(id: string, patch: Partial<DemoBenefit> = {}): DemoBenefit {
  const benefit = buildDemoData(REFERENCE).benefits.find((entry) => entry.id === id);
  assert.ok(benefit, `Missing synthetic fixture: ${id}`);
  return { ...benefit, ...patch };
}
function card(id: string, patch: Partial<DemoBenefit> = {}): string {
  return render(createElement(BenefitCard, { benefit: fixtureBenefit(id, patch) }));
}

test("the normal demo renders four synthetic service sections and six distinct benefit cards", () => {
  const markup = demo();
  const dataset = buildDemoData(REFERENCE);
  assert.equal([...markup.matchAll(/<section\b[^>]*aria-labelledby="demo-svc-[^"]+-title"/g)].length, 4);
  assert.equal([...markup.matchAll(/<article\b/g)].length, 6);
  for (const service of dataset.services) {
    assert.ok(markup.includes(`id="demo-svc-${service.id}"`));
    assert.ok(visibleText(markup).includes(service.name));
  }
  for (const benefit of dataset.benefits) {
    assert.ok(markup.includes(`id="${benefit.id}-name"`));
    assert.ok(visibleText(markup).includes(benefit.name));
  }
  assert.match(visibleText(markup), /샘플 서비스 4 모두 합성 예시/);
  assert.match(visibleText(markup), /샘플 혜택 6 서로 다른 혜택의 잔량은 합산하지 않음/);
});

test("demo disclosure stays visible and offers no real credential input or external link", () => {
  const markup = demo();
  const text = visibleText(markup);
  assert.match(text, /KEYATLAS DEMO/);
  assert.ok(text.includes(DEMO_NOTICE));
  assert.match(text, /실제 메일·키·로그인을 요청하지 않습니다/);
  assert.match(text, /실제 가입 내역을 조회한 결과가 아닙니다/);
  assert.doesNotMatch(text, /예상 수익|실시간 잔액|현재 계정 확인 완료/);
  assert.doesNotMatch(markup, /<(?:form|input|textarea|script|iframe|img)\b/i);
  for (const link of markup.matchAll(/href="([^"]*)"/g)) assert.ok(link[1]!.startsWith("#") || link[1] === "/");
});

test("request uses and drink coupons remain separate rather than becoming thirteen verified uses", () => {
  const text = visibleText(demo());
  assert.match(text, /남음 12 회/);
  assert.match(text, /남음 1 회/);
  assert.doesNotMatch(text, /(?:^|\s)13\s*회(?:\s|$)/);
  assert.doesNotMatch(text, /확인된 값만 합산|기준 남은 혜택/);
  assert.match(text, /서로 다른 혜택의 잔량은 합산하지 않음/);
});

test("unknown remaining amounts render as unknown and never gain a zero-valued meter", () => {
  const unknown = card("demo-b-4");
  assert.match(visibleText(unknown), /남음 모름 · 지급 모름/);
  assert.match(visibleText(unknown), /모름 값 유지/);
  assert.doesNotMatch(unknown, /role="meter"|aria-valuenow/);
  assert.doesNotMatch(visibleText(unknown), /0 GB/);
  const trial = card("demo-b-6");
  assert.match(visibleText(trial), /남음 모름 · 지급 14 일/);
  assert.match(visibleText(trial), /메일 분석 \(합성 예시\)/);
  assert.match(visibleText(trial), /현재 남은 기간이 없어 잔량 확인 필요/);
  assert.doesNotMatch(trial, /role="meter"|aria-valuenow/);
});

test("a recorded zero remains zero while a known positive denominator supplies a zero meter", () => {
  const markup = card("demo-b-2");
  assert.match(visibleText(markup), /남음 0 개 · 지급 100 개/);
  assert.match(markup, /role="meter"/);
  assert.match(markup, /aria-valuemin="0"/);
  assert.match(markup, /aria-valuemax="100"/);
  assert.match(markup, /aria-valuenow="0"/);
  assert.match(markup, /aria-label="오프라인 저장 남은 비율"/);
  assert.doesNotMatch(visibleText(markup), /남음 모름/);
});

test("invalid or missing ratio operands never render a misleading percentage", () => {
  for (const remaining_amount of [null, NaN, Infinity, -1]) {
    const markup = card("demo-b-3", { remaining_amount });
    assert.match(visibleText(markup), /남음 모름/);
    assert.doesNotMatch(markup, /role="meter"|aria-valuenow|NaN|Infinity/);
  }
  for (const granted_amount of [null, 0, NaN, Infinity, -1]) {
    const markup = card("demo-b-3", { granted_amount });
    assert.doesNotMatch(markup, /role="meter"|aria-valuenow|NaN|Infinity/);
  }
});

test("monthly caps render separately and do not replace the granted-amount ratio denominator", () => {
  const requests = card("demo-b-3");
  assert.match(visibleText(requests), /남음 12 회 · 지급 50 회/);
  assert.match(visibleText(requests), /별도 월 상한 200 회/);
  assert.match(visibleText(requests), /월 200회 상한이 별도로 적용됩니다/);
  assert.match(requests, /aria-valuenow="24"/);
  assert.doesNotMatch(requests, /aria-valuenow="6"/);
  assert.match(visibleText(card("demo-b-5")), /별도 월 상한 4 회/);
  assert.match(visibleText(card("demo-b-5", { monthly_cap: null })), /별도 월 상한 모름/);
  assert.match(visibleText(card("demo-b-5", { monthly_cap: 0 })), /별도 월 상한 0 회/);
});

test("source descriptions, benefit names and extra notes remain escaped text", () => {
  const text = '합성 <em data-demo="x">태그</em> & 설명';
  const markup = card("demo-b-6", { name: text, source_note: text, extra_limit_note: text });
  assert.ok(markup.includes("&lt;em"));
  assert.ok(markup.includes("&lt;/em&gt;"));
  assert.ok(markup.includes("&amp; 설명"));
  assert.doesNotMatch(markup, /<em\b|<script\b|<iframe\b/i);
  assert.match(visibleText(markup), /메일 분석 \(합성 예시\)/);
  assert.doesNotMatch(markup, /href=|src=/);
});

test("keyboard-facing markup has native buttons, a skip target and valid unique heading references", () => {
  const markup = demo();
  assert.match(markup, /href="#demo-services"/);
  assert.match(markup, /<section\b[^>]*id="demo-services"[^>]*tabindex="-1"/);
  assert.match(visibleText(markup), /화살표 위\/아래로 이동/);
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!);
  assert.equal(ids.length, new Set(ids).size);
  for (const match of markup.matchAll(/aria-labelledby="([^"]+)"/g)) {
    for (const reference of match[1]!.split(" ")) assert.ok(ids.includes(reference), reference);
  }
  const buttons = [...markup.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
  assert.ok(buttons.length >= 4);
  for (const button of buttons) assert.match(button, /type="button"/);
  assert.equal([...markup.matchAll(/aria-pressed="true"/g)].length, 1);
  assert.equal([...markup.matchAll(/aria-pressed="false"/g)].length, 3);
  // These attributes are not evidence that Arrow keys, scrolling or focus work.
});

test("attention markup preserves synthetic uncertainty and its buttons do not run during SSR", () => {
  const items = collectAttention(buildDemoData(REFERENCE), new Date(REFERENCE));
  let calls = 0;
  const markup = render(createElement(AttentionList, { items, onFocusService: () => { calls++; } }));
  assert.equal([...markup.matchAll(/<li\b/g)].length, items.length);
  assert.equal([...markup.matchAll(/<button\b[^>]*type="button"/g)].length, items.length);
  assert.match(visibleText(markup), /확인 필요/);
  assert.match(visibleText(markup), /잔량 0/);
  assert.match(visibleText(markup), /해당 서비스 보기/);
  assert.equal(calls, 0);
});

test("empty services, empty benefits and empty attention use explicit status fallbacks", () => {
  const dataset = buildDemoData(REFERENCE);
  const emptyServices = render(createElement(ServiceList, { dataset: { ...dataset, services: [], benefits: [] },
    selectedId: null, onSelect: () => {} }));
  assert.match(emptyServices, /role="status"/);
  assert.match(visibleText(emptyServices), /표시할 서비스가 없습니다/);
  assert.match(visibleText(emptyServices), /실제 계정을 연결하지 않았습니다/);
  assert.doesNotMatch(emptyServices, /<article\b|<button\b/);
  const first = dataset.services[0]!;
  const emptyBenefits = render(createElement(ServiceList, { dataset: { ...dataset, services: [first], benefits: [] },
    selectedId: first.id, onSelect: () => {} }));
  assert.match(visibleText(emptyBenefits), /혜택 기록 없음/);
  assert.doesNotMatch(emptyBenefits, /<article\b/);
  const emptyAttention = render(createElement(AttentionList, { items: [], onFocusService: () => {} }));
  assert.match(emptyAttention, /role="status"/);
  assert.match(visibleText(emptyAttention), /지금 확인할 항목 없음/);
  assert.doesNotMatch(emptyAttention, /<button\b/);
});

test("error state has an alert and only renders a retry button when supplied an action", () => {
  const markup = render(createElement(ErrorState));
  assert.match(markup, /role="alert"/);
  assert.match(visibleText(markup), /화면을 불러오지 못했습니다/);
  assert.match(visibleText(markup), /실제 계정이나 메일에 연결하지 않았습니다/);
  assert.doesNotMatch(markup, /<button\b/);
  let calls = 0;
  const retry = render(createElement(ErrorState, { onRetry: () => { calls++; } }));
  assert.match(retry, /<button\b[^>]*type="button"/);
  assert.match(visibleText(retry), /다시 시도/);
  assert.equal(calls, 0);
});

test("an invalid demo seed fails to a demo-labelled error without invented records or internal details", () => {
  for (const referenceTime of [NaN, Infinity]) {
    const markup = render(createElement(DemoExperience, { referenceTime }));
    assert.ok(visibleText(markup).includes(DEMO_NOTICE));
    assert.match(markup, /role="alert"/);
    assert.match(markup, /href="\/"/);
    assert.match(visibleText(markup), /처음으로 돌아가기/);
    assert.doesNotMatch(markup, /<article\b|aria-valuenow|DEMO_REFERENCE_TIME_INVALID|NaN|Infinity/);
    assert.doesNotMatch(visibleText(markup), /다시 시도/);
  }
});

test("notices, empty states and errors also escape interpolated synthetic text", () => {
  const synthetic = "합성 <strong>표시</strong> & 안내";
  for (const markup of [render(createElement(DemoNotice, { extra: synthetic })),
    render(createElement(EmptyState, { title: synthetic, detail: synthetic })),
    render(createElement(ErrorState, { title: synthetic, detail: synthetic }))]) {
    assert.ok(markup.includes("&lt;strong&gt;표시&lt;/strong&gt;"));
    assert.ok(markup.includes("&amp; 안내"));
    assert.doesNotMatch(markup, /<strong>표시<\/strong>/);
  }
});

test("the same seed renders identically and the reference day is Korean regardless of process timezone", () => {
  const originalTimezone = process.env.TZ;
  try {
    // Only this synthetic test process changes; restored even after assertion failure.
    const outputs = ["UTC", "America/Los_Angeles", "Asia/Seoul"].map((timezone) => {
      process.env.TZ = timezone;
      const markup = demo();
      assert.match(visibleText(markup), /샘플 기준일: 9월 28일 \(한국 시간\)/);
      assert.equal(demo(), markup);
      return markup;
    });
    assert.equal(new Set(outputs).size, 1);
    const nextDay = render(createElement(DemoExperience, { referenceTime: REFERENCE + 86_400_000 }));
    assert.match(visibleText(nextDay), /샘플 기준일: 9월 29일 \(한국 시간\)/);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});
