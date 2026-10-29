/**
 * One explicit candidate discard command per external workspace lease.
 * This owner is not authentication: hosts synchronously revoke it on external
 * lease/account/document retirement. It never mutates the review workspace.
 * No candidate content, automatic retry, persistence or rollback claim.
 */
import type { CandidateBatchContext } from "./candidate-batch-client.ts";
import { snapshotCandidateDiscardRequest, type CandidateDiscardCall, type CandidateDiscardCallResult,
  type CandidateDiscardFailure, type CandidateDiscardReceipt, type CandidateDiscardRequest } from "./candidate-discard-client.ts";

export interface CandidateDiscardSnapshot {
  readonly lease: object;
  readonly context: CandidateBatchContext;
  readonly phase: "idle" | "prepared" | "sending" | "uncertain" | "succeeded" | "rejected";
  readonly request: CandidateDiscardRequest | null;
  readonly receipt: CandidateDiscardReceipt | null;
  readonly failure: CandidateDiscardFailure | null;
}
export interface CandidateDiscardBinding { readonly lease: object; readonly context: CandidateBatchContext }
export interface CandidateDiscardObservation { readonly candidateId: string; readonly expectedRevision: number }
interface Frame { readonly lease: object; readonly context: CandidateBatchContext }
interface Command { readonly frame: Frame; readonly request: CandidateDiscardRequest; uncertain: boolean }
interface Pending { readonly command: Command; readonly abort: AbortController; readonly cancel: () => void }
const CANCELLED = Symbol("candidate-discard-cancelled");
const ERROR_CODES = ["API_NOT_FOUND", "API_METHOD_NOT_ALLOWED", "API_REQUEST_REJECTED", "API_MEDIA_TYPE",
  "API_BODY_TOO_LARGE", "API_INPUT_INVALID", "API_AUTH_REQUIRED", "API_SESSION_CHANGED", "API_RATE_LIMITED",
  "API_CONFLICT", "API_UNAVAILABLE", "API_TIMEOUT", "API_ABORTED"] as const;
const INVALID_REASONS = ["REQUEST", "STATUS", "HEADERS", "BODY", "ENVELOPE", "CLOCK"] as const;
const invalid = (): CandidateDiscardFailure => Object.freeze({ kind: "invalid", reason: "ENVELOPE", dispatched: true });

