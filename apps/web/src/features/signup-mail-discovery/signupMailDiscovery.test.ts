import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../../../tests/fixtures/synthetic/signup-mail-discovery-v1.json";
import {
  MAIL_DISCOVERY_LIMITS,
  MailDiscoveryError,
  SyntheticSignupMailDiscoverySession,
} from "./signupMailDiscovery";

const cloned = <T,>(input: T): T => structuredClone(input);
const makeSession = (request: unknown = cloned(fixture.request), clock = () => fixture.now) => new SyntheticSignupMailDiscoverySession(request, clock);
const approvedSession = (request: unknown = cloned(fixture.request), clock = () => fixture.now) => {
  const session = makeSession(request, clock);
  session.approve(session.view().preview, true);
  return session;
};
const metadata = (headers: unknown[]) => ({ version: 1, syntheticOnly: true, headers });
const header = (overrides: Record<string, unknown> = {}) => ({ ...fixture.metadata.headers[0]!, ...overrides });

afterEach(() => vi.unstubAllGlobals());

describe("scan plan and explicit confirmation", () => {
  it("copies and freezes a bounded, metadata-only synthetic preview", () => {
    const request = cloned(fixture.request);
    const session = makeSession(request);
    request.serviceIds.length = 0;
    request.maxHeaders = 1;
    const view = session.view();
    expect(view.phase).toBe("awaiting_consent");
    expect(view.hints).toEqual([]);
    expect(view.preview.serviceIds).toEqual(fixture.request.serviceIds);
    expect(view.preview.maxHeaders).toBe(50);
    expect(view.preview.expiresAt).toBe(fixture.now + MAIL_DISCOVERY_LIMITS.sessionLifetimeMs);
    expect(Object.isFrozen(view.preview)).toBe(true);
    expect(Object.isFrozen(view.preview.serviceIds)).toBe(true);
  });

  it("does not inspect a batch before confirmation", () => {
    let reads = 0;
    const batch = Object.defineProperty({}, "headers", { get: () => { reads += 1; throw Error("synthetic-only-canary"); } });
    const session = makeSession();
    expect(() => session.scan(batch)).toThrowError(new MailDiscoveryError("CONSENT_REQUIRED"));
    expect(reads).toBe(0);
    expect(session.view().phase).toBe("awaiting_consent");
  });

  it("binds approval to the exact session preview and requires true", () => {
    const session = makeSession();
    expect(() => session.approve(makeSession().view().preview, true)).toThrowError(new MailDiscoveryError("STALE_PREVIEW"));
    expect(() => session.approve({ ...session.view().preview }, true)).toThrowError(new MailDiscoveryError("STALE_PREVIEW"));
    expect(() => session.approve(session.view().preview, false)).toThrowError(new MailDiscoveryError("CONSENT_REQUIRED"));
    expect(() => session.approve(session.view().preview, "yes" as unknown as boolean)).toThrowError(new MailDiscoveryError("CONSENT_REQUIRED"));
    session.approve(session.view().preview, true);
    expect(session.view().phase).toBe("ready");
    expect(() => session.approve(session.view().preview, true)).toThrowError(new MailDiscoveryError("INVALID_STATE"));
  });

  it.each([
    { serviceIds: [] }, { serviceIds: ["unknown"] }, { serviceIds: ["aurora-demo", "aurora-demo"] },
    { serviceIds: new Array(1) }, { serviceIds: "aurora-demo" },
    { maxHeaders: 0 }, { maxHeaders: 101 }, { maxHeaders: 1.5 }, { maxHeaders: "50" },
    { from: fixture.request.to }, { to: fixture.request.from }, { from: -1 }, { from: 1.5 },
    { to: fixture.now + 1 }, { to: Number.NaN }, { from: fixture.now - MAIL_DISCOVERY_LIMITS.maxRangeMs - 1 },
    { body: "synthetic-only-body" }, { token: "synthetic-only-token" },
  ])("rejects invalid bounds and extra input fields: %j", (overrides) => {
    expect(() => makeSession({ ...fixture.request, ...overrides })).toThrowError(new MailDiscoveryError("INVALID_REQUEST"));
  });

  it("rejects future versions and live providers without activating an adapter", () => {
    expect(() => makeSession({ ...fixture.request, version: 2 })).toThrowError(new MailDiscoveryError("UNSUPPORTED_VERSION"));
    expect(() => makeSession({ ...fixture.request, provider: "gmail", scopes: ["https://www.googleapis.com/auth/gmail.metadata"] })).toThrowError(new MailDiscoveryError("LIVE_PROVIDER_UNAVAILABLE"));
    expect(() => makeSession({ ...fixture.request, provider: "microsoft_graph", scopes: ["Mail.ReadBasic"] })).toThrowError(new MailDiscoveryError("LIVE_PROVIDER_UNAVAILABLE"));
  });

  it("rejects request accessors without invoking them", () => {
    let reads = 0;
    const request = { ...fixture.request };
    Object.defineProperty(request, "provider", { enumerable: true, get: () => { reads += 1; return "synthetic_fixture"; } });
    expect(() => makeSession(request)).toThrowError(new MailDiscoveryError("INVALID_REQUEST"));
    expect(reads).toBe(0);
  });

  it("sanitizes exceptional request input and initial clocks", () => {
    const request = new Proxy({}, { getPrototypeOf: () => { throw Error("synthetic-only-private-canary"); } });
    expect(() => makeSession(request)).toThrowError(new MailDiscoveryError("INVALID_REQUEST"));
    expect(() => makeSession(undefined, () => { throw Error("synthetic-only-private-canary"); })).toThrowError(new MailDiscoveryError("INVALID_REQUEST"));
  });
});

