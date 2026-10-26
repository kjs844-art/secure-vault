// Explicit synthetic-only invocation; actual product React, in-memory Vite bundle.
// node --import tsx scripts/verify-benefit-history-browser.ts --synthetic-only [--screenshots]
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const landing = createRequire(new URL("../../landing/package.json", import.meta.url));
const { chromium } = landing("playwright") as typeof import("../../landing/node_modules/playwright/index.js");
const { expect } = landing("playwright/test") as typeof import("../../landing/node_modules/playwright/test.js");
type Browser = Awaited<ReturnType<typeof chromium.launch>>;
type Context = Awaited<ReturnType<Browser["newContext"]>>;
type Page = Awaited<ReturnType<Context["newPage"]>>;
const channel = process.env.BROWSER_CHANNEL ?? "chrome", deadline = performance.now() + 120000;
const screenshots = process.argv[3] === "--screenshots";
const screenshotDirectory = "docs/verification/images/benefit-history-20261027/";
const screenshotPaths = { CURRENT: screenshotDirectory + "narrow-current.png", HISTORY: screenshotDirectory + "narrow-history.png" } as const;
type ScreenshotView = keyof typeof screenshotPaths;
const errors = { console: 0, page: 0, transport: 0, external: 0, websocket: 0, dialog: 0, server: 0 };
const report = { scope: "SYNTHETIC_BENEFIT_HISTORY_ACTUAL_COMPONENTS", status: "FAIL", stage: "PREFLIGHT",
  browser: channel === "msedge" ? "EDGE" : "CHROME", bundle: "IN_MEMORY_VITE_NOT_EXISTING_DIST",
  startedAt: new Date().toISOString(), finishedAt: "", browserVersion: "",
  entryBytes: 0, entrySha256: "",
  screenshots: [] as { label: ScreenshotView; path: string }[],
  checks: [] as string[], sourceSha256: {} as Record<string, string>, errors,
  cleanup: { context: false, browser: false, server: false, sockets: false },
  limits: ["SYNTHETIC_FIXED_REFERENCE_NOT_LIVE_PROVIDER", "VIEWPORT_NOT_REAL_MOBILE_DEVICE",
    "REQUEST_ROUTING_NOT_OS_NETWORK_SANDBOX", "NO_AUTH_DATABASE_OR_PUBLIC_ROUTE", "NO_CSS_OR_DESIGN_CHANGE"] };
