import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CONFIDENCE_LABELS,
  FILTER_LABELS,
  SOURCE_KIND_LABELS,
  buildDiscoveryInbox,
  reduceDiscoveryInbox,
  type DiscoveryConfidence,
  type DiscoveryFilter,
  type DiscoveryInboxItem,
  type DiscoveryInboxView,
} from "./discoveryInboxModel";
import { SYNTHETIC_DISCOVERY_INBOX_ITEMS } from "./syntheticDiscoveryInboxFixture";
import "../../styles.css";
import "./discovery-inbox.css";

const FILTERS: readonly DiscoveryFilter[] = ["open", "confirmed", "inferred", "needs_review", "dismissed"];

function nextActions(confidence: DiscoveryConfidence): readonly { label: string; confidence: DiscoveryConfidence }[] {
  if (confidence === "dismissed") {
    return [
      { label: "확인됨으로 되돌리기", confidence: "confirmed" },
      { label: "확인 필요로 되돌리기", confidence: "needs_review" },
    ];
  }
  return [
    { label: "확인됨", confidence: "confirmed" },
    { label: "추정", confidence: "inferred" },
    { label: "확인 필요", confidence: "needs_review" },
    { label: "오탐으로 숨기기", confidence: "dismissed" },
  ];
}

export function DiscoveryInboxPanel({
  items,
  sourceLabel = "닫힌 합성 예시",
}: {
  readonly items?: readonly DiscoveryInboxItem[];
  readonly sourceLabel?: string;
}) {
  const sourceItems = items ?? SYNTHETIC_DISCOVERY_INBOX_ITEMS;
  const context = useMemo(() => ({
    scope: Symbol("discovery-input"),
    initialView: buildDiscoveryInbox(sourceItems),
  }), [sourceItems]);
  const [state, setState] = useState<{
    scope: symbol;
    view: DiscoveryInboxView;
  }>(() => ({ scope: context.scope, view: context.initialView }));
  // Replacement input renders its initial view without publishing a state reset
  // from a render that React may abandon. Edited arrays do not replace context.
  const { scope, initialView } = context;
  const live = state.scope === scope ? state.view : initialView;
  const committedScope = useRef<symbol | null>(null);
  const selectedFilter = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<{ scope: symbol; trigger: HTMLButtonElement } | null>(null);
  useLayoutEffect(() => {
    committedScope.current = scope;
    return () => {
      if (committedScope.current === scope) committedScope.current = null;
    };
  }, [scope]);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (!pending || pending.scope !== scope || pending.trigger.isConnected) return;
    const owner = pending.trigger.ownerDocument;
    const target = selectedFilter.current;
    if (owner.activeElement === owner.body && target?.isConnected && target.ownerDocument === owner) {
      target.focus({ preventScroll: true });
    }
  }, [scope, live]);
  const dispatch = (action: Parameters<typeof reduceDiscoveryInbox>[1], trigger?: HTMLButtonElement) => {
    // Reject stale callbacks before they can clear a newer pending focus request.
    if (committedScope.current !== scope) return;
    pendingFocus.current = action.type === "set-confidence" && trigger
      && trigger.ownerDocument.activeElement === trigger ? { scope, trigger } : null;
    setState((previous) => {
      // An accepted callback can still be queued across replacement or unmount.
      // Current-generation actions reduce the latest view, not their captured one.
      if (committedScope.current !== scope) return previous;
      const view = previous.scope === scope ? previous.view : initialView;
      return { scope, view: reduceDiscoveryInbox(view, action) };
    });
  };

  return (
    <main className="discovery-inbox">
      <header>
        <p className="eyebrow">KeyAtlas · KA-C04 Discovery Inbox</p>
        <h1>가입 흔적을 확인됨 · 추정 · 확인 필요로 나누기</h1>
        <p>
          자동 전수 조회 결과가 아닙니다. {sourceLabel}만 보여 주며, 메일 본문·내보내기 원문·비밀번호는
          이 화면에 두지 않습니다.
        </p>
        <p className="demo-warning">
          <strong>REAL_SECRET_GATE=CLOSED.</strong> 실제 메일 탐색과 password manager import는 C05~C06
          범위이며 이 화면에 없습니다.
        </p>
        <a href="/">기존 합성 목록 화면</a>
      </header>

      <nav aria-label="발견 상태 필터" className="discovery-inbox-filters">
        {FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            data-testid={`discovery-filter-${filter}`}
            aria-pressed={live.filter === filter}
            ref={live.filter === filter ? selectedFilter : undefined}
            onClick={() => dispatch({ type: "filter", filter })}
          >
            {FILTER_LABELS[filter]} {live.counts[filter]}
          </button>
        ))}
      </nav>

      <p role="status" aria-live="polite" data-testid="discovery-inbox-status">
        {FILTER_LABELS[live.filter]} {live.visible.length}건
      </p>

      {live.visible.length === 0 ? (
        <p data-testid="discovery-inbox-empty">이 필터에 표시할 합성 흔적이 없습니다.</p>
      ) : (
        <ul className="discovery-inbox-list">
          {live.visible.map((item) => (
            <li key={item.id}>
              <article data-testid="discovery-inbox-item">
                <p className="discovery-confidence">{CONFIDENCE_LABELS[item.confidence]}</p>
                <h2>{item.serviceName}</h2>
                <p>{item.accountHint}</p>
                <p>
                  {SOURCE_KIND_LABELS[item.sourceKind]} · {item.sourceLabel} · {item.observedOn}
                </p>
                <p>{item.note}</p>
                <div className="discovery-inbox-actions">
                  {nextActions(item.confidence).map((action) => (
                    action.confidence === item.confidence ? null : (
                      <button
                        key={action.confidence}
                        type="button"
                        data-testid={`discovery-action-${action.confidence}`}
                        onClick={(event) => dispatch({
                          type: "set-confidence",
                          id: item.id,
                          confidence: action.confidence,
                        }, event.currentTarget)}
                      >
                        {action.label}
                      </button>
                    )
                  ))}
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
