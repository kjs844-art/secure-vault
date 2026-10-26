import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogTransport } from "../src/domain/catalog-client/client.ts";
import { CATALOG_VIEW_SCHEMA } from "../src/domain/catalog-client/responses.ts";
import { createCatalogSelectionSource, type CatalogSelectionSource,
  type CatalogSelectionSnapshot } from "../src/domain/catalog-client/selection-source.ts";

// Real client/controller/reducer/store/page-session composition; synthetic
// bounded Fetch bodies, not authentication, a browser, or deployed endpoints.
const ORIGIN = "https://synthetic.local";
const CONTEXT = Object.freeze({ bindingId: "synthetic-A", dataGeneration: 1 });
function row(index: number) {
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, serviceId: `svc-${String(index).padStart(4, "0")}`,
    serviceRevision: 1, state: "live", profile: { name: `Synthetic ${index}`, provider: null, planName: null,
      accountLabel: null, timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null },
    createdAt: 1, updatedAt: 1, provenance: "user-reported", accountProof: "not-established" };
}
function page(start = 1, count = 1, more = false, catalogRevision = 7) {
  const services = Array.from({ length: count }, (_, offset) => row(start + offset));
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, catalogRevision, services,
    nextCursor: more ? { afterId: services.at(-1)!.serviceId, dataGeneration: 1, catalogRevision } : null };
}
function response(value: unknown) {
  return new Response(JSON.stringify({ ok: true, value }), { status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function errorResponse(code = "API_UNAVAILABLE", status = 503) {
  return new Response(JSON.stringify({ ok: false, code }), { status,
    headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(fetch: CatalogTransport = async () => response(page()), timeoutMs = 1000) {
  const source = createCatalogSelectionSource({ origin: ORIGIN, fetch, timeoutMs });
  const lease = Object.freeze({});
  const initial = source.activate({ lease, context: CONTEXT });
  assert.ok(initial);
  return { source, lease, initial };
}
function current(source: CatalogSelectionSource): CatalogSelectionSnapshot {
  const snapshot = source.getSnapshot(); assert.ok(snapshot); return snapshot;
}
function next(source: CatalogSelectionSource) { return source.next(current(source)); }

test("construction and activation are inert, cached, frozen and never expose raw cursors", () => {
  let calls = 0;
  const source = createCatalogSelectionSource({ origin: ORIGIN, fetch: async () => { calls++; return response(page()); } });
  assert.equal(source.getSnapshot(), null);
  let notifications = 0; source.subscribe(() => notifications++);
  const lease = {};
  const snapshot = source.activate({ lease, context: CONTEXT });
  assert.deepEqual(snapshot, { lease, context: CONTEXT, phase: "ready", pagesAccepted: 0,
    pageRowsObserved: 0, services: [], failure: null });
  assert.equal(source.getSnapshot(), snapshot);
  assert.ok(Object.isFrozen(source) && Object.isFrozen(snapshot) && Object.isFrozen(snapshot!.services)
    && Object.isFrozen(snapshot!.context));
  assert.equal(Object.hasOwn(snapshot!, "cursor"), false);
  assert.equal(calls, 0); assert.equal(notifications, 1);
  source.dispose();
});

test("explicit pages render accumulated store observations and exact private cursor", async () => {
  const bodies: unknown[] = [], first = page(1, 50, true);
  const f = fixture(async (request) => {
    assert.equal(request.url, ORIGIN + "/api/catalog/list");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("x-keyatlas-request"), "catalog-v1");
    bodies.push(await request.json());
    return response(bodies.length === 1 ? first : page(51, 2));
  });
  try {
    assert.equal(await next(f.source), true);
    assert.equal(current(f.source).phase, "more");
    assert.equal(current(f.source).services.length, 50);
    const firstSnapshot = current(f.source);
    const work = next(f.source);
    assert.equal(current(f.source).phase, "loading");
    assert.deepEqual(current(f.source).services, []);
    assert.equal(await work, true);
    const done = current(f.source);
    assert.equal(done.phase, "end_observed");
    assert.equal(done.pagesAccepted, 2); assert.equal(done.pageRowsObserved, 52);
    assert.deepEqual(done.services.map((entry) => entry.serviceId), Array.from({ length: 52 }, (_, i) => row(i + 1).serviceId));
    assert.equal(firstSnapshot.services.length, 50); // Old references are historical, not erased.
    assert.ok(Object.isFrozen(done.services) && Object.isFrozen(done.services[0]!.profile));
    assert.deepEqual(bodies, [{ limit: 50, cursor: null }, { limit: 50, cursor: first.nextCursor }]);
    assert.equal(await next(f.source), false); assert.equal(bodies.length, 2);
  } finally { f.source.dispose(); }
});

test("old callbacks and duplicate next send no extra HTTP while loading or after completion", async () => {
  const held = deferred<Response>(); let calls = 0;
  const f = fixture(async () => { calls++; return held.promise; });
  try {
    const first = next(f.source);
    assert.equal(await f.source.next(f.initial), false);
    assert.equal(await next(f.source), false);
    assert.equal(f.source.restart(f.initial), null);
    assert.equal(f.source.cancel(f.initial), false);
    held.resolve(response(page())); assert.equal(await first, true);
    assert.equal(await f.source.next(f.initial), false); assert.equal(calls, 1);
  } finally { f.source.dispose(); }
});

test("503 masks accumulated rows; explicit retry keeps the exact accepted cursor and restores store rows", async () => {
  const bodies: unknown[] = []; const first = page(1, 50, true);
  const f = fixture(async (request) => {
    bodies.push(await request.json());
    return bodies.length === 1 ? response(first) : bodies.length === 2 ? errorResponse() : response(page(51, 1));
  });
  try {
    await next(f.source); await next(f.source);
    const failed = current(f.source);
    assert.equal(failed.phase, "retry_required"); assert.deepEqual(failed.services, []);
    assert.deepEqual(failed.failure, { kind: "error", code: "API_UNAVAILABLE", retriableAfterMs: null });
    assert.equal(bodies.length, 2);
    await next(f.source);
    assert.deepEqual(bodies[1], bodies[2]);
    assert.equal(current(f.source).services.length, 51); assert.equal(current(f.source).failure, null);
  } finally { f.source.dispose(); }
});

test("409 stays restart_required, explicit restart is request-free and retains external lease only", async () => {
  const bodies: unknown[] = [];
  const f = fixture(async (request) => {
    bodies.push(await request.json());
    return bodies.length === 1 ? response(page(1, 50, true)) : bodies.length === 2 ? errorResponse("API_CONFLICT", 409)
      : response(page(3, 1, false, 9));
  });
  try {
    await next(f.source); await next(f.source);
    const failed = current(f.source);
    assert.equal(failed.phase, "restart_required"); assert.deepEqual(failed.services, []);
    assert.equal(await next(f.source), false); assert.equal(bodies.length, 2);
    const fresh = f.source.restart(failed); assert.ok(fresh);
    assert.equal(fresh.lease, f.lease); assert.equal(fresh.phase, "ready");
    assert.equal(fresh.pagesAccepted, 0); assert.equal(bodies.length, 2);
    assert.equal(await f.source.next(failed), false);
    await next(f.source);
    assert.deepEqual(bodies[2], { limit: 50, cursor: null });
    assert.deepEqual(current(f.source).services.map((entry) => entry.serviceId), ["svc-0003"]);
  } finally { f.source.dispose(); }
});

for (const [code, status] of [["API_AUTH_REQUIRED", 401], ["API_SESSION_CHANGED", 403], ["API_REQUEST_REJECTED", 403]] as const) {
  test(`${code} is preserved for the host to retire the review lease, with no automatic retry`, async () => {
    let calls = 0; const f = fixture(async () => { calls++; return errorResponse(code, status); });
    try {
      await next(f.source);
      assert.deepEqual(current(f.source).failure, { kind: "error", code, retriableAfterMs: null });
      assert.deepEqual(current(f.source).services, []); assert.equal(calls, 1);
    } finally { f.source.dispose(); }
  });
}

test("429 remains explicit, bounded rate detail survives, and no retry timer starts", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return new Response(JSON.stringify({ ok: false, code: "API_RATE_LIMITED" }),
    { status: 429, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "2" } }); });
  try {
    await next(f.source); assert.equal(calls, 1);
    assert.deepEqual(current(f.source).failure, { kind: "error", code: "API_RATE_LIMITED", retriableAfterMs: 2000 });
  } finally { f.source.dispose(); }
});

for (const [label, mutate] of [
  ["wrong generation", (value: ReturnType<typeof page>) => ({ ...value, dataGeneration: 2 })],
  ["wrong cursor revision", (value: ReturnType<typeof page>) => ({ ...value, nextCursor: { ...value.nextCursor!, catalogRevision: 9 } })],
  ["nonadvancing cursor", (value: ReturnType<typeof page>) => ({ ...value, nextCursor: { ...value.nextCursor!, afterId: "svc-0001" } })],
  ["deleted list row", (value: ReturnType<typeof page>) => ({ ...value, services: [{ ...value.services[0], state: "deleted", profile: null }] })],
] as const) {
  test(`malformed ${label} cannot expose rows or advance traversal`, async () => {
    const f = fixture(async () => response(mutate(page(1, 50, true))));
    try {
      await next(f.source); const state = current(f.source);
      assert.equal(state.phase, "retry_required"); assert.equal(state.pagesAccepted, 0);
      assert.deepEqual(state.services, []); assert.equal(state.failure?.kind, "invalid");
    } finally { f.source.dispose(); }
  });
}

test("cancel aborts pending transport, clears source and requires manual restart before HTTP", async () => {
  const held = deferred<Response>(); let signal: AbortSignal | undefined; let calls = 0;
  const f = fixture(async (_request, inputSignal) => { signal = inputSignal; calls++; return calls === 1 ? held.promise : response(page(2)); });
  try {
    const work = next(f.source), pending = current(f.source);
    assert.equal(f.source.cancel(pending), true); assert.equal(signal?.aborted, true);
    assert.equal(current(f.source).phase, "restart_required"); assert.deepEqual(current(f.source).services, []);
    assert.equal(await work, false); assert.equal(await next(f.source), false);
    const fresh = f.source.restart(current(f.source)); assert.ok(fresh); assert.equal(calls, 1);
    await next(f.source);
    held.resolve(response(page(9))); await Promise.resolve();
    assert.deepEqual(current(f.source).services.map((entry) => entry.serviceId), ["svc-0002"]);
    assert.equal(calls, 2);
  } finally { f.source.dispose(); }
});

test("cancel after a successful page also hides it and does not automatically reload", async () => {
  let calls = 0; const f = fixture(async () => { calls++; return response(page()); });
  try {
    await next(f.source); assert.equal(f.source.cancel(current(f.source)), true);
    const cancelled = current(f.source); assert.deepEqual(cancelled.services, []);
    assert.equal(cancelled.pageRowsObserved, 1); assert.equal(f.source.cancel(cancelled), false);
    assert.equal(await next(f.source), false); assert.equal(calls, 1);
  } finally { f.source.dispose(); }
});

// These exercise actual owner/client composition with native in-memory streams.
// Signal state is not evidence of a browser requestfinished/requestfailed event.
for (const action of ["cancel", "restart", "deactivate", "dispose"] as const) {
  test(`completed page ${action} does not abort its settled transport or reread`, async () => {
    let signal: AbortSignal | undefined, calls = 0, bodyEnded = false, sourceCancels = 0, sent = false;
    const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, value: page() }));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(bytes); }
        else { bodyEnded = true; controller.close(); }
      },
      cancel() { sourceCancels++; },
    }, { highWaterMark: 0 });
    const reply = new Response(body, { status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" } });
    const f = fixture(async (_request, inputSignal) => { signal = inputSignal; calls++; return reply; });
    try {
      assert.equal(await next(f.source), true);
      const completed = current(f.source);
      assert.equal(completed.phase, "end_observed");
      assert.equal(completed.services[0]!.serviceId, "svc-0001");
      assert.equal(bodyEnded, true); assert.equal(reply.bodyUsed, true); assert.equal(body.locked, false);
      assert.ok(signal); assert.equal(signal.aborted, false);
      if (action === "cancel") {
        assert.equal(f.source.cancel(completed), true);
        assert.equal(current(f.source).phase, "restart_required");
      } else if (action === "restart") {
        const fresh = f.source.restart(completed); assert.ok(fresh);
        assert.notEqual(fresh, completed); assert.equal(fresh.phase, "ready");
      } else if (action === "deactivate") f.source.deactivate(f.lease);
      else f.source.dispose();
      assert.deepEqual(f.source.getSnapshot()?.services ?? [], []);
      if (action === "deactivate" || action === "dispose") assert.equal(f.source.getSnapshot(), null);
      assert.equal(await f.source.next(completed), false);
      assert.equal(calls, 1); assert.equal(sourceCancels, 0); assert.equal(signal.aborted, false);
      f.source.dispose();
      assert.equal(signal.aborted, false); assert.equal(sourceCancels, 0);
    } finally { f.source.dispose(); }
  });

  test(`200 headers without body EOF remain pending and ${action} aborts without publishing the page`, { timeout: 3000 }, async () => {
    const waitingForEof = deferred<void>();
    let signal: AbortSignal | undefined, calls = 0, sourceCancels = 0, sent = false;
    const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, value: page(99) }));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(bytes); }
        else waitingForEof.resolve(); // Complete JSON is not complete response EOF.
      },
      cancel() { sourceCancels++; },
    }, { highWaterMark: 0 });
    const reply = new Response(body, { status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" } });
    const f = fixture(async (_request, inputSignal) => { signal = inputSignal; calls++; return reply; });
    try {
      const work = next(f.source);
      await waitingForEof.promise;
      const pending = current(f.source);
      assert.equal(reply.status, 200); assert.equal(pending.phase, "loading");
      assert.deepEqual(pending.services, []); assert.ok(signal); assert.equal(signal.aborted, false);
      if (action === "cancel") assert.equal(f.source.cancel(pending), true);
      else if (action === "restart") assert.ok(f.source.restart(pending));
      else if (action === "deactivate") f.source.deactivate(f.lease);
      else f.source.dispose();
      assert.equal(signal.aborted, true); assert.equal(await work, false);
      assert.equal(await f.source.next(pending), false);
      assert.deepEqual(f.source.getSnapshot()?.services ?? [], []);
      assert.equal(f.source.getSnapshot()?.pagesAccepted ?? 0, 0);
      assert.equal(calls, 1); assert.equal(sourceCancels, 1); assert.equal(body.locked, false);
      if (action === "deactivate" || action === "dispose") assert.equal(f.source.getSnapshot(), null);
    } finally { f.source.dispose(); }
  });
}

