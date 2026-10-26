/**
 * One in-memory pending-preview slot. Leases/tickets are instance-local stale
 * response fences, NOT credentials. No transport, timers, DOM, persistence,
 * confirm/reject dispatch, server revocation or retry lives in this module.
 */
import { decodeReviewPreviewView, type ReviewPreviewView } from "./review-preview-view.ts";

declare const leaseBrand: unique symbol;
declare const ticketBrand: unique symbol;
export type ReviewPreviewLease = { readonly [leaseBrand]: true };
export type ReviewPreviewTicket = { readonly [ticketBrand]: true };
export type ReviewPreviewPhase = "idle" | "loading" | "ready" | "expired" | "invalid";
export interface ReviewPreviewSnapshot {
  readonly lease: ReviewPreviewLease;
  readonly dataGeneration: number;
  readonly phase: ReviewPreviewPhase;
  readonly preview: ReviewPreviewView | null;
}
export interface ReviewPreviewOwnerConfig {
  /** Trusted, synchronous clock adapter. No clock is sampled at construction. */
  readonly clocks: () => unknown;
}
interface ClockSample { readonly wall: number; readonly monotonic: number }
interface ActiveView {
  readonly lease: ReviewPreviewLease;
  readonly dataGeneration: number;
  lastClock: ClockSample | null;
  monotonicDeadline: number | null;
}

function clockSample(input: unknown): ClockSample | null {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 2 || !keys.includes("wall") || !keys.includes("monotonic")) return null;
    const wall = descriptors.wall, monotonic = descriptors.monotonic;
    if (!wall?.enumerable || !monotonic?.enumerable || !Object.hasOwn(wall, "value")
      || !Object.hasOwn(monotonic, "value")) return null;
    const w: unknown = wall.value, m: unknown = monotonic.value;
    if (typeof w !== "number" || !Number.isSafeInteger(w) || Object.is(w, -0)
      || w < 0 || w > 253402300799999 || typeof m !== "number" || !Number.isFinite(m)
      || Object.is(m, -0) || m < 0 || m > Number.MAX_SAFE_INTEGER) return null;
    return Object.freeze({ wall: w, monotonic: m });
  } catch { return null; }
}

