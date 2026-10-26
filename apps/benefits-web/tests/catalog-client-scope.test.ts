import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { CATALOG_VIEW_SCHEMA, createCatalogClient, createCatalogCreateRequest,
  createCatalogGetRequest, createCatalogListRequest, type CatalogClientConfig,
  type CatalogRequest, type CatalogViewContext } from "../src/domain/catalog-client/client.ts";

// Injected synthetic transport only. Local context is not authentication.
const origin = "https://synthetic.invalid";
const headers = { "content-type": "application/json", "cache-control": "private, no-store" };
const initial = Object.freeze({ viewScope: "synthetic-a-1", dataGeneration: 1 });
const profile = Object.freeze({ name: "Synthetic Service", provider: null, planName: null,
  accountLabel: null, timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null });
const get = () => createCatalogGetRequest("synthetic-service");
function row(generation = 1) {
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration: generation, serviceId: "synthetic-service",
    serviceRevision: 1, state: "live", profile, createdAt: 1, updatedAt: 1,
    provenance: "user-reported", accountProof: "not-established" };
}
function response(value: unknown = row()) { return new Response(JSON.stringify({ ok: true, value }), { headers }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function client(fetch: CatalogClientConfig["fetch"], extras: Partial<CatalogClientConfig> = {}) {
  return createCatalogClient({ origin, fetch, readViewContext: () => initial, ...extras });
}

test("view-context reader is required, with no implicit signed-in fallback", () => {
  for (const reader of [undefined, null, true, "synthetic-reader"]) {
    assert.throws(() => createCatalogClient({ origin, fetch: async () => response(),
      readViewContext: reader } as unknown as CatalogClientConfig), /CATALOG_CLIENT_CONFIG_INVALID/);
  }
});

test("invalid, signed-out, accessor or throwing context cannot invoke transport", async () => {
  let invoked = 0;
  let hooks = 0;
  const invalid: unknown[] = [null, undefined, {}, [],
    { viewScope: "", dataGeneration: 1 }, { viewScope: " padded", dataGeneration: 1 },
    { viewScope: "synthetic-view\n", dataGeneration: 1 },
    { viewScope: "a".repeat(129), dataGeneration: 1 }, { viewScope: "a", dataGeneration: 0 },
    { viewScope: "a", dataGeneration: 1.5 }, { viewScope: "a", dataGeneration: Infinity },
    { viewScope: "a", dataGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...initial, ownerId: "synthetic-owner" }, { ...initial, [Symbol("extra")]: 1 },
    Object.assign(Object.create({ inherited: true }), initial),
    Object.defineProperty({ dataGeneration: 1 }, "viewScope", { enumerable: true,
      get() { hooks++; return initial.viewScope; } }),
    Object.defineProperty({ dataGeneration: 1 }, "viewScope", { value: initial.viewScope }),
  ];
  for (const value of invalid) {
    const call = client(async () => { invoked++; return response(); },
      { readViewContext: (() => value) as CatalogClientConfig["readViewContext"] });
    assert.deepEqual(await call(get()), { kind: "stale" });
  }
  assert.deepEqual(await client(async () => { invoked++; return response(); },
    { readViewContext: () => { throw new Error("synthetic-private-detail"); } })(get()), { kind: "stale" });
  assert.equal(invoked, 0);
  assert.equal(hooks, 0);
});

test("success captures and freezes local scope plus generation without sending either as authority", async () => {
  let wire!: Request;
  const context: { viewScope: string; dataGeneration: number } = { ...initial };
  const result = await client(async (request) => { wire = request; return response(); },
    { readViewContext: () => context })(get());
  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  assert.deepEqual(result.capturedScope, initial);
  assert.notEqual(result.capturedScope, context);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.capturedScope));
  context.viewScope = "synthetic-mutated";
  assert.equal(result.capturedScope.viewScope, initial.viewScope);
  assert.deepEqual(await wire.json(), { serviceId: "synthetic-service" });
  assert.deepEqual([...wire.headers.keys()].sort(), ["content-type", "x-keyatlas-request"]);
});

for (const replacement of [null, { viewScope: "synthetic-b-1", dataGeneration: 1 },
  { viewScope: initial.viewScope, dataGeneration: 2 }]) {
  test(`context transition ${replacement?.viewScope ?? "logout"}/${replacement?.dataGeneration ?? 0} discards pending success and error`, async () => {
    for (const status of [200, 503]) {
      let context: CatalogViewContext | null = initial;
      const pending = deferred<Response>();
      let cancelled = false;
      let reads = 0;
      const call = client(() => pending.promise, { readViewContext: () => context });
      const result = call(get());
      context = replacement;
      const body = new ReadableStream<Uint8Array>({ pull() { reads++; }, cancel() { cancelled = true; } },
        { highWaterMark: 0 });
      pending.resolve(new Response(body, { status, headers }));
      assert.deepEqual(await result, { kind: "stale" });
      assert.equal(cancelled, true);
      assert.equal(reads, 0);
      assert.equal(body.locked, false);
    }
  });
}

