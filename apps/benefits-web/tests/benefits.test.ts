import assert from "node:assert/strict";
import test from "node:test";
import {
  daysUntil,
  formatAmount,
  formatObservedAt,
  isObservationStale,
  isUnknown,
  nextResetAt,
  remainingRatio,
  sumByUnit,
  type BenefitRecord,
} from "../src/domain/benefits.ts";
import { EXPORT_FORMAT_VERSION } from "../src/domain/export-format.ts";

const NOW = new Date("2026-09-27T12:00:00.000Z");

function benefit(overrides: Partial<BenefitRecord> = {}): BenefitRecord {
  return {
    id: "demo-benefit",
    service_id: "demo-service",
    name: "합성 크레딧",
    unit: "크레딧",
    granted_amount: 50,
    remaining_amount: 12,
    monthly_cap: null,
    extra_limit_note: null,
    reset_rule: "none",
    reset_anchor: null,
    observed_at: "2026-09-26T09:00:00.000Z",
    observed_precision: "minute",
    observed_timezone: "Asia/Seoul",
    source_kind: "manual",
    source_note: null,
    ...overrides,
  };
}

test("unknown and non-finite amounts never become measured zero", () => {
  for (const value of [null, Number.NaN, Infinity, -Infinity, undefined as unknown as number]) {
    assert.equal(isUnknown(value), true);
    assert.equal(formatAmount(value, "회"), "모름");
  }
  assert.equal(isUnknown(0), false);
  assert.equal(formatAmount(0, "회"), "0 회");
  assert.equal(formatAmount(1234.5), "1,234.5");
});

test("ratio requires known balances and a positive grant without overflowing", () => {
  assert.equal(remainingRatio(benefit({ remaining_amount: null })), null);
  assert.equal(remainingRatio(benefit({ granted_amount: 0 })), null);
  assert.equal(remainingRatio(benefit({ granted_amount: Infinity })), null);
  assert.equal(remainingRatio(benefit({ remaining_amount: -1 })), 0);
  assert.equal(remainingRatio(benefit({ remaining_amount: 0 })), 0);
  assert.equal(remainingRatio(benefit()), 12 / 50);
  assert.equal(remainingRatio(benefit({ granted_amount: Number.MIN_VALUE, remaining_amount: Number.MAX_VALUE })), 1);
});

test("totals preserve units, exclude unknown amounts and safely accept prototype-looking units", () => {
  const totals = sumByUnit([
    benefit(),
    benefit({ remaining_amount: 3 }),
    benefit({ remaining_amount: null }),
    benefit({ remaining_amount: Infinity }),
    benefit({ unit: "GB", remaining_amount: 0 }),
    benefit({ unit: "MB", remaining_amount: null }),
    benefit({ unit: "__proto__", remaining_amount: 4 }),
    benefit({ unit: "__proto__", remaining_amount: 5 }),
    benefit({ unit: "constructor", remaining_amount: 6 }),
    benefit({ unit: "toString", remaining_amount: 7 }),
  ]);
  assert.equal(Object.getPrototypeOf(totals), null);
  assert.equal(totals["크레딧"], 15);
  assert.equal(totals["GB"], 0);
  assert.equal(Object.hasOwn(totals, "MB"), false);
  assert.equal(totals["__proto__"], 9);
  assert.equal(totals["constructor"], 6);
  assert.equal(totals["toString"], 7);
});

test("arithmetic overflow rejects a misleading aggregate", () => {
  assert.throws(() => sumByUnit([
    benefit({ remaining_amount: Number.MAX_VALUE }),
    benefit({ remaining_amount: Number.MAX_VALUE }),
  ]), { name: "RangeError", message: "BENEFIT_TOTAL_OUT_OF_RANGE" });
});

test("observed display preserves date precision and the recorded timezone", () => {
  const day = formatObservedAt(benefit({ observed_precision: "day" }));
  assert.match(day, /2026/);
  assert.match(day, /날짜만 기록됨/);
  assert.equal(day.includes(":"), false);
  const minute = formatObservedAt(benefit());
  assert.match(minute, /Asia\/Seoul/);
  assert.match(minute, /06:00|6:00|18:00/);
});

