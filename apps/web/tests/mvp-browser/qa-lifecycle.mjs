import { performance } from "node:perf_hooks";

/**
 * Node-side deadlines for this runner's owned synthetic QA resources only.
 * These bound waiting, not the underlying operation: AbortSignal is cooperative,
 * synchronous event-loop blocking cannot be interrupted, and a timed-out cleanup
 * is NOT confirmed cleanup. Callers must stop subsequent work and report failure.
 */
function validate(callback, timeoutMs) {
  if (typeof callback !== "function" || !Number.isInteger(timeoutMs)
      || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError("QA_LIFECYCLE_CONFIG");
}

/** Abort before rejecting; even an abort-triggered success cannot beat timeout. */
export function withDeadline(task, timeoutMs) {
  validate(task, timeoutMs);
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let timer;
  const result = new Promise((resolve, reject) => {
    let settled = false;
    const expire = () => {
      if (settled) return;
      // Claim the outcome before notifying task code, which may resolve/reject.
      settled = true;
      controller.abort();
      reject(new Error("QA_DEADLINE"));
    };
    timer = setTimeout(expire, timeoutMs);
    try {
      Promise.resolve(task(controller.signal)).then(
        (value) => {
          if (settled) return;
          // Microtasks can run before a delayed timer callback. Never accept
          // success after the monotonic deadline merely because that timer waits.
          if (performance.now() >= deadline) { expire(); return; }
          settled = true;
          resolve(value);
        },
        (error) => {
          if (settled) return;
          if (performance.now() >= deadline) { expire(); return; }
          settled = true;
          reject(error);
        },
      );
    } catch (error) {
      if (performance.now() >= deadline) { expire(); return; }
      settled = true;
      reject(error);
    }
  });
  return result.finally(() => clearTimeout(timer));
}

/**
 * Acquire only a resource newly owned by this call. A resource arriving after
 * timeout is never returned to the caller; dispose(resource, signal) is attempted
 * once under a separate deadline. Late disposal is best-effort, not a guarantee
 * of cancellation or release, and its failure is consumed without raw logging.
 * Never use this helper to attach to or terminate an existing user resource.
 */
export function acquireOwned(factory, dispose, timeoutMs) {
  validate(factory, timeoutMs);
  validate(dispose, timeoutMs);
  let acquired = false;
  let resource;
  let acquisitionSignal;
  let disposalAttempted = false;
  const disposeOnce = () => {
    if (!acquired || disposalAttempted) return;
    disposalAttempted = true;
    // Both rejection and non-settlement are bounded; do not await late cleanup.
    void withDeadline((cleanupSignal) => dispose(resource, cleanupSignal), timeoutMs).catch(() => {});
  };
  const acquisition = withDeadline(async (signal) => {
    acquisitionSignal = signal;
    resource = await factory(signal);
    acquired = true;
    if (signal.aborted) {
      disposeOnce();
      return undefined;
    }
    return resource;
  }, timeoutMs);
  return acquisition.catch((error) => {
    // The factory may have produced its resource before the fulfillment-time
    // deadline check aborted it. Share the same guard with the late-factory path.
    if (acquisitionSignal?.aborted) disposeOnce();
    throw error;
  });
}
