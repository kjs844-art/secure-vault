import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleRequest, isDisconnectedRoute, isSyntheticRuntime, PUBLIC_STATUS,
} from "../src/server/runtime-policy.ts";

test("only the unconfigured/synthetic runtime can start; no generic env fallback", () => {
  assert.equal(isSyntheticRuntime({}), true);
  assert.equal(isSyntheticRuntime({ KEYATLAS_BENEFITS_MODE: "synthetic" }), true);
  for (const mode of ["", "live", "production", "SYNTHETIC", " synthetic "]) {
    assert.equal(isSyntheticRuntime({ KEYATLAS_BENEFITS_MODE: mode }), false);
  }
  assert.equal(isSyntheticRuntime({ SUPABASE_URL: "https://synthetic.invalid" }), true);
});

for (const pathname of [
  "/auth", "/auth/", "/oauth/gmail/return", "/gmail", "/gmail/scan",
  "/analyze", "/mcp", "/mcp/tools", "/.well-known/oauth-protected-resource",
  "/.lovable.oauth.consent", "/dashboard", "/services", "/settings", "/schedule",
  "/AUTH", "/%61uth", "/oauth%2fgmail/return", "/%broken",
  "/api/catalog", "/api/catalog/create", "/api/catalog/list", "/API/CATALOG/delete", "/api/%63atalog/get",
]) {
  test("unconnected route does not reach any adapter: " + pathname, async () => {
    assert.equal(isDisconnectedRoute(pathname), true);
    let rendered = false;
    const result = await handleRequest(
      new Request("http://localhost" + pathname, { method: "POST", body: "synthetic-body" }),
      {},
      () => { rendered = true; throw new Error("must not run"); },
    );
    assert.equal(result.status, 503);
    assert.equal(rendered, false);
    assert.deepEqual(await result.json(), { code: "INTEGRATION_NOT_CONNECTED" });
  });
}

test("runtime mode cannot be overridden by any query/cookie", async () => {
  let rendered = false;
  const result = await handleRequest(
    new Request("http://localhost/?mode=synthetic", { headers: { cookie: "mode=synthetic" } }),
    { KEYATLAS_BENEFITS_MODE: "live" },
    () => { rendered = true; return new Response("unsafe"); },
  );
  assert.equal(result.status, 503);
  assert.equal(rendered, false);
  assert.deepEqual(await result.json(), { code: "MODE_NOT_AVAILABLE" });
});

test("public status is fixed metadata, not environment or authentication evidence", async () => {
  const result = await handleRequest(
    new Request("http://localhost/api/integration-status"),
    { SUPABASE_URL: "SYNTHETIC_ENV_DO_NOT_RETURN", SOME_OTHER_VALUE: "synthetic" },
    () => { throw new Error("status must not render"); },
  );
  assert.deepEqual(await result.json(), PUBLIC_STATUS);
  assert.equal(result.headers.get("set-cookie"), null);
});

test("status endpoint supports GET/HEAD only", async () => {
  for (const method of ["HEAD", "POST", "DELETE", "OPTIONS"]) {
    const result = await handleRequest(
      new Request("http://localhost/api/integration-status", { method }), {},
      () => { throw new Error("must not render"); },
    );
    assert.equal(result.status, method === "HEAD" ? 200 : 405);
    assert.equal(await result.text(), "");
    if (method !== "HEAD") assert.equal(result.headers.get("allow"), "GET, HEAD");
  }
});

test("rendering is retained for SSR while fixed privacy headers are added", async () => {
  const result = await handleRequest(new Request("http://localhost/"), {}, () =>
    new Response("<h1>synthetic</h1>", { headers: { "Content-Type": "text/html" } }));
  assert.equal(result.status, 200);
  assert.equal(await result.text(), "<h1>synthetic</h1>");
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  assert.equal(result.headers.get("x-frame-options"), "DENY");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.match(result.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
});

test("exceptions and upstream server error bodies are never returned", async () => {
  for (const render of [
    () => { throw new Error("SYNTHETIC_INTERNAL_ERROR_DETAIL"); },
    () => new Response("SYNTHETIC_INTERNAL_ERROR_DETAIL", { status: 500 }),
  ]) {
    const result = await handleRequest(new Request("http://localhost/"), {}, render);
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { code: "REQUEST_FAILED" });
  }
});
