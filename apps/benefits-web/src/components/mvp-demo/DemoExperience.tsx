import { useMemo, useState } from "react";
import {
  buildDemoData,
  collectAttention,
  formatDay,
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
export function DemoExperience({ referenceTime }: { referenceTime: number }) {
  const dataset = useMemo(() => {
    try {
      return buildDemoData(referenceTime);
    } catch {
      return null;
    }
  }, [referenceTime]);
  const [selectedId, setSelectedId] = useState<string | null>(dataset?.services[0]?.id ?? null);

  if (!dataset) {
    return <><DemoNotice /><ErrorState /><a href="/">처음으로 돌아가기</a></>;
  }

  const attention = collectAttention(dataset, new Date(referenceTime));
  function focusService(serviceId: string) {
    if (!dataset?.services.some((service) => service.id === serviceId)) return;
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

      <section aria-label="요약 숫자" style={{ display: "grid", gap: "0.75rem", marginTop: "1.25rem" }}>
        <Stat label="샘플 서비스" value={`${dataset.services.length}`} detail="모두 합성 예시" />
        <Stat label="샘플 혜택" value={`${dataset.benefits.length}`} detail="서로 다른 혜택의 잔량은 합산하지 않음" />
        <Stat label="살펴볼 항목" value={`${attention.length}`} detail="만료·모름·잔량 0" />
      </section>

      <section aria-labelledby="demo-attention-title" style={{ marginTop: "1.75rem" }}>
        <h2 id="demo-attention-title">만료·확인 필요</h2>
        <AttentionList items={attention} onFocusService={focusService} />
      </section>

      <section id="demo-services" tabIndex={-1} aria-labelledby="demo-services-title" style={{ marginTop: "1.75rem" }}>
        <h2 id="demo-services-title">샘플 서비스와 혜택</h2>
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
