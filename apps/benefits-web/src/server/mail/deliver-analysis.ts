/** Internal delivery composition only. Trusted ports/operation options are not
 * browser input. No route, provider, authentication or persistence is activated. */
import { createCandidateBatchReferences } from "../inbox/batch-references";
import type { CandidateBatchReferenceDependencies } from "../inbox/batch-reference-contracts";
import { parseStagingGrant } from "../inbox/validation";
import { HttpBoundaryFailure, RequestLifetime } from "../http/request-lifetime";
import type { ReviewErrorCode } from "../review/contracts";
import { objectFields, parseAuthority, parseId, ReviewFailure } from "../review/validation";
import { getVerifiedAnalysisHandoff, runMailAnalysis, type AnalysisReceipt,
  type MailAnalysisAdapters, type MailRunOptions, type MailRunResult } from "./run-analysis";

export interface MailAnalysisDeliveryDependencies {
  readonly analysis: MailAnalysisAdapters;
  readonly references: CandidateBatchReferenceDependencies;
}
export interface SafeDeliveryObservations {
  readonly quota: AnalysisReceipt["quota"];
  readonly mailbox: AnalysisReceipt["mailbox"];
  readonly analysis: AnalysisReceipt["analysis"];
  /** started means acknowledgement is uncertain, NOT that storage rolled back. */
  readonly storage: "not-started" | "started" | "acknowledged";
  readonly undoAvailable: false;
}
export interface CandidateBatchSavedReceipt {
  readonly schema: "keyatlas.candidate-batch-saved.v1";
  readonly state: "saved";
  readonly batchReference: string;
  readonly dataGeneration: number;
}
type RunError = Extract<MailRunResult, { ok: false }>["code"];
export type MailAnalysisDeliveryError = RunError | ReviewErrorCode;
export type MailAnalysisDeliveryResult =
  | { readonly ok: true; readonly value: CandidateBatchSavedReceipt; readonly receipt: SafeDeliveryObservations }
  | { readonly ok: false; readonly code: MailAnalysisDeliveryError; readonly receipt: SafeDeliveryObservations };

const RUN_PORTS = ["readAuthority", "reserveQuota", "readMailbox", "analyze"] as const;
const REFERENCE_PORTS = ["readAuthority", "isAnalysisAuthorized", "readStagingGrant", "transaction",
  "newId", "now", "newReference", "readReference"] as const;
const AUTHORITY_KEYS = ["ownerId", "sessionId", "sessionRevision", "dataGeneration", "sessionExpiresAt",
  "mailboxBindingId", "grantId", "grantRevision", "grantExpiresAt", "operationId", "recipientId",
  "policyVersion", "mailRead", "externalAnalysis", "grantOwnerId", "grantSessionId", "grantMailboxBindingId"] as const;
const APP_AUTHORITY_KEYS = ["ownerId", "sessionId", "sessionRevision", "dataGeneration", "expiresAt"] as const;
const FIXED_ERRORS: readonly MailAnalysisDeliveryError[] = ["RUN_CONFIG_INVALID", "RUN_CANCELLED", "RUN_TIMED_OUT",
  "AUTH_REQUIRED", "CONSENT_REQUIRED", "AUTHORITY_CHANGED", "AUTHORITY_UNAVAILABLE", "QUOTA_DENIED", "QUOTA_UNAVAILABLE",
  "MAIL_UNAVAILABLE", "ANALYSIS_UNAVAILABLE", "MAIL_INPUT_INVALID", "MAIL_LIMIT_EXCEEDED", "CANDIDATE_INPUT_INVALID",
  "CANDIDATE_LIMIT_EXCEEDED", "CANDIDATE_EVIDENCE_INVALID", "REVIEW_INPUT_INVALID", "REVIEW_AUTH_REQUIRED",
  "REVIEW_AUTHORITY_CHANGED", "REVIEW_NOT_FOUND", "REVIEW_CONFLICT", "REVIEW_PREVIEW_EXPIRED", "REVIEW_PREVIEW_UNAVAILABLE",
  "REVIEW_OPERATION_CONFLICT", "REVIEW_STORE_UNAVAILABLE"];
const safeCode = (code: unknown): MailAnalysisDeliveryError => typeof code === "string"
  && FIXED_ERRORS.includes(code as MailAnalysisDeliveryError) ? code as MailAnalysisDeliveryError : "AUTHORITY_UNAVAILABLE";

/** Own-data configuration snapshots reject ordinary accessors before dispatch.
 * Reflection is not a sandbox for a malicious privileged Proxy. */