test("same external lease and equal context activation still fences old request and snapshot", async () => {
  const held = deferred<Response>(); let calls = 0;
  const f = fixture(async () => ++calls === 1 ? held.promise : response(page(2)));
  try {
    const oldWork = next(f.source), old = current(f.source);
    const fresh = f.source.activate({ lease: f.lease, context: { ...CONTEXT } }); assert.ok(fresh);
    assert.notEqual(fresh, old); assert.equal(await f.source.next(old), false);
    assert.equal(await oldWork, false); await next(f.source);
    held.resolve(response(page(9))); await Promise.resolve();
    assert.equal(current(f.source).services[0]!.serviceId, "svc-0002");
  } finally { f.source.dispose(); }
});

test("A to B to fresh A rejects original A callbacks and late payload without clearing fresh A", async () => {
  const held = deferred<Response>(); let calls = 0;
  const f = fixture(async () => ++calls === 1 ? held.promise : response(page(3)));
  try {
    const oldWork = next(f.source), oldA = current(f.source);
    f.source.activate({ lease: {}, context: { bindingId: "synthetic-B", dataGeneration: 1 } });
    const freshLease = {}; f.source.activate({ lease: freshLease, context: CONTEXT });
    f.source.deactivate(f.lease); assert.equal(current(f.source).lease, freshLease);
    assert.equal(f.source.cancel(oldA), false); assert.equal(f.source.restart(oldA), null);
    assert.equal(await f.source.next(oldA), false); assert.equal(await oldWork, false);
    await next(f.source); held.resolve(response(page(99))); await Promise.resolve();
    assert.equal(current(f.source).services[0]!.serviceId, "svc-0003"); assert.equal(calls, 2);
  } finally { f.source.dispose(); }
});

