/**
 * Bounded, explicit page traversal over reviewed observations. No transport,
 * timers, authentication, persistence or current-balance guarantee. The caller
 * owns authenticated response binding and must synchronously deactivate on
 * logout/authority change/hide. Leases and tickets are not credentials.
 */
import { decodeReviewedBenefitPage, type ReviewedBenefitPageCursor } from "./reviewed-benefit-page";
import { createReviewedBenefitViewState, decodeReviewedBenefitView, MAX_REVIEWED_BENEFIT_ENTRIES,
  reduceReviewedBenefitView, type ReviewedBenefitView, type ReviewedBenefitViewState } from "./reviewed-benefit-view";

export const REVIEWED_BENEFIT_PAGE_SIZE = 50;
export const MAX_REVIEWED_BENEFIT_PAGES = 20;
declare const leaseBrand: unique symbol;
declare const ticketBrand: unique symbol;
export type ReviewedBenefitListLease = { readonly [leaseBrand]: true };
export type ReviewedBenefitListTicket = { readonly [ticketBrand]: true };
export type ReviewedBenefitListPhase = "ready" | "loading" | "more" | "retry_required"
  | "restart_required" | "end_observed";
export interface ReviewedBenefitListSnapshot {
  readonly lease: ReviewedBenefitListLease;
  readonly dataGeneration: number;
  readonly entries: readonly ReviewedBenefitView[];
  readonly phase: ReviewedBenefitListPhase;
  readonly benefitCollectionRevision: number | null;
  readonly pagesAccepted: number;
  /** Accepted page rows, not a current/live/complete inventory count. */
  readonly pageRowsObserved: number;
}
export interface ReviewedBenefitListRequest {
  readonly limit: typeof REVIEWED_BENEFIT_PAGE_SIZE;
  readonly cursor: ReviewedBenefitPageCursor | null;
}
export interface ReviewedBenefitListAttempt {
  readonly ticket: ReviewedBenefitListTicket;
  readonly request: ReviewedBenefitListRequest;
}
export type ReviewedBenefitObservationResult = "updated" | "unchanged" | "invalid" | "capacity" | "ignored";
interface ActiveView {
  readonly lease: ReviewedBenefitListLease;
  state: ReviewedBenefitViewState;
  cursor: ReviewedBenefitPageCursor | null;
  revision: number | null;
  pages: number;
  rows: number;
}
interface Pending {
  readonly view: ActiveView;
  readonly attempt: ReviewedBenefitListAttempt;
}
// Local reducer namespace only. Never reused in this loaded module; not an ID
// for a user/account. Opaque instance-local leases still fence separate owners.
let nextScope = 0;

