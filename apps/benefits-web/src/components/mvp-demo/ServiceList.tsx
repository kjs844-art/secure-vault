import type { CSSProperties, KeyboardEvent } from "react";
import {
  benefitsForService,
  type DemoDataset,
  type DemoService,
} from "../../lib/mvp-demo-data";
import { formatDemoServiceStatus, getDemoBenefitHistoryReason } from "../../lib/demo-benefit-history";
import { BenefitCard } from "./BenefitCard";
import { EmptyState } from "./EmptyState";

const panel: CSSProperties = {
  border: "1px solid currentColor",
  borderRadius: "1rem",
  marginTop: "1rem",
};

const header: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.75rem",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "0.9rem 1rem",
  borderBottom: "1px solid currentColor",
};

const grid: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  padding: "1rem",
};

export function ServiceList({
  dataset,
  selectedId,
  onSelect,
  referenceTime,
  historyView = false,
}: {
  dataset: DemoDataset;
  selectedId: string | null;
  onSelect: (serviceId: string) => void;
  referenceTime?: number | undefined;
  historyView?: boolean;
}) {
  if (dataset.services.length === 0) {
    return (
      <EmptyState
        title={historyView ? "지난 기록이 없습니다" : "표시할 서비스가 없습니다"}
        detail="선택한 조회 범위에 합성 항목이 없습니다. 실제 계정을 연결하지 않았습니다."
      />
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    const target = dataset.services[(next + dataset.services.length) % dataset.services.length];
    if (!target) return;
    onSelect(target.id);
    document.getElementById(`demo-svc-${target.id}`)?.focus();
  }

  return (
    <div>
      {dataset.services.map((service, index) => (
        <ServiceBlock
          key={service.id}
          service={service}
          selected={service.id === selectedId}
          benefits={benefitsForService(dataset, service.id)}
          onSelect={() => onSelect(service.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
          referenceTime={referenceTime}
          historyView={historyView}
        />
      ))}
    </div>
  );
}

function ServiceBlock({
  service,
  selected,
  benefits,
  onSelect,
  onKeyDown,
  referenceTime,
  historyView,
}: {
  service: DemoService;
  selected: boolean;
  benefits: ReturnType<typeof benefitsForService>;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  referenceTime?: number | undefined;
  historyView: boolean;
}) {
  return (
    <section style={panel} aria-labelledby={`${service.id}-title`}>
      <header style={header}>
        <div>
          <h3 id={`${service.id}-title`} style={{ margin: 0 }}>
            <button
              type="button"
              id={`demo-svc-${service.id}`}
              onClick={onSelect}
              onKeyDown={onKeyDown}
              aria-pressed={selected}
              style={{
                background: selected ? "color-mix(in srgb, currentColor 12%, transparent)" : "transparent",
                color: "inherit",
                border: 0,
                font: "inherit",
                fontWeight: 700,
                cursor: "pointer",
                padding: "0.15rem 0.25rem",
              }}
            >
              {service.name}
            </button>
          </h3>
          <p style={{ margin: "0.2rem 0 0", fontSize: "0.85rem" }}>
            {service.plan_name ?? "요금제 모름"} · {historyView ? "지난 혜택의 서비스 정보 · 현재 계정 상태 미조회" : formatDemoServiceStatus(service, referenceTime)}
            {service.account_label ? ` · ${service.account_label}` : ""}
          </p>
        </div>
      </header>
      <div style={grid}>
        {benefits.length === 0 ? (
          <EmptyState title="혜택 기록 없음" detail="이 서비스에 연결된 합성 혜택이 없습니다." />
        ) : (
          benefits.map((benefit) => <BenefitCard key={benefit.id} benefit={benefit}
            historyReason={historyView && referenceTime !== undefined
              ? getDemoBenefitHistoryReason(benefit, service, referenceTime) ?? undefined : undefined} />)
        )}
      </div>
    </section>
  );
}