describe("bounded local signup-hint discovery", () => {
  it("aggregates allowlisted sender signals without treating mail as proof of signup", () => {
    const session = approvedSession();
    const view = session.scan(cloned(fixture.metadata));
    expect(view.phase).toBe("review");
    expect(view.inspectedHeaders).toBe(6);
    expect(view.hints.map((hint) => hint.serviceId)).toEqual(["aurora-demo", "cedar-demo"]);
    expect(view.hints[0]?.signals).toEqual(["welcome", "email_verification"]);
    expect(view.hints[1]?.signals).toEqual(["registration"]);
    for (const hint of view.hints) {
      expect(hint.confidence).toBe("needs_review");
      expect(hint.sourceKind).toBe("mail_hint");
      expect(hint.observedOn).toMatch(/^2026-09-\d\d$/u);
      expect(Object.isFrozen(hint)).toBe(true);
    }
  });

  it("restricts services and date range; excludes the upper timestamp boundary", () => {
    const session = approvedSession({ ...fixture.request, serviceIds: ["cedar-demo"] });
    const view = session.scan(metadata([
      header(),
      header({ senderDomain: "accounts.cedar.invalid", receivedAt: fixture.request.from - 1 }),
      header({ senderDomain: "accounts.cedar.invalid", receivedAt: fixture.request.to }),
      header({ senderDomain: "accounts.cedar.invalid", receivedAt: fixture.request.from }),
    ]));
    expect(view.hints).toHaveLength(1);
    expect(view.hints[0]?.serviceId).toBe("cedar-demo");
    expect(view.hints[0]?.observedOn).toBe(new Date(fixture.request.from).toISOString().slice(0, 10));
  });

  it.each([
    "Password reset requested", "Monthly receipt", "Welcome offer ends soon", "Your account security alert", "Reverify your mailbox settings",
  ])("ignores unrelated subjects: %s", (subject) => {
    expect(approvedSession().scan(metadata([header({ subject })])).hints).toEqual([]);
  });

  it.each([
    "Registration complete", "Account created", "Thanks for signing up", "회원가입이 완료되었습니다",
    "Verify your email", "Confirm your email address", "이메일 주소를 인증해주세요", "가입을 환영합니다",
  ])("supports English and Korean signup signals: %s", (subject) => {
    expect(approvedSession().scan(metadata([header({ subject })])).hints).toHaveLength(1);
  });

  it("uses exact sender-domain matching and rejects lookalikes as evidence", () => {
    const view = approvedSession().scan(metadata([
      header({ senderDomain: "accounts.aurora.invalid.other.invalid" }),
      header({ senderDomain: "other.accounts.aurora.invalid" }),
      header({ senderDomain: "accounts-aurora.invalid" }),
      header({ senderDomain: "newsletter.aurora.invalid" }),
    ]));
    expect(view.hints).toEqual([]);
  });

  it("accepts an empty mailbox and deduplicates repeated evidence", () => {
    expect(approvedSession().scan(metadata([])).hints).toEqual([]);
    const session = approvedSession();
    const view = session.scan(metadata(Array.from({ length: 50 }, () => header())));
    expect(view.hints).toHaveLength(1);
    expect(view.hints[0]?.signals).toEqual(["welcome"]);
    expect(view.inspectedHeaders).toBe(50);
    expect(() => session.scan(metadata([]))).toThrowError(new MailDiscoveryError("INVALID_STATE"));
  });

  it("rejects a batch over its approved metadata budget before accessing rows", () => {
    let reads = 0;
    const headers = Array.from({ length: 51 }, () => header());
    Object.defineProperty(headers, "0", { enumerable: true, get: () => { reads += 1; return header(); } });
    const session = approvedSession();
    expect(() => session.scan(metadata(headers))).toThrowError(new MailDiscoveryError("SCAN_LIMIT_EXCEEDED"));
    expect(reads).toBe(0);
    expect(session.view().hints).toEqual([]);
  });
});

