import type { CSSProperties } from "react";
import type { AttentionItem } from "../../lib/mvp-demo-data";
import { EmptyState } from "./EmptyState";

const list: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "0.75rem 0 0",
  display: "grid",
  gap: "0.5rem",
};

const itemStyle: CSSProperties = {
  border: "1px solid currentColor",
  borderRadius: "0.75rem",
  padding: "0.7rem 0.9rem",
};

const KIND_LABEL: Record<AttentionItem["kind"], string> = {
  expiring: "만료",
  needs_review: "확인 필요",
  empty_balance: "잔량 0",
};

export function AttentionList({
  items,
  onFocusService,
}: {
  items: AttentionItem[];
  onFocusService: (serviceId: string) => void;
}) {
  if (items.length === 0) {
    return <EmptyState title="지금 확인할 항목 없음" detail="만료·모름 잔량·잔량 0 항목이 없습니다." />;
  }
  return (
    <ul style={list}>
      {items.map((item) => (
        <li key={item.id} style={itemStyle}>
          <p style={{ margin: 0, fontSize: "0.75rem", letterSpacing: "0.06em" }}>
            {KIND_LABEL[item.kind]}
          </p>
          <p style={{ margin: "0.2rem 0 0", fontWeight: 700 }}>{item.title}</p>
          <p style={{ margin: "0.2rem 0 0", fontSize: "0.9rem" }}>{item.detail}</p>
          <p style={{ margin: "0.45rem 0 0" }}>
            <button type="button" onClick={() => onFocusService(item.serviceId)} style={{
              minWidth: "44px",
              minHeight: "44px",
              padding: "0.45rem 0.75rem",
              font: "inherit",
              color: "inherit",
              background: "transparent",
              border: "1px solid currentColor",
              borderRadius: "0.5rem",
              cursor: "pointer",
            }}>
              해당 서비스 보기
            </button>
          </p>
        </li>
      ))}
    </ul>
  );
}
