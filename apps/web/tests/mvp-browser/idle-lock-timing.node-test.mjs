import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyIdleTiming } from "./idle-lock-timing.mjs";

for (const [name, before, after, observed, timeout, expected] of [
  ["single instant before threshold", 100, 100, 109, 10, ["before", 9, 9]],
  ["single instant exactly threshold", 100, 100, 110, 10, ["reached", 10, 10]],
  ["single instant beyond threshold", 100, 100, 111, 10, ["reached", 11, 11]],
  ["entire interval before threshold", 100, 102, 109, 10, ["before", 7, 9]],
  ["upper bound exactly threshold is uncertain", 100, 102, 110, 10, ["uncertain", 8, 10]],
  ["interval straddles threshold", 100, 102, 111, 10, ["uncertain", 9, 11]],
  ["lower bound exactly threshold is reached", 100, 102, 112, 10, ["reached", 10, 12]],
  ["entire interval beyond threshold", 100, 102, 113, 10, ["reached", 11, 13]],
  ["observation at activity interval end", 0, 2, 2, 3, ["before", 0, 2]],
  ["zero-length zero-origin interval", 0, 0, 0, 1, ["before", 0, 0]],
  ["fractional timestamps and threshold", 0.25, 0.5, 1, 0.5, ["reached", 0.5, 0.75]],
]) {
  test(name, () => {
    const result = classifyIdleTiming(before, after, observed, timeout);
    assert.deepEqual(result, { state: expected[0], minimumElapsedMs: expected[1], maximumElapsedMs: expected[2] });
    assert.ok(Object.isFrozen(result));
    assert.throws(() => { result.state = "changed"; }, TypeError);
  });
}

for (const [label, index] of [["before", 0], ["after", 1], ["observed", 2]]) {
  for (const [name, invalid] of [["NaN", NaN], ["positive infinity", Infinity], ["negative infinity", -Infinity],
    ["negative", -1], ["string", "1"], ["null", null], ["undefined", undefined], ["boolean", true]]) {
    test(`${label} rejects ${name}`, () => {
      const values = [1, 2, 3, 10]; values[index] = invalid;
      assert.throws(() => classifyIdleTiming(...values), { name: "TypeError", message: "IDLE_TIMING_INVALID" });
    });
  }
}
for (const [name, timeout] of [["NaN", NaN], ["positive infinity", Infinity], ["negative infinity", -Infinity],
  ["zero", 0], ["negative", -1], ["string", "1"], ["null", null], ["undefined", undefined], ["boolean", true]]) {
  test(`timeout rejects ${name}`, () => {
    assert.throws(() => classifyIdleTiming(1, 2, 3, timeout), { name: "TypeError", message: "IDLE_TIMING_INVALID" });
  });
}
test("reversed activity interval is rejected", () => {
  assert.throws(() => classifyIdleTiming(2, 1, 3, 10), { name: "TypeError", message: "IDLE_TIMING_INVALID" });
});
test("observation before the activity interval ends is rejected", () => {
  assert.throws(() => classifyIdleTiming(1, 3, 2, 10), { name: "TypeError", message: "IDLE_TIMING_INVALID" });
  assert.throws(() => classifyIdleTiming(2, 3, 1, 10), { name: "TypeError", message: "IDLE_TIMING_INVALID" });
});
test("predeadline evidence requires AFTER + 295s and still strictly before BEFORE + 300s", () => {
  assert.equal(classifyIdleTiming(100, 101, 295100, 295000).state, "uncertain");
  assert.equal(classifyIdleTiming(100, 101, 295101, 295000).state, "reached");
  assert.equal(classifyIdleTiming(100, 101, 295101, 300000).state, "before");
  assert.equal(classifyIdleTiming(100, 101, 300100, 300000).state, "uncertain");
});
test("actual recorded run has a conservative elapsed lower bound above five minutes", () => {
  const result = classifyIdleTiming(1149.0999999642372, 1149.199999988079, 302100.3000000119, 300000);
  assert.equal(result.state, "reached");
  assert.equal(Math.round(result.minimumElapsedMs * 10) / 10, 300951.1);
  assert.equal(Math.round(result.maximumElapsedMs * 10) / 10, 300951.2);
});
