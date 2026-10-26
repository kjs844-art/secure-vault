// Real five-minute idle against the existing synthetic production bundle only.
// node apps/web/scripts/verify-local-vault-idle.mjs --synthetic-only
// Root owns execution. No installs/builds, user profiles, clock/event injection,
// external services, real credentials, screenshots, HAR or filesystem artifacts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { acquireOwned, withDeadline } from "../tests/mvp-browser/qa-lifecycle.mjs";
import { probeSyntheticArchive } from "../tests/mvp-browser/synthetic-idb-probe.mjs";
import { classifyIdleTiming } from "../tests/mvp-browser/idle-lock-timing.mjs";

const requireLanding = createRequire(new URL("../../landing/package.json", import.meta.url));
const IDLE_MS = 300000, EARLY_SAMPLE_MS = 295000, OBSERVATION_LIMIT_MS = 360000;
const LOCKED = "잠김 · 저장된 암호문은 그대로 두고 화면 내용을 비웠습니다.";
const OPEN = "열림 · 저장된 암호문에서 3개 합성 항목을 인증하고 복원했습니다.";
const PRIVATE = '[data-testid="relationship-catalog"], [data-testid="registration-panel"], '
  + '[data-testid="rotation-stage-panel"], [data-testid="conflict-review"], '
  + '[data-testid="local-tool-panel"], [data-testid="connection-editor"], '
  + '.local-vault .identity-map, .relationship-list, .issuer-context';
const report = {
  scope: "LOCAL_VAULT_REAL_FIVE_MINUTE_IDLE", status: "BLOCKED", stage: "preflight",
  realSecretGate: "CLOSED", startedAt: new Date().toISOString(), node: process.version,
  groups: [], observed: {}, cleanupConfirmed: false,
  limits: ["existing closed synthetic build only; not real-secret authentication",
    "real elapsed idle in one foreground headless context; not OS sleep, mobile or standalone tab hiding",
    "passive DOM observation is not an exact internal lock-call timestamp or heap-zeroization proof",
    "browser scheduling can delay lock delivery; observation deadline is not a real-time security guarantee",
    "tested bundle hashes are not source-to-build attestation or release approval",
    "harness CSP and loopback isolation are not deployment policy"],
};
const errors = { page: 0, console: 0, http: 0, failed: 0, denied: 0, websocket: 0, source: 0, methods: 0 };
const assets = new Set(), contexts = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pass = (name) => report.groups.push(name);
const archive = (page) => page.evaluate(probeSyntheticArchive,
  { action: "read", acknowledgement: "keyatlas-m05a-synthetic-only" });
let browser, server, page, acquisitionTimedOut = false, origin;

