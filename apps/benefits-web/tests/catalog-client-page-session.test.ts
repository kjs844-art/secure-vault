import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogTransport } from "../src/domain/catalog-client/client.ts";
import { createCatalogPageSession, CATALOG_PAGE_SIZE, MAX_CATALOG_SESSION_PAGES,
  type CatalogPageSession } from "../src/domain/catalog-client/page-session.ts";
import { createCatalogCreateRequest, createCatalogGetRequest, createCatalogListRequest,
  createCatalogUpdateRequest } from "../src/domain/catalog-client/requests.ts";
import { CATALOG_VIEW_SCHEMA } from "../src/domain/catalog-client/responses.ts";
import { MAX_CATALOG_VIEW_COMMANDS } from "../src/domain/catalog-client/view-controller.ts";
import { createCatalogViewStore, type CatalogViewLease, type CatalogViewStore } from "../src/domain/catalog-client/view-store.ts";
import { createServiceCatalog } from "../src/server/catalog/service-catalog.ts";
import { startCatalogLoopback } from "./support/catalog-http-loopback.ts";

// Actual client/controller/store with injected synthetic Fetch bodies only.
// Not a browser/UI, operational route, authentication, or full-snapshot proof.
const ORIGIN = "https://synthetic.local";
function profile() {
  return { name: "Synthetic service", provider: null, planName: null, accountLabel: null,
    timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null };
}
function row(index: number, serviceRevision = 1) {
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, serviceId: `svc-${String(index).padStart(4, "0")}`,
    serviceRevision, state: "live", profile: profile(), createdAt: 1, updatedAt: serviceRevision,
    provenance: "user-reported", accountProof: "not-established" };
}
function page(start: number, count: number, more = false, catalogRevision = 7) {
  const services = Array.from({ length: count }, (_, offset) => row(start + offset));
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, catalogRevision, services,
    nextCursor: more ? { afterId: services.at(-1)!.serviceId, catalogRevision, dataGeneration: 1 } : null };
}
function response(value: unknown) {
  return new Response(JSON.stringify({ ok: true, value }), {
    status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
function errorResponse(code = "API_UNAVAILABLE", status = 503) {
  return new Response(JSON.stringify({ ok: false, code }), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
function fixture(fetch: CatalogTransport = async () => response(page(1, 0)), timeoutMs = 1000) {
  const store = createCatalogViewStore({ origin: ORIGIN, fetch, timeoutMs });
  const lease = store.activate({ bindingId: "synthetic-A", dataGeneration: 1 })!;
  assert.ok(lease);
  return { store, lease, session: createCatalogPageSession(store, lease) };
}
function command(store: CatalogViewStore, lease: CatalogViewLease, input: unknown = createCatalogGetRequest("svc-0001")) {
  const prepared = store.prepare(lease, input);
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("synthetic-command-failed");
  return prepared.command;
}
function assertNoPreparedLeak(store: CatalogViewStore, lease: CatalogViewLease) {
  const tokens = Array.from({ length: MAX_CATALOG_VIEW_COMMANDS }, () => command(store, lease));
  assert.deepEqual(store.prepare(lease, createCatalogGetRequest("svc-0001")), { kind: "capacity" });
  for (const token of tokens) store.release(lease, token);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("construction is inert, progress is cached/frozen and raw cursors or rows are not exposed", () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return response(page(1, 0)); });
  const before = f.session.getSnapshot();
  assert.deepEqual(before, { phase: "ready", pagesAccepted: 0, pageRowsObserved: 0 });
  assert.equal(f.session.getSnapshot(), before);
  assert.ok(Object.isFrozen(f.session) && Object.isFrozen(before));
  assert.equal(Object.hasOwn(before!, "cursor"), false);
  assert.equal(Object.hasOwn(before!, "services"), false);
  assert.equal(calls, 0);
  f.session.dispose(); f.store.dispose();
});

test("only explicit next calls traverse null then the exact last accepted cursor", async () => {
  const bodies: unknown[] = [];
  const pages = [page(1, 50, true), page(51, 50, true), page(101, 2)];
  const f = fixture(async (request) => {
    assert.equal(request.url, ORIGIN + "/api/catalog/list");
    assert.equal(request.method, "POST");
    bodies.push(await request.json());
    return response(pages[bodies.length - 1]);
  });
  try {
    for (let index = 0; index < pages.length; index++) {
      assert.equal(bodies.length, index);
      const result = await f.session.next();
      assert.equal(result.kind, "page");
      assert.equal(f.session.getSnapshot()!.pagesAccepted, index + 1);
      assertNoPreparedLeak(f.store, f.lease);
    }
    assert.deepEqual(bodies, [
      { limit: 50, cursor: null }, { limit: 50, cursor: pages[0]!.nextCursor },
      { limit: 50, cursor: pages[1]!.nextCursor },
    ]);
    assert.deepEqual(f.session.getSnapshot(), { phase: "end_observed", pagesAccepted: 3, pageRowsObserved: 102 });
    assert.equal(f.store.getSnapshot()!.state.entries.length, 102);
    const terminal = f.session.getSnapshot();
    assert.deepEqual(await f.session.next(), { kind: "end_observed" });
    assert.equal(f.session.getSnapshot(), terminal);
    assert.equal(bodies.length, 3);
  } finally { f.session.dispose(); f.store.dispose(); }
});

test("concurrent next calls are busy and send only one page request", async () => {
  const held = deferred<Response>();
  let calls = 0;
  const f = fixture(async () => { calls++; return held.promise; });
  try {
    const first = f.session.next();
    assert.equal(f.session.getSnapshot()!.phase, "loading");
    assert.deepEqual(await f.session.next(), { kind: "busy" });
    assert.equal(calls, 1);
    held.resolve(response(page(1, 1)));
    assert.equal((await first).kind, "page");
    assert.equal(f.session.getSnapshot()!.pagesAccepted, 1);
    assertNoPreparedLeak(f.store, f.lease);
  } finally { f.session.dispose(); f.store.dispose(); }
});

test("503 does not retry or advance and the explicit retry reuses the unchanged cursor", async () => {
  const bodies: unknown[] = [];
  const first = page(1, 50, true);
  const f = fixture(async (request) => {
    bodies.push(await request.json());
    return bodies.length === 1 ? response(first)
      : bodies.length === 2 ? errorResponse() : response(page(51, 1));
  });
  try {
    await f.session.next();
    const state = f.store.getSnapshot();
    assert.deepEqual(await f.session.next(), { kind: "retry_required" });
    assert.deepEqual(f.session.getSnapshot(), { phase: "retry_required", pagesAccepted: 1, pageRowsObserved: 50 });
    assert.equal(f.store.getSnapshot(), state);
    assert.equal(bodies.length, 2);
    assertNoPreparedLeak(f.store, f.lease);
    assert.equal((await f.session.next()).kind, "page");
    assert.deepEqual(bodies[1], bodies[2]);
    assert.equal(f.session.getSnapshot()!.pageRowsObserved, 51);
  } finally { f.session.dispose(); f.store.dispose(); }
});

test("local timeout is retryable only explicitly, releases the command and ignores late data", async () => {
  let calls = 0;
  let signal!: AbortSignal;
  const held = deferred<Response>();
  const f = fixture(async (_request, currentSignal) => {
    signal = currentSignal;
    return ++calls === 1 ? held.promise : response(page(1, 1));
  }, 1000);
  try {
    assert.deepEqual(await f.session.next(), { kind: "retry_required" });
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
    assert.equal(f.session.getSnapshot()!.pagesAccepted, 0);
    assertNoPreparedLeak(f.store, f.lease);
    held.resolve(response(page(1, 50, true)));
    assert.equal((await f.session.next()).kind, "page");
    assert.equal(calls, 2);
    assert.equal(f.session.getSnapshot()!.pageRowsObserved, 1);
  } finally { f.session.dispose(); f.store.dispose(); }
});

test("malformed page cannot advance the cursor or replace current observations", async () => {
  const bodies: unknown[] = [];
  const malformed = { ...page(1, 50, true), nextCursor: { afterId: "svc-0001", dataGeneration: 1, catalogRevision: 7 } };
  const f = fixture(async (request) => { bodies.push(await request.json()); return response(malformed); });
  try {
    const state = f.store.getSnapshot();
    for (let index = 0; index < 2; index++) {
      assert.deepEqual(await f.session.next(), { kind: "retry_required" });
      assert.equal(f.store.getSnapshot(), state);
      assertNoPreparedLeak(f.store, f.lease);
    }
    assert.deepEqual(bodies, [{ limit: 50, cursor: null }, { limit: 50, cursor: null }]);
    assert.equal(f.session.getSnapshot()!.pagesAccepted, 0);
  } finally { f.session.dispose(); f.store.dispose(); }
});

test("cursor conflict stops traversal and never silently restarts from null", async () => {
  let calls = 0;
  const f = fixture(async () => ++calls === 1 ? response(page(1, 50, true)) : errorResponse("API_CONFLICT", 409));
  try {
    await f.session.next();
    const state = f.store.getSnapshot();
    assert.deepEqual(await f.session.next(), { kind: "restart_required" });
    assert.equal(f.store.getSnapshot(), state);
    assert.equal(f.session.getSnapshot()!.pagesAccepted, 1);
    assert.deepEqual(await f.session.next(), { kind: "restart_required" });
    assert.equal(calls, 2);
    assertNoPreparedLeak(f.store, f.lease);
  } finally { f.session.dispose(); f.store.dispose(); }
});

test("actual loopback handler catalog mutation invalidates the cursor with 409 and stops traversal", async () => {
  // Actual Node Fetch/HTTP/handler/catalog with synthetic authority and memory
  // adapters. Internal catalog create seeds/changes data; no fake revision bump.
  const loopback = await startCatalogLoopback();
  const statuses: number[] = [];
  const bodies: unknown[] = [];
  const store = createCatalogViewStore({ origin: loopback.origin, fetch: async (request, signal) => {
    bodies.push(await request.clone().json());
    const headers = new Headers(request.headers);
    headers.set("origin", loopback.origin);
    headers.set("cookie", "synthetic-session=fixture");
    const reply = await fetch(new Request(request, { headers, signal }), { signal });
    statuses.push(reply.status);
    return reply;
  } });
  let session: CatalogPageSession | null = null;
  try {
    const catalog = createServiceCatalog(loopback.store.catalogDependencies);
    for (let index = 1; index <= 51; index++) {
      const created = await catalog.create(createCatalogCreateRequest(`synthetic-seed-${index}`, profile()).body);
      assert.equal(created.ok, true);
    }
    const lease = store.activate({ bindingId: "synthetic-loopback-pages", dataGeneration: 1 });
    assert.ok(lease);
    session = createCatalogPageSession(store, lease);
    assert.equal((await session.next()).kind, "page");
    assert.deepEqual(session.getSnapshot(), { phase: "more", pagesAccepted: 1, pageRowsObserved: 50 });
    const observed = store.getSnapshot();
    const changed = await catalog.create(createCatalogCreateRequest("synthetic-between-pages", profile()).body);
    assert.equal(changed.ok, true);
    assert.equal(loopback.store.rows.services.size, 52);
    const serverBeforeConflict = loopback.store.snapshot();
    assert.deepEqual(await session.next(), { kind: "restart_required" });
    assert.deepEqual(statuses, [200, 409]);
    assert.deepEqual(bodies[0], { limit: 50, cursor: null });
    assert.ok((bodies[1] as { cursor: unknown }).cursor);
    assert.equal(store.getSnapshot(), observed);
    assert.deepEqual(loopback.store.snapshot(), serverBeforeConflict);
    assert.deepEqual(session.getSnapshot(), { phase: "restart_required", pagesAccepted: 1, pageRowsObserved: 50 });
    assert.deepEqual(await session.next(), { kind: "restart_required" });
    assert.equal(bodies.length, 2);
    assert.equal(loopback.admissions.length, 2);
    assertNoPreparedLeak(store, lease);
  } finally { session?.dispose(); store.dispose(); await loopback.close(); }
});

test("a continuation carrying another collection revision is invalid and does not advance", async () => {
  let calls = 0;
  const f = fixture(async () => response(++calls === 1 ? page(1, 50, true) : page(51, 1, false, 8)));
  try {
    await f.session.next();
    const state = f.store.getSnapshot();
    assert.deepEqual(await f.session.next(), { kind: "retry_required" });
    assert.equal(f.session.getSnapshot()!.pagesAccepted, 1);
    assert.equal(f.store.getSnapshot(), state);
    assertNoPreparedLeak(f.store, f.lease);
  } finally { f.session.dispose(); f.store.dispose(); }
});

test("a fresh session always starts at null even when the store already observed a partial page", async () => {
  const bodies: unknown[] = [];
  const f = fixture(async (request) => {
    bodies.push(await request.json());
    return response(page(1, 50, true));
  });
  try {
    await f.session.next();
    const freshSession = createCatalogPageSession(f.store, f.lease);
    try {
      await freshSession.next();
      assert.deepEqual(bodies, [{ limit: 50, cursor: null }, { limit: 50, cursor: null }]);
    } finally { freshSession.dispose(); }
  } finally { f.session.dispose(); f.store.dispose(); }
});

test("old, forged or foreign leases make no HTTP calls and do not alter the current store", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return response(page(1, 1)); });
  const other = fixture();
  try {
    const fresh = f.store.activate({ bindingId: "synthetic-B", dataGeneration: 1 })!;
    const before = f.store.getSnapshot();
    for (const lease of [f.lease, other.lease, {} as CatalogViewLease]) {
      const session = createCatalogPageSession(f.store, lease);
      assert.equal(session.getSnapshot(), null);
      assert.deepEqual(await session.next(), { kind: "inactive" });
      assert.equal(f.store.getSnapshot(), before);
      session.dispose();
    }
    assert.equal(f.store.getSnapshot()!.lease, fresh);
    assert.equal(calls, 0);
  } finally { f.session.dispose(); f.store.dispose(); other.session.dispose(); other.store.dispose(); }
});

