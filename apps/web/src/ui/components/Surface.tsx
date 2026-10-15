import type { ReactNode } from "react";

export const surfaceElements = ["div", "section", "article"] as const;
export type SurfaceElement = (typeof surfaceElements)[number];

export interface SurfaceProps {
  readonly as?: SurfaceElement;
  readonly labelledBy?: string;
  readonly children: ReactNode;
}

/**
 * Bordered content panel. Use `section` or `article` only together with a
 * visible heading referenced by `labelledBy`.
 */
export function Surface({ as = "div", labelledBy, children }: SurfaceProps) {
  if (!surfaceElements.includes(as)) {
    throw new Error("Unsupported surface element.");
  }
  if (as !== "div" && labelledBy === undefined) {
    throw new Error("Landmark surfaces need a labelling heading id.");
  }
  const Element = as;
  return (
    <Element className="ka-surface" aria-labelledby={labelledBy}>
      {children}
    </Element>
  );
}
