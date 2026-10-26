/**
 * One lifecycle owner per store. The caller supplies a fresh opaque bindingId
 * after each verified session/view transition; this hook is NOT authentication.
 * Keep the store stable for that owner, never a shared SSR/module singleton.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { CatalogCallResult } from "../domain/catalog-client/client.ts";
import type { CatalogPrepareResult, CatalogViewCommand } from "../domain/catalog-client/view-controller.ts";
import { normalizeCatalogBindingContext, type CatalogViewStore } from "../domain/catalog-client/view-store.ts";
import type { CatalogViewState } from "../domain/catalog-client/view-state.ts";

export interface CatalogReactView {
  readonly state: CatalogViewState | null;
  readonly prepare: (input: unknown) => CatalogPrepareResult;
  readonly execute: (command: CatalogViewCommand) => Promise<CatalogCallResult>;
  readonly release: (command: CatalogViewCommand) => void;
  readonly clear: () => void;
}

const serverSnapshot = (): null => null;

export function useCatalogView(store: CatalogViewStore, expectedContext: unknown): CatalogReactView {
  const expected = normalizeCatalogBindingContext(expectedContext);
  // Primitive dependencies avoid a reset merely because the caller recreates
  // the same context object. A fresh bindingId is required for a new session.
  const bindingId = expected?.bindingId ?? null;
  const dataGeneration = expected?.dataGeneration ?? null;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, serverSnapshot);

  useEffect(() => {
    if (bindingId === null || dataGeneration === null) return;
    const lease = store.activate({ bindingId, dataGeneration });
    if (lease === null) return;
    const invalidateForNavigation = () => {
      // Native lifecycle callbacks only: flush the DOM before bfcache freezes
      // the document. Never flushSync from render or an effect cleanup.
      flushSync(() => store.deactivate(lease));
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) invalidateForNavigation();
    };
    window.addEventListener("pagehide", invalidateForNavigation);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", invalidateForNavigation);
      window.removeEventListener("pageshow", onPageShow);
      // StrictMode may set up again. Only the explicit store owner disposes it.
      store.deactivate(lease);
    };
  }, [store, bindingId, dataGeneration]);

  // Mask on render, not only after passive-effect cleanup. No old row is
  // rendered while a new/null/invalid expected context is being committed.
  const visible = snapshot !== null && snapshot.context.bindingId === bindingId
    && snapshot.context.dataGeneration === dataGeneration ? snapshot : null;
  return useMemo(() => {
    const lease = visible?.lease ?? null;
    return Object.freeze({
      state: visible?.state ?? null,
      prepare: (input: unknown): CatalogPrepareResult => lease === null
        ? Object.freeze({ kind: "inactive" }) : store.prepare(lease, input),
      execute: (command: CatalogViewCommand): Promise<CatalogCallResult> => lease === null
        ? Promise.resolve(Object.freeze({ kind: "stale" })) : store.execute(lease, command),
      release: (command: CatalogViewCommand): void => { if (lease !== null) store.release(lease, command); },
      clear: (): void => { if (lease !== null) store.deactivate(lease); },
    });
  }, [store, visible]);
}

// A pagehide is not guaranteed on process/device termination. This only fences
// the mounted view: it cannot revoke already returned JS references or undo a
// server commit. The auth owner must synchronously deactivate its lease when
// auth changes, before scheduling React work. No pageshow auto-activation/retry.
