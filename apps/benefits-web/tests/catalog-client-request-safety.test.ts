import assert from "node:assert/strict";
import { test } from "node:test";
import { createCatalogClient, CATALOG_VIEW_SCHEMA, type CatalogRequest } from "../src/domain/catalog-client/client.ts";
import { snapshotCatalogRequest } from "../src/domain/catalog-client/requests.ts";

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const SYNTHETIC_CONTEXT = Object.freeze({ viewScope: "synthetic-request-safety-view", dataGeneration: 1 });
const readViewContext = () => SYNTHETIC_CONTEXT;
const profile = () => ({ name: "Synthetic Service", provider: null, planName: null, accountLabel: null,
  timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null });
const view = (id: string) => ({ schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, serviceId: id,
  serviceRevision: 1, state: "live", profile: profile(), createdAt: 1, updatedAt: 1,
  provenance: "user-reported", accountProof: "not-established" });
const getRequest = () => ({ action: "get", body: { serviceId: "svc-1" } } as const);

test("request boundary rejects route escapes and malformed bodies before invoking transport", async () => {
  let calls = 0;
  const client = createCatalogClient({ origin: "https://synthetic.invalid", readViewContext, fetch: async () => {
    calls++;
    return new Response("{}", { headers: HEADERS });
  } });
  const invalid: unknown[] = [null, [], {}, { action: "../elsewhere", body: {} },
    { action: "get?query=1", body: { serviceId: "svc-1" } }, { ...getRequest(), extra: true },
    { action: "get", body: { serviceId: "svc-1", extra: true } }, { action: "get", body: { serviceId: " padded " } },
    { action: "create", body: { operationId: "op-1", decision: "delete", profile: profile() } },
    { action: "create", body: { operationId: "op-1", decision: "create", profile: { ...profile(), extra: true } } },
    { action: "update", body: { serviceId: "svc-1", expectedRevision: 0, operationId: "op-1", decision: "update", profile: profile() } },
    { action: "list", body: { limit: 51, cursor: null } }, { action: "list", body: { limit: 1, cursor: [] } },
    Object.assign(Object.create({ inherited: true }), getRequest()),
  ];
  for (const input of invalid) {
    assert.deepEqual(await client(input as CatalogRequest), { kind: "invalid", reason: "REQUEST" });
  }
  assert.equal(calls, 0);
});

test("request boundary rejects accessors and serialization hooks without invoking them", async () => {
  let hooks = 0;
  const getter = () => { hooks++; return "svc-1"; };
  const unsafe: unknown[] = [
    Object.defineProperty({ body: { serviceId: "svc-1" } }, "action", { enumerable: true, get: getter }),
    { action: "get", body: Object.defineProperty({}, "serviceId", { enumerable: true, get: getter }) },
    { action: "create", body: { operationId: "op-1", decision: "create",
      profile: Object.defineProperty(profile(), "name", { enumerable: true, get: getter }) } },
    { action: "get", body: { serviceId: "svc-1", toJSON() { hooks++; return {}; } } },
    { action: "list", body: { limit: 1, cursor: Object.defineProperty({ catalogRevision: 1, dataGeneration: 1 },
      "afterId", { enumerable: true, get: getter }) } },
  ];
  const client = createCatalogClient({ origin: "https://synthetic.invalid", readViewContext, fetch: async () => { throw new Error("transport must not run"); } });
  for (const input of unsafe) assert.deepEqual(await client(input as CatalogRequest), { kind: "invalid", reason: "REQUEST" });
  assert.equal(hooks, 0);
});

test("request snapshots preserve exact valid semantics and detach nested values", () => {
  const requests: unknown[] = [
    { action: "create", body: { operationId: "op-1", decision: "create", profile: profile() } },
    { action: "update", body: { serviceId: "svc-1", expectedRevision: 1, operationId: "op-2", decision: "update", profile: profile() } },
    { action: "delete", body: { serviceId: "svc-1", expectedRevision: 2, operationId: "op-3", decision: "delete" } },
    getRequest(), { action: "list", body: { limit: 2, cursor: { afterId: "svc-1", catalogRevision: 3, dataGeneration: 2 } } },
  ];
  for (const input of requests) {
    const captured = snapshotCatalogRequest(input);
    assert.deepEqual(captured, input);
    assert.notEqual(captured, input);
    assert.ok(Object.isFrozen(captured));
    assert.ok(Object.isFrozen(captured.body));
    if ("profile" in captured.body) assert.ok(Object.isFrozen(captured.body.profile));
    if ("cursor" in captured.body) assert.ok(Object.isFrozen(captured.body.cursor));
  }
});

