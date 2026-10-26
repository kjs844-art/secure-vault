/**
 * Synthetic demo dataset for M02.
 * Server/browser sample records. Never mixed with live accounts, mail, or vault secrets.
 * Source reference: benefit-validator@954da8da src/lib/demo-data.ts (read-only).
 */

export const DEMO_NOTICE =
  "데모 데이터입니다. 저장되지 않으며 실제 계정 데이터와 분리되어 있습니다.";

export const DEMO_DATASET_STAMP = "demo" as const;

export type ResetRule = "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom" | "unknown";
export type SourceKind = "manual" | "ai_text" | "ai_image" | "email" | "import" | "mcp";
export type ObservedPrecision = "minute" | "day";
export type SubscriptionStatus =
  | "active"
  | "trial"
  | "trial_ended"
  | "paused"
  | "cancelled"
  | "unknown";

export interface DemoService {
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

export interface DemoBenefit {
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
  /** Synthetic display facts only, not a provider's current entitlement. */
  benefit_kind?: "credit" | "trial" | "other";
  expires_at?: string | null;
}

export interface DemoDataset {
  dataset: typeof DEMO_DATASET_STAMP;
  notice: string;
  services: DemoService[];
  benefits: DemoBenefit[];
}

export const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  active: "이용 중",
  trial: "무료 체험 중",
  trial_ended: "무료 체험 종료 (계정은 유지)",
  paused: "일시 중지",
  cancelled: "해지됨",
  unknown: "상태 모름",
};

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  manual: "직접 입력",
  ai_text: "AI 분석 (텍스트)",
  ai_image: "AI 분석 (이미지)",
  email: "메일 분석 (합성 예시)",
  import: "가져오기",
  mcp: "AI 도구",
};

function isoDaysAgo(referenceTime: number, daysAgo: number, hours = 9, minutes = 0): string {
  const date = new Date(referenceTime);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  date.setUTCHours(hours, minutes, 0, 0);
  return date.toISOString();
}

