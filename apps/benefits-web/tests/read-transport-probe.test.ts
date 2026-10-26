import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { createReadTransportProbe } from "../scripts/fixtures/read-transport-probe.ts";

// Native Request/Response streams and signals, injected transport, synthetic only.
// No localhost server, remote endpoint, real account, secret, storage or timers.
const ORIGIN = "https://synthetic.local";
function request(path = "/api/catalog/list", method = "POST") {
  return new Request(`${ORIGIN}${path}`, { method });
}
function abortListeners(signal: AbortSignal) { return getEventListeners(signal, "abort").length; }

test("probe preserves exact native Request, signal, Promise and unread streams", async () => {
  let requestPulls = 0, responsePulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    requestPulls++; controller.enqueue(new TextEncoder().encode("synthetic-request")); controller.close();
  } }, { highWaterMark: 0 });
  const incoming = new Request(`${ORIGIN}/api/catalog/list`,
    { method: "POST", body, duplex: "half" } as RequestInit);
  const responseBody = new ReadableStream<Uint8Array>({ pull(controller) {
    responsePulls++; controller.enqueue(new TextEncoder().encode("synthetic-response")); controller.close();
  } }, { highWaterMark: 0 });
  const response = new Response(responseBody);
  const promise = Promise.resolve(response);
  const controller = new AbortController();
  let calls = 0;
  const probe = createReadTransportProbe(ORIGIN, (seenRequest, seenSignal) => {
    calls++; assert.equal(seenRequest, incoming); assert.equal(seenSignal, controller.signal);
    assert.equal(seenRequest.body, body); return promise;
  });
  assert.equal(probe.fetch(incoming, controller.signal), promise);
  probe.snapshot();
  assert.equal(calls, 1);
  assert.equal(requestPulls, 0); assert.equal(responsePulls, 0);
  assert.equal(incoming.bodyUsed, false); assert.equal(response.bodyUsed, false);
  assert.equal(body.locked, false); assert.equal(responseBody.locked, false);
  assert.equal(await promise, response);
  assert.equal(await response.text(), "synthetic-response");
  assert.equal(await incoming.text(), "synthetic-request");
  assert.equal(requestPulls, 1); assert.equal(responsePulls, 1);
  probe.detach();
});

test("probe does not inspect or attach to the Promise then/catch/finally properties", () => {
  const promise = Promise.resolve(new Response());
  for (const property of ["then", "catch", "finally"]) {
    Object.defineProperty(promise, property, { get() { assert.fail(`${property} inspected`); } });
  }
  const probe = createReadTransportProbe(ORIGIN, () => promise);
  assert.equal(probe.fetch(request(), new AbortController().signal), promise);
  probe.detach();
});

test("only exact same-origin POST read endpoints produce records", () => {
  let calls = 0;
  const response = Promise.resolve(new Response());
  const probe = createReadTransportProbe(ORIGIN, () => { calls++; return response; });
  const controller = new AbortController();
  const excluded = [request("/api/catalog/list", "GET"), request("/api/inbox/batch", "PUT"),
    request("/api/catalog/list/"), request("/api/catalog/list?synthetic=1"),
    request("/api/catalog/list#synthetic"), request("/api/catalog/%6cist"),
    request("/api/catalog/create"), request("/api/catalog/get"), request("/api/catalog/update"),
    request("/api/catalog/delete"), request("/api/inbox/batch/"),
    new Request("https://other.synthetic.local/api/catalog/list", { method: "POST" }),
    new Request("http://synthetic.local/api/catalog/list", { method: "POST" }),
    new Request("https://synthetic.local:444/api/catalog/list", { method: "POST" })];
  for (const candidate of excluded) assert.equal(probe.fetch(candidate, controller.signal), response);
  assert.deepEqual(probe.snapshot(), { total: 0, dropped: 0, records: [] });
  assert.equal(abortListeners(controller.signal), 0);
  probe.fetch(request(), controller.signal);
  probe.fetch(request("/api/inbox/batch"), controller.signal);
  assert.equal(calls, excluded.length + 2);
  assert.deepEqual(probe.snapshot().records.map(({ ordinal, route }) => ({ ordinal, route })),
    [{ ordinal: 1, route: "/api/catalog/list" }, { ordinal: 2, route: "/api/inbox/batch" }]);
  probe.detach();
});

