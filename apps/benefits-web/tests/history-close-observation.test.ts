import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createHistoryCloseObservation, HISTORY_CLOSE_LIMIT_MS, type HistoryCloseBrowser } from "../scripts/support/history-close-observation.ts";

function deferred() {
  let resolve!: () => void, reject!: (value: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture() {
  const events = new EventEmitter(), work = deferred();
  let now = 100, connected = true, calls = 0;
  const browser: HistoryCloseBrowser = {
    on: (event, listener) => events.on(event, listener),
    off: (event, listener) => events.off(event, listener),
    isConnected: () => connected,
    close: () => { calls++; return work.promise; },
  };
  return { browser, events, work, now: () => now, at: (value: number) => { now = value; }, calls: () => calls,
    disconnect: () => { connected = false; events.emit("disconnected"); } };
}
const drain = async () => { await Promise.resolve(); await Promise.resolve(); };

test("records early context disconnect separately from the single close promise", async () => {
  const f = fixture(), observer = createHistoryCloseObservation(f.browser, f.now);
  const unrelated = () => {};
  f.events.on("disconnected", unrelated);
  observer.setPhase("CONTEXT_CLOSE"); f.at(150); f.disconnect();
  f.at(200); const first = observer.close();
  assert.equal(observer.close(), first); assert.equal(f.calls(), 1);
  f.at(450); f.work.resolve();
  assert.equal(await first, "RESOLVED");
  observer.setPhase("SERVER_CLOSE"); observer.dispose(); observer.dispose();
  const s = observer.snapshot();
  assert.equal(s.passed, true); assert.equal(s.closeCalls, 1);
  assert.equal(s.firstDisconnectedPhase, "CONTEXT_CLOSE"); assert.equal(s.firstDisconnectedAtMs, 150);
  assert.equal(s.contextCloseStartedAtMs, 100); assert.equal(s.closeStartedAtMs, 200);
  assert.equal(s.promiseSettledAtMs, 450); assert.equal(s.serverCloseStartedAtMs, 450);
  assert.equal(s.connectedBeforeClose, false); assert.equal(s.connectedAtBoundary, false);
  assert.deepEqual(f.events.listeners("disconnected"), [unrelated]);
  assert.equal(observer.close(), first); assert.equal(f.calls(), 1);
});

test("disconnect alone does not resolve close and a late resolution cannot clear deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), observer = createHistoryCloseObservation(f.browser, f.now);
  const boundary = observer.close(); f.at(200); f.disconnect();
  f.at(10_100); t.mock.timers.tick(HISTORY_CLOSE_LIMIT_MS);
  assert.equal(await boundary, "DEADLINE");
  const frozen = observer.snapshot();
  assert.equal(frozen.promiseOutcome, "PENDING"); assert.equal(frozen.connectedAtBoundary, false);
  assert.equal(frozen.passed, false); assert.equal(Object.isFrozen(frozen), true);
  f.at(11_100); f.work.resolve(); await drain();
  const late = observer.snapshot();
  assert.equal(late.outcome, "DEADLINE"); assert.equal(late.promiseOutcome, "RESOLVED");
  assert.equal(late.promiseSettledAtMs, 11_100); assert.equal(late.passed, false);
  assert.equal(frozen.promiseOutcome, "PENDING"); observer.dispose();
});

test("late opaque rejection is consumed without inspecting or serializing exception properties", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), observer = createHistoryCloseObservation(f.browser, f.now);
  let reads = 0;
  const opaque = new Proxy({}, { get: () => { reads++; throw Error("synthetic-private-error"); } });
  const boundary = observer.close(); f.at(10_100); t.mock.timers.tick(HISTORY_CLOSE_LIMIT_MS);
  assert.equal(await boundary, "DEADLINE");
  f.at(10_200); f.work.reject(opaque); await drain();
  const s = observer.snapshot();
  assert.equal(s.promiseOutcome, "REJECTED"); assert.equal(s.outcome, "DEADLINE"); assert.equal(reads, 0);
  assert.equal(JSON.stringify(s).includes("synthetic-private"), false); observer.dispose();
});

