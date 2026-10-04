export const DISCOVERY_CONFIDENCE = ["confirmed", "inferred", "needs_review", "dismissed"] as const;
export type DiscoveryConfidence = (typeof DISCOVERY_CONFIDENCE)[number];

export const DISCOVERY_SOURCE_KINDS = [
  "manual",
  "official_notice",
  "export_hint",
  "mail_hint",
  "password_manager_hint",
] as const;
export type DiscoverySourceKind = (typeof DISCOVERY_SOURCE_KINDS)[number];

export const DISCOVERY_FILTERS = ["open", "confirmed", "inferred", "needs_review", "dismissed"] as const;
export type DiscoveryFilter = (typeof DISCOVERY_FILTERS)[number];

export interface DiscoveryInboxItem {
  readonly id: string;
  readonly serviceName: string;
  readonly accountHint: string;
  readonly confidence: DiscoveryConfidence;
  readonly sourceKind: DiscoverySourceKind;
  readonly sourceLabel: string;
  readonly observedOn: string;
  readonly note: string;
}

export interface DiscoveryInboxView {
  readonly filter: DiscoveryFilter;
  readonly items: readonly DiscoveryInboxItem[];
  readonly visible: readonly DiscoveryInboxItem[];
  readonly counts: Readonly<Record<DiscoveryFilter, number>>;
}

export type DiscoveryInboxAction =
  | { readonly type: "filter"; readonly filter: DiscoveryFilter }
  | { readonly type: "set-confidence"; readonly id: string; readonly confidence: DiscoveryConfidence }
  | { readonly type: "reset" };

const EMPTY_COUNTS: Record<DiscoveryFilter, number> = Object.freeze({
  open: 0,
  confirmed: 0,
  inferred: 0,
  needs_review: 0,
  dismissed: 0,
});

export const CONFIDENCE_LABELS: Record<DiscoveryConfidence, string> = {
  confirmed: "확인됨",
  inferred: "추정",
  needs_review: "확인 필요",
  dismissed: "오탐",
};

export const SOURCE_KIND_LABELS: Record<DiscoverySourceKind, string> = {
  manual: "수동 기록",
  official_notice: "공식 안내 예시",
  export_hint: "내보내기 힌트",
  mail_hint: "메일 힌트",
  password_manager_hint: "비밀번호 관리자 힌트",
};

export const FILTER_LABELS: Record<DiscoveryFilter, string> = {
  open: "열린 항목",
  confirmed: "확인됨",
  inferred: "추정",
  needs_review: "확인 필요",
  dismissed: "오탐",
};

function isUsableItem(item: DiscoveryInboxItem | null | undefined): item is DiscoveryInboxItem {
  if (item == null) return false;
  if (typeof item.id !== "string" || item.id.length === 0) return false;
  if (typeof item.serviceName !== "string" || typeof item.accountHint !== "string") return false;
  if (typeof item.sourceLabel !== "string" || typeof item.observedOn !== "string" || typeof item.note !== "string") {
    return false;
  }
  return DISCOVERY_CONFIDENCE.includes(item.confidence) && DISCOVERY_SOURCE_KINDS.includes(item.sourceKind);
}

function countsOf(items: readonly DiscoveryInboxItem[]): Record<DiscoveryFilter, number> {
  const counts = { ...EMPTY_COUNTS };
  for (const item of items) {
    counts[item.confidence] += 1;
    if (item.confidence !== "dismissed") counts.open += 1;
  }
  return Object.freeze(counts);
}

function visibleOf(items: readonly DiscoveryInboxItem[], filter: DiscoveryFilter): readonly DiscoveryInboxItem[] {
  if (filter === "open") return Object.freeze(items.filter((item) => item.confidence !== "dismissed"));
  return Object.freeze(items.filter((item) => item.confidence === filter));
}

export function emptyDiscoveryInboxView(): DiscoveryInboxView {
  return Object.freeze({
    filter: "open",
    items: Object.freeze([]),
    visible: Object.freeze([]),
    counts: EMPTY_COUNTS,
  });
}

export function buildDiscoveryInbox(
  items: readonly DiscoveryInboxItem[] | null | undefined,
  filter: DiscoveryFilter = "open",
): DiscoveryInboxView {
  if (!Array.isArray(items)) return emptyDiscoveryInboxView();
  const usable: DiscoveryInboxItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isUsableItem(item) || seen.has(item.id)) continue;
    seen.add(item.id);
    usable.push(Object.freeze({
      id: item.id,
      serviceName: item.serviceName,
      accountHint: item.accountHint,
      confidence: item.confidence,
      sourceKind: item.sourceKind,
      sourceLabel: item.sourceLabel,
      observedOn: item.observedOn,
      note: item.note,
    }));
  }
  const frozen = Object.freeze(usable);
  return Object.freeze({
    filter: DISCOVERY_FILTERS.includes(filter) ? filter : "open",
    items: frozen,
    visible: visibleOf(frozen, DISCOVERY_FILTERS.includes(filter) ? filter : "open"),
    counts: countsOf(frozen),
  });
}

export function reduceDiscoveryInbox(view: DiscoveryInboxView, action: DiscoveryInboxAction): DiscoveryInboxView {
  switch (action.type) {
    case "reset":
      return buildDiscoveryInbox(view.items, "open");
    case "filter":
      if (!DISCOVERY_FILTERS.includes(action.filter) || action.filter === view.filter) return view;
      return buildDiscoveryInbox(view.items, action.filter);
    case "set-confidence": {
      if (!DISCOVERY_CONFIDENCE.includes(action.confidence)) return view;
      let changed = false;
      const next = view.items.map((item) => {
        if (item.id !== action.id || item.confidence === action.confidence) return item;
        changed = true;
        return Object.freeze({ ...item, confidence: action.confidence });
      });
      if (!changed) return view;
      return buildDiscoveryInbox(next, view.filter);
    }
    default:
      return view;
  }
}
