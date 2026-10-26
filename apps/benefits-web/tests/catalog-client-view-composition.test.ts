import assert from "node:assert/strict";
import { test } from "node:test";
import { createCatalogClient, type CatalogTransport } from "../src/domain/catalog-client/client.ts";
import { createCatalogGetRequest, createCatalogListRequest, createCatalogUpdateRequest,
  type CatalogRequest } from "../src/domain/catalog-client/requests.ts";
import { CATALOG_VIEW_SCHEMA, type CatalogServiceProfileView,
  type CatalogServiceView } from "../src/domain/catalog-client/responses.ts";
import { createCatalogViewController } from "../src/domain/catalog-client/view-controller.ts";
import { createCatalogViewState, reduceCatalogViewState } from "../src/domain/catalog-client/view-state.ts";

// Real client decoding and reducer/controller composition, finite synthetic
// Fetch bodies only. No substituted client, server, network or authentication.
const ORIGIN = "https://synthetic.local";
const CONTEXT = Object.freeze({ viewScope: "synthetic-composition-first", dataGeneration: 1 });
type Controller = ReturnType<typeof createCatalogViewController>;

function profile(name: string): CatalogServiceProfileView {
  return { name, provider: null, planName: null, accountLabel: null, timezone: "Asia/Seoul",
    subscriptionStatus: "unknown", trialEndsAt: null, notes: null };
}
function row(serviceId: string, serviceRevision: number, name: string, dataGeneration = 1): CatalogServiceView {
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration, serviceId, serviceRevision, state: "live",
    profile: profile(name), createdAt: 1, updatedAt: serviceRevision,
    provenance: "user-reported", accountProof: "not-established" };
}
function page(services: readonly CatalogServiceView[], catalogRevision: number, dataGeneration = 1) {
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration, catalogRevision, services, nextCursor: null };
}
function boundedResponse(value: unknown): Response {
  const body = JSON.stringify({ ok: true, value });
  const bytes = new TextEncoder().encode(body).byteLength;
  assert.ok(bytes < 4096, "synthetic fixtures remain deliberately small and bounded");
  return new Response(body, { status: 200, headers: {
    "content-type": "application/json", "cache-control": "private, no-store", "content-length": String(bytes),
  } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function transport(steps: readonly { action: CatalogRequest["action"]; value: unknown }[]) {
  let calls = 0;
  const fetch: CatalogTransport = async (request) => {
    const step = steps[calls++];
    assert.ok(step, "no implicit or unplanned retry is permitted");
    assert.equal(request.url, ORIGIN + "/api/catalog/" + step.action);
    assert.equal(request.method, "POST");
    return boundedResponse(await step.value);
  };
  return { fetch, calls: () => calls };
}
function command(controller: Controller, request: CatalogRequest) {
  const prepared = controller.prepare(request);
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("synthetic-prepare-failed");
  return prepared.command;
}
async function execute(controller: Controller, request: CatalogRequest) {
  const prepared = command(controller, request);
  try { return await controller.execute(prepared); }
  finally { controller.release(prepared); }
}

test("real client accepts delayed lower live GET while controller preserves the newer snapshot", async () => {
  const old = row("svc-1", 2, "Synthetic older name");
  const current = row("svc-1", 5, "Synthetic current name");
  const held = deferred<CatalogServiceView>();
  const wire = transport([{ action: "get", value: held.promise }, { action: "get", value: current }]);
  const controller = createCatalogViewController({ origin: ORIGIN, fetch: wire.fetch });
  assert.deepEqual(controller.reset(1), { kind: "active" });
  const delayed = execute(controller, createCatalogGetRequest("svc-1"));
  try {
    assert.equal(wire.calls(), 1);
    assert.equal((await execute(controller, createCatalogGetRequest("svc-1"))).kind, "success");
    const accepted = controller.snapshot()!;
    assert.deepEqual(accepted.entries, [current]);
    held.resolve(old);
    const oldResult = await delayed;
    assert.equal(oldResult.kind, "success", "transport validity is distinct from observation freshness");
    if (oldResult.kind !== "success" || oldResult.success.kind !== "view") assert.fail("expected live view");
    assert.equal(oldResult.success.view.serviceRevision, 2);
    assert.deepEqual(oldResult.capturedScope, { viewScope: accepted.viewScope, dataGeneration: 1 });
    assert.equal(controller.snapshot(), accepted);
    assert.equal(accepted.refreshRequired, false);
    assert.equal(wire.calls(), 2);
  } finally {
    held.resolve(old);
    controller.dispose();
    await delayed;
  }
});

test("validated update receipt followed by empty newer page keeps observations and sticky refresh", async () => {
  const original = row("svc-1", 2, "Synthetic before update");
  const changed = row("svc-1", 3, "Synthetic after update");
  const untouched = row("svc-2", 1, "Synthetic second row");
  const wire = transport([
    { action: "list", value: page([original, untouched], 7) },
    { action: "update", value: { operationId: "synthetic-update", replayed: false, service: changed } },
    { action: "list", value: page([], 8) },
  ]);
  const controller = createCatalogViewController({ origin: ORIGIN, fetch: wire.fetch });
  controller.reset(1);
  try {
    assert.equal((await execute(controller, createCatalogListRequest(2, null))).kind, "success");
    assert.equal(controller.snapshot()!.refreshRequired, false);
    const updated = await execute(controller,
      createCatalogUpdateRequest("svc-1", 2, "synthetic-update", changed.profile!));
    assert.equal(updated.kind, "success", "fresh receipt must satisfy actual request correlation");
    const afterReceipt = controller.snapshot()!;
    assert.deepEqual(afterReceipt.entries, [changed, untouched]);
    assert.equal(afterReceipt.catalogRevision, 7);
    assert.equal(afterReceipt.refreshRequired, true);
    assert.equal((await execute(controller, createCatalogListRequest(2, null))).kind, "success");
    const afterEmptyPage = controller.snapshot()!;
    assert.equal(afterEmptyPage.entries, afterReceipt.entries);
    assert.equal(afterEmptyPage.catalogRevision, 8);
    assert.equal(afterEmptyPage.refreshRequired, true);
    assert.equal(Object.hasOwn(afterEmptyPage, "operationId"), false);
    assert.equal(wire.calls(), 3);
  } finally { controller.dispose(); }
});

test("malformed and other-generation HTTP successes cannot partially overwrite an accepted snapshot", async () => {
  const existing = row("svc-1", 2, "Synthetic retained row");
  const replacement = row("svc-1", 99, "Synthetic must not appear");
  const malformedSecondRow = { ...row("svc-2", 1, "Synthetic invalid row"), profile: null };
  const wire = transport([
    { action: "list", value: page([existing], 7) },
    { action: "list", value: { ...page([replacement], 8), services: [replacement, malformedSecondRow] } },
    { action: "get", value: row("svc-1", 100, "Synthetic other generation", 2) },
    { action: "list", value: page([], 9, 2) },
  ]);
  const controller = createCatalogViewController({ origin: ORIGIN, fetch: wire.fetch });
  controller.reset(1);
  try {
    assert.equal((await execute(controller, createCatalogListRequest(2, null))).kind, "success");
    const accepted = controller.snapshot()!;
    assert.deepEqual(accepted.entries, [existing]);
    for (const request of [createCatalogListRequest(2, null), createCatalogGetRequest("svc-1"),
      createCatalogListRequest(2, null)]) {
      assert.deepEqual(await execute(controller, request), { kind: "invalid", reason: "ENVELOPE" });
      assert.equal(controller.snapshot(), accepted);
      assert.equal(accepted.catalogRevision, 7);
      assert.equal(accepted.refreshRequired, false);
    }
    assert.equal(wire.calls(), 4);
  } finally { controller.dispose(); }
});

test("real client validated older collection page is atomically rejected by the reducer", async () => {
  const current = row("svc-1", 2, "Synthetic current collection");
  const late = page([row("svc-1", 99, "Synthetic rejected replacement"),
    row("svc-2", 1, "Synthetic rejected addition")], 8);
  const held = deferred<typeof late>();
  const wire = transport([{ action: "list", value: held.promise },
    { action: "list", value: page([current], 9) }]);
  const client = createCatalogClient({ origin: ORIGIN, fetch: wire.fetch, readViewContext: () => CONTEXT });
  const delayed = client(createCatalogListRequest(2, null));
  try {
    assert.equal(wire.calls(), 1);
    const fresh = await client(createCatalogListRequest(2, null));
    assert.equal(fresh.kind, "success");
    const accepted = reduceCatalogViewState(createCatalogViewState(CONTEXT.viewScope, 1),
      { type: "response", result: fresh });
    assert.deepEqual(accepted.entries, [current]);
    assert.equal(accepted.catalogRevision, 9);
    held.resolve(late);
    const oldResult = await delayed;
    assert.equal(oldResult.kind, "success", "the transport does not own global view ordering");
    // Pass the exact completed result. Never relabel it with the current scope.
    const rejected = reduceCatalogViewState(accepted, { type: "response", result: oldResult });
    assert.equal(rejected.entries, accepted.entries);
    assert.equal(rejected.catalogRevision, 9);
    assert.equal(rejected.refreshRequired, true);
    assert.equal(reduceCatalogViewState(rejected, { type: "response", result: oldResult }), rejected);
    assert.equal(wire.calls(), 2);
  } finally {
    held.resolve(late);
    await delayed;
  }
});