test("deactivation and disposal revoke pending work even if transport never resolves", async () => {
  for (const action of ["deactivate", "dispose"] as const) {
    let signal: AbortSignal | undefined;
    const f = fixture(async (_request, inputSignal) => { signal = inputSignal; return new Promise<Response>(() => {}); });
    const work = next(f.source);
    if (action === "dispose") f.source.dispose(); else f.source.deactivate(f.lease);
    assert.equal(f.source.getSnapshot(), null); assert.equal(signal?.aborted, true);
    assert.equal(await work, false); f.source.dispose();
  }
});

test("subscriber cancellation at loading prevents HTTP entirely", async () => {
  let calls = 0; const f = fixture(async () => { calls++; return response(page()); });
  try {
    f.source.subscribe(() => { const state = f.source.getSnapshot(); if (state?.phase === "loading") f.source.cancel(state); });
    assert.equal(await next(f.source), false); assert.equal(calls, 0);
    assert.equal(current(f.source).phase, "restart_required");
  } finally { f.source.dispose(); }
});

test("subscriber deactivation during completion prevents a true result or ready payload", async () => {
  const f = fixture();
  try {
    f.source.subscribe(() => { if (f.source.getSnapshot()?.phase === "end_observed") f.source.deactivate(f.lease); });
    assert.equal(await next(f.source), false); assert.equal(f.source.getSnapshot(), null);
  } finally { f.source.dispose(); }
});