async function bundleFromDisk() {
  const bundle = new Map([["/index.html", { bytes: await readFile(new URL("../dist/index.html", import.meta.url)),
    mime: "text/html; charset=utf-8" }]]);
  for (const entry of await readdir(new URL("../dist/assets/", import.meta.url), { withFileTypes: true })) {
    assert.ok(entry.isFile() && /^[A-Za-z0-9_.-]+\.(?:js|css|wasm)$/.test(entry.name), "IDLE_ASSET_SHAPE");
    bundle.set(`/assets/${entry.name}`, { bytes: await readFile(new URL(`../dist/assets/${entry.name}`, import.meta.url)),
      mime: entry.name.endsWith(".css") ? "text/css" : entry.name.endsWith(".wasm") ? "application/wasm" : "text/javascript" });
  }
  return bundle;
}
function fingerprint(bundle) {
  const manifest = [...bundle].map(([name, value]) => [name, value.bytes.length, hash(value.bytes)])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { files: manifest.length, bytes: manifest.reduce((sum, item) => sum + item[1], 0),
    sha256: hash(JSON.stringify(manifest)), indexSha256: hash(bundle.get("/index.html").bytes) };
}
function browserEnvironment() {
  const env = {};
  // Browser subprocesses receive no provider tokens, proxy URLs, NODE_OPTIONS or VITE_* settings.
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
async function closeServer(value) {
  await new Promise((resolve, reject) => {
    value.close((error) => error ? reject(error) : resolve()); value.closeAllConnections();
  });
}
function inconclusive(code) {
  report.status = "INCONCLUSIVE";
  throw new Error(code);
}

try {
  assert.deepEqual(process.argv.slice(2), ["--synthetic-only"], "IDLE_ACK_REQUIRED");
  assert.ok(!process.env.BROWSER_CHANNEL || process.env.BROWSER_CHANNEL === "chrome", "IDLE_CHROME_ONLY");
  const { chromium } = requireLanding("playwright"), { expect } = requireLanding("playwright/test");
  report.playwright = requireLanding("playwright/package.json").version;
  const bundle = await bundleFromDisk(), beforeBundle = fingerprint(bundle);
  report.observed.bundle = beforeBundle;
  server = await acquire(async () => {
    const owned = createServer((request, response) => {
      if (!["GET", "HEAD"].includes(request.method)) { errors.methods++; response.writeHead(405); response.end(); return; }
      if (!origin || request.headers.host !== new URL(origin).host) { errors.denied++; response.writeHead(403); response.end(); return; }
      response.setHeader("cache-control", "max-age=0");
      response.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
      response.setHeader("permissions-policy", "clipboard-read=(), clipboard-write=()");
      const name = request.url === "/" || request.url === "/?view=local-vault" ? "/index.html" : request.url;
      const asset = bundle.get(name);
      if (!asset) { response.writeHead(404); response.end(); return; }
      response.setHeader("content-type", asset.mime);
      response.setHeader("content-length", String(asset.bytes.length));
      response.end(request.method === "HEAD" ? undefined : asset.bytes);
    });
    try { await new Promise((resolve, reject) => { owned.once("error", reject); owned.listen(0, "127.0.0.1", resolve); }); }
    catch (error) { owned.closeAllConnections(); owned.close(); throw error; }
    return owned;
  }, closeServer);
  const address = server.address();
  assert.ok(address && typeof address === "object" && address.address === "127.0.0.1", "IDLE_LOOPBACK_ADDRESS");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await acquire(() => chromium.launch({ channel: "chrome", headless: true,
    timeout: 30000, env: browserEnvironment() }), (value) => value.close());
  report.browser = browser.version();
  const context = await acquire(() => browser.newContext({ serviceWorkers: "block", acceptDownloads: false,
    viewport: { width: 1280, height: 900 } }), (value) => value.close());
  contexts.push(context);
  assert.deepEqual(await context.storageState(), { cookies: [], origins: [] }, "IDLE_CONTEXT_NOT_FRESH");
  await context.route("**/*", (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || !["GET", "HEAD"].includes(request.method())) { errors.denied++; return route.abort(); }
    if (url.pathname.startsWith("/src/") || url.pathname.startsWith("/@")) errors.source++;
    if (url.pathname.startsWith("/assets/")) assets.add(url.pathname);
    return route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => { errors.websocket++; socket.close(); });
  page = await acquire(() => context.newPage(), (value) => value.close());
  page.setDefaultTimeout(30000);
  page.on("pageerror", () => { errors.page++; });
  page.on("console", (message) => { if (message.type() === "error") errors.console++; });
  context.on("response", (response) => { if (response.status() >= 400) errors.http++; });
  context.on("requestfailed", () => { errors.failed++; });
  report.status = "FAIL"; report.stage = "create-vault-open-editor";
  await page.goto(origin + "/?view=local-vault", { waitUntil: "domcontentloaded" });
  report.stage = "initial-locked-state";
  await expect(page.getByTestId("vault-status")).toHaveText(LOCKED);
  await expect(page.locator(PRIVATE)).toHaveCount(0);
  report.stage = "create-synthetic-vault";
  await page.getByRole("button", { name: "합성 금고 만들기", exact: true }).click();
  report.stage = "wait-for-created-vault";
  // Product WASM/KDF completion uses the same bounded 30s operation budget
  // as the existing lifecycle runner; this does not alter the five-minute clock.
  await expect(page.getByTestId("vault-status")).toHaveText(OPEN, { timeout: 30000 });
  report.stage = "capture-initial-synthetic-archive";
  const initialArchive = await archive(page);
  const initialCatalog = await page.getByTestId("relationship-catalog").locator(".relationship-list > li").allInnerTexts();
  assert.equal(initialCatalog.length, 3, "IDLE_CATALOG_COUNT");
  report.stage = "open-connection-editor";
  await page.getByTestId("connection-edit-open-0").click();
  await expect(page.getByTestId("connection-editor")).toHaveCount(1);
  await expect(page.locator(".local-vault .identity-map")).toHaveCount(1);
  await expect(page.locator(".local-vault .identity-map")).toContainText("REAL_SECRET_GATE=CLOSED");
  report.observed.initialArchive = initialArchive.archive;
  report.observed.catalogSha256 = hash(JSON.stringify(initialCatalog));
  pass("actual_synthetic_vault_worker_wasm_and_editor_open");

  report.stage = "arm-passive-trusted-activity-probe";
  await page.evaluate(({ privateSelector, lockedText, openText }) => {
    if (Object.hasOwn(window, "keyatlasVaultIdleProbe")) throw new Error("IDLE_PROBE_EXISTS");
    const clocks = () => ({ wall: Date.now(), monotonic: performance.now() });
    const sample = () => ({ ...clocks(), hidden: document.hidden,
      open: document.querySelector('[data-testid="vault-status"]')?.textContent === openText,
      locked: document.querySelector('[data-testid="vault-status"]')?.textContent === lockedText,
      privateNodes: document.querySelectorAll(privateSelector).length,
      editorNodes: document.querySelectorAll('[data-testid="connection-editor"]').length });
    let beforeCount = 0, afterCount = 0, last = null, stopped = false, firstLocked = null;
    const pending = new WeakMap(), lifecycle = [];
    const before = (event) => {
      if (!event.isTrusted) return;
      beforeCount++; pending.set(event, clocks());
    };
    const after = (event) => {
      if (!event.isTrusted) return;
      afterCount++; last = { type: event.type, trusted: true, before: pending.get(event) ?? null, after: clocks() };
    };
    const observe = () => {
      const state = sample();
      if (state.locked && firstLocked === null) firstLocked = state;
    };
    const onLifecycle = (event) => { if (lifecycle.length < 8) lifecycle.push({ type: event.type,
      trusted: event.isTrusted, ...sample() }); };
    // Window capture precedes the product's document capture activity listener;
    // this document listener was added later and observes its return. No replacement.
    for (const type of ["pointerdown", "keydown"]) {
      window.addEventListener(type, before, true); document.addEventListener(type, after, true);
    }
    window.addEventListener("pagehide", onLifecycle);
    window.addEventListener("pageshow", onLifecycle);
    document.addEventListener("visibilitychange", onLifecycle);
    const observer = new MutationObserver(observe);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    const probe = {
      stats: () => ({ beforeCount, afterCount, last, firstLocked, lifecycle: [...lifecycle], current: sample() }),
      stop: () => {
        if (stopped) return; stopped = true; observer.disconnect();
        for (const type of ["pointerdown", "keydown"]) {
          window.removeEventListener(type, before, true); document.removeEventListener(type, after, true);
        }
        window.removeEventListener("pagehide", onLifecycle); window.removeEventListener("pageshow", onLifecycle);
        document.removeEventListener("visibilitychange", onLifecycle);
      },
    };
    Object.defineProperty(window, "keyatlasVaultIdleProbe", { value: probe, configurable: false });
  }, { privateSelector: PRIVATE, lockedText: LOCKED, openText: OPEN });
  // A native browser keydown (not dispatchEvent) is the final product-recognized
  // activity. Shift alone does not edit or activate the focused product control.
  await page.keyboard.press("Shift");
  const initial = await page.evaluate(() => window.keyatlasVaultIdleProbe.stats());
  assert.equal(initial.beforeCount, 1, "IDLE_TRUSTED_BEFORE_COUNT");
  assert.equal(initial.afterCount, 1, "IDLE_TRUSTED_AFTER_COUNT");
  assert.equal(initial.last?.type, "keydown", "IDLE_TRUSTED_ACTIVITY_MISSING");
  assert.ok(initial.last?.before && initial.last.trusted, "IDLE_ACTIVITY_BOUND_MISSING");
  assert.ok(initial.current.open && initial.current.privateNodes > 0 && initial.current.editorNodes === 1,
    "IDLE_NOT_OPEN_AT_START");
  if (initial.current.hidden || initial.lifecycle.length) inconclusive("IDLE_VISIBILITY_CONFOUNDED");
  const activity = initial.last;
  const activityWidth = activity.after.monotonic - activity.before.monotonic;
  assert.ok(activityWidth >= 0, "IDLE_ACTIVITY_CLOCK_REGRESSION");
  if (activityWidth > 1000) inconclusive("IDLE_ACTIVITY_BOUND_TOO_WIDE");
  report.observed.lastTrustedActivity = activity;
  report.observed.policyMs = IDLE_MS;
  report.stage = "real-idle-no-input";
  const nodeStart = performance.now();
  let early = null, settled = null, previous = initial.current;
  while (performance.now() - nodeStart <= OBSERVATION_LIMIT_MS + 5000) {
    // At most one-second passive reads; neither this timer nor DOM reads are
    // trusted activity, clock substitution or product timer acceleration.
    await delay(1000);
    const current = await withDeadline(() => page.evaluate(() => window.keyatlasVaultIdleProbe.stats()), 5000);
    assert.equal(current.beforeCount, 1, "IDLE_UNEXPECTED_ACTIVITY");
    assert.equal(current.afterCount, 1, "IDLE_UNEXPECTED_ACTIVITY");
    assert.deepEqual(current.last, activity, "IDLE_ACTIVITY_REPLACED");
    if (current.current.hidden || current.lifecycle.length) inconclusive("IDLE_VISIBILITY_CONFOUNDED");
    const elapsed = current.current.monotonic - activity.before.monotonic;
    const wallElapsed = current.current.wall - activity.before.wall;
    if (current.current.monotonic < previous.monotonic || current.current.wall < previous.wall
      || Math.abs(wallElapsed - elapsed) > 2000) inconclusive("IDLE_CLOCK_DISCONTINUITY");
    previous = current.current;
    const timing = classifyIdleTiming(activity.before.monotonic, activity.after.monotonic,
      current.current.monotonic, IDLE_MS);
    if (current.firstLocked) {
      const lockTiming = classifyIdleTiming(activity.before.monotonic, activity.after.monotonic,
        current.firstLocked.monotonic, IDLE_MS);
      if (lockTiming.state === "uncertain") inconclusive("IDLE_LOCK_THRESHOLD_INTERVAL_UNCERTAIN");
      if (lockTiming.state === "before") {
        const wallTiming = classifyIdleTiming(activity.before.wall, activity.after.wall,
          current.firstLocked.wall, IDLE_MS);
        if (wallTiming.state !== "before") inconclusive("IDLE_WALL_CLOCK_EXPIRED_FIRST");
        assert.fail("IDLE_LOCKED_BEFORE_FIVE_MINUTES");
      }
    }
    const earlyTiming = classifyIdleTiming(activity.before.monotonic, activity.after.monotonic,
      current.current.monotonic, EARLY_SAMPLE_MS);
    if (!early && earlyTiming.state === "reached") {
      // The entire activity interval must put this observation after 295s but
      // before 300s; using only BEFORE overstates the elapsed lower bound.
      if (timing.state !== "before") inconclusive("IDLE_PREDEADLINE_SAMPLE_MISSED");
      assert.ok(current.current.open && !current.firstLocked && current.current.privateNodes > 0
        && current.current.editorNodes === 1, "IDLE_LOCKED_BEFORE_PREDEADLINE");
      early = current.current; report.observed.preDeadline = early;
      report.observed.preDeadlineTiming = timing;
      pass("still_open_with_editor_after_295_seconds_without_new_activity");
    }
    if (current.firstLocked) {
      if (current.current.locked && current.current.privateNodes === 0 && current.current.editorNodes === 0) {
        assert.ok(early, "IDLE_PREDEADLINE_EVIDENCE_MISSING");
        assert.ok(elapsed <= OBSERVATION_LIMIT_MS, "IDLE_LOCK_OBSERVATION_TOO_LATE");
        settled = current; break;
      }
    }
    assert.ok(elapsed <= OBSERVATION_LIMIT_MS, "IDLE_LOCK_NOT_OBSERVED");
  }
  assert.ok(settled, "IDLE_OBSERVATION_DEADLINE");
  report.observed.firstLocked = settled.firstLocked;
  report.observed.settled = settled.current;
  const lockTiming = classifyIdleTiming(activity.before.monotonic, activity.after.monotonic,
    settled.firstLocked.monotonic, IDLE_MS);
  const settledTiming = classifyIdleTiming(activity.before.monotonic, activity.after.monotonic,
    settled.current.monotonic, IDLE_MS);
  report.observed.lockObservedMinimumElapsedMs = lockTiming.minimumElapsedMs;
  report.observed.lockObservedMaximumElapsedMs = lockTiming.maximumElapsedMs;
  report.observed.settledMinimumElapsedMs = settledTiming.minimumElapsedMs;
  report.observed.settledMaximumElapsedMs = settledTiming.maximumElapsedMs;
  // Retained legacy fields are elapsed upper bounds, not exact activity times.
  report.observed.lockObservedElapsedMs = settled.firstLocked.monotonic - activity.before.monotonic;
  report.observed.settledElapsedMs = settled.current.monotonic - activity.before.monotonic;
  report.observed.actualTrustedActivityEvents = { before: settled.beforeCount, after: settled.afterCount };
  pass("real_five_minute_idle_reaches_locked_and_private_dom_empty_without_navigation");
  await page.evaluate(() => window.keyatlasVaultIdleProbe.stop());

  report.stage = "locked-bytes-and-explicit-reopen";
  assert.deepEqual(await archive(page), initialArchive, "IDLE_ARCHIVE_CHANGED_ON_LOCK");
  await page.getByRole("button", { name: "저장된 합성 금고 열기", exact: true }).click();
  await expect(page.getByTestId("vault-status")).toHaveText(OPEN, { timeout: 30000 });
  assert.deepEqual(await page.getByTestId("relationship-catalog").locator(".relationship-list > li").allInnerTexts(),
    initialCatalog, "IDLE_REOPEN_CATALOG_CHANGED");
  assert.deepEqual(await archive(page), initialArchive, "IDLE_REOPEN_ARCHIVE_CHANGED");
  report.observed.archivePreserved = true; report.observed.explicitReopenPreserved = true;
  pass("ciphertext_unchanged_and_explicit_reopen_restores_same_three_rows");
  assert.deepEqual(fingerprint(await bundleFromDisk()), beforeBundle, "IDLE_BUILD_CHANGED");
  assert.ok([...assets].some((name) => name.endsWith(".wasm")), "IDLE_WASM_NOT_OBSERVED");
  assert.deepEqual(errors, { page: 0, console: 0, http: 0, failed: 0, denied: 0, websocket: 0, source: 0, methods: 0 });
  report.observed.assets = [...assets].sort();
  report.status = "PASS"; report.stage = "complete";
} catch (error) {
  report.failureCode = error instanceof Error && /^IDLE_[A-Z0-9_]+$/.test(error.message)
    ? error.message : report.status === "BLOCKED" ? "IDLE_PREREQUISITE_BLOCKED" : "IDLE_CHECK_FAILED";
  // Fixed codes/stages only: never emit browser exception messages or DOM text.
  report.primaryFailureCode = report.failureCode;
  report.failureStage = report.stage;
} finally {
  let cleanup = !acquisitionTimedOut;
  const cleanupFailures = acquisitionTimedOut ? ["acquisition"] : [];
  if (page && !page.isClosed()) {
    try { await withDeadline(() => page.evaluate(() => window.keyatlasVaultIdleProbe?.stop()), 5000); }
    catch { cleanup = false; cleanupFailures.push("probe-stop"); }
  }
  for (const context of contexts.reverse()) {
    try { await withDeadline(() => context.close(), 15000); }
    catch { cleanup = false; cleanupFailures.push("context-close"); }
  }
  if (browser) {
    try {
      await withDeadline(() => browser.close(), 15000);
      if (browser.isConnected()) { cleanup = false; cleanupFailures.push("browser-still-connected"); }
    } catch { cleanup = false; cleanupFailures.push("browser-close"); }
  }
  if (server) {
    try { await withDeadline(() => closeServer(server), 15000); }
    catch { cleanup = false; cleanupFailures.push("server-close"); }
  }
  report.observed.errors = { ...errors };
  report.cleanupConfirmed = cleanup;
  report.cleanupFailures = cleanupFailures;
  if (["PASS", "INCONCLUSIVE"].includes(report.status) && Object.values(errors).some((count) => count !== 0)) {
    report.observed.beforeErrorClassification = { status: report.status, failureCode: report.failureCode ?? null };
    report.status = "FAIL"; report.failureCode = "IDLE_OBSERVED_ERRORS";
  }
  if (!cleanup) { report.status = "FAIL"; report.failureCode = "IDLE_CLEANUP_UNCONFIRMED"; }
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report));
  process.exitCode = report.status === "PASS" ? 0 : ["BLOCKED", "INCONCLUSIVE"].includes(report.status) ? 2 : 1;
}
