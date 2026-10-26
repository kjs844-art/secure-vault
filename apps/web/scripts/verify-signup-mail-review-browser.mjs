// Installed Chrome/Edge, synthetic fixtures only; no provider activation or installs.
// node apps/web/scripts/verify-signup-mail-review-browser.mjs --synthetic-only [--built-app] [--channel=chrome|msedge]
// --preflight validates arguments only: no dependency load, bundle, server or browser.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { acquireOwned, withDeadline } from "../tests/mvp-browser/qa-lifecycle.mjs";

const arguments_ = process.argv.slice(2);
const channelArguments = arguments_.filter((value) => value.startsWith("--channel="));
const validArguments = arguments_.includes("--synthetic-only")
  && new Set(arguments_).size === arguments_.length
  && channelArguments.length <= 1
  && arguments_.every((value) => ["--synthetic-only", "--built-app", "--preflight", "--channel=chrome", "--channel=msedge"].includes(value));
if (!validArguments) {
  console.log(JSON.stringify({ result: "BLOCKED", code: "SYNTHETIC_ARGUMENTS_REQUIRED" }));
  process.exit(2);
}
const channel = channelArguments.length === 0 ? "chrome" : channelArguments[0].slice("--channel=".length);
const builtApp = arguments_.includes("--built-app");
if (arguments_.includes("--preflight")) {
  console.log(JSON.stringify({ result: "PREFLIGHT_ONLY", channel, builtApp, browserStarted: false,
    limits: "argument validation only; dependency, build and browser availability not checked" }));
  process.exit(0);
}
const startedAt = new Date().toISOString();
const passed = [], inconclusiveCodes = [], cleanupSteps = [];
const counters = { pageErrors: 0, consoleErrors: 0, externalRequests: 0, httpErrors: 0, failedRequests: 0, deniedRequests: 0, serverErrors: 0 };
const ownedSockets = new Set();
const pass = (name) => { passed.push(name); };
let browser, context, server, origin, browserVersion = null, appIndexSha256 = null;
let builtAppBfcache = "NOT_RUN", builtAppRoute = "NOT_RUN", stage = "DEPENDENCIES";
let primaryFailure = null, acquisitionTimedOut = false, functionalChecksCompleted = false;

