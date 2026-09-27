import type { CSSProperties } from "react";

const box: CSSProperties = {
  border: "1px dashed currentColor",
  padding: "1.25rem",
  borderRadius: "0.75rem",
};

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div role="status" style={box}>
      <p>
        <strong>{title}</strong>
      </p>
      <p>{detail}</p>
    </div>
  );
}
