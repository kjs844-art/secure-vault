/**
 * Explicit, lease-bound page traversal. No automatic fetch/retry, raw cursor
 * input, authentication, persistence, UI mounting or full-snapshot guarantee.
 * Render rows from the store, never from traversal results. A terminal cursor
 * only means this traversal observed an end, not that all data is still fresh.
 */
import { createCatalogListRequest } from "./requests.ts";
import type { CatalogCursorView } from "./responses.ts";
import type { CatalogViewCommand } from "./view-controller.ts";
import type { CatalogViewLease, CatalogViewStore } from "./view-store.ts";

// Deliberately fixed, matching the existing wire page limit and 1,000-observation
// store bound. Tombstones/other observations can require stopping earlier.
export const CATALOG_PAGE_SIZE = 50;
export const MAX_CATALOG_SESSION_PAGES = 20;
export type CatalogPagePhase = "ready" | "loading" | "more" | "retry_required"
  | "restart_required" | "end_observed";
export interface CatalogPageProgress {
  readonly phase: CatalogPagePhase;
  readonly pagesAccepted: number;
  /** Rows seen in accepted traversal pages, not current unique/live row count. */
  readonly pageRowsObserved: number;
}
export type CatalogPageStepResult =
  | { readonly kind: "page"; readonly progress: CatalogPageProgress }
  | { readonly kind: "busy" | "inactive" | "disposed" | "retry_required" | "restart_required" | "end_observed" };

export function createCatalogPageSession(store: CatalogViewStore, lease: CatalogViewLease) {
  let progress: CatalogPageProgress = Object.freeze({ phase: "ready", pagesAccepted: 0, pageRowsObserved: 0 });
  let cursor: CatalogCursorView | null = null;
  let catalogRevision: number | null = null;
  let running = false;
  let disposed = false;
  let ownedCommand: CatalogViewCommand | null = null;

  function current() {
    const snapshot = store.getSnapshot();
    return !disposed && snapshot !== null && snapshot.lease === lease ? snapshot : null;
  }
  function setPhase(phase: CatalogPagePhase): void {
    if (progress.phase !== phase) progress = Object.freeze({ ...progress, phase });
  }
  function restartRequired(): CatalogPageStepResult {
    cursor = null;
    setPhase("restart_required");
    return Object.freeze({ kind: "restart_required" });
  }
  function invalidated(): CatalogPageStepResult {
    return Object.freeze({ kind: disposed ? "disposed" : "inactive" });
  }
  async function next(): Promise<CatalogPageStepResult> {
    const before = current();
    if (before === null) return invalidated();
    if (running) return Object.freeze({ kind: "busy" });
    // This adapter never clears refreshRequired or owns a store/lease reset.
    // The lifecycle owner must explicitly establish a fresh traversal context.
    if (before.state.refreshRequired || progress.phase === "restart_required"
      || (catalogRevision !== null && before.state.catalogRevision !== catalogRevision)) return restartRequired();
    if (progress.phase === "end_observed") return Object.freeze({ kind: "end_observed" });
    if (progress.pagesAccepted >= MAX_CATALOG_SESSION_PAGES) return restartRequired();
    running = true;
    setPhase("loading");
    let preparedCommand: CatalogViewCommand | null = null;
    try {
      // No caller can supply or relabel a cursor from another view/session.
      const prepared = store.prepare(lease, createCatalogListRequest(CATALOG_PAGE_SIZE, cursor));
      if (prepared.kind === "prepared") preparedCommand = prepared.command;
      if (current() === null) return invalidated();
      if (prepared.kind !== "prepared") {
        setPhase("retry_required");
        return Object.freeze({ kind: "retry_required" });
      }
      ownedCommand = prepared.command;
      const result = await store.execute(lease, prepared.command);
      const after = current();
      if (after === null) return invalidated();
      if (after.state.refreshRequired || (catalogRevision !== null
        && after.state.catalogRevision !== catalogRevision)
        || (result.kind === "error" && result.code === "API_CONFLICT")) return restartRequired();
      if (result.kind !== "success" || result.success.kind !== "page") {
        setPhase("retry_required");
        return Object.freeze({ kind: "retry_required" });
      }
      const page = result.success.page;
      if (result.capturedScope.viewScope !== after.state.viewScope
        || result.capturedScope.dataGeneration !== after.state.dataGeneration
        || page.dataGeneration !== after.state.dataGeneration
        || after.state.catalogRevision !== page.catalogRevision) return restartRequired();
      // The underlying request-correlated decoder already enforces ordered IDs,
      // cursor advancement, generation/revision equality and a maximum of 50.
      catalogRevision = page.catalogRevision;
      cursor = page.nextCursor;
      const pagesAccepted = progress.pagesAccepted + 1;
      const phase = cursor === null ? "end_observed"
        : pagesAccepted === MAX_CATALOG_SESSION_PAGES ? "restart_required" : "more";
      progress = Object.freeze({ phase, pagesAccepted,
        pageRowsObserved: progress.pageRowsObserved + page.services.length });
      if (phase === "restart_required") return restartRequired();
      return Object.freeze({ kind: "page", progress });
    } catch {
      // Do not echo unexpected adapter exceptions or publish across a reset.
      const after = current();
      if (after === null) return invalidated();
      if (after.state.refreshRequired || (catalogRevision !== null
        && after.state.catalogRevision !== catalogRevision)) return restartRequired();
      setPhase("retry_required");
      return Object.freeze({ kind: "retry_required" });
    } finally {
      // Release after every attempt, including explicit retry/failure. A list
      // retry creates a new command with the same unchanged internal cursor.
      if (preparedCommand !== null) store.release(lease, preparedCommand);
      if (ownedCommand === preparedCommand) ownedCommand = null;
      running = false;
    }
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    cursor = null;
    const command = ownedCommand;
    ownedCommand = null;
    if (command !== null) store.release(lease, command);
  }
  // No subscription or controller is created here. Old progress references are
  // historical observations; this getter hides them after lease invalidation.
  return Object.freeze({ getSnapshot: (): CatalogPageProgress | null => current() === null ? null : progress,
    next, dispose });
}

export type CatalogPageSession = ReturnType<typeof createCatalogPageSession>;
