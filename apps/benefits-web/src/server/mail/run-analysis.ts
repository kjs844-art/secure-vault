import { type EmailCandidate, type PreparedMail } from "./contracts";
import { normalizeGmailMessagesJson } from "./normalize-gmail";
import { validateGmailCandidatesJson } from "./validate-candidates";

export const MAIL_ANALYSIS_POLICY = Object.freeze({
  version: "keyatlas.gmail-review.v1",
  provider: "gmail",
  query: "newer_than:2y {subject:welcome subject:trial subject:coupon subject:credit subject:receipt subject:subscription}",
  maxMessages: 30,
  format: "full",
} as const);

export interface RunAuthority {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly sessionExpiresAt: number;
  readonly mailboxBindingId: string;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly grantExpiresAt: number;
  readonly operationId: string;
  readonly recipientId: string;
  readonly policyVersion: typeof MAIL_ANALYSIS_POLICY.version;
  readonly mailRead: true;
  readonly externalAnalysis: true;
}

export interface RunContext {
  readonly authority: RunAuthority;
  readonly scope: typeof MAIL_ANALYSIS_POLICY;
}

/** Implementations are trusted server dependencies, never request-body functions/data. */
export interface MailAnalysisAdapters {
  // Resolve verified auth + owned mailbox + two independently chosen consent capabilities.
  // A combined grant snapshot must change revision on either capability change/revocation,
  // and use the earlier expiry. OAuth connection alone never implies AI-analysis consent.
  // grantOwnerId/grantSessionId/grantMailboxBindingId are checked against the principal.
  readAuthority(signal: AbortSignal): Promise<unknown>;
  // Atomically enforce owner/session/mailbox/recipient/policy/grant/expiry and numeric caps.
  // One-use key is (ownerId, operationId), NOT grant revision/session; a replay is denied.
  // This runner never automatically retries or refunds an uncertain consumption.
  reserveQuota(context: RunContext, signal: AbortSignal): Promise<unknown>;
  // Credential lookup must use context.authority and recheck that grant/session at dispatch.
  readMailbox(context: RunContext, signal: AbortSignal): Promise<unknown>;
  // Private dispatch context for reauthorization, NEVER serialize it to the model.
  // A closed/tool-free provider adapter projects only bounded messages into its payload.
  analyze(messages: readonly PreparedMail[], context: RunContext, signal: AbortSignal): Promise<unknown>;
  now?(): number;
}

export interface MailRunOptions {
  // Chosen by a trusted server route, bound to an explicit single-run grant.
  readonly operationId: string;
  readonly mailboxBindingId: string;
  readonly recipientId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

type ErrorCode =
  | "RUN_CONFIG_INVALID" | "RUN_CANCELLED" | "RUN_TIMED_OUT"
  | "AUTH_REQUIRED" | "CONSENT_REQUIRED" | "AUTHORITY_CHANGED" | "AUTHORITY_UNAVAILABLE"
  | "QUOTA_DENIED" | "QUOTA_UNAVAILABLE" | "MAIL_UNAVAILABLE" | "ANALYSIS_UNAVAILABLE"
  | "MAIL_INPUT_INVALID" | "MAIL_LIMIT_EXCEEDED" | "CANDIDATE_INPUT_INVALID"
  | "CANDIDATE_LIMIT_EXCEEDED" | "CANDIDATE_EVIDENCE_INVALID";

export interface AnalysisReceipt {
  readonly schema: "keyatlas.mail-analysis-receipt.v1";
  readonly policyVersion: string;
  readonly authorityAtStart: Readonly<{
    operationId: string; mailboxBindingId: string; recipientId: string;
    grantId: string; grantRevision: number; authorizedAt: string;
  }> | null;
  readonly quota: "not-consumed" | "unknown" | "consumed";
  readonly mailbox: "not-started" | "started" | "returned";
  readonly analysis: "not-started" | "started" | "returned";
  readonly undoAvailable: false;
}

export type MailRunResult =
  | { readonly ok: true; readonly candidates: readonly EmailCandidate[];
    readonly extractedAt: string; readonly receipt: AnalysisReceipt }
  | { readonly ok: false; readonly code: ErrorCode; readonly receipt: AnalysisReceipt };

class RunFailure extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}
function fail(code: ErrorCode): never { throw new RunFailure(code); }
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999;
}
function authority(value: unknown, options: MailRunOptions, now: number): RunAuthority {
  if (value === null) return fail("AUTH_REQUIRED");
  const raw = record(value);
  if (!raw || !identifier(raw.ownerId) || !identifier(raw.sessionId)
    || !timestamp(raw.sessionExpiresAt) || raw.sessionExpiresAt <= now) return fail("AUTH_REQUIRED");
  if (!identifier(raw.grantId) || !Number.isSafeInteger(raw.grantRevision) || (raw.grantRevision as number) < 1
    || raw.grantOwnerId !== raw.ownerId || raw.grantSessionId !== raw.sessionId
    || raw.mailboxBindingId !== options.mailboxBindingId || raw.grantMailboxBindingId !== options.mailboxBindingId
    || !timestamp(raw.grantExpiresAt) || raw.grantExpiresAt <= now
    || raw.operationId !== options.operationId || raw.recipientId !== options.recipientId
    || raw.policyVersion !== MAIL_ANALYSIS_POLICY.version || raw.mailRead !== true || raw.externalAnalysis !== true) {
    return fail("CONSENT_REQUIRED");
  }
  // Explicit projection: no tokens, extra adapter data or mutable objects cross stages.
  return Object.freeze({
    ownerId: raw.ownerId, sessionId: raw.sessionId, sessionExpiresAt: raw.sessionExpiresAt,
    mailboxBindingId: options.mailboxBindingId,
    grantId: raw.grantId, grantRevision: raw.grantRevision as number, grantExpiresAt: raw.grantExpiresAt,
    operationId: options.operationId, recipientId: options.recipientId,
    policyVersion: MAIL_ANALYSIS_POLICY.version, mailRead: true, externalAnalysis: true,
  });
}

