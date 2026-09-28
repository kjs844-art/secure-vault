import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";
import type { CatalogHttpError } from "../src/server/http/catalog-http-contracts.ts";
import type { CatalogPage, CatalogReceipt, CatalogView, ServiceProfile }
  from "../src/server/catalog/contracts.ts";
import {
  loopbackRequest, reviewAuthority, startCatalogLoopback, SYNTHETIC_PRIVATE,
  type LoopbackFixture, type LoopbackFixtureOptions,
} from "./support/catalog-http-loopback.ts";

// Real 127.0.0.1 loopback HTTP framing with a synthetic server, session,
// admission and memory adapters only. Not the production route, real
// authentication, limiter, database, proxy, TLS or browser evidence.

const profile = (patch: Partial<ServiceProfile> = {}): ServiceProfile => ({
  name: "Synthetic Loopback Studio", provider: null, planName: null, accountLabel: null,
  timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null, ...patch,
});
const createBody = (operationId: string, value = profile()) =>
  JSON.stringify({ operationId, decision: "create", profile: value });

async function withFixture(run: (f: LoopbackFixture) => Promise<void>, options: LoopbackFixtureOptions = {}) {
  const fixture = await startCatalogLoopback(options);
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  assert.ok(![...response.headers].some(([name]) => name.toLowerCase() === "set-cookie"));
  assert.ok(![...response.headers].some(([name]) => name.toLowerCase().startsWith("access-control-allow")));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  const text = await response.text();
  assert.ok(!text.includes(SYNTHETIC_PRIVATE));
  return JSON.parse(text) as Record<string, unknown>;
}

async function success<T>(response: Response): Promise<T> {
  const value = await readJson(response);
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.deepEqual(Object.keys(value).sort(), ["ok", "value"]);
  assert.equal(value.ok, true);
  return value.value as T;
}

async function failure(response: Response, code: CatalogHttpError, status: number) {
  assert.deepEqual(await readJson(response), { ok: false, code });
  assert.equal(response.status, status);
  if (code === "API_METHOD_NOT_ALLOWED") assert.equal(response.headers.get("allow"), "POST");
  else assert.equal(response.headers.get("allow"), null);
  if (code !== "API_RATE_LIMITED") assert.equal(response.headers.get("retry-after"), null);
}

test("loopback server starts on an OS-chosen 127.0.0.1 port and stops cleanly", async () => {
  await withFixture(async (f) => {
    const parsed = new URL(f.origin);
    assert.equal(parsed.hostname, "127.0.0.1");
    assert.ok(Number(parsed.port) > 0);
    const page = await success<CatalogPage>(await loopbackRequest(f, {
      path: "/api/catalog/list", body: JSON.stringify({ limit: 50, cursor: null }),
    }));
    assert.deepEqual(page.services, []);
    assert.equal(page.nextCursor, null);
  });
});

test("create/get/update/list/delete flow works over actual loopback HTTP", async () => {
  await withFixture(async (f) => {
    const created = await success<CatalogReceipt>(await loopbackRequest(f, { body: createBody("loopback-create-1") }));
    assert.equal(created.replayed, false);
    assert.equal(created.service.state, "live");
    assert.deepEqual(created.service.profile, profile());
    assert.equal(created.service.provenance, "user-reported");
    assert.equal(created.service.accountProof, "not-established");

    const got = await success<CatalogView>(await loopbackRequest(f, {
      path: "/api/catalog/get", body: JSON.stringify({ serviceId: created.service.serviceId }),
    }));
    assert.deepEqual(got, created.service);

    const updated = await success<CatalogReceipt>(await loopbackRequest(f, {
      path: "/api/catalog/update",
      body: JSON.stringify({ serviceId: created.service.serviceId, expectedRevision: created.service.serviceRevision,
        operationId: "loopback-update-1", decision: "update",
        profile: profile({ name: "Renamed Loopback", timezone: "Asia/Seoul" }) }),
    }));
    assert.equal(updated.service.serviceRevision, created.service.serviceRevision + 1);

    const page = await success<CatalogPage>(await loopbackRequest(f, {
      path: "/api/catalog/list", body: JSON.stringify({ limit: 50, cursor: null }),
    }));
    assert.equal(page.services.length, 1);
    assert.deepEqual(page.services[0], updated.service);

    const deleted = await success<CatalogReceipt>(await loopbackRequest(f, {
      path: "/api/catalog/delete",
      body: JSON.stringify({ serviceId: updated.service.serviceId, expectedRevision: updated.service.serviceRevision,
        operationId: "loopback-delete-1", decision: "delete" }),
    }));
    assert.equal(deleted.service.state, "deleted");
    assert.equal(deleted.service.profile, null);
    assert.equal(f.store.rows.services.size, 1);
    assert.equal(f.store.rows.catalogOperations.size, 3);
    assert.equal(f.store.controls.commits, 5, "every action including get/list runs its own transaction");
    assert.equal(f.store.controls.rollbacks, 0);
  });
});

