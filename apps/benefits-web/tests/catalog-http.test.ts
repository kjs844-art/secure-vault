import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createCatalogHttpHandler } from "../src/server/http/catalog-http.ts";
import type { CatalogAdmissionRequest, CatalogHttpDependencies, CatalogHttpError,
  CatalogSessionContext } from "../src/server/http/catalog-http-contracts.ts";
import type { CatalogPage, CatalogReceipt, CatalogView, ServiceProfile } from "../src/server/catalog/contracts.ts";
import { REVIEW_NOW, REVIEW_OWNER, SYNTHETIC_PRIVATE, createReviewMemoryStore,
  reviewAuthority } from "./support/review-memory-store.ts";

// Fetch objects plus a serialized synthetic memory adapter only: no server,
// network, credentials, real limiter, database, or durable-commit evidence.
const ORIGIN = "https://catalog.example.test";
const COOKIE = "synthetic-session=fixture";
const profile = (patch: Partial<ServiceProfile> = {}): ServiceProfile => ({
  name: "Synthetic HTTP Studio", provider: null, planName: null, accountLabel: null,
  timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null, ...patch,
});
const createInput = (operationId = "synthetic-http-create", value = profile()) => ({ operationId, decision: "create", profile: value });
const updateInput = (view: CatalogView, operationId = "synthetic-http-update") => ({
  serviceId: view.serviceId, expectedRevision: view.serviceRevision, operationId, decision: "update",
  profile: profile({ name: "Synthetic HTTP renamed", timezone: "Asia/Seoul", notes: "합성\n메모" }),
});
const deleteInput = (view: CatalogView, operationId = "synthetic-http-delete") => ({
  serviceId: view.serviceId, expectedRevision: view.serviceRevision, operationId, decision: "delete",
});
const grant = (request: CatalogAdmissionRequest) => Object.freeze({ allowed: true, requestId: request.requestId,
  action: request.action, authority: request.authority, expiresAt: request.notAfter });

function fixture(overrides: Partial<CatalogHttpDependencies> = {}) {
  const store = createReviewMemoryStore();
  store.rows.services.clear();
  const sessions: Array<{ context: CatalogSessionContext; signal: AbortSignal }> = [];
  const admissions: Array<{ request: CatalogAdmissionRequest; signal: AbortSignal }> = [];
  const deps: CatalogHttpDependencies = {
    trustedOrigin: overrides.trustedOrigin ?? ORIGIN,
    ...(overrides.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: overrides.requestTimeoutMs }),
    now: () => overrides.now ? overrides.now() : store.controls.now,
    newId: () => overrides.newId ? overrides.newId() : store.catalogDependencies.newId(),
    readSession: async (context, signal) => {
      sessions.push({ context, signal });
      return overrides.readSession ? overrides.readSession(context, signal) : structuredClone(store.controls.authority);
    },
    admit: async (request, signal) => {
      admissions.push({ request, signal });
      return overrides.admit ? overrides.admit(request, signal) : grant(request);
    },
    transaction: (authority, task) => (overrides.transaction ?? store.catalogDependencies.transaction)(authority, task),
  };
  return { store, controls: store.controls, deps, overrides, sessions, admissions, handler: createCatalogHttpHandler(deps) };
}
type Fixture = ReturnType<typeof fixture>;
type RequestOptions = { url?: string; method?: string; headers?: Record<string, string | null>;
  raw?: BodyInit | null; signal?: AbortSignal };
