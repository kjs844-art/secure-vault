import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import {
  CATALOG_VIEW_SCHEMA, createCatalogClient, createCatalogCreateRequest,
  createCatalogDeleteRequest, createCatalogGetRequest, createCatalogListRequest,
  createCatalogUpdateRequest, type CatalogClientConfig, type CatalogRequest,
} from "../src/domain/catalog-client/client.ts";

// Native synthetic Request/Response/streams only. cancel spies forward to the
// original body method: a closed source's cancel callback alone cannot prove
// whether body.cancel() was called. No browser terminal/root-cause claim.
const ORIGIN = "https://synthetic.invalid";
const CONTEXT = Object.freeze({ viewScope: "synthetic-completed-read", dataGeneration: 1 });
const HEADERS = { "content-type": "application/json", "cache-control": "private, no-store" };
const PROFILE = Object.freeze({ name: "Synthetic Service", provider: null, planName: null,
  accountLabel: null, timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null });

function row(revision = 1, state: "live" | "deleted" = "live", generation = 1) {
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration: generation, serviceId: "synthetic-service",
    serviceRevision: revision, state, profile: state === "live" ? PROFILE : null,
    createdAt: 1, updatedAt: 1, provenance: "user-reported", accountProof: "not-established" };
}
function readRequest(action: "get" | "list") {
  return action === "get" ? createCatalogGetRequest("synthetic-service") : createCatalogListRequest(10, null);
}
function readEnvelope(action: "get" | "list", generation = 1) {
  return { ok: true, value: action === "get" ? row(1, "live", generation)
    : { schema: CATALOG_VIEW_SCHEMA, dataGeneration: generation, catalogRevision: 1,
      services: [row(1, "live", generation)], nextCursor: null } };
}
function observeBody(t: TestContext, response: Response) {
  assert.ok(response.body);
  const body = response.body, nativeCancel = body.cancel;
  let cancelCalls = 0;
  t.mock.method(body, "cancel", (reason?: unknown) => {
    cancelCalls++;
    return nativeCancel.call(body, reason);
  });
  return { response, body, cancelCalls: () => cancelCalls };
}
function reply(t: TestContext, payload: unknown, status = 200, headers = HEADERS) {
  return observeBody(t, new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status, headers }));
}
function fixture(fetch: CatalogClientConfig["fetch"], extras: Partial<CatalogClientConfig> = {}) {
  const calls: { request: Request; signal: AbortSignal }[] = [];
  const call = createCatalogClient({ origin: ORIGIN, readViewContext: () => CONTEXT,
    fetch: async (request, signal) => { calls.push({ request, signal }); return fetch(request, signal); }, ...extras });
  return { call, calls };
}
function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const action of ["get", "list"] as const) {
  test(`validated EOF ${action} skips body.cancel and detaches completed transport`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const observed = reply(t, readEnvelope(action)), caller = new AbortController();
    const f = fixture(async () => observed.response);
    const result = await f.call(readRequest(action), caller.signal);
    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.equal(result.success.kind, action === "get" ? "view" : "page");
      assert.deepEqual(result.capturedScope, CONTEXT);
    }
    assert.equal(observed.cancelCalls(), 0);
    assert.equal(observed.body.locked, false); assert.equal(observed.response.bodyUsed, true);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    t.mock.timers.tick(10000); caller.abort();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.signal.aborted, false);
    assert.equal(f.calls[0]!.request.signal.aborted, false); assert.equal(observed.cancelCalls(), 0);
  });
}

test("validated EOF empty list skips body.cancel and detaches completed transport", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, catalogRevision: 1,
    services: [], nextCursor: null };
  const observed = reply(t, { ok: true, value: page }), caller = new AbortController();
  const f = fixture(async () => observed.response);
  const result = await f.call(readRequest("list"), caller.signal);
  assert.equal(result.kind, "success");
  if (result.kind === "success") {
    assert.equal(result.success.kind, "page");
    if (result.success.kind === "page") assert.deepEqual(result.success.page, page);
    assert.deepEqual(result.capturedScope, CONTEXT);
  }
  assert.equal(observed.cancelCalls(), 0); assert.equal(observed.body.locked, false);
  assert.equal(observed.response.bodyUsed, true); assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  t.mock.timers.tick(10000); caller.abort();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.signal.aborted, false);
  assert.equal(f.calls[0]!.request.signal.aborted, false); assert.equal(observed.cancelCalls(), 0);
});

test("mutation receipts keep their original body.cancel cleanup and exact command correlation", async (t) => {
  const cases: { request: CatalogRequest; value: unknown }[] = [
    { request: createCatalogCreateRequest("synthetic-create", PROFILE),
      value: { operationId: "synthetic-create", replayed: false, service: row() } },
    { request: createCatalogUpdateRequest("synthetic-service", 1, "synthetic-update", PROFILE),
      value: { operationId: "synthetic-update", replayed: false, service: row(2) } },
    { request: createCatalogDeleteRequest("synthetic-service", 2, "synthetic-delete"),
      value: { operationId: "synthetic-delete", replayed: false, service: row(3, "deleted") } },
  ];
  for (const { request, value } of cases) {
    const observed = reply(t, { ok: true, value }), caller = new AbortController();
    const f = fixture(async () => observed.response);
    const result = await f.call(request, caller.signal);
    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.equal(result.success.kind, "receipt");
      if (result.success.kind === "receipt") assert.deepEqual(result.success.receipt, value);
    }
    assert.equal(observed.cancelCalls(), 1); assert.equal(observed.body.locked, false);
    assert.equal(f.calls.length, 1); assert.deepEqual(await f.calls[0]!.request.json(), request.body);
    assert.equal(f.calls[0]!.signal.aborted, false);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  }
});

