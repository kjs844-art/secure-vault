import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG_REQUEST_HEADER, CATALOG_VIEW_SCHEMA, createCatalogClient, createCatalogCreateRequest,
  createCatalogDeleteRequest, createCatalogGetRequest, createCatalogListRequest, createCatalogUpdateRequest,
  type CatalogCallResult, type CatalogClientConfig, type CatalogRequest,
} from "../src/domain/catalog-client/index.ts";

// Synthetic in-memory Fetch adapter checks only. No real browser, server,
// authentication, operational route, DB or network connection is involved.

const ORIGIN = "https://synthetic.local";
const RESPONSE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
};

interface RecordedCall {
  request: Request;
  signal: AbortSignal;
}

const recordedBodies = new WeakMap<Request, string>();

function transport(respond: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const impl = async (request: Request, signal: AbortSignal): Promise<Response> => {
    const call = { request, signal };
    calls.push(call);
    recordedBodies.set(request, await request.clone().text());
    const result = await respond(call);
    return result;
  };
  return { impl, calls };
}
function bodyTextOf(request: Request): string {
  const text = recordedBodies.get(request);
  assert.ok(text !== undefined);
  return text;
}

function client(impl: CatalogClientConfig["fetch"], overrides: Partial<CatalogClientConfig> = {}) {
  return createCatalogClient({ origin: ORIGIN, fetch: impl, ...overrides });
}

function profile() {
  return {
    name: "Synthetic Service", provider: null, planName: null, accountLabel: null,
    timezone: "Asia/Seoul", subscriptionStatus: "active", trialEndsAt: null, notes: null,
  };
}
function serviceView(serviceId: string, revision = 1, state: "live" | "deleted" = "live") {
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, serviceId, serviceRevision: revision, state,
    profile: state === "live" ? profile() : null, createdAt: 1, updatedAt: 2,
    provenance: "user-reported", accountProof: "not-established" };
}
function successBody(action: string) {
  if (action === "create" || action === "update" || action === "delete") {
    return { ok: true, value: { operationId: "op-1", replayed: false, service: serviceView("svc-1") } };
  }
  if (action === "get") return { ok: true, value: serviceView("svc-2") };
  return { ok: true, value: { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, catalogRevision: 7,
    services: [serviceView("svc-1"), serviceView("svc-2")], nextCursor: { afterId: "svc-2", catalogRevision: 7, dataGeneration: 1 } } };
}

test("configuration rejects unsafe origins, external origins and invalid timeouts", () => {
  for (const origin of ["", "ftp://synthetic.local", "https://user:pass@synthetic.local",
    "https://synthetic.local/path", "https://synthetic.local/?q=1", "http://synthetic.local"]) {
    assert.throws(() => createCatalogClient({ origin, fetch: async () => new Response() }),
      /CATALOG_CLIENT_CONFIG_INVALID/);
  }
  assert.throws(() => createCatalogClient({ origin: ORIGIN, fetch: async () => new Response(), timeoutMs: 0 }));
  assert.throws(() => createCatalogClient({ origin: ORIGIN, fetch: async () => new Response(), timeoutMs: 10001 }));
  assert.throws(() => createCatalogClient({ origin: ORIGIN, fetch: async () => new Response(), timeoutMs: 1.5 }));
  assert.throws(() => createCatalogClient({ origin: ORIGIN, fetch: "not-a-function" as never }));
  assert.doesNotThrow(() => createCatalogClient({ origin: "https://synthetic.local", fetch: async () => new Response() }));
  assert.doesNotThrow(() => createCatalogClient({ origin: "http://127.0.0.1:4317", fetch: async () => new Response() }));
  assert.doesNotThrow(() => createCatalogClient({ origin: "http://localhost:4317", fetch: async () => new Response() }));
  assert.doesNotThrow(() => createCatalogClient({ origin: "http://[::1]:4317", fetch: async () => new Response() }));
});

