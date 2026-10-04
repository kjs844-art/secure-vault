import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import {
  createCatalogClient, createCatalogCreateRequest, createCatalogUpdateRequest,
  createCatalogDeleteRequest, createCatalogGetRequest, createCatalogListRequest,
  type CatalogCallResult, type CatalogClientConfig,
} from "../src/domain/catalog-client/index.ts";
import { startCatalogLoopback, reviewAuthority, type LoopbackFixture, type LoopbackFixtureOptions }
  from "./support/catalog-http-loopback.ts";

// Synthetic client -> actual owned loopback HTTP -> existing handler -> memory
// store. The Node-only transport below supplies fixture cookie/Origin as a
// browser would. It is not a production session, browser cookie policy or DB.

const profile = { name: "합성 서비스", provider: null, planName: null, accountLabel: null,
  timezone: "Asia/Seoul", subscriptionStatus: "unknown", trialEndsAt: null, notes: null };

async function withFixture(run: (fixture: LoopbackFixture) => Promise<void>, options: LoopbackFixtureOptions = {}) {
  const fixture = await startCatalogLoopback(options);
  try { await run(fixture); } finally {
    await fixture.close();
    assert.equal(fixture.openSockets, 0);
  }
}

function connectedClient(fixture: LoopbackFixture, timeoutMs = 10000) {
  const outbound: Request[] = [];
  const fetchFixture: CatalogClientConfig["fetch"] = async (request, signal) => {
    outbound.push(request);
    assert.equal(new URL(request.url).origin, fixture.origin);
    assert.equal(request.method, "POST");
    assert.equal(request.credentials, "same-origin");
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.get("x-keyatlas-request"), "catalog-v1");
    assert.equal(request.headers.get("cookie"), null);
    assert.equal(request.headers.get("origin"), null);
    assert.equal(request.headers.get("authorization"), null);
    const headers = new Headers(request.headers);
    headers.set("origin", fixture.origin);
    headers.set("cookie", "synthetic-session=fixture");
    return fetch(new Request(request, { headers, signal }));
  };
  return { call: createCatalogClient({ origin: fixture.origin, fetch: fetchFixture, timeoutMs }), outbound };
}

function receipt(result: CatalogCallResult) {
  assert.ok(result.kind === "success" && result.success.kind === "receipt");
  return result.success.receipt;
}

test("client decodes CRUD/list over actual HTTP and replays the current deleted row", { timeout: 10000 }, async () => {
  await withFixture(async (fixture) => {
    const { call, outbound } = connectedClient(fixture);
    const original = createCatalogCreateRequest("synthetic-create", profile);
    const created = receipt(await call(original));
    assert.equal(created.replayed, false);
    assert.equal(created.service.profile!.name, profile.name);
    assert.equal(created.service.provenance, "user-reported");
    assert.equal(created.service.accountProof, "not-established");
    const replayed = receipt(await call(original));
    assert.equal(replayed.replayed, true);
    assert.deepEqual(replayed.service, created.service);
    const got = await call(createCatalogGetRequest(created.service.serviceId));
    assert.ok(got.kind === "success" && got.success.kind === "view");
    assert.deepEqual(got.success.view, created.service);
    const updated = receipt(await call(createCatalogUpdateRequest(created.service.serviceId,
      created.service.serviceRevision, "synthetic-update", { ...profile, name: "변경된 합성 서비스" })));
    assert.equal(updated.service.serviceRevision, created.service.serviceRevision + 1);
    const listed = await call(createCatalogListRequest(50, null));
    assert.ok(listed.kind === "success" && listed.success.kind === "page");
    assert.deepEqual(listed.success.page.services, [updated.service]);
    const deleted = receipt(await call(createCatalogDeleteRequest(created.service.serviceId,
      updated.service.serviceRevision, "synthetic-delete")));
    assert.equal(deleted.service.state, "deleted");
    assert.equal(deleted.service.profile, null);
    const replayAfterDelete = receipt(await call(original));
    assert.equal(replayAfterDelete.replayed, true);
    assert.deepEqual(replayAfterDelete.service, deleted.service);
    assert.equal(outbound.length, 7);
    assert.equal(fixture.store.rows.services.size, 1);
    assert.equal(fixture.store.rows.catalogOperations.size, 3);
  });
});

