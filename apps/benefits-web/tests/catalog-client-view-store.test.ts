import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogTransport } from "../src/domain/catalog-client/client.ts";
import { createCatalogGetRequest } from "../src/domain/catalog-client/requests.ts";
import { CATALOG_VIEW_SCHEMA } from "../src/domain/catalog-client/responses.ts";
import { MAX_CATALOG_VIEW_COMMANDS } from "../src/domain/catalog-client/view-controller.ts";
import { createCatalogViewStore, normalizeCatalogBindingContext,
  type CatalogViewLease, type CatalogViewStore } from "../src/domain/catalog-client/view-store.ts";

// Synthetic injected transport only: no authentication, React mount, or real route evidence.
const context = (bindingId = "synthetic-session-A", dataGeneration = 1) => ({ bindingId, dataGeneration });
function row(serviceId = "svc-1", serviceRevision = 1) {
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, serviceId, serviceRevision, state: "live",
    profile: { name: "Synthetic service", provider: null, planName: null, accountLabel: null,
      timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null },
    createdAt: 1, updatedAt: serviceRevision, provenance: "user-reported", accountProof: "not-established" };
}
function response(value: unknown = row()) {
  return new Response(JSON.stringify({ ok: true, value }), {
    status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
function fixture(fetch: CatalogTransport = async () => response()) {
  return createCatalogViewStore({ origin: "https://synthetic.local", fetch, timeoutMs: 1000 });
}
function activate(store: CatalogViewStore, input: unknown = context()): CatalogViewLease {
  const lease = store.activate(input);
  assert.notEqual(lease, null);
  return lease!;
}
function command(store: CatalogViewStore, lease: CatalogViewLease, input: unknown = createCatalogGetRequest("svc-1")) {
  const result = store.prepare(lease, input);
  assert.equal(result.kind, "prepared");
  if (result.kind !== "prepared") throw new Error("synthetic-prepare-failed");
  return result.command;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("context accepts detached frozen plain/null-prototype records with bounded opaque identifiers", () => {
  const original = context();
  const normalized = normalizeCatalogBindingContext(original);
  assert.deepEqual(normalized, original);
  assert.notEqual(normalized, original);
  assert.ok(Object.isFrozen(normalized));
  original.bindingId = "synthetic-session-B";
  assert.equal(normalized!.bindingId, "synthetic-session-A");
  for (const input of [Object.freeze(context()), Object.assign(Object.create(null), context()),
    context("A".repeat(128), Number.MAX_SAFE_INTEGER), context("session:0_a-b.c")]) {
    assert.notEqual(normalizeCatalogBindingContext(input), null);
  }
});

test("context rejects malformed scalar, inherited, hidden, extra and symbol fields", () => {
  class Context { bindingId = "synthetic"; dataGeneration = 1; }
  const hidden = Object.defineProperty(context(), "bindingId", { enumerable: false });
  for (const input of [null, undefined, 1, [], new Context(), Object.create(context()), {},
    { ...context(), extra: true }, { ...context(), [Symbol("synthetic")]: 1 }, hidden,
    ...["", " ", "a\n", "a\r", "a b", "a/b", "é", "A".repeat(129)].map((id) => context(id)),
    ...[0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((generation) => context("a", generation)),
    { ...context(), dataGeneration: "1" }]) {
    assert.equal(normalizeCatalogBindingContext(input), null);
  }
});

test("context never invokes ordinary accessors and normalizes reflection failures", () => {
  let reads = 0;
  for (const property of ["bindingId", "dataGeneration"]) {
    const input = Object.defineProperty(context(), property, {
      enumerable: true, get() { reads++; throw new Error("synthetic-private-detail"); },
    });
    assert.equal(normalizeCatalogBindingContext(input), null);
  }
  for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"]) {
    const input = new Proxy(context(), { [trap]: () => { throw new Error("synthetic-private-detail"); } });
    assert.equal(normalizeCatalogBindingContext(input), null);
  }
  assert.equal(reads, 0);
});

test("factory is inert and unavailable secure UUID fails activation closed", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let calls = 0;
  let notifications = 0;
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    const store = fixture(async () => { calls++; return response(); });
    const unsubscribe = store.subscribe(() => { notifications++; });
    assert.equal(store.getSnapshot(), null);
    assert.equal(store.activate(context()), null);
    assert.equal(store.getSnapshot(), null);
    assert.equal(calls, 0);
    assert.equal(notifications, 0);
    unsubscribe();
    store.dispose();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("invalid configuration fails lazy activation without exposing raw details", () => {
  const store = createCatalogViewStore({ origin: "invalid", fetch: async () => response() });
  assert.equal(store.getSnapshot(), null);
  assert.equal(store.activate(context()), null);
  assert.equal(store.getSnapshot(), null);
  store.dispose();
});

test("activation yields opaque fresh leases and stable immutable snapshots without fetching", () => {
  let calls = 0;
  const store = fixture(async () => { calls++; return response(); });
  const first = activate(store);
  const a = store.getSnapshot()!;
  assert.equal(store.getSnapshot(), a);
  assert.equal(a.lease, first);
  assert.ok(Object.isFrozen(store) && Object.isFrozen(a) && Object.isFrozen(a.context) && Object.isFrozen(first));
  assert.deepEqual(Reflect.ownKeys(first), []);
  const second = activate(store);
  const b = store.getSnapshot()!;
  assert.notEqual(first, second);
  assert.notEqual(a.state.viewScope, b.state.viewScope);
  assert.equal(a.state.viewScope.split(":")[1], b.state.viewScope.split(":")[1]);
  assert.equal(calls, 0);
  store.dispose();
});

test("subscription does not immediately run; changes notify and unsubscribe is idempotent", async () => {
  const store = fixture();
  const seen: unknown[] = [];
  const off = store.subscribe(() => { seen.push(store.getSnapshot()); });
  assert.equal(seen.length, 0);
  const lease = activate(store);
  assert.equal(seen.length, 1);
  assert.equal((await store.execute(lease, command(store, lease))).kind, "success");
  assert.equal(seen.length, 2);
  assert.equal(store.getSnapshot()!.state.entries.length, 1);
  off(); off();
  store.deactivate(lease);
  assert.equal(store.getSnapshot(), null);
  assert.equal(seen.length, 2);
  store.dispose();
});

test("invalid activation clears existing rows and revokes unsent commands", async () => {
  let calls = 0;
  const store = fixture(async () => { calls++; return response(); });
  const lease = activate(store);
  const token = command(store, lease);
  await store.execute(lease, token);
  const seen: unknown[] = [];
  store.subscribe(() => { seen.push(store.getSnapshot()); });
  assert.equal(store.activate({ ...context(), dataGeneration: 0 }), null);
  assert.equal(store.getSnapshot(), null);
  assert.deepEqual(seen, [null]);
  assert.deepEqual(store.prepare(lease, createCatalogGetRequest("svc-1")), { kind: "inactive" });
  assert.deepEqual(await store.execute(lease, token), { kind: "stale" });
  assert.equal(calls, 1);
  store.dispose();
});

test("old, forged, and foreign leases cannot dispatch, prepare, release or deactivate current data", async () => {
  let calls = 0;
  const store = fixture(async () => { calls++; return response(); });
  const other = fixture();
  const foreign = activate(other);
  const old = activate(store);
  const current = activate(store);
  const token = command(store, current);
  let traps = 0;
  const proxy = new Proxy({}, { get: () => { traps++; throw new Error(); } });
  for (const lease of [old, foreign, {}, null, undefined, 1, proxy]) {
    assert.deepEqual(store.prepare(lease, createCatalogGetRequest("svc-1")), { kind: "inactive" });
    assert.deepEqual(await store.execute(lease, token), { kind: "stale" });
    store.release(lease, token);
    store.deactivate(lease);
    assert.equal(store.getSnapshot()!.lease, current);
  }
  assert.equal(calls, 0);
  assert.equal(traps, 0);
  assert.equal((await store.execute(current, token)).kind, "success");
  assert.equal(calls, 1);
  store.dispose(); other.dispose();
});

test("A to B to fresh A never revives a previously prepared command or lease", async () => {
  let calls = 0;
  const store = fixture(async () => { calls++; return response(); });
  const old = activate(store);
  const token = command(store, old);
  activate(store, context("synthetic-session-B"));
  const fresh = activate(store);
  assert.deepEqual(await store.execute(old, token), { kind: "stale" });
  assert.deepEqual(await store.execute(fresh, token), { kind: "stale" });
  assert.equal(calls, 0);
  assert.equal(store.getSnapshot()!.state.entries.length, 0);
  store.dispose();
});

test("deactivation clears before synchronous abort callbacks and old asynchronous failure cannot publish", async () => {
  const pending = deferred<Response>();
  let aborted = false;
  const store = fixture(async (_request, signal) => {
    signal.addEventListener("abort", () => {
      aborted = true;
      assert.equal(store.getSnapshot(), null);
      assert.equal(store.activate(context("resurrected")), null);
    }, { once: true });
    return pending.promise;
  });
  const lease = activate(store);
  const result = store.execute(lease, command(store, lease));
  store.deactivate(lease);
  assert.equal(aborted, true);
  const fresh = activate(store, context("synthetic-session-B"));
  const before = store.getSnapshot();
  pending.reject(new Error("synthetic-private-detail"));
  assert.deepEqual(await result, { kind: "stale" });
  assert.equal(store.getSnapshot(), before);
  assert.equal(store.getSnapshot()!.lease, fresh);
  store.dispose();
});

test("late successful response after clear cannot repopulate a fresh view", async () => {
  const pending = deferred<Response>();
  const store = fixture(async () => pending.promise);
  const lease = activate(store);
  const result = store.execute(lease, command(store, lease));
  store.deactivate(lease);
  activate(store);
  pending.resolve(response());
  assert.deepEqual(await result, { kind: "stale" });
  assert.equal(store.getSnapshot()!.state.entries.length, 0);
  store.dispose();
});

test("subscriber exceptions cannot block another observer or clearing", async () => {
  const store = fixture();
  let observed = 0;
  store.subscribe(() => { throw new Error("synthetic-private-detail"); });
  store.subscribe(() => { observed++; });
  const lease = activate(store);
  await store.execute(lease, command(store, lease));
  store.deactivate(lease);
  assert.equal(observed, 3);
  assert.equal(store.getSnapshot(), null);
  store.dispose();
});

test("subscriber activate is rejected during notifications without changing current lease", () => {
  const store = fixture();
  const attempts: unknown[] = [];
  store.subscribe(() => { attempts.push(store.activate(context("reentrant"))); });
  const lease = activate(store);
  assert.deepEqual(attempts, [null]);
  assert.equal(store.getSnapshot()!.lease, lease);
  store.deactivate(lease);
  assert.deepEqual(attempts, [null, null]);
  assert.equal(store.getSnapshot(), null);
  store.dispose();
});

test("subscriber can deactivate the just-published lease without outer activation resurrecting it", () => {
  const store = fixture();
  let observed = 0;
  store.subscribe(() => {
    observed++;
    const snapshot = store.getSnapshot();
    if (snapshot !== null) store.deactivate(snapshot.lease);
  });
  assert.equal(store.activate(context()), null);
  assert.equal(store.getSnapshot(), null);
  assert.equal(observed, 2);
  store.dispose();
});

test("subscriber disposing during activation permanently wins and removes listeners", () => {
  const store = fixture();
  let observed = 0;
  store.subscribe(() => { observed++; store.dispose(); });
  assert.equal(store.activate(context()), null);
  assert.equal(store.getSnapshot(), null);
  assert.equal(observed, 2);
  store.subscribe(() => { observed++; });
  assert.equal(store.activate(context()), null);
  assert.deepEqual(store.prepare({}, createCatalogGetRequest("svc-1")), { kind: "disposed" });
  store.dispose();
  assert.equal(observed, 2);
});

test("abort callback deactivation of previous lease cancels an outer replacement activation", async () => {
  let lease!: CatalogViewLease;
  const store = fixture(async (_request, signal) => {
    signal.addEventListener("abort", () => { store.deactivate(lease); }, { once: true });
    return new Promise<Response>(() => {});
  });
  lease = activate(store);
  const pending = store.execute(lease, command(store, lease));
  assert.equal(store.activate(context("synthetic-session-B")), null);
  assert.equal(store.getSnapshot(), null);
  assert.deepEqual(await pending, { kind: "stale" });
  store.dispose();
});

test("context reflection reentrancy cannot undo a logout or bind an outer activation", () => {
  const store = fixture();
  const lease = activate(store);
  const input = new Proxy(context("synthetic-session-B"), {
    getPrototypeOf(target) { store.deactivate(lease); return Reflect.getPrototypeOf(target); },
  });
  assert.equal(store.activate(input), null);
  assert.equal(store.getSnapshot(), null);
  store.dispose();
});

test("prepare reflection replacement makes the old preparation inactive", async () => {
  let calls = 0;
  const store = fixture(async () => { calls++; return response(); });
  const lease = activate(store);
  let fresh!: CatalogViewLease;
  const input = new Proxy(createCatalogGetRequest("svc-1"), {
    getPrototypeOf(target) { fresh = activate(store, context("synthetic-session-B")); return Reflect.getPrototypeOf(target); },
  });
  assert.deepEqual(store.prepare(lease, input), { kind: "inactive" });
  assert.equal(store.getSnapshot()!.lease, fresh);
  assert.equal(calls, 0);
  store.dispose();
});

test("render snapshot keeps newer observations when a later completion contains an older row", async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  let calls = 0;
  const store = fixture(async () => (++calls === 1 ? first.promise : second.promise));
  const lease = activate(store);
  const a = store.execute(lease, command(store, lease));
  const b = store.execute(lease, command(store, lease));
  second.resolve(response(row("svc-1", 2)));
  await b;
  const latest = store.getSnapshot();
  first.resolve(response(row("svc-1", 1)));
  assert.equal((await a).kind, "success");
  assert.equal(store.getSnapshot(), latest);
  assert.equal(store.getSnapshot()!.state.entries[0]!.serviceRevision, 2);
  store.dispose();
});

test("subscriber logout on response publication changes returned outcome to stale", async () => {
  const store = fixture();
  const lease = activate(store);
  store.subscribe(() => {
    if (store.getSnapshot()?.state.entries.length) store.deactivate(lease);
  });
  assert.deepEqual(await store.execute(lease, command(store, lease)), { kind: "stale" });
  assert.equal(store.getSnapshot(), null);
  store.dispose();
});

test("release revokes only its command and explicit retry has no automatic duplicate transport", async () => {
  let calls = 0;
  const store = fixture(async () => { calls++; return response(); });
  const lease = activate(store);
  const token = command(store, lease);
  const retained = command(store, lease);
  assert.equal((await store.execute(lease, token)).kind, "success");
  assert.equal(calls, 1);
  assert.equal((await store.execute(lease, token)).kind, "success");
  assert.equal(calls, 2);
  store.release(lease, token);
  assert.deepEqual(await store.execute(lease, token), { kind: "stale" });
  assert.equal((await store.execute(lease, retained)).kind, "success");
  assert.equal(calls, 3);
  store.dispose();
});

test("prepared command quota stays bounded and is freed only by release or activation", () => {
  const store = fixture();
  const lease = activate(store);
  const tokens = Array.from({ length: MAX_CATALOG_VIEW_COMMANDS }, () => command(store, lease));
  assert.deepEqual(store.prepare(lease, createCatalogGetRequest("svc-1")), { kind: "capacity" });
  store.release(lease, tokens[0]);
  command(store, lease);
  assert.deepEqual(store.prepare(lease, createCatalogGetRequest("svc-1")), { kind: "capacity" });
  const fresh = activate(store);
  command(store, fresh);
  store.dispose();
});

test("reused controller retains logical flight cap across deactivate and fresh activation", async () => {
  let calls = 0;
  const store = fixture(async () => { calls++; return new Promise<Response>(() => {}); });
  const lease = activate(store);
  const tokens = Array.from({ length: MAX_CATALOG_VIEW_COMMANDS }, () => command(store, lease));
  const pending = tokens.map((token) => store.execute(lease, token));
  assert.equal(calls, MAX_CATALOG_VIEW_COMMANDS);
  store.deactivate(lease);
  const fresh = activate(store);
  const token = command(store, fresh);
  const blocked = store.execute(fresh, token); // Before old finally blocks settle.
  assert.equal(calls, MAX_CATALOG_VIEW_COMMANDS);
  assert.deepEqual(await blocked, { kind: "invalid", reason: "REQUEST" });
  assert.ok((await Promise.all(pending)).every((result) => result.kind === "stale"));
  const later = store.execute(fresh, token);
  assert.equal(calls, MAX_CATALOG_VIEW_COMMANDS + 1);
  store.dispose();
  assert.deepEqual(await later, { kind: "stale" });
});

test("old cleanup cannot clear replacement lease and dispose permanently aborts pending work", async () => {
  let signal!: AbortSignal;
  const store = fixture(async (_request, currentSignal) => {
    signal = currentSignal;
    return new Promise<Response>(() => {});
  });
  const old = activate(store);
  const fresh = activate(store);
  store.deactivate(old);
  assert.equal(store.getSnapshot()!.lease, fresh);
  const pending = store.execute(fresh, command(store, fresh));
  store.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(store.getSnapshot(), null);
  assert.equal(store.activate(context()), null);
  assert.deepEqual(await pending, { kind: "stale" });
  assert.deepEqual(await store.execute(fresh, {}), { kind: "stale" });
});
