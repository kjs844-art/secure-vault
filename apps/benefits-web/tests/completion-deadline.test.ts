import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompletionDeadline } from "../src/components/review-workspace/completion-deadline.ts";

test("exact deadline fails even if its timer has not run and stays failed after the clock recovers", () => {
  let stamp = { wall: 100000, monotonic: 20 };
  const valid = createCompletionDeadline(() => stamp, 10000); assert.ok(valid);
  stamp = { wall: 109999, monotonic: 10019.5 }; assert.equal(valid(), true);
  stamp = { wall: 110000, monotonic: 10020 }; assert.equal(valid(), false);
  stamp = { wall: 100001, monotonic: 21 }; assert.equal(valid(), false);
});
for (const clock of ["wall", "monotonic"] as const) {
  test(`${clock} forward expiry alone invalidates the request`, () => {
    const stamp = { wall: 100000, monotonic: 20 };
    const valid = createCompletionDeadline(() => stamp, 10000); assert.ok(valid);
    stamp[clock] += 10000; assert.equal(valid(), false);
  });
  test(`${clock} backwards movement is sticky and detached from the input clock object`, () => {
    const stamp = { wall: 100000, monotonic: 20 };
    const valid = createCompletionDeadline(() => stamp, 10000); assert.ok(valid);
    stamp[clock]--; assert.equal(valid(), false);
    stamp[clock]++; assert.equal(valid(), false);
  });
}
test("invalid initial and later clock samples fail closed without exposing thrown values", () => {
  for (const wall of [NaN, Infinity, -1, -0, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(createCompletionDeadline(() => ({ wall, monotonic: 1 }), 10000), null);
  for (const monotonic of [NaN, Infinity, -1, -0])
    assert.equal(createCompletionDeadline(() => ({ wall: 100000, monotonic }), 10000), null);
  let broken = false;
  const valid = createCompletionDeadline(() => { if (broken) throw Error("SYNTHETIC_PRIVATE");
    return { wall: 100000, monotonic: 1 }; }, 10000); assert.ok(valid);
  broken = true; assert.equal(valid(), false); broken = false; assert.equal(valid(), false);
});
test("invalid budgets never sample the clock", () => {
  for (const ms of [0, -1, -0, NaN, Infinity, 0.5])
    assert.equal(createCompletionDeadline(() => { throw Error("NO_CLOCK_READ"); }, ms), null);
});
