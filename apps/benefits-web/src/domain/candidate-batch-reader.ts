/**
 * One explicit known-batch read at a time. This owner neither activates nor
 * revokes a review workspace: its caller must synchronously deactivate it when
 * the external workspace lease/account/document becomes inactive. No timers,
 * persistence, authentication, automatic read/retry or provider calls here.
 */
import { decodeCandidateBatchDisplay, type CandidateBatchDisplay } from "./candidate-batch-view";
import type { CandidateBatchCallResult, CandidateBatchContext } from "./candidate-batch-client";

export type CandidateBatchReaderFailure = Exclude<CandidateBatchCallResult, { readonly kind: "success" }>;
export interface CandidateBatchReaderSnapshot {
  /** External identity only, not a credential; the owner never mutates it. */
  readonly lease: object;
  readonly context: CandidateBatchContext;
  readonly phase: "idle" | "loading" | "ready" | "failed";
  readonly batch: CandidateBatchDisplay | null;
  readonly failure: CandidateBatchReaderFailure | null;
}
export interface CandidateBatchReaderBinding { readonly lease: object; readonly context: CandidateBatchContext }
export type CandidateBatchRead = (signal?: AbortSignal) => Promise<CandidateBatchCallResult>;
interface Frame { readonly lease: object; readonly context: CandidateBatchContext }
interface Pending { readonly frame: Frame; readonly abort: AbortController; readonly cancel: () => void }
const CANCELLED = Symbol("candidate-read-cancelled");
const ERROR_CODES = ["API_NOT_FOUND", "API_METHOD_NOT_ALLOWED", "API_REQUEST_REJECTED", "API_MEDIA_TYPE",
  "API_BODY_TOO_LARGE", "API_INPUT_INVALID", "API_AUTH_REQUIRED", "API_SESSION_CHANGED", "API_RATE_LIMITED",
  "API_CONFLICT", "API_UNAVAILABLE", "API_TIMEOUT", "API_ABORTED"] as const;
const INVALID_REASONS = ["REQUEST", "STATUS", "HEADERS", "BODY", "ENVELOPE", "CLOCK"] as const;
const invalid = (): CandidateBatchReaderFailure => Object.freeze({ kind: "invalid", reason: "ENVELOPE" });

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
function parseResult(input: unknown, expected: CandidateBatchContext): CandidateBatchCallResult {
  try {
    // Inspect the tag as a descriptor, never through a getter. Reflection traps
    // may execute; exception containment is not a Proxy sandbox.
    if (typeof input !== "object" || input === null) return invalid();
    const tag = Object.getOwnPropertyDescriptor(input, "kind");
    if (!tag || !Object.hasOwn(tag, "value") || !tag.enumerable) return invalid();
    const kind: unknown = tag.value;
    if (kind === "success") {
      const raw = fields(input, ["kind", "context", "batch"]), bound = context(raw.context);
      if (raw.kind !== kind) return invalid();
      if (!same(expected, bound)) return Object.freeze({ kind: "stale" });
      const batch = decodeCandidateBatchDisplay(raw.batch);
      if (!batch || batch.dataGeneration !== expected.dataGeneration) return invalid();
      return Object.freeze({ kind, context: bound, batch });
    }
    if (kind === "error") {
      const raw = fields(input, ["kind", "code", "retriableAfterMs"]);
      if (raw.kind !== kind || !ERROR_CODES.some((code) => code === raw.code)) return invalid();
      if (raw.code === "API_RATE_LIMITED" ? typeof raw.retriableAfterMs !== "number"
        || !Number.isSafeInteger(raw.retriableAfterMs) || raw.retriableAfterMs < 1000 || raw.retriableAfterMs > 60000
        || raw.retriableAfterMs % 1000 !== 0 : raw.retriableAfterMs !== null) return invalid();
      return Object.freeze({ kind, code: raw.code as typeof ERROR_CODES[number], retriableAfterMs: raw.retriableAfterMs as number | null });
    }
    if (kind === "invalid") {
      const raw = fields(input, ["kind", "reason"]);
      return raw.kind === kind && INVALID_REASONS.some((reason) => reason === raw.reason)
        ? Object.freeze({ kind, reason: raw.reason as typeof INVALID_REASONS[number] }) : invalid();
    }
    if (kind === "stale" || kind === "timeout" || kind === "aborted" || kind === "network") {
      return fields(input, ["kind"]).kind === kind ? Object.freeze({ kind }) : invalid();
    }
    return invalid();
  } catch { return invalid(); }
}

