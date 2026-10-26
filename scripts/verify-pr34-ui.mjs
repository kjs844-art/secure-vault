import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Two synthetic, loopback-only browser regressions. No WASM, generated files,
// downloaded browsers, existing profiles, provider calls, or screenshots.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(repoRoot, "apps", "web");
const landingRoot = path.join(repoRoot, "apps", "landing");
const fixtureId = path.join(webRoot, "__pr34_discovery_fixture__.tsx").replaceAll("\\", "/");
const fixtureSource = `
import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { DiscoveryInboxPanel } from "./src/features/discovery-inbox/DiscoveryInboxPanel";
const item = (serviceName) => [{
  id: "synthetic-shared-id", serviceName, accountHint: "synthetic account",
  confidence: "needs_review", sourceKind: "manual", sourceLabel: "synthetic only",
  observedOn: "2026-10-27", note: "synthetic evidence"
}];
const A = item("Synthetic Alpha");
const B = item("Synthetic Beta");
const EMPTY = [];
function Fixture() {
  const [items, setItems] = useState(A);
  const [label, setLabel] = useState("합성 입력 처음");
  return <>
    <nav aria-label="Synthetic fixture controls">
      <button data-testid="fixture-a" onClick={() => setItems(A)}>Input A</button>
      <button data-testid="fixture-b" onClick={() => setItems(B)}>Input B</button>
      <button data-testid="fixture-empty" onClick={() => setItems(EMPTY)}>Empty input</button>
      <button data-testid="fixture-label" onClick={() => setLabel("합성 입력 이름 변경")}>Label only</button>
    </nav>
    <DiscoveryInboxPanel items={items} sourceLabel={label} />
  </>;
}
createRoot(document.getElementById("root")).render(<StrictMode><Fixture /></StrictMode>);
`;

