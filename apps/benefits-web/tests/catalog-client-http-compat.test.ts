import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCatalogClient, createCatalogCreateRequest, createCatalogDeleteRequest,
  createCatalogGetRequest, createCatalogListRequest, createCatalogUpdateRequest,
  type CatalogRequest,
} from "../src/domain/catalog-client/client.ts";
import { createCatalogHttpHandler } from "../src/server/http/catalog-http.ts";
import type { ServiceProfile } from "../src/server/catalog/contracts.ts";
import { createReviewMemoryStore, SYNTHETIC_PRIVATE } from "./support/review-memory-store.ts";

// Compose the real client and HTTP handler with the existing synthetic memory
// ports. No listening server, network, browser cookies, account or durable DB.
const ORIGIN = "https://catalog-compat.example.test";
const COOKIE = "synthetic-session=compat-fixture";
const VIEW = Object.freeze({ viewScope: "synthetic-http-compat-view", dataGeneration: 1 });
type Mode = "normal" | "signed-out" | "rate-limited" | "unavailable" | "wrong-origin";
function profile(patch: Partial<ServiceProfile> = {}): ServiceProfile {
  return { name: "Synthetic compatibility service", provider: null, planName: null,
    accountLabel: null, timezone: "Asia/Seoul", subscriptionStatus: "active",
    trialEndsAt: null, notes: null, ...patch };
}
function fixture(mode: Mode = "normal") {
  const store = createReviewMemoryStore();
  store.rows.services.clear();
  const observations: Array<{ status: number; retryAfter: string | null }> = [];
  let admissionCount = 0;
  const handler = createCatalogHttpHandler({
    trustedOrigin: ORIGIN,
    now: () => store.controls.now,
    newId: () => store.catalogDependencies.newId(),
    readSession: async (context) => {
      assert.deepEqual(context, { cookie: COOKIE });
      if (mode === "unavailable") throw new Error(SYNTHETIC_PRIVATE);
      return mode === "signed-out" ? null : structuredClone(store.controls.authority);
    },
    admit: async (request) => {
      admissionCount++;
      return mode === "rate-limited" ? { allowed: false, retryAfterSeconds: 7 }
        : { allowed: true, requestId: request.requestId, action: request.action,
          authority: request.authority, expiresAt: request.notAfter };
    },
    transaction: (authority, action) => store.catalogDependencies.transaction(authority, action),
  });
  const call = createCatalogClient({
    origin: ORIGIN, readViewContext: () => VIEW,
    fetch: async (request, signal) => {
      assert.equal(request.method, "POST");
      assert.equal(request.credentials, "same-origin");
      assert.equal(request.redirect, "error");
      assert.equal(request.headers.get("x-keyatlas-request"), "catalog-v1");
      assert.equal(new URL(request.url).search, "");
      // Model the headers a same-origin browser/session port supplies. They are
      // deliberately synthetic and are not added by production client code.
      const headers = new Headers(request.headers);
      headers.set("origin", mode === "wrong-origin" ? "https://other.example.test" : ORIGIN);
      headers.set("sec-fetch-site", "same-origin");
      headers.set("cookie", COOKIE);
      const response = await handler(new Request(request, { headers, signal }));
      observations.push({ status: response.status, retryAfter: response.headers.get("retry-after") });
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
      for (const name of ["set-cookie", "access-control-allow-origin", "access-control-allow-credentials",
        "authorization", "cookie"]) assert.equal(response.headers.get(name), null);
      return response;
    },
  });
  return { store, call, observations, admissionCount: () => admissionCount };
}
type Fixture = ReturnType<typeof fixture>;
async function success(f: Fixture, request: CatalogRequest) {
  const result = await f.call(request);
  if (result.kind !== "success") assert.fail(`Expected compatible HTTP success, got ${result.kind}`);
  assert.deepEqual(result.capturedScope, VIEW);
  assert.equal(f.observations.at(-1)?.status, 200);
  assert.equal(f.observations.at(-1)?.retryAfter, null);
  return result.success;
}
async function receipt(f: Fixture, request: CatalogRequest) {
  const result = await success(f, request);
  if (result.kind !== "receipt") assert.fail("Expected mutation receipt");
  return result.receipt;
}