function fields(input: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
  const prototype = Object.getPrototypeOf(input), descriptors = Object.getOwnPropertyDescriptors(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
  const keys = Reflect.ownKeys(descriptors), allowed = [...required, ...optional];
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(descriptors, key))) throw new Error();
  const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key as string]!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
    value[key as string] = descriptor.value as unknown;
  }
  return Object.freeze(value);
}
function fixed(error: unknown): MailAnalysisDeliveryError {
  try {
    // Error classes are not a runtime allowlist. Faulty ports may throw a forged
    // code/accessor; never reflect its value or execute that getter in reporting.
    const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
    if (!code || !Object.hasOwn(code, "value")) return "AUTHORITY_UNAVAILABLE";
    if (error instanceof ReviewFailure) return safeCode(code.value);
    if (error instanceof HttpBoundaryFailure) {
      if (code.value === "API_ABORTED") return "RUN_CANCELLED";
      if (code.value === "API_TIMEOUT") return "RUN_TIMED_OUT";
      if (code.value === "API_SESSION_CHANGED") return "REVIEW_AUTHORITY_CHANGED";
    }
  } catch { /* Proxy reflection exceptions are contained, not echoed. */ }
  return "AUTHORITY_UNAVAILABLE";
}

/** Executes ONCE. Never reruns analysis, refunds quota, retries a transaction or
 * invents a new operation. For uncertain storage, callers may explicitly use
 * references.ensure with their server-retained operation under current auth.
 * The original successful analysis object never leaves this invocation. */