test("invalid observation timestamps, impossible dates, precision and zones fail to unknown", () => {
  for (const observed_at of ["invalid", "2026-02-30T09:00:00Z", "2026-09-27T09:00:00", "2026-13-01", "2026-09-27T25:00:00Z"]) {
    assert.equal(formatObservedAt(benefit({ observed_at })), "확인 시점 모름");
  }
  assert.equal(formatObservedAt(benefit({ observed_timezone: "not/a-zone" })), "확인 시점 모름");
  assert.equal(formatObservedAt(benefit({ observed_timezone: "" })), "확인 시점 모름");
  assert.equal(formatObservedAt(benefit({ observed_precision: "hour" as "minute" })), "확인 시점 모름");
});

test("a calendar-only observation cannot invent a time or shift its recorded day", () => {
  assert.equal(formatObservedAt(benefit({ observed_at: "2026-09-27", observed_precision: "minute" })), "확인 시점 모름");
  const day = formatObservedAt(benefit({ observed_at: "2026-09-27", observed_precision: "day", observed_timezone: "America/Los_Angeles" }));
  assert.match(day, /09\.\s*27\./);
  assert.match(day, /날짜만 기록됨/);
});

test("reset calculation rejects invalid anchors, invalid reference dates and unknown rules", () => {
  for (const reset_anchor of [null, "invalid", "2025-02-29T09:00:00Z", "2026-09-27T09:00:00", "2026-01-01T00:00:00+99:00"]) {
    assert.equal(nextResetAt({ reset_rule: "daily", reset_anchor }, NOW), null);
  }
  for (const reset_rule of ["none", "unknown", "unexpected"] as const) {
    assert.equal(nextResetAt({ reset_rule: reset_rule as "none", reset_anchor: "2026-09-28T00:00:00Z" }, NOW), null);
  }
  assert.equal(nextResetAt({ reset_rule: "daily", reset_anchor: "2026-09-28T00:00:00Z" }, new Date("invalid")), null);
});

test("custom reset is strictly future and never mutates the supplied reference date", () => {
  const initial = NOW.getTime();
  assert.equal(nextResetAt({ reset_rule: "custom", reset_anchor: NOW.toISOString() }, NOW), null);
  assert.equal(nextResetAt({ reset_rule: "custom", reset_anchor: "2026-09-28T12:00:00Z" }, NOW)?.toISOString(), "2026-09-28T12:00:00.000Z");
  assert.equal(NOW.getTime(), initial);
});

test("daily and weekly old anchors return the next occurrence past the former loop bound", () => {
  assert.equal(nextResetAt({ reset_rule: "daily", reset_anchor: "1900-01-01T09:10:11.012Z" }, NOW)?.toISOString(), "2026-09-28T09:10:11.012Z");
  const weekly = nextResetAt({ reset_rule: "weekly", reset_anchor: "1800-01-01T00:00:00Z" }, NOW);
  assert.ok(weekly);
  assert.ok(weekly > NOW);
  assert.ok(weekly.getTime() - NOW.getTime() <= 7 * 86_400_000);
  assert.equal((weekly.getTime() - Date.parse("1800-01-01T00:00:00Z")) % (7 * 86_400_000), 0);
});

test("monthly reset clamps each month against the original day without cumulative drift", () => {
  const record = { reset_rule: "monthly" as const, reset_anchor: "2025-01-31T10:20:30.040Z" };
  assert.equal(nextResetAt(record, new Date("2025-01-31T10:20:30.040Z"))?.toISOString(), "2025-02-28T10:20:30.040Z");
  assert.equal(nextResetAt(record, new Date("2025-02-28T10:20:30.040Z"))?.toISOString(), "2025-03-31T10:20:30.040Z");
  assert.equal(nextResetAt({ ...record, reset_anchor: "2025-01-30T10:20:30.040Z" }, new Date("2025-02-28T10:20:30.040Z"))?.toISOString(), "2025-03-30T10:20:30.040Z");
});

test("monthly old anchors are constant-time and preserve leap month days", () => {
  assert.equal(nextResetAt({ reset_rule: "monthly", reset_anchor: "1000-01-31T00:00:00Z" }, new Date("2024-01-31T00:00:00Z"))?.toISOString(), "2024-02-29T00:00:00.000Z");
  assert.equal(nextResetAt({ reset_rule: "monthly", reset_anchor: "2026-12-31T00:00:00Z" }, new Date("2026-12-31T00:00:00Z"))?.toISOString(), "2027-01-31T00:00:00.000Z");
});