const sockets = new Set<Socket>(), assets = new Map<string, { body: string | Uint8Array; type: string }>();
let browser: Browser | undefined, context: Context | undefined, origin = "", html = "", closedContext = true;
const server = createServer((request, response) => {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  if (!origin || request.method !== "GET" || request.headers.host !== new URL(origin).host) {
    errors.server++; response.writeHead(400).end(); return;
  }
  if (request.url === "/favicon.ico") { response.writeHead(204).end(); return; }
  const asset = request.url === "/" ? { body: html, type: "text/html; charset=utf-8" } : assets.get(request.url ?? "");
  if (!asset) { errors.server++; response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": asset.type }).end(asset.body);
});
server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
server.on("error", () => { errors.server++; });
function ensure(value: unknown): asserts value { if (!value) throw new Error("HISTORY_CHECK_FAILED"); }
async function bounded<T>(promise: Promise<T>, milliseconds = 10000, cleanup = false): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = cleanup ? milliseconds : Math.min(milliseconds, Math.max(1, deadline - performance.now()));
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("HISTORY_DEADLINE")), wait);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
async function choose(page: Page, mode: string) {
  const button = page.getByTestId("mode-" + mode);
  await button.focus(); await button.press("Enter");
  await expect(page.getByTestId("history-fixture")).toHaveAttribute("data-mode", mode);
}
async function requireAbsent(path: URL) {
  try { await lstat(path); } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("HISTORY_SCREENSHOT_ALREADY_EXISTS");
}
async function narrowOverflow(page: Page, prefix: string, view: ScreenshotView) {
  if (prefix !== "NARROW") return;
  ensure(await page.evaluate(() => window.innerWidth === 360 &&
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth));
  report.checks.push("NARROW_" + view + "_NO_HORIZONTAL_OVERFLOW");
  if (screenshots) {
    const png = await page.screenshot({ type: "png", fullPage: true, timeout: 5000 });
    await writeFile(new URL("../../../" + screenshotPaths[view], import.meta.url), png, { flag: "wx" });
    report.screenshots.push({ label: view, path: screenshotPaths[view] });
  }
}
async function normalFlow(page: Page, prefix: string) {
  await choose(page, "normal");
  await expect(page.locator("article")).toHaveCount(6);
  await expect(page.locator("article strong").filter({ hasText: /^지난 기록$/ })).toHaveCount(0);
  await expect(page.getByText("지난 프로모션 크레딧", { exact: true })).toHaveCount(0);
  await expect(page.getByText("지난 14일 무료 체험", { exact: true })).toHaveCount(0);
  const review = page.getByRole("button", { name: "현재·확인 필요 보기", exact: true });
  const history = page.getByRole("button", { name: "지난 기록 보기", exact: true });
  await expect(review).toHaveAttribute("aria-pressed", "true");
  await narrowOverflow(page, prefix, "CURRENT");
  await history.focus(); await history.press("Enter");
  await expect(history).toHaveAttribute("aria-pressed", "true");
  await expect(review).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("article")).toHaveCount(2);
  await expect(page.locator("article strong").filter({ hasText: /^지난 기록$/ })).toHaveCount(2);
  await expect(page.locator("article [role=meter]")).toHaveCount(0);
  const summary = page.locator('section[aria-label="요약 숫자"]');
  await expect(summary).toContainText("지난 기록이 있는 서비스");
  await expect(summary).toContainText("현재 사용할 수 있는 혜택이 아님");
  await expect(summary).not.toContainText(/샘플 혜택|살펴볼 항목/);
  await expect(summary.locator(":scope > div")).toHaveCount(2);
  await expect(summary.locator(":scope > div").nth(1).locator("p").nth(1)).toHaveText("2");
  await expect(page.locator("article").first()).toContainText("기록 당시 잔량");
  await narrowOverflow(page, prefix, "HISTORY");
  await review.focus(); await review.press("Enter");
  await expect(page.locator("article")).toHaveCount(6);
  const first = page.locator("#demo-svc-demo-svc-1"), second = page.locator("#demo-svc-demo-svc-2");
  await first.focus(); await first.press("ArrowDown");
  await expect(second).toBeFocused(); await expect(second).toHaveAttribute("aria-pressed", "true");
  await second.press("ArrowUp"); await expect(first).toBeFocused();
  await expect(first).toHaveAttribute("aria-pressed", "true"); await expect(second).toHaveAttribute("aria-pressed", "false");
  await page.locator('section[aria-labelledby="demo-attention-title"] button').first().click();
  await expect(second).toBeFocused(); await expect(second).toHaveAttribute("aria-pressed", "true");
  report.checks.push(prefix + "_NORMAL_HISTORY_RETURN_KEYBOARD_ATTENTION");
}
async function boundaries(page: Page, prefix: string) {
  for (const mode of ["expired-benefit", "ended-trial", "date-only"]) {
    await choose(page, mode); const card = page.locator("article");
    await expect(card).toHaveCount(1); await expect(card.locator("strong")).toHaveText("확인 필요");
    await expect(card).toContainText("기록된 잔량"); await expect(card).not.toContainText("기록 당시 잔량");
    await expect(card.locator("[role=meter]")).toHaveCount(0);
    const attention = page.locator('section[aria-label="합성 확인 항목"]');
    const expiryItem = attention.locator("li").filter({ hasText: "합성 체험 기록 만료일 확인 필요" });
    await expect(expiryItem).toHaveCount(1); await expect(expiryItem.locator("p").first()).toHaveText("확인 필요");
    await expiryItem.getByRole("button", { name: "해당 서비스 보기" }).click();
    const service = page.locator("#demo-svc-synthetic-history-service");
    await expect(service).toBeFocused(); await expect(service).toHaveAttribute("aria-pressed", "true");
    report.checks.push(prefix + "_" + mode.toUpperCase().replaceAll("-", "_"));
  }
  await choose(page, "impossible-service");
  const attention = page.locator('section[aria-label="합성 확인 항목"]');
  await expect(attention.locator("li")).toHaveCount(1);
  await expect(attention.locator("li p").first()).toHaveText("확인 필요");
  await expect(attention).toContainText("체험 종료 시점을 확인해 주세요.");
  await expect(attention).not.toContainText(/\d+일 남음/);
  report.checks.push(prefix + "_IMPOSSIBLE_SERVICE_REQUIRES_REVIEW");
  await choose(page, "escaped");
  await expect(page.locator("article h4")).toHaveText("<img src=x onerror=alert(1)>");
  await expect(page.locator("article img, article script, article svg, article iframe")).toHaveCount(0);
  report.checks.push(prefix + "_ESCAPED_SYNTHETIC_LABEL");
  await choose(page, "normal"); await expect(page.locator("article")).toHaveCount(6);
}
try {
  ensure(process.argv[2] === "--synthetic-only" && (process.argv.length === 3 || (process.argv.length === 4 && screenshots)));
  ensure(channel === "chrome" || channel === "msedge");
  if (screenshots) {
    for (const path of Object.values(screenshotPaths)) await requireAbsent(new URL("../../../" + path, import.meta.url));
    await mkdir(new URL("../../../" + screenshotDirectory, import.meta.url), { recursive: true });
  }
  const inputs = { FIXTURE: "./fixtures/benefit-history-fixture.tsx", DEMO: "../src/components/mvp-demo/DemoExperience.tsx",
    CARD: "../src/components/mvp-demo/BenefitCard.tsx", LIST: "../src/components/mvp-demo/ServiceList.tsx",
    ATTENTION: "../src/components/mvp-demo/AttentionList.tsx", DATA: "../src/lib/mvp-demo-data.ts",
    HISTORY: "../src/lib/demo-benefit-history.ts", STYLES: "../src/styles.css" };
  for (const [key, path] of Object.entries(inputs))
    report.sourceSha256[key] = createHash("sha256").update(await readFile(new URL(path, import.meta.url))).digest("hex");
  report.stage = "BUNDLE";
  const bundle = await bounded(build({ root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false, envDir: false, envPrefix: [], logLevel: "silent", esbuild: { jsx: "automatic" },
    build: { write: false, emptyOutDir: false, rollupOptions: {
      input: fileURLToPath(new URL("./fixtures/benefit-history-fixture.tsx", import.meta.url)),
      output: { entryFileNames: "fixture.js" },
    } } }), 45000);
  ensure(!Array.isArray(bundle) && "output" in bundle);
  for (const asset of bundle.output) {
    ensure(/^[A-Za-z0-9._/-]+$/.test(asset.fileName));
    assets.set("/" + asset.fileName, { body: asset.type === "chunk" ? asset.code : asset.source,
      type: asset.fileName.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" });
  }
  ensure(assets.has("/fixture.js"));
  const entry = assets.get("/fixture.js")!.body;
  report.entryBytes = typeof entry === "string" ? Buffer.byteLength(entry) : entry.byteLength;
  report.entrySha256 = createHash("sha256").update(entry).digest("hex");
  const css = [...assets.keys()].filter((name) => name.endsWith(".css")).map((name) => '<link rel="stylesheet" href="' + name + '">').join("");
  html = '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Synthetic history verification</title>' + css + '<body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
  report.stage = "SERVER";
  await bounded(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }));
  const address = server.address(); ensure(address && typeof address === "object"); origin = "http://127.0.0.1:" + address.port;
  report.stage = "LAUNCH";
  ensure(deadline - performance.now() > 16000);
  browser = await chromium.launch({ channel, headless: true, timeout: 15000 });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" }); closedContext = false;
  context.on("close", () => { closedContext = true; });
  context.setDefaultTimeout(5000); context.setDefaultNavigationTimeout(10000);
  await context.route("**/*", async (route) => {
    let allowed = false; try { const url = new URL(route.request().url()); allowed = url.origin === origin; } catch { /* Fixed counters only. */ }
    if (!allowed) { errors.external++; await route.abort("blockedbyclient"); } else await route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => { errors.websocket++; socket.close(); });
  context.on("requestfailed", () => { errors.transport++; });
  const page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") errors.console++; });
  page.on("pageerror", () => { errors.page++; });
  page.on("dialog", (dialog) => { errors.dialog++; void dialog.dismiss().catch(() => {}); });
  await bounded(page.goto(origin, { waitUntil: "load" }));
  for (const [prefix, width, height] of [["DESKTOP", 1280, 900], ["NARROW", 360, 800]] as const) {
    report.stage = prefix;
    await page.setViewportSize({ width, height });
    await bounded(normalFlow(page, prefix), 25000); await bounded(boundaries(page, prefix), 25000);
  }
  ensure(Object.values(errors).every((value) => value === 0)); report.status = "PASS"; report.stage = "CHECKS_COMPLETE";
} catch { report.status = "FAIL"; }
finally {
  try { if (context) await bounded(context.close(), 5000, true); } catch { report.status = "FAIL"; }
  report.cleanup.context = closedContext;
  try { if (browser) await bounded(browser.close(), 10000, true); } catch { report.status = "FAIL"; }
  report.cleanup.browser = !browser || !browser.isConnected();
  try {
    const closing = server.listening ? new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) : Promise.resolve();
    const socketCloses = [...sockets].map((socket) => new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.destroy(); }));
    await bounded(Promise.all([closing, ...socketCloses]), 5000, true);
  } catch { report.status = "FAIL"; }
  report.cleanup.server = !server.listening; report.cleanup.sockets = sockets.size === 0;
  if (!Object.values(report.cleanup).every(Boolean) || Object.values(errors).some((value) => value !== 0)) report.status = "FAIL";
  report.finishedAt = new Date().toISOString();
  process.stdout.write(JSON.stringify(report) + "\n"); process.exitCode = report.status === "PASS" ? 0 : 1;
}