test("same-operation retry replays the current row over real HTTP", async () => {
  await withFixture(async (f) => {
    const first = await success<CatalogReceipt>(await loopbackRequest(f, { body: createBody("loopback-retry-1") }));
    assert.equal(first.replayed, false);
    const retry = await success<CatalogReceipt>(await loopbackRequest(f, { body: createBody("loopback-retry-1") }));
    assert.equal(retry.replayed, true);
    assert.deepEqual(retry.service, first.service);
    assert.equal(f.store.rows.services.size, 1);
    assert.equal(f.store.rows.catalogOperations.size, 1);
    assert.equal(f.admissions.length, 2, "each HTTP retry is admitted independently");
  });
});

test("origin, marker, route, method and missing-cookie rejections return fixed codes over loopback", async () => {
  await withFixture(async (f) => {
    await failure(await loopbackRequest(f, { headers: { origin: f.origin + "/" } }), "API_REQUEST_REJECTED", 403);
    await failure(await loopbackRequest(f, { headers: { "x-keyatlas-request": "catalog-v2" } }),
      "API_REQUEST_REJECTED", 403);
    await failure(await loopbackRequest(f, { headers: { origin: "https://other.example.test" } }),
      "API_REQUEST_REJECTED", 403);
    await failure(await loopbackRequest(f, { method: "GET", path: "/api/catalog/list" }),
      "API_METHOD_NOT_ALLOWED", 405);
    await failure(await loopbackRequest(f, { path: "/api/catalog/nope" }), "API_NOT_FOUND", 404);
    await failure(await loopbackRequest(f, { headers: { cookie: "" } }), "API_AUTH_REQUIRED", 401);
    assert.equal(f.sessions.length, 0);
    assert.equal(f.admissions.length, 0);
    assert.equal(f.store.rows.services.size, 0);
    assert.equal(f.store.controls.commits, 0);
  });
});

test("media type, size and malformed bodies are rejected with fixed codes", async () => {
  await withFixture(async (f) => {
    await failure(await loopbackRequest(f, { headers: { "content-type": "text/plain" } }), "API_MEDIA_TYPE", 415);
    const big = createBody("loopback-big-1", profile({ notes: "x".repeat(20000) }));
    assert.ok(big.length > 16384);
    await failure(await loopbackRequest(f, { body: big }), "API_BODY_TOO_LARGE", 413);
    await failure(await loopbackRequest(f, { body: "{\"operationId\":" }), "API_INPUT_INVALID", 400);
    assert.equal(f.store.rows.catalogOperations.size, 0);
    assert.equal(f.store.controls.commits, 0);
  });
});

test("a session switch mid-request is a fixed conflict and a later request still works", async () => {
  let sessionReads = 0;
  await withFixture(async (f) => {
    await failure(await loopbackRequest(f, { body: createBody("loopback-switch-1") }), "API_SESSION_CHANGED", 403);
    assert.equal(f.store.rows.services.size, 0);
    assert.equal(f.store.rows.catalogOperations.size, 0);
    assert.equal(f.store.controls.commits, 0);
    const after = await success<CatalogReceipt>(await loopbackRequest(f, { body: createBody("loopback-switch-2") }));
    assert.equal(after.replayed, false);
    assert.equal(f.store.rows.services.size, 1);
  }, {
    readSession: async () => {
      sessionReads += 1;
      if (sessionReads === 2) return structuredClone(reviewAuthority({ sessionRevision: 2 }));
      return structuredClone(reviewAuthority());
    },
  });
});