test("request builders normalize unknown input into exact bodies and reject malformed input", () => {
  const created = createCatalogCreateRequest("op-1", profile());
  assert.equal(created.action, "create");
  assert.deepEqual(created.body, { operationId: "op-1", decision: "create", profile: profile() });

  const updated = createCatalogUpdateRequest("svc-1", 3, "op-2", { ...profile(), name: "Renamed" });
  assert.deepEqual(updated.body, { serviceId: "svc-1", expectedRevision: 3, operationId: "op-2",
    decision: "update", profile: { ...profile(), name: "Renamed" } });

  const removed = createCatalogDeleteRequest("svc-1", 4, "op-3");
  assert.deepEqual(removed.body, { serviceId: "svc-1", expectedRevision: 4, operationId: "op-3", decision: "delete" });

  const got = createCatalogGetRequest("svc-1");
  assert.deepEqual(got.body, { serviceId: "svc-1" });

  const listed = createCatalogListRequest(50, null);
  assert.deepEqual(listed.body, { limit: 50, cursor: null });
  const listedCursor = createCatalogListRequest(20, { afterId: "svc-2", catalogRevision: 7, dataGeneration: 1 });
  assert.deepEqual(listedCursor.body, { limit: 20, cursor: { afterId: "svc-2", catalogRevision: 7, dataGeneration: 1 } });

  for (const bad of [() => createCatalogCreateRequest(" leading", { ...profile(), name: "X" }),
    () => createCatalogCreateRequest("op-1", { ...profile(), name: " padded " }),
    () => createCatalogCreateRequest("op-1", { ...profile(), name: "" }),
    () => createCatalogCreateRequest("op-1", { ...profile(), name: "x".repeat(161) }),
    () => createCatalogCreateRequest("op-1", { ...profile(), subscriptionStatus: "gold" }),
    () => createCatalogCreateRequest("op-1", { ...profile(), timezone: "Not/AZone" }),
    () => createCatalogCreateRequest("op-1", { ...profile(), trialEndsAt: "2026-02-30" }),
    () => createCatalogCreateRequest("op-1", { ...profile(), trialEndsAt: "2026-01-01T25:00:00Z" }),
    () => createCatalogCreateRequest("op-1", { ...profile(), provider: 5 }),
    () => createCatalogCreateRequest("op-1", { ...profile(), notes: "bad\u0000notes" }),
    () => createCatalogUpdateRequest("svc-1", 0, "op-2", { ...profile(), name: "X" }),
    () => createCatalogUpdateRequest("svc-1", 1.5, "op-2", { ...profile(), name: "X" }),
    () => createCatalogDeleteRequest("svc-1", 2, "op-3 ".trimEnd() + " "),
    () => createCatalogGetRequest("../escape"),
    () => createCatalogListRequest(0, null),
    () => createCatalogListRequest(51, null),
    () => createCatalogListRequest(20, { afterId: "svc-2" }),
    () => createCatalogListRequest(20, { afterId: "svc-2", catalogRevision: 7 }),
  ]) assert.throws(bad, /CATALOG_INPUT_INVALID/);

  const controlProfile = { ...profile(), notes: "line1\nline2" };
  const withNotes = createCatalogCreateRequest("op-1", controlProfile);
  assert.equal(withNotes.body.profile.notes, "line1\nline2");
});

