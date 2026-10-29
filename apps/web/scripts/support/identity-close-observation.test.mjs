import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createIdentityCloseObservation, IDENTITY_CLOSE_LIMIT_MS } from "./identity-close-observation.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const events = new EventEmitter(), work = deferred();
  let now = 100, connected = true, calls = 0;
  const browser = {
    on: (event, listener) => events.on(event, listener),
    off: (event, listener) => events.off(event, listener),
    isConnected: () => connected,
    close: () => { calls++; return work.promise; },
  };
  return {
    browser,
    events,
    work,
    now: () => now,
    at: (value) => { now = value; },
    calls: () => calls,
    disconnect: () => { connected = false; events.emit("disconnected"); },
  };
}

const drain = async () => { await Promise.resolve(); await Promise.resolve(); };

test("records context disconnect separately from the one close promise", async () => {
  const f = fixture(), observer = createIdentityCloseObservation(f.browser, f.now);
  const unrelated = () => {};
  f.events.on("disconnected", unrelated);
  observer.setPhase("CONTEXT_CLOSE"); f.at(150); f.disconnect();
  f.at(200); const first = observer.close();
  assert.equal(observer.close(), first); assert.equal(f.calls(), 1);
  f.at(450); f.work.resolve();
  assert.equal(await first, "RESOLVED");
  observer.setPhase("SERVER_CLOSE"); observer.dispose(); observer.dispose();
  const snapshot = observer.snapshot();
  assert.equal(snapshot.passed, true); assert.equal(snapshot.closeCalls, 1);
  assert.equal(snapshot.firstDisconnectedPhase, "CONTEXT_CLOSE"); assert.equal(snapshot.firstDisconnectedAtMs, 150);
  assert.equal(snapshot.contextCloseStartedAtMs, 100); assert.equal(snapshot.closeStartedAtMs, 200);
  assert.equal(snapshot.promiseSettledAtMs, 450); assert.equal(snapshot.serverCloseStartedAtMs, 450);
  assert.equal(snapshot.connectedBeforeClose, false); assert.equal(snapshot.connectedAtBoundary, false);
  assert.deepEqual(f.events.listeners("disconnected"), [unrelated]);
  assert.equal(observer.close(), first); assert.equal(f.calls(), 1);
});

test("disconnect alone cannot resolve close or clear a later deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), observer = createIdentityCloseObservation(f.browser, f.now);
  const boundary = observer.close(); f.at(200); f.disconnect();
  f.at(10_100); t.mock.timers.tick(IDENTITY_CLOSE_LIMIT_MS);
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

test("opaque late rejection is consumed without reading or serializing it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), observer = createIdentityCloseObservation(f.browser, f.now);
  let reads = 0;
  const opaque = new Proxy({}, { get: () => { reads++; throw Error("synthetic-private-error"); } });
  const boundary = observer.close(); f.at(10_100); t.mock.timers.tick(IDENTITY_CLOSE_LIMIT_MS);
  assert.equal(await boundary, "DEADLINE");
  f.at(10_200); f.work.reject(opaque); await drain();
  const snapshot = observer.snapshot();
  assert.equal(snapshot.promiseOutcome, "REJECTED"); assert.equal(snapshot.outcome, "DEADLINE");
  assert.equal(reads, 0); assert.equal(JSON.stringify(snapshot).includes("synthetic-private"), false);
  observer.dispose();
});

for (const elapsed of [9_999, 10_000, 10_001]) {
  test(`settlement at ${elapsed}ms applies the strict monotonic boundary`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(), observer = createIdentityCloseObservation(f.browser, f.now);
    const boundary = observer.close(); f.at(100 + elapsed); f.disconnect(); f.work.resolve();
    assert.equal(await boundary, elapsed < IDENTITY_CLOSE_LIMIT_MS ? "RESOLVED" : "DEADLINE");
    assert.equal(observer.snapshot().passed, elapsed < IDENTITY_CLOSE_LIMIT_MS);
    observer.dispose();
  });
}

test("resolved close while still connected is never a pass", async () => {
  const f = fixture(), observer = createIdentityCloseObservation(f.browser, f.now);
  const boundary = observer.close(); f.work.resolve();
  assert.equal(await boundary, "RESOLVED"); assert.equal(observer.snapshot().passed, false);
  observer.dispose();
});

