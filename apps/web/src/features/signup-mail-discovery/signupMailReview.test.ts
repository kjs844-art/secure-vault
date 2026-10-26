import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../../../tests/fixtures/synthetic/signup-mail-discovery-v1.json";
import type { DiscoveryInboxAction } from "../discovery-inbox/discoveryInboxModel";
import {
  MAIL_DISCOVERY_LIMITS,
  SyntheticSignupMailDiscoverySession,
  type SignupMailPhase,
} from "./signupMailDiscovery";
import { projectSignupMailReview, transitionSignupMailReview } from "./signupMailReview";

function scannedSession(clock = () => fixture.now, serviceIds = fixture.request.serviceIds) {
  const session = new SyntheticSignupMailDiscoverySession({ ...fixture.request, serviceIds }, clock);
  session.approve(session.view().preview, true);
  session.scan(structuredClone(fixture.metadata));
  return session;
}

const confirmAurora: DiscoveryInboxAction = { type: "set-confidence", id: "aurora-demo", confidence: "confirmed" };
const reviewActions: readonly DiscoveryInboxAction[] = [
  confirmAurora,
  { type: "filter", filter: "confirmed" },
  { type: "filter", filter: "dismissed" },
  { type: "reset" },
];

afterEach(() => vi.unstubAllGlobals());

describe("same-session signup mail review projection", () => {
  it("projects only the approved services with coarse evidence and no fallback fixtures", () => {
    const session = scannedSession(undefined, ["cedar-demo"]);
    const inbox = projectSignupMailReview(session.view());
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toEqual({
      id: "cedar-demo",
      serviceName: "Cedar 예제",
      accountHint: "계정 정보 없음 · 가입 여부와 계정 소유는 직접 확인 필요",
      confidence: "needs_review",
      sourceKind: "mail_hint",
      sourceLabel: "합성 메일의 가입 문구",
      observedOn: "2026-09-27",
      note: "가입 완료 문구",
    });
    expect(inbox.counts).toEqual({ open: 1, confirmed: 0, inferred: 0, needs_review: 1, dismissed: 0 });
    expect(Object.isFrozen(inbox)).toBe(true);
    expect(Object.isFrozen(inbox.items)).toBe(true);
    expect(Object.isFrozen(inbox.items[0])).toBe(true);
    const empty = projectSignupMailReview(scannedSession(undefined, ["harbor-demo"]).view());
    expect(empty.items).toEqual([]);
    expect(empty.visible).toEqual([]);
  });

  it("changes classifications on the original session and lets every supported filter inspect them", () => {
    const session = scannedSession();
    const originalExpiry = session.view().preview.expiresAt;
    const confirmed = transitionSignupMailReview(session, "open", confirmAurora);
    expect(confirmed.view.hints.find((hint) => hint.serviceId === "aurora-demo")?.confidence).toBe("confirmed");
    expect(session.view().hints.find((hint) => hint.serviceId === "aurora-demo")?.confidence).toBe("confirmed");
    expect(confirmed.inbox.counts).toEqual({ open: 2, confirmed: 1, inferred: 0, needs_review: 1, dismissed: 0 });
    const onlyConfirmed = transitionSignupMailReview(session, "open", { type: "filter", filter: "confirmed" });
    expect(onlyConfirmed.inbox.visible.map((item) => item.id)).toEqual(["aurora-demo"]);
    const onlyPending = transitionSignupMailReview(session, "confirmed", { type: "filter", filter: "needs_review" });
    expect(onlyPending.inbox.visible.map((item) => item.id)).toEqual(["cedar-demo"]);
    const dismissed = transitionSignupMailReview(session, "open", { ...confirmAurora, confidence: "dismissed" });
    expect(dismissed.inbox.visible.map((item) => item.id)).toEqual(["cedar-demo"]);
    const onlyDismissed = transitionSignupMailReview(session, "open", { type: "filter", filter: "dismissed" });
    expect(onlyDismissed.inbox.visible.map((item) => item.id)).toEqual(["aurora-demo"]);
    const reset = transitionSignupMailReview(session, "dismissed", { type: "reset" });
    expect(reset.inbox.filter).toBe("open");
    expect(reset.inbox.counts.dismissed).toBe(1);
    const reopened = transitionSignupMailReview(session, "open", { ...confirmAurora, confidence: "needs_review" });
    expect(reopened.inbox.counts.needs_review).toBe(2);
    expect(reopened.view.preview.expiresAt).toBe(originalExpiry);
  });

  it("does not invent inferred confidence or classify a service outside the scan", () => {
    const session = scannedSession(undefined, ["cedar-demo"]);
    const original = session.view().hints;
    const inferred = transitionSignupMailReview(session, "needs_review", { type: "set-confidence", id: "cedar-demo", confidence: "inferred" });
    expect(inferred.view.hints).toEqual(original);
    expect(inferred.inbox.filter).toBe("needs_review");
    const unknown = transitionSignupMailReview(session, "open", confirmAurora);
    expect(unknown.view.hints).toEqual(original);
    expect(projectSignupMailReview(session.view(), "inferred").filter).toBe("open");
    const unsupportedFilter = transitionSignupMailReview(session, "needs_review", { type: "filter", filter: "inferred" });
    expect(unsupportedFilter.inbox.filter).toBe("open");
    expect(unsupportedFilter.inbox.counts.inferred).toBe(0);
  });

  it("never puts raw subjects, sender domains, message data, or account identifiers in the inbox", () => {
    const session = scannedSession();
    const inbox = transitionSignupMailReview(session, "open", confirmAurora).inbox;
    const serialized = JSON.stringify(inbox);
    for (const forbidden of ["synthetic-only-private-canary", "Welcome to Aurora", "accounts.aurora.invalid", "subject", "senderDomain", "receivedAt", "messageId", "body", "@", "https://"]) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const item of inbox.items) expect(item.accountHint).toContain("직접 확인 필요");
    expect(inbox.items[0]?.note).toBe("가입 환영 문구 · 이메일 인증 문구");
  });
});

