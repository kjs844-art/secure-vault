import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyIdleTiming, classifyIdleTransition } from "./idle-lock-timing.mjs";

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

for (const [name, before, after, lastOpen, firstLocked, timeout, expected] of [
  ["delayed delivery straddles five minutes", 0, 0, 299990, 300080, 300000, ["uncertain", 299990, 300080]],
  ["both observations before threshold", 100, 102, 108, 109, 10, ["before", 6, 9]],
  ["both observations beyond threshold", 100, 102, 113, 114, 10, ["reached", 11, 14]],
  ["upper bound exactly threshold is uncertain", 100, 102, 109, 110, 10, ["uncertain", 7, 10]],
  ["lower bound exactly threshold is reached", 100, 102, 112, 113, 10, ["reached", 10, 13]],
  ["activity uncertainty prevents reached classification", 100, 102, 110, 111, 10, ["uncertain", 8, 11]],
  ["open observation at activity interval end", 100, 102, 102, 103, 10, ["before", 0, 3]],
  ["equal zero-origin observation timestamps", 0, 0, 0, 0, 1, ["before", 0, 0]],
  ["equal observation timestamps retain activity uncertainty", 100, 102, 111, 111, 10, ["uncertain", 9, 11]],
  ["equal observation timestamps at conservative threshold", 100, 102, 112, 112, 10, ["reached", 10, 12]],
  ["fractional observation interval", 0.25, 0.5, 1, 1.25, 0.5, ["reached", 0.5, 1]],
  ["narrow transition crossing threshold", 0, 0, 9.75, 10.25, 10, ["uncertain", 9.75, 10.25]],
  ["wide activity interval remains uncertain", 100, 200, 200, 210, 10, ["uncertain", 0, 110]],
]) {
  test(`transition ${name}`, () => {
    const result = classifyIdleTransition(before, after, lastOpen, firstLocked, timeout);
    assert.deepEqual(result, { state: expected[0], minimumElapsedMs: expected[1], maximumElapsedMs: expected[2] });
    assert.ok(Object.isFrozen(result));
    assert.throws(() => { result.state = "changed"; }, TypeError);
  });
}

test("a late locked sample alone cannot establish an on-time DOM transition", () => {
  assert.equal(classifyIdleTiming(0, 0, 300080, 300000).state, "reached");
  assert.equal(classifyIdleTransition(0, 0, 299990, 300080, 300000).state, "uncertain");
});

for (const [label, index] of [["activityBefore", 0], ["activityAfter", 1], ["lastOpenAt", 2], ["firstLockedAt", 3]]) {
  for (const [name, invalid] of [["NaN", NaN], ["positive infinity", Infinity], ["negative infinity", -Infinity],
    ["negative", -1], ["string", "1"], ["null", null], ["undefined", undefined], ["boolean", true]]) {
    test(`transition ${label} rejects ${name}`, () => {
      const values = [1, 2, 3, 4, 10]; values[index] = invalid;
      assert.throws(() => classifyIdleTransition(...values), { name: "TypeError", message: "IDLE_TRANSITION_INVALID" });
    });
  }
}

for (const [name, timeout] of [["NaN", NaN], ["positive infinity", Infinity], ["negative infinity", -Infinity],
  ["zero", 0], ["negative", -1], ["string", "1"], ["null", null], ["undefined", undefined], ["boolean", true]]) {
  test(`transition timeout rejects ${name}`, () => {
    assert.throws(() => classifyIdleTransition(1, 2, 3, 4, timeout), { name: "TypeError", message: "IDLE_TRANSITION_INVALID" });
  });
}

for (const [name, values] of [
  ["reversed activity interval", [2, 1, 3, 4, 10]],
  ["open observation before activity handling ends", [1, 3, 2, 4, 10]],
  ["locked observation before open observation", [1, 2, 4, 3, 10]],
]) {
  test(`transition rejects ${name}`, () => {
    assert.throws(() => classifyIdleTransition(...values), { name: "TypeError", message: "IDLE_TRANSITION_INVALID" });
  });
}