export async function deliverMailAnalysis(input: MailAnalysisDeliveryDependencies,
  requested: MailRunOptions): Promise<MailAnalysisDeliveryResult> {
  let observed: Pick<AnalysisReceipt, "quota" | "mailbox" | "analysis"> = {
    quota: "not-consumed", mailbox: "not-started", analysis: "not-started",
  };
  let storage: SafeDeliveryObservations["storage"] = "not-started";
  const receipt = (): SafeDeliveryObservations => Object.freeze({ quota: observed.quota,
    mailbox: observed.mailbox, analysis: observed.analysis, storage, undoAvailable: false });
  const failed = (code: unknown): MailAnalysisDeliveryResult => Object.freeze({ ok: false, code: safeCode(code), receipt: receipt() });
  let lifetime: RequestLifetime | undefined;
  let detachInput: (() => void) | undefined;
  let configured = false;
  try {
    const config = fields(input, ["analysis", "references"]);
    const analysis = fields(config.analysis, RUN_PORTS, ["now"]);
    const references = fields(config.references, REFERENCE_PORTS);
    if (RUN_PORTS.some((key) => typeof analysis[key] !== "function")
      || (Object.hasOwn(analysis, "now") && typeof analysis.now !== "function")
      || REFERENCE_PORTS.some((key) => typeof references[key] !== "function")) throw new Error();
    const raw = fields(requested, ["operationId", "mailboxBindingId", "recipientId"], ["timeoutMs", "signal"]);
    const timeoutMs = Object.hasOwn(raw, "timeoutMs") ? raw.timeoutMs : 30000;
    if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error();
    const signal = Object.hasOwn(raw, "signal") ? raw.signal : new AbortController().signal;
    const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
    aborted.call(signal); // native brand check, no caller-supplied getter
    // RequestLifetime uses native signal methods through the supplied instance.
    // Reject shadows/subclasses before it creates timers or cleanup callbacks;
    // a custom removeEventListener must not run after the final authority check.
    if (Object.getPrototypeOf(signal) !== AbortSignal.prototype
      || ["aborted", "addEventListener", "removeEventListener"].some((key) => Object.hasOwn(signal as object, key))) throw new Error();
    const options = Object.freeze({ operationId: parseId(raw.operationId), mailboxBindingId: parseId(raw.mailboxBindingId),
      recipientId: parseId(raw.recipientId), timeoutMs, signal: signal as AbortSignal });
    const runPorts = analysis as unknown as MailAnalysisAdapters;
    const refPorts = references as unknown as CandidateBatchReferenceDependencies;
    configured = true;
    if (aborted.call(signal) === true) return failed("RUN_CANCELLED");
    // The external signal remains caller-owned and could be changed after the
    // initial validation. Only a private pristine signal reaches the lifetime;
    // attach/detach through native methods, never late instance property reads.
    const bridge = new AbortController(), forwardAbort = () => bridge.abort();
    EventTarget.prototype.addEventListener.call(options.signal, "abort", forwardAbort, { once: true });
    detachInput = () => { EventTarget.prototype.removeEventListener.call(options.signal, "abort", forwardAbort); };
    if (aborted.call(signal) === true) forwardAbort();
    // One authoritative clock for BOTH stages, never a new storage-time budget.
    // analysis.now is validated for compatibility but is deliberately not used.
    lifetime = new RequestLifetime(() => {
      const now = refPorts.now();
      if (!Number.isSafeInteger(now) || Object.is(now, -0)) throw new Error();
      return now;
    }, bridge.signal, timeoutMs);
    const life = lifetime;
    const analysisResult = await runMailAnalysis({
      readAuthority: (signal) => life.run(async () => {
        const value = await runPorts.readAuthority(signal);
        return value === null ? null : Object.freeze(objectFields(value, AUTHORITY_KEYS, false));
      }),
      reserveQuota: (context, signal) => life.run(() => runPorts.reserveQuota(context, signal)),
      readMailbox: (context, signal) => life.run(() => runPorts.readMailbox(context, signal)),
      analyze: (messages, context, signal) => life.run(() => runPorts.analyze(messages, context, signal)),
      now: () => life.now(),
    }, { ...options, signal: life.signal });
    observed = analysisResult.receipt;
    life.now();
    if (!analysisResult.ok) return failed(analysisResult.code);
    const handoff = getVerifiedAnalysisHandoff(analysisResult);
    if (handoff === null) return failed("REVIEW_INPUT_INVALID");
    const source = handoff.authority;
    life.tighten(Math.min(source.sessionExpiresAt, source.grantExpiresAt), "API_SESSION_CHANGED");
    const guardedId = (port: () => string) => {
      life.now(); const value = port(); life.now(); return value;
    };
    const referencesForRequest = createCandidateBatchReferences({
      readAuthority: () => life.run(() => refPorts.readAuthority()),
      isAnalysisAuthorized: (expected) => life.run(() => refPorts.isAnalysisAuthorized(expected)),
      readStagingGrant: (expected) => life.run(async () => {
        const grant = await refPorts.readStagingGrant(expected);
        const parsed = parseStagingGrant(grant, source, handoff.result.extractedAt, life.now());
        life.tighten(Math.min(parsed.expiresAt, parsed.pendingAccessUntil), "API_SESSION_CHANGED");
        return grant;
      }),
      transaction: (authority, action) => life.run(() => refPorts.transaction(authority, async (tx) => {
        life.now(); tx.limitCommitTime(life.notAfter);
        const value = await action(tx);
        life.now(); return value;
      })),
      newId: () => guardedId(() => refPorts.newId()), newReference: () => guardedId(() => refPorts.newReference()),
      now: () => life.now(), readReference: (reference, signal) => life.run(() => refPorts.readReference(reference, signal)),
    });
    life.now(); storage = "started";
    const staged = await life.run(() => referencesForRequest.stage(analysisResult));
    if (!staged.ok) return failed(staged.code);
    storage = "acknowledged";
    // Stage already guards its original grants/commit. Recheck current app
    // ownership after that await before exposing even the public lookup alias.
    const finalAuthority = await life.run(() => refPorts.readAuthority());
    let current;
    try { current = parseAuthority(objectFields(finalAuthority, APP_AUTHORITY_KEYS), life.now()); }
    catch { throw new ReviewFailure("REVIEW_AUTHORITY_CHANGED"); }
    if (current.ownerId !== source.ownerId || current.sessionId !== source.sessionId
      || current.sessionRevision !== source.sessionRevision || current.dataGeneration !== source.dataGeneration
      || current.expiresAt !== source.sessionExpiresAt || staged.value.dataGeneration !== source.dataGeneration) {
      return failed("REVIEW_AUTHORITY_CHANGED");
    }
    const value: CandidateBatchSavedReceipt = Object.freeze({ schema: "keyatlas.candidate-batch-saved.v1", state: "saved",
      batchReference: staged.value.batchReference, dataGeneration: staged.value.dataGeneration });
    life.now();
    return Object.freeze({ ok: true, value, receipt: receipt() });
  } catch (error) {
    if (!configured) return failed("RUN_CONFIG_INVALID");
    try { lifetime?.now(); } catch (stopped) { return failed(fixed(stopped)); }
    return failed(fixed(error));
  } finally {
    // Cancellation suppresses late delivery and future cooperative calls. A
    // dispatched provider/commit may still finish; there is no rollback promise.
    try { lifetime?.finish(); } finally { detachInput?.(); }
  }
}
