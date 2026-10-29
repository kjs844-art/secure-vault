// Synthetic QA diagnostics only. No browser launch, process termination or raw
// exception inspection. All times use this process's monotonic clock in ms.
export const HISTORY_CLOSE_LIMIT_MS = 10_000;
export type HistoryClosePhase = "RUNNING" | "CONTEXT_CLOSE" | "BROWSER_CLOSE" | "SERVER_CLOSE" | "FINAL";
export type HistoryCloseOutcome = "NOT_STARTED" | "RESOLVED" | "REJECTED" | "DEADLINE" | "OBSERVATION_FAILED";
type Settlement = "NOT_CALLED" | "PENDING" | "RESOLVED" | "REJECTED";
export interface HistoryCloseBrowser {
  on(event: "disconnected", listener: () => void): unknown;
  off(event: "disconnected", listener: () => void): unknown;
  isConnected(): boolean;
  close(): Promise<unknown>;
}
export interface HistoryCloseSnapshot {
  readonly limitMs: number;
  readonly closeCalls: number;
  readonly observerStartedAtMs: number | null;
  readonly contextCloseStartedAtMs: number | null;
  readonly closeStartedAtMs: number | null;
  readonly boundaryAtMs: number | null;
  readonly serverCloseStartedAtMs: number | null;
  readonly outcome: HistoryCloseOutcome;
  readonly promiseOutcome: Settlement;
  readonly promiseSettledAtMs: number | null;
  readonly connectedBeforeClose: boolean | null;
  readonly connectedAtBoundary: boolean | null;
  readonly disconnectedEvents: number;
  readonly firstDisconnectedAtMs: number | null;
  readonly firstDisconnectedPhase: HistoryClosePhase | null;
  readonly listenerAttachFailed: boolean;
  readonly listenerDetachFailed: boolean;
  readonly connectionProbeFailed: boolean;
  readonly clockFailed: boolean;
  readonly passed: boolean;
}

export function createHistoryCloseObservation(browser: HistoryCloseBrowser, now: () => number = () => performance.now()) {
  let phase: HistoryClosePhase = "RUNNING", lastTime: number | null = null, clockFailed = false;
  function stamp(): number | null {
    try {
      const value = now();
      if (!Number.isFinite(value) || value < 0 || (lastTime !== null && value < lastTime)) throw undefined;
      lastTime = value;
      return value;
    } catch { clockFailed = true; return null; }
  }
  const observerStartedAtMs = stamp();
  let contextCloseStartedAtMs: number | null = null, serverCloseStartedAtMs: number | null = null;
  let closeStartedAtMs: number | null = null, boundaryAtMs: number | null = null;
  let outcome: HistoryCloseOutcome = "NOT_STARTED", promiseOutcome: Settlement = "NOT_CALLED";
  let promiseSettledAtMs: number | null = null, closeCalls = 0;
  let connectedBeforeClose: boolean | null = null, connectedAtBoundary: boolean | null = null;
  let disconnectedEvents = 0, firstDisconnectedAtMs: number | null = null;
  let firstDisconnectedPhase: HistoryClosePhase | null = null;
  let listenerAttachFailed = false, listenerDetachFailed = false, connectionProbeFailed = false;
  let disposed = false, boundaryPromise: Promise<HistoryCloseOutcome> | undefined;
  const disconnected = () => {
    if (disposed) return;
    disconnectedEvents++;
    if (firstDisconnectedPhase === null) {
      firstDisconnectedAtMs = stamp();
      firstDisconnectedPhase = phase;
    }
  };
  try { browser.on("disconnected", disconnected); } catch { listenerAttachFailed = true; }
  function probe(): boolean | null {
    try {
      const connected = browser.isConnected();
      if (typeof connected !== "boolean") throw undefined;
      return connected;
    } catch { connectionProbeFailed = true; return null; }
  }
  function setPhase(next: HistoryClosePhase) {
    phase = next;
    if (next === "CONTEXT_CLOSE") contextCloseStartedAtMs ??= stamp();
    if (next === "SERVER_CLOSE") serverCloseStartedAtMs ??= stamp();
  }
  function close(): Promise<HistoryCloseOutcome> {
    if (boundaryPromise) return boundaryPromise;
    // Publish the promise before calling any browser API, including a probe:
    // synchronous reentry can observe but never start a second close operation.
    let resolveBoundary!: (value: HistoryCloseOutcome) => void;
    boundaryPromise = new Promise((resolve) => { resolveBoundary = resolve; });
    phase = "BROWSER_CLOSE";
    closeStartedAtMs = stamp();
    connectedBeforeClose = probe();
    let finished = false, timer: ReturnType<typeof setTimeout> | undefined;
    function finish(value: HistoryCloseOutcome) {
      if (finished) return;
      finished = true;
      outcome = value;
      boundaryAtMs = stamp();
      clearTimeout(timer);
      connectedAtBoundary = probe();
      resolveBoundary(value);
    }
    function settled(value: "RESOLVED" | "REJECTED") {
      promiseOutcome = value;
      promiseSettledAtMs = stamp();
      // A late observation is useful evidence, never a replacement for DEADLINE.
      if (finished) return;
      if (clockFailed || closeStartedAtMs === null || promiseSettledAtMs === null) finish("OBSERVATION_FAILED");
      else if (promiseSettledAtMs - closeStartedAtMs >= HISTORY_CLOSE_LIMIT_MS) finish("DEADLINE");
      else finish(value);
    }
    timer = setTimeout(() => finish("DEADLINE"), HISTORY_CLOSE_LIMIT_MS);
    closeCalls++;
    promiseOutcome = "PENDING";
    try {
      // Both handlers consume late rejection without inspecting its value.
      void Promise.resolve(browser.close()).then(() => settled("RESOLVED"), () => settled("REJECTED"));
    } catch { settled("REJECTED"); }
    return boundaryPromise;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    // Also attempt removal if registration partially succeeded before throwing.
    try { browser.off("disconnected", disconnected); } catch { listenerDetachFailed = true; }
  }
  function snapshot(): HistoryCloseSnapshot {
    return Object.freeze({
      limitMs: HISTORY_CLOSE_LIMIT_MS, closeCalls, observerStartedAtMs, contextCloseStartedAtMs,
      closeStartedAtMs, boundaryAtMs, serverCloseStartedAtMs, outcome, promiseOutcome, promiseSettledAtMs,
      connectedBeforeClose, connectedAtBoundary, disconnectedEvents, firstDisconnectedAtMs,
      firstDisconnectedPhase, listenerAttachFailed, listenerDetachFailed, connectionProbeFailed, clockFailed,
      passed: outcome === "RESOLVED" && connectedAtBoundary === false && !listenerAttachFailed
        && !listenerDetachFailed && !connectionProbeFailed && !clockFailed,
    });
  }
  return Object.freeze({ setPhase, close, snapshot, dispose });
}
