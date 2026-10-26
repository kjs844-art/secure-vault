import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG_VIEW_SCHEMA, catalogErrorStatus, decodeCatalogError, decodeCatalogSuccess,
  decodeCatalogSuccessForRequest, type CatalogHttpErrorCode,
} from "../src/domain/catalog-client/responses.ts";
import {
  createCatalogCreateRequest, createCatalogDeleteRequest, createCatalogGetRequest,
  createCatalogListRequest, createCatalogUpdateRequest, type CatalogRequest,
} from "../src/domain/catalog-client/requests.ts";
import { createServiceCatalog } from "../src/server/catalog/service-catalog.ts";
import { createReviewMemoryStore } from "./support/review-memory-store.ts";

// Synthetic value-boundary checks only. No network, auth, storage or real keys.
function profile() {
  return { name: "Synthetic Service", provider: null, planName: null, accountLabel: null,
    timezone: "Asia/Seoul", subscriptionStatus: "active", trialEndsAt: null, notes: null };
}
function service(serviceId = "synthetic-service-1") {
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, serviceId, serviceRevision: 1,
    state: "live", profile: profile(), createdAt: 1, updatedAt: 1,
    provenance: "user-reported", accountProof: "not-established" };
}
function page() {
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, catalogRevision: 3,
    services: [service()], nextCursor: null };
}
function receipt(row: unknown = service(), replayed = false) {
  return { operationId: "synthetic-operation", replayed, service: row };
}

test("service views require a live profile and nondecreasing timestamps", () => {
  for (const value of [{ ...service(), profile: null }, { ...service(), state: "deleted" },
    { ...service(), createdAt: 2, updatedAt: 1 }]) {
    assert.equal(decodeCatalogSuccess("get", value), null);
  }
  assert.ok(decodeCatalogSuccess("get", service()));
  assert.ok(decodeCatalogSuccess("get", { ...service(), state: "deleted", profile: null }));
});

test("list pages contain only same-generation live services in strict ID order", () => {
  for (const services of [[{ ...service(), state: "deleted", profile: null }],
    [{ ...service(), dataGeneration: 2 }], [service(), service()],
    [service("synthetic-service-2"), service()]]) {
    assert.equal(decodeCatalogSuccess("list", { ...page(), services }), null);
  }
  assert.ok(decodeCatalogSuccess("list", page()));
  assert.ok(decodeCatalogSuccess("list", { ...page(), services: [] }));
});

test("continuation cursors agree with page generation, revision and final service ID", () => {
  const nextCursor = { afterId: "synthetic-service-1", catalogRevision: 3, dataGeneration: 1 };
  assert.ok(decodeCatalogSuccess("list", { ...page(), nextCursor }));
  for (const bad of [{ ...nextCursor, afterId: "synthetic-service-2" },
    { ...nextCursor, catalogRevision: 4 }, { ...nextCursor, dataGeneration: 2 }]) {
    assert.equal(decodeCatalogSuccess("list", { ...page(), nextCursor: bad }), null);
  }
  assert.equal(decodeCatalogSuccess("list", { ...page(), services: [], nextCursor }), null);
});

test("list decoder does not invoke array entry accessors", () => {
  let reads = 0;
  const services = [service()];
  Object.defineProperty(services, "0", { enumerable: true, get() { reads++; return service(); } });
  assert.equal(decodeCatalogSuccess("list", { ...page(), services }), null);
  assert.equal(reads, 0);
});

test("list decoder rejects sparse, hidden, decorated and oversized arrays", () => {
  const hidden = [service()];
  Object.defineProperty(hidden, "0", { value: service(), enumerable: false });
  for (const services of [Array(1), hidden, Object.assign([service()], { extra: true }),
    Object.assign([service()], { [Symbol("synthetic")]: true }),
    Array.from({ length: 51 }, (_, index) => service(`synthetic-${String(index).padStart(2, "0")}`))]) {
    assert.equal(decodeCatalogSuccess("list", { ...page(), services }), null);
  }
});