for (const elapsed of [9_999, 10_000, 10_001]) test(`settlement at ${elapsed}ms uses the monotonic bound before a delayed timer`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), observer = createHistoryCloseObservation(f.browser, f.now);
  const boundary = observer.close(); f.at(100 + elapsed); f.disconnect(); f.work.resolve();
  assert.equal(await boundary, elapsed < HISTORY_CLOSE_LIMIT_MS ? "RESOLVED" : "DEADLINE");
  assert.equal(observer.snapshot().passed, elapsed < HISTORY_CLOSE_LIMIT_MS);
  observer.dispose();
});

test("resolved close while connected is not a pass", async () => {
  const f = fixture(), observer = createHistoryCloseObservation(f.browser, f.now);
  const boundary = observer.close(); f.work.resolve();
  assert.equal(await boundary, "RESOLVED"); assert.equal(observer.snapshot().passed, false); observer.dispose();
});

test("early rejection and synchronous throw remain distinct from a deadline", async () => {
  for (const synchronous of [false, true]) {
    const f = fixture();
    const opaque = new Proxy({}, { get: () => { throw Error("must-not-read"); } });
    if (synchronous) f.browser.close = () => { throw opaque; };
    const observer = createHistoryCloseObservation(f.browser, f.now), boundary = observer.close();
    if (!synchronous) f.work.reject(opaque);
    assert.equal(await boundary, "REJECTED"); assert.equal(observer.snapshot().promiseOutcome, "REJECTED");
    assert.equal(observer.snapshot().passed, false); assert.equal(observer.snapshot().closeCalls, 1); observer.dispose();
  }
});

test("a reentrant close call reuses the already-published promise", async () => {
  const f = fixture();
  let nested: Promise<unknown> | undefined;
  const original = f.browser.close;
  const observer = createHistoryCloseObservation(f.browser, f.now);
  f.browser.close = () => { nested = observer.close(); return original(); };
  const boundary = observer.close(); assert.equal(nested, boundary);
  f.disconnect(); f.work.resolve(); assert.equal(await boundary, "RESOLVED");
  assert.equal(f.calls(), 1); observer.dispose();
});

for (const kind of ["backward", "nonfinite", "throw"] as const) test(`a ${kind} clock never certifies cleanup`, async () => {
  const f = fixture(); let changed = false;
  const observer = createHistoryCloseObservation(f.browser, () => {
    if (!changed) return f.now();
    if (kind === "throw") throw { private: "not-for-output" };
    return kind === "backward" ? 99 : Number.NaN;
  });
  const boundary = observer.close(); changed = true; f.disconnect(); f.work.resolve();
  assert.equal(await boundary, "OBSERVATION_FAILED");
  assert.equal(observer.snapshot().clockFailed, true); assert.equal(observer.snapshot().passed, false); observer.dispose();
});

test("failed connection probes cannot skip the one close attempt or pass", async () => {
  const f = fixture(); f.browser.isConnected = () => { throw { private: "not-for-output" }; };
  const observer = createHistoryCloseObservation(f.browser, f.now), boundary = observer.close();
  f.disconnect(); f.work.resolve(); assert.equal(await boundary, "RESOLVED");
  assert.equal(f.calls(), 1); assert.equal(observer.snapshot().connectionProbeFailed, true);
  assert.equal(observer.snapshot().connectedAtBoundary, null); assert.equal(observer.snapshot().passed, false); observer.dispose();
});

test("partial listener registration is cleaned without removing an unrelated listener", async () => {
  const f = fixture(), unrelated = () => {};
  f.events.on("disconnected", unrelated);
  f.browser.on = (event, listener) => { f.events.on(event, listener); throw Error("synthetic-private"); };
  const observer = createHistoryCloseObservation(f.browser, f.now), boundary = observer.close();
  f.disconnect(); f.work.resolve(); await boundary; observer.dispose();
  assert.deepEqual(f.events.listeners("disconnected"), [unrelated]);
  assert.equal(observer.snapshot().listenerAttachFailed, true); assert.equal(observer.snapshot().passed, false);
});

test("listener removal failure is sticky and does not retry close or off", async () => {
  const f = fixture(); let offCalls = 0;
  f.browser.off = () => { offCalls++; throw { private: "not-for-output" }; };
  const observer = createHistoryCloseObservation(f.browser, f.now), boundary = observer.close();
  f.disconnect(); f.work.resolve(); await boundary; observer.dispose(); observer.dispose();
  assert.equal(offCalls, 1); assert.equal(f.calls(), 1);
  assert.equal(observer.snapshot().listenerDetachFailed, true); assert.equal(observer.snapshot().passed, false);
});
