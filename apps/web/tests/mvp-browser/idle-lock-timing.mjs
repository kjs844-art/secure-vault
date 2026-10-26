// Pure timing evidence only: the product's last activity lies somewhere in the
// inclusive [before, after] observation interval. No clocks or browser imports.
export function classifyIdleTiming(before, after, observedAt, timeoutMs) {
  if (![before, after, observedAt].every((value) => typeof value === "number"
      && Number.isFinite(value) && value >= 0)
    || before > after || observedAt < after
    || typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("IDLE_TIMING_INVALID");
  }
  const minimumElapsedMs = observedAt - after;
  const maximumElapsedMs = observedAt - before;
  const state = minimumElapsedMs >= timeoutMs ? "reached"
    : maximumElapsedMs < timeoutMs ? "before" : "uncertain";
  return Object.freeze({ state, minimumElapsedMs, maximumElapsedMs });
}