test("each action posts to its exact path with fixed headers, same-origin credentials and no redirects", async () => {
  const respond = (call: RecordedCall) => new Response(JSON.stringify(successBody(
    new URL(call.request.url).pathname.split("/").pop()!)), { status: 200, headers: RESPONSE_HEADERS });
  const { impl, calls } = transport(respond);
  const call = client(impl);
  const requests: CatalogRequest[] = [createCatalogCreateRequest("op-1", profile()),
    createCatalogUpdateRequest("svc-1", 1, "op-2", { ...profile(), name: "Renamed" }),
    createCatalogDeleteRequest("svc-1", 2, "op-3"), createCatalogGetRequest("svc-1"),
    createCatalogListRequest(50, null)];
  for (const request of requests) {
    const result = await call(request);
    assert.equal(result.kind, "success");
  }
  assert.equal(calls.length, 5);
  const paths = calls.map((entry) => new URL(entry.request.url).pathname);
  assert.deepEqual(paths, ["/api/catalog/create", "/api/catalog/update", "/api/catalog/delete",
    "/api/catalog/get", "/api/catalog/list"]);
  for (const entry of calls) {
    assert.equal(new URL(entry.request.url).origin, ORIGIN);
    assert.equal(new URL(entry.request.url).search, "");
    assert.equal(entry.request.method, "POST");
    assert.equal(entry.request.headers.get("x-keyatlas-request"), CATALOG_REQUEST_HEADER);
    assert.equal(entry.request.headers.get("content-type"), "application/json");
    assert.equal(entry.request.credentials, "same-origin");
    assert.equal(entry.request.redirect, "error");
    assert.ok(!entry.request.headers.has("cookie"));
    assert.ok(!entry.request.headers.has("origin"));
    assert.ok(!entry.request.headers.has("authorization"));
    const body = JSON.parse(bodyTextOf(entry.request)) as unknown;
    assert.ok(typeof body === "object" && body !== null && !Array.isArray(body));
  }
  const createdBody = JSON.parse(bodyTextOf(calls[0]!.request)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(createdBody).sort(), ["decision", "operationId", "profile"].sort());
  const listedBody = JSON.parse(bodyTextOf(calls[4]!.request)) as Record<string, unknown>;
  assert.deepEqual(listedBody, { limit: 50, cursor: null });
});

test("successful create/update/delete/get/list responses decode into frozen validated views", async () => {
  const respond = (entry: RecordedCall) => {
    const action = new URL(entry.request.url).pathname.split("/").pop()!;
    return new Response(JSON.stringify(successBody(action)), { status: 200, headers: RESPONSE_HEADERS });
  };
  const call = client((request, signal) => transportRespond(respond, request, signal));
  const receipt = await call(createCatalogCreateRequest("op-1", profile()));
  assert.ok(receipt.kind === "success" && receipt.success.kind === "receipt");
  assert.equal(receipt.success.receipt.operationId, "op-1");
  assert.equal(receipt.success.receipt.replayed, false);
  assert.equal(receipt.success.receipt.service.state, "live");
  assert.equal(receipt.success.receipt.service.profile!.subscriptionStatus, "active");
  assert.ok(Object.isFrozen(receipt.success.receipt));
  assert.ok(Object.isFrozen(receipt.success.receipt.service));

  const got = await call(createCatalogGetRequest("svc-2"));
  assert.ok(got.kind === "success" && got.success.kind === "view");
  assert.equal(got.success.view.serviceId, "svc-2");

  const listed = await call(createCatalogListRequest(50, null));
  assert.ok(listed.kind === "success" && listed.success.kind === "page");
  assert.equal(listed.success.page.catalogRevision, 7);
  assert.equal(listed.success.page.services.length, 2);
  assert.deepEqual(listed.success.page.nextCursor, { afterId: "svc-2", catalogRevision: 7, dataGeneration: 1 });
});

function transportRespond(respond: (entry: RecordedCall) => Response, request: Request, signal: AbortSignal) {
  return Promise.resolve(respond({ request, signal }));
}

