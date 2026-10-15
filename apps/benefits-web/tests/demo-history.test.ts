import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDemoDataWithHistory,
  getDemoBenefitHistoryReason,
  selectDemoHistoryView,
} from "../src/lib/demo-benefit-history.ts";
import {
  buildDemoData, DEMO_DATASET_STAMP, DEMO_NOTICE,
  type DemoBenefit, type DemoDataset, type DemoService,
} from "../src/lib/mvp-demo-data.ts";

// Synthetic display fixtures only: no user account, persistence, mail or network.
const REFERENCE = Date.parse("2026-09-29T12:34:56.789Z");
const DAY = 86_400_000;
const iso = (offset = 0) => new Date(REFERENCE + offset).toISOString();
const service = (patch: Partial<DemoService> = {}): DemoService => ({
  ...buildDemoData(REFERENCE).services[0]!, id: "history-test-service", ...patch,
});
type BenefitPatch = Omit<Partial<DemoBenefit>, "benefit_kind" | "expires_at"> & {
  benefit_kind?: DemoBenefit["benefit_kind"];
  expires_at?: DemoBenefit["expires_at"];
};
function benefit(patch: BenefitPatch = {}): DemoBenefit {
  const { benefit_kind, expires_at, ...other } = patch;
  const row: DemoBenefit = {
    ...buildDemoData(REFERENCE).benefits[0]!, id: "history-test-benefit",
    service_id: "history-test-service", benefit_kind: "credit", expires_at: null, ...other,
  };
  // An undefined optional fixture fact means absent, respecting exact optional types.
  if (Object.hasOwn(patch, "benefit_kind")) {
    if (benefit_kind === undefined) delete row.benefit_kind;
    else row.benefit_kind = benefit_kind;
  }
  if (Object.hasOwn(patch, "expires_at")) {
    if (expires_at === undefined) delete row.expires_at;
    else row.expires_at = expires_at;
  }
  return row;
}
const dataset = (services: DemoService[], benefits: DemoBenefit[]): DemoDataset => ({
  dataset: DEMO_DATASET_STAMP, notice: DEMO_NOTICE, services, benefits,
});
const reason = (row: DemoBenefit, owner: DemoService | undefined = service(), at = REFERENCE) =>
  getDemoBenefitHistoryReason(row, owner, at);
function assertHistory(value: string | null): void {
  assert.equal(typeof value, "string");
  assert.ok(value && value.length > 0);
  assert.match(value, /기록/);
}

for (const offset of [-DAY, -1, 0]) {
  test(`an explicit canonical expiry at reference ${offset} ms is historical`, () => {
    assertHistory(reason(benefit({ expires_at: iso(offset), remaining_amount: 80 })));
  });
}

test("one millisecond before an explicit expiry remains in review", () => {
  const row = benefit({ expires_at: iso(1), remaining_amount: 0 });
  assert.equal(reason(row), null);
  assertHistory(reason(row, service(), REFERENCE + 1));
});

test("an explicit benefit expiry does not need a related service or a known kind", () => {
  assertHistory(getDemoBenefitHistoryReason(benefit({ benefit_kind: undefined, expires_at: iso(-1) }), undefined, REFERENCE));
  assertHistory(reason(benefit({ benefit_kind: "other", expires_at: iso(-1) }), service({ id: "other-service" })));
});

test("zero epoch is a valid reference instant, not an absent reference", () => {
  assertHistory(reason(benefit({ expires_at: "1970-01-01T00:00:00.000Z" }), service(), 0));
});

const INVALID_DATES = [
  "", "not-a-date", "2026-09-28", "2026-09-28T12:34:56",
  "2026-09-28T12:34:56Z", "2026-09-28T12:34:56.789+00:00",
  "2026-09-28T12:34:56.789+09:00", "2026-02-30T00:00:00.000Z",
  "2025-02-29T00:00:00.000Z", "2026-09-28T24:00:00.000Z",
  "2026-09-28T12:34:60.000Z", "2026-13-01T00:00:00.000Z",
  " 2026-09-28T12:34:56.789Z", "2026-09-28T12:34:56.789Z ",
  "2026-09-28T12:34:56.789Z\n", "2026-09-28t12:34:56.789z",
];