describe("privacy and all-or-nothing input handling", () => {
  it.each(["body", "bodyPreview", "snippet", "html", "attachments", "messageId", "to", "from", "token", "url"])("rejects the unapproved %s field", (field) => {
    const session = approvedSession();
    expect(() => session.scan(metadata([header(), header({ [field]: "synthetic-only-private-canary" })]))).toThrowError(new MailDiscoveryError("INVALID_METADATA"));
    expect(session.view().hints).toEqual([]);
    expect(session.view().inspectedHeaders).toBe(0);
    expect(session.view().phase).toBe("failed");
  });

  it.each([
    { subject: "x".repeat(513) }, { subject: "한".repeat(171) }, { subject: "Welcome to Aurora\n" },
    { subject: 1 }, { receivedAt: "2026-09-30" }, { receivedAt: Number.POSITIVE_INFINITY },
    { senderDomain: "accounts.example.com" }, { senderDomain: "synthetic-user@accounts.aurora.invalid" },
    { senderDomain: "Accounts.Aurora.Invalid" },
  ])("rejects malformed metadata without returning earlier matches: %j", (overrides) => {
    const session = approvedSession();
    expect(() => session.scan(metadata([header(), header(overrides)]))).toThrowError(new MailDiscoveryError("INVALID_METADATA"));
    expect(session.view().hints).toEqual([]);
  });

  it("accepts exactly 512 UTF-8 bytes, rather than using only character length", () => {
    const subject = "Welcome to Aurora " + "한".repeat(164) + "xx";
    expect(new TextEncoder().encode(subject).byteLength).toBe(512);
    expect(approvedSession().scan(metadata([header({ subject })])).hints).toHaveLength(1);
  });

  it("rejects metadata getters, prototype fields and future versions", () => {
    let reads = 0;
    const row = header();
    Object.defineProperty(row, "subject", { enumerable: true, get: () => { reads += 1; return "Welcome to Aurora"; } });
    expect(() => approvedSession().scan(metadata([row]))).toThrowError(new MailDiscoveryError("INVALID_METADATA"));
    expect(reads).toBe(0);
    expect(() => approvedSession().scan(metadata([Object.create(header())]))).toThrowError(new MailDiscoveryError("INVALID_METADATA"));
    expect(() => approvedSession().scan({ ...fixture.metadata, version: 2 })).toThrowError(new MailDiscoveryError("UNSUPPORTED_VERSION"));
    expect(() => approvedSession().scan({ ...fixture.metadata, syntheticOnly: false })).toThrowError(new MailDiscoveryError("INVALID_METADATA"));
    expect(() => approvedSession().scan({ ...fixture.metadata, body: "synthetic-only-body" })).toThrowError(new MailDiscoveryError("INVALID_METADATA"));
  });

  it("never projects subject, sender, source messages, or private canaries into results", () => {
    const view = approvedSession().scan(cloned(fixture.metadata));
    const result = JSON.stringify(view.hints);
    for (const forbidden of ["synthetic-only-private-canary", "Welcome to Aurora", "accounts.aurora.invalid", "subject", "senderDomain", "receivedAt", "body", "messageId", "@", "https://"]) {
      expect(result).not.toContain(forbidden);
    }
  });

  it("performs no network, storage, or console operation during scan and review", () => {
    const network = vi.fn();
    const storage = { open: vi.fn(), deleteDatabase: vi.fn() };
    vi.stubGlobal("fetch", network);
    vi.stubGlobal("indexedDB", storage);
    vi.stubGlobal("localStorage", { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() });
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const session = approvedSession();
      session.scan(cloned(fixture.metadata));
      session.setConfidence("aurora-demo", "dismissed");
      session.dispose();
      expect(network).not.toHaveBeenCalled();
      expect(storage.open).not.toHaveBeenCalled();
      expect(storage.deleteDatabase).not.toHaveBeenCalled();
      expect(localStorage.getItem).not.toHaveBeenCalled();
      expect(localStorage.setItem).not.toHaveBeenCalled();
      expect(localStorage.removeItem).not.toHaveBeenCalled();
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });

  it("sanitizes unexpected input exceptions", () => {
    const input = new Proxy({}, { getPrototypeOf: () => { throw Error("synthetic-only-private-canary"); } });
    expect(() => approvedSession().scan(input)).toThrowError(new MailDiscoveryError("INVALID_METADATA"));
  });
});

