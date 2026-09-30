import assert from "node:assert/strict";
import nodeTest from "node:test";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { acquireOwned, withDeadline } from "./qa-lifecycle.mjs";

// Promise-only synthetic resources. No browser, filesystem, network or processes.
const test = (name, run) => nodeTest(name, { timeout: 2000 }, run);
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const isDeadline = (error) => error instanceof Error && error.message === "QA_DEADLINE";
const never = () => new Promise(() => {});
function blockEventLoop(milliseconds) {
  const stopAt = performance.now() + milliseconds;
  while (performance.now() < stopAt) { /* Brief deterministic timer-starvation fixture. */ }
}

test("deadline arguments are validated before invoking work", () => {
  let calls = 0;
  const task = () => { calls += 1; };
  for (const timeout of [undefined, null, "5", 0, -1, 1.5, NaN, Infinity, 120001]) {
    assert.throws(() => withDeadline(task, timeout), { message: "QA_LIFECYCLE_CONFIG" });
    assert.throws(() => acquireOwned(task, task, timeout), { message: "QA_LIFECYCLE_CONFIG" });
  }
  for (const callback of [undefined, null, {}, 1, "callback"]) {
    assert.throws(() => withDeadline(callback, 10), { message: "QA_LIFECYCLE_CONFIG" });
    assert.throws(() => acquireOwned(callback, task, 10), { message: "QA_LIFECYCLE_CONFIG" });
    assert.throws(() => acquireOwned(task, callback, 10), { message: "QA_LIFECYCLE_CONFIG" });
  }
  assert.equal(calls, 0);
});

test("normal sync and async values survive and completed timers are cleared", async () => {
  let receivedSignal;
  const value = Object.freeze({ synthetic: true });
  assert.equal(await withDeadline((signal) => {
    receivedSignal = signal;
    return value;
  }, 1), value);
  assert.equal(await withDeadline(async () => value, 120000), value);
  await delay(15);
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(receivedSignal.aborted, false);
});

test("sync throws and promise rejections preserve the caller's error", async () => {
  const error = new Error("synthetic caller error");
  let receivedSignal;
  await assert.rejects(withDeadline((signal) => {
    receivedSignal = signal;
    throw error;
  }, 5), (actual) => actual === error);
  await assert.rejects(withDeadline(() => Promise.reject(error), 5), (actual) => actual === error);
  await delay(15);
  assert.equal(receivedSignal.aborted, false);
});

test("never-settling work rejects with the fixed deadline after abort", async () => {
  let signal;
  let abortCount = 0;
  await assert.rejects(withDeadline((received) => {
    signal = received;
    received.addEventListener("abort", () => { abortCount += 1; }, { once: true });
    return never();
  }, 5), (error) => {
    assert.equal(signal.aborted, true);
    assert.equal(abortCount, 1);
    return isDeadline(error);
  });
});

test("abort-listener success cannot replace a deadline failure", async () => {
  const work = deferred();
  let successCount = 0;
  const outcome = withDeadline((signal) => {
    signal.addEventListener("abort", () => work.resolve("late synthetic success"), { once: true });
    return work.promise;
  }, 5);
  void outcome.then(() => { successCount += 1; }, () => {});
  await assert.rejects(outcome, isDeadline);
  await delay(0);
  assert.equal(successCount, 0);
});

test("late work rejection remains handled after timeout", async () => {
  const work = deferred();
  await assert.rejects(withDeadline(() => work.promise, 5), isDeadline);
  work.reject(new Error("synthetic late rejection"));
  await delay(0);
});

test("normal owned acquisition returns its resource without disposing it", async () => {
  const resource = Object.freeze({ synthetic: true });
  let disposeCount = 0;
  let signal;
  assert.equal(await acquireOwned((received) => {
    signal = received;
    return resource;
  }, () => { disposeCount += 1; }, 5), resource);
  await delay(15);
  assert.equal(signal.aborted, false);
  assert.equal(disposeCount, 0);
});

test("failed acquisition does not invent a resource to dispose", async () => {
  const error = new Error("synthetic acquisition failure");
  let disposeCount = 0;
  await assert.rejects(acquireOwned(() => { throw error; }, () => { disposeCount += 1; }, 5),
    (actual) => actual === error);
  await assert.rejects(acquireOwned(never, () => { disposeCount += 1; }, 5), isDeadline);
  assert.equal(disposeCount, 0);
});

test("resource produced by an abort listener is disposed once, never returned", async () => {
  const factory = deferred();
  const disposed = deferred();
  const resource = Object.freeze({ owned: "synthetic" });
  let disposeCount = 0;
  const outcome = acquireOwned((signal) => {
    signal.addEventListener("abort", () => factory.resolve(resource), { once: true });
    return factory.promise;
  }, (actual, signal) => {
    disposeCount += 1;
    assert.equal(actual, resource);
    assert.ok(signal instanceof AbortSignal);
    disposed.resolve();
  }, 5);
  await assert.rejects(outcome, isDeadline);
  await disposed.promise;
  factory.resolve(resource);
  await delay(0);
  assert.equal(disposeCount, 1);
});