test("A to B to fresh A cannot reuse an old session cursor or its next callback", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return response(page(1, 50, true)); });
  try {
    await f.session.next();
    const oldNext = f.session.next;
    f.store.activate({ bindingId: "synthetic-B", dataGeneration: 1 });
    f.store.activate({ bindingId: "synthetic-A", dataGeneration: 1 });
    const before = f.store.getSnapshot();
    assert.equal(f.session.getSnapshot(), null);
    assert.deepEqual(await oldNext(), { kind: "inactive" });
    assert.equal(calls, 1);
    assert.equal(f.store.getSnapshot(), before);
  } finally { f.session.dispose(); f.store.dispose(); }
});

for (const outcome of ["success", "failure"] as const) {
  test(`late ${outcome} after lease replacement cannot change the new store or expose old progress`, async () => {
    const held = deferred<Response>();
    const f = fixture(async () => held.promise);
    try {
      const pending = f.session.next();
      f.store.activate({ bindingId: "synthetic-B", dataGeneration: 1 });
      const before = f.store.getSnapshot();
      if (outcome === "success") held.resolve(response(page(1, 1)));
      else held.reject(new Error("synthetic-private-detail"));
      assert.deepEqual(await pending, { kind: "inactive" });
      assert.equal(f.session.getSnapshot(), null);
      assert.equal(f.store.getSnapshot(), before);
    } finally { f.session.dispose(); f.store.dispose(); }
  });
}

