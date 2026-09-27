/**
 * Browser-safe benefit domain, selected from benefit-validator at 954da8da.
 * null is unknown, zero is measured zero, and a reset never replenishes a balance.
 * Recurrence uses UTC and the original anchor day; display uses the recorded zone.
 */

export type ResetRule = "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom" | "unknown";
export type SourceKind = "manual" | "ai_text" | "ai_image" | "email" | "import" | "mcp";
export type ObservedPrecision = "minute" | "day";
export type SubscriptionStatus =
  "active" | "trial" | "trial_ended" | "paused" | "cancelled" | "unknown";

export interface BenefitRecord {
  id: string;
  service_id: string;
  name: string;
  unit: string;
  granted_amount: number | null;
  remaining_amount: number | null;
  monthly_cap: number | null;
  extra_limit_note: string | null;
  reset_rule: ResetRule;
  reset_anchor: string | null;
  observed_at: string;
  observed_precision: ObservedPrecision;
  observed_timezone: string;
  source_kind: SourceKind;
  source_note: string | null;
}

export interface ServiceRecord {
  id: string;
  name: string;
  provider: string | null;
  plan_name: string | null;
  account_label: string | null;
  timezone: string;
  subscription_status: SubscriptionStatus;
  trial_ends_at: string | null;
  notes: string | null;
}

export const RESET_RULE_LABELS: Record<ResetRule, string> = {
  none: "리셋 없음",
  daily: "매일 리셋",
  weekly: "매주 리셋",
  monthly: "매월 리셋",
  yearly: "매년 리셋",
  custom: "직접 지정",
  unknown: "리셋 주기 모름",
};

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  manual: "직접 입력",
  ai_text: "AI 분석 (텍스트)",
  ai_image: "AI 분석 (이미지)",
  email: "메일 분석",
  import: "가져오기",
  mcp: "AI 도구",
};

export const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  active: "이용 중",
  trial: "무료 체험 중",
  trial_ended: "무료 체험 종료 (계정은 유지)",
  paused: "일시 중지",
  cancelled: "해지됨",
  unknown: "상태 모름",
};

/** Invalid/non-finite input is unknown, never measured zero. */
export function isUnknown(value: number | null): boolean {
  return typeof value !== "number" || !Number.isFinite(value);
}

export function formatAmount(value: number | null, unit?: string): string {
  if (isUnknown(value)) return "모름";
  const amount = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value as number);
  return unit ? `${amount} ${unit}` : amount;
}

export function remainingRatio(
  benefit: Pick<BenefitRecord, "granted_amount" | "remaining_amount">,
): number | null {
  if (isUnknown(benefit.granted_amount) || isUnknown(benefit.remaining_amount)) return null;
  const granted = benefit.granted_amount as number;
  const remaining = benefit.remaining_amount as number;
  if (granted <= 0) return null;
  if (remaining <= 0) return 0;
  if (remaining >= granted) return 1;
  return remaining / granted;
}

/** Sum known amounts per exact unit. Reject arithmetic overflow instead of showing a false total. */
export function sumByUnit(benefits: BenefitRecord[]): Record<string, number> {
  const totals = Object.create(null) as Record<string, number>;
  for (const benefit of benefits) {
    if (isUnknown(benefit.remaining_amount)) continue;
    const next = (totals[benefit.unit] ?? 0) + (benefit.remaining_amount as number);
    if (!Number.isFinite(next)) throw new RangeError("BENEFIT_TOTAL_OUT_OF_RANGE");
    totals[benefit.unit] = next;
  }
  return totals;
}

function daysInMonth(year: number, month: number): number {
  if (month === 1) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [3, 5, 8, 10].includes(month) ? 30 : 31;
}

/**
 * Accept ISO dates or explicitly zoned ISO instants, including database microseconds.
 * The source string is never rewritten; JavaScript Date calculations have millisecond resolution.
 */
function recordedDate(value: string): Date | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month - 1)) return null;
  if (match[4] !== undefined && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function finiteDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

type ObservationFields = Pick<BenefitRecord, "observed_at" | "observed_precision" | "observed_timezone">;

function calendarDateKey(date: Date, formatter: Intl.DateTimeFormat): number {
  const parts = formatter.formatToParts(date);
  const field = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const displayedYear = Number(field("year"));
  const year = field("era") === "BC" ? 1 - displayedYear : displayedYear;
  return year * 10_000 + Number(field("month")) * 100 + Number(field("day"));
}

/** Display and freshness share validation so invalid provenance cannot look fresh. */
function observationMetadata(benefit: ObservationFields) {
  const date = recordedDate(benefit.observed_at);
  if (!date || (benefit.observed_precision !== "day" && benefit.observed_precision !== "minute")) return null;
  if (typeof benefit.observed_timezone !== "string" || benefit.observed_timezone.length === 0) return null;
  const hasRecordedTime = benefit.observed_at.includes("T");
  if (benefit.observed_precision === "minute" && !hasRecordedTime) return null;
  try {
    const calendarFormatter = new Intl.DateTimeFormat("en-US", {
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      era: "short",
      timeZone: benefit.observed_timezone,
    });
    const dayKey = hasRecordedTime
      ? calendarDateKey(date, calendarFormatter)
      : Number(benefit.observed_at.slice(0, 4)) * 10_000
        + Number(benefit.observed_at.slice(5, 7)) * 100
        + Number(benefit.observed_at.slice(8, 10));
    return { date, hasRecordedTime, calendarFormatter, dayKey };
  } catch {
    return null;
  }
}

/** Precision is preserved: a date-only observation never acquires an invented clock time. */
export function formatObservedAt(
  benefit: Pick<BenefitRecord, "observed_at" | "observed_precision" | "observed_timezone">,
): string {
  const metadata = observationMetadata(benefit);
  if (!metadata) return "확인 시점 모름";
  try {
    const options: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: metadata.hasRecordedTime ? benefit.observed_timezone : "UTC",
      ...(benefit.observed_precision === "minute" ? { hour: "2-digit", minute: "2-digit" } as const : {}),
    };
    const text = new Intl.DateTimeFormat("ko-KR", options).format(metadata.date);
    return benefit.observed_precision === "day"
      ? `${text} (날짜만 기록됨)`
      : `${text} (${benefit.observed_timezone})`;
  } catch {
    return "확인 시점 모름";
  }
}

