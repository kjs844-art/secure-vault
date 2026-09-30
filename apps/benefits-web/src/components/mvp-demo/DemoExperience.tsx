import { useMemo, useState } from "react";
import {
  collectAttention,
  formatDay,
} from "../../lib/mvp-demo-data";
import { buildDemoDataWithHistory, selectDemoHistoryView, type DemoHistoryView } from "../../lib/demo-benefit-history";
import { AttentionList } from "./AttentionList";
import { DemoNotice } from "./DemoNotice";
import { ErrorState } from "./ErrorState";
import { ServiceList } from "./ServiceList";

/**
 * Isolated 5-minute walkthrough: services → benefits → expiry / review.
 * No auth, Gmail, server functions, or vault imports.
 * M01A should mount this inside apps/benefits-web routes when ready.
 */
export function DemoExperience({ referenceTime }: { referenceTime: number }) {
  const dataset = useMemo(() => {
    try {
      return buildDemoDataWithHistory(referenceTime);
    } catch {
      return null;
    }
  }, [referenceTime]);
  const [selectedId, setSelectedId] = useState<string | null>(dataset?.services[0]?.id ?? null);
  const [view, setView] = useState<DemoHistoryView>("review");
  const visibleDataset = useMemo(() => dataset ? selectDemoHistoryView(dataset, view, referenceTime) : null,
    [dataset, view, referenceTime]);

  if (!dataset || !visibleDataset) {
    return <><DemoNotice /><ErrorState /><a href="/">처음으로 돌아가기</a></>;
  }

  const attention = view === "review" ? collectAttention(visibleDataset, new Date(referenceTime)) : [];
  const effectiveSelectedId = visibleDataset.services.some((service) => service.id === selectedId)
    ? selectedId : visibleDataset.services[0]?.id ?? null;
  function changeView(nextView: DemoHistoryView) {
    setView(nextView);
    setSelectedId(selectDemoHistoryView(dataset!, nextView, referenceTime).services[0]?.id ?? null);
  }
  function focusService(serviceId: string) {
    if (!visibleDataset?.services.some((service) => service.id === serviceId)) return;
    setSelectedId(serviceId);
    const target = document.getElementById(`demo-svc-${serviceId}`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center" });
  }

  return (
    <div>
      <a href="#demo-services">서비스 목록으로 건너뛰기</a>
      <header>
        <p style={{ letterSpacing: "0.14em", fontSize: "0.75rem", fontWeight: 700 }}>KEYATLAS DEMO</p>
        <h1>서비스와 혜택을 한곳에서 살펴보세요</h1>
        <DemoNotice extra="이 화면의 변경은 계정에 저장되지 않습니다. 실제 메일·키·로그인을 요청하지 않습니다." />
        <p>샘플 기준일: {formatDay(new Date(referenceTime).toISOString())} (한국 시간).
          이 화면을 열 때 만든 예시이며 실제 가입 내역을 조회한 결과가 아닙니다.</p>
      </header>

      <div className="history-filter" role="group" aria-label="혜택 조회 범위" style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", marginTop: "1rem" }}>
        <button type="button" aria-pressed={view === "review"} aria-controls="demo-services" onClick={() => changeView("review")}>
          현재·확인 필요 보기
        </button>
        <button type="button" aria-pressed={view === "history"} aria-controls="demo-services" onClick={() => changeView("history")}>
          지난 기록 보기
        </button>
      </div>
      <p role="status" aria-live="polite">
        {view === "history" ? "지난 기록 조회 중 · 기록은 삭제하지 않으며 현재 사용 가능한 혜택과 구분합니다."
          : "현재·확인 필요 조회 중 · 지난 기록은 버튼을 눌러 따로 볼 수 있습니다."}
      </p>
      <p>기록된 만료·체험 종료를 기준으로 분리합니다. 오래된 메일이나 잔량 0만으로 만료를 단정하지 않습니다. 현재 잔액·이용 가능 여부는 실제 조회한 것이 아닙니다.</p>

      <section aria-label="요약 숫자" style={{ display: "grid", gap: "0.75rem", marginTop: "1.25rem" }}>
        <Stat label="샘플 서비스" value={`${visibleDataset.services.length}`} detail="모두 합성 예시" />
        <Stat label="샘플 혜택" value={`${visibleDataset.benefits.length}`} detail="서로 다른 혜택의 잔량은 합산하지 않음" />
        <Stat label="살펴볼 항목" value={`${attention.length}`} detail="만료·모름·잔량 0" />
      </section>

      {view === "review" && <section aria-labelledby="demo-attention-title" style={{ marginTop: "1.75rem" }}>
        <h2 id="demo-attention-title">만료·확인 필요</h2>
        <AttentionList items={attention} onFocusService={focusService} />
      </section>}

      <section id="demo-services" tabIndex={-1} aria-labelledby="demo-services-title" style={{ marginTop: "1.75rem" }}>
        <h2 id="demo-services-title">{view === "history" ? "지난 크레딧·체험판 기록" : "샘플 서비스와 혜택"}</h2>
        <p style={{ fontSize: "0.9rem" }}>
          서비스 이름을 선택하거나 화살표 위/아래로 이동합니다. 수치는 자료에 있는 값만 표시합니다.
        </p>
        <ServiceList dataset={visibleDataset} selectedId={effectiveSelectedId} onSelect={setSelectedId}
          referenceTime={referenceTime} historyView={view === "history"} />
      </section>
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div style={{ border: "1px solid currentColor", borderRadius: "0.85rem", padding: "0.85rem 1rem" }}>
      <p style={{ margin: 0, fontSize: "0.8rem" }}>{label}</p>
      <p style={{ margin: "0.35rem 0 0", fontSize: "1.6rem", fontWeight: 700 }}>{value}</p>
      <p style={{ margin: "0.25rem 0 0", fontSize: "0.8rem" }}>{detail}</p>
    </div>
  );
}