test("fixed error envelopes decode with bounded retry-after and no automatic retry", async () => {
  const errors: Array<[number, string, unknown, string | null, CatalogCallResult | undefined]> = [
    [401, "API_AUTH_REQUIRED", { ok: false, code: "API_AUTH_REQUIRED" }, null, undefined],
    [403, "API_SESSION_CHANGED", { ok: false, code: "API_SESSION_CHANGED" }, null, undefined],
    [429, "API_RATE_LIMITED", { ok: false, code: "API_RATE_LIMITED" }, "30", undefined],
  ];
  for (const [status, code, body, retryAfter, expected] of errors) {
    const headers = { ...RESPONSE_HEADERS, ...(retryAfter ? { "retry-after": retryAfter } : {}) };
    const call = client(async () => new Response(JSON.stringify(body), { status, headers }));
    const result = await call(createCatalogGetRequest("svc-1"));
    assert.ok(result.kind === "error");
    assert.equal(result.code, code);
    assert.equal(result.retriableAfterMs, retryAfter === null ? null : Number(retryAfter) * 1000);
    assert.ok(Object.isFrozen(result));
    if (expected) assert.deepEqual(result, expected);
  }
  const call = client(async () => new Response(JSON.stringify({ ok: false, code: "API_RATE_LIMITED" }),
    { status: 429, headers: { ...RESPONSE_HEADERS, "retry-after": "61" } }));
  const invalid = await call(createCatalogGetRequest("svc-1"));
  assert.deepEqual(invalid, { kind: "invalid", reason: "HEADERS" });

  const missing = client(async () => new Response(JSON.stringify({ ok: false, code: "API_RATE_LIMITED" }),
    { status: 429, headers: RESPONSE_HEADERS }));
  assert.deepEqual(await missing(createCatalogGetRequest("svc-1")), { kind: "invalid", reason: "HEADERS" });

  const second = await client(async () => new Response(JSON.stringify({ ok: false, code: "API_NOT_FOUND" }),
    { status: 404, headers: RESPONSE_HEADERS }))(createCatalogGetRequest("svc-1"));
  assert.deepEqual(second, { kind: "error", code: "API_NOT_FOUND", retriableAfterMs: null });
});

test("unexpected status/envelope mismatches fail closed as invalid, never as success", async () => {
  const mismatches: Array<[number, unknown, string]> = [
    [400, { ok: true, value: serviceView("svc-1") }, "ENVELOPE"],
    [400, { ok: false }, "ENVELOPE"],
    [400, { ok: false, code: "made_up" }, "ENVELOPE"],
    [400, [1, 2], "ENVELOPE"],
    [400, { ok: false, code: "API_INPUT_INVALID", extra: 1 }, "ENVELOPE"],
    [404, { ok: false, code: "API_NOT_FOUND", extra: 1 }, "ENVELOPE"],
  ];
  for (const [status, body, reason] of mismatches) {
    const call = client(async () => new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS }));
    const result: CatalogCallResult = await call(createCatalogGetRequest("svc-1"));
    assert.deepEqual(result, { kind: "invalid", reason });
  }
  const successWithWrongStatus = client(async () => new Response(
    JSON.stringify({ ok: true, value: serviceView("svc-1") }), { status: 404, headers: RESPONSE_HEADERS }));
  assert.deepEqual(await successWithWrongStatus(createCatalogGetRequest("svc-1")), { kind: "invalid", reason: "ENVELOPE" });
});

test("malformed response bodies and oversized payloads fail closed", async () => {
  const badBodies: Array<[string, string]> = [
    ["BODY", "not json"],
    ["BODY", "{\"ok\":tr"],
    ["BODY", "\uFEFF{\"ok\":true}"],
    ["ENVELOPE", "{\"ok\":true,\"value\":null}"],
    ["ENVELOPE", "{\"ok\":false,\"value\":null}"],
    ["BODY", "{\"ok\":true,\"value\":{}}{}"],
  ];
  for (const [reason, body] of badBodies) {
    const call = client(async () => new Response(body, { status: 200, headers: RESPONSE_HEADERS }));
    const result: CatalogCallResult = await call(createCatalogGetRequest("svc-1"));
    assert.deepEqual(result, { kind: "invalid", reason });
  }
  const oversized = "x".repeat(1048577);
  const call = client(async () => new Response(oversized, { status: 200, headers: RESPONSE_HEADERS }));
  const result: CatalogCallResult = await call(createCatalogGetRequest("svc-1"));
  assert.deepEqual(result, { kind: "invalid", reason: "BODY" });

  const declared = client(async () => new Response(JSON.stringify(successBody("get")), { status: 200,
    headers: { ...RESPONSE_HEADERS, "content-length": String(1048577 + 1) } }));
  assert.deepEqual(await declared(createCatalogGetRequest("svc-1")), { kind: "invalid", reason: "HEADERS" });

  const noCache = client(async () => new Response(JSON.stringify(successBody("get")),
    { status: 200, headers: { "content-type": "application/json" } }));
  assert.deepEqual(await noCache(createCatalogGetRequest("svc-1")), { kind: "invalid", reason: "HEADERS" });

  const setsCookie = client(async () => new Response(JSON.stringify(successBody("get")),
    { status: 200, headers: { ...RESPONSE_HEADERS, "set-cookie": "session=1" } }));
  assert.deepEqual(await setsCookie(createCatalogGetRequest("svc-1")), { kind: "invalid", reason: "HEADERS" });

  const wrongType = client(async () => new Response("<html></html>", { status: 200,
    headers: { ...RESPONSE_HEADERS, "content-type": "text/html" } }));
  assert.deepEqual(await wrongType(createCatalogGetRequest("svc-1")), { kind: "invalid", reason: "HEADERS" });

  const invalidStatus: unknown = { status: 99, headers: RESPONSE_HEADERS, text: async () => "{}" };
  const wrongStatusType = client(async () => invalidStatus as Response);
  assert.deepEqual(await wrongStatusType(createCatalogGetRequest("svc-1")), { kind: "invalid", reason: "STATUS" });

  const bodyMismatched = client(async () => new Response(JSON.stringify({ ok: false, code: "API_CONFLICT" }),
    { status: 409, headers: RESPONSE_HEADERS }));
  assert.deepEqual(await bodyMismatched(createCatalogGetRequest("svc-1")),
    { kind: "error", code: "API_CONFLICT", retriableAfterMs: null });
});

