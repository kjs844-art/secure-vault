import type { ReactNode } from "react";

/** Width at which the navigation moves beside the content. Mirrors shell.css. */
export const appShellWideMinWidthPx = 960;

const htmlIdPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface AppShellProps {
  readonly brand: ReactNode;
  /** Controls at the end of the header, such as a lock or language button. */
  readonly headerEnd?: ReactNode;
  /** Banner under the header, for example the synthetic-data notice. */
  readonly notice?: ReactNode;
  readonly nav?: ReactNode;
  /** Accessible name of the navigation landmark; required with `nav`. */
  readonly navLabel?: string;
  readonly footer?: ReactNode;
  /** Id of the main landmark, the target for skip links. */
  readonly mainId?: string;
  readonly children: ReactNode;
}

/**
 * Page frame with header, optional notice and navigation, main content and
 * footer. Single column on narrow screens; the navigation becomes a sidebar
 * from `appShellWideMinWidthPx`. Layout only: no state, routing or effects.
 */
export function AppShell({
  brand,
  headerEnd,
  notice,
  nav,
  navLabel,
  footer,
  mainId = "main-content",
  children,
}: AppShellProps) {
  if (nav !== undefined && (navLabel === undefined || navLabel.trim() === "")) {
    throw new Error("Navigation needs an accessible label.");
  }
  if (!htmlIdPattern.test(mainId)) {
    throw new Error("Main landmark id must be a simple HTML id.");
  }
  return (
    <div className={nav === undefined ? "ka-shell" : "ka-shell ka-shell--with-nav"}>
      <header className="ka-shell__header">
        <div className="ka-shell__brand">{brand}</div>
        {headerEnd === undefined ? null : (
          <div className="ka-shell__header-end">{headerEnd}</div>
        )}
      </header>
      {notice === undefined ? null : <div className="ka-shell__notice">{notice}</div>}
      <div className="ka-shell__body">
        {nav === undefined ? null : (
          <nav className="ka-shell__nav" aria-label={navLabel}>
            {nav}
          </nav>
        )}
        <main id={mainId} className="ka-shell__main" tabIndex={-1}>
          {children}
        </main>
      </div>
      {footer === undefined ? null : <footer className="ka-shell__footer">{footer}</footer>}
    </div>
  );
}