test("oversized list arrays are rejected before enumerating entry descriptors", () => {
  let enumerations = 0;
  let entryDescriptors = 0;
  const services = new Proxy(Array(51).fill(null), {
    ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      if (key !== "length") entryDescriptors++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.equal(decodeCatalogSuccess("list", { ...page(), services }), null);
  assert.equal(enumerations, 0);
  assert.equal(entryDescriptors, 0);
});

test("unknown runtime actions are not interpreted as list", () => {
  assert.equal(decodeCatalogSuccess("other" as never, page()), null);
});

test("get responses are bound to the requested service ID, including tombstones", () => {
  const request = createCatalogGetRequest("synthetic-service-1");
  assert.ok(decodeCatalogSuccessForRequest(request, service()));
  assert.ok(decodeCatalogSuccessForRequest(request, { ...service(), state: "deleted", profile: null }));
  assert.equal(decodeCatalogSuccessForRequest(request, service("synthetic-other")), null);
  assert.equal(decodeCatalogSuccessForRequest(request, receipt()), null);
});

test("all mutation receipts must acknowledge the exact operation ID", () => {
  const requests = [createCatalogCreateRequest("synthetic-operation", profile()),
    createCatalogUpdateRequest("synthetic-service-1", 1, "synthetic-operation", profile()),
    createCatalogDeleteRequest("synthetic-service-1", 1, "synthetic-operation")];
  for (const request of requests) {
    const row = { ...service(), serviceRevision: request.action === "create" ? 1 : 2,
      ...(request.action === "delete" ? { state: "deleted", profile: null } : {}) };
    assert.ok(decodeCatalogSuccessForRequest(request, receipt(row)));
    for (const replayed of [false, true]) {
      assert.equal(decodeCatalogSuccessForRequest(request,
        { ...receipt(row, replayed), operationId: "synthetic-other" }), null);
    }
  }
});

test("fresh create is live revision one with the exact profile and creation timestamp", () => {
  const request = createCatalogCreateRequest("synthetic-operation", profile());
  assert.ok(decodeCatalogSuccessForRequest(request, receipt()));
  for (const row of [{ ...service(), serviceRevision: 2 }, { ...service(), updatedAt: 2 },
    { ...service(), state: "deleted", profile: null }]) {
    assert.equal(decodeCatalogSuccessForRequest(request, { ...receipt(), service: row }), null);
  }
  // Compare each field, not just the display name.
  const changes = { name: "Other", provider: "Other provider", planName: "Other plan", accountLabel: "Other account",
    timezone: "UTC", subscriptionStatus: "trial", trialEndsAt: "2026-10-17", notes: "Other note" };
  for (const [field, value] of Object.entries(changes)) {
    assert.equal(decodeCatalogSuccessForRequest(request,
      receipt({ ...service(), profile: { ...profile(), [field]: value } })), null, field);
  }
});

test("fresh updates bind target ID, exact next revision, live state and profile", () => {
  const request = createCatalogUpdateRequest("synthetic-service-1", 3, "synthetic-operation", profile());
  const row = { ...service(), serviceRevision: 4, updatedAt: 4 };
  assert.ok(decodeCatalogSuccessForRequest(request, receipt(row)));
  for (const changed of [{ ...row, serviceId: "synthetic-other" }, { ...row, serviceRevision: 3 },
    { ...row, serviceRevision: 5 }, { ...row, state: "deleted", profile: null },
    { ...row, profile: { ...profile(), notes: "Changed" } }]) {
    assert.equal(decodeCatalogSuccessForRequest(request, { ...receipt(), service: changed }), null);
  }
});

test("delete acknowledgements require matching IDs and an advanced deleted row", () => {
  const request = createCatalogDeleteRequest("synthetic-service-1", 3, "synthetic-operation");
  const row = { ...service(), serviceRevision: 4, state: "deleted", profile: null, updatedAt: 4 };
  for (const replayed of [false, true]) {
    assert.ok(decodeCatalogSuccessForRequest(request, { ...receipt(), replayed, service: row }));
    for (const changed of [{ ...row, serviceId: "synthetic-other" }, { ...row, serviceRevision: 3 },
      { ...row, state: "live", profile: profile() }]) {
      assert.equal(decodeCatalogSuccessForRequest(request, { ...receipt(), replayed, service: changed }), null);
    }
  }
  assert.equal(decodeCatalogSuccessForRequest(request,
    { ...receipt(), service: { ...row, serviceRevision: 5 } }), null);
  assert.ok(decodeCatalogSuccessForRequest(request,
    { ...receipt(), replayed: true, service: { ...row, serviceRevision: 5 } }));
});

test("create and update replays accept newer profiles and current deletion tombstones", () => {
  const requests = [createCatalogCreateRequest("synthetic-operation", profile()),
    createCatalogUpdateRequest("synthetic-service-1", 2, "synthetic-operation", profile())];
  for (const request of requests) {
    for (const row of [{ ...service(), serviceRevision: 4, profile: { ...profile(), name: "Renamed later" } },
      { ...service(), serviceRevision: 5, state: "deleted", profile: null }]) {
      assert.ok(decodeCatalogSuccessForRequest(request, { ...receipt(), replayed: true, service: row }));
      assert.equal(decodeCatalogSuccessForRequest(request, { ...receipt(), replayed: false, service: row }), null);
    }
    const revision = request.action === "create" ? 1 : 3;
    assert.equal(decodeCatalogSuccessForRequest(request, { ...receipt(), replayed: true,
      service: { ...service(), serviceRevision: revision, profile: { ...profile(), name: "Wrong same revision" } } }), null);
  }
  const update = createCatalogUpdateRequest("synthetic-service-1", 2, "synthetic-operation", profile());
  assert.equal(decodeCatalogSuccessForRequest(update, receipt({ ...service(), serviceRevision: 2 }, true)), null);
  assert.equal(decodeCatalogSuccessForRequest(update,
    receipt({ ...service("synthetic-other"), serviceRevision: 4 }, true)), null);
});

test("overflowed next revisions cannot be acknowledged", () => {
  for (const request of [createCatalogUpdateRequest("synthetic-service-1", Number.MAX_SAFE_INTEGER,
    "synthetic-operation", profile()), createCatalogDeleteRequest("synthetic-service-1", Number.MAX_SAFE_INTEGER,
    "synthetic-operation")]) {
    assert.equal(decodeCatalogSuccessForRequest(request,
      receipt({ ...service(), serviceRevision: Number.MAX_SAFE_INTEGER }, true)), null);
  }
});

test("list page length and continuation fullness match the requested limit", () => {
  const nextCursor = { afterId: "synthetic-service-1", catalogRevision: 3, dataGeneration: 1 };
  assert.ok(decodeCatalogSuccessForRequest(createCatalogListRequest(1, null), { ...page(), nextCursor }));
  assert.ok(decodeCatalogSuccessForRequest(createCatalogListRequest(2, null), page()));
  assert.equal(decodeCatalogSuccessForRequest(createCatalogListRequest(2, null), { ...page(), nextCursor }), null);
  assert.equal(decodeCatalogSuccessForRequest(createCatalogListRequest(1, null),
    { ...page(), services: [service(), service("synthetic-service-2")] }), null);
});

test("list continuations stay in the requested snapshot and advance after the cursor", () => {
  const cursor = { afterId: "synthetic-service-1", catalogRevision: 3, dataGeneration: 1 };
  const request = createCatalogListRequest(1, cursor);
  const valid = { ...page(), services: [service("synthetic-service-2")] };
  assert.ok(decodeCatalogSuccessForRequest(request, valid));
  assert.ok(decodeCatalogSuccessForRequest(request, { ...valid, services: [] }));
  for (const value of [page(), { ...valid, services: [service("synthetic-service-0")] },
    { ...valid, catalogRevision: 4 },
    { ...valid, dataGeneration: 2, services: [{ ...service("synthetic-service-2"), dataGeneration: 2 }] }]) {
    assert.equal(decodeCatalogSuccessForRequest(request, value), null);
  }
});

test("fixed error codes have the exact internal HTTP status mapping", () => {
  const expected: Readonly<Record<CatalogHttpErrorCode, number>> = {
    API_NOT_FOUND: 404, API_METHOD_NOT_ALLOWED: 405, API_REQUEST_REJECTED: 403,
    API_MEDIA_TYPE: 415, API_BODY_TOO_LARGE: 413, API_INPUT_INVALID: 400,
    API_AUTH_REQUIRED: 401, API_SESSION_CHANGED: 403, API_RATE_LIMITED: 429,
    API_CONFLICT: 409, API_UNAVAILABLE: 503, API_TIMEOUT: 408, API_ABORTED: 408,
  };
  for (const [code, status] of Object.entries(expected)) {
    assert.equal(decodeCatalogError({ ok: false, code }), code);
    assert.equal(catalogErrorStatus(code as CatalogHttpErrorCode), status);
  }
});

test("actual synthetic server create/update/delete/replay/get/list values remain accepted", async () => {
  const store = createReviewMemoryStore();
  store.rows.services.clear();
  const catalog = createServiceCatalog(store.catalogDependencies);
  async function execute(request: CatalogRequest) {
    const dispatch = request.action === "delete" ? catalog.remove : catalog[request.action];
    const response = await dispatch(request.body);
    assert.ok(response.ok);
    const decoded = decodeCatalogSuccessForRequest(request, response.value);
    assert.ok(decoded);
    return decoded;
  }
  const create = createCatalogCreateRequest("synthetic-create", profile());
  const initial = await execute(create);
  assert.equal(initial.kind, "receipt");
  if (initial.kind !== "receipt") assert.fail();
  const id = initial.receipt.service.serviceId;
  await execute(create);
  const update = createCatalogUpdateRequest(id, 1, "synthetic-update", { ...profile(), name: "Renamed later" });
  await execute(update);
  await execute(create);
  await execute(update);
  await execute(createCatalogGetRequest(id));
  await execute(createCatalogCreateRequest("synthetic-create-second", { ...profile(), name: "Second synthetic service" }));
  const firstPage = await execute(createCatalogListRequest(1, null));
  assert.equal(firstPage.kind, "page");
  if (firstPage.kind !== "page") assert.fail();
  assert.ok(firstPage.page.nextCursor);
  const secondPage = await execute(createCatalogListRequest(1, firstPage.page.nextCursor));
  assert.equal(secondPage.kind, "page");
  if (secondPage.kind !== "page") assert.fail();
  assert.equal(secondPage.page.nextCursor, null);
  const remove = createCatalogDeleteRequest(id, 2, "synthetic-delete");
  await execute(remove);
  await execute(remove);
  await execute(create);
  await execute(update);
  await execute(createCatalogGetRequest(id));
  await execute(createCatalogListRequest(1, null));
});