test("headers, malformed bytes/envelopes, HTTP errors and wrong-generation EOF still discard", async (t) => {
  for (const action of ["get", "list"] as const) {
    const cases = [
      { payload: readEnvelope(action), status: 200, headers: { ...HEADERS, "content-type": "text/html" },
        expected: { kind: "invalid", reason: "HEADERS" } },
      { payload: "not-json", status: 200, headers: HEADERS, expected: { kind: "invalid", reason: "BODY" } },
      { payload: { ...readEnvelope(action), extra: true }, status: 200, headers: HEADERS,
        expected: { kind: "invalid", reason: "ENVELOPE" } },
      { payload: readEnvelope(action, 2), status: 200, headers: HEADERS,
        expected: { kind: "invalid", reason: "ENVELOPE" } },
      { payload: { ok: false, code: "API_CONFLICT" }, status: 409, headers: HEADERS,
        expected: { kind: "error", code: "API_CONFLICT", retriableAfterMs: null } },
      { payload: readEnvelope(action), status: 200, headers: { ...HEADERS, "content-length": "1" },
        expected: { kind: "invalid", reason: "BODY" } },
    ];
    for (const entry of cases) {
      const observed = reply(t, entry.payload, entry.status, entry.headers);
      const f = fixture(async () => observed.response);
      assert.deepEqual(await f.call(readRequest(action)), entry.expected);
      assert.equal(observed.cancelCalls(), 1); assert.equal(observed.body.locked, false);
      assert.equal(f.calls.length, 1);
    }
  }
});

for (const failure of ["scope", "deadline", "caller"] as const) {
  test(`decoded EOF ${failure} failure at finish does not skip discard`, async (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    for (const action of ["get", "list"] as const) {
      now = 0;
      let baselineReads = 0;
      const baseline = fixture(async () => new Response(JSON.stringify(readEnvelope(action)), { headers: HEADERS }),
        { readViewContext: () => { baselineReads++; return CONTEXT; } });
      assert.equal((await baseline.call(readRequest(action))).kind, "success");
      const finalRead = baselineReads; assert.ok(finalRead > 5);
      let reads = 0, injected = false;
      const caller = new AbortController(), observed = reply(t, readEnvelope(action));
      const f = fixture(async () => observed.response, { readViewContext: () => {
        if (++reads === finalRead) {
          injected = true;
          if (failure === "scope") return { ...CONTEXT, viewScope: "synthetic-replacement" };
          if (failure === "deadline") now = 10000;
          else caller.abort();
        }
        return CONTEXT;
      } });
      assert.deepEqual(await f.call(readRequest(action), caller.signal),
        { kind: failure === "scope" ? "stale" : failure === "deadline" ? "timeout" : "aborted" });
      assert.equal(injected, true); assert.equal(observed.cancelCalls(), 1);
      assert.equal(observed.body.locked, false); assert.equal(getEventListeners(caller.signal, "abort").length, 0);
      if (failure !== "scope") assert.equal(f.calls[0]!.signal.aborted, true);
    }
  });
}

for (const stop of ["caller", "timeout"] as const) {
  test(`complete JSON and declared length without EOF still require ${stop} cancellation`, async (t) => {
    let now = 0, pulls = 0, sourceCancels = 0, settled = false;
    t.mock.method(performance, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const entered = barrier<void>(), caller = new AbortController();
    const bytes = new TextEncoder().encode(JSON.stringify(readEnvelope("list")));
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (++pulls === 1) { controller.enqueue(bytes); return undefined; }
      entered.resolve(); return new Promise<void>(() => {});
    }, cancel() { sourceCancels++; } }, { highWaterMark: 0 });
    const observed = observeBody(t, new Response(body, { headers: { ...HEADERS, "content-length": String(bytes.byteLength) } }));
    const f = fixture(async () => observed.response);
    const pending = f.call(readRequest("list"), caller.signal).then((result) => { settled = true; return result; });
    await entered.promise; assert.equal(settled, false);
    if (stop === "caller") caller.abort();
    else { now = 10000; t.mock.timers.tick(10000); }
    assert.deepEqual(await pending, { kind: stop === "caller" ? "aborted" : "timeout" });
    assert.equal(sourceCancels, 1); assert.equal(observed.cancelCalls(), 1);
    assert.equal(body.locked, false); assert.equal(f.calls[0]!.signal.aborted, true);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  });
}

test("a response arriving after timeout retains exact unread-body discard", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = barrier<Response>(), caller = new AbortController();
  const f = fixture(async () => gate.promise), pending = f.call(readRequest("get"), caller.signal);
  now = 10000; t.mock.timers.tick(10000);
  assert.deepEqual(await pending, { kind: "timeout" });
  const observed = reply(t, readEnvelope("get"));
  gate.resolve(observed.response); await setImmediate();
  assert.equal(observed.cancelCalls(), 1); assert.equal(observed.body.locked, false);
  assert.equal(observed.response.bodyUsed, true); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.signal.aborted, true);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});
