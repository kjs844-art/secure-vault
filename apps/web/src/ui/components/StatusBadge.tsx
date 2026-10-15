import type { ReactNode } from "react";

import { uiTones, type UiTone } from "../tokens/tokens";

export interface StatusBadgeProps {
  readonly tone?: UiTone;
  readonly children: ReactNode;
}

/**
 * Short status label. Meaning is always carried by the text itself; the tone
 * color is only a secondary cue.
 */
export function StatusBadge({ tone = "neutral", children }: StatusBadgeProps) {
  if (!uiTones.includes(tone)) {
    throw new Error("Unknown status badge tone.");
  }
  return <span className={`ka-badge ka-badge--${tone}`}>{children}</span>;
}