export function createReviewedBenefitListOwner() {
  let active: ActiveView | null = null;
  let pending: Pending | null = null;
  let snapshot: ReviewedBenefitListSnapshot | null = null;
  let activationAttempt: { readonly previousLease: ReviewedBenefitListLease | null } | null = null;
  let disposed = false;
  let transitionDepth = 0;
  const listeners = new Set<() => void>();

  function current(view: ActiveView): boolean { return !disposed && active === view; }
  function notify(): void {
    transitionDepth++;
    try {
      for (const listener of [...listeners]) {
        if (listeners.has(listener)) {
          try { listener(); } catch { /* Observers cannot block revocation. */ }
        }
      }
    } finally { transitionDepth--; }
  }
  function revoke(): void {
    const changed = snapshot !== null;
    active = null;
    pending = null;
    snapshot = null;
    if (changed) notify();
  }
  function publish(view: ActiveView, phase: ReviewedBenefitListPhase): boolean {
    if (!current(view)) return false;
    const next = Object.freeze({ lease: view.lease, dataGeneration: view.state.dataGeneration,
      entries: view.state.entries, phase, benefitCollectionRevision: view.revision,
      pagesAccepted: view.pages, pageRowsObserved: view.rows });
    snapshot = next;
    notify();
    return current(view) && snapshot === next;
  }
  function guarded<T>(fallback: T, action: () => T): T {
    if (disposed || transitionDepth > 0) return fallback;
    transitionDepth++;
    try { return action(); } finally { transitionDepth--; }
  }
  function restart(view: ActiveView): boolean {
    pending = null;
    view.cursor = null;
    return publish(view, "restart_required");
  }
  function activate(dataGeneration: unknown): ReviewedBenefitListLease | null {
    return guarded(null as ReviewedBenefitListLease | null, () => {
      const attempt = { previousLease: active?.lease ?? null };
      activationAttempt = attempt;
      try {
        revoke();
        if (disposed || activationAttempt !== attempt || typeof dataGeneration !== "number"
          || !Number.isSafeInteger(dataGeneration) || dataGeneration < 1 || nextScope >= Number.MAX_SAFE_INTEGER) return null;
        const view: ActiveView = { lease: Object.freeze({}) as ReviewedBenefitListLease,
          state: createReviewedBenefitViewState(`reviewed-list-${++nextScope}`, dataGeneration),
          cursor: null, revision: null, pages: 0, rows: 0 };
        active = view;
        return publish(view, "ready") ? view.lease : null;
      } finally { if (activationAttempt === attempt) activationAttempt = null; }
    });
  }
  function begin(lease: unknown, expectedSnapshot: unknown): ReviewedBenefitListAttempt | null {
    return guarded(null as ReviewedBenefitListAttempt | null, () => {
      const view = active;
      if (view === null || view.lease !== lease || snapshot === null || snapshot !== expectedSnapshot || pending !== null
        || !["ready", "more", "retry_required"].includes(snapshot.phase)) return null;
      if (view.pages >= MAX_REVIEWED_BENEFIT_PAGES || view.state.entries.length >= MAX_REVIEWED_BENEFIT_ENTRIES) {
        restart(view);
        return null;
      }
      const attempt = Object.freeze({ ticket: Object.freeze({}) as ReviewedBenefitListTicket,
        request: Object.freeze({ limit: REVIEWED_BENEFIT_PAGE_SIZE,
          cursor: view.cursor === null ? null : Object.freeze({ ...view.cursor }) }) });
      const record: Pending = { view, attempt };
      pending = record;
      return publish(view, "loading") && pending === record ? attempt : null;
    });
  }
  function settle(ticket: unknown, payload: unknown): boolean {
    return guarded(false, () => {
      const record = pending;
      if (record === null || record.attempt.ticket !== ticket || !current(record.view)) return false;
      const page = decodeReviewedBenefitPage(payload);
      // A decoder's Proxy trap may revoke this lease. Stale payloads are never
      // inspected, and revocation during decoding wins over publication.
      if (!current(record.view) || pending !== record) return false;
      const view = record.view;
      const request = record.attempt.request;
      pending = null; // Every completion consumes its ticket, including invalid.
      if (page === null || page.dataGeneration !== view.state.dataGeneration
        || page.benefits.length > request.limit
        || (page.nextCursor !== null && page.benefits.length !== request.limit)
        || (request.cursor !== null && (page.benefitCollectionRevision !== request.cursor.benefitCollectionRevision
          || page.benefits.some((row) => row.benefitId <= request.cursor!.afterId)))
        || (view.revision !== null && page.benefitCollectionRevision !== view.revision)) {
        restart(view);
        return false;
      }
      const ids = new Set(view.state.entries.map((row) => row.benefitId));
      // A traversal cannot replace an earlier row or treat absent rows as deleted.
      // Observations from commands invalidate traversal before any next page.
      if (page.benefits.some((row) => ids.has(row.benefitId))
        || view.state.entries.length + page.benefits.length > MAX_REVIEWED_BENEFIT_ENTRIES) {
        restart(view);
        return false;
      }
      view.state = Object.freeze({ ...view.state, entries: Object.freeze([...view.state.entries, ...page.benefits]) });
      view.revision = page.benefitCollectionRevision;
      view.cursor = page.nextCursor;
      view.pages++;
      view.rows += page.benefits.length;
      const phase = page.nextCursor === null ? "end_observed"
        : view.pages === MAX_REVIEWED_BENEFIT_PAGES ? "restart_required" : "more";
      if (phase === "restart_required") view.cursor = null;
      return publish(view, phase);
    });
  }
  function fail(ticket: unknown, reason: unknown = "retry"): boolean {
    return guarded(false, () => {
      const record = pending;
      if (record === null || record.attempt.ticket !== ticket || !current(record.view)
        || (reason !== "retry" && reason !== "conflict" && reason !== "authority")) return false;
      pending = null;
      if (reason === "authority") { revoke(); return true; }
      return reason === "conflict" ? restart(record.view) : publish(record.view, "retry_required");
    });
  }
  function cancel(lease: unknown, expected: unknown): boolean {
    return guarded(false, () => {
      const record = pending;
      if (record === null || record.view.lease !== lease || !current(record.view)
        || (expected !== snapshot && expected !== record.attempt.ticket)) return false;
      pending = null;
      return publish(record.view, "retry_required");
    });
  }
  function observe(lease: unknown, payload: unknown): ReviewedBenefitObservationResult {
    return guarded("ignored" as ReviewedBenefitObservationResult, () => {
      const view = active;
      if (view === null || view.lease !== lease) return "ignored";
      const row = decodeReviewedBenefitView(payload);
      if (!current(view)) return "ignored";
      if (row === null || row.dataGeneration !== view.state.dataGeneration) { restart(view); return "invalid"; }
      if (!view.state.entries.some((entry) => entry.benefitId === row.benefitId)
        && view.state.entries.length >= MAX_REVIEWED_BENEFIT_ENTRIES) { restart(view); return "capacity"; }
      const before = view.state;
      view.state = reduceReviewedBenefitView(before, { type: "response", capturedScope: before.viewScope, payload: row });
      // Receipts/get lack a collection revision. Even unchanged/lower-revision
      // observations invalidate traversal; only a new lease may start it again.
      const changed = view.state !== before;
      return restart(view) ? changed ? "updated" : "unchanged" : "ignored";
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
  // Cached historical observations, not credentials or a freshness proof. No
  // clock checks/automatic fetch occur here. Returned objects cannot be erased.
  return Object.freeze({ getSnapshot: (): ReviewedBenefitListSnapshot | null => snapshot,
    activate, begin, settle, fail, cancel, observe, deactivate, dispose, subscribe });
}
export type ReviewedBenefitListOwner = ReturnType<typeof createReviewedBenefitListOwner>;
