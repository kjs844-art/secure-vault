// Current product React fixture; installed browser only, no credentials or downloads.
// node apps/web/scripts/verify-identity-map-browser.mjs --synthetic-only [--built-app] [--channel=chrome|msedge]
// --built-app additionally reads existing dist; it never builds that app.
// --preflight checks arguments only, without loading dependencies or starting resources.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createIdentityCloseObservation, IDENTITY_CLOSE_LIMIT_MS } from "./support/identity-close-observation.mjs";
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
let browserCloseObserver, browserCloseObservation = null, browserCloseStep = null;
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
      input: fileURLToPath(new URL("./fixtures/identity-map-fixture.tsx", import.meta.url)),
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
      if (appHtml !== null && ["/", "/?view=identity-map"].includes(request.url)) {
        response.setHeader("content-type", "text/html; charset=utf-8"); response.end(appHtml); return;
      }
      if (request.url === "/__identity_map__.html") {
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
  browserCloseObserver = createIdentityCloseObservation(browser);
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
  await withDeadline(() => page.goto(origin + "/__identity_map__.html"), 20_000);
  await page.waitForFunction(() => window.identityMapFixture?.ready());
  const left = page.locator("#left-panel"), right = page.locator("#right-panel");
  const accounts = (panel) => panel.getByTestId("identity-map-account"), issuers = (panel) => panel.getByTestId("identity-map-issuer");
  const usages = (panel) => panel.getByTestId("identity-map-usages"), step = (panel, name) => panel.getByTestId(`identity-map-step-${name}`);
  const status = (panel) => panel.getByTestId("identity-map-status"), back = (panel) => panel.getByTestId("identity-map-back");
  const reset = (panel) => panel.getByTestId("identity-map-reset");
  const openUsage = async (panel) => { await accounts(panel).first().click(); await issuers(panel).first().click(); };
  const noOverflow = async (target) => assert.equal(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const noStorage = async (target) => {
    assert.equal(await target.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(await target.evaluate(async () => (await indexedDB.databases()).length), 0);
  };
  const aria = async () => {
    const observed = await page.evaluate(() => {
      const roots = [...document.querySelectorAll("[data-testid='identity-map-root']")];
      const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
      return { count: roots.length, unique: new Set(ids).size === ids.length, local: roots.every((root) =>
        [root, ...root.querySelectorAll("[aria-labelledby]")].every((section) => {
          const references = section.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
          return references.length === 1 && references.every((id) => {
            const target = document.getElementById(id);
            return target !== null && root.contains(target) && /^H[1-6]$/.test(target.tagName);
          });
        })) };
    });
    assert.deepEqual(observed, { count: 2, unique: true, local: true });
  };
  await check("FIXTURE_UNIQUE_LOCAL_ARIA", async () => {
    await expect(accounts(left)).toHaveCount(3); await expect(accounts(right)).toHaveCount(3); await aria();
  });
  await check("FIXTURE_NATIVE_KEYBOARD_FOCUS", async () => {
    await accounts(left).first().focus(); await page.keyboard.press("Enter");
    await expect(issuers(left)).toHaveCount(2); await expect(step(left, "issuer")).toBeFocused();
    await issuers(left).first().focus(); await page.keyboard.press("Enter");
    await expect(usages(left).locator("li")).toHaveCount(2); await expect(step(left, "usage")).toBeFocused();
    await expect(status(right)).toHaveText("계정 3곳"); await aria();
    await reset(left).focus(); await page.keyboard.press("Enter"); await expect(step(left, "account")).toBeFocused();
  });
  await check("FIXTURE_PROGRAMMATIC_AND_LABEL_FOCUS", async () => {
    await page.locator("#outside").focus();
    await accounts(left).first().evaluate((element) => element.click()); await expect(issuers(left)).toHaveCount(2);
    await expect(page.locator("#outside")).toBeFocused();
    await issuers(left).first().evaluate((element) => element.click()); await expect(usages(left)).toBeVisible();
    await expect(page.locator("#outside")).toBeFocused();
    await back(left).focus(); await page.locator("#source-label").evaluate((element) => element.click());
    await expect(left).toContainText("Synthetic label changed"); await expect(back(left)).toBeFocused(); await expect(usages(left)).toBeVisible();
  });
  await check("FIXTURE_PANEL_LOCAL_ESCAPE", async () => {
    await openUsage(right); await back(left).focus(); await page.keyboard.press("Escape");
    await expect(issuers(left)).toHaveCount(2); await expect(usages(right)).toBeVisible();
    await page.keyboard.press("Escape"); await expect(accounts(left)).toHaveCount(3); await expect(step(left, "account")).toBeFocused();
    await page.locator("#outside").focus(); await page.keyboard.press("Escape");
    await expect(accounts(left)).toHaveCount(3); await expect(usages(right)).toBeVisible();
    await back(right).focus(); await page.keyboard.press("Escape");
    await expect(issuers(right)).toHaveCount(2); await expect(accounts(left)).toHaveCount(3);
  });
  await check("FIXTURE_REPLACEMENT_AND_EMPTY", async () => {
    await openUsage(left); await page.locator("#source-b").click(); await expect(accounts(left)).toHaveCount(3);
    await expect(accounts(left).first()).toContainText("Replacement Example AI Workshop"); await expect(page.locator("#source-b")).toBeFocused();
    await openUsage(left); await expect(status(left)).toContainText("Replacement Workshop API Credential");
    await page.locator("#source-a").click(); await expect(accounts(left)).toHaveCount(3); await openUsage(left);
    await expect(status(left)).toHaveText("Workshop API Credential · 사용처 2곳");
    await reset(left).click(); await accounts(left).first().focus(); await page.locator("#source-empty").evaluate((element) => element.click());
    await expect(left.getByTestId("identity-map-empty")).toBeVisible();
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    await page.locator("#source-a").click(); await expect(accounts(left)).toHaveCount(3); await openUsage(left); await expect(usages(left)).toBeVisible();
  });
  const transition = page.locator("#transition-pending"), committed = page.locator("#committed-source");
  let beforeSuspension, afterDiscard, afterCommittedB;
  await check("FIXTURE_SUSPENDED_RENDER_DISCARDED", async () => {
    beforeSuspension = await page.evaluate(() => window.identityMapFixture.stats());
    await page.locator("#suspend-b").click();
    await page.waitForFunction((attempts) => window.identityMapFixture.stats().suspendedAttempts > attempts, beforeSuspension.suspendedAttempts);
    await expect(transition).toHaveText("pending"); await expect(committed).toHaveText("A"); await expect(page.locator("#transition-fallback")).toHaveCount(0);
    await expect(status(left)).toHaveText("Workshop API Credential · 사용처 2곳"); await expect(left).not.toContainText("Replacement");
    await expect(page.locator("#urgent-probe")).toHaveText("0"); await page.locator("#urgent-probe").click(); await expect(page.locator("#urgent-probe")).toHaveText("1");
    await expect(committed).toHaveText("A"); await expect(transition).toHaveText("pending");
    await reset(left).focus(); await page.keyboard.press("Enter"); await expect(accounts(left)).toHaveCount(3); await expect(step(left, "account")).toBeFocused();
    await accounts(left).first().focus(); await page.keyboard.press("Enter"); await expect(issuers(left)).toHaveCount(2); await expect(step(left, "issuer")).toBeFocused();
    await issuers(left).first().focus(); await page.keyboard.press("Enter"); await expect(step(left, "usage")).toBeFocused(); await expect(transition).toHaveText("pending");
    await page.locator("#cancel-b").evaluate((element) => element.click());
    await expect(transition).toHaveText("idle"); await expect(committed).toHaveText("A");
    await expect(status(left)).toHaveText("Workshop API Credential · 사용처 2곳"); await expect(step(left, "usage")).toBeFocused();
    await page.locator("#release-b").evaluate((element) => element.click());
    await page.waitForFunction((released) => window.identityMapFixture.stats().releasedGates > released, beforeSuspension.releasedGates);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(transition).toHaveText("idle"); await expect(committed).toHaveText("A");
    await expect(status(left)).toHaveText("Workshop API Credential · 사용처 2곳"); await expect(step(left, "usage")).toBeFocused();
    afterDiscard = await page.evaluate(() => window.identityMapFixture.stats());
    assert.ok(afterDiscard.commits.length > beforeSuspension.commits.length);
    assert.ok(afterDiscard.commits.slice(beforeSuspension.commits.length).every(({ source }) => source === "A"));
  });
  await check("FIXTURE_FRESH_SUSPENDED_RENDER_COMMITTED", async () => {
    await page.locator("#suspend-b").click();
    await page.waitForFunction((attempts) => window.identityMapFixture.stats().suspendedAttempts > attempts, afterDiscard.suspendedAttempts);
    await expect(transition).toHaveText("pending"); await expect(committed).toHaveText("A"); await expect(usages(left)).toBeVisible();
    await page.locator("#release-b").click(); await expect(transition).toHaveText("idle"); await expect(committed).toHaveText("B");
    await expect(accounts(left)).toHaveCount(3); await expect(issuers(left)).toHaveCount(0); await expect(usages(left)).toHaveCount(0);
    await expect(accounts(left).first()).toContainText("Replacement Example AI Workshop");
    await accounts(left).first().focus(); await page.keyboard.press("Enter"); await expect(issuers(left)).toHaveCount(2); await expect(step(left, "issuer")).toBeFocused();
    await issuers(left).first().focus(); await page.keyboard.press("Enter");
    await expect(status(left)).toHaveText("Replacement Workshop API Credential · 사용처 2곳"); await expect(step(left, "usage")).toBeFocused();
    afterCommittedB = await page.evaluate(() => window.identityMapFixture.stats());
    assert.ok(afterCommittedB.commits.slice(afterDiscard.commits.length).some(({ source }) => source === "B"));
    concurrency = {
      suspendedAttempts: afterCommittedB.suspendedAttempts - beforeSuspension.suspendedAttempts,
      releasedGates: afterCommittedB.releasedGates - beforeSuspension.releasedGates,
      discardedBCommits: afterDiscard.commits.slice(beforeSuspension.commits.length).filter(({ source }) => source === "B").length,
      freshBCommits: afterCommittedB.commits.slice(afterDiscard.commits.length).filter(({ source }) => source === "B").length,
    };
  });
  await check("FIXTURE_MISSING_AND_EMPTY_DISTINCT", async () => {
    await page.locator("#source-missing-empty").click(); await expect(accounts(left)).toHaveCount(2);
    assert.deepEqual(await accounts(left).locator("span").allTextContents(), ["기록 없음", "빈 값으로 기록됨"]);
    for (const [index, label] of ["Synthetic missing issuer", "Synthetic empty issuer"].entries()) {
      await accounts(left).nth(index).click(); await expect(issuers(left)).toHaveCount(1); await expect(issuers(left)).toContainText(label);
      await issuers(left).click(); await expect(usages(left)).toContainText(`${label} MCP`); await reset(left).click();
    }
  });
  await check("FIXTURE_DELIMITER_PAIRS_DISTINCT", async () => {
    await page.locator("#source-delimiter").click(); await expect(accounts(left)).toHaveCount(2);
    assert.deepEqual(await accounts(left).locator("strong").allTextContents(), ["Example\0Provider", "Example"]);
    assert.deepEqual(await accounts(left).locator("span").allTextContents(), ["demo", "Provider\0demo"]);
    for (const [index, label] of ["Synthetic first issuer", "Synthetic second issuer"].entries()) {
      await accounts(left).nth(index).click(); await expect(issuers(left)).toHaveCount(1); await expect(issuers(left)).toContainText(label);
      await issuers(left).click(); await expect(usages(left)).toContainText(`${label} MCP`); await reset(left).click();
    }
  });
  await check("FIXTURE_UNMOUNT_REMOUNT_ISOLATION", async () => {
    await page.locator("#source-a").click(); await openUsage(left); const rightBefore = await status(right).innerText();
    await page.locator("#unmount-left").click(); await expect(left.getByTestId("identity-map-root")).toHaveCount(0); await expect(status(right)).toHaveText(rightBefore);
    await page.locator("#mount-left").click(); await expect(accounts(left)).toHaveCount(3); await expect(status(right)).toHaveText(rightBefore); await aria();
  });
  await check("FIXTURE_NARROW_STEPS_AND_NO_STORAGE", async () => {
    await reset(right).click();
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 900 }); await noOverflow(page);
      await accounts(left).first().click(); await expect(issuers(left)).toHaveCount(2); await noOverflow(page);
      await issuers(left).first().click(); await expect(usages(left)).toBeVisible(); await noOverflow(page); await reset(left).click();
    }
    await noStorage(page);
  });
  if (builtApp) {
    stage = "BUILT_PAGE_CREATE";
    const app = await acquire(() => context.newPage(), (value) => value.close());
    const home = app.getByRole("heading", { name: "내 자격 증명이 어디에 연결됐는지 한눈에", exact: true });
    const nativeUsage = async () => {
      await accounts(app).first().focus(); await app.keyboard.press("Enter"); await expect(issuers(app)).toHaveCount(2); await expect(step(app, "issuer")).toBeFocused();
      await issuers(app).first().focus(); await app.keyboard.press("Enter"); await expect(usages(app).locator("li")).toHaveCount(2); await expect(step(app, "usage")).toBeFocused();
    };
    await check("BUILT_HOME_ROUTE_AND_CLOSED_GATE", async () => {
      await app.goto(origin + "/"); await expect(home).toBeVisible();
      await app.getByRole("link", { name: "Identity Map 3단계 탐색 →", exact: true }).click(); await app.waitForURL(origin + "/?view=identity-map");
      await expect(accounts(app)).toHaveCount(3); await expect(app.getByTestId("identity-map-root")).toContainText("REAL_SECRET_GATE=CLOSED");
      await expect(app.getByRole("heading", { level: 1, name: "계정 · 발급처 · 사용처를 세 단계로 보기" })).toBeVisible();
    });
    await check("BUILT_NATIVE_KEYBOARD_ESCAPE_RESET", async () => {
      await nativeUsage(); await back(app).focus(); await app.keyboard.press("Escape"); await expect(issuers(app)).toHaveCount(2);
      await app.keyboard.press("Escape"); await expect(accounts(app)).toHaveCount(3); await expect(step(app, "account")).toBeFocused();
      await nativeUsage(); await reset(app).focus(); await app.keyboard.press("Enter"); await expect(accounts(app)).toHaveCount(3); await expect(step(app, "account")).toBeFocused();
    });
    await check("BUILT_NARROW_AND_HOME_RETURN", async () => {
      await app.setViewportSize({ width: 320, height: 900 }); await noOverflow(app);
      await accounts(app).first().click(); await expect(issuers(app)).toHaveCount(2); await noOverflow(app);
      await issuers(app).first().click(); await expect(usages(app).locator("li")).toHaveCount(2); await noOverflow(app);
      await reset(app).click(); await expect(accounts(app)).toHaveCount(3);
      await app.getByRole("link", { name: "기존 합성 목록 화면", exact: true }).click(); await app.waitForURL(origin + "/"); await expect(home).toBeVisible();
    });
    await check("BUILT_ASSETS_NO_STORAGE_UNCHANGED_INDEX", async () => {
      await noStorage(app); assert.ok([...requestedAssets].some((name) => name.endsWith(".js")));
      assert.equal(sha(await readFile(new URL("../dist/index.html", import.meta.url))), appIndexSha256);
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
  browserCloseObserver?.setPhase("CONTEXT_CLOSE");
  if (context) await cleanup("CONTEXT_CLOSE", () => context.close(), 10_000);
  if (browser) {
    browserCloseObserver ??= createIdentityCloseObservation(browser);
    try {
      const outcome = await browserCloseObserver.close(), boundary = browserCloseObserver.snapshot();
      browserCloseStep = { name: "BROWSER_CLOSE", outcome: outcome === "DEADLINE" ? "DEADLINE"
        : outcome === "RESOLVED" && boundary.passed ? "RESOLVED" : "REJECTED", timeoutMs: IDENTITY_CLOSE_LIMIT_MS };
    } catch {
      browserCloseStep = { name: "BROWSER_CLOSE", outcome: "REJECTED", timeoutMs: IDENTITY_CLOSE_LIMIT_MS };
    }
    cleanupSteps.push(browserCloseStep);
  }
  browserCloseObserver?.setPhase("SERVER_CLOSE");
  if (server) await cleanup("SERVER_CLOSE", () => new Promise((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
  }), 10_000);
  if (sockets.size > 0) await cleanup("SOCKET_CLOSE", () => Promise.all([...sockets].map((socket) => new Promise((resolve) => {
    socket.once("close", resolve); socket.destroy();
  }))), 5_000);
  if (browserCloseObserver) {
    browserCloseObserver.setPhase("FINAL");
    browserCloseObserver.dispose();
    browserCloseObservation = browserCloseObserver.snapshot();
    if (!browserCloseObservation.passed && browserCloseStep?.outcome === "RESOLVED") browserCloseStep.outcome = "REJECTED";
  }
  let browserConnected = null, connectionProbeFailed = false;
  if (browser) { try { browserConnected = browser.isConnected(); } catch { connectionProbeFailed = true; } }
  const confirmed = !acquisitionTimedOut && !serverListenTimedOut && !connectionProbeFailed
    && (!browser || (browserConnected === false && browserCloseObservation?.passed === true))
    && cleanupSteps.every((step) => step.outcome === "RESOLVED")
    && (!server || !server.listening) && sockets.size === 0;
  const result = primaryFailure || !functionalChecksCompleted || !confirmed || Object.values(counters).some((count) => count !== 0) ? "FAIL" : "PASS";
  console.log(JSON.stringify({ result, startedAt, finishedAt: new Date().toISOString(), channel, browserVersion,
    groups: groups.length, passedGroups: groups, primaryFailure, counters, concurrency,
    fixtureEntrySha256, fixtureAssetsSha256, builtAppRoute, appIndexSha256, appAssetsSha256,
    builtAssetsRequested: requestedAssets.size, realSecretGate: "CLOSED", browserCloseObservation,
    cleanup: { confirmed, acquisitionTimedOut, serverListenTimedOut, connectionProbeFailed, browserConnected,
      serverListening: server?.listening ?? false, ownedSocketsRemaining: sockets.size, steps: cleanupSteps },
    limits: ["synthetic current-product in-memory production React fixture; not development StrictMode effect replay",
      "optional existing dist is not rebuilt; served-byte hashes are not source-to-build attestation",
      "desktop viewports are not mobile OS, real vault, authentication or deployment verification",
      "request interception is not an OS network sandbox; no BFCache assertion is made",
      "deadlines bound waiting, not guaranteed cancellation or OS process-exit proof; this runner calls no process-kill API"] }));
  process.exitCode = result === "PASS" ? 0 : 1;
}