test("subscriber deactivation of previous lease overrides a new activation transition", () => {
  const f = fixture();
  f.source.subscribe(() => { if (f.source.getSnapshot() === null) f.source.deactivate(f.lease); });
  assert.equal(f.source.activate({ lease: {}, context: CONTEXT }), null);
  assert.equal(f.source.getSnapshot(), null); f.source.dispose();
});

test("reentrant next/restart/activate are refused during notifications; observer throws do not prevent revoke", async () => {
  const f = fixture(); const calls: Promise<boolean>[] = [];
  const observations: { phase: CatalogSelectionSnapshot["phase"]; restart: CatalogSelectionSnapshot | null;
    activate: CatalogSelectionSnapshot | null }[] = [];
  f.source.subscribe(() => {
    const state = f.source.getSnapshot(); if (!state) return;
    calls.push(f.source.next(state));
    // notify intentionally contains observer exceptions. Assert outside this
    // callback so an AssertionError cannot be mistaken for the intended throw.
    observations.push({ phase: state.phase, restart: f.source.restart(state),
      activate: f.source.activate({ lease: {}, context: CONTEXT }) });
    throw new Error("synthetic observer");
  });
  try {
    assert.equal(await next(f.source), true);
    assert.deepEqual(await Promise.all(calls), [false, false]);
    assert.deepEqual(observations, [
      { phase: "loading", restart: null, activate: null },
      { phase: "end_observed", restart: null, activate: null },
    ]);
    f.source.deactivate(f.lease); assert.equal(f.source.getSnapshot(), null);
  } finally { f.source.dispose(); }
});

