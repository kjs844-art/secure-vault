import { useMemo, useState } from "react";
import {
  buildDemoData,
  collectAttention,
  formatAmount,
  sumKnownRemainingByUnit,
} from "../../lib/mvp-demo-data";
import { AttentionList } from "./AttentionList";
import { DemoNotice } from "./DemoNotice";
import { ErrorState } from "./ErrorState";
import { ServiceList } from "./ServiceList";

/**
 * Isolated 5-minute walkthrough: services → benefits → expiry / review.
 * No auth, Gmail, server functions, or vault imports.
 * M01A should mount this inside apps/benefits-web routes when ready.
 */
export function DemoExperience() {
  const [failed, setFailed] = useState(false);
  const dataset = useMemo(() => {
    try {
      return buildDemoData();
    } catch {
      return null;
    }
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(dataset?.services[0]?.id ?? null);

  if (failed || !dataset) {
    return <ErrorState onRetry={() => setFailed(false)} />;
  }

  const attention = collectAttention(dataset);
  const totals = sumKnownRemainingByUnit(dataset.benefits);

  return (
    <div>
      <a href="#demo-services">서비스 목록으로 건너뛰기</a>
      <header>
        <p style={{ letterSpacing: "0.14em", fontSize: "0.75rem", fontWeight: 700 }}>KEYATLAS DEMO</p>
        <h1>가입하고 잊었던 서비스가 이렇게 다시 보입니다.</h1>
        <DemoNotice extra="이 화면의 변경은 계정에 저장되지 않습니다. 실제 메일·키·로그인을 요청하지 않습니다." />
      </header>

      <section aria-label="요약 숫자" style={{ display: "grid", gap: "0.75rem", marginTop: "1.25rem" }}>
        <Stat label="찾은 서비스" value={`${dataset.services.length}`} detail="합성 메일 + 직접 기록" />
        {Object.entries(totals).slice(0, 2).map(([unit, total]) => (
          <Stat
            key={unit}
            label={`${unit} 기준 남은 핵택`}
            value={formatAmount(total, unit)}
            detail="확인된 값만 합산"
          />
        ))}
        <Stat label="확인 필요" value={`${attention.length}`} detail="만료·모름·잔량 0" />
      </section>

      <section aria-labelledby="demo-attention-title" style={{ marginTop: "1.75rem" }}>
        <h2 id="demo-attention-title">만료·확인 필요</h2>
        <AttentionList items={attention} onFocusService={setSelectedId} />
      </section>

      <section id="demo-services" aria-labelledby="demo-services-title" style={{ marginTop: "1.75rem" }}>
        <h2 id="demo-services-title">발견한 서비스와 핵택</h2>
        <p style={{ fontSize: "0.9rem" }}>
          서비스 이름을 선택하거나 화살표 위/아래로 이동합니다. 수치는 자료에 있는 값만 표시합니다.
        </p>
        <ServiceList dataset={dataset} selectedId={selectedId} onSelect={setSelectedId} />
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
