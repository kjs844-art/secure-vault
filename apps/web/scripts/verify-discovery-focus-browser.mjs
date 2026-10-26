// Current C04 focus regression React fixture; installed browser only, no credentials or downloads.
// node apps/web/scripts/verify-discovery-focus-browser.mjs --synthetic-only [--built-app] [--channel=chrome|msedge]
// --built-app additionally reads existing dist; it never builds that app.
// --preflight checks arguments only, without loading dependencies or starting resources.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { acquireOwned, withDeadline } from "../tests/mvp-browser/qa-lifecycle.mjs";

const args = process.argv.slice(2), channelArgs = args.filter((arg) => arg.startsWith("--channel="));
const valid = args.includes("--synthetic-only") && new Set(args).size === args.length && channelArgs.length <= 1
  && args.every((arg) => ["--synthetic-only", "--built-app", "--preflight", "--channel=chrome", "--channel=msedge"].includes(arg));
if (!valid) {
  console.log(JSON.stringify({ result: "BLOCKED", code: "SYNTHETIC_ARGUMENTS_REQUIRED" }));
  process.exit(2);
}
const channel = channelArgs[0]?.slice("--channel=".length) ?? "chrome", builtApp = args.includes("--built-app");
if (args.includes("--preflight")) {
  console.log(JSON.stringify({ result: "PREFLIGHT_ONLY", channel, builtApp, browserStarted: false,
    limits: "arguments only; dependencies, existing build and browser availability not checked" }));
  process.exit(0);
}

const startedAt = new Date().toISOString(), groups = [], cleanupSteps = [], sockets = new Set();
const counters = { pageErrors: 0, consoleErrors: 0, externalRequests: 0, httpErrors: 0, failedRequests: 0,
  deniedRequests: 0, blockedMethods: 0, sourceRequests: 0, websocketRequests: 0, routeErrors: 0, serverErrors: 0 };
const requestedAssets = new Set(), assets = new Map();
let stage = "DEPENDENCIES", primaryFailure = null, functionalChecksCompleted = false;
let acquisitionTimedOut = false, serverListenTimedOut = false;
let browser, context, server, origin, browserVersion = null, fixtureEntrySha256 = null, fixtureAssetsSha256 = null;
let appIndexSha256 = null, appAssetsSha256 = null, builtAppRoute = "NOT_RUN", concurrency = null;
const sha = (value) => createHash("sha256").update(value).digest("hex");
function failureCode(error) {
  // Only fixed tags escape this process; never serialize the thrown value.
  try {
    if (error instanceof Error && error.message === "QA_DEADLINE") return "DEADLINE";
    if (error instanceof assert.AssertionError) return "ASSERTION";
    if (error instanceof Error && error.name === "TimeoutError") return "OPERATION_TIMEOUT";
  } catch { /* A hostile thrown object is still just an unknown failure. */ }
  return "CHECK_FAILED";
}
function browserEnvironment() {
  const env = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "Path", "LANG", "TZ"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
async function acquire(factory, dispose) {
  try { return await acquireOwned(factory, dispose, 30_000); }
  catch (error) { if (failureCode(error) === "DEADLINE") acquisitionTimedOut = true; throw error; }
}
async function check(name, operation) {
  stage = name;
  await withDeadline(operation, 30_000);
  // A late operation can never append a passed group after its deadline.
  groups.push(name);
}
async function cleanup(name, operation, timeoutMs) {
  try { await withDeadline(operation, timeoutMs); cleanupSteps.push({ name, outcome: "RESOLVED", timeoutMs }); }
  catch (error) { cleanupSteps.push({ name, outcome: failureCode(error) === "DEADLINE" ? "DEADLINE" : "REJECTED", timeoutMs }); }
}
function assetName(name) {
  assert.match(name, /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/);
  assert.ok(name.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
}
function assetType(name) {
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".wasm")) return "application/wasm";
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".png")) return "image/png";
  return "text/javascript; charset=utf-8";
}
function assetDigest(entries) {
  return sha(JSON.stringify(entries.map(([name, body]) => [name, Buffer.byteLength(body), sha(body)])
    .sort(([left], [right]) => left.localeCompare(right))));
}

