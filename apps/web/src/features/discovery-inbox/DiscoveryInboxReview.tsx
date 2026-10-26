import { useLayoutEffect, useRef, useState } from "react";
import {
  CONFIDENCE_LABELS, FILTER_LABELS, SOURCE_KIND_LABELS,
  type DiscoveryConfidence, type DiscoveryFilter, type DiscoveryInboxAction, type DiscoveryInboxView,
} from "./discoveryInboxModel";
import "./discovery-inbox.css";

const FILTERS: readonly DiscoveryFilter[] = ["open", "confirmed", "needs_review", "dismissed"];
const ACTIONS = [
  { label: "확인됨", confidence: "confirmed" },
  { label: "확인 필요", confidence: "needs_review" },
  { label: "오탐으로 숨기기", confidence: "dismissed" },
] as const;

/** C06-only controlled presentation. No candidates, consent or lifetime are owned here. */
export function DiscoveryInboxReview({ view, onAction, focusScope }: {
  readonly view: DiscoveryInboxView;
  readonly onAction: (action: DiscoveryInboxAction) => void;
  readonly focusScope: object;
}) {
  const [binding, setBinding] = useState(() => ({ owner: focusScope, token: Symbol("mail-review") }));
  let current = binding;
  if (binding.owner !== focusScope) {
    current = { owner: focusScope, token: Symbol("mail-review") };
    setBinding(current);
  }
  const token = current.token;
  const committed = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    committed.current = token;
    return () => { if (committed.current === token) committed.current = null; };
  }, [token]);
  // Action frames expire on every committed render; the separate owner token
  // keeps a valid focus handoff alive across that render.
  const actionFrame = Symbol("mail-review-action");
  const committedAction = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    committedAction.current = actionFrame;
    return () => { if (committedAction.current === actionFrame) committedAction.current = null; };
  }, [actionFrame]);
  const selectedFilter = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<{ token: symbol; trigger: HTMLButtonElement } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (!pending || pending.token !== token || pending.trigger.isConnected) return;
    const owner = pending.trigger.ownerDocument;
    const target = selectedFilter.current;
    if (owner.activeElement === owner.body && target?.isConnected && target.ownerDocument === owner) {
      target.focus({ preventScroll: true });
    }
  }, [token, view]);
  const dispatch = (action: DiscoveryInboxAction, trigger?: HTMLButtonElement) => {
    // Commit-only publication rejects callbacks from replaced, unmounted and
    // A -> B -> fresh-A owners before any pending-focus or owner state mutation.
    if (committed.current !== token || committedAction.current !== actionFrame) return;
    // Consume before any focus mutation or owner callback can reenter dispatch.
    committedAction.current = null;
    pendingFocus.current = action.type === "set-confidence" && trigger
      && trigger.ownerDocument.activeElement === trigger ? { token, trigger } : null;
    onAction(action);
  };
  const label = (confidence: DiscoveryConfidence, text: string) => confidence === "dismissed"
    ? `${text}으로 되돌리기` : text;

  return (
    <div className="discovery-inbox">
      <nav aria-label="발견 상태 필터" className="discovery-inbox-filters">
        {FILTERS.map((filter) => (
          <button key={filter} type="button" data-testid={`discovery-filter-${filter}`}
            ref={view.filter === filter ? selectedFilter : undefined}
            aria-pressed={view.filter === filter} onClick={() => dispatch({ type: "filter", filter })}>
            {FILTER_LABELS[filter]} {view.counts[filter]}
          </button>
        ))}
      </nav>
      <p role="status" aria-live="polite" data-testid="discovery-inbox-status">
        {FILTER_LABELS[view.filter]} {view.visible.length}건
      </p>
      {view.visible.length === 0 ? (
        <p data-testid="discovery-inbox-empty">이 필터에 표시할 합성 흔적이 없습니다.</p>
      ) : (
        <ul className="discovery-inbox-list">
          {view.visible.map((item) => (
            <li key={item.id}>
              <article data-testid="discovery-inbox-item">
                <p className="discovery-confidence">{CONFIDENCE_LABELS[item.confidence]}</p>
                <h3>{item.serviceName}</h3>
                <p>{item.accountHint}</p>
                <p>{SOURCE_KIND_LABELS[item.sourceKind]} · {item.sourceLabel} · {item.observedOn} (UTC 날짜)</p>
                <p>{item.note}</p>
                <div className="discovery-inbox-actions">
                  {ACTIONS.filter((action) => action.confidence !== item.confidence).map((action) => (
                    <button key={action.confidence} type="button" data-testid={`discovery-action-${action.confidence}`}
                      onClick={(event) => dispatch({ type: "set-confidence", id: item.id,
                        confidence: action.confidence }, event.currentTarget)}>
                      {label(item.confidence, action.label)}
                    </button>
                  ))}
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