function request(action = "create", command: unknown = createInput(), options: RequestOptions = {}) {
  const headers = new Headers({ "content-type": "application/json", origin: ORIGIN,
    "x-keyatlas-request": "catalog-v1", "sec-fetch-site": "same-origin", cookie: COOKIE });
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(key); else headers.set(key, value);
  }
  const method = options.method ?? "POST";
  const init: RequestInit & { duplex?: "half" } = { method, headers, ...(options.signal ? { signal: options.signal } : {}) };
  if (method !== "GET" && method !== "HEAD") {
    init.body = "raw" in options ? options.raw : JSON.stringify(command);
    if (init.body instanceof ReadableStream) init.duplex = "half";
  }
  const result = new Request(options.url ?? `${ORIGIN}/api/catalog/${action}`, init);
  // Fetch fills a string body's content type, so explicitly exercise absent headers.
  for (const [key, value] of Object.entries(options.headers ?? {})) if (value === null) result.headers.delete(key);
  return result;
}
async function body(response: Response) {
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  for (const name of ["set-cookie", "access-control-allow-origin", "access-control-allow-credentials", "authorization", "cookie"]) {
    assert.equal(response.headers.get(name), null);
  }
  const text = await response.text();
  for (const privateText of [COOKIE, SYNTHETIC_PRIVATE]) assert.ok(!text.includes(privateText));
  return JSON.parse(text) as Record<string, unknown>;
}
async function success<T>(response: Response): Promise<T> {
  const value = await body(response);
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.deepEqual(Object.keys(value).sort(), ["ok", "value"]);
  assert.equal(value.ok, true);
  return value.value as T;
}
async function failure(response: Response, code: CatalogHttpError, status: number) {
  assert.deepEqual(await body(response), { ok: false, code });
  assert.equal(response.status, status);
  if (status !== 405) assert.equal(response.headers.get("allow"), null);
  if (status !== 429) assert.equal(response.headers.get("retry-after"), null);
}
async function created(f: Fixture, operationId = "synthetic-http-create") {
  return success<CatalogReceipt>(await f.handler(request("create", createInput(operationId))));
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function noWrites(f: Fixture) {
  assert.equal(f.store.rows.services.size, 0);
  assert.equal(f.store.rows.catalogOperations.size, 0);
  assert.equal(f.controls.commits, 0);
}

test("HTTP create/get/update/list/delete composes the actual catalog and current-row retries", async () => {
  const f = fixture();
  const first = await created(f);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.service.profile, profile());
  assert.equal(first.service.provenance, "user-reported");
  assert.equal(first.service.accountProof, "not-established");
  const get = await success<CatalogView>(await f.handler(request("get", { serviceId: first.service.serviceId })));
  assert.deepEqual(get, first.service);
  const input = updateInput(first.service);
  const updated = await success<CatalogReceipt>(await f.handler(request("update", input)));
  assert.equal(updated.service.serviceRevision, 2);
  assert.deepEqual(updated.service.profile, input.profile);
  const retry = await created(f);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.service, updated.service);
  const page = await success<CatalogPage>(await f.handler(request("list", { limit: 50, cursor: null })));
  assert.deepEqual(page.services, [updated.service]);
  assert.equal(page.nextCursor, null);
  const remove = deleteInput(updated.service);
  const deleted = await success<CatalogReceipt>(await f.handler(request("delete", remove)));
  assert.equal(deleted.service.state, "deleted");
  assert.equal(deleted.service.profile, null);
  assert.equal(deleted.service.serviceRevision, 3);
  assert.equal((await success<CatalogReceipt>(await f.handler(request("delete", remove)))).replayed, true);
  assert.deepEqual((await created(f)).service, deleted.service);
  assert.equal((await success<CatalogPage>(await f.handler(request("list", { limit: 50, cursor: null })))).services.length, 0);
  assert.equal(f.store.rows.services.size, 1);
  assert.equal(f.store.rows.catalogOperations.size, 3);
  assert.equal(f.admissions.length, 9, "every HTTP retry is independently admitted");
});

test("same operation different body/kind and stale revision are safe conflict responses", async () => {
  const f = fixture();
  const first = await created(f);
  await failure(await f.handler(request("create", createInput("synthetic-http-create", profile({ name: "Different" })))), "API_CONFLICT", 409);
  await failure(await f.handler(request("delete", deleteInput(first.service, "synthetic-http-create"))), "API_CONFLICT", 409);
  await success(await f.handler(request("update", updateInput(first.service))));
  await failure(await f.handler(request("update", updateInput(first.service, "synthetic-stale"))), "API_CONFLICT", 409);
  assert.equal(f.store.rows.services.size, 1);
  assert.equal(f.store.rows.catalogOperations.size, 2);
});

