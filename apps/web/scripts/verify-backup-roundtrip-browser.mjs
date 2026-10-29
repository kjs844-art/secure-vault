// Synthetic-only installed-browser evidence. This runner serves the already-built
// product, downloads its archive to an owned directory, and restores that disk
// file through the real file-input boundary in isolated browser contexts.
//
// node apps/web/scripts/verify-backup-roundtrip-browser.mjs --synthetic-only [--channel=chrome|msedge]
// node apps/web/scripts/verify-backup-roundtrip-browser.mjs --synthetic-only --preflight
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  SYNTHETIC_ARCHIVE_MAX_BYTES,
  SYNTHETIC_BACKUP_FILENAME,
  assertKnownSyntheticSemantics,
  deriveNegativeArchives,
  inspectSyntheticArchive,
  parseBackupRoundtripArgs,
} from "./support/backup-roundtrip-contract.mjs";
import { createIdentityCloseObservation, IDENTITY_CLOSE_LIMIT_MS } from "./support/identity-close-observation.mjs";
import { acquireOwned, withDeadline } from "../tests/mvp-browser/qa-lifecycle.mjs";
import { probeSyntheticArchive } from "../tests/mvp-browser/synthetic-idb-probe.mjs";

const EXPECTED_HEAD = "6211b276c462defc2d6ad2e58baff62a1c0bf684";
const EXPECTED_INDEX_SHA256 = "64cadaaff8e4391fab87c434826f2058db87061d0d1f0e260ffe982d870f4303";
const EXPECTED_ASSETS_SHA256 = "487b043d6be1eb0b8b2911a6fef088a546448acd4907612aec1ec3fa843c3c89";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIST_ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const REPORT_ROOT = join(REPOSITORY_ROOT, "target", "reports");
const execFileAsync = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const PRODUCT_INPUT_PATHS = Object.freeze([
  "apps/web/src", "apps/web/index.html", "apps/web/package.json", "apps/web/package-lock.json",
  "apps/web/tsconfig.json", "apps/web/vite.config.ts", "crates", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml",
]);
const PROVENANCE_PATHS = Object.freeze({
  runner: fileURLToPath(import.meta.url),
  contract: fileURLToPath(new URL("./support/backup-roundtrip-contract.mjs", import.meta.url)),
  contractTest: fileURLToPath(new URL("./support/backup-roundtrip-contract.test.mjs", import.meta.url)),
  closeObservation: fileURLToPath(new URL("./support/identity-close-observation.mjs", import.meta.url)),
  lifecycle: fileURLToPath(new URL("../tests/mvp-browser/qa-lifecycle.mjs", import.meta.url)),
  idbProbe: fileURLToPath(new URL("../tests/mvp-browser/synthetic-idb-probe.mjs", import.meta.url)),
  playwrightPackage: fileURLToPath(new URL("../../landing/package.json", import.meta.url)),
  playwrightLock: fileURLToPath(new URL("../../landing/package-lock.json", import.meta.url)),
});

let parsed;
try { parsed = parseBackupRoundtripArgs(process.argv.slice(2)); }
catch {
  console.log(JSON.stringify({ result: "BLOCKED", code: "SYNTHETIC_ARGUMENTS_REQUIRED" }));
  process.exit(2);
}
if (process.env.REAL_SECRET_GATE !== undefined && process.env.REAL_SECRET_GATE !== "CLOSED") {
  console.log(JSON.stringify({ result: "BLOCKED", code: "REAL_SECRET_GATE_NOT_CLOSED" }));
  process.exit(2);
}
if (parsed.preflight) {
  console.log(JSON.stringify({ result: "PREFLIGHT_ONLY", channel: parsed.channel, browserStarted: false,
    realSecretGate: "CLOSED", limits: "arguments only; dependencies, frozen dist and browser availability not checked" }));
  process.exit(0);
}

const startedAt = new Date().toISOString();
const groups = [];
const cleanupSteps = [];
const sockets = new Set();
const contexts = new Map();
const trackedPages = new WeakSet();
const requestedAssets = new Set();
const counters = {
  pageErrors: 0,
  consoleErrors: 0,
  externalRequests: 0,
  httpErrors: 0,
  failedRequests: 0,
  deniedRequests: 0,
  blockedMethods: 0,
  sourceRequests: 0,
  websocketRequests: 0,
  routeErrors: 0,
  serverErrors: 0,
  dialogs: 0,
  nodeUnhandledRejections: 0,
  nodeUncaughtExceptions: 0,
};
let stage = "PREPARE";
let primaryFailure = null;
let functionalChecksCompleted = false;
let acquisitionTimedOut = false;
let serverListenTimedOut = false;
let browser = null;
let browserVersion = null;
let browserCloseObserver = null;
let browserCloseObservation = null;
let browserCloseStep = null;
let server = null;
let origin = null;
let artifactDirectory = null;
let artifactId = null;
let initialSourceState = null;
let initialDist = null;
let initialProvenance = null;
let finalSourceState = null;
let finalDist = null;
let finalProvenance = null;
let playwrightVersion = null;
let evidence = {
  archiveBytes: null,
  archiveSha256: null,
  semanticRows: null,
  semanticSha256: null,
  negativeCases: 0,
  sourceDownload: false,
  freshRestore: false,
  existingVaultRefusal: false,
  reexportExactBytes: false,
};