describe("consent lifetime and stale-candidate exclusion", () => {
  it.each(["awaiting_consent", "ready", "failed", "cancelled", "expired", "disposed"] satisfies SignupMailPhase[])("projects no retained hints for phase %s", (phase) => {
    const stale = scannedSession().view();
    const inbox = projectSignupMailReview({ ...stale, phase }, "dismissed");
    expect(inbox.items).toEqual([]);
    expect(inbox.visible).toEqual([]);
    expect(Object.values(inbox.counts)).toEqual([0, 0, 0, 0, 0]);
  });

  it("does not approve or scan a session through review actions", () => {
    const session = new SyntheticSignupMailDiscoverySession(fixture.request, () => fixture.now);
    for (const action of reviewActions) {
      const next = transitionSignupMailReview(session, "open", action);
      expect(next.view.phase).toBe("awaiting_consent");
      expect(next.inbox.items).toEqual([]);
    }
    session.approve(session.view().preview, true);
    const ready = transitionSignupMailReview(session, "open", confirmAurora);
    expect(ready.view.phase).toBe("ready");
    expect(ready.inbox.items).toEqual([]);
    expect(ready.view.inspectedHeaders).toBe(0);
  });

  it.each(reviewActions)("does not extend expiry with a last-millisecond action: %j", (action) => {
    let now = fixture.now;
    const session = scannedSession(() => now);
    const expiresAt = now + MAIL_DISCOVERY_LIMITS.sessionLifetimeMs;
    now = expiresAt - 1;
    const before = transitionSignupMailReview(session, "dismissed", action);
    expect(before.view.phase).toBe("review");
    expect(before.view.preview.expiresAt).toBe(expiresAt);
    now = expiresAt;
    const expired = transitionSignupMailReview(session, before.inbox.filter, { type: "reset" });
    expect(expired.view.phase).toBe("expired");
    expect(expired.inbox.filter).toBe("open");
    expect(expired.inbox.items).toEqual([]);
    expect(expired.view.inspectedHeaders).toBe(0);
    now = fixture.now;
    for (const staleAction of reviewActions) {
      const next = transitionSignupMailReview(session, "confirmed", staleAction);
      expect(next.view.phase).toBe("expired");
      expect(next.inbox.items).toEqual([]);
    }
  });

  it("clears an expiry race between inspecting the view and applying its action", () => {
    let atBoundary = false;
    let calls = 0;
    const session = scannedSession(() => {
      if (!atBoundary) return fixture.now;
      calls += 1;
      return fixture.now + MAIL_DISCOVERY_LIMITS.sessionLifetimeMs - (calls === 1 ? 1 : 0);
    });
    atBoundary = true;
    const result = transitionSignupMailReview(session, "open", confirmAurora);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.view.phase).toBe("expired");
    expect(result.inbox.items).toEqual([]);
  });

  it.each(["cancel", "dispose"] as const)("never resurrects a retained review snapshot after %s", (method) => {
    const session = scannedSession();
    const snapshot = projectSignupMailReview(session.view());
    expect(snapshot.items).toHaveLength(2);
    session[method]();
    for (const action of reviewActions) {
      const result = transitionSignupMailReview(session, snapshot.filter, action);
      expect(result.view.phase).toBe(method === "cancel" ? "cancelled" : "disposed");
      expect(result.inbox.items).toEqual([]);
      expect(result.view.inspectedHeaders).toBe(0);
    }
  });

  it("does not use network, persistent storage, or logging for projection and transitions", () => {
    const fetchMock = vi.fn();
    const indexedDb = { open: vi.fn(), deleteDatabase: vi.fn() };
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("indexedDB", indexedDb);
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const session = scannedSession();
      for (const action of reviewActions) transitionSignupMailReview(session, "open", action);
      session.dispose();
      projectSignupMailReview(session.view());
      expect(fetchMock).not.toHaveBeenCalled();
      for (const operation of [...Object.values(indexedDb), ...Object.values(storage), ...logs]) {
        expect(operation).not.toHaveBeenCalled();
      }
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });
});