for (const value of INVALID_DATES) {
  test(`ambiguous or invalid benefit expiry stays in review: ${JSON.stringify(value)}`, () => {
    assert.equal(reason(benefit({ expires_at: value })), null);
    // An ended service cannot override the benefit's malformed/conflicting expiry.
    assert.equal(reason(benefit({ benefit_kind: "trial", expires_at: value }),
      service({ subscription_status: "trial_ended", trial_ends_at: null })), null);
  });
}

test("missing expiry never treats an old observation as expiry", () => {
  for (const expires_at of [undefined, null]) {
    assert.equal(reason(benefit({ expires_at, observed_at: "2000-01-01T00:00:00.000Z" })), null);
  }
});

for (const status of ["active", "cancelled", "paused", "unknown"] as const) {
  test(`service status ${status} does not establish trial expiry`, () => {
    assert.equal(reason(benefit({ benefit_kind: "trial" }),
      service({ subscription_status: status, trial_ends_at: iso(-DAY) })), null);
  });
}

for (const kind of [undefined, "credit", "other"] as const) {
  test(`ended trial service never archives unrelated benefit kind ${String(kind)}`, () => {
    for (const subscription_status of ["trial", "trial_ended"] as const) {
      assert.equal(reason(benefit({ benefit_kind: kind, remaining_amount: 0 }),
        service({ subscription_status, trial_ends_at: iso(-DAY) })), null);
    }
  });
}

test("trial type is explicit, not guessed from the benefit or plan label", () => {
  assert.equal(reason(benefit({ name: "합성 무료 체험", benefit_kind: undefined }),
    service({ subscription_status: "trial_ended", plan_name: "종료된 체험", trial_ends_at: null })), null);
});

test("recorded trial_ended with no date is a historical record only for its trial benefit", () => {
  const owner = service({ subscription_status: "trial_ended", trial_ends_at: null });
  assertHistory(reason(benefit({ benefit_kind: "trial", expires_at: null }), owner));
  assertHistory(reason(benefit({ benefit_kind: "trial", expires_at: undefined }), owner));
  assert.equal(reason(benefit({ benefit_kind: "credit" }), owner), null);
});

for (const status of ["trial", "trial_ended"] as const) {
  test(`canonical service trial deadline applies to ${status} at its exact boundary`, () => {
    const row = benefit({ benefit_kind: "trial" });
    assertHistory(reason(row, service({ subscription_status: status, trial_ends_at: iso(-1) })));
    assertHistory(reason(row, service({ subscription_status: status, trial_ends_at: iso() })));
    assert.equal(reason(row, service({ subscription_status: status, trial_ends_at: iso(1) })), null);
  });
}

test("a current trial with no recorded end stays in review", () => {
  assert.equal(reason(benefit({ benefit_kind: "trial" }),
    service({ subscription_status: "trial", trial_ends_at: null })), null);
});

test("malformed or future trial end conflicts remain in review even if status says ended", () => {
  for (const trial_ends_at of [...INVALID_DATES, iso(1), iso(DAY)]) {
    for (const subscription_status of ["trial", "trial_ended"] as const) {
      assert.equal(reason(benefit({ benefit_kind: "trial" }),
        service({ subscription_status, trial_ends_at })), null);
    }
  }
});

test("a later benefit expiry cannot be overridden by an ended service-level trial", () => {
  for (const trial_ends_at of [null, iso(-DAY)]) {
    assert.equal(reason(benefit({ benefit_kind: "trial", expires_at: iso(1) }),
      service({ subscription_status: "trial_ended", trial_ends_at })), null);
  }
});