export function createCandidateBatchReader(client: CandidateBatchRead) {
  if (typeof client !== "function") throw new Error("CANDIDATE_BATCH_READER_CONFIG_INVALID");
  let active: Frame | null = null, pending: Pending | null = null, snapshot: CandidateBatchReaderSnapshot | null = null;
  let disposed = false, transitionDepth = 0;
  let activation: { readonly previousLease: object | null; cancelled: boolean } | null = null;
  const listeners = new Set<() => void>();
  const current = (frame: Frame): boolean => !disposed && active === frame;
  const currentRead = (attempt: Pending): boolean => current(attempt.frame) && pending === attempt;
  function notify(): void {
    transitionDepth++;
    try { for (const listener of [...listeners]) if (listeners.has(listener)) {
      try { listener(); } catch { /* Observer errors do not prevent revocation. */ }
    } } finally { transitionDepth--; }
  }
  function publish(frame: Frame, phase: CandidateBatchReaderSnapshot["phase"], batch: CandidateBatchDisplay | null = null,
    failure: CandidateBatchReaderFailure | null = null): CandidateBatchReaderSnapshot | null {
    if (!current(frame)) return null;
    const next = Object.freeze({ lease: frame.lease, context: frame.context, phase, batch, failure });
    snapshot = next; notify();
    return current(frame) && snapshot === next ? next : null;
  }
  function stop(attempt: Pending | null): void {
    // The logical read settles even when an injected port ignores cancellation.
    // Abort does not guarantee destruction of that port's underlying resources.
    if (attempt) { attempt.cancel(); attempt.abort.abort(); }
  }
  function revoke(): void {
    const old = pending, changed = snapshot !== null;
    active = null; pending = null; snapshot = null;
    if (changed) notify();
    stop(old);
  }
  function activate(input: unknown): CandidateBatchReaderSnapshot | null {
    if (disposed || transitionDepth > 0) return null;
    transitionDepth++;
    const attempt = { previousLease: active?.lease ?? null, cancelled: false };
    activation = attempt;
    try {
      revoke();
      const raw = fields(input, ["lease", "context"]);
      if (typeof raw.lease !== "object" || raw.lease === null || Array.isArray(raw.lease)) return null;
      const frame: Frame = { lease: raw.lease, context: context(raw.context) };
      if (disposed || attempt.cancelled) return null;
      active = frame;
      return publish(frame, "idle");
    } catch { return null; }
    finally { if (activation === attempt) activation = null; transitionDepth--; }
  }
  async function read(expected: CandidateBatchReaderSnapshot): Promise<boolean> {
    if (disposed || transitionDepth > 0 || snapshot !== expected || !active || pending) return false;
    const frame = active;
    let cancel!: () => void;
    const cancelled = new Promise<typeof CANCELLED>((resolve) => { cancel = () => resolve(CANCELLED); });
    const attempt: Pending = { frame, abort: new AbortController(), cancel };
    transitionDepth++;
    let operation: Promise<unknown>;
    try {
      pending = attempt;
      if (!publish(frame, "loading") || !currentRead(attempt)) return false;
      try { operation = Promise.resolve(client(attempt.abort.signal)); }
      catch { operation = Promise.resolve(Object.freeze({ kind: "network" })); }
    } finally { transitionDepth--; }
    // Attach rejection handling immediately; an abandoned late rejection must
    // not become unhandled or revive a newer read, even for A -> B -> A.
    const raw: unknown = await Promise.race([operation.catch(() => Object.freeze({ kind: "network" })), cancelled]);
    if (raw === CANCELLED || !currentRead(attempt)) return false;
    transitionDepth++;
    try {
      const result = parseResult(raw, frame.context);
      if (!currentRead(attempt)) return false;
      pending = null;
      if (result.kind !== "success") { publish(frame, "failed", null, result); return false; }
      return publish(frame, "ready", result.batch) !== null;
    } finally { transitionDepth--; }
  }
  function cancel(expected: CandidateBatchReaderSnapshot): boolean {
    if (disposed || snapshot !== expected || !active || (snapshot.phase === "idle" && pending === null)) return false;
    const frame = active, old = pending;
    transitionDepth++;
    try { pending = null; publish(frame, "idle"); stop(old); return true; }
    finally { transitionDepth--; }
  }
  function deactivate(lease: object): void {
    if (activation?.previousLease === lease) activation.cancelled = true;
    if (!active || active.lease !== lease) return;
    transitionDepth++;
    try { revoke(); } finally { transitionDepth--; }
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (activation) activation.cancelled = true;
    transitionDepth++;
    try { revoke(); listeners.clear(); } finally { transitionDepth--; }
  }
  return Object.freeze({ activate, read, cancel, deactivate, dispose,
    getSnapshot: (): CandidateBatchReaderSnapshot | null => snapshot,
    getContext: (): CandidateBatchContext | null => snapshot?.context ?? null,
    subscribe(listener: () => void): () => void {
      if (disposed) return () => {};
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
  });
}
export type CandidateBatchReader = ReturnType<typeof createCandidateBatchReader>;