function isoDaysFromNow(referenceTime: number, daysFromNow: number): string {
  const date = new Date(referenceTime);
  date.setUTCDate(date.getUTCDate() + daysFromNow);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function isKnownAmount(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isUnknownAmount(value: number | null): boolean {
  return !isKnownAmount(value);
}

export function formatAmount(value: number | null, unit?: string): string {
  if (!isKnownAmount(value)) return "모름";
  const amount = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value === 0 ? 0 : value);
  return unit ? `${amount} ${unit}` : amount;
}

export function remainingRatio(benefit: DemoBenefit): number | null {
  const granted = benefit.granted_amount;
  const remaining = benefit.remaining_amount;
  if (!isKnownAmount(granted) || !isKnownAmount(remaining) || granted === 0) {
    return null;
  }
  if (remaining === 0) return 0;
  if (remaining >= granted) return 1;
  return remaining / granted;
}

export function daysUntil(iso: string | null, now: Date): number | null {
  // A service countdown must not turn a history-ambiguous date into a fact.
  const timestamp = parseDemoInstant(iso);
  if (timestamp === null || !Number.isFinite(now.getTime())) return null;
  const remaining = timestamp - now.getTime();
  // A just-expired timestamp must not round up to negative zero ("today").
  return remaining < 0 ? Math.floor(remaining / 86_400_000) : Math.ceil(remaining / 86_400_000);
}

export function formatDay(iso: string | null): string {
  if (!iso) return "날짜 모름";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "날짜 모름";
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", timeZone: "Asia/Seoul" }).format(date);
}

// Date-only, ambiguous timezone and normalized impossible dates require review.
// This synthetic display helper is not a mail parser or authorization boundary.
export function parseDemoInstant(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

/** 같은 서비스의 체험 기록이 기준 시각보다 뒤에 끝난다고 적혀 있는지. 체험 혜택에만 적용한다. */
export function hasLaterMatchingTrialEnd(
  benefit: DemoBenefit, service: DemoService | undefined, referenceTime: number,
): boolean {
  if (benefit.benefit_kind !== "trial" || !service || service.id !== benefit.service_id) return false;
  if (service.subscription_status !== "trial" && service.subscription_status !== "trial_ended") return false;
  const trialEnd = parseDemoInstant(service.trial_ends_at);
  return trialEnd !== null && trialEnd > referenceTime;
}

/**
 * 현재·확인 필요 보기에 남지만 사용할 수 있는 혜택처럼 보이면 안 되는 행의 확인 사유.
 * - 형식이 모호한 만료일: 만료 여부를 판단할 수 없다.
 * - 만료 시각이 지났지만 같은 서비스의 체험 종료일이 남은 체험: 기록끼리 충돌한다.
 * - 혜택 만료일은 남았지만 같은 서비스 체험은 종료된 기록: 반대 방향 충돌도 확인한다.
 * 지난 기록으로 분류되는 행에는 사유를 돌려주지 않는다(지난 기록 사유와 겹치지 않음).
 */
export function getDemoBenefitReviewReason(
  benefit: DemoBenefit, service: DemoService | undefined, referenceTime: number,
): string | null {
  if (benefit.expires_at == null) return null;
  const expiry = parseDemoInstant(benefit.expires_at);
  if (expiry === null) return "기록된 만료일 형식이 모호함 · 만료 여부 확인 필요";
  if (!Number.isFinite(new Date(referenceTime).getTime())) return null;
  if (expiry > referenceTime) {
    if (benefit.benefit_kind !== "trial" || !service || service.id !== benefit.service_id
      || (service.subscription_status !== "trial" && service.subscription_status !== "trial_ended")) return null;
    const trialEnd = parseDemoInstant(service.trial_ends_at);
    const ended = trialEnd !== null ? trialEnd <= referenceTime
      : service.subscription_status === "trial_ended" && service.trial_ends_at === null;
    return ended ? "서비스 체험은 종료된 기록이지만 혜택 만료일은 남아 있음 · 이용 가능 여부 확인 필요" : null;
  }
  return hasLaterMatchingTrialEnd(benefit, service, referenceTime)
    ? "기록상 만료 시각이 지났지만 서비스 체험 종료일은 남아 있음 · 이용 가능 여부 확인 필요"
    : null;
}

export type AttentionKind = "expiring" | "needs_review" | "empty_balance";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  serviceId: string;
}

export function collectAttention(dataset: DemoDataset, now: Date): AttentionItem[] {
  const items: AttentionItem[] = [];
  const services = new Map(dataset.services.map((service) => [service.id, service]));
  for (const service of dataset.services) {
    if (service.subscription_status !== "trial") continue;
    const days = daysUntil(service.trial_ends_at, now);
    if (days === null || days <= 0) {
      items.push({
        id: `trial-${service.id}`,
        kind: "needs_review",
        title: `${service.name} 체험 상태 확인`,
        detail: days === null ? "체험 종료 시점을 확인해 주세요." : "예정된 종료 시각에 도달했습니다. 현재 상태를 확인해 주세요.",
        serviceId: service.id,
      });
    } else if (days <= 7) {
      items.push({
        id: `trial-${service.id}`,
        kind: "expiring",
        title: `${service.name} 체험 종료`,
        detail: `${days}일 남음`,
        serviceId: service.id,
      });
    }
  }
  for (const benefit of dataset.benefits) {
    if (benefit.remaining_amount === 0) {
      items.push({
        id: `empty-${benefit.id}`,
        kind: "empty_balance",
        title: `${benefit.name} 잔량 0`,
        detail: benefit.extra_limit_note ?? "확인된 0. 추정하지 않음.",
        serviceId: benefit.service_id,
      });
    } else if (isUnknownAmount(benefit.remaining_amount)) {
      items.push({
        id: `review-${benefit.id}`,
        kind: "needs_review",
        title: `${benefit.name} 확인 필요`,
        detail: benefit.extra_limit_note ?? "잔량이 자료에 없어 모름으로 남겼습니다.",
        serviceId: benefit.service_id,
      });
    }
    // 잔량 항목과 별개로, 만료일을 믿을 수 없는 행도 살펴볼 항목에 넣는다.
    const reviewReason = getDemoBenefitReviewReason(benefit, services.get(benefit.service_id), now.getTime());
    if (reviewReason !== null) {
      items.push({
        id: `expiry-${benefit.id}`,
        kind: "needs_review",
        title: `${benefit.name} 만료일 확인 필요`,
        detail: reviewReason,
        serviceId: benefit.service_id,
      });
    }
  }
  return items;
}

/** All synthetic dates derive from the one SSR/client reference timestamp. */
export function buildDemoData(referenceTime: number): DemoDataset {
  if (typeof referenceTime !== "number" || !Number.isFinite(new Date(referenceTime).getTime())) {
    throw new Error("DEMO_REFERENCE_TIME_INVALID");
  }
  const services: DemoService[] = [
    {
      id: "demo-svc-1",
      name: "스트리밍 플러스",
      provider: "Demo Media",
      plan_name: "스탠다드",
      account_label: "샘플 계정",
      timezone: "Asia/Seoul",
      subscription_status: "active",
      trial_ends_at: null,
      notes: null,
    },
    {
      id: "demo-svc-2",
      name: "AI 어시스턴트",
      provider: "Demo Labs",
      plan_name: "무료 체험",
      account_label: "업무용 샘플",
      timezone: "Asia/Seoul",
      subscription_status: "trial",
      trial_ends_at: isoDaysFromNow(referenceTime, 6),
      notes: "체험 종료 후에도 계정은 유지됩니다.",
    },
    {
      id: "demo-svc-3",
      name: "커피 구독",
      provider: "Demo Coffee",
      plan_name: "월 4잔",
      account_label: null,
      timezone: "Asia/Seoul",
      subscription_status: "active",
      trial_ends_at: null,
      notes: null,
    },
    {
      id: "demo-svc-4",
      name: "디자인 스튜디오",
      provider: "Demo Design",
      plan_name: "Pro 체험",
      account_label: "합성 메일 예시",
      timezone: "Asia/Seoul",
      subscription_status: "trial",
      trial_ends_at: isoDaysFromNow(referenceTime, 4),
      notes: "메일에서 확인된 가입 서비스 예시입니다.",
    },
  ];

  const benefits: DemoBenefit[] = [
    {
      id: "demo-b-1",
      service_id: "demo-svc-1",
      name: "동시 시청 기기",
      unit: "개",
      granted_amount: 2,
      remaining_amount: 2,
      monthly_cap: null,
      extra_limit_note: null,
      reset_rule: "none",
      reset_anchor: null,
      observed_at: isoDaysAgo(referenceTime, 2, 21, 30),
      observed_precision: "minute",
      observed_timezone: "Asia/Seoul",
      source_kind: "manual",
      source_note: null,
    },
    {
      id: "demo-b-2",
      service_id: "demo-svc-1",
      name: "오프라인 저장",
      unit: "개",
      granted_amount: 100,
      remaining_amount: 0,
      monthly_cap: null,
      extra_limit_note: "기기당 100개 제한이 따로 있습니다.",
      reset_rule: "unknown",
      reset_anchor: null,
      observed_at: isoDaysAgo(referenceTime, 5, 12, 0),
      observed_precision: "day",
      observed_timezone: "Asia/Seoul",
      source_kind: "ai_image",
      source_note: "앱 설정 화면 캡처에서 추출(합성)",
    },
    {
      id: "demo-b-3",
      service_id: "demo-svc-2",
      name: "고급 모델 요청",
      unit: "회",
      granted_amount: 50,
      remaining_amount: 12,
      monthly_cap: 200,
      extra_limit_note: "월 200회 상한이 별도로 적용됩니다.",
      reset_rule: "daily",
      reset_anchor: isoDaysFromNow(referenceTime, 0),
      observed_at: isoDaysAgo(referenceTime, 1, 3, 15),
      observed_precision: "minute",
      observed_timezone: "Asia/Seoul",
      source_kind: "ai_text",
      source_note: "요금제 안내문 붙여넣기(합성)",
    },
    {
      id: "demo-b-4",
      service_id: "demo-svc-2",
      name: "파일 업로드 용량",
      unit: "GB",
      granted_amount: null,
      remaining_amount: null,
      monthly_cap: null,
      extra_limit_note: "안내문에 수치가 없어 확인하지 못했습니다.",
      reset_rule: "unknown",
      reset_anchor: null,
      observed_at: isoDaysAgo(referenceTime, 1, 3, 15),
      observed_precision: "minute",
      observed_timezone: "Asia/Seoul",
      source_kind: "ai_text",
      source_note: "값을 찾지 못해 '모름'으로 기록",
    },
    {
      id: "demo-b-5",
      service_id: "demo-svc-3",
      name: "무료 음료 쿠폰",
      unit: "회",
      granted_amount: 4,
      remaining_amount: 1,
      monthly_cap: 4,
      extra_limit_note: null,
      reset_rule: "monthly",
      reset_anchor: isoDaysFromNow(referenceTime, 3),
      observed_at: isoDaysAgo(referenceTime, 9, 10, 0),
      observed_precision: "day",
      observed_timezone: "Asia/Seoul",
      source_kind: "manual",
      source_note: null,
    },
    {
      id: "demo-b-6",
      service_id: "demo-svc-4",
      name: "Pro 무료 체험",
      unit: "일",
      granted_amount: 14,
      remaining_amount: null,
      monthly_cap: null,
      extra_limit_note: "메일에 현재 남은 기간이 없어 잔량 확인 필요",
      reset_rule: "none",
      reset_anchor: null,
      observed_at: isoDaysAgo(referenceTime, 1, 0, 0),
      observed_precision: "day",
      observed_timezone: "Asia/Seoul",
      source_kind: "email",
      source_note: "합성 근거: Pro 무료 체험이 시작되었습니다",
    },
  ];

  return {
    dataset: DEMO_DATASET_STAMP,
    notice: DEMO_NOTICE,
    services,
    benefits,
  };
}

export function benefitsForService(dataset: DemoDataset, serviceId: string): DemoBenefit[] {
  return dataset.benefits.filter((benefit) => benefit.service_id === serviceId);
}