test("an expired trial benefit with a matching future service trial stays visible for review", () => {
  for (const subscription_status of ["trial", "trial_ended"] as const) {
    for (const expires_at of [iso(-1), iso()]) {
      const owner = service({ subscription_status, trial_ends_at: iso(1) });
      const row = benefit({ benefit_kind: "trial", expires_at });
      assert.equal(reason(row, owner), null);
      const records = dataset([owner], [row]);
      assert.deepEqual(selectDemoHistoryView(records, "review", REFERENCE).benefits, [row]);
      assert.deepEqual(selectDemoHistoryView(records, "history", REFERENCE).benefits, []);
      assertHistory(reason(row, service({ subscription_status, trial_ends_at: iso() })));
    }
  }
});

test("a future trial fact only conflicts with its matching trial benefit", () => {
  const owner = service({ subscription_status: "trial", trial_ends_at: iso(1) });
  assertHistory(reason(benefit({ benefit_kind: "credit", expires_at: iso(-1) }), owner));
  const trial = benefit({ benefit_kind: "trial", expires_at: iso(-1) });
  assertHistory(reason(trial, { ...owner, id: "unrelated-service" }));
  assertHistory(getDemoBenefitHistoryReason(trial, undefined, REFERENCE));
  assertHistory(reason(trial, { ...owner, subscription_status: "unknown" }));
});

test("trial classification needs the matching service, not an unrelated ended trial", () => {
  const row = benefit({ benefit_kind: "trial" });
  assert.equal(getDemoBenefitHistoryReason(row, undefined, REFERENCE), null);
  assert.equal(reason(row, service({ id: "different", subscription_status: "trial_ended", trial_ends_at: null })), null);
});

test("zero balance, old observations, resets, cancellation and pauses alone do not archive", () => {
  for (const subscription_status of ["active", "cancelled", "paused", "unknown"] as const) {
    for (const reset_rule of ["daily", "weekly", "monthly", "yearly", "custom"] as const) {
      const row = benefit({ remaining_amount: 0, observed_at: "2000-01-01T00:00:00.000Z",
        reset_rule, reset_anchor: iso(-DAY), expires_at: null });
      assert.equal(reason(row, service({ subscription_status, trial_ends_at: iso(-DAY) })), null);
    }
  }
});

test("an ended trial's active credit sibling stays review and keeps its service visible there", () => {
  const owner = service({ subscription_status: "trial_ended", trial_ends_at: iso(-DAY) });
  const ended = benefit({ id: "ended-trial", benefit_kind: "trial" });
  const active = benefit({ id: "active-credit", benefit_kind: "credit", remaining_amount: 80 });
  const source = dataset([owner], [ended, active]);
  assert.deepEqual(selectDemoHistoryView(source, "review", REFERENCE), dataset([owner], [active]));
  assert.deepEqual(selectDemoHistoryView(source, "history", REFERENCE), dataset([owner], [ended]));
});

test("review retains genuinely benefit-less services but not history-only services", () => {
  const historyOwner = service({ id: "history-only" });
  const reviewOwner = service({ id: "review-only" });
  const emptyOwner = service({ id: "truly-empty" });
  const historical = benefit({ id: "old", service_id: historyOwner.id, expires_at: iso(-DAY) });
  const current = benefit({ id: "current", service_id: reviewOwner.id });
  const source = dataset([historyOwner, reviewOwner, emptyOwner], [historical, current]);
  assert.deepEqual(selectDemoHistoryView(source, "review", REFERENCE), dataset([reviewOwner, emptyOwner], [current]));
  assert.deepEqual(selectDemoHistoryView(source, "history", REFERENCE), dataset([historyOwner], [historical]));
});

test("selection preserves order and metadata without deleting or mutating frozen source records", () => {
  const source = buildDemoDataWithHistory(REFERENCE);
  const snapshot = structuredClone(source);
  source.services.forEach(Object.freeze);
  source.benefits.forEach(Object.freeze);
  Object.freeze(source.services);
  Object.freeze(source.benefits);
  Object.freeze(source);
  const review = selectDemoHistoryView(source, "review", REFERENCE);
  const history = selectDemoHistoryView(source, "history", REFERENCE);
  assert.deepEqual(source, snapshot);
  for (const selection of [review, history]) {
    assert.notEqual(selection, source);
    assert.notEqual(selection.services, source.services);
    assert.notEqual(selection.benefits, source.benefits);
    assert.equal(selection.dataset, source.dataset);
    assert.equal(selection.notice, source.notice);
    assert.deepEqual(selection.benefits, source.benefits.filter((row) => selection.benefits.includes(row)));
  }
  const reviewIds = review.benefits.map(({ id }) => id);
  const historyIds = history.benefits.map(({ id }) => id);
  assert.ok(reviewIds.every((id) => !historyIds.includes(id)));
  assert.deepEqual([...reviewIds, ...historyIds].sort(), source.benefits.map(({ id }) => id).sort());
  assert.deepEqual(selectDemoHistoryView(source, "review", REFERENCE), review);
});

