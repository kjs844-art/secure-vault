/** A display request budget, not server authorization or a storage TTL. Timers
 * alone are insufficient: a promise microtask can run before an overdue timer. */
export function createCompletionDeadline(clocks: () => { wall: number; monotonic: number }, budgetMs: number): (() => boolean) | null {
  function read() {
    const stamp = clocks();
    if (!Number.isSafeInteger(stamp.wall) || stamp.wall < 0 || Object.is(stamp.wall, -0)
      || !Number.isFinite(stamp.monotonic) || stamp.monotonic < 0 || Object.is(stamp.monotonic, -0)) throw Error("COMPLETION_CLOCK");
    return { wall: stamp.wall, monotonic: stamp.monotonic };
  }
  try {
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1) return null;
    const start = read(); let last = start, valid = true;
    return () => {
      if (!valid) return false;
      try {
        const now = read();
        valid = now.wall >= last.wall && now.monotonic >= last.monotonic
          && now.wall - start.wall < budgetMs && now.monotonic - start.monotonic < budgetMs;
        last = now;
      } catch { valid = false; }
      return valid;
    };
  } catch { return null; }
}
