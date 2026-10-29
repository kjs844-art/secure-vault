// Synthetic QA diagnostics only. No browser launch, process termination, raw
// exception inspection, environment values or filesystem paths are recorded.
// All timestamps use this process's monotonic clock in milliseconds.
export const IDENTITY_CLOSE_LIMIT_MS = 10_000;
const IDENTITY_CLOSE_PHASES = new Set(["RUNNING", "CONTEXT_CLOSE", "BROWSER_CLOSE", "SERVER_CLOSE", "FINAL"]);

export function createIdentityCloseObservation(browser, now = () => performance.now()) {
  let phase = "RUNNING", lastTime = null, clockFailed = false, phaseFailed = false;
  function stamp() {
    try {
      const value = now();
      if (!Number.isFinite(value) || value < 0 || (lastTime !== null && value < lastTime)) throw undefined;
      lastTime = value;
      return value;
    } catch {
      clockFailed = true;
      return null;
    }
  }

  const observerStartedAtMs = stamp();
  let contextCloseStartedAtMs = null, serverCloseStartedAtMs = null;
  let closeStartedAtMs = null, boundaryAtMs = null;
  let outcome = "NOT_STARTED", promiseOutcome = "NOT_CALLED", promiseSettledAtMs = null, closeCalls = 0;
  let connectedBeforeClose = null, connectedAtBoundary = null;
  let disconnectedEvents = 0, firstDisconnectedAtMs = null, firstDisconnectedPhase = null;
  let listenerAttachFailed = false, listenerDetachFailed = false, connectionProbeFailed = false;
  let disposed = false, boundaryPromise;

  const disconnected = () => {
    if (disposed) return;
    disconnectedEvents++;
    if (firstDisconnectedPhase === null) {
      firstDisconnectedAtMs = stamp();
      firstDisconnectedPhase = phase;
    }
  };
  try { browser.on("disconnected", disconnected); } catch { listenerAttachFailed = true; }

  function probe() {
    try {
      const connected = browser.isConnected();
      if (typeof connected !== "boolean") throw undefined;
      return connected;
    } catch {
      connectionProbeFailed = true;
      return null;
    }
  }

  function setPhase(next) {
    if (!IDENTITY_CLOSE_PHASES.has(next)) { phaseFailed = true; return; }
    phase = next;
    if (next === "CONTEXT_CLOSE") contextCloseStartedAtMs ??= stamp();
    if (next === "SERVER_CLOSE") serverCloseStartedAtMs ??= stamp();
  }

  function close() {
    if (boundaryPromise) return boundaryPromise;
    // Publish before invoking browser APIs so reentry cannot trigger a second close.
    let resolveBoundary;
    boundaryPromise = new Promise((resolve) => { resolveBoundary = resolve; });
    phase = "BROWSER_CLOSE";
    closeStartedAtMs = stamp();
    connectedBeforeClose = probe();
    let finished = false, timer;

    function finish(value) {
      if (finished) return;
      finished = true;
      outcome = value;
      boundaryAtMs = stamp();
      clearTimeout(timer);
      connectedAtBoundary = probe();
      resolveBoundary(value);
    }

    function settled(value) {
      promiseOutcome = value;
      promiseSettledAtMs = stamp();
      // A late settlement remains evidence and can never replace DEADLINE.
      if (finished) return;
      if (clockFailed || closeStartedAtMs === null || promiseSettledAtMs === null) finish("OBSERVATION_FAILED");
      else if (promiseSettledAtMs - closeStartedAtMs >= IDENTITY_CLOSE_LIMIT_MS) finish("DEADLINE");
      else finish(value);
    }

    timer = setTimeout(() => finish("DEADLINE"), IDENTITY_CLOSE_LIMIT_MS);
    closeCalls++;
    promiseOutcome = "PENDING";
    try {
      // Both handlers consume an opaque late rejection without reading its value.
      void Promise.resolve(browser.close()).then(() => settled("RESOLVED"), () => settled("REJECTED"));
    } catch {
      settled("REJECTED");
    }
    return boundaryPromise;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try { browser.off("disconnected", disconnected); } catch { listenerDetachFailed = true; }
  }

  function snapshot() {
    return Object.freeze({
      limitMs: IDENTITY_CLOSE_LIMIT_MS,
      closeCalls,
      observerStartedAtMs,
      contextCloseStartedAtMs,
      closeStartedAtMs,
      boundaryAtMs,
      serverCloseStartedAtMs,
      outcome,
      promiseOutcome,
      promiseSettledAtMs,
      connectedBeforeClose,
      connectedAtBoundary,
      disconnectedEvents,
      firstDisconnectedAtMs,
      firstDisconnectedPhase,
      listenerAttachFailed,
      listenerDetachFailed,
      connectionProbeFailed,
      clockFailed,
      phaseFailed,
      passed: outcome === "RESOLVED" && connectedAtBoundary === false && !listenerAttachFailed
        && !listenerDetachFailed && !connectionProbeFailed && !clockFailed && !phaseFailed,
    });
  }

  return Object.freeze({ setPhase, close, snapshot, dispose });
}