export function createReviewPreviewOwner(config: ReviewPreviewOwnerConfig) {
  // The fixed dependency is trusted; returned data is still validated. The
  // production caller must choose clocks and own lifecycle/expiry scheduling.
  const clocks = config.clocks;
  if (typeof clocks !== "function") throw new Error("REVIEW_PREVIEW_OWNER_CONFIG_INVALID");
  let active: ActiveView | null = null;
  let pending: ReviewPreviewTicket | null = null;
  let snapshot: ReviewPreviewSnapshot | null = null;
  let activationAttempt: { readonly previousLease: ReviewPreviewLease | null } | null = null;
  let disposed = false;
  let transitionDepth = 0;
  const listeners = new Set<() => void>();

  function current(view: ActiveView): boolean { return !disposed && active === view; }
  function notify(): void {
    transitionDepth++;
    try {
      for (const listener of [...listeners]) {
        if (listeners.has(listener)) {
          try { listener(); } catch { /* An observer cannot block revocation. */ }
        }
      }
    } finally { transitionDepth--; }
  }
  function revoke(): void {
    const changed = snapshot !== null;
    // Revoke all internal references before notifying. Already returned frozen
    // objects cannot be recalled, and the JS engine does not guarantee erasure.
    active = null;
    pending = null;
    snapshot = null;
    if (changed) notify();
  }
  function publish(view: ActiveView, phase: ReviewPreviewPhase, preview: ReviewPreviewView | null = null): boolean {
    if (!current(view)) return false;
    if (phase !== "ready") view.monotonicDeadline = null;
    const next = Object.freeze({ lease: view.lease, dataGeneration: view.dataGeneration, phase, preview });
    snapshot = next;
    notify();
    return current(view) && snapshot === next;
  }
  function sample(view: ActiveView): ClockSample | null {
    let time: ClockSample | null = null;
    try { time = clockSample(clocks()); } catch { /* Do not expose adapter errors. */ }
    // Clocks/Proxy traps may synchronously revoke. Never resurrect that owner.
    if (!current(view)) return null;
    if (time === null || (view.lastClock !== null
      && (time.wall < view.lastClock.wall || time.monotonic < view.lastClock.monotonic))) {
      revoke();
      return null;
    }
    view.lastClock = time;
    return time;
  }
  function guarded<T>(fallback: T, action: () => T): T {
    if (disposed || transitionDepth > 0) return fallback;
    transitionDepth++;
    try { return action(); } finally { transitionDepth--; }
  }

  function activate(dataGeneration: unknown): ReviewPreviewLease | null {
    return guarded(null as ReviewPreviewLease | null, () => {
      const attempt = { previousLease: active?.lease ?? null };
      activationAttempt = attempt;
      try {
        revoke();
        // During this null notification the previous lifecycle owner can log
        // out. Its revocation wins over the in-progress replacement activation.
        if (disposed || activationAttempt !== attempt || typeof dataGeneration !== "number"
          || !Number.isSafeInteger(dataGeneration) || dataGeneration < 1) return null;
        const view: ActiveView = { lease: Object.freeze({}) as ReviewPreviewLease,
          dataGeneration, lastClock: null, monotonicDeadline: null };
        active = view;
        if (sample(view) === null || activationAttempt !== attempt || !publish(view, "idle")) return null;
        return view.lease;
      } finally {
        if (activationAttempt === attempt) activationAttempt = null;
      }
    });
  }
  function begin(lease: unknown, expectedSnapshot: unknown): ReviewPreviewTicket | null {
    return guarded(null as ReviewPreviewTicket | null, () => {
      const view = active;
      if (view === null || view.lease !== lease || snapshot === null || snapshot !== expectedSnapshot) return null;
      if (sample(view) === null) return null;
      // An explicit replacement starts a new slot; no fallback to the previous
      // preview if this request fails. Old click closures cannot start a request.
      const ticket = Object.freeze({}) as ReviewPreviewTicket;
      pending = ticket;
      if (!publish(view, "loading")) return null;
      return pending === ticket ? ticket : null;
    });
  }
  function settle(ticket: unknown, payload: unknown): boolean {
    return guarded(false, () => {
      const view = active;
      // Check before decoding: stale payload traps are not inspected at all.
      if (view === null || pending === null || pending !== ticket) return false;
      const preview = decodeReviewPreviewView(payload);
      if (!current(view) || pending !== ticket) return false;
      const time = sample(view);
      if (time === null || pending !== ticket) return false;
      pending = null; // A completed ticket is never reusable.
      if (preview === null || preview.dataGeneration !== view.dataGeneration) {
        publish(view, "invalid");
        return false;
      }
      const remaining = preview.expiresAt - time.wall;
      if (remaining <= 0) { publish(view, "expired"); return false; }
      const deadline = time.monotonic + remaining;
      if (!Number.isFinite(deadline) || deadline > Number.MAX_SAFE_INTEGER || deadline <= time.monotonic) {
        publish(view, "invalid");
        return false;
      }
      view.monotonicDeadline = deadline;
      return publish(view, "ready", preview);
    });
  }
  function fail(ticket: unknown): boolean {
    return guarded(false, () => {
      const view = active;
      if (view === null || pending === null || pending !== ticket || sample(view) === null) return false;
      pending = null;
      return publish(view, "invalid");
    });
  }
  function cancel(lease: unknown, expected: unknown): boolean {
    return guarded(false, () => {
      const view = active;
      if (view === null || view.lease !== lease || snapshot === null || snapshot.phase === "idle"
        || (expected !== snapshot && (pending === null || expected !== pending))) return false;
      if (sample(view) === null) return false;
      pending = null;
      return publish(view, "idle");
    });
  }
  function checkExpiry(lease: unknown, expectedSnapshot: unknown): boolean {
    return guarded(false, () => {
      const view = active;
      const shown = snapshot;
      if (view === null || view.lease !== lease || shown === null || shown !== expectedSnapshot
        || shown.phase !== "ready" || shown.preview === null) return false;
      const time = sample(view);
      if (time === null) return false;
      if (time.wall >= shown.preview.expiresAt || view.monotonicDeadline === null
        || time.monotonic >= view.monotonicDeadline) {
        publish(view, "expired");
        return false;
      }
      return true;
    });
  }
  function deactivate(lease: unknown): void {
    if (disposed || lease === null || lease === undefined) return;
    if (active?.lease === lease || activationAttempt?.previousLease === lease) {
      activationAttempt = null;
      revoke();
    }
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    activationAttempt = null;
    try { revoke(); } finally { listeners.clear(); }
  }
  function subscribe(listener: () => void): () => void {
    if (disposed || typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  // Pure cached read, suitable for a future useSyncExternalStore adapter.
  // The lifecycle owner MUST check expiry on scheduled ticks and immediately
  // before acting, and deactivate on hide/logout/navigation. No automatic
  // timers are installed here. A true check is not server authorization and
  // must not be cached across await/another event as permission to confirm.
  return Object.freeze({ getSnapshot: (): ReviewPreviewSnapshot | null => snapshot,
    activate, begin, settle, fail, cancel, checkExpiry, deactivate, dispose, subscribe });
}

export type ReviewPreviewOwner = ReturnType<typeof createReviewPreviewOwner>;
