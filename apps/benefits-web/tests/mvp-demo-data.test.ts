import assert from "node:assert/strict";
import { test } from "node:test";
import { benefitsForService, buildDemoData, collectAttention, daysUntil, DEMO_DATASET_STAMP,
  DEMO_NOTICE, formatAmount, formatDay, isUnknownAmount, remainingRatio,
  type DemoBenefit, type DemoDataset, type DemoService } from "../src/lib/mvp-demo-data.ts";

// Pure synthetic display fixtures only; these are not account/balance evidence.
const REFERENCE = Date.parse("2026-09-28T12:34:56.789Z");
const DAY = 86_400_000;
const now = () => new Date(REFERENCE);
const benefit = (patch: Partial<DemoBenefit> = {}): DemoBenefit => ({
  ...buildDemoData(REFERENCE).benefits[0]!, ...patch,
});
const service = (patch: Partial<DemoService> = {}): DemoService => ({
  ...buildDemoData(REFERENCE).services[1]!, ...patch,
});
const dataset = (services: DemoService[] = [], benefits: DemoBenefit[] = []): DemoDataset => ({
  dataset: DEMO_DATASET_STAMP, notice: DEMO_NOTICE, services, benefits,
});

test("the seeded fixture retains four distinct synthetic services and six related benefits", () => {
  const value = buildDemoData(REFERENCE);
  assert.equal(value.dataset, "demo");
  assert.equal(value.notice, DEMO_NOTICE);
  assert.match(value.notice, /저장되지 않으며/);
  assert.equal(value.services.length, 4);
  assert.equal(value.benefits.length, 6);
  assert.equal(new Set(value.services.map(({ id }) => id)).size, 4);
  assert.equal(new Set(value.benefits.map(({ id }) => id)).size, 6);
  for (const row of value.benefits) assert.ok(value.services.some(({ id }) => id === row.service_id));
  assert.ok(value.benefits.some(({ remaining_amount }) => remaining_amount === null));
  assert.ok(value.benefits.some(({ remaining_amount }) => remaining_amount === 0));
});

test("every non-null synthetic timestamp is deterministically derived from the supplied epoch", () => {
  const value = buildDemoData(REFERENCE);
  assert.deepEqual(value.services.map(({ trial_ends_at }) => trial_ends_at), [
    null, "2026-10-04T00:00:00.000Z", null, "2026-10-02T00:00:00.000Z",
  ]);
  assert.deepEqual(value.benefits.map(({ observed_at }) => observed_at), [
    "2026-09-26T21:30:00.000Z", "2026-09-23T12:00:00.000Z", "2026-09-27T03:15:00.000Z",
    "2026-09-27T03:15:00.000Z", "2026-09-19T10:00:00.000Z", "2026-09-27T00:00:00.000Z",
  ]);
  assert.deepEqual(value.benefits.map(({ reset_anchor }) => reset_anchor), [
    null, null, "2026-09-28T00:00:00.000Z", null, "2026-10-01T00:00:00.000Z", null,
  ]);
  assert.deepEqual(buildDemoData(REFERENCE), value);
  const tomorrow = buildDemoData(REFERENCE + DAY);
  for (let index = 0; index < value.services.length; index++) {
    const before = value.services[index]!.trial_ends_at;
    const after = tomorrow.services[index]!.trial_ends_at;
    if (before === null) assert.equal(after, null);
    else assert.equal(Date.parse(after!) - Date.parse(before), DAY);
  }
  for (let index = 0; index < value.benefits.length; index++) {
    const before = value.benefits[index]!;
    const after = tomorrow.benefits[index]!;
    assert.equal(Date.parse(after.observed_at) - Date.parse(before.observed_at), DAY);
    if (before.reset_anchor === null) assert.equal(after.reset_anchor, null);
    else assert.equal(Date.parse(after.reset_anchor!) - Date.parse(before.reset_anchor), DAY);
  }
});

for (const epoch of [0, Date.parse("2028-02-29T23:59:59.999Z"), Date.parse("2026-12-31T23:59:59.999Z")]) {
  test(`deterministic fixture handles epoch/month/year rollover ${epoch}`, () => {
    const first = buildDemoData(epoch);
    assert.deepEqual(first, buildDemoData(epoch));
    for (const row of first.benefits) assert.ok(Number.isFinite(Date.parse(row.observed_at)));
    for (const row of first.services) if (row.trial_ends_at !== null) assert.ok(Date.parse(row.trial_ends_at) > epoch);
    assert.ok(!JSON.stringify(first).includes("2026-09-19 ·"), "no hardcoded source-note date contradicts the seed");
  });
}

