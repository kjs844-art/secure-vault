import type { SyntheticVaultSessionState } from "./SyntheticVaultSession";

export const VAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface LockableSession {
  readonly state: { readonly phase: SyntheticVaultSessionState["phase"] };
  subscribe(listener: () => void): () => void;
  lock(): void;
}

interface ClockSample { readonly wall: number; readonly monotonic: number }

export interface VaultAutoLockEnvironment {
  readonly document: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
  readonly window: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly clocks: () => ClockSample;
}

/** Local UI lifecycle policy, not authentication or a defense against same-origin JS. */
export function bindVaultAutoLock(
  session: LockableSession,
  environment: VaultAutoLockEnvironment = {
    document, window,
    clocks: () => ({ wall: Date.now(), monotonic: performance.now() }),
  },
): () => void {
  let disposed = false;
  let activity: ClockSample | null = null;
  let observed: ClockSample | null = null;
  const active = () => session.state.phase === "busy" || session.state.phase === "open";
  const lock = () => {
    activity = null;
    observed = null;
    if (!disposed) session.lock();
  };

  function sample(): ClockSample | null {
    try {
      const now = environment.clocks();
      if (!Number.isFinite(now.wall) || !Number.isFinite(now.monotonic)
          || (observed !== null && (now.wall < observed.wall || now.monotonic < observed.monotonic))) {
        lock();
        return null;
      }
      observed = { wall: now.wall, monotonic: now.monotonic };
      return observed;
    } catch {
      lock();
      return null;
    }
  }

  function check(): ClockSample | null {
    if (disposed) return null;
    if (!active()) { activity = null; observed = null; return null; }
    if (environment.document.hidden) { lock(); return null; }
    const now = sample();
    if (now === null) return null;
    if (activity === null) activity = now;
    // Either clock expiring is sufficient. Wall time covers platforms where
    // performance.now pauses during sleep. Never extend an expired session.
    if (now.wall - activity.wall >= VAULT_IDLE_TIMEOUT_MS
        || now.monotonic - activity.monotonic >= VAULT_IDLE_TIMEOUT_MS) {
      lock();
      return null;
    }
    return now;
  }

  const onActivity = (event: Event) => {
    const now = check();
    if (now !== null && event.isTrusted) activity = now;
  };
  const onVisibility = () => {
    if (environment.document.hidden) lock();
    else check();
  };
  const onResume = () => { check(); };
  const unsubscribe = session.subscribe(() => { check(); });
  environment.document.addEventListener("pointerdown", onActivity, true);
  environment.document.addEventListener("keydown", onActivity, true);
  environment.document.addEventListener("visibilitychange", onVisibility);
  environment.window.addEventListener("pagehide", lock);
  environment.window.addEventListener("pageshow", onResume);
  environment.window.addEventListener("focus", onResume);
  const timer = setInterval(check, 1000);
  check();

  return () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    unsubscribe();
    environment.document.removeEventListener("pointerdown", onActivity, true);
    environment.document.removeEventListener("keydown", onActivity, true);
    environment.document.removeEventListener("visibilitychange", onVisibility);
    environment.window.removeEventListener("pagehide", lock);
    environment.window.removeEventListener("pageshow", onResume);
    environment.window.removeEventListener("focus", onResume);
    activity = null;
    observed = null;
    session.lock();
  };
}