for (const reference of [NaN, Infinity, -Infinity, 8.64e15 + 1, -8.64e15 - 1]) {
  test(`invalid reference time cannot produce history: ${String(reference)}`, () => {
    const source = buildDemoDataWithHistory(REFERENCE);
    assert.equal(reason(benefit({ expires_at: iso(-DAY) }), service(), reference), null);
    assert.deepEqual(selectDemoHistoryView(source, "history", reference), dataset([], []));
    assert.deepEqual(selectDemoHistoryView(source, "review", reference), source);
  });
}

test("history demo adds exactly two records and leaves the original 4-service 6-benefit review intact", () => {
  const original = buildDemoData(REFERENCE);
  const expanded = buildDemoDataWithHistory(REFERENCE);
  assert.equal(expanded.services.length, 5);
  assert.equal(expanded.benefits.length, 8);
  assert.deepEqual(expanded.services.slice(0, 4), original.services);
  assert.deepEqual(expanded.benefits.slice(0, 6), original.benefits);
  assert.deepEqual(selectDemoHistoryView(expanded, "review", REFERENCE), original);
  const history = selectDemoHistoryView(expanded, "history", REFERENCE);
  assert.equal(history.services.length, 2);
  assert.equal(history.benefits.length, 2);
  assert.deepEqual(history.benefits.map(({ benefit_kind }) => benefit_kind).sort(), ["credit", "trial"]);
  assert.ok(history.benefits.every((row) => history.services.some(({ id }) => id === row.service_id)));
  assert.equal(new Set(expanded.services.map(({ id }) => id)).size, 5);
  assert.equal(new Set(expanded.benefits.map(({ id }) => id)).size, 8);
  assert.deepEqual(buildDemoDataWithHistory(REFERENCE), expanded);
  assert.deepEqual(buildDemoData(REFERENCE), original);
});

test("the positive historical credit is labelled as a past record, not spendable current balance", () => {
  const history = selectDemoHistoryView(buildDemoDataWithHistory(REFERENCE), "history", REFERENCE);
  const credit = history.benefits.find(({ benefit_kind }) => benefit_kind === "credit")!;
  assert.ok(credit.remaining_amount !== null && credit.remaining_amount > 0);
  assert.match(credit.extra_limit_note ?? "", /당시.*기록/);
  assert.match(credit.extra_limit_note ?? "", /현재.*잔액이 아닙니다/);
  assertHistory(reason(credit));
});

test("each demo build owns its arrays and deterministic historical dates", () => {
  const first = buildDemoDataWithHistory(REFERENCE);
  const second = buildDemoDataWithHistory(REFERENCE);
  assert.notEqual(first.services, second.services);
  assert.notEqual(first.benefits, second.benefits);
  first.benefits[0]!.name = "synthetic local mutation";
  assert.notEqual(first.benefits[0]!.name, second.benefits[0]!.name);
  const tomorrow = buildDemoDataWithHistory(REFERENCE + DAY);
  for (const row of second.benefits.slice(6)) {
    const shifted = tomorrow.benefits.find(({ id }) => id === row.id)!;
    assert.equal(Date.parse(shifted.observed_at) - Date.parse(row.observed_at), DAY);
    if (row.expires_at !== null && row.expires_at !== undefined) {
      assert.equal(Date.parse(shifted.expires_at!) - Date.parse(row.expires_at), DAY);
    }
  }
});