test("calls create independent arrays and records without sharing mutable fixture state", () => {
  const first = buildDemoData(REFERENCE);
  const second = buildDemoData(REFERENCE);
  assert.notEqual(first, second);
  assert.notEqual(first.services, second.services);
  assert.notEqual(first.benefits, second.benefits);
  for (let index = 0; index < first.services.length; index++) assert.notEqual(first.services[index], second.services[index]);
  for (let index = 0; index < first.benefits.length; index++) assert.notEqual(first.benefits[index], second.benefits[index]);
  first.services[0]!.name = "Changed locally";
  first.benefits[0]!.remaining_amount = 99;
  first.services.pop();
  assert.deepEqual(second, buildDemoData(REFERENCE));
});

test("data generation, attention and formatting never consult an implicit global clock", (t) => {
  const RealDate = Date;
  const referenceDate = new RealDate(REFERENCE);
  const expected = buildDemoData(REFERENCE);
  class ExplicitDate extends RealDate {
    constructor(value: string | number) {
      assert.ok(arguments.length > 0, "Date() must receive an explicit value");
      super(value);
    }
    static override now(): never { throw new Error("Unexpected global clock"); }
  }
  t.mock.method(globalThis, "Date", ExplicitDate as unknown as DateConstructor);
  assert.deepEqual(buildDemoData(REFERENCE), expected);
  assert.ok(collectAttention(expected, referenceDate).length > 0);
  assert.equal(daysUntil("2026-09-29T12:34:56.789Z", referenceDate), 1);
  assert.equal(formatDay("2026-09-28T15:00:00.000Z"), "9월 29일");
});

for (const invalid of [NaN, Infinity, -Infinity, 8.64e15 + 1, null, undefined, "2026-09-28"]) {
  test(`invalid reference epoch is rejected explicitly ${String(invalid)}`, () => {
    assert.throws(() => buildDemoData(invalid as number), { message: "DEMO_REFERENCE_TIME_INVALID" });
  });
}

for (const unknown of [null, NaN, Infinity, -Infinity, -1, -0.001]) {
  test(`unknown/invalid amount stays unknown: ${String(unknown)}`, () => {
    assert.equal(isUnknownAmount(unknown), true);
    assert.equal(formatAmount(unknown), "모름");
    assert.equal(formatAmount(unknown, "회"), "모름");
    assert.equal(remainingRatio(benefit({ granted_amount: unknown, remaining_amount: 0 })), null);
    assert.equal(remainingRatio(benefit({ granted_amount: 100, remaining_amount: unknown })), null);
    const attention = collectAttention(dataset([], [benefit({ remaining_amount: unknown })]), now());
    assert.equal(attention.length, 1);
    assert.equal(attention[0]!.kind, "needs_review");
    assert.ok(!attention[0]!.title.includes("잔량 0"));
  });
}
for (const known of [0, -0, 0.001, 1, 100, Number.MAX_VALUE]) {
  test(`finite nonnegative amount remains known: ${String(known)}`, () => {
    assert.equal(isUnknownAmount(known), false);
    assert.notEqual(formatAmount(known), "모름");
  });
}
test("confirmed zero is neither unknown nor a negative zero display", () => {
  assert.equal(formatAmount(0), "0");
  assert.equal(formatAmount(-0, "회"), "0 회");
  assert.equal(formatAmount(null, "회"), "모름");
  const items = collectAttention(dataset([], [benefit({ remaining_amount: 0 })]), now());
  assert.equal(items[0]!.kind, "empty_balance");
  assert.equal(items[0]!.detail, "확인된 0. 추정하지 않음.");
  assert.equal(remainingRatio(benefit({ granted_amount: 100, remaining_amount: 0 })), 0);
});
test("amount display uses bounded Korean decimal formatting without changing values", () => {
  assert.equal(formatAmount(1234.567, "회"), "1,234.57 회");
  assert.equal(formatAmount(1.2), "1.2");
  assert.equal(formatAmount(1, ""), "1");
  const row = benefit({ remaining_amount: 1.2345 });
  formatAmount(row.remaining_amount);
  assert.equal(row.remaining_amount, 1.2345);
});
for (const [granted, remaining, expected] of [
  [0, 0, null], [0, 1, null], [100, 25, 0.25], [100, 100, 1], [100, 101, 1],
  [0.5, 0.25, 0.5], [Number.MAX_VALUE, Number.MAX_VALUE, 1], [1, Number.MAX_VALUE, 1],
] as const) {
  test(`ratio boundary granted=${granted}, remaining=${remaining}`, () => {
    assert.equal(remainingRatio(benefit({ granted_amount: granted, remaining_amount: remaining })), expected);
  });
}