test("store notification logout during page publication prevents progress acceptance", async () => {
  const f = fixture(async () => response(page(1, 1)));
  f.store.subscribe(() => { if (f.store.getSnapshot()?.state.entries.length) f.store.deactivate(f.lease); });
  try {
    assert.deepEqual(await f.session.next(), { kind: "inactive" });
    assert.equal(f.session.getSnapshot(), null);
    assert.equal(f.store.getSnapshot(), null);
  } finally { f.session.dispose(); f.store.dispose(); }
});

test("reentrant session disposal during store publication still releases its prepared command", async () => {
  const f = fixture(async () => response(page(1, 1)));
  f.store.subscribe(() => { if (f.store.getSnapshot()?.state.entries.length) f.session.dispose(); });
  try {
    assert.deepEqual(await f.session.next(), { kind: "disposed" });
    assert.equal(f.session.getSnapshot(), null);
    assert.equal(f.store.getSnapshot()!.lease, f.lease);
    assert.equal(f.store.getSnapshot()!.state.entries.length, 1);
    assertNoPreparedLeak(f.store, f.lease);
  } finally { f.session.dispose(); f.store.dispose(); }
});

test("unexpected execution exception is normalized and its prepared command is released", async () => {
  const f = fixture();
  const wrapped = Object.freeze({ ...f.store,
    execute: async () => { throw new Error("synthetic-private-detail"); },
  });
  const session = createCatalogPageSession(wrapped, f.lease);
  try {
    const before = f.store.getSnapshot();
    assert.deepEqual(await session.next(), { kind: "retry_required" });
    assert.equal(session.getSnapshot()!.pagesAccepted, 0);
    assert.equal(f.store.getSnapshot(), before);
    assertNoPreparedLeak(f.store, f.lease);
  } finally { session.dispose(); f.session.dispose(); f.store.dispose(); }
});