const onUnhandledRejection = () => { counters.nodeUnhandledRejections += 1; };
const onUncaughtExceptionMonitor = () => { counters.nodeUncaughtExceptions += 1; };
process.on("unhandledRejection", onUnhandledRejection);
process.on("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);

function failureCode(error) {
  try {
    if (error instanceof Error && error.message === "QA_DEADLINE") return "DEADLINE";
    if (error instanceof assert.AssertionError) return "ASSERTION";
    if (error instanceof Error && error.name === "TimeoutError") return "OPERATION_TIMEOUT";
  } catch { /* Never inspect a hostile thrown value further. */ }
  return "CHECK_FAILED";
}

function browserEnvironment() {
  const env = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "Path", "LANG", "TZ"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function acquire(factory, dispose) {
  try { return await acquireOwned(factory, dispose, 30_000); }
  catch (error) {
    if (failureCode(error) === "DEADLINE") acquisitionTimedOut = true;
    throw error;
  }
}

async function check(name, operation, timeoutMs = 30_000) {
  stage = name;
  await withDeadline(operation, timeoutMs);
  groups.push(name);
}

async function cleanup(name, operation, timeoutMs) {
  try {
    await withDeadline(operation, timeoutMs);
    cleanupSteps.push({ name, outcome: "RESOLVED", timeoutMs });
    return true;
  } catch (error) {
    cleanupSteps.push({ name, outcome: failureCode(error) === "DEADLINE" ? "DEADLINE" : "REJECTED", timeoutMs });
    return false;
  }
}

async function sourceState() {
  const options = { cwd: REPOSITORY_ROOT, encoding: "buffer", windowsHide: true, maxBuffer: 1024 * 1024,
    timeout: 8_000, killSignal: "SIGTERM" };
  const runGit = (args) => withDeadline(() => execFileAsync("git", args, options), 10_000);
  const headResult = await runGit(["rev-parse", "HEAD"]);
  const head = Buffer.from(headResult.stdout).toString("utf8").trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  const mergeBaseResult = await runGit(["merge-base", EXPECTED_HEAD, head]);
  const mergeBase = Buffer.from(mergeBaseResult.stdout).toString("utf8").trim();
  assert.equal(mergeBase, EXPECTED_HEAD);
  const committedResult = await runGit(["diff", "--name-only", "-z", EXPECTED_HEAD, head, "--", ...PRODUCT_INPUT_PATHS]);
  const committed = Buffer.from(committedResult.stdout);
  const statusResult = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...PRODUCT_INPUT_PATHS]);
  const status = Buffer.from(statusResult.stdout);
  assert.ok(committed.byteLength <= 1024 * 1024);
  assert.ok(status.byteLength <= 1024 * 1024);
  return Object.freeze({ baselineHead: EXPECTED_HEAD, head,
    committedDiffSha256: sha256(committed), committedChangedPaths: committed.filter((byte) => byte === 0).byteLength,
    statusSha256: sha256(status), workingChangedPaths: status.filter((byte) => byte === 0).byteLength });
}

async function provenanceSnapshot() {
  const output = {};
  for (const [name, path] of Object.entries(PROVENANCE_PATHS)) {
    const stat = await lstat(path);
    assert.equal(stat.isFile() && !stat.isSymbolicLink(), true);
    assert.ok(stat.size > 0 && stat.size <= 2 * 1024 * 1024);
    const body = await readFile(path);
    assert.equal(body.byteLength, stat.size);
    output[`${name}Sha256`] = sha256(body);
  }
  return Object.freeze(output);
}

function assetType(name) {
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".wasm")) return "application/wasm";
  return "text/javascript; charset=utf-8";
}

async function distSnapshot() {
  const rootStat = await lstat(DIST_ROOT);
  assert.equal(rootStat.isDirectory() && !rootStat.isSymbolicLink(), true);
  const indexPath = join(DIST_ROOT, "index.html");
  const indexStat = await lstat(indexPath);
  assert.equal(indexStat.isFile() && !indexStat.isSymbolicLink(), true);
  assert.ok(indexStat.size > 0 && indexStat.size <= 1024 * 1024);
  const index = await readFile(indexPath);
  assert.equal(index.byteLength, indexStat.size);

  const assetsPath = join(DIST_ROOT, "assets");
  const assetsStat = await lstat(assetsPath);
  assert.equal(assetsStat.isDirectory() && !assetsStat.isSymbolicLink(), true);
  const entries = await readdir(assetsPath, { withFileTypes: true });
  assert.ok(entries.length > 0 && entries.length <= 16);
  const assets = new Map();
  const manifest = [];
  let totalBytes = 0;
  for (const entry of entries) {
    assert.equal(entry.isFile() && !entry.isSymbolicLink(), true);
    assert.match(entry.name, /^[A-Za-z0-9_][A-Za-z0-9._-]*\.(?:js|css|wasm)$/);
    const path = join(assetsPath, entry.name);
    const stat = await lstat(path);
    assert.equal(stat.isFile() && !stat.isSymbolicLink(), true);
    assert.ok(stat.size > 0 && stat.size <= 1024 * 1024);
    totalBytes += stat.size;
    assert.ok(totalBytes <= 2 * 1024 * 1024);
    const body = await readFile(path);
    assert.equal(body.byteLength, stat.size);
    const url = `/assets/${entry.name}`;
    assets.set(url, Object.freeze({ body, type: assetType(entry.name) }));
    manifest.push([url, body.byteLength, sha256(body)]);
  }
  manifest.sort(([left], [right]) => left.localeCompare(right));
  return Object.freeze({
    index,
    assets,
    indexSha256: sha256(index),
    assetsSha256: sha256(JSON.stringify(manifest)),
    assetCount: manifest.length,
  });
}

