import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { localEnvironment } from "./local-environment.mjs";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const child = spawn(process.execPath, [".output/server/index.mjs"], {
  cwd, env: localEnvironment(process.env, port), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
// Drain runtime output without storing potentially sensitive request logs.
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});
let spawnError;
child.on("error", (error) => { spawnError = error; });
const exited = once(child, "exit").catch(() => []);
const base = "http://127.0.0.1:" + port;
const request = (path, init) => fetch(base + path, {
  ...init, redirect: "error", signal: AbortSignal.timeout(5000),
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (spawnError || child.exitCode !== null) throw new Error("Local SSR process did not start");
    try {
      const result = await request("/api/integration-status");
      ready = result.status === 200;
      await result.arrayBuffer();
    } catch { /* A freshly spawned server may not be listening yet. */ }
    if (ready) break;
    await delay(250);
  }
  assert.ok(ready, "SSR server never became ready");
  const status = await request("/api/integration-status");
  assert.equal(status.headers.get("cache-control"), "no-store");
  const metadata = await status.json();
  assert.equal(metadata.database, "not-connected");
  assert.equal(metadata.gmail, "not-connected");
  assert.equal(metadata.realSecretGate, "CLOSED");
  const page = await request("/");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<html lang="ko"/);
  assert.match(html, /계정과 서비스 정보를 한곳으로/);
  assert.match(html, /합성 데이터 전용/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|supabase\.co|lovable\.app/);
  const statusPage = await request("/status");
  assert.equal(statusPage.status, 200);
  const statusHtml = await statusPage.text();
  assert.match(statusHtml, /연결 준비 상태/);
  assert.match(statusHtml, /not-connected/);
  assert.match(statusHtml, /CLOSED/);
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]);
  assert.ok(assets.length >= 2, "SSR must reference executable client assets");
  for (const asset of assets) {
    assert.ok(asset.startsWith("/") && !asset.startsWith("//"), "Asset must be local");
    const result = await request(asset);
    assert.equal(result.status, 200, "Bundled asset not served");
    await result.arrayBuffer();
  }
  for (const path of ["/auth", "/oauth/gmail/return", "/mcp", "/gmail", "/services",
    "/api/catalog", "/api/catalog/create", "/api/catalog/list"]) {
    const result = await request(path, { method: "POST", body: "synthetic" });
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { code: "INTEGRATION_NOT_CONNECTED" });
  }
  const missing = await request("/synthetic-missing-page");
  assert.equal(missing.status, 404);
  console.log(JSON.stringify({
    check: "benefits-ssr-http-smoke", result: "passed", assets: assets.length,
    network: "loopback only", browserHydration: "not tested", realSecretGate: "CLOSED",
  }));
} finally {
  // This is only the child created above, never another developer's Node process.
  if (child.exitCode === null) child.kill();
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("Owned SSR process cleanup was not confirmed");
  }
}