function browserEnvironment() {
  const env = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "Path", "LANG", "TZ"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
async function acquire(factory, dispose) {
  try { return await acquireOwned(factory, dispose, 30000); }
  catch (error) {
    if (error instanceof Error && error.message === "QA_DEADLINE") acquisitionTimedOut = true;
    throw error;
  }
}
async function cleanup(name, operation, timeoutMs) {
  try {
    await withDeadline(operation, timeoutMs);
    cleanupSteps.push({ name, outcome: "RESOLVED", timeoutMs });
  } catch (error) {
    // Deadline is sticky even if the close operation resolves/disconnects later.
    cleanupSteps.push({ name, outcome: error instanceof Error && error.message === "QA_DEADLINE" ? "DEADLINE" : "REJECTED", timeoutMs });
  }
}
try {
  const requireLanding = createRequire(new URL("../../landing/package.json", import.meta.url));
  const { chromium } = requireLanding("playwright");
  const { expect } = requireLanding("playwright/test");
  const { build } = await import("vite");
  const webRoot = fileURLToPath(new URL("../", import.meta.url));
  stage = "FIXTURE_BUILD";
  // Fixture-only in-memory build. No WebSocket routing or intercepted requests:
  // those would alter the existing native back/forward-cache observation.
  const bundle = await build({ root: webRoot, configFile: false, envDir: false, envPrefix: [], logLevel: "silent",
    esbuild: { jsx: "automatic" },
    build: { write: false, emptyOutDir: false, rollupOptions: {
      input: fileURLToPath(new URL("./fixtures/signup-mail-review-fixture.tsx", import.meta.url)),
      output: { entryFileNames: "fixture.js" },
    } },
  });
  assert.ok(!Array.isArray(bundle) && "output" in bundle);
  const assets = new Map(bundle.output.map((asset) => [`/${asset.fileName}`,
    { body: asset.type === "chunk" ? asset.code : asset.source,
      type: asset.fileName.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" }]));
  const css = bundle.output.filter((asset) => asset.fileName.endsWith(".css"))
    .map((asset) => `<link rel="stylesheet" href="/${asset.fileName}">`).join("");
  let appHtml = null;
  if (builtApp) {
    // Read only the current checkout's existing build, never launch a user's profile.
    appHtml = await readFile(new URL("../dist/index.html", import.meta.url));
    appIndexSha256 = createHash("sha256").update(appHtml).digest("hex");
    for (const entry of await readdir(new URL("../dist/assets/", import.meta.url), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      assets.set(`/assets/${entry.name}`, {
        body: await readFile(new URL(`../dist/assets/${entry.name}`, import.meta.url)),
        type: entry.name.endsWith(".css") ? "text/css; charset=utf-8"
          : entry.name.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8",
      });
    }
  }
  stage = "SERVER_CREATE";
  server = createServer((request, response) => {
    if (!origin || request.headers.host !== new URL(origin).host) { counters.deniedRequests++; response.writeHead(403); response.end(); return; }
    if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
    const path = request.url;
    response.setHeader("cache-control", "max-age=0");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; form-action 'none'; base-uri 'none'");
    if (appHtml !== null && (path === "/" || path === "/?view=signup-mail-discovery")) {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(appHtml);
    } else if (path === "/__signup_review__.html") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,">${css}</head><body style="margin:0"><div id="fixture-root"></div><a id="leave" href="/__signup_away__.html">Leave synthetic fixture</a><script type="module" src="/fixture.js"></script></body></html>`);
    } else if (path === "/__signup_away__.html") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end('<!doctype html><html lang="ko"><head><link rel="icon" href="data:,"></head><body><h1>Away from synthetic discovery</h1></body></html>');
    } else if (assets.has(path)) {
      const asset = assets.get(path);
      response.setHeader("content-type", asset.type);
      response.end(asset.body);
    } else { response.writeHead(404); response.end(); }
  });
  server.on("connection", (socket) => {
    ownedSockets.add(socket);
    socket.once("close", () => ownedSockets.delete(socket));
  });
  server.on("error", () => { counters.serverErrors++; });

  const httpServer = server;
  stage = "SERVER_LISTEN";
  await withDeadline(() => new Promise((resolve, reject) => {
    const onError = (error) => { httpServer.off("listening", onListening); reject(error); };
    const onListening = () => { httpServer.off("error", onError); resolve(); };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(0, "127.0.0.1");
  }), 15000);
  const address = httpServer.address();
  assert.ok(address && typeof address === "object" && address.address === "127.0.0.1");
  origin = `http://127.0.0.1:${address.port}`;
  stage = "BROWSER_LAUNCH";
  browser = await acquire(() => chromium.launch({ channel, headless: true, timeout: 30000,
    env: browserEnvironment(), ignoreDefaultArgs: ["--disable-back-forward-cache"] }), (value) => value.close());
  const version = browser.version();
  assert.match(version, /^\d+(?:\.\d+){1,3}$/);
  browserVersion = version;
  stage = "CONTEXT_CREATE";
  context = await acquire(() => browser.newContext({ serviceWorkers: "block", acceptDownloads: false,
    locale: "ko-KR", timezoneId: "Asia/Seoul" }), (value) => value.close());
  stage = "FUNCTIONAL_CHECKS";
  function observe(page) {
    page.setDefaultTimeout(10_000);
    page.on("pageerror", () => { counters.pageErrors++; });
    page.on("console", (message) => { if (message.type() === "error") counters.consoleErrors++; });
    page.on("request", (request) => {
      try { if (new URL(request.url()).origin !== origin) counters.externalRequests++; }
      catch { counters.externalRequests++; }
    });
    page.on("response", (response) => { if (response.status() >= 400) counters.httpErrors++; });
    page.on("requestfailed", () => { counters.failedRequests++; });
  }
  const page = await context.newPage();
  observe(page);
  // No interception or clock mock on this page: do not invalidate bfcache proof.
  await page.goto(`${origin}/__signup_review__.html`);
  await page.waitForFunction(() => window.signupReviewHarness?.ready());
  const preview = (target = page) => target.getByRole("button", { name: "탐색 범위 미리보기", exact: true });
  const consent = (target = page) => target.getByRole("button", { name: "선택한 범위에 동의하고 탐색", exact: true });
  const rows = (target = page) => target.getByTestId("discovery-inbox-item");
  const filter = (name, target = page) => target.getByTestId(`discovery-filter-${name}`);
  const reset = (target = page) => target.getByRole("button", { name: "범위 다시 선택", exact: true });
  const scan = async (target = page) => { await preview(target).click(); await consent(target).click(); };
  const noRaw = async (target = page) => {
    const text = await target.locator("body").innerText();
    for (const value of ["synthetic-only-private-canary", "Welcome to Aurora", "accounts.aurora.invalid"]) {
      assert.equal(text.includes(value), false);
    }
    assert.equal(await target.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(await target.evaluate(async () => (await indexedDB.databases()).length), 0);
  };
  await expect(rows()).toHaveCount(0);
  await page.getByLabel("Cedar 예제", { exact: true }).uncheck();
  await page.getByLabel("Harbor 예제", { exact: true }).uncheck();
  await preview().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "이 범위로 탐색할까요?" })).toBeFocused();
  await expect(rows()).toHaveCount(0);
  await expect(page.locator(".signup-mail-card")).toContainText("Aurora 예제");
  await expect(page.locator(".signup-mail-card")).not.toContainText("Cedar 예제");
  await page.getByRole("button", { name: "탐색 취소", exact: true }).click();
  await expect(consent()).toHaveCount(0);
  await expect(page.getByText("탐색을 취소하고 후보를 지웠습니다.", { exact: true })).toBeFocused();
  pass("explicit selected scope, keyboard preview and cancel before consent");

  await reset().click();
  await scan();
  await expect(rows()).toHaveCount(1);
  await expect(rows()).toContainText("Aurora 예제");
  await expect(filter("inferred")).toHaveCount(0);
  await filter("needs_review").click();
  await rows().getByTestId("discovery-action-confirmed").focus();
  await page.keyboard.press("Enter");
  await expect(rows()).toHaveCount(0);
  await expect(filter("needs_review")).toBeFocused();
  await filter("confirmed").click();
  await expect(rows()).toHaveCount(1);
  await rows().getByTestId("discovery-action-dismissed").click();
  await expect(rows()).toHaveCount(0);
  await filter("dismissed").click();
  await expect(rows()).toHaveCount(1);
  await rows().getByTestId("discovery-action-needs_review").focus();
  await page.keyboard.press("Enter");
  await expect(rows()).toHaveCount(0);
  await expect(filter("dismissed")).toBeFocused();
  await filter("open").click();
  await expect(rows().locator(".discovery-confidence")).toHaveText("확인 필요");
  pass("same-session confirm/dismiss/reopen, filters and keyboard focus");

  await noRaw();
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px overflow`);
  }
  pass("coarse evidence only, no persisted browser data and 360/320px no horizontal overflow");

  await rows().getByTestId("discovery-action-confirmed").click();
  await filter("confirmed").click();
  await page.getByRole("button", { name: "후보 지우기", exact: true }).click();
  await expect(rows()).toHaveCount(0);
  await expect(filter("confirmed")).toHaveCount(0);
  await reset().click();
  await scan();
  await expect(filter("confirmed")).toHaveText("확인됨 0");
  await expect(filter("needs_review")).toHaveText("확인 필요 1");
  pass("explicit clear/reset requires fresh consent and clears classifications");

  for (const state of ["review", "pending-consent"]) {
    if (state === "pending-consent") { await reset().click(); await preview().click(); }
    else { await rows().getByTestId("discovery-action-confirmed").click(); await filter("confirmed").click(); }
    const before = await page.evaluate(() => window.signupReviewHarness.stats());
    await page.locator("#leave").click();
    await page.waitForURL(`${origin}/__signup_away__.html`);
    await page.goBack({ waitUntil: "commit" });
    await page.waitForFunction(() => window.signupReviewHarness?.ready());
    await expect(preview()).toBeVisible();
    await expect(rows()).toHaveCount(0);
    await expect(consent()).toHaveCount(0);
    const after = await page.evaluate(() => window.signupReviewHarness.stats());
    const events = after.events.slice(before.events.length);
    if (before.marker !== after.marker || !events.some((event) => event.type === "pageshow" && event.trusted && event.persisted)) {
      inconclusiveCodes.push(state === "review" ? "FIXTURE_REVIEW_BFCACHE_NOT_OBSERVED" : "FIXTURE_CONSENT_BFCACHE_NOT_OBSERVED");
    } else {
      assert.ok(events.some((event) => event.type === "pagehide" && event.trusted && event.persisted && event.empty));
      assert.ok(events.filter((event) => event.type === "pageshow").every((event) => event.empty));
      pass(`${state}: real same-document persisted bfcache has empty event-time DOM, no old consent/results`);
    }
    await scan();
    await expect(filter("confirmed")).toHaveText("확인됨 0");
  }

  await rows().getByTestId("discovery-action-confirmed").click();
  await page.evaluate(() => window.signupReviewHarness.unmount());
  await expect(page.locator("#fixture-root")).toHaveText("");
  await page.evaluate(() => window.signupReviewHarness.mount());
  await page.waitForFunction(() => window.signupReviewHarness.ready());
  await expect(preview()).toBeVisible();
  await expect(rows()).toHaveCount(0);
  await scan();
  await expect(filter("confirmed")).toHaveText("확인됨 0");
  await page.reload();
  await expect(preview()).toBeVisible();
  await expect(rows()).toHaveCount(0);
  await expect(consent()).toHaveCount(0);
  pass("unmount/remount and reload do not recover old consent or classifications");

  const timed = await context.newPage();
  observe(timed);
  await timed.clock.install();
  await timed.goto(`${origin}/__signup_review__.html`);
  await timed.waitForFunction(() => window.signupReviewHarness?.ready());
  await scan(timed);
  await expect(rows(timed)).toHaveCount(2);
  await timed.clock.fastForward(298_000);
  await rows(timed).first().getByTestId("discovery-action-confirmed").click();
  await filter("confirmed", timed).click();
  await rows(timed).getByTestId("discovery-action-needs_review").focus();
  await timed.clock.fastForward(3_001);
  const expired = timed.getByText("확인 시간이 만료되어 후보를 지웠습니다. 범위를 다시 선택해 주세요.", { exact: true });
  await expect(expired).toBeVisible();
  await expect(expired).toBeFocused();
  await expect(rows(timed)).toHaveCount(0);
  await expect(filter("confirmed", timed)).toHaveCount(0);
  await reset(timed).focus();
  await timed.clock.fastForward(2_000);
  await expect(reset(timed)).toBeFocused();
  await reset(timed).click();
  await preview(timed).click();
  await consent(timed).focus();
  await timed.clock.fastForward(300_001);
  await expect(expired).toBeFocused();
  await expect(consent(timed)).toHaveCount(0);
  pass("original five-minute TTL survives classification/filter activity; result and pending-consent expiry clear focus safely");
  await noRaw(timed);
  await noRaw(page);
  if (builtApp) {
    const app = await context.newPage();
    observe(app);
    await app.goto(origin + "/");
    await app.getByRole("link", { name: "합성 메일 범위 선택 · 동의 · 후보 검토 →", exact: true }).click();
    await app.waitForURL(origin + "/?view=signup-mail-discovery");
    await expect(rows(app)).toHaveCount(0);
    await expect(consent(app)).toHaveCount(0);
    await scan(app);
    await expect(rows(app)).toHaveCount(2);
    await rows(app).first().getByTestId("discovery-action-confirmed").click();
    await filter("confirmed", app).click();
    await expect(rows(app)).toHaveCount(1);
    await noRaw(app);
    await app.getByRole("button", { name: "후보 지우기", exact: true }).click();
    await expect(rows(app)).toHaveCount(0);
    pass("built app home link enters the synthetic route; fresh consent, review and clear work without provider/storage");
    // Read-only event observers installed after product effects, not a synthetic
    // pageshow, init script, clock mock or interception. A full reload loses this
    // marker and must be reported as INCONCLUSIVE rather than bfcache success.
    await app.evaluate(() => {
      const events = [];
      const empty = () => document.querySelector("[data-testid='discovery-inbox-item']") === null
        && document.querySelector(".signup-mail-card") === null
        && document.querySelector("[data-testid='discovery-filter-confirmed']") === null;
      const marker = `${Date.now()}-${Math.random()}`;
      const observeEvent = (event) => events.push({
        type: event.type, trusted: event.isTrusted, persisted: event.persisted, empty: empty(),
      });
      window.addEventListener("pagehide", observeEvent);
      window.addEventListener("pageshow", observeEvent);
      window.builtSignupReviewProbe = { stats: () => ({ marker, events: [...events], empty: empty() }) };
    });
    builtAppBfcache = "PASS";
    for (const state of ["review", "pending-consent"]) {
      await reset(app).click();
      await preview(app).click();
      if (state === "review") {
        await consent(app).click();
        await expect(rows(app)).toHaveCount(2);
        await rows(app).first().getByTestId("discovery-action-confirmed").click();
        await filter("confirmed", app).click();
        await expect(rows(app)).toHaveCount(1);
      } else {
        await expect(consent(app)).toBeVisible();
        await expect(rows(app)).toHaveCount(0);
      }
      const before = await app.evaluate(() => window.builtSignupReviewProbe?.stats() ?? null);
      assert.ok(before, "built app event observer must exist before navigation");
      assert.equal(before.empty, false, "native restoration must start with real pending consent or review DOM");
      // Exercise the product's own return link, without altering its HTML.
      await app.getByRole("link", { name: "합성 체험 목록으로", exact: true }).click();
      await app.waitForURL(origin + "/");
      await app.goBack({ waitUntil: "commit" });
      // A bfcache restore need not fire a fresh load event. Check the committed
      // URL independently instead of waiting for another document load.
      await expect(app).toHaveURL(origin + "/?view=signup-mail-discovery");
      await expect(preview(app)).toBeVisible();
      await expect(rows(app)).toHaveCount(0);
      await expect(consent(app)).toHaveCount(0);
      const after = await app.evaluate(() => window.builtSignupReviewProbe?.stats() ?? null);
      const events = before && after ? after.events.slice(before.events.length) : [];
      if (!before || !after || before.marker !== after.marker
        || !events.some((event) => event.type === "pageshow" && event.trusted && event.persisted)) {
        inconclusiveCodes.push(state === "review" ? "BUILT_REVIEW_BFCACHE_NOT_OBSERVED" : "BUILT_CONSENT_BFCACHE_NOT_OBSERVED");
        builtAppBfcache = "INCONCLUSIVE";
        await noRaw(app);
        break;
      } else {
        assert.deepEqual(events.map((event) => event.type), ["pagehide", "pageshow"]);
        assert.ok(events.every((event) => event.trusted && event.persisted && event.empty));
        pass(`built app ${state}: native same-document bfcache clears event-time DOM and requires new consent`);
      }
      await scan(app);
      await expect(filter("confirmed", app)).toHaveText("확인됨 0");
      await expect(filter("needs_review", app)).toHaveText("확인 필요 2");
      await noRaw(app);
    }
  }
  builtAppRoute = builtApp ? "PASS" : "NOT_RUN";
  functionalChecksCompleted = true;
  assert.ok(Object.values(counters).every((value) => value === 0));
} catch {
  // Never serialize exception values, assertion diffs, URLs, bodies or stacks.
  primaryFailure = { code: "CHECK_FAILED", stage, groupsCompleted: passed.length };
} finally {
  // Close only resources created by this process. Deadlines bound waiting, not
  // underlying operations; unconfirmed cleanup remains FAIL, without force kill.
  if (context) await cleanup("CONTEXT_CLOSE", () => context.close(), 15000);
  if (browser) await cleanup("BROWSER_CLOSE", () => browser.close(), 15000);
  if (server) await cleanup("SERVER_CLOSE", () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    // These are this loopback server's connections only, never user sockets.
    server.closeAllConnections();
    for (const socket of ownedSockets) socket.destroy();
  }), 15000);
  if (ownedSockets.size > 0) await cleanup("SOCKET_CLOSE", () => Promise.all(
    [...ownedSockets].map((socket) => new Promise((resolve) => {
      socket.once("close", resolve);
      socket.destroy();
    })),
  ), 5000);
  let browserConnected = null, connectionProbeFailed = false;
  if (browser) {
    try { browserConnected = browser.isConnected(); }
    catch { connectionProbeFailed = true; }
  }
  const cleanupConfirmed = !acquisitionTimedOut && !connectionProbeFailed
    && (browser === undefined || browserConnected === false)
    && cleanupSteps.every((step) => step.outcome === "RESOLVED")
    && (server === undefined || server.listening === false) && ownedSockets.size === 0;
  const observedErrors = Object.values(counters).some((value) => value !== 0);
  const result = primaryFailure || observedErrors || !cleanupConfirmed ? "FAIL"
    : !functionalChecksCompleted ? "FAIL" : inconclusiveCodes.length > 0 ? "INCONCLUSIVE" : "PASS";
  console.log(JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), result, channel,
    browser: browserVersion, groups: passed.length, passedGroups: passed, counters, primaryFailure,
    inconclusiveCodes, builtAppRoute, builtAppBfcache, appIndexSha256,
    cleanup: { confirmed: cleanupConfirmed, acquisitionTimedOut, steps: cleanupSteps,
      browserConnected, connectionProbeFailed, serverListening: server?.listening ?? false,
      ownedSocketsRemaining: ownedSockets.size },
    realSecretGate: "CLOSED",
    limits: ["synthetic local fixture and optional existing built-app only; no live mailbox or credentials",
      "native BFCache requires the unchanged marker and trusted persisted lifecycle events",
      "expiry groups use a mocked clock, not a real five-minute timing measurement",
      "bundle index hash is not source-to-build attestation or release approval",
      "cleanup deadlines bound waiting, not guaranteed cancellation; no forced process termination"] }));
  process.exitCode = result === "PASS" ? 0 : result === "INCONCLUSIVE" ? 2 : 1;
}