test("scope changes during body read discard success, error and malformed bodies", async () => {
  for (const bodyText of [JSON.stringify({ ok: true, value: row() }),
    JSON.stringify({ ok: false, code: "API_UNAVAILABLE" }), "malformed-synthetic"]) {
    let context: CatalogViewContext = initial;
    const entered = deferred<void>();
    const release = deferred<void>();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      entered.resolve();
      await release.promise;
      controller.enqueue(new TextEncoder().encode(bodyText));
      // Remain open so cancellation of a stale body is observable.
    }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const call = client(async () => new Response(body, { headers,
      status: bodyText.includes("API_UNAVAILABLE") ? 503 : 200 }), { readViewContext: () => context });
    const result = call(get());
    await entered.promise;
    context = { viewScope: "synthetic-b-1", dataGeneration: 1 };
    release.resolve();
    assert.deepEqual(await result, { kind: "stale" });
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  }
});

test("A to B to fresh A cannot revive a pending response or reuse its request object", async () => {
  let context: CatalogViewContext = initial;
  const pending = deferred<Response>();
  let calls = 0;
  const call = client(() => { calls++; return calls === 1 ? pending.promise : Promise.resolve(response()); },
    { readViewContext: () => context });
  const original = get();
  const result = call(original);
  context = { viewScope: "synthetic-b-1", dataGeneration: 1 };
  context = { viewScope: "synthetic-a-2", dataGeneration: 1 };
  pending.resolve(response());
  assert.deepEqual(await result, { kind: "stale" });
  assert.deepEqual(await call(original), { kind: "stale" });
  assert.equal(calls, 1);
  // A new object is deliberately outside the WeakMap fence, not authenticated by it.
  const fresh = await call(get());
  assert.ok(fresh.kind === "success");
  assert.deepEqual(fresh.capturedScope, context);
  assert.equal(calls, 2);
});

test("same-scope explicit uncertain mutation retry preserves body while scope change makes zero new requests", async () => {
  let context: CatalogViewContext = initial;
  const bodies: unknown[] = [];
  const call = client(async (request) => { bodies.push(await request.json()); throw new Error("synthetic-uncertain"); },
    { readViewContext: () => context });
  const original = createCatalogCreateRequest("synthetic-operation", profile);
  assert.deepEqual(await call(original), { kind: "aborted" });
  assert.equal(bodies.length, 1);
  assert.deepEqual(await call(original), { kind: "aborted" });
  assert.deepEqual(bodies, [original.body, original.body]);
  context = { viewScope: "synthetic-b-1", dataGeneration: 1 };
  assert.deepEqual(await call(original), { kind: "stale" });
  assert.equal(bodies.length, 2);
});

test("captured generation must match get, receipt and even empty list responses", async () => {
  const cases = [
    { request: get(), value: row(2) },
    { request: createCatalogCreateRequest("synthetic-operation", profile),
      value: { operationId: "synthetic-operation", replayed: false, service: row(2) } },
    { request: createCatalogListRequest(10, null), value: { schema: CATALOG_VIEW_SCHEMA,
      dataGeneration: 2, catalogRevision: 1, services: [], nextCursor: null } },
  ];
  for (const entry of cases) assert.deepEqual(await client(async () => response(entry.value))(entry.request),
    { kind: "invalid", reason: "ENVELOPE" });
});

test("a cursor from another generation fails before transport", async () => {
  let calls = 0;
  const call = client(async () => { calls++; return response(); });
  assert.deepEqual(await call(createCatalogListRequest(10, { dataGeneration: 2,
    catalogRevision: 1, afterId: "synthetic-service" })), { kind: "invalid", reason: "REQUEST" });
  assert.equal(calls, 0);
});