function calendarOccurrence(anchor: Date, year: number, month: number): Date {
  const result = new Date(anchor.getTime());
  result.setUTCFullYear(year, month, Math.min(anchor.getUTCDate(), daysInMonth(year, month)));
  return result;
}

/** Return a strictly future occurrence. No loop bound can accidentally return a past reset. */
export function nextResetAt(
  benefit: Pick<BenefitRecord, "reset_rule" | "reset_anchor">,
  from: Date = new Date(),
): Date | null {
  if (!finiteDate(from) || benefit.reset_rule === "none" || benefit.reset_rule === "unknown") return null;
  if (!["daily", "weekly", "monthly", "yearly", "custom"].includes(benefit.reset_rule)) return null;
  if (!benefit.reset_anchor) return null;
  const anchor = recordedDate(benefit.reset_anchor);
  if (!anchor) return null;
  if (anchor > from) return new Date(anchor.getTime());
  if (benefit.reset_rule === "custom") return null;

  let next: Date;
  if (benefit.reset_rule === "daily" || benefit.reset_rule === "weekly") {
    const period = 86_400_000 * (benefit.reset_rule === "weekly" ? 7 : 1);
    const steps = Math.floor((from.getTime() - anchor.getTime()) / period) + 1;
    next = new Date(anchor.getTime() + steps * period);
  } else if (benefit.reset_rule === "monthly") {
    const monthIndex = from.getUTCFullYear() * 12 + from.getUTCMonth();
    next = calendarOccurrence(anchor, Math.floor(monthIndex / 12), monthIndex % 12);
    if (next <= from) {
      const following = monthIndex + 1;
      next = calendarOccurrence(anchor, Math.floor(following / 12), following % 12);
    }
  } else {
    next = calendarOccurrence(anchor, from.getUTCFullYear(), anchor.getUTCMonth());
    if (next <= from) next = calendarOccurrence(anchor, from.getUTCFullYear() + 1, anchor.getUTCMonth());
  }
  return finiteDate(next) && next > from ? next : null;
}

function latestResetAt(rule: ResetRule, anchor: Date, now: Date): Date | null {
  let latest: Date;
  if (rule === "custom") {
    latest = new Date(anchor.getTime());
  } else if (rule === "daily" || rule === "weekly") {
    const period = 86_400_000 * (rule === "weekly" ? 7 : 1);
    const steps = Math.floor((now.getTime() - anchor.getTime()) / period);
    latest = new Date(anchor.getTime() + steps * period);
  } else if (rule === "monthly") {
    const monthIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
    latest = calendarOccurrence(anchor, Math.floor(monthIndex / 12), monthIndex % 12);
    if (latest > now) {
      const preceding = monthIndex - 1;
      latest = calendarOccurrence(anchor, Math.floor(preceding / 12), preceding % 12);
    }
  } else if (rule === "yearly") {
    latest = calendarOccurrence(anchor, now.getUTCFullYear(), anchor.getUTCMonth());
    if (latest > now) latest = calendarOccurrence(anchor, now.getUTCFullYear() - 1, anchor.getUTCMonth());
  } else {
    return null;
  }
  return finiteDate(latest) && latest >= anchor && latest <= now ? latest : null;
}

/**
 * true means review is needed, including invalid/uncertain provenance; it never changes a balance.
 * Day precision cannot prove whether an observation preceded a reset on that same local day.
 * Such a day is conservatively flagged rather than assigning it an invented midnight instant.
 */
export function isObservationStale(benefit: BenefitRecord, now: Date = new Date()): boolean {
  const metadata = observationMetadata(benefit);
  if (!metadata || !finiteDate(now)) return true;
  if (benefit.observed_precision === "day") {
    if (metadata.dayKey > calendarDateKey(now, metadata.calendarFormatter)) return true;
  } else if (metadata.date > now) {
    return true;
  }
  if (benefit.reset_rule === "none" || benefit.reset_rule === "unknown") return false;
  if (!["daily", "weekly", "monthly", "yearly", "custom"].includes(benefit.reset_rule)) return true;
  const anchor = benefit.reset_anchor ? recordedDate(benefit.reset_anchor) : null;
  if (!anchor) return true;
  if (benefit.observed_precision === "day") {
    if (anchor > now) return false;
    const latest = latestResetAt(benefit.reset_rule, anchor, now);
    if (!latest) return true;
    return calendarDateKey(latest, metadata.calendarFormatter) >= metadata.dayKey;
  }
  const nextAfterObservation = nextResetAt(benefit, metadata.date);
  if (!nextAfterObservation) return benefit.reset_rule !== "custom";
  return nextAfterObservation <= now;
}

/** NaN signals an unknown interval and must not be displayed as measured zero. */
export function daysUntil(date: Date, now: Date = new Date()): number {
  if (!finiteDate(date) || !finiteDate(now)) return Number.NaN;
  return Math.ceil((date.getTime() - now.getTime()) / 86_400_000);
}

export const UNITS = ["회", "건", "개", "크레딧", "포인트", "GB", "MB", "분", "시간", "원", "%"] as const;
