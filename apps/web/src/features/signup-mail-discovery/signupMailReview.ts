import {
  buildDiscoveryInbox,
  type DiscoveryFilter,
  type DiscoveryInboxAction,
  type DiscoveryInboxView,
} from "../discovery-inbox/discoveryInboxModel";
import {
  MailDiscoveryError,
  type SignupMailSignal,
  type SignupMailView,
  type SyntheticSignupMailDiscoverySession,
} from "./signupMailDiscovery";

const SIGNAL_LABELS: Readonly<Record<SignupMailSignal, string>> = Object.freeze({
  welcome: "가입 환영 문구",
  registration: "가입 완료 문구",
  email_verification: "이메일 인증 문구",
});

function reviewFilter(filter: DiscoveryFilter): DiscoveryFilter {
  return filter === "confirmed" || filter === "needs_review" || filter === "dismissed" ? filter : "open";
}

/** Presentation only: the scan session remains the sole owner of candidates. */
export function projectSignupMailReview(
  view: SignupMailView,
  filter: DiscoveryFilter = "open",
): DiscoveryInboxView {
  const items = view.phase === "review" ? view.hints.map((hint) => ({
    id: hint.serviceId,
    serviceName: hint.serviceName,
    accountHint: "계정 정보 없음 · 가입 여부와 계정 소유는 직접 확인 필요",
    confidence: hint.confidence,
    sourceKind: "mail_hint" as const,
    sourceLabel: "합성 메일의 가입 문구",
    observedOn: hint.observedOn,
    note: hint.signals.map((signal) => SIGNAL_LABELS[signal]).join(" · "),
  })) : [];
  return buildDiscoveryInbox(items, reviewFilter(filter));
}

/** Never replay a retained presentation snapshot or start a new consent lifetime. */
export function transitionSignupMailReview(
  session: SyntheticSignupMailDiscoverySession,
  currentFilter: DiscoveryFilter,
  action: DiscoveryInboxAction,
): { readonly view: SignupMailView; readonly inbox: DiscoveryInboxView } {
  let view = session.view();
  let filter = reviewFilter(currentFilter);
  if (action.type === "filter") filter = reviewFilter(action.filter);
  else if (action.type === "reset") filter = "open";
  if (view.phase === "review") {
    if (action.type === "set-confidence"
      && action.confidence !== "inferred"
      && ["confirmed", "needs_review", "dismissed"].includes(action.confidence)
      && view.hints.some((hint) => hint.serviceId === action.id)) {
      try {
        session.setConfidence(action.id, action.confidence);
      } catch (error) {
        // Time can pass between the first view and the session's mutation guard.
        if (!(error instanceof MailDiscoveryError)
          || (error.code !== "SESSION_EXPIRED" && error.code !== "SESSION_CLOSED")) throw error;
      }
    }
    view = session.view();
  }
  return Object.freeze({ view, inbox: projectSignupMailReview(view, filter) });
}
