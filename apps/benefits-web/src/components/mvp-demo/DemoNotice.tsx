import type { CSSProperties } from "react";
import { DEMO_NOTICE } from "../../lib/mvp-demo-data";

const box: CSSProperties = {
  border: "1px solid currentColor",
  padding: "0.85rem 1rem",
  borderRadius: "0.75rem",
};

export function DemoNotice({ extra }: { extra?: string }) {
  return (
    <p role="status" style={box}>
      <strong>DEMO</strong> {DEMO_NOTICE}
      {extra ? ` ${extra}` : ""}
    </p>
  );
}