test("known refresh requirement blocks before HTTP and is never cleared by the session", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return response({ operationId: "synthetic-update", replayed: false, service: row(1, 2) });
  });
  try {
    const token = command(f.store, f.lease, createCatalogUpdateRequest("svc-0001", 1, "synthetic-update", profile()));
    await f.store.execute(f.lease, token);
    f.store.release(f.lease, token);
    const before = f.store.getSnapshot();
    assert.equal(before!.state.refreshRequired, true);
    assert.deepEqual(await f.session.next(), { kind: "restart_required" });
    assert.equal(f.store.getSnapshot(), before);
    assert.equal(calls, 1);
    assertNoPreparedLeak(f.store, f.lease);
  } finally { f.session.dispose(); f.store.dispose(); }
});

test("an independently observed newer collection revision stops an existing cursor before HTTP", async () => {
  let calls = 0;
  const f = fixture(async () => response(++calls === 1 ? page(1, 50, true, 7) : page(100, 1, false, 8)));
  try {
    await f.session.next();
    const token = command(f.store, f.lease, createCatalogListRequest(50, null));
    await f.store.execute(f.lease, token); f.store.release(f.lease, token);
    const before = f.store.getSnapshot();
    assert.deepEqual(await f.session.next(), { kind: "restart_required" });
    assert.equal(f.store.getSnapshot(), before);
    assert.equal(calls, 2);
  } finally { f.session.dispose(); f.store.dispose(); }
});