test("pagination uses POST body and invalidates a cursor after a catalog change", async () => {
  const f = fixture();
  await created(f, "synthetic-first");
  await created(f, "synthetic-second");
  const page = await success<CatalogPage>(await f.handler(request("list", { limit: 1, cursor: null })));
  assert.equal(page.services.length, 1);
  assert.ok(page.nextCursor);
  const second = await success<CatalogPage>(await f.handler(request("list", { limit: 1, cursor: page.nextCursor })));
  assert.equal(second.services.length, 1);
  assert.notEqual(second.services[0]!.serviceId, page.services[0]!.serviceId);
  await created(f, "synthetic-third");
  await failure(await f.handler(request("list", { limit: 1, cursor: page.nextCursor })), "API_CONFLICT", 409);
});

for (const patch of [{ ownerId: "synthetic-other-owner" }, { dataGeneration: 2 }]) {
  test(`server-selected scope hides prior service: ${Object.keys(patch)[0]}`, async () => {
    const f = fixture();
    const first = await created(f);
    f.controls.authority = reviewAuthority(patch);
    await failure(await f.handler(request("get", { serviceId: first.service.serviceId })), "API_NOT_FOUND", 404);
    await failure(await f.handler(request("delete", deleteInput(first.service))), "API_NOT_FOUND", 404);
    assert.equal((await success<CatalogPage>(await f.handler(request("list", { limit: 50, cursor: null })))).services.length, 0);
    assert.equal(f.store.rows.services.size, 1);
  });
}

test("parallel exact operation retries persist one service and both requests pass admission", async () => {
  const f = fixture();
  const values = await Promise.all([created(f), created(f)]);
  assert.deepEqual(values.map((value) => value.replayed).sort(), [false, true]);
  assert.equal(values[0].service.serviceId, values[1].service.serviceId);
  assert.equal(f.store.rows.services.size, 1);
  assert.equal(f.store.rows.catalogOperations.size, 1);
  assert.equal(f.admissions.length, 2);
});

for (const origin of ["https://catalog.example.test/", "https://catalog.example.test/path", "https://catalog.example.test?x=1",
  "https://catalog.example.test#x", "https://CATALOG.example.test", "https://catalog.example.test:443", "https://user@catalog.example.test",
  "http://catalog.example.test", "http://localhost.example.test", "ftp://localhost", "not-a-url"]) {
  test(`factory rejects noncanonical or untrusted origin ${origin}`, () => {
    const f = fixture();
    assert.throws(() => createCatalogHttpHandler({ ...f.deps, trustedOrigin: origin }), { message: "API_CONFIGURATION_INVALID" });
  });
}
for (const origin of [ORIGIN, "http://localhost:4317", "http://127.0.0.1:4317", "http://[::1]:4317"]) {
  test(`configured canonical origin is accepted ${origin}`, async () => {
    const f = fixture({ trustedOrigin: origin });
    await success(await f.handler(request("list", { limit: 1, cursor: null }, { url: `${origin}/api/catalog/list`, headers: { origin } })));
  });
}
for (const timeout of [null, 0, -1, 0.5, 10001, NaN, Infinity, "10"]) {
  test(`factory rejects invalid timeout ${String(timeout)}`, () => {
    const f = fixture();
    assert.throws(() => createCatalogHttpHandler({ ...f.deps, requestTimeoutMs: timeout as number }), { message: "API_CONFIGURATION_INVALID" });
  });
}
for (const key of ["readSession", "admit", "transaction", "now", "newId"] as const) {
  test(`factory rejects missing trusted dependency ${key}`, () => {
    const f = fixture();
    assert.throws(() => createCatalogHttpHandler({ ...f.deps, [key]: null } as unknown as CatalogHttpDependencies), { message: "API_CONFIGURATION_INVALID" });
  });
}

