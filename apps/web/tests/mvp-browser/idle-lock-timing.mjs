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

// Conservative DOM transition evidence, not an internal session-lock timestamp.
// The transition is observed between the last open and first locked samples.
// Although the open endpoint is excluded, retaining it as a lower bound cannot
// overstate elapsed time. Equal timestamps are valid for ordered observations
// from a coarsened clock; they do not establish an exact internal transition.
export function classifyIdleTransition(activityBefore, activityAfter, lastOpenAt, firstLockedAt, timeoutMs) {
  if (![activityBefore, activityAfter, lastOpenAt, firstLockedAt].every((value) => typeof value === "number"
      && Number.isFinite(value) && value >= 0)
    || activityBefore > activityAfter || activityAfter > lastOpenAt || lastOpenAt > firstLockedAt
    || typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("IDLE_TRANSITION_INVALID");
  }
  const minimumElapsedMs = lastOpenAt - activityAfter;
  const maximumElapsedMs = firstLockedAt - activityBefore;
  const state = minimumElapsedMs >= timeoutMs ? "reached"
    : maximumElapsedMs < timeoutMs ? "before" : "uncertain";
  return Object.freeze({ state, minimumElapsedMs, maximumElapsedMs });
}
