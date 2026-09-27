/**
 * Synthetic demo dataset for M02.
 * Browser-only sample records. Never mixed with live accounts, mail, or vault secrets.
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

function isoDaysAgo(daysAgo: number, hours = 9, minutes = 0): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  date.setUTCHours(hours, minutes, 0, 0);
  return date.toISOString();
}

function isoDaysFromNow(daysFromNow: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromNow);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

export function isUnknownAmount(value: number | null): boolean {
  return typeof value !== "number" || !Number.isFinite(value);
}

export function formatAmount(value: number | null, unit?: string): string {
  if (isUnknownAmount(value)) return "모름";
  const amount = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value);
  return unit ? `${amount} ${unit}` : amount;
}

export function remainingRatio(benefit: DemoBenefit): number | null {
  if (isUnknownAmount(benefit.granted_amount) || isUnknownAmount(benefit.remaining_amount)) {
    return null;
  }
  if (benefit.granted_amount <= 0) return null;
  if (benefit.remaining_amount <= 0) return 0;
  if (benefit.remaining_amount >= benefit.granted_amount) return 1;
  return benefit.remaining_amount / benefit.granted_amount;
}

export function sumKnownRemainingByUnit(benefits: DemoBenefit[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const benefit of benefits) {
    if (isUnknownAmount(benefit.remaining_amount)) continue;
    totals[benefit.unit] = (totals[benefit.unit] ?? 0) + benefit.remaining_amount;
  }
  return totals;
}

export function daysUntil(iso: string | null, now = new Date()): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return Math.ceil((date.getTime() - now.getTime()) / 86_400_000);
}

export function formatDay(iso: string | null): string {
  if (!iso) return "날짜 모름";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "날짜 모름";
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" }).format(date);
}

export type AttentionKind = "expiring" | "needs_review" | "empty_balance";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  serviceId: string;
}

export function collectAttention(dataset: DemoDataset, now = new Date()): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const service of dataset.services) {
    const days = daysUntil(service.trial_ends_at, now);
    if (service.subscription_status === "trial" && days !== null && days <= 7) {
      items.push({
        id: `trial-${service.id}`,
        kind: "expiring",
        title: `${service.name} 체험 종료`,
        detail: days <= 0 ? "오늘 종료 예정" : `${days}일 남음`,
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
  }
  return items;
}

/** Built at call time so dates stay relative to "now". */
export function buildDemoData(): DemoDataset {
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
      trial_ends_at: isoDaysFromNow(6),
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
      trial_ends_at: isoDaysFromNow(4),
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
      observed_at: isoDaysAgo(2, 21, 30),
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
      observed_at: isoDaysAgo(5, 12, 0),
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
      reset_anchor: isoDaysFromNow(0),
      observed_at: isoDaysAgo(1, 3, 15),
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
      observed_at: isoDaysAgo(1, 3, 15),
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
      reset_anchor: isoDaysFromNow(3),
      observed_at: isoDaysAgo(9, 10, 0),
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
      observed_at: isoDaysAgo(1, 0, 0),
      observed_precision: "day",
      observed_timezone: "Asia/Seoul",
      source_kind: "email",
      source_note: "합성 근거: 2026-09-19 · Pro 무료 체험이 시작되었습니다",
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