test("snapshots expose only frozen detached primitive observations", () => {
  const controller = new AbortController();
  const probe = createReadTransportProbe(ORIGIN, () => Promise.resolve(new Response()));
  probe.fetch(new Request(`${ORIGIN}/api/inbox/batch`, { method: "POST",
    headers: { "x-synthetic-marker": "synthetic-header" }, body: "synthetic-body" }), controller.signal);
  const before = probe.snapshot();
  assert.ok(Object.isFrozen(before) && Object.isFrozen(before.records) && Object.isFrozen(before.records[0]));
  assert.deepEqual(Object.keys(before.records[0]!).sort(),
    ["ordinal", "route", "initiallyAborted", "abortObserved", "abortEvents", "observationActive"].sort());
  assert.equal(JSON.stringify(before).includes(ORIGIN), false);
  assert.equal(JSON.stringify(before).includes("synthetic-header"), false);
  assert.equal(JSON.stringify(before).includes("synthetic-body"), false);
  controller.abort("synthetic-reason-not-recorded");
  const after = probe.snapshot();
  assert.notEqual(after, before); assert.notEqual(after.records, before.records);
  assert.notEqual(after.records[0], before.records[0]);
  assert.equal(before.records[0]!.abortObserved, false);
  assert.equal(before.records[0]!.observationActive, true);
  assert.equal(after.records[0]!.abortObserved, true);
  assert.equal(after.records[0]!.abortEvents, 1);
  assert.equal(after.records[0]!.observationActive, false);
  assert.equal(JSON.stringify(after).includes("synthetic-reason-not-recorded"), false);
  assert.equal(abortListeners(controller.signal), 0);
});

test("already-aborted signal is initial state, not an observed abort event", () => {
  const controller = new AbortController(); controller.abort();
  const promise = Promise.resolve(new Response());
  const probe = createReadTransportProbe(ORIGIN, (_request, signal) => {
    assert.equal(signal, controller.signal); assert.equal(signal.aborted, true); return promise;
  });
  assert.equal(probe.fetch(request(), controller.signal), promise);
  assert.deepEqual(probe.snapshot().records[0], { ordinal: 1, route: "/api/catalog/list",
    initiallyAborted: true, abortObserved: false, abortEvents: 0, observationActive: false });
  assert.equal(abortListeners(controller.signal), 0);
});

test("abort during transport is observed without settling or changing its Promise", async () => {
  const controller = new AbortController();
  let settle!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => { settle = resolve; });
  const probe = createReadTransportProbe(ORIGIN, () => { controller.abort(); return promise; });
  assert.equal(probe.fetch(request(), controller.signal), promise);
  assert.deepEqual(probe.snapshot().records[0], { ordinal: 1, route: "/api/catalog/list",
    initiallyAborted: false, abortObserved: true, abortEvents: 1, observationActive: false });
  assert.equal(abortListeners(controller.signal), 0);
  const response = new Response(); settle(response); assert.equal(await promise, response);
});

test("Promise completion does not become signal completion; later abort is observed", async () => {
  const controller = new AbortController();
  const response = new Response();
  const probe = createReadTransportProbe(ORIGIN, () => Promise.resolve(response));
  assert.equal(await probe.fetch(request(), controller.signal), response);
  assert.equal(controller.signal.aborted, false);
  assert.equal(probe.snapshot().records[0]!.observationActive, true);
  controller.abort(); controller.abort();
  assert.equal(probe.snapshot().records[0]!.abortEvents, 1);
  assert.equal(abortListeners(controller.signal), 0);
});