/**
 * Internal orchestration only, not an auth implementation or a route. No storage.
 * Adapters must enforce owner/grant/scope and streaming response limits themselves.
 * Revocation stops future stages and drops late results; it cannot recall data
 * already transmitted or force a provider that ignores AbortSignal to cancel.
 */
export async function runMailAnalysis(adapters: MailAnalysisAdapters, options: MailRunOptions): Promise<MailRunResult> {
  const state: { quota: AnalysisReceipt["quota"]; mailbox: AnalysisReceipt["mailbox"]; analysis: AnalysisReceipt["analysis"] } = {
    quota: "not-consumed", mailbox: "not-started", analysis: "not-started",
  };
  let authorityAtStart: AnalysisReceipt["authorityAtStart"] = null;
  const receipt = (): AnalysisReceipt => Object.freeze({
    schema: "keyatlas.mail-analysis-receipt.v1", policyVersion: MAIL_ANALYSIS_POLICY.version,
    authorityAtStart, ...state, undoAvailable: false,
  });
  const controller = new AbortController();
  let timedOut = false;
  let authorityExpired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline = Infinity;
  let authorityDeadline = Infinity;
  let lastTime = -1;
  let parentSignal: AbortSignal | undefined;
  const cancelled = () => controller.abort(); // Never forward caller-supplied abort reasons.
  const stopCode = (): ErrorCode => timedOut ? "RUN_TIMED_OUT" : authorityExpired ? "AUTHORITY_CHANGED" : "RUN_CANCELLED";
  const check = () => {
    if (!controller.signal.aborted && performance.now() >= Math.min(deadline, authorityDeadline)) {
      timedOut = deadline <= authorityDeadline;
      authorityExpired = !timedOut;
      controller.abort();
    }
    if (controller.signal.aborted) fail(stopCode());
  };
  const now = () => {
    const value = adapters.now ? adapters.now() : Date.now();
    if (!timestamp(value) || value < lastTime) return fail("AUTHORITY_UNAVAILABLE");
    lastTime = value;
    return value;
  };
  async function stage<T>(run: () => Promise<T>, failure: ErrorCode): Promise<T> {
    check();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new RunFailure(stopCode()));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => { check(); return run(); }).then(
        (value) => { controller.signal.removeEventListener("abort", onAbort); resolve(value); },
        (error: unknown) => {
          controller.signal.removeEventListener("abort", onAbort);
          // Only this module's fixed failures survive; provider error bodies never do.
          reject(error instanceof RunFailure ? error : new RunFailure(failure));
        },
      );
    });
  }
  try {
    // Snapshot trusted configuration once, rather than rereading a mutable options object.
    if (!options || typeof options !== "object") return fail("RUN_CONFIG_INVALID");
    options = Object.freeze({
      operationId: options.operationId, mailboxBindingId: options.mailboxBindingId, recipientId: options.recipientId,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) return fail("RUN_CONFIG_INVALID");
    parentSignal = options.signal;
    const timeoutMs = options.timeoutMs ?? 30000;
    if (!identifier(options.operationId) || !identifier(options.recipientId) || !identifier(options.mailboxBindingId)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return fail("RUN_CONFIG_INVALID");
    if (parentSignal?.aborted) cancelled();
    else parentSignal?.addEventListener("abort", cancelled, { once: true });
    check();
    deadline = performance.now() + timeoutMs;
    timer = setTimeout(() => {
      if (!controller.signal.aborted) { timedOut = true; controller.abort(); }
    }, timeoutMs);
    const rawAuthority = await stage(() => adapters.readAuthority(controller.signal), "AUTHORITY_UNAVAILABLE");
    check();
    const initial = authority(rawAuthority, options, now());
    authorityAtStart = Object.freeze({
      operationId: initial.operationId, mailboxBindingId: initial.mailboxBindingId, recipientId: initial.recipientId,
      grantId: initial.grantId, grantRevision: initial.grantRevision, authorizedAt: new Date(lastTime).toISOString(),
    });
    const context: RunContext = Object.freeze({ authority: initial, scope: MAIL_ANALYSIS_POLICY });
    const expiresIn = Math.min(initial.sessionExpiresAt, initial.grantExpiresAt) - now();
    if (expiresIn <= 0) return fail("AUTHORITY_CHANGED");
    authorityDeadline = performance.now() + expiresIn;
    if (expiresIn <= timeoutMs) expiryTimer = setTimeout(() => {
      if (!controller.signal.aborted) { authorityExpired = true; controller.abort(); }
    }, expiresIn);
    async function guard(): Promise<void> {
      const raw = await stage(() => adapters.readAuthority(controller.signal), "AUTHORITY_UNAVAILABLE");
      check();
      let current: RunAuthority;
      try { current = authority(raw, options, now()); }
      catch { return fail("AUTHORITY_CHANGED"); }
      if (JSON.stringify(current) !== JSON.stringify(initial)) return fail("AUTHORITY_CHANGED");
    }
    // The atomic quota adapter also binds this permit to the verified owner/session/grant.
    const rawPermit = await stage(() => {
      state.quota = "unknown";
      return adapters.reserveQuota(context, controller.signal);
    }, "QUOTA_UNAVAILABLE");
    check();
    const permit = record(rawPermit);
    if (permit?.status === "denied" && Object.keys(permit).length === 1) {
      state.quota = "not-consumed";
      return fail("QUOTA_DENIED");
    }
    const permitFields = ["status", "ownerId", "sessionId", "mailboxBindingId", "recipientId", "policyVersion",
      "grantId", "grantRevision", "operationId", "remaining"];
    if (!permit || Object.keys(permit).length !== permitFields.length || Object.keys(permit).some((key) => !permitFields.includes(key))
      || permit.status !== "granted" || permit.ownerId !== initial.ownerId || permit.sessionId !== initial.sessionId
      || permit.mailboxBindingId !== initial.mailboxBindingId
      || permit.recipientId !== initial.recipientId || permit.policyVersion !== initial.policyVersion
      || permit.grantId !== initial.grantId || permit.grantRevision !== initial.grantRevision
      || permit.operationId !== initial.operationId || !Number.isSafeInteger(permit.remaining)
      || (permit.remaining as number) < 0) return fail("QUOTA_UNAVAILABLE");
    state.quota = "consumed";
    await guard();
    const rawMail = await stage(() => {
      state.mailbox = "started";
      return adapters.readMailbox(context, controller.signal);
    }, "MAIL_UNAVAILABLE");
    state.mailbox = "returned";
    await guard();
    if (typeof rawMail !== "string") return fail("MAIL_INPUT_INVALID");
    const normalized = normalizeGmailMessagesJson(rawMail);
    check();
    if (!normalized.ok) return fail(normalized.code);
    let candidates: readonly EmailCandidate[] = Object.freeze([]);
    if (normalized.messages.length > 0) {
      // Revalidate immediately before dispatch too; parsing never authorizes transmission.
      await guard();
      const rawAnalysis = await stage(() => {
        state.analysis = "started";
        return adapters.analyze(normalized.messages, context, controller.signal);
      }, "ANALYSIS_UNAVAILABLE");
      state.analysis = "returned";
      await guard();
      if (typeof rawAnalysis !== "string") return fail("CANDIDATE_INPUT_INVALID");
      const validated = validateGmailCandidatesJson(rawAnalysis, normalized.messages);
      check();
      if (!validated.ok) return fail(validated.code);
      candidates = validated.candidates;
    }
    await guard();
    check();
    const extractedAt = new Date(now()).toISOString();
    check();
    if (initial.grantExpiresAt <= lastTime || initial.sessionExpiresAt <= lastTime) return fail("AUTHORITY_CHANGED");
    return Object.freeze({ ok: true, candidates, extractedAt, receipt: receipt() });
  } catch (error) {
    return Object.freeze({ ok: false, code: error instanceof RunFailure ? error.code : "AUTHORITY_UNAVAILABLE", receipt: receipt() });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    parentSignal?.removeEventListener("abort", cancelled);
  }
}
