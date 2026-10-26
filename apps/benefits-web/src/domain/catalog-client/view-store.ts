/**
 * Inert, instance-local subscription adapter. A binding identifies one UI
 * session, not an account proof. Its owner supplies a fresh binding on every
 * authentication/session recreation; no authentication or persistence here.
 */
import type { CatalogCallResult } from "./client.ts";
import { createCatalogViewController, type CatalogPrepareResult,
  type CatalogViewControllerConfig } from "./view-controller.ts";
import type { CatalogViewState } from "./view-state.ts";

export interface CatalogBindingContext {
  readonly bindingId: string;
  readonly dataGeneration: number;
}
declare const leaseBrand: unique symbol;
export type CatalogViewLease = { readonly [leaseBrand]: true };
export type CatalogViewStoreSnapshot = Readonly<{
  lease: CatalogViewLease;
  context: CatalogBindingContext;
  state: CatalogViewState;
}> | null;

/** Exact plain own data only. Reflection traps may run, but ordinary getters do not. */
export function normalizeCatalogBindingContext(input: unknown): CatalogBindingContext | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const fields = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(fields);
    if (keys.length !== 2 || !keys.includes("bindingId") || !keys.includes("dataGeneration")) return null;
    const binding = fields.bindingId;
    const generation = fields.dataGeneration;
    if (!binding?.enumerable || !generation?.enumerable
      || !Object.hasOwn(binding, "value") || !Object.hasOwn(generation, "value")) return null;
    const bindingId: unknown = binding.value;
    const dataGeneration: unknown = generation.value;
    if (typeof bindingId !== "string" || bindingId.trim() !== bindingId
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(bindingId)
      || typeof dataGeneration !== "number" || !Number.isSafeInteger(dataGeneration)
      || dataGeneration < 1) return null;
    return Object.freeze({ bindingId, dataGeneration });
  } catch { return null; }
}

export function createCatalogViewStore(config: CatalogViewControllerConfig) {
  // Deliberately no UUID generation, transport, or subscription on construction.
  // The operator owns this fixed config; replacing it requires a separate store.
  let controller: ReturnType<typeof createCatalogViewController> | null = null;
  let snapshot: CatalogViewStoreSnapshot = null;
  let disposed = false;
  let transitionDepth = 0;
  let transitionLease: CatalogViewLease | null = null;
  let revision: object = {};
  const listeners = new Set<() => void>();

  function current(lease: unknown): boolean {
    return !disposed && snapshot !== null && snapshot.lease === lease;
  }
  function notify(): void {
    // Subscribers may revoke/dispose, but may not resurrect a view mid-notify.
    transitionDepth++;
    try {
      for (const listener of [...listeners]) {
        if (listeners.has(listener)) {
          try { listener(); } catch { /* One observer cannot block revocation. */ }
        }
      }
    } finally { transitionDepth--; }
  }
  function subscribe(listener: () => void): () => void {
    if (disposed || typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  function deactivate(lease: unknown): void {
    if (disposed || (lease !== transitionLease && !current(lease)) || lease === null) return;
    revision = {};
    transitionLease = null;
    const changed = snapshot !== null;
    snapshot = null;
    transitionDepth++;
    try {
      controller?.clear(); // Already invisible and revoked when abort callbacks run.
      if (changed) notify();
    } finally { transitionDepth--; }
  }
  function activate(input: unknown): CatalogViewLease | null {
    if (disposed || transitionDepth > 0) return null;
    const captured = {};
    revision = captured;
    transitionLease = snapshot?.lease ?? null;
    const changed = snapshot !== null;
    snapshot = null;
    transitionDepth++;
    try {
      controller?.clear();
      if (changed) notify();
      if (disposed || revision !== captured) return null;
      const context = normalizeCatalogBindingContext(input);
      if (context === null || disposed || revision !== captured) return null;
      if (controller === null) {
        try {
          const created = createCatalogViewController(config);
          if (disposed || revision !== captured) { created.dispose(); return null; }
          controller = created;
        } catch { return null; }
      }
      if (controller.reset(context.dataGeneration).kind !== "active"
        || disposed || revision !== captured) return null;
      const state = controller.snapshot();
      if (state === null) return null;
      const lease = Object.freeze({}) as CatalogViewLease;
      transitionLease = lease;
      snapshot = Object.freeze({ lease, context, state });
      notify();
      return current(lease) && revision === captured ? lease : null;
    } finally {
      transitionLease = null;
      transitionDepth--;
    }
  }
  function prepare(lease: unknown, input: unknown): CatalogPrepareResult {
    if (disposed) return Object.freeze({ kind: "disposed" });
    if (!current(lease) || transitionDepth > 0 || controller === null) return Object.freeze({ kind: "inactive" });
    const result = controller.prepare(input);
    if (disposed) return Object.freeze({ kind: "disposed" });
    return current(lease) ? result : Object.freeze({ kind: "inactive" });
  }
  async function execute(lease: unknown, command: unknown): Promise<CatalogCallResult> {
    if (!current(lease) || transitionDepth > 0 || controller === null) return Object.freeze({ kind: "stale" });
    const result = await controller.execute(command);
    if (!current(lease) || snapshot === null) return Object.freeze({ kind: "stale" });
    const state = controller.snapshot();
    if (state !== null && state !== snapshot.state) {
      snapshot = Object.freeze({ lease: snapshot.lease, context: snapshot.context, state });
      notify();
    }
    return current(lease) ? result : Object.freeze({ kind: "stale" });
  }
  function release(lease: unknown, command: unknown): void {
    if (current(lease) && transitionDepth === 0) controller?.release(command);
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    revision = {};
    transitionLease = null;
    const changed = snapshot !== null;
    snapshot = null;
    try {
      controller?.dispose();
      if (changed) notify();
    } finally { listeners.clear(); }
  }
  // Render only this cached immutable snapshot. Per-call results are not the
  // latest-state authority, and previously returned objects cannot be revoked.
  return Object.freeze({ getSnapshot: (): CatalogViewStoreSnapshot => snapshot, subscribe,
    activate, deactivate, prepare, execute, release, dispose });
}

export type CatalogViewStore = ReturnType<typeof createCatalogViewStore>;