for (const action of ["", "create/", "CREATE", "remove", "create/extra", "%63reate", "../other"]) {
  test(`unknown route ${JSON.stringify(action)} cannot call adapters`, async () => {
    const f = fixture();
    await failure(await f.handler(request(action)), "API_NOT_FOUND", 404);
    assert.equal(f.sessions.length, 0);
    assert.equal(f.admissions.length, 0);
    noWrites(f);
  });
}
for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
  test(`method ${method} cannot dispatch POST-only catalog reads or writes`, async () => {
    const f = fixture();
    const response = await f.handler(request("list", { limit: 1, cursor: null }, { method }));
    await failure(response, "API_METHOD_NOT_ALLOWED", 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal(f.sessions.length, 0);
    noWrites(f);
  });
}
const rejectedHeaders: Array<[string, Record<string, string | null>]> = [
  ["no Origin", { origin: null }], ["foreign Origin", { origin: "https://other.example.test" }],
  ["opaque Origin", { origin: "null" }], ["Origin slash", { origin: `${ORIGIN}/` }],
  ["no marker", { "x-keyatlas-request": null }], ["bad marker", { "x-keyatlas-request": "catalog-v2" }],
  ["cross-site", { "sec-fetch-site": "cross-site" }], ["same-site", { "sec-fetch-site": "same-site" }],
  ["fetch none", { "sec-fetch-site": "none" }], ["bearer header", { authorization: "synthetic-not-a-real-token" }],
  ["empty authorization", { authorization: "" }], ["overlong cookie", { cookie: "x".repeat(4097) }],
  ["non-ASCII cookie", { cookie: "synthetic=é" }],
];
for (const [name, headers] of rejectedHeaders) {
  test(`request boundary rejects ${name} before session/admission`, async () => {
    const f = fixture();
    await failure(await f.handler(request("create", createInput(), { headers })), "API_REQUEST_REJECTED", 403);
    assert.equal(f.sessions.length, 0);
    assert.equal(f.admissions.length, 0);
    noWrites(f);
  });
}
for (const suffix of ["?privateId=synthetic", "#fragment"]) {
  test(`request URL refuses ${suffix}`, async () => {
    const f = fixture();
    await failure(await f.handler(request("create", createInput(), { url: `${ORIGIN}/api/catalog/create${suffix}` })), "API_REQUEST_REJECTED", 403);
    assert.equal(f.sessions.length, 0);
  });
}
test("untrusted request origin and forwarded headers cannot replace configured origin", async () => {
  const f = fixture();
  await failure(await f.handler(request("create", createInput(), { url: "https://other.example.test/api/catalog/create",
    headers: { host: "catalog.example.test", "x-forwarded-host": "catalog.example.test", "x-forwarded-proto": "https" } })), "API_REQUEST_REJECTED", 403);
  assert.equal(f.sessions.length, 0);
});
for (const cookie of [null, "", "   "]) {
  test(`absent or empty cookie ${JSON.stringify(cookie)} never invokes an ambient-session adapter`, async () => {
    const f = fixture();
    await failure(await f.handler(request("create", createInput(), { headers: { cookie } })), "API_AUTH_REQUIRED", 401);
    assert.equal(f.sessions.length, 0);
    noWrites(f);
  });
}
test("bounded ASCII cookie is private and contexts/authority are frozen with one forwarded signal", async () => {
  const f = fixture();
  await success(await f.handler(request("list", { limit: 1, cursor: null }, { headers: { cookie: "x".repeat(4096), "sec-fetch-site": null } })));
  assert.ok(f.sessions.length > 3);
  const first = f.sessions[0];
  const admitted = f.admissions[0];
  assert.ok(first);
  assert.ok(admitted);
  assert.equal(first.context.cookie, "x".repeat(4096));
  assert.deepEqual(Object.keys(first.context), ["cookie"]);
  assert.ok(Object.isFrozen(first.context));
  for (const session of f.sessions) {
    assert.equal(session.context, first.context);
    assert.equal(session.signal, first.signal);
  }
  assert.equal(admitted.signal, first.signal);
  assert.ok(Object.isFrozen(admitted.request));
  assert.ok(Object.isFrozen(admitted.request.authority));
  assert.deepEqual(Object.keys(admitted.request).sort(), ["action", "authority", "notAfter", "requestId"]);
  assert.ok(first.signal.aborted, "finished request releases pending cooperative adapters");
});

for (const initial of [null, {}, reviewAuthority({ expiresAt: REVIEW_NOW }), reviewAuthority({ sessionRevision: 0 }),
  reviewAuthority({ dataGeneration: 0 })]) {
  test(`invalid initial server session ${JSON.stringify(initial)} is unauthorized before admission`, async () => {
    const f = fixture({ readSession: async () => initial });
    await failure(await f.handler(request()), "API_AUTH_REQUIRED", 401);
    assert.equal(f.admissions.length, 0);
    noWrites(f);
  });
}

