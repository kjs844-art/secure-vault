/** One in-memory delivery slot. No HTTP, mailbox/quota replay, clocks, timers,
 * UUID, persistence or workspace activation. The host revokes this owner when
 * its external workspace lease becomes inactive. Old returned objects cannot
 * be recalled. Receipt possession never grants server authority. */
import type { AnalysisDeliveryBinding, AnalysisDeliveryPhase, AnalysisDeliverySnapshot,
  AnalysisDeliveryTicket, CandidateBatchSavedReceipt } from "./contracts";
import { decodeCandidateBatchSavedReceipt, normalizeAnalysisDeliveryBinding } from "./receipt";

export function createAnalysisDeliveryOwner() {
  let active: AnalysisDeliveryBinding | null = null, snapshot: AnalysisDeliverySnapshot | null = null;
  let pending: AnalysisDeliveryTicket | null = null, disposed = false, transitionDepth = 0;
  let activation: { readonly previousLease: object | null; cancelled: boolean } | null = null;
  const listeners = new Set<() => void>();
  const current = (frame: AnalysisDeliveryBinding) => !disposed && active === frame;
  function notify(): void {
    transitionDepth++;
    try { for (const listener of [...listeners]) if (listeners.has(listener)) {
      try { listener(); } catch { /* Observer exceptions cannot defeat revocation. */ }
    } } finally { transitionDepth--; }
  }
  function revoke(): void {
    const changed = snapshot !== null;
    active = null; snapshot = null; pending = null;
    if (changed) notify();
  }
  function guarded<T>(fallback: T, action: () => T): T {
    if (disposed || transitionDepth > 0) return fallback;
    transitionDepth++;
    try { return action(); } finally { transitionDepth--; }
  }
  function publish(frame: AnalysisDeliveryBinding, phase: AnalysisDeliveryPhase,
    receipt: CandidateBatchSavedReceipt | null = null, selectedReference: string | null = null): boolean {
    if (!current(frame)) return false;
    const next = Object.freeze({ lease: frame.lease, context: frame.context, phase, receipt, selectedReference });
    snapshot = next; notify();
    return current(frame) && snapshot === next;
  }
  function activate(input: unknown): AnalysisDeliverySnapshot | null {
    return guarded(null as AnalysisDeliverySnapshot | null, () => {
      const attempt = { previousLease: active?.lease ?? null, cancelled: false };
      activation = attempt;
      try {
        revoke();
        const frame = normalizeAnalysisDeliveryBinding(input);
        if (!frame || disposed || attempt.cancelled) return null;
        active = frame;
        return publish(frame, "idle") ? snapshot : null;
      } finally { if (activation === attempt) activation = null; }
    });
  }
  function begin(expected: unknown): AnalysisDeliveryTicket | null {
    return guarded(null as AnalysisDeliveryTicket | null, () => {
      const frame = active;
      if (!frame || snapshot === null || snapshot !== expected) return null;
      // Explicit replacement clears this owner only, never external review
      // commands. Even an equal context receives a new unforgeable local ticket.
      const ticket = Object.freeze({}) as AnalysisDeliveryTicket;
      pending = ticket;
      return publish(frame, "receiving") && pending === ticket ? ticket : null;
    });
  }
  function deliver(ticket: unknown, input: unknown): boolean {
    return guarded(false, () => {
      const frame = active;
      // Stale/cross-owner tickets are rejected BEFORE inspecting untrusted data.
      if (!frame || pending === null || pending !== ticket) return false;
      const receipt = decodeCandidateBatchSavedReceipt(input);
      if (!current(frame) || pending !== ticket) return false;
      pending = null;
      if (!receipt || receipt.dataGeneration !== frame.context.dataGeneration) {
        publish(frame, "unconfirmed"); return false;
      }
      return publish(frame, "saved", receipt);
    });
  }
  function select(expected: unknown): boolean {
    return guarded(false, () => {
      const frame = active, shown = snapshot;
      if (!frame || !shown || shown !== expected || shown.phase !== "saved" || !shown.receipt) return false;
      return publish(frame, "selected", shown.receipt, shown.receipt.batchReference);
    });
  }
  function cancel(expected: unknown): boolean {
    return guarded(false, () => {
      const frame = active;
      if (!frame || snapshot === null || snapshot.phase === "idle"
        || (snapshot !== expected && (pending === null || pending !== expected))) return false;
      pending = null; return publish(frame, "idle");
    });
  }
  /** Explicit LOCAL display expiration. The receipt has no server TTL and this
   * method neither retires the server alias nor proves that stored data expired. */
  function expire(expected: unknown): boolean {
    return guarded(false, () => {
      const frame = active;
      if (!frame || snapshot === null || snapshot !== expected || snapshot.phase === "expired") return false;
      pending = null; return publish(frame, "expired");
    });
  }
  function deactivate(lease: unknown): void {
    if (activation && activation.previousLease === lease && lease !== null) activation.cancelled = true;
    if (active?.lease !== lease || active === null) return;
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
  return Object.freeze({ activate, begin, deliver, select, cancel, expire, deactivate, dispose,
    getSnapshot: (): AnalysisDeliverySnapshot | null => snapshot,
    subscribe(listener: () => void): () => void {
      if (disposed) return () => {};
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
  });
}
export type AnalysisDeliveryOwner = ReturnType<typeof createAnalysisDeliveryOwner>;