test("ordinary binding getters do not run and malformed replacement clears the old source", async () => {
  let getterCalls = 0; const f = fixture();
  try {
    await next(f.source);
    assert.equal(f.source.activate({ lease: f.lease, get context() { getterCalls++; return CONTEXT; } }), null);
    assert.equal(getterCalls, 0); assert.equal(f.source.getSnapshot(), null);
    assert.equal(f.source.activate({ lease: {}, context: { ...CONTEXT, extra: true } }), null);
    assert.equal(f.source.activate({ lease: [], context: CONTEXT }), null);
  } finally { f.source.dispose(); }
});

test("binding reflection reentrancy cannot resurrect after previous-lease deactivation", () => {
  const f = fixture();
  const reflected = new Proxy({ lease: {}, context: CONTEXT }, { ownKeys(target) {
    f.source.deactivate(f.lease); return Reflect.ownKeys(target);
  } });
  assert.equal(f.source.activate(reflected), null); assert.equal(f.source.getSnapshot(), null); f.source.dispose();
});

test("20 full pages with another cursor stop at 1000 rows and mask bounded observations", async () => {
  let calls = 0; const f = fixture(async () => response(page(calls++ * 50 + 1, 50, true)));
  try {
    for (let index = 0; index < 20; index++) await next(f.source);
    const state = current(f.source);
    assert.equal(state.pagesAccepted, 20); assert.equal(state.pageRowsObserved, 1000);
    assert.equal(state.phase, "restart_required"); assert.deepEqual(state.services, []);
    assert.equal(await next(f.source), false); assert.equal(calls, 20);
  } finally { f.source.dispose(); }
});

test("20 pages ending exactly at 1000 can observe an end, not claim snapshot freshness", async () => {
  let calls = 0; const f = fixture(async () => { const index = calls++; return response(page(index * 50 + 1, 50, index < 19)); });
  try {
    for (let index = 0; index < 20; index++) await next(f.source);
    assert.equal(current(f.source).phase, "end_observed"); assert.equal(current(f.source).services.length, 1000);
    assert.equal(await next(f.source), false); assert.equal(calls, 20);
  } finally { f.source.dispose(); }
});

test("empty end page does not erase accepted earlier store observations", async () => {
  let calls = 0; const f = fixture(async () => response(++calls === 1 ? page(1, 50, true) : page(51, 0)));
  try {
    await next(f.source); await next(f.source);
    assert.equal(current(f.source).phase, "end_observed"); assert.equal(current(f.source).services.length, 50);
    assert.equal(current(f.source).pageRowsObserved, 50);
  } finally { f.source.dispose(); }
});

test("real transport deadline is a fixed failure and does not restart automatically", async () => {
  const f = fixture(async () => new Promise<Response>(() => {}), 50);
  try {
    await next(f.source);
    assert.equal(current(f.source).phase, "retry_required"); assert.deepEqual(current(f.source).failure, { kind: "timeout" });
  } finally { f.source.dispose(); }
});