function sameSourceState(left, right) {
  return left?.baselineHead === right?.baselineHead && left?.head === right?.head
    && left?.committedDiffSha256 === right?.committedDiffSha256
    && left?.committedChangedPaths === right?.committedChangedPaths
    && left?.statusSha256 === right?.statusSha256
    && left?.workingChangedPaths === right?.workingChangedPaths;
}

function sameDist(left, right) {
  return left?.indexSha256 === right?.indexSha256 && left?.assetsSha256 === right?.assetsSha256
    && left?.assetCount === right?.assetCount;
}

function sameProvenance(left, right) {
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

function attachPage(page) {
  if (trackedPages.has(page)) return;
  trackedPages.add(page);
  page.on("pageerror", () => { counters.pageErrors += 1; });
  page.on("console", (message) => { if (message.type() === "error") counters.consoleErrors += 1; });
  page.on("dialog", (dialog) => {
    counters.dialogs += 1;
    void dialog.dismiss().catch(() => { counters.routeErrors += 1; });
  });
}

async function createContext(acceptDownloads) {
  const context = await acquire(() => browser.newContext({
    acceptDownloads,
    serviceWorkers: "block",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1280, height: 900 },
  }), (value) => value.close());
  contexts.set(context, { attempted: false, outcome: "PENDING" });
  context.setDefaultTimeout(10_000);
  context.setDefaultNavigationTimeout(15_000);
  await withDeadline(() => context.route("**/*", async (route) => {
    try {
      const request = route.request();
      const url = new URL(request.url());
      if (url.protocol === "blob:" && url.origin === origin) { await route.continue(); return; }
      if (url.origin !== origin) {
        counters.externalRequests += 1;
        await route.abort("blockedbyclient");
        return;
      }
      if (!["GET", "HEAD"].includes(request.method())) {
        counters.blockedMethods += 1;
        await route.abort("blockedbyclient");
        return;
      }
      if (/^\/(?:src\/|@vite\/|@fs\/|@id\/)/.test(url.pathname)) {
        counters.sourceRequests += 1;
        await route.abort("blockedbyclient");
        return;
      }
      if (url.pathname.startsWith("/assets/")) requestedAssets.add(url.pathname);
      await route.continue();
    } catch { counters.routeErrors += 1; }
  }), 10_000);
  await withDeadline(() => context.routeWebSocket("**/*", (socket) => {
    counters.websocketRequests += 1;
    try { socket.close(); } catch { counters.routeErrors += 1; }
  }), 10_000);
  context.on("requestfailed", () => { counters.failedRequests += 1; });
  context.on("response", (response) => { if (response.status() >= 400) counters.httpErrors += 1; });
  context.on("page", attachPage);
  return context;
}

async function closeContext(context, name, required = true) {
  const state = contexts.get(context);
  assert.ok(state && state.attempted === false);
  state.attempted = true;
  const resolved = await cleanup(name, () => context.close(), 10_000);
  state.outcome = resolved ? "RESOLVED" : "FAILED";
  if (!resolved && required) throw new Error("CONTEXT_CLOSE_FAILED");
}

async function newPage(context) {
  const page = await acquire(() => context.newPage(), (value) => value.close());
  attachPage(page);
  return page;
}

async function gotoVault(page) {
  await page.goto(`${origin}/?view=local-vault`);
  await page.getByRole("heading", { name: "저장해 두고, 연결까지 다시 찾기", exact: true }).waitFor();
}

async function gotoBackup(page) {
  await page.goto(`${origin}/?view=synthetic-backup`);
  await page.getByRole("heading", { name: "합성 금고 백업 · 복원 연습", exact: true }).waitFor();
}

async function acknowledgeBackup(page) {
  const checkbox = page.locator(".backup-acknowledgement input[type=checkbox]");
  await checkbox.check();
  assert.equal(await checkbox.isChecked(), true);
}

async function selectDiskFile(page, path) {
  const input = page.locator("input[type=file]");
  const chooserPromise = page.waitForEvent("filechooser");
  await input.click();
  const chooser = await chooserPromise;
  assert.equal(chooser.isMultiple(), false);
  await chooser.setFiles(path);
}