test("request deadline returns 408, a late adapter answer never becomes a write, and a fresh request works", async () => {
  let release!: (value: unknown) => void;
  const gate = new Promise<unknown>((resolve) => { release = resolve; });
  await withFixture(async (f) => {
    await failure(await loopbackRequest(f, { body: createBody("loopback-deadline-1") }), "API_TIMEOUT", 408);
    assert.ok(f.admissions[0]!.signal.aborted, "the finished request released its adapters");
    release({ allowed: false, retryAfterSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(f.store.rows.services.size, 0, "a late adapter answer after the deadline is not a write");
    assert.equal(f.store.controls.commits, 0);
    const after = await success<CatalogReceipt>(await loopbackRequest(f, { body: createBody("loopback-deadline-2") }));
    assert.equal(after.replayed, false);
    assert.equal(f.store.rows.services.size, 1);
  }, {
    requestTimeoutMs: 100,
    admit: (request) => gate.then(() => ({ allowed: true, requestId: request.requestId,
      action: request.action, authority: request.authority, expiresAt: request.notAfter })),
  });
});

test("client abort before commit leaves the fixture uncommitted and the server usable", async () => {
  const controller = new AbortController();
  await withFixture(async (f) => {
    const pending = loopbackRequest(f, { body: createBody("loopback-abort-1"), signal: controller.signal });
    controller.abort();
    await assert.rejects(pending);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.store.rows.services.size, 0);
    assert.equal(f.store.rows.catalogOperations.size, 0);
    assert.equal(f.store.controls.commits, 0, "fixture commit state is verified, not assumed");
    const after = await success<CatalogReceipt>(await loopbackRequest(f, { body: createBody("loopback-abort-2") }));
    assert.equal(after.replayed, false);
  });
});

test("client abort after commit does not roll back; the same operation ID replays", async () => {
  const controller = new AbortController();
  await withFixture(async (f) => {
    f.store.controls.afterCommit = () => { controller.abort(); };
    await assert.rejects(loopbackRequest(f, {
      body: createBody("loopback-abort-late-1"), signal: controller.signal,
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.store.controls.commits, 1, "the commit already happened before the abort");
    assert.equal(f.store.controls.rollbacks, 0);
    assert.equal(f.store.rows.services.size, 1);
    delete f.store.controls.afterCommit;
    const retry = await success<CatalogReceipt>(await loopbackRequest(f, { body: createBody("loopback-abort-late-1") }));
    assert.equal(retry.replayed, true, "retrying the same operation ID is safe after a lost response");
    assert.equal(f.store.rows.services.size, 1);
    assert.equal(f.store.rows.catalogOperations.size, 1);
  });
});

test("raw non-HTTP bytes are a framing rejection that never reaches the handler", async () => {
  await withFixture(async (f) => {
    const port = Number(new URL(f.origin).port);
    const socket = connect({ port, host: "127.0.0.1" });
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.on("connect", resolve));
    const frames: Buffer[] = []
    socket.on("data", (chunk: Buffer) => frames.push(chunk));
    const closed = new Promise<void>((resolve) => socket.on("close", resolve));
    socket.end("THIS IS NOT HTTP\r\n\r\n");
    await closed;
    const raw = Buffer.concat(frames).toString("latin1");
    assert.match(raw, /^HTTP\/1\.1 400 Bad Request/, "Node's HTTP parser rejects the framing before any handler");
    assert.equal(f.sessions.length, 0, "a Node framing rejection never invokes the handler");
    assert.equal(f.admissions.length, 0);
    assert.equal(f.store.controls.commits, 0);
    const created = await success<CatalogReceipt>(await loopbackRequest(f, { body: createBody("loopback-framing-1") }));
    assert.equal(created.replayed, false);
    assert.ok(f.sessions.length >= 6, "a well-formed request still reaches the handler");
    assert.equal(f.store.rows.services.size, 1);
  });
});

test("server close releases listening sockets so the suite leaves no listeners", async () => {
  const fixture = await startCatalogLoopback();
  const origin = fixture.origin;
  await fixture.close();
  await assert.rejects(() => fetch(origin + "/api/catalog/list", { method: "POST" }));
});