type BadPermit = (request: CatalogAdmissionRequest) => unknown;
const badPermits: Array<[string, BadPermit]> = [
  ["null", () => null], ["absent", () => undefined], ["empty", () => ({})],
  ["truthy allowed", (r) => ({ ...grant(r), allowed: 1 })], ["missing request ID", (r) => { const { requestId: _, ...rest } = grant(r); return rest; }],
  ["extra key", (r) => ({ ...grant(r), note: SYNTHETIC_PRIVATE })],
  ["wrong request ID", (r) => ({ ...grant(r), requestId: "synthetic-other-request" })],
  ["wrong action", (r) => ({ ...grant(r), action: "delete" })],
  ["expired permit", (r) => ({ ...grant(r), expiresAt: REVIEW_NOW })],
  ["long permit", (r) => ({ ...grant(r), expiresAt: r.notAfter + 1 })],
  ["fractional expiry", (r) => ({ ...grant(r), expiresAt: REVIEW_NOW + 0.5 })],
  ["NaN expiry", (r) => ({ ...grant(r), expiresAt: NaN })],
  ["string expiry", (r) => ({ ...grant(r), expiresAt: String(r.notAfter) })],
  ["authority extra", (r) => ({ ...grant(r), authority: { ...r.authority, privateDetail: SYNTHETIC_PRIVATE } })],
  ["getter", (r) => Object.defineProperty({ ...grant(r) }, "action", { get() { throw new Error(SYNTHETIC_PRIVATE); } })],
];
for (const [key, value] of Object.entries({ ownerId: "synthetic-other", sessionId: "synthetic-other", sessionRevision: 2,
  dataGeneration: 2, expiresAt: REVIEW_NOW + 599999 })) {
  badPermits.push([`wrong authority ${key}`, (r) => ({ ...grant(r), authority: { ...r.authority, [key]: value } })]);
}
for (const [name, permit] of badPermits) {
  test(`malformed or mismatched admission ${name} cannot dispatch`, async () => {
    const f = fixture({ admit: async (input) => permit(input) });
    await failure(await f.handler(request()), "API_UNAVAILABLE", 503);
    assert.equal(f.controls.transactions, 0);
    noWrites(f);
  });
}
for (const retryAfterSeconds of [1, 60]) {
  test(`exact denied permit returns bounded Retry-After ${retryAfterSeconds}`, async () => {
    const f = fixture({ admit: async () => ({ allowed: false, retryAfterSeconds }) });
    const response = await f.handler(request());
    await failure(response, "API_RATE_LIMITED", 429);
    assert.equal(response.headers.get("retry-after"), String(retryAfterSeconds));
    assert.equal(f.controls.transactions, 0);
    noWrites(f);
  });
}
for (const denied of [{ allowed: false }, { allowed: false, retryAfterSeconds: 0 }, { allowed: false, retryAfterSeconds: 61 },
  { allowed: false, retryAfterSeconds: 1.5 }, { allowed: false, retryAfterSeconds: "1" },
  { allowed: false, retryAfterSeconds: 1, extra: SYNTHETIC_PRIVATE }]) {
  test(`malformed admission denial fails closed ${JSON.stringify(denied)}`, async () => {
    const f = fixture({ admit: async () => denied });
    await failure(await f.handler(request()), "API_UNAVAILABLE", 503);
    noWrites(f);
  });
}
for (const stage of ["readSession", "admit", "transaction"] as const) {
  test(`generic ${stage} adapter failure is redacted without retry/fallback`, async () => {
    const f = fixture();
    let calls = 0;
    const fail = async () => { calls++; throw new Error(SYNTHETIC_PRIVATE); };
    f.overrides[stage] = fail;
    await failure(await f.handler(request()), "API_UNAVAILABLE", 503);
    assert.equal(calls, 1);
    noWrites(f);
  });
}