function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(input), actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) throw new Error();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new Error();
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
function context(input: unknown): CandidateBatchContext {
  const raw = fields(input, ["bindingId", "dataGeneration", "batchReference"]);
  if (!identifier(raw.bindingId) || !identifier(raw.batchReference) || typeof raw.dataGeneration !== "number"
    || !Number.isSafeInteger(raw.dataGeneration) || raw.dataGeneration < 1) throw new Error();
  return Object.freeze({ bindingId: raw.bindingId, dataGeneration: raw.dataGeneration, batchReference: raw.batchReference });
}
function same(a: CandidateBatchContext, b: CandidateBatchContext): boolean {
  return a.bindingId === b.bindingId && a.dataGeneration === b.dataGeneration && a.batchReference === b.batchReference;
}
function parseResult(input: unknown, command: Command): CandidateDiscardCallResult {
  try {
    // Ordinary getters are never called. Reflection traps may run; all callers
    // fence ownership again after decoding, because reflection is not a sandbox.
    if (typeof input !== "object" || input === null) return invalid();
    const tag = Object.getOwnPropertyDescriptor(input, "kind");
    if (!tag || !Object.hasOwn(tag, "value") || !tag.enumerable) return invalid();
    const kind: unknown = tag.value;
    if (kind === "success") {
      const raw = fields(input, ["kind", "context", "receipt"]), bound = context(raw.context);
      if (raw.kind !== kind) return invalid();
      if (!same(command.frame.context, bound)) return Object.freeze({ kind: "stale", dispatched: true });
      const value = fields(raw.receipt, ["batchReference", "candidateId", "candidateRevision", "state", "content"]);
      if (value.batchReference !== command.request.batchReference || value.candidateId !== command.request.candidateId
        || !Number.isSafeInteger(value.candidateRevision) || value.candidateRevision !== command.request.expectedRevision + 1
        || value.state !== "deleted" || value.content !== null) return invalid();
      return Object.freeze({ kind, context: bound, receipt: Object.freeze({
        batchReference: command.request.batchReference, candidateId: command.request.candidateId,
        candidateRevision: value.candidateRevision as number, state: "deleted", content: null,
      }) });
    }
    if (kind === "error") {
      const raw = fields(input, ["kind", "code", "retriableAfterMs", "dispatched"]);
      if (raw.kind !== kind || typeof raw.dispatched !== "boolean" || !ERROR_CODES.some((code) => code === raw.code)) return invalid();
      if (raw.code === "API_RATE_LIMITED" ? typeof raw.retriableAfterMs !== "number"
        || !Number.isSafeInteger(raw.retriableAfterMs) || raw.retriableAfterMs < 1000 || raw.retriableAfterMs > 60000
        || raw.retriableAfterMs % 1000 !== 0 : raw.retriableAfterMs !== null) return invalid();
      return Object.freeze({ kind, code: raw.code as typeof ERROR_CODES[number],
        retriableAfterMs: raw.retriableAfterMs as number | null, dispatched: raw.dispatched });
    }
    if (kind === "invalid") {
      const raw = fields(input, ["kind", "reason", "dispatched"]);
      return raw.kind === kind && typeof raw.dispatched === "boolean" && INVALID_REASONS.some((reason) => reason === raw.reason)
        ? Object.freeze({ kind, reason: raw.reason as typeof INVALID_REASONS[number], dispatched: raw.dispatched }) : invalid();
    }
    if (kind === "stale" || kind === "timeout" || kind === "aborted" || kind === "network") {
      const raw = fields(input, ["kind", "dispatched"]);
      return raw.kind === kind && typeof raw.dispatched === "boolean"
        ? Object.freeze({ kind, dispatched: raw.dispatched }) : invalid();
    }
    return invalid();
  } catch { return invalid(); }
}
function authorityFailure(result: CandidateDiscardFailure): boolean {
  return result.kind === "stale" || result.kind === "invalid" && result.reason === "CLOCK"
    || result.kind === "error" && ["API_AUTH_REQUIRED", "API_SESSION_CHANGED", "API_REQUEST_REJECTED"].includes(result.code);
}
function definitive(result: CandidateDiscardFailure): boolean {
  // Even the first API_CONFLICT can follow a committed write when the alias
  // retires before acknowledgement. Only local pre-dispatch proves not sent.
  return !result.dispatched;
}