test("malformed signal and already-aborted caller cannot invoke transport or reveal abort reason", async () => {
  let calls = 0;
  const call = client(async () => { calls++; return response(); });
  for (const value of [null, {}, { aborted: false }]) {
    assert.deepEqual(await call(get(), value as AbortSignal), { kind: "invalid", reason: "REQUEST" });
  }
  const caller = new AbortController();
  caller.abort(new Error("synthetic-private-reason"));
  assert.deepEqual(await call(get(), caller.signal), { kind: "aborted" });
  assert.equal(calls, 0);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

for (const late of ["resolve", "reject"] as const) {
  test(`caller abort settles immediately; ignored transport late ${late} is handled`, async () => {
    const caller = new AbortController();
    const pending = deferred<Response>();
    let cancelled = false;
    let transportSignal!: AbortSignal;
    const call = client((_request, signal) => { transportSignal = signal; return pending.promise; });
    const result = call(get(), caller.signal);
    caller.abort(new Error("synthetic-private-reason"));
    assert.deepEqual(await result, { kind: "aborted" });
    assert.equal(transportSignal.aborted, true);
    if (late === "resolve") pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers }));
    else pending.reject(new Error("synthetic-private-late-error"));
    await setImmediate();
    assert.equal(cancelled, late === "resolve");
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  });
}

for (const chunkSize of [0, 1]) {
  test(`immediate ${chunkSize}-byte chunks yield to caller abort and clean stalled cancellation`, { timeout: 3000 }, async () => {
    const caller = new AbortController();
    let pulls = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (pulls++ === 0) timer = setTimeout(() => caller.abort(), 0);
      controller.enqueue(new Uint8Array(chunkSize).fill(32));
    }, cancel() { cancelled = true; return new Promise<void>(() => undefined); } }, { highWaterMark: 0 });
    try {
      assert.deepEqual(await client(async () => new Response(body, { headers }))(get(), caller.signal), { kind: "aborted" });
      assert.ok(pulls > 0);
      assert.equal(cancelled, true);
      assert.equal(body.locked, false);
      assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  });
}

test("first stop wins when caller abort races the monotonic deadline", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  for (const abortAt of [99, 100, 101]) {
    now = 0;
    const caller = new AbortController();
    const pending = deferred<Response>();
    const result = client(() => pending.promise, { timeoutMs: 100 })(get(), caller.signal);
    now = abortAt;
    caller.abort();
    now = 200;
    assert.deepEqual(await result, { kind: abortAt < 100 ? "aborted" : "timeout" });
    pending.reject(new Error("synthetic-late-failure"));
    await setImmediate();
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  }
});

for (const stopped of ["abort", "timeout"] as const) {
  test(`a changed or unreadable context outranks ${stopped} before failure delivery`, async (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    for (const replacement of [null, { viewScope: "synthetic-b-1", dataGeneration: 1 },
      { ...initial, dataGeneration: 2 }, "throw"] as const) {
      now = 0;
      let context: CatalogViewContext | null = initial;
      let unreadable = false;
      const caller = new AbortController();
      const pending = deferred<Response>();
      const call = client(() => pending.promise, { timeoutMs: 100,
        readViewContext: () => {
          if (unreadable) throw new Error("synthetic-private-context-error");
          return context;
        } });
      const result = call(get(), caller.signal);
      if (replacement === "throw") unreadable = true;
      else context = replacement;
      now = stopped === "timeout" ? 100 : 1;
      caller.abort(new Error("synthetic-private-abort-reason"));
      assert.deepEqual(await result, { kind: "stale" });
      pending.reject(new Error("synthetic-private-late-error"));
      await setImmediate();
      assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    }
  });
}

test("caller listeners are removed for success, malformed request/body, stale, rejection, abort and timeout", async () => {
  for (const outcome of ["success", "request", "body", "stale", "rejection", "abort", "timeout"] as const) {
    const caller = new AbortController();
    let context: CatalogViewContext = initial;
    const call = client(async () => {
      if (outcome === "rejection") throw new Error("synthetic-adapter-detail");
      if (outcome === "abort") caller.abort();
      if (outcome === "stale") context = { viewScope: "synthetic-b-1", dataGeneration: 1 };
      if (outcome === "timeout") return new Promise<Response>(() => undefined);
      return outcome === "body" ? new Response("bad-json", { headers }) : response();
    }, { timeoutMs: outcome === "timeout" ? 10 : 1000, readViewContext: () => context });
    const result = await call(outcome === "request" ? {} as CatalogRequest : get(), caller.signal);
    const expected = outcome === "request" || outcome === "body" ? "invalid"
      : outcome === "rejection" || outcome === "abort" ? "aborted" : outcome;
    assert.equal(result.kind, expected);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0, outcome);
  }
});

test("completed call clears its timer and detaches from later caller cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const caller = new AbortController();
  let signal!: AbortSignal;
  const result = await client(async (_request, transportSignal) => { signal = transportSignal; return response(); })(get(), caller.signal);
  assert.equal(result.kind, "success");
  t.mock.timers.tick(10000);
  caller.abort();
  assert.equal(signal.aborted, false);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});