test("twenty full accepted pages may observe end, but a further cursor requires restart", async () => {
  assert.equal(CATALOG_PAGE_SIZE, 50);
  assert.equal(MAX_CATALOG_SESSION_PAGES, 20);
  for (const lastHasMore of [false, true]) {
    let calls = 0;
    const f = fixture(async () => {
      const start = calls++ * 50 + 1;
      return response(page(start, 50, calls < 20 || lastHasMore));
    });
    try {
      for (let index = 0; index < 20; index++) {
        const result = await f.session.next();
        assert.equal(result.kind, index === 19 && lastHasMore ? "restart_required" : "page");
      }
      assert.deepEqual(f.session.getSnapshot(), { phase: lastHasMore ? "restart_required" : "end_observed",
        pagesAccepted: 20, pageRowsObserved: 1000 });
      assert.equal(f.store.getSnapshot()!.state.entries.length, 1000);
      assert.deepEqual(await f.session.next(), { kind: lastHasMore ? "restart_required" : "end_observed" });
      assert.equal(calls, 20);
      assertNoPreparedLeak(f.store, f.lease);
    } finally { f.session.dispose(); f.store.dispose(); }
  }
});

for (const retainedState of ["live", "deleted"] as const) {
test(`store capacity counts existing ${retainedState} rows and rejects the whole page without advancing`, async () => {
  let listCalls = 0;
  const existing = retainedState === "live" ? row(9999) : { ...row(9999, 2), state: "deleted", profile: null };
  const f = fixture(async (request) => request.url.endsWith("/get") ? response(existing)
    : response(page(listCalls++ * 50 + 1, 50, true)));
  try {
    const token = command(f.store, f.lease, createCatalogGetRequest("svc-9999"));
    await f.store.execute(f.lease, token); f.store.release(f.lease, token);
    for (let index = 0; index < 19; index++) assert.equal((await f.session.next()).kind, "page");
    const entries = f.store.getSnapshot()!.state.entries;
    assert.equal(entries.length, 951);
    assert.deepEqual(await f.session.next(), { kind: "restart_required" });
    assert.equal(f.store.getSnapshot()!.state.entries, entries);
    assert.equal(f.store.getSnapshot()!.state.refreshRequired, true);
    assert.deepEqual(f.session.getSnapshot(), { phase: "restart_required", pagesAccepted: 19, pageRowsObserved: 950 });
    assert.deepEqual(await f.session.next(), { kind: "restart_required" });
    assert.equal(listCalls, 20);
    assertNoPreparedLeak(f.store, f.lease);
  } finally { f.session.dispose(); f.store.dispose(); }
});
}