test("yearly February 29 clamps in ordinary years and returns on the next leap year", () => {
  const record = { reset_rule: "yearly" as const, reset_anchor: "2024-02-29T08:00:00Z" };
  assert.equal(nextResetAt(record, new Date("2024-02-29T08:00:00Z"))?.toISOString(), "2025-02-28T08:00:00.000Z");
  assert.equal(nextResetAt(record, new Date("2027-02-28T08:00:00Z"))?.toISOString(), "2028-02-29T08:00:00.000Z");
  assert.equal(nextResetAt(record, new Date("2100-02-28T08:00:00Z"))?.toISOString(), "2101-02-28T08:00:00.000Z");
});

test("date-only and explicit-offset anchors resolve deterministically in UTC", () => {
  assert.equal(nextResetAt({ reset_rule: "daily", reset_anchor: "2026-09-27" }, NOW)?.toISOString(), "2026-09-28T00:00:00.000Z");
  assert.equal(nextResetAt({ reset_rule: "daily", reset_anchor: "2026-09-27T21:00:00+09:00" }, NOW)?.toISOString(), "2026-09-28T12:00:00.000Z");
});

test("database fractional seconds remain compatible without rewriting the recorded value", () => {
  for (const timestamp of [
    "2026-09-27T12:00:00.123456Z",
    "2026-09-27T12:00:00.123456+00:00",
    "2026-09-27T12:00:00.123456789Z",
    "2026-09-27T21:00:00.123456789+09:00",
  ]) {
    const record = Object.freeze(benefit({ observed_at: timestamp, reset_rule: "daily", reset_anchor: timestamp }));
    const before = JSON.stringify(record);
    assert.notEqual(formatObservedAt(record), "확인 시점 모름");
    assert.equal(isObservationStale(record, new Date("2026-09-27T13:00:00Z")), false);
    assert.equal(nextResetAt(record, new Date("2026-09-27T12:00:00.124Z"))?.toISOString(), "2026-09-28T12:00:00.123Z");
    assert.equal(JSON.stringify(record), before);
  }
  const excessive = "2026-09-27T12:00:00.1234567890Z";
  assert.equal(formatObservedAt(benefit({ observed_at: excessive })), "확인 시점 모름");
  assert.equal(nextResetAt({ reset_rule: "daily", reset_anchor: excessive }, NOW), null);
});

test("unrepresentable future reset returns unknown instead of a past or invalid date", () => {
  const edge = new Date(8_640_000_000_000_000);
  for (const reset_rule of ["daily", "weekly", "monthly", "yearly"] as const) {
    assert.equal(nextResetAt({ reset_rule, reset_anchor: "2000-01-01T00:00:00Z" }, edge), null);
  }
});

test("stale observation only flags review and never replenishes or rewrites a record", () => {
  const record = Object.freeze(benefit({ reset_rule: "daily", reset_anchor: "2026-09-26T10:00:00Z", remaining_amount: 0 }));
  const before = JSON.stringify(record);
  assert.equal(isObservationStale(record, NOW), true);
  assert.equal(JSON.stringify(record), before);
  assert.equal(record.remaining_amount, 0);
  assert.equal(isObservationStale(benefit({ reset_rule: "daily", reset_anchor: "2026-09-28T10:00:00Z" }), NOW), false);
});

test("invalid or future provenance requests review while absent reset rules do not invent resets", () => {
  assert.equal(isObservationStale(benefit({ observed_at: "invalid" }), NOW), true);
  assert.equal(isObservationStale(benefit({ observed_at: "2026-09-28T00:00:00Z" }), NOW), true);
  assert.equal(isObservationStale(benefit(), new Date("invalid")), true);
  assert.equal(isObservationStale(benefit({ reset_rule: "monthly", reset_anchor: "invalid" }), NOW), true);
  assert.equal(isObservationStale(benefit({ reset_rule: "unknown" }), NOW), false);
  assert.equal(isObservationStale(benefit(), NOW), false);
});