function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function bundleInMemory(root, fixture = false) {
  const require = createRequire(path.join(root, "package.json"));
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  const { default: react } = await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href);
  const result = await bounded(build({
    root,
    configFile: false,
    envDir: false,
    envPrefix: [],
    publicDir: false,
    base: "/",
    logLevel: "error",
    plugins: [
      ...(fixture ? [{
        name: "pr34-synthetic-only-entry",
        resolveId(id) { return id.replaceAll("\\", "/") === fixtureId ? fixtureId : null; },
        load(id) { return id === fixtureId ? fixtureSource : null; },
      }] : []),
      react(),
    ],
    build: {
      write: false,
      emptyOutDir: false,
      sourcemap: false,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: fixture ? fixtureId : path.join(root, "src", "main.tsx"),
        output: { entryFileNames: "entry.js", chunkFileNames: "assets/[name]-[hash].js" },
      },
    },
  }), 60_000, "in-memory bundle");
  assert(!Array.isArray(result) && Array.isArray(result.output), "expected one in-memory output");
  const files = new Map(result.output.map((entry) => [
    `/${entry.fileName}`,
    Buffer.from(entry.type === "chunk" ? entry.code : entry.source),
  ]));
  assert(files.has("/entry.js"), "entry missing");
  const styles = [...files.keys()].filter((file) => file.endsWith(".css"))
    .map((file) => `<link rel="stylesheet" href="${file}">`).join("");
  files.set("/", Buffer.from(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
${styles}</head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`));
  return files;
}

const contentTypes = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff": "font/woff", ".woff2": "font/woff2", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json",
};

async function openServer(files) {
  const server = http.createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    let pathname;
    try { pathname = new URL(request.url, "http://127.0.0.1").pathname; }
    catch { response.writeHead(400).end(); return; }
    const body = files.get(pathname);
    if (!body) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", pathname === "/" ? "text/html; charset=utf-8"
      : contentTypes[path.extname(pathname)] ?? "application/octet-stream");
    response.writeHead(200).end(request.method === "HEAD" ? undefined : body);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await bounded(new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  }), 5_000, "loopback listen");
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function expectInbox(page, filter, count, name) {
  await page.waitForFunction(({ filter, count, name }) => {
    const active = document.querySelector(`[data-testid="discovery-filter-${filter}"]`);
    const items = [...document.querySelectorAll('[data-testid="discovery-inbox-item"]')];
    return active?.getAttribute("aria-pressed") === "true" && items.length === count
      && (name === null || items[0]?.querySelector("h2")?.textContent === name);
  }, { filter, count, name: name ?? null });
  const status = await page.getByTestId("discovery-inbox-status").textContent();
  assert(status?.endsWith(`${count}건`), "live status count must match the rendered list");
}

async function discoveryChecks(page, groups) {
  await expectInbox(page, "open", 1, "Synthetic Alpha");
  await page.getByTestId("discovery-filter-needs_review").click();
  await page.getByTestId("discovery-action-dismissed").click();
  await expectInbox(page, "needs_review", 0);
  await page.getByTestId("discovery-filter-dismissed").click();
  await expectInbox(page, "dismissed", 1, "Synthetic Alpha");
  groups.push("discovery: filter and dismiss remain effective within input A");

  await page.getByTestId("fixture-b").click();
  await expectInbox(page, "open", 1, "Synthetic Beta");
  // This is deliberately the first panel action after replacement props.
  await page.getByTestId("discovery-action-dismissed").click();
  await expectInbox(page, "open", 0);
  await page.getByTestId("discovery-filter-dismissed").click();
  await expectInbox(page, "dismissed", 1, "Synthetic Beta");
  groups.push("discovery: first action after replacement acts on B, not stale A");

  await page.getByTestId("fixture-a").click();
  await expectInbox(page, "open", 1, "Synthetic Alpha");
  await page.getByTestId("discovery-action-confirmed").click();
  await page.getByTestId("discovery-filter-confirmed").click();
  await expectInbox(page, "confirmed", 1, "Synthetic Alpha");
  groups.push("discovery: A to B to the identical original A array resets scope");

  await page.getByTestId("fixture-label").click();
  await page.getByText("합성 입력 이름 변경", { exact: false }).waitFor();
  await expectInbox(page, "confirmed", 1, "Synthetic Alpha");
  groups.push("discovery: label-only rerender preserves current edits and filter");

  await page.getByTestId("fixture-empty").click();
  await expectInbox(page, "open", 0);
  await page.getByTestId("discovery-inbox-empty").waitFor();
  await page.getByTestId("fixture-a").click();
  await expectInbox(page, "open", 1, "Synthetic Alpha");
  groups.push("discovery: empty replacement and subsequent A reset correctly");
}

const captionTags = ["01 · KEY", "02 · TURN", "03 · GATHER", "04 · LOCK"];
async function landingChecks(page, groups) {
  await page.locator(".captions").waitFor({ state: "attached" });
  assert.equal(await page.locator(".captions").getAttribute("role"), "status");
  assert.equal(await page.locator(".captions").getAttribute("aria-live"), "polite");
  assert.equal(await page.locator(".captions").getAttribute("aria-atomic"), "true");
  // The actual Scene is included, not aliased away. WebGL failures fail the run.
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".gl canvas");
    return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0;
  });
  groups.push("landing: real Scene canvas and stable polite atomic status region mount");

  for (const [fraction, beat] of [[0, 0], [0.2, 1], [0.46, 2], [0.65, 3], [0.9, 4], [1, 0], [0, 0]]) {
    await page.evaluate((fraction) => window.scrollTo({ top: innerHeight * 4.6 * fraction, behavior: "instant" }), fraction);
    await page.waitForFunction(({ fraction, beat, tags }) => {
      const region = document.querySelector(".captions");
      const paragraphs = region?.querySelectorAll("p");
      const target = innerHeight * 4.6 * fraction;
      return Math.abs(scrollY - target) <= 2 && region !== null && paragraphs?.length === (beat ? 1 : 0)
        && (beat ? paragraphs[0]?.querySelector("small")?.textContent === tags[beat - 1]
          : region.textContent.trim() === "");
    }, { fraction, beat, tags: captionTags });
    const snapshot = await page.locator(".captions").ariaSnapshot();
    for (const [index, tag] of captionTags.entries()) {
      assert.equal(snapshot.includes(tag), beat === index + 1, "only the active caption belongs in the accessibility tree");
    }
    groups.push(`landing: native scroll ${fraction} exposes only caption ${beat}`);
  }
}

async function runSurface(name, chromium, files, checks) {
  const result = { name, groups: [], errors: {}, passed: false,
    cleanup: { contextClosed: false, browserDisconnected: false, serverClosed: false } };
  let server;
  let browser;
  let context;
  const errors = { page: 0, console: 0, http: 0, request: 0, offOrigin: 0, websocket: 0 };
  try {
    const started = await openServer(files);
    server = started.server;
    browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 15_000 });
    result.browserVersion = browser.version();
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
    context.setDefaultTimeout(8_000);
    context.setDefaultNavigationTimeout(15_000);
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === started.origin) return route.continue();
      errors.offOrigin += 1;
      return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => { errors.websocket += 1; socket.close(); });
    const page = await context.newPage();
    page.on("pageerror", () => { errors.page += 1; });
    page.on("console", (message) => { if (message.type() === "error") errors.console += 1; });
    page.on("response", (response) => { if (response.status() >= 400) errors.http += 1; });
    page.on("requestfailed", () => { errors.request += 1; });
    await page.goto(started.origin, { waitUntil: "load" });
    await bounded(checks(page, result.groups), 60_000, `${name} assertions`);
    assert(Object.values(errors).every((count) => count === 0), `${name}: browser or network errors`);
    result.passed = true;
  } catch (error) {
    result.failure = String(error?.message ?? error).slice(0, 500);
  } finally {
    // Only resources created above are closed. Never close a user browser/profile.
    try {
      if (context) await bounded(context.close(), 10_000, `${name} context close`);
      result.cleanup.contextClosed = true;
    } catch { result.cleanup.contextClosed = false; }
    try {
      if (browser) await bounded(browser.close(), 10_000, `${name} browser close`);
      result.cleanup.browserDisconnected = !browser || !browser.isConnected();
    } catch { result.cleanup.browserDisconnected = false; }
    try {
      if (server) {
        await bounded(new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        }), 5_000, `${name} server close`);
      }
      result.cleanup.serverClosed = !server || !server.listening;
    } catch { result.cleanup.serverClosed = false; }
    result.errors = errors;
    result.passed &&= Object.values(result.cleanup).every(Boolean)
      && Object.values(errors).every((count) => count === 0);
  }
  return result;
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ["--synthetic-only"], "Usage: node scripts/verify-pr34-ui.mjs --synthetic-only");
  const require = createRequire(path.join(landingRoot, "package.json"));
  const { chromium } = require("playwright");
  const evidence = { kind: "pr34-two-ui-regressions", syntheticOnly: true, results: [], sourceSha256: {} };
  for (const file of [
    "apps/web/src/features/discovery-inbox/DiscoveryInboxPanel.tsx",
    "apps/landing/src/App.tsx", "apps/landing/src/landing/Scene.tsx",
  ]) {
    evidence.sourceSha256[file] = createHash("sha256").update(await readFile(path.join(repoRoot, file))).digest("hex");
  }
  for (const [name, root, fixture, checks] of [
    ["discovery", webRoot, true, discoveryChecks],
    ["landing", landingRoot, false, landingChecks],
  ]) {
    const result = await runSurface(name, chromium, await bundleInMemory(root, fixture), checks);
    evidence.results.push(result);
    // Do not launch another browser until every owned resource is closed.
    if (!Object.values(result.cleanup).every(Boolean)) break;
  }
  evidence.passed = evidence.results.length === 2 && evidence.results.every((result) => result.passed);
  console.log(JSON.stringify(evidence, null, 2));
  process.exitCode = evidence.passed ? 0 : 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ kind: "pr34-two-ui-regressions", passed: false,
    failure: String(error?.message ?? error).slice(0, 500) }));
  process.exitCode = 1;
});