test("request correlation uses the original wire request after caller mutation", async () => {
  for (const responseId of ["svc-1", "svc-2"]) {
    const input = { action: "get" as const, body: { serviceId: "svc-1" } };
    let finish!: (response: Response) => void;
    let wire!: Request;
    const client = createCatalogClient({ origin: "https://synthetic.invalid", readViewContext, fetch: async (request) => {
      wire = request;
      return new Promise<Response>((resolve) => { finish = resolve; });
    } });
    const pending = client(input);
    input.body.serviceId = "svc-2";
    finish(new Response(JSON.stringify({ ok: true, value: view(responseId) }), { headers: HEADERS }));
    assert.deepEqual(await wire.json(), { serviceId: "svc-1" });
    const result = await pending;
    assert.equal(result.kind, responseId === "svc-1" ? "success" : "invalid");
    if (result.kind === "invalid") assert.equal(result.reason, "ENVELOPE");
  }
});

test("error status and code must agree at the public client boundary", async () => {
  const cases = [[429, "API_CONFLICT"], [500, "API_AUTH_REQUIRED"], [401, "API_RATE_LIMITED"], [400, "API_TIMEOUT"]] as const;
  for (const [status, code] of cases) {
    const client = createCatalogClient({ origin: "https://synthetic.invalid", readViewContext, fetch: async () =>
      new Response(JSON.stringify({ ok: false, code }), { status, headers: { ...HEADERS, "retry-after": "1" } }) });
    assert.deepEqual(await client(getRequest()), { kind: "invalid", reason: "ENVELOPE" });
  }
});

test("header checks require real no-store and UTF-8 JSON directives", async () => {
  for (const headers of [
    { ...HEADERS, "cache-control": "x-no-store" },
    { ...HEADERS, "cache-control": "no-store=false" },
    { ...HEADERS, "content-type": "application/json; charset=utf-16" },
    { ...HEADERS, "content-type": "application/json; arbitrary=1" },
  ]) {
    const client = createCatalogClient({ origin: "https://synthetic.invalid", readViewContext, fetch: async () =>
      new Response(JSON.stringify({ ok: true, value: view("svc-1") }), { headers }) });
    assert.deepEqual(await client(getRequest()), { kind: "invalid", reason: "HEADERS" });
  }
});

test("redirected or off-target adapter responses are rejected before body consumption", async () => {
  const origin = "https://synthetic.invalid";
  for (const patch of [{ redirected: true }, { url: "https://other.synthetic.invalid/api/catalog/get" },
    { url: `${origin}/api/catalog/list` }, { url: `${origin}/api/catalog/get?alternate=1` },
    { url: `${origin}/api/catalog/get#fragment` }]) {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, value: view("svc-1") })));
      controller.close();
    }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const reply = new Response(stream, { headers: HEADERS });
    // Synthetic adapter metadata override, not a claim that native Fetch
    // follows redirects when the outgoing Request uses redirect: "error".
    for (const [name, value] of Object.entries(patch)) Object.defineProperty(reply, name, { value });
    const client = createCatalogClient({ origin, readViewContext, fetch: async () => reply });
    assert.deepEqual(await client(getRequest()), { kind: "invalid", reason: "HEADERS" });
    assert.equal(pulls, 0);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  }
});

test("empty fixture URL and exact captured request URL remain accepted after caller mutation", async () => {
  const origin = "https://synthetic.invalid";
  for (const url of ["", `${origin}/api/catalog/get`]) {
    const input = { action: "get", body: { serviceId: "svc-1" } };
    const client = createCatalogClient({ origin, readViewContext, fetch: async (request) => {
      assert.equal(request.url, `${origin}/api/catalog/get`);
      assert.equal(request.redirect, "error");
      input.action = "list";
      const reply = new Response(JSON.stringify({ ok: true, value: view("svc-1") }), { headers: HEADERS });
      Object.defineProperty(reply, "url", { value: url });
      return reply;
    } });
    assert.equal((await client(input as CatalogRequest)).kind, "success");
  }
});

test("arrived response is cancelled if its await continuation crosses the deadline", async (context) => {
  let now = 0;
  context.mock.method(performance, "now", () => now);
  let resolveTransport!: (response: Response) => void;
  const transport = new Promise<Response>((resolve) => { resolveTransport = resolve; });
  // Queue clock advancement AFTER the arrival handler but BEFORE wait resumes.
  void transport.then(() => queueMicrotask(() => { now = 101; }));
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const client = createCatalogClient({ origin: "https://synthetic.invalid", readViewContext, timeoutMs: 100, fetch: () => transport });
  const result = client(getRequest());
  resolveTransport(new Response(stream, { headers: HEADERS }));
  assert.deepEqual(await result, { kind: "timeout" });
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});