try {
  const landing = createRequire(new URL("../../landing/package.json", import.meta.url));
  const { chromium } = landing("playwright"), { expect } = landing("playwright/test");
  const { build } = await import("vite");
  stage = "FIXTURE_BUILD";
  const bundle = await withDeadline(() => build({ root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false, envDir: false, envPrefix: [], logLevel: "silent", esbuild: { jsx: "automatic" },
    build: { write: false, emptyOutDir: false, rollupOptions: {
      input: fileURLToPath(new URL("./fixtures/discovery-focus-fixture.tsx", import.meta.url)),
      output: { entryFileNames: "fixture.js" },
    } },
  }), 45_000);
  assert.ok(!Array.isArray(bundle) && "output" in bundle);
  for (const output of bundle.output) {
    assetName(output.fileName);
    assets.set("/" + output.fileName, { body: output.type === "chunk" ? output.code : output.source, type: assetType(output.fileName) });
  }
  assert.ok(assets.has("/fixture.js"));
  fixtureEntrySha256 = sha(assets.get("/fixture.js").body);
  fixtureAssetsSha256 = assetDigest([...assets].map(([name, asset]) => [name, asset.body]));
  const css = [...assets.keys()].filter((name) => name.endsWith(".css"))
    .map((name) => `<link rel="stylesheet" href="${name}">`).join("");
  let appHtml = null;
  if (builtApp) {
    stage = "EXISTING_DIST_READ";
    appHtml = await readFile(new URL("../dist/index.html", import.meta.url));
    appIndexSha256 = sha(appHtml);
    const appEntries = [];
    for (const entry of await readdir(new URL("../dist/assets/", import.meta.url), { withFileTypes: true })) {
      assert.ok(entry.isFile()); assetName(entry.name);
      const name = "/assets/" + entry.name, body = await readFile(new URL("../dist/assets/" + entry.name, import.meta.url));
      assert.ok(!assets.has(name));
      assets.set(name, { body, type: assetType(entry.name) }); appEntries.push([name, body]);
    }
    appAssetsSha256 = assetDigest(appEntries);
  }
  stage = "SERVER_CREATE";
  server = createServer((request, response) => {
    try {
      if (!origin || request.headers.host !== new URL(origin).host) {
        counters.deniedRequests++; response.writeHead(403).end(); return;
      }
      if (!["GET", "HEAD"].includes(request.method)) { counters.blockedMethods++; response.writeHead(405).end(); return; }
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("content-security-policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
      if (request.url === "/favicon.ico") { response.writeHead(204).end(); return; }
      if (appHtml !== null && ["/", "/?view=discovery-inbox"].includes(request.url)) {
        response.setHeader("content-type", "text/html; charset=utf-8"); response.end(appHtml); return;
      }
      if (request.url === "/__discovery_focus__.html") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,">${css}</head><body><div id="fixture-root"></div><script type="module" src="/fixture.js"></script></body></html>`); return;
      }
      const asset = assets.get(request.url);
      if (!asset) { response.writeHead(404).end(); return; }
      response.setHeader("content-type", asset.type); response.end(asset.body);
    } catch { counters.serverErrors++; response.destroy(); }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("error", () => { counters.serverErrors++; });
  stage = "SERVER_LISTEN";
  try {
    await withDeadline(() => new Promise((resolve, reject) => {
      const onError = (error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError); server.once("listening", onListening); server.listen(0, "127.0.0.1");
    }), 15_000);
  } catch (error) { if (failureCode(error) === "DEADLINE") serverListenTimedOut = true; throw error; }
  const address = server.address();
  assert.ok(address && typeof address === "object" && address.address === "127.0.0.1");
  origin = `http://127.0.0.1:${address.port}`;
  stage = "BROWSER_LAUNCH";
  browser = await acquire(() => chromium.launch({ channel, headless: true, timeout: 30_000, env: browserEnvironment() }), (value) => value.close());
  const version = browser.version(); assert.match(version, /^\d+(?:\.\d+){1,3}$/); browserVersion = version;
  stage = "CONTEXT_CREATE";
  context = await acquire(() => browser.newContext({ serviceWorkers: "block", acceptDownloads: false,
    locale: "ko-KR", timezoneId: "Asia/Seoul", viewport: { width: 1280, height: 900 } }), (value) => value.close());
  context.setDefaultTimeout(10_000); context.setDefaultNavigationTimeout(15_000);
  await withDeadline(() => context.route("**/*", async (route) => {
    try {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { counters.externalRequests++; await route.abort("blockedbyclient"); return; }
      if (!["GET", "HEAD"].includes(request.method())) { counters.blockedMethods++; await route.abort("blockedbyclient"); return; }
      if (/^\/(?:src\/|@vite\/|@fs\/|@id\/)/.test(url.pathname)) { counters.sourceRequests++; await route.abort("blockedbyclient"); return; }
      if (url.pathname.startsWith("/assets/")) requestedAssets.add(url.pathname);
      await route.continue();
    } catch { counters.routeErrors++; }
  }), 10_000);
  await withDeadline(() => context.routeWebSocket("**/*", (socket) => {
    counters.websocketRequests++;
    try { socket.close(); } catch { counters.routeErrors++; }
  }), 10_000);
  context.on("requestfailed", () => { counters.failedRequests++; });
  context.on("response", (response) => { if (response.status() >= 400) counters.httpErrors++; });
  context.on("page", (page) => {
    page.on("pageerror", () => { counters.pageErrors++; });
    page.on("console", (message) => { if (message.type() === "error") counters.consoleErrors++; });
    page.on("dialog", (dialog) => { counters.pageErrors++; void dialog.dismiss().catch(() => { counters.routeErrors++; }); });
  });
  stage = "FIXTURE_PAGE_CREATE";
  const page = await acquire(() => context.newPage(), (value) => value.close());
  await withDeadline(() => page.goto(origin + "/__discovery_focus__.html"), 20_000);
  await page.waitForFunction(() => window.discoveryFocusFixture?.ready());
  const panel = page.locator("#panel");
  const rows = (target) => target.getByTestId("discovery-inbox-item");
  const filter = (target, name) => target.getByTestId("discovery-filter-" + name);
  const action = (row, name) => row.getByTestId("discovery-action-" + name);
  const nativeAction = async (target, name) => {
    await action(rows(target).first(), name).focus(); await page.keyboard.press("Enter");
  };
  const noStorage = async (target) => {
    assert.equal(await target.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(await target.evaluate(async () => (await indexedDB.databases()).length), 0);
  };
  const noOverflow = async (target) => assert.equal(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const resetSource = async () => {
    await page.locator("#source-b").click(); await page.locator("#source-a").click();
    await expect(rows(panel)).toHaveCount(4); await expect(filter(panel, "open")).toHaveAttribute("aria-pressed", "true");
  };
  await check("FIXTURE_BASELINE", async () => {
    await expect(rows(panel)).toHaveCount(4); await expect(filter(panel, "needs_review")).toHaveText("확인 필요 2");
    await expect(filter(panel, "open")).toHaveAttribute("aria-pressed", "true");
    await expect(panel).toContainText("REAL_SECRET_GATE=CLOSED");
  });
  await check("FIXTURE_CONFIRM_REMOVED_ROW_FOCUS", async () => {
    await filter(panel, "needs_review").click(); await expect(rows(panel)).toHaveCount(2);
    await nativeAction(panel, "confirmed"); await expect(rows(panel)).toHaveCount(1);
    await expect(filter(panel, "needs_review")).toBeFocused();
    await expect(filter(panel, "needs_review")).toHaveAttribute("aria-pressed", "true");
    await expect(filter(panel, "confirmed")).toHaveText("확인됨 2");
  });
  await check("FIXTURE_DISMISS_LAST_ROW_FOCUS", async () => {
    await nativeAction(panel, "dismissed"); await expect(rows(panel)).toHaveCount(0);
    await expect(panel.getByTestId("discovery-inbox-empty")).toBeVisible();
    await expect(filter(panel, "needs_review")).toBeFocused();
    await expect(filter(panel, "dismissed")).toHaveText("오탐 1");
  });
  await check("FIXTURE_RESTORE_DISMISSED_ROW_FOCUS", async () => {
    await filter(panel, "dismissed").click(); await expect(rows(panel)).toHaveCount(1);
    await nativeAction(panel, "needs_review"); await expect(rows(panel)).toHaveCount(0);
    await expect(filter(panel, "dismissed")).toBeFocused();
    await expect(filter(panel, "dismissed")).toHaveAttribute("aria-pressed", "true");
    await filter(panel, "needs_review").click(); await expect(rows(panel)).toHaveCount(1);
    await expect(rows(panel).locator(".discovery-confidence")).toHaveText("확인 필요");
  });
  await check("FIXTURE_OPEN_ROW_REMOVED_TRIGGER_FOCUS", async () => {
    await resetSource();
    const row = rows(panel).filter({ has: page.getByRole("heading", { name: "Example Notes Board", exact: true }) });
    await action(row, "confirmed").focus(); await page.keyboard.press("Enter");
    await expect(rows(panel)).toHaveCount(4);
    await expect(row.locator(".discovery-confidence")).toHaveText("확인됨");
    await expect(action(row, "confirmed")).toHaveCount(0);
    await expect(filter(panel, "open")).toBeFocused();
    await expect(filter(panel, "open")).toHaveAttribute("aria-pressed", "true");
  });
  await check("FIXTURE_CONNECTED_FOCUS_UNCHANGED", async () => {
    await resetSource();
    const row = rows(panel).filter({ has: page.getByRole("heading", { name: "Example Notes Board", exact: true }) });
    await expect(row).toHaveCount(1);
    // The confirmed action disappears after use, but this sibling remains connected.
    // A source-independent/programmatic action must not move its existing focus.
    await action(row, "dismissed").focus();
    await action(row, "confirmed").evaluate((element) => element.click());
    await expect(rows(panel)).toHaveCount(4);
    await expect(row.locator(".discovery-confidence")).toHaveText("확인됨");
    await expect(action(row, "dismissed")).toBeFocused();
    await page.locator("#source-label").evaluate((element) => element.click());
    await expect(panel).toContainText("Synthetic label changed");
    await expect(action(row, "dismissed")).toBeFocused();
  });
  await check("FIXTURE_EXTERNAL_FOCUS_UNCHANGED", async () => {
    await resetSource(); await filter(panel, "needs_review").click();
    await page.locator("#outside").focus();
    await action(rows(panel).first(), "confirmed").evaluate((element) => element.click());
    await expect(rows(panel)).toHaveCount(1); await expect(page.locator("#outside")).toBeFocused();
    await action(rows(panel).first(), "dismissed").evaluate((element) => element.click());
    await expect(rows(panel)).toHaveCount(0); await expect(page.locator("#outside")).toBeFocused();
    await filter(panel, "dismissed").evaluate((element) => element.click()); await expect(rows(panel)).toHaveCount(1);
    await action(rows(panel).first(), "needs_review").evaluate((element) => element.click());
    await expect(rows(panel)).toHaveCount(0); await expect(page.locator("#outside")).toBeFocused();
  });
  await check("FIXTURE_REPLACEMENT_EMPTY_ABA", async () => {
    await page.locator("#source-b").click(); await expect(rows(panel)).toHaveCount(4);
    await expect(rows(panel).first()).toContainText("Replacement");
    await expect(filter(panel, "open")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#source-b")).toBeFocused();
    await filter(panel, "needs_review").click(); await nativeAction(panel, "confirmed");
    await expect(rows(panel)).toHaveCount(1); await expect(filter(panel, "needs_review")).toBeFocused();
    await page.locator("#source-a").click();
    await expect(rows(panel)).toHaveCount(4); await expect(rows(panel).first()).not.toContainText("Replacement");
    await expect(filter(panel, "needs_review")).toHaveText("확인 필요 2");
    await expect(filter(panel, "confirmed")).toHaveText("확인됨 1");
    await expect(filter(panel, "open")).toHaveAttribute("aria-pressed", "true");
    await page.locator("#source-empty").click(); await expect(rows(panel)).toHaveCount(0);
    await expect(panel.getByTestId("discovery-inbox-empty")).toBeVisible();
    await expect(filter(panel, "open")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#source-empty")).toBeFocused();
    await page.locator("#source-a").click(); await expect(rows(panel)).toHaveCount(4);
    await filter(panel, "needs_review").click(); await nativeAction(panel, "confirmed");
    await expect(rows(panel)).toHaveCount(1); await expect(filter(panel, "needs_review")).toBeFocused();
  });
  await check("FIXTURE_REMOUNT_CLEANUP", async () => {
    await page.locator("#unmount").click(); await expect(panel).toBeEmpty();
    await expect(page.locator("#unmount")).toBeFocused();
    await page.locator("#mount").click(); await expect(rows(panel)).toHaveCount(4);
    await expect(filter(panel, "open")).toHaveAttribute("aria-pressed", "true");
    await expect(filter(panel, "needs_review")).toHaveText("확인 필요 2");
    await filter(panel, "needs_review").click(); await nativeAction(panel, "dismissed");
    await expect(rows(panel)).toHaveCount(1); await expect(filter(panel, "needs_review")).toBeFocused();
  });
  const transition = page.locator("#transition-pending"), committed = page.locator("#committed-source");
  let beforeSuspension, afterDiscard;
  const witness = async () => {
    const value = await page.evaluate(() => window.discoveryFocusFixture.stats());
    assert.equal(value.witnessOverflow, false);
    assert.ok(Number.isInteger(value.attempts) && value.attempts >= 0 && value.attempts <= 256);
    assert.ok(Number.isInteger(value.releases) && value.releases >= 0 && value.releases <= 256);
    assert.ok(Array.isArray(value.commits) && value.commits.length <= 64);
    assert.ok(value.commits.every((item) => Number.isInteger(item.request) && item.request >= 0 && item.request <= 256
      && ["A", "B", "EMPTY"].includes(item.source)));
    return value;
  };
  await check("FIXTURE_SUSPENDED_B_DISCARD_PRESERVES_A_EDITS", async () => {
    await resetSource(); await filter(panel, "needs_review").click(); await expect(rows(panel)).toHaveCount(2);
    beforeSuspension = await witness();
    await page.locator("#suspend-b").click();
    await page.waitForFunction((before) => window.discoveryFocusFixture.stats().attempts > before, beforeSuspension.attempts);
    await expect(transition).toHaveText("pending"); await expect(committed).toHaveText("A");
    await expect(page.locator("#transition-fallback")).toHaveCount(0);
    await expect(rows(panel)).toHaveCount(2); await expect(panel).not.toContainText("Replacement");
    await expect(page.locator("#urgent-probe")).toHaveText("0"); await page.locator("#urgent-probe").click();
    await expect(page.locator("#urgent-probe")).toHaveText("1"); await expect(transition).toHaveText("pending");
    // This native action uses committed A after B has actually tried rendering.
    await nativeAction(panel, "confirmed"); await expect(rows(panel)).toHaveCount(1);
    await expect(filter(panel, "needs_review")).toBeFocused(); await expect(filter(panel, "confirmed")).toHaveText("확인됨 2");
    await expect(committed).toHaveText("A"); await expect(transition).toHaveText("pending");
    await page.locator("#cancel-b").evaluate((element) => element.click());
    await expect(transition).toHaveText("idle"); await expect(committed).toHaveText("A");
    await expect(rows(panel)).toHaveCount(1); await expect(filter(panel, "confirmed")).toHaveText("확인됨 2");
    await expect(filter(panel, "needs_review")).toBeFocused();
    await page.locator("#release-b").evaluate((element) => element.click());
    await page.waitForFunction((before) => window.discoveryFocusFixture.stats().releases > before, beforeSuspension.releases);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(transition).toHaveText("idle"); await expect(committed).toHaveText("A");
    await expect(rows(panel)).toHaveCount(1); await expect(filter(panel, "confirmed")).toHaveText("확인됨 2");
    await expect(filter(panel, "needs_review")).toBeFocused();
    afterDiscard = await witness();
    const changed = afterDiscard.commits.slice(beforeSuspension.commits.length);
    assert.ok(changed.length > 0); assert.ok(changed.every(({ source }) => source === "A"));
    concurrency = { suspendedAttempts: afterDiscard.attempts - beforeSuspension.attempts,
      releasedGates: afterDiscard.releases - beforeSuspension.releases,
      discardedBCommits: changed.filter(({ source }) => source === "B").length, freshBCommits: 0 };
  });
  await check("FIXTURE_FRESH_SUSPENDED_B_COMMIT_RESETS", async () => {
    await page.locator("#suspend-b").click();
    await page.waitForFunction((before) => window.discoveryFocusFixture.stats().attempts > before, afterDiscard.attempts);
    await expect(transition).toHaveText("pending"); await expect(committed).toHaveText("A");
    await expect(rows(panel)).toHaveCount(1); await expect(filter(panel, "confirmed")).toHaveText("확인됨 2");
    await page.locator("#release-b").click(); await expect(transition).toHaveText("idle"); await expect(committed).toHaveText("B");
    await expect(rows(panel)).toHaveCount(4); await expect(rows(panel).first()).toContainText("Replacement");
    await expect(filter(panel, "open")).toHaveAttribute("aria-pressed", "true");
    await expect(filter(panel, "needs_review")).toHaveText("확인 필요 2"); await expect(filter(panel, "confirmed")).toHaveText("확인됨 1");
    await filter(panel, "needs_review").click(); await nativeAction(panel, "confirmed");
    await expect(rows(panel)).toHaveCount(1); await expect(filter(panel, "needs_review")).toBeFocused();
    const after = await witness(), changed = after.commits.slice(afterDiscard.commits.length);
    assert.ok(changed.some(({ source }) => source === "B"));
    concurrency = { suspendedAttempts: after.attempts - beforeSuspension.attempts,
      releasedGates: after.releases - beforeSuspension.releases,
      discardedBCommits: concurrency.discardedBCommits, freshBCommits: changed.filter(({ source }) => source === "B").length };
  });
  await check("FIXTURE_NARROW_NO_STORAGE", async () => {
    await resetSource();
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 900 }); await noOverflow(page);
      await filter(panel, "needs_review").click(); await noOverflow(page);
      await filter(panel, "open").click(); await noOverflow(page);
    }
    await noStorage(page);
  });
  if (builtApp) {
    stage = "BUILT_PAGE_CREATE";
    const app = await acquire(() => context.newPage(), (value) => value.close());
    const home = app.getByRole("heading", { name: "내 자격 증명이 어디에 연결됐는지 한눈에", exact: true });
    await check("BUILT_HOME_ROUTE_CLOSED_GATE", async () => {
      await app.goto(origin + "/"); await expect(home).toBeVisible();
      await app.getByRole("link", { name: "가입 흔적 Discovery Inbox →", exact: true }).click();
      await app.waitForURL(origin + "/?view=discovery-inbox"); await expect(rows(app)).toHaveCount(4);
      await expect(app.getByRole("heading", { level: 1, name: "가입 흔적을 확인됨 · 추정 · 확인 필요로 나누기" })).toBeVisible();
      await expect(app.locator(".discovery-inbox")).toContainText("REAL_SECRET_GATE=CLOSED");
    });
    await check("BUILT_CONFIRM_DISMISS_RESTORE_FOCUS", async () => {
      await filter(app, "needs_review").click();
      await action(rows(app).first(), "confirmed").focus(); await app.keyboard.press("Enter");
      await expect(rows(app)).toHaveCount(1); await expect(filter(app, "needs_review")).toBeFocused();
      await action(rows(app).first(), "dismissed").focus(); await app.keyboard.press("Enter");
      await expect(rows(app)).toHaveCount(0); await expect(filter(app, "needs_review")).toBeFocused();
      await filter(app, "dismissed").click(); await expect(rows(app)).toHaveCount(1);
      await action(rows(app).first(), "needs_review").focus(); await app.keyboard.press("Enter");
      await expect(rows(app)).toHaveCount(0); await expect(filter(app, "dismissed")).toBeFocused();
    });
    await check("BUILT_CONNECTED_AND_OTHER_CONTROL_FOCUS", async () => {
      await filter(app, "open").click();
      const row = rows(app).filter({ has: app.getByRole("heading", { name: "Example Shop Newsletter", exact: true }) });
      await action(row, "dismissed").focus();
      await action(row, "confirmed").evaluate((element) => element.click());
      await expect(rows(app)).toHaveCount(4); await expect(action(row, "dismissed")).toBeFocused();
      const homeLink = app.getByRole("link", { name: "기존 합성 목록 화면", exact: true });
      await filter(app, "confirmed").click(); await homeLink.focus();
      const before = await rows(app).count();
      await action(rows(app).first(), "dismissed").evaluate((element) => element.click());
      await expect(rows(app)).toHaveCount(before - 1); await expect(homeLink).toBeFocused();
    });
    await check("BUILT_NARROW_STORAGE_ASSETS_HOME", async () => {
      await app.setViewportSize({ width: 320, height: 900 }); await noOverflow(app);
      await filter(app, "open").click(); await noOverflow(app); await noStorage(app);
      assert.ok([...requestedAssets].some((name) => name.endsWith(".js")));
      assert.equal(sha(await readFile(new URL("../dist/index.html", import.meta.url))), appIndexSha256);
      await app.getByRole("link", { name: "기존 합성 목록 화면", exact: true }).click();
      await app.waitForURL(origin + "/"); await expect(home).toBeVisible();
      assert.ok(Object.values(counters).every((count) => count === 0));
    });
    builtAppRoute = "PASS";
  }
  stage = "FINAL_COUNTERS";
  assert.ok(Object.values(counters).every((count) => count === 0)); functionalChecksCompleted = true;
} catch (error) {
  primaryFailure = { stage, code: failureCode(error), groupsCompleted: groups.length };
} finally {
  // A failed/deadline cleanup never becomes PASS from later disconnect alone.
  // These calls concern this process's new resources only; no process kill API.
  if (context) await cleanup("CONTEXT_CLOSE", () => context.close(), 10_000);
  if (browser) await cleanup("BROWSER_CLOSE", () => browser.close(), 10_000);
  if (server) await cleanup("SERVER_CLOSE", () => new Promise((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
  }), 10_000);
  if (sockets.size > 0) await cleanup("SOCKET_CLOSE", () => Promise.all([...sockets].map((socket) => new Promise((resolve) => {
    socket.once("close", resolve); socket.destroy();
  }))), 5_000);
  let browserConnected = null, connectionProbeFailed = false;
  if (browser) { try { browserConnected = browser.isConnected(); } catch { connectionProbeFailed = true; } }
  const confirmed = !acquisitionTimedOut && !serverListenTimedOut && !connectionProbeFailed
    && (!browser || browserConnected === false) && cleanupSteps.every((step) => step.outcome === "RESOLVED")
    && (!server || !server.listening) && sockets.size === 0;
  const result = primaryFailure || !functionalChecksCompleted || !confirmed || Object.values(counters).some((count) => count !== 0) ? "FAIL" : "PASS";
  console.log(JSON.stringify({ result, startedAt, finishedAt: new Date().toISOString(), channel, browserVersion,
    groups: groups.length, passedGroups: groups, primaryFailure, counters, concurrency,
    fixtureEntrySha256, fixtureAssetsSha256, builtAppRoute, appIndexSha256, appAssetsSha256,
    builtAssetsRequested: requestedAssets.size, realSecretGate: "CLOSED",
    cleanup: { confirmed, acquisitionTimedOut, serverListenTimedOut, connectionProbeFailed, browserConnected,
      serverListening: server?.listening ?? false, ownedSocketsRemaining: sockets.size, steps: cleanupSteps },
    limits: ["synthetic current-product in-memory production React fixture; not development StrictMode effect replay",
      "optional existing dist is not rebuilt; served-byte hashes are not source-to-build attestation",
      "desktop viewports are not mobile OS, real vault, authentication or deployment verification",
      "request interception is not an OS network sandbox; no BFCache assertion is made",
      "deadlines bound waiting, not guaranteed cancellation or OS process-exit proof; this runner calls no process-kill API"] }));
  process.exitCode = result === "PASS" ? 0 : 1;
}