export function createCandidateDiscardOwner(client: CandidateDiscardCall, onAuthorityRejected?: () => void) {
  if (typeof client !== "function" || onAuthorityRejected !== undefined && typeof onAuthorityRejected !== "function")
    throw new Error("CANDIDATE_DISCARD_OWNER_CONFIG_INVALID");
  let active: Frame | null = null, command: Command | null = null, pending: Pending | null = null;
  let snapshot: CandidateDiscardSnapshot | null = null, disposed = false, depth = 0;
  let activation: { readonly previousLease: object | null; cancelled: boolean } | null = null;
  const listeners = new Set<() => void>();
  const current = (frame: Frame): boolean => !disposed && active === frame;
  const currentFlight = (attempt: Pending): boolean =>
    current(attempt.command.frame) && pending === attempt && command === attempt.command;
  function notify(): void {
    depth++;
    try { for (const listener of [...listeners]) if (listeners.has(listener)) {
      try { listener(); } catch { /* Observer errors cannot block authority retirement. */ }
    } } finally { depth--; }
  }
  function publish(frame: Frame, phase: CandidateDiscardSnapshot["phase"], receipt: CandidateDiscardReceipt | null = null,
    failure: CandidateDiscardFailure | null = null): CandidateDiscardSnapshot | null {
    if (!current(frame)) return null;
    const next = Object.freeze({ lease: frame.lease, context: frame.context, phase,
      request: command?.request ?? null, receipt, failure });
    snapshot = next; notify();
    return current(frame) && snapshot === next ? next : null;
  }
  function revoke(authorityRejected = false): void {
    const old = pending, changed = snapshot !== null;
    // Erase ownership before synchronous adapter callbacks, and abort before
    // observers are notified. A noncooperative late result has no apply right.
    active = null; command = null; pending = null; snapshot = null;
    if (old) { old.cancel(); old.abort.abort(); }
    // The trusted host may retire the WHOLE review workspace. It sees no
    // retained command and runs before observers, without exposing error data.
    if (authorityRejected) try { onAuthorityRejected?.(); } catch { /* Still finish own revocation. */ }
    if (changed) notify();
  }
  function activate(input: unknown): CandidateDiscardSnapshot | null {
    if (disposed || depth > 0) return null;
    depth++;
    const attempt = { previousLease: active?.lease ?? null, cancelled: false };
    activation = attempt;
    try {
      revoke();
      const raw = fields(input, ["lease", "context"]);
      if (typeof raw.lease !== "object" || raw.lease === null || Array.isArray(raw.lease)) return null;
      const frame: Frame = { lease: raw.lease, context: context(raw.context) };
      if (disposed || attempt.cancelled) return null;
      active = frame; return publish(frame, "idle");
    } catch { return null; }
    finally { if (activation === attempt) activation = null; depth--; }
  }
  function prepare(expected: CandidateDiscardSnapshot, input: unknown): CandidateDiscardSnapshot | null {
    if (disposed || depth > 0 || snapshot !== expected || !active || pending
      || !["idle", "succeeded", "rejected"].includes(snapshot.phase)) return null;
    const frame = active;
    depth++;
    try {
      const raw = fields(input, ["candidateId", "expectedRevision"]);
      const request = snapshotCandidateDiscardRequest({ batchReference: frame.context.batchReference,
        candidateId: raw.candidateId, expectedRevision: raw.expectedRevision, decision: "discard" });
      if (!request || !current(frame) || snapshot !== expected) return null;
      command = { frame, request, uncertain: false };
      return publish(frame, "prepared");
    } catch { return null; }
    finally { depth--; }
  }
  async function run(expected: CandidateDiscardSnapshot, reconciling: boolean): Promise<boolean> {
    if (disposed || depth > 0 || snapshot !== expected || !active || pending || !command
      || snapshot.phase !== (reconciling ? "uncertain" : "prepared")) return false;
    const captured = command, frame = active;
    let cancel!: () => void;
    const cancelled = new Promise<typeof CANCELLED>((resolve) => { cancel = () => resolve(CANCELLED); });
    const attempt: Pending = { command: captured, abort: new AbortController(), cancel };
    let operation: Promise<unknown>;
    depth++;
    try {
      pending = attempt;
      if (!publish(frame, "sending") || !currentFlight(attempt)) return false;
      try { operation = Promise.resolve(client(captured.request, attempt.abort.signal)); }
      catch { operation = Promise.resolve(Object.freeze({ kind: "network", dispatched: true })); }
    } finally { depth--; }
    const raw: unknown = await Promise.race([
      operation.catch(() => Object.freeze({ kind: "network", dispatched: true })), cancelled,
    ]);
    if (raw === CANCELLED || !currentFlight(attempt)) return false;
    depth++;
    try {
      const result = parseResult(raw, captured);
      if (!currentFlight(attempt)) return false;
      if (result.kind !== "success" && authorityFailure(result)) { revoke(true); return false; }
      pending = null;
      if (result.kind === "success") return publish(frame, "succeeded", result.receipt) !== null;
      // Once acknowledgement was lost, a later 404/409 or preflight failure
      // cannot disprove that the ORIGINAL write committed. Keep that exact
      // request, never substitute a newer revision or permit a different target.
      captured.uncertain = captured.uncertain || !definitive(result);
      publish(frame, captured.uncertain ? "uncertain" : "rejected", null, result);
      return false;
    } finally { depth--; }
  }
  function cancelPrepared(expected: CandidateDiscardSnapshot): boolean {
    if (disposed || depth > 0 || snapshot !== expected || !active || pending || snapshot.phase !== "prepared") return false;
    const frame = active;
    depth++;
    try { command = null; return publish(frame, "idle") !== null; }
    finally { depth--; }
  }
  function deactivate(lease: object): void {
    if (activation?.previousLease === lease) activation.cancelled = true;
    if (!active || active.lease !== lease) return;
    depth++;
    try { revoke(); } finally { depth--; }
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (activation) activation.cancelled = true;
    depth++;
    try { revoke(); listeners.clear(); } finally { depth--; }
  }
  return Object.freeze({ activate, prepare,
    execute: (expected: CandidateDiscardSnapshot): Promise<boolean> => run(expected, false),
    reconcile: (expected: CandidateDiscardSnapshot): Promise<boolean> => run(expected, true),
    cancelPrepared, deactivate, dispose,
    getSnapshot: (): CandidateDiscardSnapshot | null => snapshot,
    getContext: (): CandidateBatchContext | null => snapshot?.context ?? null,
    subscribe(listener: () => void): () => void {
      if (disposed || typeof listener !== "function") return () => {};
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
  });
}
export type CandidateDiscardOwner = ReturnType<typeof createCandidateDiscardOwner>;
