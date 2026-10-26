import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyNativeLifecycleEvidence, type NativeLifecycleSample } from "../scripts/support/native-lifecycle-evidence.ts";

function sample(type: string, patch: Partial<NativeLifecycleSample> = {}): NativeLifecycleSample {
  return { type, trusted: true, persisted: true, open: "no", privateNodes: 0, ...patch };
}
const closedPair = () => [sample("pagehide"), sample("pageshow")];

test("same-document exact trusted persisted pair with closed DOM is PASS", () => {
  assert.deepEqual(classifyNativeLifecycleEvidence(true, closedPair()),
    { bfcacheObserved: true, privacyObserved: "CLOSED", status: "PASS" });
});

test("missing events or a different document are NOT_OBSERVED, never privacy PASS", () => {
  for (const sameDocument of [false, true]) {
    assert.deepEqual(classifyNativeLifecycleEvidence(sameDocument, []),
      { bfcacheObserved: false, privacyObserved: "NOT_OBSERVED", status: "INCONCLUSIVE" });
  }
  for (const events of [closedPair(), [sample("pagehide", { open: "yes", privateNodes: 3 }), sample("pageshow")]]) {
    assert.deepEqual(classifyNativeLifecycleEvidence(false, events),
      { bfcacheObserved: false, privacyObserved: "NOT_OBSERVED", status: "INCONCLUSIVE" });
  }
});

test("nonpersisted or unknown persistence with closed DOM is history evidence only", () => {
  for (const persisted of [false, null]) for (const index of [0, 1]) {
    const events = closedPair(); events[index] = sample(index === 0 ? "pagehide" : "pageshow", { persisted });
    assert.deepEqual(classifyNativeLifecycleEvidence(true, events),
      { bfcacheObserved: false, privacyObserved: "CLOSED", status: "INCONCLUSIVE" });
  }
});

test("persisted exposure is FAIL even though BFCache was observed", () => {
  for (const patch of [{ open: "yes" }, { open: null }, { privateNodes: 1 }, { privateNodes: -1 }, { privateNodes: NaN }]) {
    for (const index of [0, 1]) {
      const events = closedPair(); events[index] = sample(index === 0 ? "pagehide" : "pageshow", patch);
      assert.deepEqual(classifyNativeLifecycleEvidence(true, events),
        { bfcacheObserved: true, privacyObserved: "EXPOSED", status: "FAIL" });
    }
  }
});

test("exposure still fails when BFCache was not observed", () => {
  for (const persisted of [false, null]) {
    assert.deepEqual(classifyNativeLifecycleEvidence(true,
      [sample("pagehide", { persisted, privateNodes: 2 }), sample("pageshow", { persisted })]),
    { bfcacheObserved: false, privacyObserved: "EXPOSED", status: "FAIL" });
  }
});

test("untrusted events cannot certify BFCache and do not excuse observed exposure", () => {
  for (const index of [0, 1]) {
    const events = closedPair(); events[index] = sample(index === 0 ? "pagehide" : "pageshow", { trusted: false });
    assert.deepEqual(classifyNativeLifecycleEvidence(true, events),
      { bfcacheObserved: false, privacyObserved: "CLOSED", status: "INCONCLUSIVE" });
    events[index] = sample(index === 0 ? "pagehide" : "pageshow", { trusted: false, open: "yes" });
    assert.deepEqual(classifyNativeLifecycleEvidence(true, events),
      { bfcacheObserved: false, privacyObserved: "EXPOSED", status: "FAIL" });
  }
});

test("extra events cannot certify the exact BFCache pair, including exposure in the extra event", () => {
  assert.deepEqual(classifyNativeLifecycleEvidence(true, [...closedPair(), sample("pageshow")]),
    { bfcacheObserved: false, privacyObserved: "CLOSED", status: "INCONCLUSIVE" });
  assert.deepEqual(classifyNativeLifecycleEvidence(true, [...closedPair(), sample("pagehide", { privateNodes: 1 })]),
    { bfcacheObserved: false, privacyObserved: "EXPOSED", status: "FAIL" });
});

test("reversed, partial and differently named events remain inconclusive when closed", () => {
  for (const events of [[sample("pageshow"), sample("pagehide")], [sample("pagehide")], [sample("pageshow")],
    [sample("visibilitychange"), sample("pageshow")], [sample("pagehide"), sample("pagehide")]]) {
    assert.deepEqual(classifyNativeLifecycleEvidence(true, events),
      { bfcacheObserved: false, privacyObserved: "CLOSED", status: "INCONCLUSIVE" });
  }
});

test("classification is immutable, retains no samples and emits no raw identifiers", () => {
  const syntheticMarker = "synthetic-do-not-echo-document-marker";
  const extra = Object.freeze({ ...sample("pagehide"), documentMarker: syntheticMarker });
  const events = Object.freeze([extra, Object.freeze(sample("pageshow"))]);
  const result = classifyNativeLifecycleEvidence(true, events);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(Object.keys(result).sort(), ["bfcacheObserved", "privacyObserved", "status"]);
  assert.equal(JSON.stringify(result).includes(syntheticMarker), false);
  assert.equal(events[0], extra); assert.equal(events[0]?.documentMarker, syntheticMarker);
  assert.deepEqual(result, { bfcacheObserved: true, privacyObserved: "CLOSED", status: "PASS" });
});
