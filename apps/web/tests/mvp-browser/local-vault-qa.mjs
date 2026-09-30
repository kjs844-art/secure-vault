import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenarioSuite, validateBaseUrl, SCENARIO_CHECKS } from "./qa-core.mjs";
import { createScenarios } from "./local-vault-scenarios.mjs";
import { acquireOwned, withDeadline } from "./qa-lifecycle.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DEFAULT_BASE = "http://127.0.0.1:4173/?view=local-vault";
const NOT_VERIFIED = Object.freeze([
  "B05-disk-download-and-fresh-profile-restore", "heap-zeroization", "actual-mobile-and-biometrics",
  "five-minute-and-background-auto-lock", "multiwriter-and-general-upgrade-rollback",
  "benefits-ui-and-M03-V2", "served-build-to-source-binding", "real-secrets-and-production",
]);

class Blocked extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function parseCli(args) {
  if (!Array.isArray(args) || args.length < 1 || args.length > 2
      || args.filter((value) => value === "--synthetic-only").length !== 1) throw new Error("CONFIG");
  let baseUrl = DEFAULT_BASE;
  for (const value of args) {
    if (value === "--synthetic-only") continue;
    if (typeof value !== "string" || !value.startsWith("--base-url=")) throw new Error("CONFIG");
    baseUrl = value.slice("--base-url=".length);
  }
  return { baseUrl: validateBaseUrl(baseUrl) };
}