async function drainPage(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function semanticRows(page) {
  const rows = await page.locator(".relationship-list > li").evaluateAll((items) => items.map((item, reference) => {
    const text = (value) => (value?.textContent ?? "").replace(/\s+/g, " ").trim();
    const providerName = text(item.querySelector(":scope > .relationship-service"));
    const heading = item.querySelector(":scope > h3");
    const exampleElement = heading?.querySelector(":scope > small") ?? null;
    const example = text(exampleElement);
    const itemName = heading === null ? "" : Array.from(heading.childNodes)
      .filter((node) => node !== exampleElement).map((node) => text(node)).join(" ").trim();
    const summaryElement = Array.from(item.children).find((element) =>
      element.tagName === "P" && !element.classList.contains("relationship-service")) ?? null;
    const summary = text(summaryElement);
    const match = /^(API 키|비밀번호|OAuth 클라이언트|클라우드 접근 키|토큰|복구 코드|사용자 정의) · (사용 중|교체 필요|교체 중|만료됨|노출 의심|폐기됨|비활성|상태 미확인) · 보관된 비밀 필드 (\d+)개 · 연결 (\d+)곳$/.exec(summary);
    const issuerElements = Array.from(item.querySelectorAll(":scope > dl.issuer-context > dt, :scope > dl.issuer-context > dd"));
    const issuerPairs = {};
    for (let index = 0; index < issuerElements.length; index += 2) {
      issuerPairs[text(issuerElements[index])] = text(issuerElements[index + 1]);
    }
    const connections = Array.from(item.querySelectorAll(":scope > ul > li")).map((connection) => ({
      label: text(connection.querySelector(":scope > strong")),
      consumerTypeLabel: text(connection.querySelector(":scope > .consumer-type")),
    }));
    return {
      reference,
      example,
      providerName,
      itemName,
      credentialLabel: match?.[1] ?? "",
      statusLabel: match?.[2] ?? "",
      secretFieldCount: Number(match?.[3] ?? NaN),
      connectionCount: Number(match?.[4] ?? NaN),
      issuer: {
        account: issuerPairs["발급 계정"] ?? "",
        organization: issuerPairs["조직 · 워크스페이스"] ?? "",
        project: issuerPairs["프로젝트"] ?? "",
        environment: issuerPairs["환경"] ?? "",
      },
      connections,
    };
  }));
  assertKnownSyntheticSemantics(rows);
  return rows;
}

async function expectLockedPrivateDom(page, expect) {
  await expect(page.getByTestId("vault-status")).toHaveText("잠김 · 저장된 암호문은 그대로 두고 화면 내용을 비웠습니다.");
  await expect(page.getByTestId("relationship-catalog")).toHaveCount(0);
  await expect(page.locator(".relationship-list > li")).toHaveCount(0);
}

async function probeArchive(page) {
  return await page.evaluate(probeSyntheticArchive,
    { action: "read", acknowledgement: "keyatlas-m05a-synthetic-only" });
}

// Read-only oracle: databases() is checked before open, and onupgradeneeded is
// aborted. Late open success always closes its result, including after timeout.
async function probeSyntheticArchiveRecord() {
  const name = "keyatlas-synthetic-vault-v1";
  const maximumBytes = 524288;
  const deadline = performance.now() + 3000;
  let database = null;
  let transaction = null;
  let openRequest = null;
  let stopped = false;
  let timer;
  const failure = (code) => new Error(code);
  const check = () => { if (stopped || performance.now() >= deadline) throw failure("QA_IDB_TIMEOUT"); };
  const close = (target) => { try { target?.close(); } catch { /* Opaque. */ } };
  const abort = () => { try { transaction?.abort(); } catch { /* Opaque. */ } };
  const stop = () => { stopped = true; abort(); close(database); };
  try {
    if (typeof indexedDB?.databases !== "function") throw failure("QA_IDB_DATABASES_UNAVAILABLE");
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { stop(); reject(failure("QA_IDB_TIMEOUT")); }, 3000); });
    const work = async () => {
      check();
      const databases = await indexedDB.databases();
      check();
      if (!Array.isArray(databases) || databases.length > 64) throw failure("QA_IDB_METADATA");
      const matches = databases.filter((item) => item?.name === name);
      if (matches.length === 0) return { databasePresent: false, bundleStorePresent: false, archivePresent: false };
      if (matches.length !== 1 || !Number.isSafeInteger(matches[0].version) || matches[0].version < 1
        || matches[0].version > 99) {
        throw failure("QA_IDB_METADATA");
      }
      database = await new Promise((resolve, reject) => {
        let settled = false;
        const rejectOpen = (code) => {
          if (settled) return;
          settled = true;
          reject(failure(code));
        };
        openRequest = indexedDB.open(name, matches[0].version);
        openRequest.onblocked = () => rejectOpen("QA_IDB_BLOCKED");
        openRequest.onerror = () => rejectOpen("QA_IDB_ERROR");
        openRequest.onupgradeneeded = () => {
          const opened = openRequest.result;
          try { openRequest.transaction?.abort(); } catch {}
          close(opened);
          rejectOpen("QA_IDB_RACE");
        };
        openRequest.onsuccess = () => {
          const opened = openRequest.result;
          if (settled || stopped) { close(opened); return; }
          settled = true;
          resolve(opened);
        };
      });
      check();
      const version = database.version;
      const stores = Array.from(database.objectStoreNames).sort();
      if (stores.length > 32 || stores.some((value) => typeof value !== "string" || value.length > 128)) {
        throw failure("QA_IDB_METADATA");
      }
      if (!stores.includes("bundle")) {
        return { databasePresent: true, version, stores, bundleStorePresent: false, keys: null, archivePresent: false };
      }
      return await new Promise((resolve, reject) => {
        transaction = database.transaction("bundle", "readonly");
        let keys;
        let archive;
        let settled = false;
        const rejectFixed = (code) => { if (!settled) { settled = true; reject(failure(code)); } };
        transaction.onabort = () => rejectFixed("QA_IDB_ABORT");
        transaction.onerror = () => rejectFixed("QA_IDB_ERROR");
        transaction.oncomplete = async () => {
          if (settled) return;
          try {
            check();
            if (!Array.isArray(keys) || keys.length > 10 || keys.some((key) =>
              typeof key !== "string" || key.length < 1 || key.length > 128)) {
              throw failure("QA_IDB_KEYS");
            }
            keys.sort();
            if (archive === undefined) {
              settled = true;
              resolve({ databasePresent: true, version, stores, bundleStorePresent: true, keys, archivePresent: false });
              return;
            }
            if (!(archive instanceof Uint8Array) || Object.getPrototypeOf(archive) !== Uint8Array.prototype
              || archive.byteLength < 16 || archive.byteLength > maximumBytes) throw failure("QA_IDB_ARCHIVE_INVALID");
            const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(archive));
            check();
            settled = true;
            resolve({ databasePresent: true, version, stores, bundleStorePresent: true, keys, archivePresent: true,
              bytes: archive.byteLength,
              sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") });
          } catch { rejectFixed("QA_IDB_ERROR"); }
        };
        const store = transaction.objectStore("bundle");
        const keysRequest = store.getAllKeys(undefined, 10);
        keysRequest.onerror = () => rejectFixed("QA_IDB_ERROR");
        keysRequest.onsuccess = () => { keys = keysRequest.result; };
        const archiveRequest = store.get("archive");
        archiveRequest.onerror = () => rejectFixed("QA_IDB_ERROR");
        archiveRequest.onsuccess = () => { archive = archiveRequest.result; };
      });
    };
    return await Promise.race([work(), timeout]);
  } catch {
    throw failure("QA_IDB_READ_ONLY_PROBE_FAILED");
  } finally {
    clearTimeout(timer);
    stop();
  }
}