test("a lost response after commit is aborted and a manual same-operation retry replays", { timeout: 10000 }, async () => {
  await withFixture(async (fixture) => {
    const caller = new AbortController();
    const { call, outbound } = connectedClient(fixture);
    const original = createCatalogCreateRequest("synthetic-lost-response", profile);
    fixture.store.controls.afterCommit = () => { caller.abort(); };
    assert.deepEqual(await call(original, caller.signal), { kind: "aborted" });
    await fixture.whenIdle();
    assert.equal(outbound.length, 1);
    assert.equal(fixture.store.controls.commits, 1);
    assert.equal(fixture.store.controls.rollbacks, 0);
    assert.equal(fixture.store.rows.services.size, 1);
    delete fixture.store.controls.afterCommit;
    const retry = receipt(await call(original));
    assert.equal(retry.replayed, true);
    assert.equal(outbound.length, 2);
    assert.equal(fixture.store.rows.services.size, 1);
    assert.equal(fixture.store.rows.catalogOperations.size, 1);
  });
});

test("client timeout before admission commit cancels the handler and a fresh request works", { timeout: 10000 }, async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await withFixture(async (fixture) => {
    const { call } = connectedClient(fixture, 1000);
    const original = createCatalogCreateRequest("synthetic-client-timeout", profile);
    assert.deepEqual(await call(original), { kind: "timeout" });
    // Observe server-side termination before releasing admission. A local
    // timeout alone does not prove the server has seen the disconnect.
    await fixture.whenIdle();
    assert.equal(fixture.admissions.length, 1);
    assert.equal(fixture.admissions[0]!.signal.aborted, true);
    release();
    await setImmediate();
    assert.equal(fixture.store.controls.commits, 0);
    assert.equal(fixture.store.rows.services.size, 0);
    const fresh = receipt(await call(original));
    assert.equal(fresh.replayed, false);
    assert.equal(fixture.store.rows.services.size, 1);
  }, { requestTimeoutMs: 5000, admit: async (request) => {
    await gate;
    return { allowed: true, requestId: request.requestId, action: request.action,
      authority: request.authority, expiresAt: request.notAfter };
  } });
});

test("same-generation session switches return a fixed error without a write", { timeout: 10000 }, async () => {
  let reads = 0;
  await withFixture(async (fixture) => {
    const { call } = connectedClient(fixture);
    assert.deepEqual(await call(createCatalogCreateRequest("synthetic-session-switch", profile)),
      { kind: "error", code: "API_SESSION_CHANGED", retriableAfterMs: null });
    assert.equal(fixture.store.controls.commits, 0);
    assert.equal(fixture.store.rows.services.size, 0);
    assert.equal(receipt(await call(createCatalogCreateRequest("synthetic-fresh-session", profile))).replayed, false);
  }, { readSession: async () => reviewAuthority(++reads === 2
    ? { ownerId: "synthetic-other-owner", sessionId: "synthetic-other-session", dataGeneration: 1 } : {}) });
});

test("real HTTP rate-limit responses keep retry-after and do not automatically retry", { timeout: 10000 }, async () => {
  await withFixture(async (fixture) => {
    const { call, outbound } = connectedClient(fixture);
    assert.deepEqual(await call(createCatalogListRequest(50, null)),
      { kind: "error", code: "API_RATE_LIMITED", retriableAfterMs: 30000 });
    assert.equal(outbound.length, 1);
    assert.equal(fixture.admissions.length, 1);
    assert.equal(fixture.store.controls.commits, 0);
  }, { admit: async () => ({ allowed: false, retryAfterSeconds: 30 }) });
});