test("late owned resource is disposed once after caller already received timeout", async () => {
  const factory = deferred();
  const disposed = deferred();
  const resource = Object.freeze({ owned: "synthetic" });
  let disposeCount = 0;
  await assert.rejects(acquireOwned(() => factory.promise, (actual) => {
    disposeCount += 1;
    assert.equal(actual, resource);
    disposed.resolve();
  }, 5), isDeadline);
  factory.resolve(resource);
  await disposed.promise;
  await delay(15);
  assert.equal(disposeCount, 1);
});

test("late disposer throw or rejection creates no unhandled rejection", async () => {
  for (const kind of ["throw", "reject"]) {
    const factory = deferred();
    const disposed = deferred();
    let disposeCount = 0;
    await assert.rejects(acquireOwned(() => factory.promise, () => {
      disposeCount += 1;
      disposed.resolve();
      const error = new Error("synthetic cleanup failure");
      if (kind === "throw") throw error;
      return Promise.reject(error);
    }, 5), isDeadline);
    factory.resolve({ owned: "synthetic" });
    await disposed.promise;
    await delay(15);
    assert.equal(disposeCount, 1);
  }
});

test("never-settling late disposal is aborted without awaiting it forever", async () => {
  const factory = deferred();
  const cleanupAborted = deferred();
  let disposeCount = 0;
  await assert.rejects(acquireOwned(() => factory.promise, (_resource, signal) => {
    disposeCount += 1;
    signal.addEventListener("abort", () => cleanupAborted.resolve(), { once: true });
    return never();
  }, 5), isDeadline);
  factory.resolve({ owned: "synthetic" });
  await withDeadline(() => cleanupAborted.promise, 1000);
  await delay(0);
  assert.equal(disposeCount, 1);
});

test("late acquisition rejection does not invoke disposal or leak a rejection", async () => {
  const factory = deferred();
  let disposeCount = 0;
  await assert.rejects(acquireOwned(() => factory.promise, () => { disposeCount += 1; }, 5), isDeadline);
  factory.reject(new Error("synthetic late acquisition failure"));
  await delay(0);
  assert.equal(disposeCount, 0);
});

test("disposal rejection after its own timeout remains handled", async () => {
  const factory = deferred();
  const cleanup = deferred();
  const cleanupAborted = deferred();
  let disposeCount = 0;
  await assert.rejects(acquireOwned(() => factory.promise, (_resource, signal) => {
    disposeCount += 1;
    signal.addEventListener("abort", () => cleanupAborted.resolve(), { once: true });
    return cleanup.promise;
  }, 5), isDeadline);
  factory.resolve({ owned: "synthetic" });
  await withDeadline(() => cleanupAborted.promise, 1000);
  cleanup.reject(new Error("synthetic late cleanup rejection"));
  await delay(0);
  assert.equal(disposeCount, 1);
});

test("success after a blocked event loop cannot beat the still-pending timer", async () => {
  let signal;
  let abortCount = 0;
  await assert.rejects(withDeadline((received) => {
    signal = received;
    received.addEventListener("abort", () => { abortCount += 1; }, { once: true });
    blockEventLoop(8);
    // This is still the same stack: the timer has had no chance to run.
    assert.equal(received.aborted, false);
    return "synthetic late success";
  }, 2), isDeadline);
  assert.equal(signal.aborted, true);
  assert.equal(abortCount, 1);
});

test("resource acquired before the delayed deadline check is still disposed once", async () => {
  const resource = Object.freeze({ owned: "synthetic" });
  const disposed = deferred();
  let factorySignal;
  let disposeCount = 0;
  let disposedResource;
  await assert.rejects(acquireOwned((signal) => {
    factorySignal = signal;
    blockEventLoop(8);
    assert.equal(signal.aborted, false);
    return resource;
  }, (actual) => {
    disposeCount += 1;
    disposedResource = actual;
    disposed.resolve();
  }, 2), isDeadline);
  await disposed.promise;
  await delay(10);
  assert.equal(factorySignal.aborted, true);
  assert.equal(disposedResource, resource);
  assert.equal(disposeCount, 1);
});

test("errors after a blocked deadline also abort so callers can quarantine work", async () => {
  for (const kind of ["throw", "reject"]) {
    let signal;
    await assert.rejects(withDeadline((received) => {
      signal = received;
      blockEventLoop(8);
      const error = new Error("synthetic delayed failure");
      if (kind === "throw") throw error;
      return Promise.reject(error);
    }, 2), isDeadline);
    assert.equal(signal.aborted, true);
  }
});