test("empty terminal page preserves prior observations instead of claiming deletion or freshness", async () => {
  const f = fixture(async (request) => response(request.url.endsWith("/get") ? row(99) : page(1, 0)));
  try {
    const token = command(f.store, f.lease, createCatalogGetRequest("svc-0099"));
    await f.store.execute(f.lease, token); f.store.release(f.lease, token);
    assert.equal((await f.session.next()).kind, "page");
    assert.deepEqual(f.session.getSnapshot(), { phase: "end_observed", pagesAccepted: 1, pageRowsObserved: 0 });
    assert.equal(f.store.getSnapshot()!.state.entries.length, 1);
    assert.equal(Object.hasOwn(f.session.getSnapshot()!, "fresh"), false);
  } finally { f.session.dispose(); f.store.dispose(); }
});

test("prepared capacity failure makes zero HTTP calls and explicit retry works after external release", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return response(page(1, 0)); });
  const tokens = Array.from({ length: MAX_CATALOG_VIEW_COMMANDS }, () => command(f.store, f.lease));
  try {
    assert.deepEqual(await f.session.next(), { kind: "retry_required" });
    assert.equal(calls, 0);
    f.store.release(f.lease, tokens[0]);
    assert.equal((await f.session.next()).kind, "page");
    assert.equal(calls, 1);
  } finally {
    for (const token of tokens) f.store.release(f.lease, token);
    assertNoPreparedLeak(f.store, f.lease);
    f.session.dispose(); f.store.dispose();
  }
});

test("dispose aborts only this session command and cannot clear or abort another store command", async () => {
  let listSignal!: AbortSignal;
  let getSignal!: AbortSignal;
  const f = fixture(async (request, signal) => {
    if (request.url.endsWith("/list")) listSignal = signal;
    else getSignal = signal;
    return new Promise<Response>(() => {});
  });
  const unrelated = command(f.store, f.lease);
  const unrelatedResult = f.store.execute(f.lease, unrelated);
  const pending = f.session.next();
  try {
    const before = f.store.getSnapshot();
    f.session.dispose(); f.session.dispose();
    assert.equal(listSignal.aborted, true);
    assert.equal(getSignal.aborted, false);
    assert.equal(f.store.getSnapshot(), before);
    assert.equal(f.session.getSnapshot(), null);
    assert.deepEqual(await pending, { kind: "disposed" });
    assert.deepEqual(await f.session.next(), { kind: "disposed" });
  } finally {
    f.store.release(f.lease, unrelated);
    assert.equal((await unrelatedResult).kind, "stale");
    assertNoPreparedLeak(f.store, f.lease);
    f.store.dispose();
  }
});