async function readSyntheticKeyspace(page) {
  return await page.evaluate(probeSyntheticArchiveRecord);
}

async function assertDatabaseAbsent(page) {
  assert.deepEqual(await readSyntheticKeyspace(page),
    { databasePresent: false, bundleStorePresent: false, archivePresent: false });
}

async function assertEmptyBundle(page) {
  const record = await readSyntheticKeyspace(page);
  assert.deepEqual(record, { databasePresent: true, version: 1, stores: ["bundle"],
    bundleStorePresent: true, keys: [], archivePresent: false });
}

async function assertCanonicalArchive(page, expected) {
  const record = await readSyntheticKeyspace(page);
  assert.deepEqual(record, { databasePresent: true, version: 1, stores: ["bundle"],
    bundleStorePresent: true, keys: ["archive"], archivePresent: true,
    bytes: expected.bytes, sha256: expected.sha256 });
}

async function saveActualDownload(page, destination, expect) {
  await page.getByRole("button", { name: "합성 백업 파일 준비", exact: true }).click();
  await expect(page.getByTestId("backup-status")).toContainText("파일 준비 완료");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("a.backup-download").click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), SYNTHETIC_BACKUP_FILENAME);
  await download.saveAs(destination);
  assert.equal(await download.failure(), null);
  await expect(page.getByTestId("backup-status")).toContainText("다운로드를 요청했습니다");
}

async function readBoundedArchive(path) {
  const before = await lstat(path);
  assert.equal(before.isFile() && !before.isSymbolicLink(), true);
  assert.ok(before.size >= 16 && before.size <= SYNTHETIC_ARCHIVE_MAX_BYTES);
  const buffer = await readFile(path);
  const after = await lstat(path);
  assert.equal(after.isFile() && !after.isSymbolicLink(), true);
  assert.equal(buffer.byteLength, before.size);
  assert.equal(after.size, before.size);
  const bytes = new Uint8Array(buffer);
  inspectSyntheticArchive(bytes);
  return bytes;
}

async function writeOwnedArchive(path, bytes) {
  assert.ok(bytes instanceof Uint8Array && bytes.byteLength >= 16 && bytes.byteLength <= SYNTHETIC_ARCHIVE_MAX_BYTES);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  const stat = await lstat(path);
  assert.equal(stat.isFile() && !stat.isSymbolicLink(), true);
  assert.equal(stat.size, bytes.byteLength);
}