test("freshness and display agree on invalid observation metadata", () => {
  const invalid: Partial<BenefitRecord>[] = [
    { observed_timezone: "not/a-zone" },
    { observed_timezone: "" },
    { observed_precision: "hour" as "minute" },
    { observed_at: "2026-09-27", observed_precision: "minute" },
  ];
  for (const overrides of invalid) {
    for (const reset_rule of ["none", "unknown"] as const) {
      const record = benefit({ ...overrides, reset_rule });
      assert.equal(formatObservedAt(record), "확인 시점 모름");
      assert.equal(isObservationStale(record, NOW), true);
    }
  }
});

test("date-only future checks use the recorded local calendar, not UTC midnight", () => {
  const record = Object.freeze(benefit({ observed_at: "2026-09-27", observed_precision: "day", observed_timezone: "America/Los_Angeles" }));
  const before = JSON.stringify(record);
  assert.equal(isObservationStale(record, new Date("2026-09-27T06:00:00Z")), true);
  assert.equal(isObservationStale(record, new Date("2026-09-27T07:00:00Z")), false);
  assert.equal(isObservationStale(benefit({ ...record, observed_timezone: "Asia/Seoul" }), new Date("2026-09-26T16:00:00Z")), false);
  assert.equal(isObservationStale(benefit({ ...record, observed_timezone: "Pacific/Kiritimati" }), new Date("2026-09-26T12:00:00Z")), false);
  assert.equal(JSON.stringify(record), before);
});

test("day-precision reset uncertainty requests review without claiming an exact observation time", () => {
  const record = benefit({ observed_at: "2026-09-27", observed_precision: "day", observed_timezone: "America/Los_Angeles", reset_rule: "custom" });
  const now = new Date("2026-09-27T20:00:00Z");
  // The first reset is future, so none could have elapsed.
  assert.equal(isObservationStale({ ...record, reset_anchor: "2026-09-28T07:00:00Z" }, now), false);
  // 06:00Z is still the previous local day; that observation is definitely later.
  assert.equal(isObservationStale({ ...record, reset_anchor: "2026-09-27T06:00:00Z" }, now), false);
  // 07:00Z starts the recorded local day; within-day ordering is unknown and needs review.
  assert.equal(isObservationStale({ ...record, reset_anchor: "2026-09-27T07:00:00Z" }, now), true);
  // An incidental timestamp must not create precision that the record explicitly lacks.
  assert.equal(isObservationStale({ ...record, observed_at: "2026-09-27T19:00:00Z", reset_anchor: "2026-09-27T07:00:00Z" }, now), true);
});

test("day-precision freshness locates the latest recurring reset without calendar drift", () => {
  const record = benefit({ observed_at: "2026-09-27", observed_precision: "day", observed_timezone: "America/Los_Angeles" });
  const now = new Date("2026-09-27T20:00:00Z");
  assert.equal(isObservationStale({ ...record, reset_rule: "daily", reset_anchor: "2026-09-26T06:00:00Z" }, now), false);
  assert.equal(isObservationStale({ ...record, reset_rule: "daily", reset_anchor: "2026-09-26T07:00:00Z" }, now), true);
  assert.equal(isObservationStale({ ...record, reset_rule: "weekly", reset_anchor: "2026-09-20T07:00:00Z" }, now), true);
  assert.equal(isObservationStale({ ...record, reset_rule: "monthly", reset_anchor: "2026-08-27T07:00:00Z" }, now), true);
  assert.equal(isObservationStale({ ...record, reset_rule: "yearly", reset_anchor: "2025-09-27T07:00:00Z" }, now), true);
  const leapRecord = benefit({ observed_at: "2028-02-28", observed_precision: "day", observed_timezone: "UTC", reset_rule: "yearly", reset_anchor: "2024-02-29T08:00:00Z" });
  assert.equal(isObservationStale(leapRecord, new Date("2028-02-28T20:00:00Z")), false);
  assert.equal(isObservationStale(leapRecord, new Date("2028-02-29T08:00:00Z")), true);
});

test("daysUntil preserves elapsed/unknown intervals and the migrated export version", () => {
  assert.equal(daysUntil(new Date("2026-09-28T12:00:00Z"), NOW), 1);
  assert.equal(daysUntil(new Date("2026-09-26T12:00:00Z"), NOW), -1);
  assert.equal(Number.isNaN(daysUntil(new Date("invalid"), NOW)), true);
  assert.equal(Number.isNaN(daysUntil(NOW, new Date("invalid"))), true);
  assert.equal(EXPORT_FORMAT_VERSION, "keyatlas.export.v3");
});
