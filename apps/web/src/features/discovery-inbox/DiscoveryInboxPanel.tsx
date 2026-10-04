import { useEffect, useMemo, useRef, useState } from "react";
import {
  CONFIDENCE_LABELS,
  FILTER_LABELS,
  SOURCE_KIND_LABELS,
  buildDiscoveryInbox,
  reduceDiscoveryInbox,
  type DiscoveryConfidence,
  type DiscoveryFilter,
  type DiscoveryInboxItem,
  type DiscoveryInboxAction,
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
  sourceLabel = "합성 예시",
}: {
  readonly items?: readonly DiscoveryInboxItem[];
  readonly sourceLabel?: string;
}) {
  const seed = useMemo(
    () => buildDiscoveryInbox(items ?? SYNTHETIC_DISCOVERY_INBOX_ITEMS),
    [items],
  );
  const [state, setState] = useState(() => ({ seed, view: seed }));
  const live = state.seed === seed ? state.view : seed;
  const panel = useRef<HTMLElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const pendingFocus = useRef<{ seed: typeof seed; id: string } | null>(null);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null) return;
    pendingFocus.current = null;
    if (pending.seed !== seed) return;
    const heading = [...(panel.current?.querySelectorAll<HTMLElement>("[data-discovery-item-heading]") ?? [])]
      .find((element) => element.dataset.discoveryItemHeading === pending.id);
    (heading ?? status.current)?.focus();
  }, [live, seed]);

  const transition = (action: DiscoveryInboxAction) => {
    if (action.type === "set-confidence") pendingFocus.current = { seed, id: action.id };
    setState((current) => {
      const base = current.seed === seed ? current.view : seed;
      const next = reduceDiscoveryInbox(base, action);
      return current.seed === seed && next === current.view ? current : { seed, view: next };
    });
  };

  return (
    <main ref={panel} className="discovery-inbox">
      <header>
        <p className="eyebrow">KeyAtlas · 가입 흔적 검토</p>
        <h1>가입 흔적을 확인됨 · 추정 · 확인 필요로 나누기</h1>
        <p>
          자동 전수 조회 결과가 아닙니다. {sourceLabel}만 보여 주며, 메일 본문·내보내기 원문·비밀번호는
          이 화면에 두지 않습니다.
        </p>
        <p className="demo-warning">
          <strong>실제 비밀번호·API 키 입력 금지.</strong> 합성 데이터로 분류를 연습합니다.
          실제 계정·메일 조회와 비밀번호 관리 도구 가져오기는 아직 연결되지 않았습니다.
        </p>
        <p>‘확인됨’은 이 화면의 검토 표시이며 실제 가입·계정 소유를 인증하지 않습니다.
          분류 변경은 이 화면에서만 유지되며, 새로고침하면 원래 예시로 돌아갑니다.</p>
        <a href="/">기존 합성 목록 화면</a>
      </header>

      <nav aria-label="발견 상태 필터" className="discovery-inbox-filters">
        {FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            data-testid={`discovery-filter-${filter}`}
            aria-pressed={live.filter === filter}
            onClick={() => transition({ type: "filter", filter })}
          >
            {FILTER_LABELS[filter]} {live.counts[filter]}
          </button>
        ))}
      </nav>

      <p ref={status} tabIndex={-1} role="status" aria-live="polite" data-testid="discovery-inbox-status">
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
                <h2 tabIndex={-1} data-discovery-item-heading={item.id}>{item.serviceName}</h2>
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
                        onClick={() => transition({
                          type: "set-confidence",
                          id: item.id,
                          confidence: action.confidence,
                        })}
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