const malformedBodies: Array<[string, RequestOptions, CatalogHttpError, number]> = [
  ["absent media type", { headers: { "content-type": null } }, "API_MEDIA_TYPE", 415],
  ["text media type", { headers: { "content-type": "text/plain" } }, "API_MEDIA_TYPE", 415],
  ["gzip", { headers: { "content-encoding": "gzip" } }, "API_MEDIA_TYPE", 415],
  ["absent body", { raw: null }, "API_INPUT_INVALID", 400],
  ["bad JSON", { raw: "{invalid" }, "API_INPUT_INVALID", 400],
  ["array", { raw: "[]" }, "API_INPUT_INVALID", 400],
  ["duplicate property", { raw: '{"operationId":"a","operationId":"b"}' }, "API_INPUT_INVALID", 400],
  ["excess bytes", { raw: JSON.stringify({ padding: "x".repeat(16384) }) }, "API_BODY_TOO_LARGE", 413],
  ["declared excess", { headers: { "content-length": "16385" } }, "API_BODY_TOO_LARGE", 413],
  ["length mismatch", { headers: { "content-length": "1" } }, "API_INPUT_INVALID", 400],
  ["malformed declared length", { headers: { "content-length": "-1" } }, "API_INPUT_INVALID", 400],
];
for (const [name, options, code, status] of malformedBodies) {
  test(`body boundary rejects ${name} before a transaction`, async () => {
    const f = fixture();
    await failure(await f.handler(request("create", createInput(), options)), code, status);
    assert.equal(f.admissions.length, 1);
    assert.equal(f.controls.transactions, 0);
    noWrites(f);
  });
}
for (const [action, command] of [
  ["list", {}], ["list", { cursor: null }], ["list", { limit: 0, cursor: null }],
  ["list", { limit: 51, cursor: null }], ["get", { serviceId: "synthetic-missing", ownerId: REVIEW_OWNER }],
  ["create", { ...createInput(), authority: reviewAuthority() }],
  ["create", { ...createInput(), profile: { ...profile(), unknown: true } }],
] as const) {
  test(`command contract rejects extras or missing/bad bounds: ${action} ${JSON.stringify(command)}`, async () => {
    const f = fixture();
    await failure(await f.handler(request(action, command)), "API_INPUT_INVALID", 400);
    noWrites(f);
  });
}

for (const patch of [{ ownerId: "synthetic-other-owner" }, { sessionId: "synthetic-other-session" }, { sessionRevision: 2 },
  { dataGeneration: 2 }, { expiresAt: REVIEW_NOW + 599999 }]) {
  test(`admission cannot rebind the captured session ${Object.keys(patch)[0]}`, async () => {
    const f = fixture();
    f.overrides.admit = async (input) => {
      f.controls.authority = reviewAuthority(patch);
      return grant(input);
    };
    await failure(await f.handler(request()), "API_SESSION_CHANGED", 403);
    assert.equal(f.controls.transactions, 0);
    assert.equal(f.admissions[0]!.request.authority.ownerId, REVIEW_OWNER);
    noWrites(f);
  });
}
test("every session reread rejects a persistent A-to-B transition, including final response checks", async (t) => {
  const baseline = fixture();
  await created(baseline);
  const reads = baseline.sessions.length;
  assert.ok(reads >= 6);
  for (let changedAt = 2; changedAt <= reads; changedAt++) {
    await t.test(`session reread ${changedAt}/${reads}`, async () => {
      const f = fixture();
      f.overrides.readSession = async () => {
        if (f.sessions.length === changedAt) f.controls.authority = reviewAuthority({ ownerId: "synthetic-owner-B", sessionId: "synthetic-session-B" });
        return structuredClone(f.controls.authority);
      };
      await failure(await f.handler(request()), "API_SESSION_CHANGED", 403);
      for (const row of f.store.rows.services.values()) assert.equal(row.ownerId, REVIEW_OWNER, "never insert as B");
      assert.ok(f.store.rows.services.size <= 1);
      if (f.controls.commits === 1) {
        assert.equal(f.store.rows.catalogOperations.size, 1);
        assert.equal(f.controls.rollbacks, 0, "a suppressed post-commit response is not rollback");
      }
    });
  }
});
for (const hook of ["beforeEntry", "beforeCommit", "afterCommit"] as const) {
  test(`server authority changes at transaction ${hook} suppress payload without rebinding`, async () => {
    const f = fixture();
    f.controls[hook] = () => { f.controls.authority = reviewAuthority({ sessionRevision: 2 }); };
    await failure(await f.handler(request()), "API_SESSION_CHANGED", 403);
    if (hook === "afterCommit") {
      assert.equal(f.controls.commits, 1);
      assert.equal(f.controls.rollbacks, 0);
      assert.equal(f.store.rows.services.size, 1);
      delete f.controls[hook];
      assert.equal((await created(f)).replayed, true);
    } else noWrites(f);
  });
}
test("revoked session during admission is changed rather than a new unauthenticated identity", async () => {
  const f = fixture();
  f.overrides.admit = async (input) => { f.controls.authority = null; return grant(input); };
  await failure(await f.handler(request()), "API_SESSION_CHANGED", 403);
  noWrites(f);
});