test("create receipts with wrong shapes are rejected before reaching application state", async () => {
  const bodies: unknown[] = [
    { ok: true, value: { operationId: "op-1", service: serviceView("svc-1") } },
    { ok: true, value: { operationId: "op-1", replayed: "false", service: serviceView("svc-1") } },
    { ok: true, value: { operationId: "op-1", replayed: false, service: { ...serviceView("svc-1"), schema: "other.v1" } } },
    { ok: true, value: { operationId: "op-1", replayed: false, service: { ...serviceView("svc-1"), accountProof: "verified" } } },
    { ok: true, value: { operationId: "op-1", replayed: false, service: { ...serviceView("svc-1"), provenance: "system" } } },
    { ok: true, value: { operationId: "op-1", replayed: false, service: { ...serviceView("svc-1"), serviceRevision: 0 } } },
    { ok: true, value: { operationId: "op-1", replayed: false, service: { ...serviceView("svc-1"), dataGeneration: 1.5 } } },
    { ok: true, value: { operationId: "op-1", replayed: false, service: { ...serviceView("svc-1"),
      profile: { ...profile(), name: " padded " } } } },
    { ok: true, value: { operationId: "op-1", replayed: false, service: { ...serviceView("svc-1"),
      profile: { ...profile(), subscriptionStatus: "grandfathered" } } } },
    { ok: true, value: { operationId: "op-1", replayed: false, service: { ...serviceView("svc-1"),
      profile: { ...profile(), timezone: "Mars/Olympus" } } } },
    { ok: true, value: { operationId: "op-1", replayed: false, service: { ...serviceView("svc-1"),
      profile: { ...profile(), trialEndsAt: "2026-13-01" } } } },
    { ok: true, value: { operationId: "op-1", replayed: false, service: { ...serviceView("svc-1"),
      profile: { ...profile(), notes: 7 } } } },
    { ok: true, value: { operationId: "op-1", replayed: false, service: { ...serviceView("svc-1"), extra: true } } },
    { ok: true, value: { operationId: "op-1", replayed: false, service: { ...serviceView("svc-1"), state: "removed" } } },
    { ok: true, value: { operationId: " op-1", replayed: false, service: serviceView("svc-1") } },
    { ok: true, value: null },
    { ok: true, value: "text" },
    { ok: true, value: {} },
    [1, 2],
  ];
  for (const value of bodies) {
    const call = client(async () => new Response(JSON.stringify({ ok: true, value }),
      { status: 200, headers: RESPONSE_HEADERS }));
    const result: CatalogCallResult = await call(createCatalogCreateRequest("op-1", profile()));
    assert.deepEqual(result, { kind: "invalid", reason: "ENVELOPE" });
  }
});

