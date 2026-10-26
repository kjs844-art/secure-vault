/**
 * Explicit bounded service selection source, composed from the existing catalog
 * store and page session. The external lease is an identity, not authentication.
 * The host must deactivate it synchronously with its review workspace. This
 * owner never calls that workspace, starts a request automatically, or certifies
 * a complete/current catalog. Returned historical references are not revocable.
 */
import type { CatalogCallFailure } from "./client.ts";
import { createCatalogPageSession, type CatalogPagePhase, type CatalogPageSession } from "./page-session.ts";
import type { CatalogServiceView } from "./responses.ts";
import type { CatalogViewControllerConfig } from "./view-controller.ts";
import { createCatalogViewStore, normalizeCatalogBindingContext,
  type CatalogBindingContext, type CatalogViewLease } from "./view-store.ts";

export interface CatalogSelectionSnapshot {
  readonly lease: object;
  readonly context: CatalogBindingContext;
  readonly phase: CatalogPagePhase;
  readonly pagesAccepted: number;
  readonly pageRowsObserved: number;
  readonly services: readonly CatalogServiceView[];
  readonly failure: CatalogCallFailure | null;
}
export interface CatalogSelectionBinding { readonly lease: object; readonly context: CatalogBindingContext }
interface Frame {
  readonly lease: object;
  readonly context: CatalogBindingContext;
  readonly catalogLease: CatalogViewLease;
  page: CatalogPageSession;
  operation: object | null;
  failure: CatalogCallFailure | null;
}
const EMPTY: readonly CatalogServiceView[] = Object.freeze([]);

function binding(input: unknown): CatalogSelectionBinding | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const fields = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(fields);
    if (keys.length !== 2 || !keys.includes("lease") || !keys.includes("context")) return null;
    const lease = fields.lease, context = fields.context;
    if (!lease?.enumerable || !context?.enumerable || !Object.hasOwn(lease, "value")
      || !Object.hasOwn(context, "value") || typeof lease.value !== "object"
      || lease.value === null || Array.isArray(lease.value)) return null;
    const normalized = normalizeCatalogBindingContext(context.value);
    return normalized === null ? null : Object.freeze({ lease: lease.value as object, context: normalized });
  } catch { return null; }
}

export function createCatalogSelectionSource(config: CatalogViewControllerConfig) {
  // Store construction is inert: no UUID, clocks, request or subscription.
  const store = createCatalogViewStore(config);
  let frame: Frame | null = null, snapshot: CatalogSelectionSnapshot | null = null;
  let disposed = false, transitionDepth = 0;
  let activation: { previousLease: object | null; cancelled: boolean } | null = null;
  const listeners = new Set<() => void>();
  const current = (value: Frame): boolean => !disposed && frame === value;
  function notify(): void {
    transitionDepth++;
    try { for (const listener of [...listeners]) if (listeners.has(listener)) {
      try { listener(); } catch { /* Observer errors must not block revocation. */ }
    } } finally { transitionDepth--; }
  }
  function publish(value: Frame, phase: CatalogPagePhase, pagesAccepted: number, pageRowsObserved: number): boolean {
    if (!current(value)) return false;
    const state = store.getSnapshot();
    if (state?.lease !== value.catalogLease) return false;
    // Pending or uncertain traversal observations cannot mint a new draft.
    // Tombstones remain in the store and are not dropped from accepted sources.
    const services = phase === "more" || phase === "end_observed" ? state.state.entries : EMPTY;
    const next = Object.freeze({ lease: value.lease, context: value.context, phase,
      pagesAccepted, pageRowsObserved, services, failure: value.failure });
    snapshot = next; notify();
    return current(value) && snapshot === next;
  }
  function revoke(): void {
    const old = frame, changed = snapshot !== null;
    frame = null; snapshot = null;
    if (old) old.operation = null;
    if (changed) notify();
    if (old) { old.page.dispose(); store.deactivate(old.catalogLease); }
  }
  function activate(input: unknown): CatalogSelectionSnapshot | null {
    if (disposed || transitionDepth > 0) return null;
    const attempt = { previousLease: frame?.lease ?? null, cancelled: false };
    activation = attempt; transitionDepth++;
    try {
      revoke();
      const normalized = binding(input);
      if (!normalized || disposed || attempt.cancelled) return null;
      const catalogLease = store.activate(normalized.context);
      if (catalogLease === null) return null;
      if (disposed || attempt.cancelled) { store.deactivate(catalogLease); return null; }
      // The wrapper observes the fixed transport failure before the page session
      // deliberately compresses it to retry/restart. It does not alter results.
      const pageStore = Object.freeze({ ...store, execute: async (lease: unknown, command: unknown) => {
        const result = await store.execute(lease, command);
        if (current(value) && result.kind !== "success") value.failure = result;
        return result;
      } });
      const value: Frame = { ...normalized, catalogLease, page: createCatalogPageSession(pageStore, catalogLease),
        operation: null, failure: null };
      frame = value;
      return publish(value, "ready", 0, 0) ? snapshot : null;
    } finally { if (activation === attempt) activation = null; transitionDepth--; }
  }
  async function next(expected: CatalogSelectionSnapshot): Promise<boolean> {
    if (disposed || transitionDepth > 0 || snapshot !== expected || frame === null || frame.operation !== null
      || !["ready", "more", "retry_required"].includes(expected.phase)) return false;
    const value = frame, operation = {};
    value.operation = operation; value.failure = null;
    transitionDepth++;
    try {
      if (!publish(value, "loading", expected.pagesAccepted, expected.pageRowsObserved)
        || !current(value) || value.operation !== operation) return false;
    } finally { transitionDepth--; }
    await value.page.next();
    if (!current(value) || value.operation !== operation) return false;
    transitionDepth++;
    try {
      value.operation = null;
      const progress = value.page.getSnapshot();
      if (progress === null) return false;
      return publish(value, progress.phase, progress.pagesAccepted, progress.pageRowsObserved);
    } finally { transitionDepth--; }
  }
  function restart(expected: CatalogSelectionSnapshot): CatalogSelectionSnapshot | null {
    if (disposed || transitionDepth > 0 || snapshot !== expected || frame === null) return null;
    return activate({ lease: frame.lease, context: frame.context });
  }
  function cancel(expected: CatalogSelectionSnapshot): boolean {
    if (disposed || snapshot !== expected || frame === null || expected.phase === "restart_required") return false;
    const value = frame;
    transitionDepth++;
    try {
      value.operation = null; value.failure = null;
      // Revoke logical ownership before abort listeners can reenter. Retain the
      // store's revision/tombstone fences until an explicit fresh traversal.
      const accepted = publish(value, "restart_required", expected.pagesAccepted, expected.pageRowsObserved);
      value.page.dispose();
      return accepted;
    } finally { transitionDepth--; }
  }
  function deactivate(lease: object): void {
    if (activation?.previousLease === lease) activation.cancelled = true;
    if (frame?.lease !== lease) return;
    transitionDepth++;
    try { revoke(); } finally { transitionDepth--; }
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (activation) activation.cancelled = true;
    transitionDepth++;
    try { revoke(); store.dispose(); listeners.clear(); } finally { transitionDepth--; }
  }
  return Object.freeze({ activate, next, restart, cancel, deactivate, dispose,
    getSnapshot: (): CatalogSelectionSnapshot | null => snapshot,
    subscribe(listener: () => void): () => void {
      if (disposed || typeof listener !== "function") return () => {};
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
  });
}
export type CatalogSelectionSource = ReturnType<typeof createCatalogSelectionSource>;