async function nodeDrain() {
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

try {
  await check("FROZEN_SOURCE_AND_DIST", async () => {
    initialSourceState = await sourceState();
    assert.equal(initialSourceState.baselineHead, EXPECTED_HEAD);
    assert.equal(initialSourceState.committedChangedPaths, 0);
    assert.equal(initialSourceState.workingChangedPaths, 0);
    initialDist = await distSnapshot();
    assert.equal(initialDist.indexSha256, EXPECTED_INDEX_SHA256);
    assert.equal(initialDist.assetsSha256, EXPECTED_ASSETS_SHA256);
    assert.equal(initialDist.assetCount, 4);
    initialProvenance = await provenanceSnapshot();
  });

  await check("OWNED_EVIDENCE_DIRECTORY", async () => {
    await mkdir(REPORT_ROOT, { recursive: true });
    artifactDirectory = await mkdtemp(join(REPORT_ROOT, "backup-roundtrip-"));
    artifactId = basename(artifactDirectory);
    assert.match(artifactId, /^backup-roundtrip-[A-Za-z0-9_-]{6,}$/);
    const stat = await lstat(artifactDirectory);
    assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true);
  });

  const landing = createRequire(new URL("../../landing/package.json", import.meta.url));
  const { chromium } = landing("playwright");
  const { expect } = landing("playwright/test");
  playwrightVersion = landing("playwright/package.json").version;
  assert.match(playwrightVersion, /^\d+\.\d+\.\d+$/);

  await check("ASSET_ONLY_LOOPBACK_SERVER", async () => {
    server = createServer((request, response) => {
      try {
        if (!origin || request.headers.host !== new URL(origin).host) {
          counters.deniedRequests += 1;
          response.writeHead(403).end();
          return;
        }
        if (!["GET", "HEAD"].includes(request.method)) {
          counters.blockedMethods += 1;
          response.writeHead(405).end();
          return;
        }
        const requestUrl = new URL(request.url, origin);
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        response.setHeader("referrer-policy", "no-referrer");
        response.setHeader("cross-origin-opener-policy", "same-origin");
        response.setHeader("content-security-policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
        if (requestUrl.pathname === "/favicon.ico" && requestUrl.search === "") {
          response.writeHead(204).end();
          return;
        }
        if (requestUrl.pathname === "/" && ["", "?view=local-vault", "?view=synthetic-backup"].includes(requestUrl.search)) {
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.writeHead(200);
          response.end(request.method === "HEAD" ? undefined : initialDist.index);
          return;
        }
        if (requestUrl.search !== "") { response.writeHead(404).end(); return; }
        const asset = initialDist.assets.get(requestUrl.pathname);
        if (!asset) { response.writeHead(404).end(); return; }
        response.setHeader("content-type", asset.type);
        response.writeHead(200);
        response.end(request.method === "HEAD" ? undefined : asset.body);
      } catch { counters.serverErrors += 1; response.destroy(); }
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    server.on("error", () => { counters.serverErrors += 1; });
    try {
      await withDeadline(() => new Promise((resolve, reject) => {
        const onError = (error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, "127.0.0.1");
      }), 15_000);
    } catch (error) {
      if (failureCode(error) === "DEADLINE") serverListenTimedOut = true;
      throw error;
    }
    const address = server.address();
    assert.ok(address && typeof address === "object" && address.address === "127.0.0.1");
    origin = `http://127.0.0.1:${address.port}`;
  });

  await check("INSTALLED_BROWSER_LAUNCH", async () => {
    browser = await acquire(() => chromium.launch({
      channel: parsed.channel,
      headless: true,
      timeout: 30_000,
      env: browserEnvironment(),
      downloadsPath: artifactDirectory,
    }), (value) => value.close());
    browserCloseObserver = createIdentityCloseObservation(browser);
    browserVersion = browser.version();
    assert.match(browserVersion, /^\d+(?:\.\d+){1,3}$/);
  });

  const sourcePath = join(artifactDirectory, "source-export.katldemo");
  let sourceSnapshot;
  let sourceRows;
  await check("SOURCE_CREATE_AND_ACTUAL_DOWNLOAD", async () => {
    const context = await createContext(true);
    const page = await newPage(context);
    await gotoVault(page);
    await assertDatabaseAbsent(page);
    await page.getByRole("button", { name: "합성 금고 만들기", exact: true }).click();
    await expect(page.getByTestId("vault-status")).toHaveText("열림 · 저장된 암호문에서 3개 합성 항목을 인증하고 복원했습니다.");
    sourceRows = await semanticRows(page);
    sourceSnapshot = await probeArchive(page);
    assert.equal(sourceSnapshot.archive.bytes >= 16 && sourceSnapshot.archive.bytes <= SYNTHETIC_ARCHIVE_MAX_BYTES, true);
    assert.match(sourceSnapshot.archive.sha256, /^[0-9a-f]{64}$/);
    await assertCanonicalArchive(page, sourceSnapshot.archive);
    await page.getByRole("link", { name: "합성 금고 백업 · 복원 연습", exact: true }).click();
    await page.waitForURL(`${origin}/?view=synthetic-backup`);
    await acknowledgeBackup(page);
    await saveActualDownload(page, sourcePath, expect);
    const afterDownload = await probeArchive(page);
    assert.deepEqual(afterDownload.archive, sourceSnapshot.archive);
    await assertCanonicalArchive(page, sourceSnapshot.archive);
    await drainPage(page);
    await closeContext(context, "SOURCE_CONTEXT_CLOSE");
  }, 60_000);

  let sourceBytes;
  await check("SOURCE_DISK_ARCHIVE_AFTER_CONTEXT_CLOSE", async () => {
    sourceBytes = await readBoundedArchive(sourcePath);
    const descriptor = inspectSyntheticArchive(sourceBytes);
    assert.equal(descriptor.count, 3);
    assert.equal(sourceBytes.byteLength, sourceSnapshot.archive.bytes);
    assert.equal(sha256(sourceBytes), sourceSnapshot.archive.sha256);
    evidence = { ...evidence, archiveBytes: sourceBytes.byteLength, archiveSha256: sha256(sourceBytes),
      semanticRows: sourceRows.length, semanticSha256: sha256(JSON.stringify(sourceRows)), sourceDownload: true };
  });

  const negative = deriveNegativeArchives(sourceBytes);
  const malformedPath = join(artifactDirectory, "malformed-magic.katldemo");
  const corruptedPath = join(artifactDirectory, "corrupted-auth.katldemo");
  const futurePath = join(artifactDirectory, "future-version.katldemo");
  await check("OWNED_NEGATIVE_DISK_ARCHIVES", async () => {
    await writeOwnedArchive(malformedPath, negative.malformed);
    await writeOwnedArchive(corruptedPath, negative.corrupted);
    await writeOwnedArchive(futurePath, negative.future);
  });

  const invalidCases = [
    ["MALFORMED_MAGIC_REJECTED_EMPTY", malformedPath,
      "지원하는 합성 백업 파일이 아닙니다. 파일을 변경하지 않았습니다.", "absent"],
    ["AUTH_CORRUPTION_REJECTED_EMPTY", corruptedPath,
      "백업을 인증하지 못해 저장하지 않았습니다. 손상되었거나 지원하지 않는 파일일 수 있습니다.", "empty"],
    ["FUTURE_VERSION_REJECTED_EMPTY", futurePath,
      "지원하지 않는 백업 버전입니다. 파일과 기존 금고를 보존했습니다.", "absent"],
  ];
  for (const [name, path, message, rejectionStorage] of invalidCases) {
    await check(name, async () => {
      const context = await createContext(false);
      const page = await newPage(context);
      await gotoBackup(page);
      await assertDatabaseAbsent(page);
      await acknowledgeBackup(page);
      await selectDiskFile(page, path);
      await page.getByRole("button", { name: "빈 저장소에 복원", exact: true }).click();
      await expect(page.getByTestId("backup-status")).toHaveText(message);
      await drainPage(page);
      if (rejectionStorage === "absent") await assertDatabaseAbsent(page);
      else await assertEmptyBundle(page);
      await page.getByRole("link", { name: "합성 금고 화면으로 돌아가기", exact: true }).click();
      await page.waitForURL(`${origin}/?view=local-vault`);
      await expectLockedPrivateDom(page, expect);
      await page.getByRole("button", { name: "저장된 합성 금고 열기", exact: true }).click();
      await expect(page.getByTestId("vault-status")).toHaveText("저장된 합성 금고가 없습니다. ‘합성 금고 만들기’를 눌러 시작하세요.");
      await assertEmptyBundle(page);
      await closeContext(context, `${name}_CONTEXT_CLOSE`);
      evidence = { ...evidence, negativeCases: evidence.negativeCases + 1 };
    }, 45_000);
  }

  const reexportPath = join(artifactDirectory, "restored-reexport.katldemo");
  await check("FRESH_CONTEXT_DISK_RESTORE_LOCK_OPEN_REFUSAL_REEXPORT", async () => {
    const context = await createContext(true);
    const page = await newPage(context);
    await gotoBackup(page);
    await assertDatabaseAbsent(page);
    await acknowledgeBackup(page);
    await selectDiskFile(page, sourcePath);
    await page.getByRole("button", { name: "빈 저장소에 복원", exact: true }).click();
    await expect(page.getByTestId("backup-status")).toHaveText(
      "복원 완료 · 빈 저장소에 암호문을 저장하고 같은 바이트인지 확인했습니다. 금고는 잠긴 상태입니다. 금고 화면에서 ‘저장된 합성 금고 열기’로 확인하세요.");
    await assertCanonicalArchive(page, sourceSnapshot.archive);

    await page.getByRole("link", { name: "합성 금고 화면으로 돌아가기", exact: true }).click();
    await page.waitForURL(`${origin}/?view=local-vault`);
    await expectLockedPrivateDom(page, expect);
    await page.getByRole("button", { name: "저장된 합성 금고 열기", exact: true }).click();
    await expect(page.getByTestId("vault-status")).toHaveText("열림 · 저장된 암호문에서 3개 합성 항목을 인증하고 복원했습니다.");
    assert.deepEqual(await semanticRows(page), sourceRows);
    const restoredSnapshot = await probeArchive(page);
    assert.deepEqual(restoredSnapshot.archive, sourceSnapshot.archive);
    await assertCanonicalArchive(page, sourceSnapshot.archive);

    await page.getByRole("link", { name: "합성 금고 백업 · 복원 연습", exact: true }).click();
    await page.waitForURL(`${origin}/?view=synthetic-backup`);
    await acknowledgeBackup(page);
    const beforeRefusal = await probeArchive(page);
    await assertCanonicalArchive(page, sourceSnapshot.archive);
    await selectDiskFile(page, corruptedPath);
    await page.getByRole("button", { name: "빈 저장소에 복원", exact: true }).click();
    await expect(page.getByTestId("backup-status")).toHaveText(
      "이미 금고가 있어 복원하지 않았습니다. 기존 금고는 그대로 보존했습니다.");
    const afterRefusal = await probeArchive(page);
    assert.deepEqual(afterRefusal.archive, beforeRefusal.archive);
    assert.deepEqual(afterRefusal.archive, sourceSnapshot.archive);
    await assertCanonicalArchive(page, sourceSnapshot.archive);

    await page.getByRole("link", { name: "합성 금고 화면으로 돌아가기", exact: true }).click();
    await page.waitForURL(`${origin}/?view=local-vault`);
    await expectLockedPrivateDom(page, expect);
    await page.getByRole("button", { name: "저장된 합성 금고 열기", exact: true }).click();
    await expect(page.getByTestId("vault-status")).toHaveText("열림 · 저장된 암호문에서 3개 합성 항목을 인증하고 복원했습니다.");
    assert.deepEqual(await semanticRows(page), sourceRows);

    await page.getByRole("link", { name: "합성 금고 백업 · 복원 연습", exact: true }).click();
    await page.waitForURL(`${origin}/?view=synthetic-backup`);
    await acknowledgeBackup(page);
    await saveActualDownload(page, reexportPath, expect);
    await assertCanonicalArchive(page, sourceSnapshot.archive);
    await drainPage(page);
    await closeContext(context, "RESTORE_CONTEXT_CLOSE");
    evidence = { ...evidence, freshRestore: true, existingVaultRefusal: true };
  }, 75_000);

  await check("REEXPORT_EXACT_BYTES_AFTER_CONTEXT_CLOSE", async () => {
    const reexportBytes = await readBoundedArchive(reexportPath);
    assert.equal(reexportBytes.byteLength, sourceBytes.byteLength);
    assert.equal(sha256(reexportBytes), sha256(sourceBytes));
    assert.deepEqual(reexportBytes, sourceBytes);
    evidence = { ...evidence, reexportExactBytes: true };
  });

  await check("LATE_ASYNC_DRAIN_AND_ZERO_ERRORS", async () => {
    await nodeDrain();
    assert.ok(Object.values(counters).every((count) => count === 0));
    assert.equal(contexts.size, 5);
    assert.ok([...contexts.values()].every((value) => value.attempted && value.outcome === "RESOLVED"));
    assert.ok(requestedAssets.size >= 4);
  });
  functionalChecksCompleted = true;
} catch (error) {
  primaryFailure = { stage, code: failureCode(error), groupsCompleted: groups.length };
} finally {
  browserCloseObserver?.setPhase("CONTEXT_CLOSE");
  for (const [context, state] of contexts) {
    if (!state.attempted) await closeContext(context, "FINAL_CONTEXT_CLOSE", false);
  }
  if (browser) {
    browserCloseObserver ??= createIdentityCloseObservation(browser);
    try {
      const outcome = await browserCloseObserver.close();
      const boundary = browserCloseObserver.snapshot();
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
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
  }), 10_000);
  if (sockets.size > 0) await cleanup("SOCKET_CLOSE", () => Promise.all([...sockets].map((socket) => new Promise((resolve) => {
    socket.once("close", resolve);
    socket.destroy();
  }))), 5_000);
  if (browserCloseObserver) {
    browserCloseObserver.setPhase("FINAL");
    browserCloseObserver.dispose();
    browserCloseObservation = browserCloseObserver.snapshot();
    if (!browserCloseObservation.passed && browserCloseStep?.outcome === "RESOLVED") browserCloseStep.outcome = "REJECTED";
  }

  try {
    await withDeadline(async () => {
      finalSourceState = await sourceState();
      finalDist = await distSnapshot();
      finalProvenance = await provenanceSnapshot();
    }, 30_000);
    if (!sameSourceState(initialSourceState, finalSourceState) || !sameDist(initialDist, finalDist)
      || !sameProvenance(initialProvenance, finalProvenance)) {
      primaryFailure ??= { stage: "FINAL_SOURCE_IDENTITY", code: "ASSERTION", groupsCompleted: groups.length };
    }
  } catch {
    primaryFailure ??= { stage: "FINAL_SOURCE_IDENTITY", code: "CHECK_FAILED", groupsCompleted: groups.length };
  }
  try { await nodeDrain(); }
  catch { primaryFailure ??= { stage: "FINAL_ASYNC_DRAIN", code: "CHECK_FAILED", groupsCompleted: groups.length }; }

  let browserConnected = null;
  let connectionProbeFailed = false;
  if (browser) {
    try { browserConnected = browser.isConnected(); }
    catch { connectionProbeFailed = true; }
  }
  const contextsConfirmed = [...contexts.values()].every((value) => value.attempted && value.outcome === "RESOLVED");
  const cleanupConfirmed = !acquisitionTimedOut && !serverListenTimedOut && !connectionProbeFailed
    && (!browser || (browserConnected === false && browserCloseObservation?.passed === true))
    && contextsConfirmed && cleanupSteps.every((step) => step.outcome === "RESOLVED")
    && (!server || !server.listening) && sockets.size === 0;
  const zeroErrors = Object.values(counters).every((count) => count === 0);
  const result = primaryFailure || !functionalChecksCompleted || !cleanupConfirmed || !zeroErrors ? "FAIL" : "PASS";
  const report = {
    result,
    startedAt,
    finishedAt: new Date().toISOString(),
    channel: parsed.channel,
    browserVersion,
    baselineHead: initialSourceState?.baselineHead ?? EXPECTED_HEAD,
    actualHead: initialSourceState?.head ?? null,
    productCommittedDiffSha256: initialSourceState?.committedDiffSha256 ?? null,
    productCommittedChangedPaths: initialSourceState?.committedChangedPaths ?? null,
    productStatusSha256: initialSourceState?.statusSha256 ?? null,
    productWorkingChangedPaths: initialSourceState?.workingChangedPaths ?? null,
    finalActualHead: finalSourceState?.head ?? null,
    finalProductCommittedDiffSha256: finalSourceState?.committedDiffSha256 ?? null,
    finalProductCommittedChangedPaths: finalSourceState?.committedChangedPaths ?? null,
    finalProductStatusSha256: finalSourceState?.statusSha256 ?? null,
    finalProductWorkingChangedPaths: finalSourceState?.workingChangedPaths ?? null,
    indexSha256: initialDist?.indexSha256 ?? null,
    assetsSha256: initialDist?.assetsSha256 ?? null,
    finalIndexSha256: finalDist?.indexSha256 ?? null,
    finalAssetsSha256: finalDist?.assetsSha256 ?? null,
    provenanceInitial: initialProvenance,
    provenanceFinal: finalProvenance,
    playwrightVersion,
    groups: groups.length,
    passedGroups: groups,
    primaryFailure,
    counters,
    evidence,
    evidenceId: artifactId,
    requestedAssets: requestedAssets.size,
    realSecretGate: "CLOSED",
    browserCloseObservation,
    cleanup: {
      confirmed: cleanupConfirmed,
      contextsConfirmed,
      acquisitionTimedOut,
      serverListenTimedOut,
      connectionProbeFailed,
      browserConnected,
      serverListening: server?.listening ?? false,
      ownedSocketsRemaining: sockets.size,
      steps: cleanupSteps,
    },
    limits: [
      "synthetic data only; no real password, API key, account, OAuth, recovery or deployment path is exercised",
      "Playwright uses an actual browser download event and disk-backed file input, but this automation is not native OS dialog or manual file-picker evidence",
      "isolated non-persistent browser contexts are not persistent-profile, browser-restart, mobile OS or device-loss proof",
      "byte tampering is not physical disk-corruption, storage durability or recovery-policy proof",
      "request interception is a process-local allowlist, not an OS network sandbox",
      "deadlines bound waiting; no process-kill API, browser install or user-profile attachment is used",
      "owned ignored synthetic ciphertext evidence is retained locally and must never be uploaded",
    ],
  };
  if (artifactDirectory) {
    try { await writeFile(join(artifactDirectory, "result.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
    catch {
      report.result = "FAIL";
      report.primaryFailure ??= { stage: "EVIDENCE_REPORT_WRITE", code: "CHECK_FAILED", groupsCompleted: groups.length };
    }
  }
  process.off("unhandledRejection", onUnhandledRejection);
  process.off("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
  console.log(JSON.stringify(report));
  process.exitCode = report.result === "PASS" ? 0 : 1;
}