test("early opaque rejection and synchronous throw remain distinct from deadline", async () => {
  for (const synchronous of [false, true]) {
    const f = fixture(), opaque = new Proxy({}, { get: () => { throw Error("must-not-read"); } });
    if (synchronous) f.browser.close = () => { throw opaque; };
    const observer = createIdentityCloseObservation(f.browser, f.now), boundary = observer.close();
    if (!synchronous) f.work.reject(opaque);
    assert.equal(await boundary, "REJECTED"); assert.equal(observer.snapshot().promiseOutcome, "REJECTED");
    assert.equal(observer.snapshot().passed, false); assert.equal(observer.snapshot().closeCalls, 1);
    observer.dispose();
  }
});

test("reentrant close reuses the already-published promise", async () => {
  const f = fixture();
  let nested;
  const original = f.browser.close;
  const observer = createIdentityCloseObservation(f.browser, f.now);
  f.browser.close = () => { nested = observer.close(); return original(); };
  const boundary = observer.close(); assert.equal(nested, boundary);
  f.disconnect(); f.work.resolve(); assert.equal(await boundary, "RESOLVED");
  assert.equal(f.calls(), 1); observer.dispose();
});

for (const kind of ["backward", "nonfinite", "throw"]) {
  test(`${kind} clock cannot certify cleanup`, async () => {
    const f = fixture(); let changed = false;
    const observer = createIdentityCloseObservation(f.browser, () => {
      if (!changed) return f.now();
      if (kind === "throw") throw { private: "not-for-output" };
      return kind === "backward" ? 99 : Number.NaN;
    });
    const boundary = observer.close(); changed = true; f.disconnect(); f.work.resolve();
    assert.equal(await boundary, "OBSERVATION_FAILED");
    assert.equal(observer.snapshot().clockFailed, true); assert.equal(observer.snapshot().passed, false);
    observer.dispose();
  });
}

test("failed connection probes still perform exactly one close and cannot pass", async () => {
  const f = fixture(); f.browser.isConnected = () => { throw { private: "not-for-output" }; };
  const observer = createIdentityCloseObservation(f.browser, f.now), boundary = observer.close();
  f.disconnect(); f.work.resolve(); assert.equal(await boundary, "RESOLVED");
  assert.equal(f.calls(), 1); assert.equal(observer.snapshot().connectionProbeFailed, true);
  assert.equal(observer.snapshot().connectedAtBoundary, null); assert.equal(observer.snapshot().passed, false);
  observer.dispose();
});

test("partial listener registration is cleaned without touching unrelated listeners", async () => {
  const f = fixture(), unrelated = () => {};
  f.events.on("disconnected", unrelated);
  f.browser.on = (event, listener) => { f.events.on(event, listener); throw Error("synthetic-private"); };
  const observer = createIdentityCloseObservation(f.browser, f.now), boundary = observer.close();
  f.disconnect(); f.work.resolve(); await boundary; observer.dispose();
  assert.deepEqual(f.events.listeners("disconnected"), [unrelated]);
  assert.equal(observer.snapshot().listenerAttachFailed, true); assert.equal(observer.snapshot().passed, false);
});

test("listener removal failure is sticky without retrying close or removal", async () => {
  const f = fixture(); let offCalls = 0;
  f.browser.off = () => { offCalls++; throw { private: "not-for-output" }; };
  const observer = createIdentityCloseObservation(f.browser, f.now), boundary = observer.close();
  f.disconnect(); f.work.resolve(); await boundary; observer.dispose(); observer.dispose();
  assert.equal(offCalls, 1); assert.equal(f.calls(), 1);
  assert.equal(observer.snapshot().listenerDetachFailed, true); assert.equal(observer.snapshot().passed, false);
});

test("arbitrary phase text is rejected and cannot enter serialized evidence", async () => {
  const f = fixture(), observer = createIdentityCloseObservation(f.browser, f.now);
  observer.setPhase("C:/synthetic-private-path");
  const boundary = observer.close(); f.disconnect(); f.work.resolve(); await boundary;
  const snapshot = observer.snapshot(), serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.phaseFailed, true); assert.equal(snapshot.passed, false);
  assert.equal(snapshot.firstDisconnectedPhase, "BROWSER_CLOSE");
  assert.equal(serialized.includes("synthetic-private-path"), false);
  observer.dispose();
});