test("pre-aborted request suppresses all async adapters", async () => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort(SYNTHETIC_PRIVATE);
  await failure(await f.handler(request("create", createInput(), { signal: abort.signal })), "API_ABORTED", 408);
  assert.equal(f.sessions.length, 0);
  assert.equal(f.admissions.length, 0);
  noWrites(f);
});
for (const phase of ["session", "admission", "transaction"] as const) {
  for (const ending of ["resolve", "reject"] as const) {
    test(`cancel pending ${phase}, then late ${ending}, cannot resume dispatch`, async () => {
      const f = fixture();
      const entered = deferred<void>();
      const late = deferred<unknown>();
      const abort = new AbortController();
      if (phase === "session") f.overrides.readSession = async () => { entered.resolve(); return late.promise; };
      if (phase === "admission") f.overrides.admit = async () => { entered.resolve(); return late.promise; };
      if (phase === "transaction") f.overrides.transaction = async (authority, task) => {
        entered.resolve(); await late.promise;
        return f.store.catalogDependencies.transaction(authority, task);
      };
      const pending = f.handler(request("create", createInput(), { signal: abort.signal }));
      await entered.promise;
      abort.abort(SYNTHETIC_PRIVATE);
      await failure(await pending, "API_ABORTED", 408);
      if (ending === "reject") late.reject(new Error(SYNTHETIC_PRIVATE));
      else late.resolve(phase === "session" ? reviewAuthority() : phase === "admission" ? grant(f.admissions[0]!.request) : undefined);
      await nextTurn(); await nextTurn();
      noWrites(f);
      assert.ok(f.sessions.every(({ signal }) => signal.aborted));
      if (phase === "session") assert.equal(f.admissions.length, 0);
      if (phase !== "transaction") assert.equal(f.controls.transactions, 0);
    });
  }
}
for (const phase of ["session", "admission", "transaction"] as const) {
  test(`deadline aborts pending ${phase} and handles a late rejection`, async () => {
    const f = fixture({ requestTimeoutMs: 500 });
    const late = deferred<unknown>();
    if (phase === "session") f.overrides.readSession = async () => late.promise;
    if (phase === "admission") f.overrides.admit = async () => late.promise;
    if (phase === "transaction") f.overrides.transaction = async () => { await late.promise; throw new Error(SYNTHETIC_PRIVATE); };
    await failure(await f.handler(request()), "API_TIMEOUT", 408);
    late.reject(new Error(SYNTHETIC_PRIVATE));
    await nextTurn();
    noWrites(f);
    assert.ok(f.sessions.every(({ signal }) => signal.aborted));
  });
}
for (const interruption of ["abort", "timeout"] as const) {
  for (const ending of ["resolve", "reject"] as const) {
    test(`${interruption} after commit with late ${ending} hides payload but keeps ledger for same-operation retry`, async () => {
      const f = fixture({ requestTimeoutMs: 750 });
      const committed = deferred<void>();
      const ack = deferred<void>();
      const abort = new AbortController();
      f.controls.afterCommit = async () => { committed.resolve(); await ack.promise; };
      const pending = f.handler(request("create", createInput(), { signal: abort.signal }));
      await committed.promise;
      assert.equal(f.controls.commits, 1);
      if (interruption === "abort") abort.abort(SYNTHETIC_PRIVATE);
      await failure(await pending, interruption === "abort" ? "API_ABORTED" : "API_TIMEOUT", 408);
      assert.equal(f.controls.rollbacks, 0);
      assert.equal(f.store.rows.services.size, 1);
      assert.equal(f.store.rows.catalogOperations.size, 1);
      if (ending === "resolve") ack.resolve(); else ack.reject(new Error(SYNTHETIC_PRIVATE));
      await nextTurn(); await nextTurn();
      delete f.controls.afterCommit;
      assert.equal((await created(f)).replayed, true);
      assert.equal(f.store.rows.services.size, 1);
      assert.equal(f.store.rows.catalogOperations.size, 1);
    });
  }
}
test("pending body read cancels on request abort without a transaction", async () => {
  const f = fixture();
  const reading = deferred<void>();
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); return new Promise<void>(() => {}); }, cancel() { cancelled++; } });
  const abort = new AbortController();
  const pending = f.handler(request("create", undefined, { raw: stream, signal: abort.signal }));
  await reading.promise;
  // The stream can prefetch before session/admission; allow those microtasks to settle.
  await nextTurn();
  abort.abort(SYNTHETIC_PRIVATE);
  await failure(await pending, "API_ABORTED", 408);
  assert.equal(f.controls.transactions, 0);
  assert.equal(cancelled, 1);
  noWrites(f);
});
test("wall-clock deadline is enforced synchronously while the session itself remains live", async () => {
  const f = fixture({ requestTimeoutMs: 500 });
  f.overrides.admit = async (input) => { f.controls.now += 500; return grant(input); };
  await failure(await f.handler(request()), "API_TIMEOUT", 408);
  assert.equal(f.controls.transactions, 0);
  noWrites(f);
});
test("monotonic deadline detects a starved timer even when the injected wall clock is fixed", async () => {
  const f = fixture({ requestTimeoutMs: 100 });
  f.overrides.admit = async (input) => {
    const until = performance.now() + 125;
    while (performance.now() < until) { /* Bounded synthetic event-loop starvation. */ }
    return grant(input);
  };
  await failure(await f.handler(request()), "API_TIMEOUT", 408);
  assert.equal(f.controls.now, REVIEW_NOW);
  assert.equal(f.controls.transactions, 0);
  noWrites(f);
});
for (const scope of ["session", "permit", "overall"] as const) {
  test(`${scope} deadline is registered with the transaction and blocks a late commit`, async () => {
    const f = fixture({ requestTimeoutMs: 2000 });
    let deadline = REVIEW_NOW + 2000;
    if (scope === "session") {
      deadline = REVIEW_NOW + 1000;
      f.controls.authority = reviewAuthority({ expiresAt: deadline });
    }
    if (scope === "permit") {
      deadline = REVIEW_NOW + 1000;
      f.overrides.admit = async (input) => ({ ...grant(input), expiresAt: deadline });
    }
    const registered: number[] = [];
    f.overrides.transaction = (authority, task) => f.store.catalogDependencies.transaction(authority, (tx) => task({
      ...tx, limitCommitTime(notAfter) { registered.push(notAfter); tx.limitCommitTime(notAfter); },
    }));
    f.controls.beforeCommit = () => { f.controls.now = deadline; };
    await failure(await f.handler(request()), scope === "session" ? "API_SESSION_CHANGED" : "API_TIMEOUT", scope === "session" ? 403 : 408);
    assert.ok(registered.includes(deadline));
    assert.equal(f.controls.rollbacks, 1);
    noWrites(f);
  });
}
test("session expiry while awaiting admission aborts the shared signal and cannot advance", async () => {
  const f = fixture({ requestTimeoutMs: 2000 });
  f.controls.authority = reviewAuthority({ expiresAt: REVIEW_NOW + 500 });
  const late = deferred<unknown>();
  f.overrides.admit = async () => late.promise;
  await failure(await f.handler(request()), "API_SESSION_CHANGED", 403);
  assert.ok(f.admissions[0]!.signal.aborted);
  late.resolve(grant(f.admissions[0]!.request));
  await nextTurn();
  noWrites(f);
});
test("short permit expiry while awaiting a body yields timeout rather than user cancellation", async () => {
  const f = fixture({ requestTimeoutMs: 2000 });
  f.overrides.admit = async (input) => ({ ...grant(input), expiresAt: REVIEW_NOW + 500 });
  const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
  await failure(await f.handler(request("create", undefined, { raw: stream })), "API_TIMEOUT", 408);
  assert.equal(f.controls.transactions, 0);
  noWrites(f);
});
for (const value of [NaN, Infinity, -1, REVIEW_NOW - 1]) {
  test(`invalid or backwards clock fails closed ${String(value)}`, async () => {
    const f = fixture();
    f.overrides.admit = async (input) => { f.controls.now = value; return grant(input); };
    await failure(await f.handler(request()), "API_UNAVAILABLE", 503);
    noWrites(f);
  });
}
