import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogTransport } from "../src/domain/catalog-client/client.ts";
import { createCatalogCreateRequest, createCatalogGetRequest } from "../src/domain/catalog-client/requests.ts";
import { CATALOG_VIEW_SCHEMA } from "../src/domain/catalog-client/responses.ts";
import { createCatalogViewController, MAX_CATALOG_VIEW_COMMANDS } from "../src/domain/catalog-client/view-controller.ts";
import { reduceCatalogViewState } from "../src/domain/catalog-client/view-state.ts";

// Injected synthetic transport only, no auth/operational routes or persistence.
type Controller = ReturnType<typeof createCatalogViewController>;
function row(serviceId = "svc-1", dataGeneration = 1) {
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration, serviceId, serviceRevision: 1, state: "live",
    profile: { name: "Synthetic service", provider: null, planName: null, accountLabel: null, timezone: null,
      subscriptionStatus: "unknown", trialEndsAt: null, notes: null },
    createdAt: 1, updatedAt: 1, provenance: "user-reported", accountProof: "not-established" };
}
function response(value: unknown) {
  return new Response(JSON.stringify({ ok: true, value }), {
    status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
function errorResponse() {
  return new Response(JSON.stringify({ ok: false, code: "API_UNAVAILABLE" }), {
    status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
function fixture(fetch: CatalogTransport = async () => response(row()), timeoutMs = 1000) {
  return createCatalogViewController({ origin: "https://synthetic.local", fetch, timeoutMs });
}
function command(controller: Controller, request: unknown = createCatalogGetRequest("svc-1")) {
  const result = controller.prepare(request);
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

test("controller starts inactive, generates fresh scopes on every reset and separates instances", () => {
  const first = fixture();
  assert.equal(first.snapshot(), null);
  assert.deepEqual(first.prepare(createCatalogGetRequest("svc-1")), { kind: "inactive" });
  assert.deepEqual(first.reset(1), { kind: "active" });
  const a = first.snapshot()!;
  assert.deepEqual(first.reset(1), { kind: "active" });
  const b = first.snapshot()!;
  assert.notEqual(a.viewScope, b.viewScope);
  assert.equal(a.dataGeneration, b.dataGeneration);
  assert.match(a.viewScope, /^catalog:[0-9a-f-]{36}:1$/i);
  assert.match(b.viewScope, /^catalog:[0-9a-f-]{36}:2$/i);
  const second = fixture();
  second.reset(1);
  assert.notEqual(second.snapshot()!.viewScope, a.viewScope);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(b));
});

test("missing or broken secure UUID facility fails closed without weak-random fallback", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    for (const crypto of [undefined, { randomUUID: () => { throw new Error("synthetic-private-detail"); } },
      { randomUUID: () => "bad-namespace" }]) {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: crypto });
      assert.throws(() => fixture(), /^Error: CATALOG_VIEW_CONTROLLER_CONFIG_INVALID$/);
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("prepare detaches request before execution and exposes only an empty frozen token", async () => {
  const sent: unknown[] = [];
  const controller = fixture(async (request) => { sent.push(await request.json()); return response(row()); });
  controller.reset(1);
  const mutable = { action: "get", body: { serviceId: "svc-1" } };
  const token = command(controller, mutable);
  mutable.body.serviceId = "svc-2";
  assert.deepEqual(Reflect.ownKeys(token), []);
  assert.ok(Object.isFrozen(token));
  assert.equal((await controller.execute(token)).kind, "success");
  assert.deepEqual(sent, [{ serviceId: "svc-1" }]);
  assert.equal(controller.snapshot()!.entries[0]!.serviceId, "svc-1");
});

test("prepared but unsent old command cannot cross reset, including A to B to fresh A", async () => {
  let calls = 0;
  const controller = fixture(async () => { calls++; return response(row()); });
  controller.reset(1);
  const old = command(controller);
  controller.reset(1);
  controller.reset(1);
  assert.deepEqual(await controller.execute(old), { kind: "stale" });
  assert.equal(calls, 0);
  assert.equal(controller.snapshot()!.entries.length, 0);
  assert.equal((await controller.execute(command(controller))).kind, "success");
  assert.equal(calls, 1);
});

test("forged or foreign commands cause no transport and expose no request details", async () => {
  let calls = 0;
  const controller = fixture(async () => { calls++; return response(row()); });
  const other = fixture();
  controller.reset(1);
  other.reset(1);
  let traps = 0;
  const proxy = new Proxy({}, { get: () => { traps++; throw new Error(); }, getPrototypeOf: () => { traps++; throw new Error(); } });
  for (const forged of [null, 1, "command", {}, [], proxy, command(other)]) {
    assert.deepEqual(await controller.execute(forged), { kind: "invalid", reason: "REQUEST" });
  }
  assert.equal(calls, 0);
  assert.equal(traps, 0);
});

test("invalid reset clears old data immediately and revokes prepared commands", async () => {
  const controller = fixture();
  for (const invalid of [undefined, null, "1", 0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    controller.reset(1);
    const token = command(controller);
    assert.equal((await controller.execute(token)).kind, "success");
    assert.equal(controller.snapshot()!.entries.length, 1);
    assert.deepEqual(controller.reset(invalid), { kind: "invalid" });
    assert.equal(controller.snapshot(), null);
    assert.deepEqual(await controller.execute(token), { kind: "stale" });
  }
});

test("clear empties snapshot and aborts pending work before a late success can apply", async () => {
  const transport = deferred<Response>();
  let signal: AbortSignal | undefined;
  const controller = fixture((_request, incoming) => { signal = incoming; return transport.promise; });
  controller.reset(1);
  const pending = controller.execute(command(controller));
  assert.equal(signal!.aborted, false);
  controller.clear();
  assert.equal(controller.snapshot(), null);
  assert.equal(signal!.aborted, true);
  assert.deepEqual(await pending, { kind: "stale" });
  transport.resolve(response(row()));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot(), null);
});

test("invalid reset aborts pending request and ignores late old-account error", async () => {
  const transport = deferred<Response>();
  let signal: AbortSignal | undefined;
  const controller = fixture((_request, incoming) => { signal = incoming; return transport.promise; });
  controller.reset(1);
  const pending = controller.execute(command(controller));
  assert.deepEqual(controller.reset(0), { kind: "invalid" });
  assert.equal(signal!.aborted, true);
  assert.deepEqual(await pending, { kind: "stale" });
  transport.resolve(errorResponse());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot(), null);
});

test("account switch rejects late old result while fresh account accepts its own request", async () => {
  const old = deferred<Response>();
  let calls = 0;
  const controller = fixture(() => ++calls === 1 ? old.promise : Promise.resolve(response(row("svc-1", 2))));
  controller.reset(1);
  const pending = controller.execute(command(controller));
  controller.reset(2);
  const currentScope = controller.snapshot()!.viewScope;
  assert.equal((await controller.execute(command(controller))).kind, "success");
  assert.deepEqual(await pending, { kind: "stale" });
  old.reject(new Error("synthetic-old-account-detail"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot()!.viewScope, currentScope);
  assert.equal(controller.snapshot()!.entries[0]!.dataGeneration, 2);
});

test("already resolved result remains old-scoped and cannot reapply after reset", async () => {
  const controller = fixture();
  controller.reset(1);
  const completed = await controller.execute(command(controller));
  assert.equal(completed.kind, "success");
  const oldSnapshot = controller.snapshot()!;
  controller.clear();
  controller.reset(1);
  const fresh = controller.snapshot()!;
  assert.equal(reduceCatalogViewState(fresh, { type: "response", result: completed }), fresh);
  assert.equal(fresh.entries.length, 0);
  // Existing references are not secure erasure/revocation; document this limit.
  assert.equal(oldSnapshot.entries.length, 1);
});

test("uncertain mutation failure only retries explicitly with exact original operation and body", async () => {
  let calls = 0;
  const bodies: string[] = [];
  const controller = fixture(async (request) => {
    bodies.push(await request.text());
    calls++;
    return calls === 1 ? errorResponse() : response({ operationId: "synthetic-operation", replayed: true, service: row() });
  });
  controller.reset(1);
  const token = command(controller, createCatalogCreateRequest("synthetic-operation", row().profile));
  assert.deepEqual(await controller.execute(token), { kind: "error", code: "API_UNAVAILABLE", retriableAfterMs: null });
  assert.equal(calls, 1);
  assert.equal(controller.snapshot()!.entries.length, 0);
  assert.equal((await controller.execute(token)).kind, "success");
  assert.equal(calls, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(controller.snapshot()!.entries.length, 1);
  assert.equal(controller.snapshot()!.refreshRequired, true);
});

test("same token concurrent execution is denied but explicit settled retry is allowed", async () => {
  const delayed = deferred<Response>();
  let calls = 0;
  const controller = fixture(() => ++calls === 1 ? delayed.promise : Promise.resolve(response(row())));
  controller.reset(1);
  const token = command(controller);
  const first = controller.execute(token);
  assert.deepEqual(await controller.execute(token), { kind: "invalid", reason: "REQUEST" });
  assert.equal(calls, 1);
  delayed.resolve(response(row()));
  assert.equal((await first).kind, "success");
  assert.equal((await controller.execute(token)).kind, "success");
  assert.equal(calls, 2);
});

test("release revokes one token and aborts only its flight", async () => {
  const pending: ReturnType<typeof deferred<Response>>[] = [];
  const signals: AbortSignal[] = [];
  const controller = fixture((_request, signal) => {
    const transport = deferred<Response>();
    pending.push(transport);
    signals.push(signal);
    return transport.promise;
  });
  controller.reset(1);
  const first = command(controller);
  const second = command(controller);
  const firstResult = controller.execute(first);
  const secondResult = controller.execute(second);
  controller.release(first);
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals[1]!.aborted, false);
  assert.deepEqual(await firstResult, { kind: "stale" });
  assert.deepEqual(await controller.execute(first), { kind: "stale" });
  pending[0]!.resolve(response(row()));
  pending[1]!.resolve(response(row()));
  assert.equal((await secondResult).kind, "success");
});

test("prepared quota is bounded until explicit release or reset, and repeated release cannot underflow", () => {
  const controller = fixture();
  controller.reset(1);
  const tokens = Array.from({ length: MAX_CATALOG_VIEW_COMMANDS }, () => command(controller));
  assert.deepEqual(controller.prepare(createCatalogGetRequest("svc-1")), { kind: "capacity" });
  controller.release(tokens[0]);
  controller.release(tokens[0]);
  controller.release({});
  command(controller);
  assert.deepEqual(controller.prepare(createCatalogGetRequest("svc-1")), { kind: "capacity" });
  controller.reset(1);
  command(controller);
});

test("releasing an old-scope token cannot reduce the current scope quota", () => {
  const controller = fixture();
  controller.reset(1);
  const old = command(controller);
  controller.reset(1);
  for (let index = 0; index < MAX_CATALOG_VIEW_COMMANDS; index++) command(controller);
  controller.release(old);
  assert.deepEqual(controller.prepare(createCatalogGetRequest("svc-1")), { kind: "capacity" });
});

test("releasing a flight cannot bypass the independent concurrent-call limit before it settles", async () => {
  const controller = fixture(() => new Promise<Response>(() => undefined));
  controller.reset(1);
  const tokens = Array.from({ length: MAX_CATALOG_VIEW_COMMANDS }, () => command(controller));
  const pending = tokens.map((token) => controller.execute(token));
  controller.release(tokens[0]);
  const replacement = command(controller);
  const denied = controller.execute(replacement);
  assert.deepEqual(await denied, { kind: "invalid", reason: "REQUEST" });
  controller.clear();
  const results = await Promise.all(pending);
  assert.ok(results.every((result) => result.kind === "stale"));
});

test("reset cannot bypass 64 outstanding logical calls before their finally cleanup settles", async () => {
  let calls = 0;
  let respondNow = false;
  const controller = fixture(() => {
    calls++;
    return respondNow ? Promise.resolve(response(row())) : new Promise<Response>(() => undefined);
  });
  controller.reset(1);
  const tokens = Array.from({ length: MAX_CATALOG_VIEW_COMMANDS }, () => command(controller));
  const pending = tokens.map((token) => controller.execute(token));
  controller.reset(1);
  const fresh = command(controller);
  // Dispatch immediately, before an await lets the old finally blocks run.
  const denied = controller.execute(fresh);
  assert.deepEqual(await denied, { kind: "invalid", reason: "REQUEST" });
  assert.equal(calls, MAX_CATALOG_VIEW_COMMANDS);
  const results = await Promise.all(pending);
  assert.ok(results.every((result) => result.kind === "stale"));
  respondNow = true;
  assert.equal((await controller.execute(fresh)).kind, "success");
  assert.equal(calls, MAX_CATALOG_VIEW_COMMANDS + 1);
});

test("dispose is permanent, clears observations and aborts work; clear and reset never revive it", async () => {
  const controller = fixture(() => new Promise<Response>(() => undefined));
  controller.reset(1);
  const token = command(controller);
  const pending = controller.execute(token);
  controller.dispose();
  assert.equal(controller.snapshot(), null);
  assert.deepEqual(await pending, { kind: "stale" });
  assert.deepEqual(controller.reset(1), { kind: "disposed" });
  assert.deepEqual(controller.prepare(createCatalogGetRequest("svc-1")), { kind: "disposed" });
  assert.deepEqual(await controller.execute(token), { kind: "stale" });
  controller.clear();
  controller.dispose();
  assert.equal(controller.snapshot(), null);
});

test("abort listener cannot undo logout by reentrant reset", async () => {
  let controller!: Controller;
  let seen: unknown;
  controller = fixture((_request, signal) => {
    signal.addEventListener("abort", () => {
      assert.equal(controller.snapshot(), null);
      seen = controller.reset(2);
      assert.deepEqual(controller.prepare(createCatalogGetRequest("svc-1")), { kind: "inactive" });
    });
    return new Promise<Response>(() => undefined);
  });
  controller.reset(1);
  const pending = controller.execute(command(controller));
  controller.clear();
  assert.deepEqual(seen, { kind: "invalid" });
  assert.equal(controller.snapshot(), null);
  assert.deepEqual(await pending, { kind: "stale" });
});

test("reentrant clear during outer reset wins and prevents stale reactivation", async () => {
  let controller!: Controller;
  controller = fixture((_request, signal) => {
    signal.addEventListener("abort", () => controller.clear());
    return new Promise<Response>(() => undefined);
  });
  controller.reset(1);
  const pending = controller.execute(command(controller));
  assert.deepEqual(controller.reset(2), { kind: "invalid" });
  assert.equal(controller.snapshot(), null);
  assert.deepEqual(await pending, { kind: "stale" });
});

test("reentrant dispose during outer reset wins permanently", async () => {
  let controller!: Controller;
  controller = fixture((_request, signal) => {
    signal.addEventListener("abort", () => controller.dispose());
    return new Promise<Response>(() => undefined);
  });
  controller.reset(1);
  const pending = controller.execute(command(controller));
  assert.deepEqual(controller.reset(2), { kind: "disposed" });
  assert.deepEqual(await pending, { kind: "stale" });
  assert.equal(controller.snapshot(), null);
  assert.deepEqual(controller.reset(1), { kind: "disposed" });
});

test("reentrant scope change during request snapshot cannot mint a command in the new account", () => {
  const controller = fixture();
  controller.reset(1);
  let changed = false;
  const request = new Proxy(createCatalogGetRequest("svc-1"), {
    getPrototypeOf(target) {
      if (!changed) { changed = true; controller.reset(2); }
      return Object.getPrototypeOf(target);
    },
  });
  assert.deepEqual(controller.prepare(request), { kind: "inactive" });
  assert.equal(controller.snapshot()!.dataGeneration, 2);
  assert.equal(controller.snapshot()!.entries.length, 0);
});

test("reentrant snapshot allocations cannot mint a 65th command after the initial capacity check", () => {
  const controller = fixture();
  controller.reset(1);
  let allocated = false;
  const tokens: ReturnType<typeof command>[] = [];
  const request = new Proxy(createCatalogGetRequest("svc-1"), {
    getPrototypeOf(target) {
      if (!allocated) {
        allocated = true;
        for (let index = 0; index < MAX_CATALOG_VIEW_COMMANDS; index++) tokens.push(command(controller));
      }
      return Object.getPrototypeOf(target);
    },
  });
  assert.deepEqual(controller.prepare(request), { kind: "capacity" });
  assert.equal(tokens.length, MAX_CATALOG_VIEW_COMMANDS);
  assert.deepEqual(controller.prepare(createCatalogGetRequest("svc-1")), { kind: "capacity" });
  controller.release(tokens[0]);
  command(controller);
  assert.deepEqual(controller.prepare(createCatalogGetRequest("svc-1")), { kind: "capacity" });
});

test("invalid request preparation neither consumes quota nor invokes ordinary getters", () => {
  const controller = fixture();
  controller.reset(1);
  let calls = 0;
  const malformed = { get action() { calls++; return "get"; }, body: { serviceId: "svc-1" } };
  for (let index = 0; index < MAX_CATALOG_VIEW_COMMANDS + 1; index++) {
    assert.deepEqual(controller.prepare(malformed), { kind: "invalid" });
  }
  assert.equal(calls, 0);
  for (let index = 0; index < MAX_CATALOG_VIEW_COMMANDS; index++) command(controller);
  assert.deepEqual(controller.prepare(createCatalogGetRequest("svc-1")), { kind: "capacity" });
});

test("transport failure details never escape controller result or enter view state", async () => {
  const controller = fixture(async () => { throw new Error("synthetic-private-provider-detail"); });
  controller.reset(1);
  const outcome = await controller.execute(command(controller));
  assert.deepEqual(outcome, { kind: "aborted" });
  assert.equal(controller.snapshot()!.entries.length, 0);
  assert.ok(!JSON.stringify(outcome).includes("synthetic-private-provider-detail"));
});