for (const [offset, expected] of [[-DAY - 1, -2], [-DAY, -1], [-1, -1], [0, 0], [1, 1], [DAY, 1], [DAY + 1, 2]] as const) {
  test(`daysUntil retains the past/future boundary at offset ${offset}`, () => {
    const reference = now();
    assert.equal(daysUntil(new Date(REFERENCE + offset).toISOString(), reference), expected);
    assert.equal(reference.getTime(), REFERENCE);
  });
}
for (const iso of [null, "", "not-a-date"]) {
  test(`unknown date ${JSON.stringify(iso)} is not converted to today`, () => {
    assert.equal(daysUntil(iso, now()), null);
    assert.equal(formatDay(iso), "날짜 모름");
    const items = collectAttention(dataset([service({ trial_ends_at: iso })]), now());
    assert.equal(items.length, 1);
    assert.equal(items[0]!.kind, "needs_review");
    assert.ok(!items[0]!.detail.includes("오늘 종료 예정"));
  });
}
test("invalid explicit reference date does not produce NaN or a false future expiration", () => {
  assert.equal(daysUntil("2026-10-01T00:00:00Z", new Date(NaN)), null);
  const items = collectAttention(dataset([service()]), new Date(NaN));
  assert.equal(items[0]!.kind, "needs_review");
  assert.ok(!JSON.stringify(items).includes("NaN"));
});

for (const offset of [-8 * DAY, -DAY, -1, 0]) {
  test(`reached/expired trial requires status review instead of today's future ending: ${offset}`, () => {
    const items = collectAttention(dataset([service({ trial_ends_at: new Date(REFERENCE + offset).toISOString() })]), now());
    assert.equal(items.length, 1);
    assert.equal(items[0]!.kind, "needs_review");
    assert.match(items[0]!.detail, /종료 시각에 도달/);
    assert.ok(!items[0]!.detail.includes("오늘 종료 예정"));
  });
}
for (const [offset, expectedDays] of [[1, 1], [DAY, 1], [DAY + 1, 2], [7 * DAY, 7]] as const) {
  test(`future trial expiring within seven days is shown accurately: ${offset}`, () => {
    const items = collectAttention(dataset([service({ trial_ends_at: new Date(REFERENCE + offset).toISOString() })]), now());
    assert.equal(items.length, 1);
    assert.equal(items[0]!.kind, "expiring");
    assert.equal(items[0]!.detail, `${expectedDays}일 남음`);
  });
}
test("a trial more than seven days away is not an imminent-expiry item", () => {
  assert.deepEqual(collectAttention(dataset([service({ trial_ends_at: new Date(REFERENCE + 7 * DAY + 1).toISOString() })]), now()), []);
});
for (const status of ["active", "trial_ended", "paused", "cancelled", "unknown"] as const) {
  test(`non-trial status ${status} does not become an upcoming trial from a date alone`, () => {
    assert.deepEqual(collectAttention(dataset([service({ subscription_status: status, trial_ends_at: new Date(REFERENCE - 1).toISOString() })]), now()), []);
    assert.deepEqual(collectAttention(dataset([service({ subscription_status: status, trial_ends_at: null })]), now()), []);
  });
}
test("attention preserves the explicit limit note and does not infer a positive balance problem", () => {
  const rows = [benefit({ id: "zero", remaining_amount: 0, extra_limit_note: "Synthetic zero note" }),
    benefit({ id: "unknown", remaining_amount: null, extra_limit_note: "Synthetic unknown note" }),
    benefit({ id: "positive", remaining_amount: 1 })];
  const input = dataset([], rows);
  const snapshot = structuredClone(input);
  const items = collectAttention(input, now());
  assert.deepEqual(items.map(({ detail }) => detail), ["Synthetic zero note", "Synthetic unknown note"]);
  assert.deepEqual(items.map(({ id }) => id), ["empty-zero", "review-unknown"]);
  assert.deepEqual(input, snapshot);
});

for (const [iso, expected] of [
  ["2026-12-31T14:59:59.999Z", "12월 31일"], ["2026-12-31T15:00:00.000Z", "1월 1일"],
  ["2026-01-01T00:00:00+09:00", "1월 1일"], ["2026-01-01T00:00:00-08:00", "1월 1일"],
] as const) {
  test(`day formatting uses Seoul's calendar boundary for ${iso}`, () => {
    assert.equal(formatDay(iso), expected);
  });
}
test("date formatter explicitly supplies Asia/Seoul instead of relying on the host timezone", (t) => {
  const Formatter = Intl.DateTimeFormat;
  let calls = 0;
  t.mock.method(Intl, "DateTimeFormat", function (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    calls++;
    assert.equal(options?.timeZone, "Asia/Seoul");
    return new Formatter(locales, options);
  } as typeof Intl.DateTimeFormat);
  assert.equal(formatDay("2026-09-28T15:00:00Z"), "9월 29일");
  assert.equal(calls, 1);
});
test("service benefit lookup returns a new filtered array without cross-service entries", () => {
  const value = buildDemoData(REFERENCE);
  const rows = benefitsForService(value, "demo-svc-1");
  assert.equal(rows.length, 2);
  assert.ok(rows.every(({ service_id }) => service_id === "demo-svc-1"));
  assert.notEqual(rows, value.benefits);
  rows.pop();
  assert.equal(value.benefits.length, 6);
  assert.deepEqual(benefitsForService(value, "not-a-service"), []);
});