describe("review, expiry and disposal", () => {
  it("allows manual confirmation, dismissal, and correction of false positives", () => {
    const session = approvedSession();
    session.scan(cloned(fixture.metadata));
    expect(session.setConfidence("aurora-demo", "confirmed").hints[0]?.confidence).toBe("confirmed");
    expect(session.setConfidence("aurora-demo", "dismissed").hints[0]?.confidence).toBe("dismissed");
    expect(session.setConfidence("aurora-demo", "needs_review").hints[0]?.confidence).toBe("needs_review");
    expect(() => session.setConfidence("unknown", "confirmed")).toThrowError(new MailDiscoveryError("INVALID_REQUEST"));
    expect(() => session.setConfidence("aurora-demo", "future-state" as "confirmed")).toThrowError(new MailDiscoveryError("INVALID_REQUEST"));
  });

  it.each(["cancel", "dispose"] as const)("%s clears results and permanently closes the scan", (method) => {
    const session = approvedSession();
    session.scan(cloned(fixture.metadata));
    session[method]();
    session[method]();
    expect(session.view().hints).toEqual([]);
    expect(session.view().inspectedHeaders).toBe(0);
    expect(() => session.scan(cloned(fixture.metadata))).toThrowError(new MailDiscoveryError("SESSION_CLOSED"));
    expect(() => session.setConfidence("aurora-demo", "confirmed")).toThrowError(new MailDiscoveryError("SESSION_CLOSED"));
  });

  it("expires at the boundary, clears reviewed hints, and cannot extend consent", () => {
    let now = fixture.now;
    const session = approvedSession(undefined, () => now);
    session.scan(cloned(fixture.metadata));
    now += MAIL_DISCOVERY_LIMITS.sessionLifetimeMs - 1;
    expect(session.view().hints).toHaveLength(2);
    now += 1;
    expect(session.view().phase).toBe("expired");
    expect(session.view().hints).toEqual([]);
    expect(() => session.approve(session.view().preview, true)).toThrowError(new MailDiscoveryError("SESSION_EXPIRED"));
    now = fixture.now;
    expect(session.view().phase).toBe("expired");
  });

  it.each(["rollback", "invalid", "throw"] as const)("clears results if the clock becomes %s", (failure) => {
    let changed = false;
    const clock = () => {
      if (!changed) return fixture.now;
      if (failure === "throw") throw Error("synthetic-only-clock-error");
      return failure === "rollback" ? fixture.now - 1 : Number.NaN;
    };
    const session = approvedSession(undefined, clock);
    session.scan(cloned(fixture.metadata));
    changed = true;
    expect(session.view().phase).toBe("expired");
    expect(session.view().hints).toEqual([]);
  });

  it("does not publish results if consent expires during processing", () => {
    let calls = 0;
    const clock = () => (++calls < 5 ? fixture.now : fixture.now + MAIL_DISCOVERY_LIMITS.sessionLifetimeMs);
    const session = approvedSession(undefined, clock);
    expect(() => session.scan(cloned(fixture.metadata))).toThrowError(new MailDiscoveryError("SESSION_EXPIRED"));
    expect(session.view().hints).toEqual([]);
    expect(session.view().phase).toBe("expired");
  });
});
