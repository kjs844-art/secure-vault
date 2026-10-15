import type { ReactNode } from "react";

export interface SyntheticDataNoticeProps {
  readonly title: ReactNode;
  readonly children?: ReactNode;
}

/**
 * Persistent warning that the surrounding screen uses synthetic data only.
 * The wording comes from the caller so it can follow the copy catalog.
 */
export function SyntheticDataNotice({ title, children }: SyntheticDataNoticeProps) {
  return (
    <aside className="ka-notice ka-notice--warning" role="note">
      <strong className="ka-notice__title">{title}</strong>
      {children === undefined ? null : (
        <div className="ka-notice__body">{children}</div>
      )}
    </aside>
  );
}