test("synchronous throw is forwarded unchanged without converting to rejected Promise", () => {
  const failure = Error("synthetic-sync-failure");
  const probe = createReadTransportProbe(ORIGIN, () => { throw failure; });
  const controller = new AbortController();
  assert.throws(() => probe.fetch(request(), controller.signal), (error: unknown) => error === failure);
  assert.equal(probe.snapshot().total, 1);
  probe.detach(); assert.equal(abortListeners(controller.signal), 0);
});

test("transport rejection is forwarded as the original Promise and reason", async () => {
  const failure = Error("synthetic-rejection");
  const promise = Promise.reject(failure);
  const probe = createReadTransportProbe(ORIGIN, () => promise);
  const result = probe.fetch(request(), new AbortController().signal);
  assert.equal(result, promise);
  await assert.rejects(result, (error: unknown) => error === failure);
  probe.detach();
});

test("detach is idempotent, prevents later observation and allows StrictMode-style reuse", () => {
  const old = new AbortController(), next = new AbortController();
  const probe = createReadTransportProbe(ORIGIN, () => Promise.resolve(new Response()));
  probe.fetch(request(), old.signal);
  assert.equal(abortListeners(old.signal), 1);
  probe.detach(); probe.detach();
  assert.equal(abortListeners(old.signal), 0);
  assert.equal(old.signal.aborted, false);
  probe.fetch(request("/api/inbox/batch"), next.signal);
  old.abort(); next.abort();
  assert.deepEqual(probe.snapshot(), { total: 2, dropped: 0, records: [
    { ordinal: 1, route: "/api/catalog/list", initiallyAborted: false,
      abortObserved: false, abortEvents: 0, observationActive: false },
    { ordinal: 2, route: "/api/inbox/batch", initiallyAborted: false,
      abortObserved: true, abortEvents: 1, observationActive: false },
  ] });
  assert.equal(abortListeners(next.signal), 0);
});

test("bounded retention removes evicted listeners and keeps total/dropped ordinals", () => {
  const probe = createReadTransportProbe(ORIGIN, () => Promise.resolve(new Response()));
  const controllers = Array.from({ length: 300 }, () => new AbortController());
  for (const controller of controllers) probe.fetch(request(), controller.signal);
  const snapshot = probe.snapshot();
  assert.equal(snapshot.total, 300); assert.equal(snapshot.dropped, 44);
  assert.equal(snapshot.records.length, 256);
  assert.equal(snapshot.records[0]!.ordinal, 45); assert.equal(snapshot.records[255]!.ordinal, 300);
  for (const controller of controllers.slice(0, 44)) {
    assert.equal(abortListeners(controller.signal), 0); controller.abort();
  }
  assert.equal(controllers.reduce((total, controller) => total + abortListeners(controller.signal), 0), 256);
  assert.equal(probe.snapshot().records.some((record) => record.abortObserved), false);
  probe.detach();
  assert.equal(controllers.reduce((total, controller) => total + abortListeners(controller.signal), 0), 0);
  for (const controller of controllers) controller.abort();
  assert.equal(probe.snapshot().records.some((record) => record.abortObserved), false);
  assert.equal(probe.snapshot().records.some((record) => record.observationActive), false);
});

test("detach removes only this probe's listener and does not cancel native streams", async () => {
  const controller = new AbortController();
  let outsideAborts = 0, cancellations = 0;
  controller.signal.addEventListener("abort", () => { outsideAborts++; });
  const body = new ReadableStream<Uint8Array>({ cancel() { cancellations++; } }, { highWaterMark: 0 });
  const response = new Response(body), promise = Promise.resolve(response);
  const probe = createReadTransportProbe(ORIGIN, () => promise);
  assert.equal(probe.fetch(request(), controller.signal), promise);
  assert.equal(abortListeners(controller.signal), 2);
  probe.detach();
  assert.equal(abortListeners(controller.signal), 1);
  assert.equal(cancellations, 0); assert.equal(body.locked, false); assert.equal(response.bodyUsed, false);
  controller.abort(); assert.equal(outsideAborts, 1); assert.equal(cancellations, 0);
  assert.equal(await promise, response);
});
