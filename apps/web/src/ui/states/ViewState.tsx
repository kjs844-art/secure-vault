import type { ReactNode } from "react";

import { formatCopy, type CopyCatalog } from "../copy/copyCatalog";

export const viewStateKinds = ["loading", "empty", "offline", "error"] as const;
export type ViewStateKind = (typeof viewStateKinds)[number];

export const viewStateTitleElements = ["h2", "h3", "h4", "p"] as const;
export type ViewStateTitleElement = (typeof viewStateTitleElements)[number];

// Loading and offline are polite status updates; an error interrupts. Empty
// is static content and is not announced.
const liveRoles: Readonly<Record<ViewStateKind, "status" | "alert" | undefined>> = {
  loading: "status",
  empty: undefined,
  offline: "status",
  error: "alert",
};

export interface ViewStateProps {
  readonly kind: ViewStateKind;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Secondary line such as a support reference. Never a raw error message. */
  readonly detail?: ReactNode;
  /** Caller-owned control, for example a retry button. */
  readonly action?: ReactNode;
  readonly titleAs?: ViewStateTitleElement;
}

/**
 * Placeholder shown instead of content while it loads, when it is empty, when
 * the device is offline or when an operation failed. Display only.
 */
export function ViewState({
  kind,
  title,
  description,
  detail,
  action,
  titleAs = "h2",
}: ViewStateProps) {
  if (!viewStateKinds.includes(kind)) {
    throw new Error("Unknown view state kind.");
  }
  if (!viewStateTitleElements.includes(titleAs)) {
    throw new Error("Unsupported view state title element.");
  }
  const Title = titleAs;
  return (
    <div className={`ka-state ka-state--${kind}`} role={liveRoles[kind]}>
      <span className="ka-state__indicator" aria-hidden="true" />
      <Title className="ka-state__title">{title}</Title>
      {description === undefined ? null : (
        <p className="ka-state__description">{description}</p>
      )}
      {detail === undefined ? null : <p className="ka-state__detail">{detail}</p>}
      {action === undefined ? null : <div className="ka-state__action">{action}</div>}
    </div>
  );
}

const referenceCodePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Reference codes are short opaque identifiers. Anything else, such as an
 * exception message that could quote user data, is rejected.
 */
export function isSafeReferenceCode(code: string): boolean {
  return referenceCodePattern.test(code);
}

export interface ViewStateText {
  readonly title: string;
  readonly description?: string;
  readonly detail?: string;
}

/**
 * Default catalog wording for a view state. `referenceCode` only applies to
 * the error state and is dropped unless it passes `isSafeReferenceCode`.
 */
export function viewStateText(
  copy: CopyCatalog,
  kind: ViewStateKind,
  referenceCode?: string,
): ViewStateText {
  const text = copy.viewState;
  switch (kind) {
    case "loading":
      return { title: text.loadingTitle };
    case "empty":
      return { title: text.emptyTitle, description: text.emptyBody };
    case "offline":
      return { title: text.offlineTitle, description: text.offlineBody };
    case "error":
      if (referenceCode !== undefined && isSafeReferenceCode(referenceCode)) {
        return {
          title: text.errorTitle,
          description: text.errorBody,
          detail: formatCopy(text.errorReference, { code: referenceCode }),
        };
      }
      return { title: text.errorTitle, description: text.errorBody };
    default:
      throw new Error("Unknown view state kind.");
  }
}