test("actual HTTP CRUD and original-operation retries preserve current-row receipt compatibility", async () => {
  const f = fixture();
  const create = createCatalogCreateRequest("synthetic-compat-create", profile());
  const first = await receipt(f, create);
  assert.equal(first.replayed, false);
  assert.equal(first.service.serviceRevision, 1);
  assert.deepEqual(first.service.profile, profile());
  assert.equal((await receipt(f, create)).replayed, true);
  const id = first.service.serviceId;
  const get = await success(f, createCatalogGetRequest(id));
  assert.deepEqual(get, { kind: "view", view: first.service });
  const renamed = profile({ name: "Synthetic renamed service", notes: "합성\n메모",
    trialEndsAt: "2028-02-29T12:30:00.123456789+09:00" });
  const update = createCatalogUpdateRequest(id, 1, "synthetic-compat-update", renamed);
  const updated = await receipt(f, update);
  assert.equal(updated.replayed, false);
  assert.equal(updated.service.serviceRevision, 2);
  assert.deepEqual(updated.service.profile, renamed);
  for (const request of [create, update]) {
    const replay = await receipt(f, request);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.service, updated.service);
  }
  const remove = createCatalogDeleteRequest(id, 2, "synthetic-compat-delete");
  const deleted = await receipt(f, remove);
  assert.equal(deleted.replayed, false);
  assert.equal(deleted.service.serviceRevision, 3);
  assert.equal(deleted.service.state, "deleted");
  assert.equal(deleted.service.profile, null);
  for (const request of [remove, create, update]) {
    const replay = await receipt(f, request);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.service, deleted.service);
  }
  assert.deepEqual(await success(f, createCatalogGetRequest(id)), { kind: "view", view: deleted.service });
  const listed = await success(f, createCatalogListRequest(50, null));
  if (listed.kind !== "page") assert.fail("Expected page");
  assert.deepEqual(listed.page.services, []);
  assert.equal(listed.page.nextCursor, null);
  assert.equal(f.store.rows.services.size, 1);
  assert.equal(f.store.rows.catalogOperations.size, 3);
  assert.equal(f.admissionCount(), f.observations.length, "Each retry needs separate HTTP admission");
});

test("actual HTTP list cursors remain compatible and stale snapshots become typed conflicts", async () => {
  const f = fixture();
  const ids = new Set<string>();
  for (const operationId of ["synthetic-compat-first", "synthetic-compat-second"]) {
    ids.add((await receipt(f, createCatalogCreateRequest(operationId, profile()))).service.serviceId);
  }
  const first = await success(f, createCatalogListRequest(1, null));
  if (first.kind !== "page") assert.fail("Expected first page");
  assert.ok(first.page.nextCursor);
  const continuation = createCatalogListRequest(1, first.page.nextCursor);
  const second = await success(f, continuation);
  if (second.kind !== "page") assert.fail("Expected second page");
  assert.equal(second.page.nextCursor, null);
  assert.deepEqual(new Set([...first.page.services, ...second.page.services].map((row) => row.serviceId)), ids);
  assert.equal(first.page.catalogRevision, second.page.catalogRevision);
  await receipt(f, createCatalogCreateRequest("synthetic-compat-third", profile()));
  const before = f.store.snapshot();
  assert.deepEqual(await f.call(continuation), { kind: "error", code: "API_CONFLICT", retriableAfterMs: null });
  assert.deepEqual(f.observations.at(-1), { status: 409, retryAfter: null });
  assert.deepEqual(f.store.snapshot(), before);
});

test("actual HTTP rejects changed operation fingerprints without a mutation or false success", async () => {
  const f = fixture();
  await receipt(f, createCatalogCreateRequest("synthetic-compat-once", profile()));
  const before = f.store.snapshot();
  assert.deepEqual(await f.call(createCatalogCreateRequest("synthetic-compat-once", profile({ name: "Different" }))),
    { kind: "error", code: "API_CONFLICT", retriableAfterMs: null });
  assert.deepEqual(f.observations.at(-1), { status: 409, retryAfter: null });
  assert.deepEqual(f.store.snapshot(), before);
});

for (const [mode, code, status] of [
  ["normal", "API_NOT_FOUND", 404],
  ["signed-out", "API_AUTH_REQUIRED", 401],
  ["wrong-origin", "API_REQUEST_REJECTED", 403],
  ["rate-limited", "API_RATE_LIMITED", 429],
  ["unavailable", "API_UNAVAILABLE", 503],
] as const) {
  test(`actual HTTP ${code} status and headers become the expected client result without writes`, async () => {
    const f = fixture(mode), before = f.store.snapshot();
    assert.deepEqual(await f.call(createCatalogGetRequest("synthetic-compat-missing")),
      { kind: "error", code, retriableAfterMs: status === 429 ? 7000 : null });
    assert.deepEqual(f.observations, [{ status, retryAfter: status === 429 ? "7" : null }]);
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(f.store.rows.catalogOperations.size, 0);
  });
}
