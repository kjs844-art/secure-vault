import type { CSSProperties } from "react";
import {
  formatAmount,
  remainingRatio,
  SOURCE_KIND_LABELS,
  type DemoBenefit,
} from "../../lib/mvp-demo-data";

const card: CSSProperties = {
  border: "1px solid currentColor",
  borderRadius: "0.75rem",
  padding: "0.9rem 1rem",
};

const meter: CSSProperties = {
  height: "0.4rem",
  background: "color-mix(in srgb, currentColor 18%, transparent)",
  borderRadius: "999px",
  marginTop: "0.5rem",
};

export function BenefitCard({ benefit }: { benefit: DemoBenefit }) {
  const ratio = remainingRatio(benefit);
  return (
    <article style={card} aria-labelledby={`${benefit.id}-name`}>
      <h4 id={`${benefit.id}-name`} style={{ margin: 0 }}>
        {benefit.name}
      </h4>
      <p style={{ margin: "0.35rem 0 0" }}>
        남음 {formatAmount(benefit.remaining_amount, benefit.unit)}
        {" · "}
        지급 {formatAmount(benefit.granted_amount, benefit.unit)}
      </p>
      <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
        {SOURCE_KIND_LABELS[benefit.source_kind]}
        {benefit.source_note ? ` · ${benefit.source_note}` : ""}
      </p>
      {ratio === null ? (
        <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
          비율을 계산할 수 없습니다 (모름 값 유지).
        </p>
      ) : (
        <div
          style={meter}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
          aria-label={`${benefit.name} 남은 비율`}
        >
          <div
            style={{
              width: `${Math.round(ratio * 100)}%`,
              height: "100%",
              background: "currentColor",
              borderRadius: "999px",
            }}
          />
        </div>
      )}
      {benefit.extra_limit_note ? (
        <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>{benefit.extra_limit_note}</p>
      ) : null}
    </article>
  );
}
