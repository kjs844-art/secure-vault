import { buildDemoData, STATUS_LABELS, type DemoBenefit, type DemoDataset, type DemoService } from "./mvp-demo-data";

export type DemoHistoryView = "review" | "history";

// Date-only, ambiguous timezone and normalized impossible dates require review.
// This synthetic display helper is not a mail parser or authorization boundary.
function instant(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

export function getDemoBenefitHistoryReason(
  benefit: DemoBenefit, service: DemoService | undefined, referenceTime: number,
): string | null {
  if (!Number.isFinite(referenceTime) || !Number.isFinite(new Date(referenceTime).getTime())) return null;
  const expiry = instant(benefit.expires_at);
  if (expiry !== null && expiry <= referenceTime) {
    // Matching trial facts that disagree about whether it ended need review.
    // A future service trial does not override an unrelated credit's expiry.
    const matchingTrial = benefit.benefit_kind === "trial" && service?.id === benefit.service_id
      && (service.subscription_status === "trial" || service.subscription_status === "trial_ended");
    const serviceTrialExpiry = matchingTrial ? instant(service.trial_ends_at) : null;
    if (serviceTrialExpiry !== null && serviceTrialExpiry > referenceTime) return null;
    return "기록상 만료 시각이 지난 혜택 · 연장·재지급 여부는 별도 확인";
  }
  // Do not apply a service's trial expiry to unrelated credits or subscriptions.
  if (benefit.benefit_kind !== "trial" || !service || service.id !== benefit.service_id) return null;
  if (service.subscription_status !== "trial" && service.subscription_status !== "trial_ended") return null;
  const trialExpiry = instant(service.trial_ends_at);
  // A later benefit expiry conflicts with an earlier service-level trial end.
  if (benefit.expires_at != null && (expiry === null || expiry > referenceTime)) return null;
  if (service.subscription_status === "trial_ended" && service.trial_ends_at === null) {
    return "기록상 무료 체험 종료 · 계정 해지나 재가입 여부를 뜻하지 않음";
  }
  return trialExpiry !== null && trialExpiry <= referenceTime
    ? "기록상 무료 체험 종료일 지남 · 연장 여부는 별도 확인"
    : null;
}

export function selectDemoHistoryView(
  dataset: DemoDataset, view: DemoHistoryView, referenceTime: number,
): DemoDataset {
  const services = new Map(dataset.services.map((service) => [service.id, service]));
  const benefits = dataset.benefits.filter((benefit) => {
    const historical = getDemoBenefitHistoryReason(benefit, services.get(benefit.service_id), referenceTime) !== null;
    return view === "history" ? historical : !historical;
  });
  const visibleIds = new Set(benefits.map((benefit) => benefit.service_id));
  const originalIds = new Set(dataset.benefits.map((benefit) => benefit.service_id));
  return {
    ...dataset,
    services: dataset.services.filter((service) => visibleIds.has(service.id)
      || (view === "review" && !originalIds.has(service.id))),
    benefits,
  };
}

export function formatDemoRecordDate(value: string | null | undefined): string {
  const parsed = instant(value);
  if (parsed === null) return "날짜 확인 필요";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Seoul",
  }).format(new Date(parsed));
}

export function formatDemoServiceStatus(service: DemoService, referenceTime: number | undefined): string {
  if (service.subscription_status === "trial_ended") return "기록상 무료 체험 종료 · 현재 계정 상태 확인 필요";
  const expiry = instant(service.trial_ends_at);
  if (service.subscription_status === "trial" && expiry !== null
    && referenceTime !== undefined && Number.isFinite(referenceTime) && expiry <= referenceTime) {
    return "기록상 체험 종료일 지남 · 현재 상태 확인 필요";
  }
  return STATUS_LABELS[service.subscription_status];
}

/** Optional history demonstration; the original six current/review fixtures remain unchanged. */
export function buildDemoDataWithHistory(referenceTime: number): DemoDataset {
  const dataset = buildDemoData(referenceTime);
  const past = (days: number) => new Date(referenceTime - days * 86_400_000).toISOString();
  dataset.services.push({
    id: "demo-svc-history", name: "이전 체험 서비스", provider: "Demo History",
    plan_name: "종료된 체험 기록", account_label: "합성 과거 기록", timezone: "Asia/Seoul",
    subscription_status: "trial_ended", trial_ends_at: past(10), notes: null,
  });
  const template = dataset.benefits[0]!;
  dataset.benefits.push({
    ...template, id: "demo-b-history-credit", service_id: dataset.services[0]!.id,
    name: "지난 프로모션 크레딧", unit: "크레딧", benefit_kind: "credit",
    granted_amount: 100, remaining_amount: 80, expires_at: past(14),
    observed_at: past(30), monthly_cap: null, reset_rule: "none", reset_anchor: null,
    extra_limit_note: "80은 당시 기록이며 현재 사용할 수 있는 잔액이 아닙니다.",
    source_kind: "email", source_note: "합성 메일의 과거 지급·만료 안내 예시",
  }, {
    ...template, id: "demo-b-history-trial", service_id: "demo-svc-history",
    name: "지난 14일 무료 체험", unit: "일", benefit_kind: "trial",
    granted_amount: 14, remaining_amount: null, expires_at: null,
    observed_at: past(24), monthly_cap: null, reset_rule: "none", reset_anchor: null,
    extra_limit_note: "지난 체험 기록을 보존합니다. 현재 계정 상태는 조회하지 않습니다.",
    source_kind: "email", source_note: "합성 메일의 체험 종료 안내 예시",
  });
  return dataset;
}
