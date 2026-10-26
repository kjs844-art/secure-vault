/**
 * One component-local workspace lifecycle. Supply a fresh bindingId after every
 * explicit view/session reopen. This is not authentication or route activation.
 * Keep the workspace stable and local to its owner, never an SSR singleton.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { normalizeReviewWorkspaceContext, type ReviewWorkspace, type ReviewWorkspaceLease,
  type ReviewWorkspaceSnapshot } from "../domain/review-client/workspace.ts";
import type { ReviewPrepareResult, ReviewExecuteResult } from "../domain/review-client/command-owner.ts";

export interface ReviewWorkspaceReactView {
  readonly snapshot: ReviewWorkspaceSnapshot | null;
  readonly prepare: (input: unknown) => ReviewPrepareResult;
  readonly execute: (command: unknown) => Promise<ReviewExecuteResult>;
  readonly release: (command: unknown) => void;
  readonly nextPage: () => Promise<ReviewExecuteResult | { readonly kind: "unavailable" }>;
  readonly cancelPreview: () => boolean;
  readonly cancelPage: () => boolean;
  readonly restartList: () => boolean;
  readonly clear: () => void;
}
interface Context {
  readonly workspace: ReviewWorkspace;
  readonly bindingId: string | null;
  readonly dataGeneration: number | null;
}
interface Lifetime {
  readonly context: Context;
  readonly lease: ReviewWorkspaceLease;
  active: boolean;
  stopTimer: (() => void) | null;
}
const serverSnapshot = (): null => null;
const MAX_EXPIRY_TICK_MS = 250;
const stale = (): ReviewExecuteResult => Object.freeze({ kind: "stale" });

export function useReviewWorkspace(workspace: ReviewWorkspace, expectedContext: unknown): ReviewWorkspaceReactView {
  const expected = normalizeReviewWorkspaceContext(expectedContext);
  const bindingId = expected?.bindingId ?? null, dataGeneration = expected?.dataGeneration ?? null;
  const context = useMemo(() => Object.freeze({ workspace, bindingId, dataGeneration }), [workspace, bindingId, dataGeneration]);
  const committed = useRef<Context | null>(null), lifetime = useRef<Lifetime | null>(null);
  const retiredContext = useRef<Context | null>(null);
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, serverSnapshot);

  // Rendering an abandoned/suspended B must not mutate still-committed A.
  // A committed replacement fences A's callbacks before passive activation.
  useLayoutEffect(() => {
    committed.current = context;
    return () => { if (committed.current === context) committed.current = null; };
  }, [context]);

  useEffect(() => {
    if (bindingId === null || dataGeneration === null || retiredContext.current === context) return;
    const lease = workspace.activate({ bindingId, dataGeneration });
    if (lease === null) return;
    const life: Lifetime = { context, lease, active: true, stopTimer: null };
    lifetime.current = life;
    const retire = () => {
      if (!life.active) return;
      life.active = false;
      life.stopTimer?.(); life.stopTimer = null;
      if (lifetime.current === life) lifetime.current = null;
      workspace.deactivate(lease);
    };
    let attached = true;
    const navigate = () => {
      if (!attached) return;
      // A document-wide hide also applies when B has committed its layout but
      // A's passive cleanup is still pending. Fence B's not-yet-started effect
      // without mutating anything during an abandoned B render.
      retiredContext.current = committed.current;
      if (!life.active || lifetime.current !== life) return;
      // Native events only: no flushSync from render/effect/subscription cleanup.
      flushSync(retire);
    };
    const hidden = () => { if (document.hidden) navigate(); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) navigate(); };
    window.addEventListener("pagehide", navigate);
    window.addEventListener("pageshow", restored);
    document.addEventListener("visibilitychange", hidden);
    if (document.hidden || committed.current !== context) retire();
    return () => {
      attached = false;
      window.removeEventListener("pagehide", navigate);
      window.removeEventListener("pageshow", restored);
      document.removeEventListener("visibilitychange", hidden);
      retire(); // StrictMode setup may follow; only the owning component disposes.
    };
  }, [workspace, context, bindingId, dataGeneration]);

  const life = lifetime.current;
  const visible = life?.active && life.context === context && snapshot?.lease === life.lease
    && snapshot.context.bindingId === bindingId && snapshot.context.dataGeneration === dataGeneration ? snapshot : null;
  const preview = visible?.preview ?? null;

  useEffect(() => {
    if (!life || !preview || preview.phase !== "ready" || !preview.preview) return;
    const shown = preview, expiresAt = preview.preview.expiresAt;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !stopped && life.active && lifetime.current === life && committed.current === context
      && workspace.getSnapshot()?.lease === life.lease && workspace.getSnapshot()?.preview === shown;
    const stop = () => { stopped = true; if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const tick = () => {
      timer = undefined;
      if (!current() || !workspace.checkExpiry(life.lease, shown) || !current()) return;
      // Schedule only; the workspace's validated clocks decide expiry and its
      // original deadline is never extended. Browser timers can be throttled.
      let remaining = NaN;
      try { remaining = expiresAt - Date.now(); } catch { /* Workspace clocks remain authoritative. */ }
      const delay = Number.isFinite(remaining) && remaining > 0
        ? Math.min(MAX_EXPIRY_TICK_MS, Math.max(1, remaining)) : MAX_EXPIRY_TICK_MS;
      timer = setTimeout(tick, delay);
    };
    life.stopTimer = stop;
    tick();
    return () => { stop(); if (life.stopTimer === stop) life.stopTimer = null; };
  }, [workspace, context, life, preview]);

  return useMemo(() => {
    const current = () => life !== null && life.active && lifetime.current === life && life.context === context
      && committed.current === context && workspace.getSnapshot()?.lease === life.lease;
    const displayed = () => current() && visible !== null && workspace.getSnapshot() === visible;
    return Object.freeze({
      snapshot: visible,
      prepare: (input: unknown): ReviewPrepareResult => {
        if (!displayed() || !life) return Object.freeze({ kind: "inactive" });
        const result = workspace.prepare(life.lease, input);
        return current() ? result : Object.freeze({ kind: "inactive" });
      },
      // Execution/release use the captured current lease, not a later render's
      // composite snapshot; command ownership remains the workspace's job.
      execute: async (command: unknown): Promise<ReviewExecuteResult> => {
        if (!current() || !life) return stale();
        const result = await workspace.execute(life.lease, command);
        return current() ? result : stale();
      },
      release: (command: unknown) => { if (current() && life) workspace.release(life.lease, command); },
      nextPage: async (): Promise<ReviewExecuteResult | { readonly kind: "unavailable" }> => {
        if (!displayed() || !life) return Object.freeze({ kind: "unavailable" });
        const result = await workspace.nextPage(life.lease);
        return current() ? result : stale();
      },
      cancelPreview: () => displayed() && life !== null && visible !== null && workspace.cancelPreview(life.lease, visible.preview),
      cancelPage: () => displayed() && life !== null && visible !== null && workspace.cancelPage(life.lease, visible.list),
      restartList: () => displayed() && life !== null && visible !== null && workspace.restartList(life.lease, visible.list),
      clear: () => {
        if (!displayed() || !life) return;
        life.active = false;
        life.stopTimer?.(); life.stopTimer = null;
        if (lifetime.current === life) lifetime.current = null;
        workspace.deactivate(life.lease);
      },
    });
  }, [workspace, context, life, visible]);
}

// Hide/pagehide can be skipped on crash; bounded foreground ticks are not a
// hard real-time guarantee. Returning visible/pageshow does not reopen anything.
// Auth owners must revoke synchronously, before delayed React transitions.
// Local clearing cannot retract returned objects or undo a committed server write.