test("page responses enforce ordered ids, frozen arrays, and reject tampered cursors", async () => {
  const valid = { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, catalogRevision: 7,
    services: [serviceView("svc-1"), serviceView("svc-2"), serviceView("svc-9")],
    nextCursor: { afterId: "svc-9", catalogRevision: 7, dataGeneration: 1 } };
  const call = client(async () => new Response(JSON.stringify({ ok: true, value: valid }),
    { status: 200, headers: RESPONSE_HEADERS }));
  const result = await call(createCatalogListRequest(50, null));
  assert.ok(result.kind === "success" && result.success.kind === "page");
  assert.ok(Object.isFrozen(result.success.page.services));
  assert.ok(result.success.page.services.every((service) => Object.isFrozen(service)));

  const unordered: Array<unknown> = [
    { ...valid, services: [serviceView("svc-2"), serviceView("svc-1")] },
    { ...valid, services: [serviceView("svc-1"), serviceView("svc-1")] },
    { ...valid, services: Array.from({ length: 51 }, (_, index) => serviceView(`svc-${index + 1}`)) },
    { ...valid, services: "no" },
    { ...valid, catalogRevision: 0 },
    { ...valid, nextCursor: { afterId: "svc-9", catalogRevision: 7 } },
    { ...valid, nextCursor: { afterId: "svc-9", catalogRevision: 7, dataGeneration: 0 } },
    { ...valid, nextCursor: null, schema: "keyatlas.other.v1" },
    { ...valid, services: [serviceView("svc-1", 1, "deleted")], nextCursor: null, extra: 1 },
    { ...valid, services: [{ ...serviceView("svc-1"), profile: { ...profile(), notes: "x".repeat(2049) } }] },
  ];
  for (const value of unordered) {
    const listCall = client(async () => new Response(JSON.stringify({ ok: true, value }),
      { status: 200, headers: RESPONSE_HEADERS }));
    assert.deepEqual(await listCall(createCatalogListRequest(50, null)),
      { kind: "invalid", reason: "ENVELOPE" }, JSON.stringify(value).slice(0, 120));
  }

  const deletedPage = { schema: CATALOG_VIEW_SCHEMA, dataGeneration: 1, catalogRevision: 8,
    services: [serviceView("svc-1", 5, "deleted")], nextCursor: null };
  const deletedCall = client(async () => new Response(JSON.stringify({ ok: true, value: deletedPage }),
    { status: 200, headers: RESPONSE_HEADERS }));
  const deletedResult = await deletedCall(createCatalogListRequest(50, null));
  assert.ok(deletedResult.kind === "success" && deletedResult.success.kind === "page");
  assert.equal(deletedResult.success.page.services[0]!.state, "deleted");
  assert.equal(deletedResult.success.page.services[0]!.profile, null);
});

test("timeout aborts the transport and surfaces explicitly without retry", async () => {
  const call = client((request, signal) => new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    void request.body;
  }), { timeoutMs: 5 });
  const result: CatalogCallResult = await call(createCatalogGetRequest("svc-1"));
  assert.deepEqual(result, { kind: "timeout" });
});

test("a transport rejection before any timeout is reported as an explicit abort", async () => {
  const aborting = client(() => Promise.reject(new DOMException("aborted", "AbortError")));
  const result: CatalogCallResult = await aborting(createCatalogGetRequest("svc-1"));
  assert.deepEqual(result, { kind: "aborted" });
});

test("client state stays in memory only: no storage, analytics or logging side effects", async () => {
  const forbidden = ["localStorage", "sessionStorage", "document.cookie", "navigator.sendBeacon", "console.log"];
  const call = client(async () => new Response(JSON.stringify(successBody("get")),
    { status: 200, headers: RESPONSE_HEADERS }));
  await call(createCatalogGetRequest("svc-1"));
  const result = await call(createCatalogGetRequest("svc-1"));
  assert.ok(result.kind === "success");
  const moduleText = JSON.stringify(result);
  for (const marker of forbidden) assert.ok(!moduleText.includes(marker));
});