function gitState() {
  const git = (args) => execFileSync("git", ["-C", REPO, ...args], {
    encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const head = git(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Blocked("SOURCE_UNAVAILABLE");
  const status = git(["status", "--porcelain", "--untracked-files=normal"]);
  return { head, dirty: status.length > 0, status };
}

function preflight() {
  // Fail before opening a browser. Never generate stubs or bypass a blocked build tool.
  for (const folder of ["vault-wasm", "vault-wasm-demo"]) {
    for (const name of ["vault_client_wasm.js", "vault_client_wasm_bg.wasm"]) {
      if (!existsSync(join(REPO, "apps/web/src/generated", folder, name))) throw new Blocked("WASM_NOT_GENERATED");
    }
  }
}

async function isolatedContext(browser, baseUrl, health) {
  if (health.fatal) throw new Error("QA_RUN_QUARANTINED");
  const origin = new URL(baseUrl).origin;
  let context;
  try {
    context = await acquireOwned(() => browser.newContext({
      viewport: { width: 1280, height: 900 }, serviceWorkers: "block", acceptDownloads: false,
    }), (owned) => owned.close(), 15000);
  } catch {
    health.fatal = true;
    health.cleanupConfirmed = false;
    throw new Error("QA_CONTEXT_FAILED");
  }
  let closePromise;
  const close = () => {
    closePromise ??= withDeadline(() => context.close(), 5000).catch(() => {
      health.fatal = true;
      health.cleanupConfirmed = false;
      throw new Error("QA_CONTEXT_CLEANUP_FAILED");
    });
    return closePromise;
  };
  let page;
  let boundaryViolation = false;
  try {
    await withDeadline(async (signal) => {
      signal.addEventListener("abort", () => {
        health.fatal = true;
        void close().catch(() => {});
      }, { once: true });
      const guard = () => { if (signal.aborted) throw new Error("QA_CONTEXT_CANCELLED"); };
      context.setDefaultTimeout(15000);
      context.setDefaultNavigationTimeout(15000);
      await context.route("**/*", (route) => {
        const request = route.request();
        try {
          if (!health.fatal && new URL(request.url()).origin === origin
              && ["GET", "HEAD"].includes(request.method())) return route.continue();
        } catch { /* Treat malformed or non-loopback requests as out of scope. */ }
        boundaryViolation = true;
        return route.abort();
      });
      guard();
      // Production preview needs no WebSocket, permissions, cookies or existing profile.
      await context.routeWebSocket("**/*", (socket) => { boundaryViolation = true; socket.close(); });
      guard();
      context.on("page", (newPage) => {
        if (context.pages().length > 1) {
          boundaryViolation = true;
          void withDeadline(() => newPage.close(), 5000).catch(() => { health.cleanupConfirmed = false; });
        }
      });
      page = await context.newPage();
      guard();
    }, 15000);
    return {
      page,
      assertBoundary() { if (boundaryViolation) throw new Error("QA_NETWORK_BOUNDARY"); },
      async close() {
        await close();
        if (boundaryViolation) throw new Error("QA_NETWORK_BOUNDARY");
      },
    };
  } catch {
    health.fatal = true;
    await close();
    throw new Error("QA_CONTEXT_FAILED");
  }
}

export async function main(args) {
  let config;
  try { config = parseCli(args); }
  catch { return { status: "BLOCKED", code: "CONFIG", exitCode: 2, reportPath: null }; }

  const report = {
    schema: "keyatlas.synthetic-browser-qa.v2", runId: randomUUID(),
    startedAt: new Date().toISOString(), finishedAt: null,
    baseUrl: config.baseUrl, sourceHead: null, sourceDirty: null,
    nodeVersion: process.version, browserVersion: null, playwrightVersion: null, cleanupConfirmed: true,
    status: "BLOCKED", code: "NOT_STARTED", exitCode: 2,
    scenarios: Object.keys(SCENARIO_CHECKS).map((id) => ({ id, status: "NOT_RUN", code: "NOT_STARTED", evidence: null })),
    notVerified: NOT_VERIFIED,
  };
  let browser;
  let startState;
  const health = { fatal: false, cleanupConfirmed: true };
  try {
    startState = gitState();
    report.sourceHead = startState.head;
    report.sourceDirty = startState.dirty;
    preflight();
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
      const version = createRequire(import.meta.url)("playwright/package.json").version;
      if (typeof version !== "string" || !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(version)) {
        throw new Error("QA_RUNTIME_VERSION");
      }
      report.playwrightVersion = version;
    }
    catch { throw new Blocked("BROWSER_RUNTIME_UNAVAILABLE"); }
    // No CDP attach, launchPersistentContext, storageState, executable override or auth restore.
    try {
      browser = await acquireOwned(() => chromium.launch({ headless: true, timeout: 15000 }),
        (owned) => owned.close(), 20000);
    } catch {
      health.cleanupConfirmed = false;
      throw new Blocked("BROWSER_LAUNCH_UNAVAILABLE");
    }
    const version = browser.version();
    if (!/^[0-9]+(?:\.[0-9]+){1,4}$/.test(version)) throw new Blocked("BROWSER_VERSION_UNAVAILABLE");
    report.browserVersion = version;
    const scenarios = createScenarios(config.baseUrl).map(({ id, run }) => ({
      id,
      async run(context) {
        const result = await withDeadline((signal) => {
          signal.addEventListener("abort", () => {
            health.fatal = true;
            void context.close().catch(() => { health.cleanupConfirmed = false; });
          }, { once: true });
          return run(context);
        }, 60000);
        context.assertBoundary();
        return result;
      },
    }));
    const result = await runScenarioSuite({ scenarios, createContext: () => isolatedContext(browser, config.baseUrl, health) });
    report.scenarios = result.scenarios;
    report.exitCode = result.exitCode;
    report.status = result.exitCode === 0 ? "PASS" : "FAIL";
    report.code = result.exitCode === 0 ? "OK" : "SCENARIO_FAILURE";
    const endState = gitState();
    if (endState.head !== startState.head || endState.status !== startState.status) {
      report.status = "FAIL"; report.code = "SOURCE_CHANGED"; report.exitCode = 1;
    }
  } catch (error) {
    report.status = error instanceof Blocked ? "BLOCKED" : "FAIL";
    report.code = error instanceof Blocked ? error.code : "RUN_FAILED";
    report.exitCode = error instanceof Blocked ? 2 : 1;
  } finally {
    if (browser) {
      try { await withDeadline(() => browser.close(), 5000); }
      catch {
        health.cleanupConfirmed = false;
        report.status = "FAIL"; report.code = "BROWSER_CLEANUP_FAILED"; report.exitCode = 1;
      }
    }
  }
  report.cleanupConfirmed = health.cleanupConfirmed;
  if (!health.cleanupConfirmed && report.status === "PASS") {
    report.status = "FAIL"; report.code = "CLEANUP_UNCONFIRMED"; report.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  try {
    // Generated evidence is outside Git, in a new directory; never overwrite a prior report.
    const directory = mkdtempSync(join(tmpdir(), "keyatlas-m05a-synthetic-"));
    const reportPath = join(directory, "report.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { status: report.status, code: report.code, exitCode: report.exitCode, reportPath };
  } catch {
    return { status: "FAIL", code: "REPORT_WRITE_FAILED", exitCode: 1, reportPath: null };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Print only fixed codes and the generated report path, never a raw exception or page text.
  const outcome = await main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(outcome) + "\n");
  process.exitCode = outcome.exitCode;
}
