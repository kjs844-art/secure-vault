// SYNTHETIC ONLY: node --import tsx scripts/verify-candidate-review-browser.ts --synthetic-only
// Actual product composition, native HTTP/Chrome; test-only host and memory ports.
// Optional --bootstrap-diagnostic narrows execution to eight fresh React bootstrap/create cycles.
// Optional --bootstrap-after-history requires --bootstrap-diagnostic and precedes each cycle with held-completion native back navigation.
// Optional --native-network-diagnostics adds bounded CDP/server observations; may perturb timing/BFCache.
// Optional --candidate-cleanup-experiment=observe|omit_perform_success_discard transforms only the in-memory test bundle, never product files.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { build } from "vite";
import { CandidateReviewHarness } from "./fixtures/candidate-review-fixture.tsx";
import { observeUnexpectedTransport, type ReadHelperTrace } from "./support/unexpected-transport-observation.ts";
import { createNativeNetworkDiagnostics, type ServerDiagnosticEvent } from "./support/native-network-diagnostics.ts";
import { classifyNativeLifecycleEvidence } from "./support/native-lifecycle-evidence.ts";
import { createExpectedAbortArm } from "./support/expected-abort-arm.ts";
import { CANDIDATE_CLEANUP_EXPERIMENT_KEY, transformCandidateCleanupExperiment,
  type CandidateCleanupExperimentMode } from "./support/candidate-cleanup-experiment.ts";
import { createCandidateSelectionFixture } from "../tests/support/candidate-selection-fixture.ts";
import { SYNTHETIC_PRIVATE } from "../tests/support/review-memory-store.ts";
import { createReviewHttpHandler } from "../src/server/http/review-http.ts";
import { createInboxHttpHandler } from "../src/server/http/inbox-http.ts";
import { createInboxDiscardHttpHandler } from "../src/server/http/inbox-discard-http.ts";
import { INBOX_DISCARD_REQUEST_HEADER } from "../src/server/http/inbox-discard-http-contracts.ts";
import { createCandidateBatchReferences } from "../src/server/inbox/batch-references.ts";
import type { ReviewAuthority } from "../src/server/review/contracts.ts";
import { createCatalogHttpHandler } from "../src/server/http/catalog-http.ts";
import { CATALOG_REQUEST_HEADER } from "../src/server/http/catalog-http-contracts.ts";
import { createServiceCatalog } from "../src/server/catalog/service-catalog.ts";
import { decodeCatalogSuccess } from "../src/domain/catalog-client/responses.ts";
import { INBOX_REQUEST_HEADER } from "../src/server/http/inbox-http-contracts.ts";
import { MAX_REVIEW_REQUEST_BYTES, MAX_REVIEW_RESPONSE_BYTES, REVIEW_REQUEST_HEADER } from "../src/server/http/review-http-contracts.ts";

const landing = createRequire(new URL("../../landing/package.json", import.meta.url));
const { chromium } = landing("playwright") as typeof import("../../landing/node_modules/playwright/index.js");
const { expect } = landing("playwright/test") as typeof import("../../landing/node_modules/playwright/test.js");
type Browser = Awaited<ReturnType<typeof chromium.launch>>;
type Context = Awaited<ReturnType<Browser["newContext"]>>;
type Page = Awaited<ReturnType<Context["newPage"]>>;
type BrowserRequest = import("../../landing/node_modules/playwright/index.js").Request;
type EventSample = { type: string; trusted: boolean; persisted: boolean | null; open: string | null; privateNodes: number };
declare global { interface Window { candidateProbe?: { marker: string; events: EventSample[]; detach: () => void };
  candidateExpiryObserved?: number | null } }
const args = process.argv.slice(2), developmentEffects = args.includes("--development-effects");
const discardOnly = args.includes("--discard-only");
const bootstrapDiagnostic = args.includes("--bootstrap-diagnostic"), BOOTSTRAP_CYCLES = 8;
const bootstrapAfterHistory = args.includes("--bootstrap-after-history");
const nativeNetworkDiagnosticsEnabled = args.includes("--native-network-diagnostics");
const cleanupExperimentArgument = args.find((flag) => flag.startsWith("--candidate-cleanup-experiment="));
const cleanupExperiment = cleanupExperimentArgument?.slice("--candidate-cleanup-experiment=".length) as CandidateCleanupExperimentMode | undefined;
const browserChannel = process.env.BROWSER_CHANNEL ?? "chrome";
const report = { scope: discardOnly ? "ACTUAL_CANDIDATE_DISCARD_SYNTHETIC_HTTP" : bootstrapAfterHistory ? "ACTUAL_REACT_HISTORY_BOOTSTRAP_DIAGNOSTIC_SYNTHETIC_HTTP"
  : bootstrapDiagnostic ? "ACTUAL_REACT_BOOTSTRAP_DIAGNOSTIC_SYNTHETIC_HTTP" : "ACTUAL_CANDIDATE_REVIEW_COMPOSITION_SYNTHETIC_HTTP",
  mode: discardOnly ? "DISCARD_ONLY" : bootstrapAfterHistory ? "BOOTSTRAP_AFTER_HISTORY_DIAGNOSTIC"
    : bootstrapDiagnostic ? "BOOTSTRAP_DIAGNOSTIC" : "FULL_COMPOSITION", stage: "preflight", status: "BLOCKED",
  startedAt: new Date().toISOString(), groups: [] as string[], observations: {} as Record<string, unknown>,
  limits: [discardOnly ? "Focused candidate-discard regression only; earlier full-composition groups are not executed"
    : bootstrapDiagnostic
    ? "Diagnostic only: eight fresh-document cycles alternate seeded-two/empty-zero services, read completion/catalog/two candidates, create once and close; not full composition or root-cause proof"
    : "Full composition mode; the opt-in bootstrap diagnostic is not executed",
    ...(bootstrapAfterHistory ? ["Each diagnostic cycle first holds an actual completion request, natively leaves and returns closed, then takes a separate baseline for the existing four read/create requests",
      "BFCache requires the existing same-document marker and trusted persisted pagehide/pageshow evidence; otherwise the navigation is HISTORY_ONLY and the run remains INCONCLUSIVE, not proof of BFCache",
      "History no-auto-I/O observations cover native return through the next explicit Open; no fixed sleep or native-request terminal barrier is added"] : []),
    "Test-only host mounts actual catalog/inbox/review handlers and reference issuer/resolver, not production routes or real auth/Gmail/DB",
    "Test-only completion endpoint delivers a run-specific saved receipt; not production delivery/authentication or durable recovery",
    "Actual runMailAnalysis handoff and catalog/inbox/review controllers use serialized synthetic memory ports",
    "Only one known batch is loaded; no full inbox enumeration or provider discovery",
    developmentEffects ? "Development StrictMode replay is measured after explicit keyed remount, not initial hydration or dev server/HMR"
      : "Production fixture bundle uses StrictMode wrapper and explicit keyed remount, not development effect replay",
    "Only public closed fixture HTML is max-age=0; observation and actual review responses stay no-store",
    "Short test grant precedes real staging; clocks/native navigation events are not fabricated; controlled visibility is separately labeled",
    "Passive native lifecycle observer follows product listeners; not all listener orderings",
    "Standalone hidden-document tests override document.hidden and dispatch untrusted events; not native tab/OS hide evidence",
    "Installed Chrome/Edge are both Chromium-based; no Firefox/WebKit or real mobile-device engine coverage",
    "Local close cannot recall already returned JS values or undo committed writes",
    "Read-signal snapshots are passive same-document ordinal correlation, not cross-realm object identity or causal proof; sampling can perturb timing",
    "Bounded buffered test bridge, not production streaming/backpressure or durable concurrency evidence"] };
const errors = { bridge: 0, page: 0, console: 0, external: 0, websocket: 0, csp: 0, transport: 0 };
// Only static stages and numeric status are retained. Do not log URLs, payloads,
// headers or adapter exception text when diagnosing a late network event.
const requestStages = new WeakMap<object, string>(), responseStatuses = new WeakMap<object, number>();
const requestReadHelpers = new WeakMap<object, ReadHelperTrace>();
let nativeDiagnostics: ReturnType<typeof createNativeNetworkDiagnostics> | undefined;
const nativeDiagnosticDetachers: (() => void)[] = [];
const cleanupExperimentDocuments: { performSuccess: number; performOther: number; discardInvoked: number;
  discardOmitted: number; overflow: boolean }[] = [];
const readSignalCounts = { catalog: { total: 0, abortObserved: 0 }, candidate: { total: 0, abortObserved: 0 } };
let readHelperOrdinal = 0, nativeApiRequestStarts = 0;
const sockets = new Set<Socket>(), responses = new Set<ServerResponse>(), idle = new Set<() => void>();
const assets = new Map<string, { body: string | Uint8Array; type: string }>();
const wire: { action: string; status: number; digest: string; requestBytes: number; responseBytes: number }[] = [];
const reads: { status: number; code: string | null; requestBytes: number; responseBytes: number }[] = [];
const discardWire: { status: number; digest: string; requestBytes: number; responseBytes: number }[] = [];
let expectedDiscardStatus: number | null = null;
const matchedDiscardStatuses: number[] = [];
let holdNextDiscard = false, releaseDiscard: (() => void) | null = null;
function releaseHeldDiscard() { releaseDiscard?.(); }
const catalogWire: { status: number; code: string | null; cursor: boolean; requestBytes: number; responseBytes: number }[] = [];
const catalogMutationWire: { action: "create" | "update" | "delete"; status: number; code: string | null; digest: string; replayed: boolean | null;
  state: string | null; responseWriteAttempted: boolean; requestBytes: number; responseBytes: number }[] = [];
const COOKIE = "synthetic-candidate-session";
// All fixture consumers follow awaited freshFixture(); preflight/finally check
// existence separately so a failed acquisition does not imply initialized state.
let fixture!: Awaited<ReturnType<typeof createCandidateSelectionFixture>>;
let handler: ReturnType<typeof createReviewHttpHandler>;
let inboxHandler: ReturnType<typeof createInboxHttpHandler>;
let discardHandler: ReturnType<typeof createInboxDiscardHttpHandler>;
let catalogHandler: ReturnType<typeof createCatalogHttpHandler>;
let origin = "", html = "", active = 0, expected503 = false, matched503 = 0;
let expected401 = false, matched401 = 0;
let expected404 = false, matched404 = 0;
let expected403 = false, matched403 = 0, revokeDuringReferenceRead = false;
let completions = 0, completionAborts = 0, invalidNextCompletion = false;
let holdNextCompletion = false, releaseCompletion: (() => void) | null = null, matchedCompletionAborts = 0;
const expectedCompletionAborts = new Set<object>();
function releaseHeldCompletion() { releaseCompletion?.(); }
let expectedCatalog409 = false, matchedCatalog409 = 0, expectedCatalog401 = false, matchedCatalog401 = 0;
let expectedCreate503 = false, matchedCreate503 = 0, expectedCreate401 = false, matchedCreate401 = 0;
let expectedUpdate503 = false, matchedUpdate503 = 0, expectedUpdate409 = false, matchedUpdate409 = 0,
  expectedUpdate401 = false, matchedUpdate401 = 0;
let expectedDelete503 = false, matchedDelete503 = 0, expectedDelete409 = false, matchedDelete409 = 0,
  expectedDelete401 = false, matchedDelete401 = 0;
let failNextCreatedAcknowledgement = false;
let failNextUpdatedAcknowledgement = false;
let failNextDeletedAcknowledgement = false;
let matchedCreateAborts = 0;
const expectedCreateAborts = new Set<object>();
let matchedUpdateAborts = 0;
const expectedUpdateAborts = new Set<object>();
let matchedDeleteAborts = 0;
const expectedDeleteAborts = new Set<object>();
let holdNextCreateReply = false, releaseCreateReply: (() => void) | null = null;
function releaseHeldCreateReply() { releaseCreateReply?.(); }
let holdNextPreviewReply = false, releasePreviewReply: (() => void) | null = null;
function releaseHeldPreviewReply() { releasePreviewReply?.(); }
let holdNextGetReply = false, releaseGetReply: (() => void) | null = null;
function releaseHeldGetReply() { releaseGetReply?.(); }
let holdNextRead = false, releaseRead: (() => void) | null = null, matchedReadAborts = 0;
const expectedReadAborts = new Set<object>();
function releaseHeldRead() { releaseRead?.(); }
let holdNextCatalog = false, releaseCatalog: (() => void) | null = null, matchedCatalogAborts = 0;
const expectedCatalogAborts = new Set<object>();
const expectedAbortSets = new Map<string, Set<object>>([
  ["/__candidate_completion", expectedCompletionAborts], ["/api/inbox/batch", expectedReadAborts],
  ["/api/catalog/list", expectedCatalogAborts], ["/api/catalog/create", expectedCreateAborts],
  ["/api/catalog/update", expectedUpdateAborts], ["/api/catalog/delete", expectedDeleteAborts],
]);
const expectedAbortArms = new Map<string, { page: Page; arm: ReturnType<typeof createExpectedAbortArm> }>();
const expectedAbortArmCounts = { armed: 0, claimed: 0, mismatched: 0 };
function armExpectedAbort(route: string, page: Page) {
  assert.ok(expectedAbortSets.has(route), "CANDIDATE_ABORT_ARM_ROUTE");
  assert.equal(expectedAbortArms.has(route), false, "CANDIDATE_UNCONSUMED_ABORT_ARM");
  expectedAbortArms.set(route, { page, arm: createExpectedAbortArm(page, report.stage) });
  expectedAbortArmCounts.armed++;
}
function observeExpectedAbortRequest(request: BrowserRequest) {
  if (request.method() !== "POST") return;
  for (const [route, target] of expectedAbortSets) {
    if (request.url() !== origin + route) continue;
    const entry = expectedAbortArms.get(route);
    if (!entry) return;
    expectedAbortArms.delete(route);
    let owner: Page | null = null;
    try { owner = request.frame().page(); } catch { /* Unknown owner never receives an allowance. */ }
    if (entry.arm.claim(owner, report.stage)) {
      expectedAbortArmCounts.claimed++; target.add(request);
    } else {
      expectedAbortArmCounts.mismatched++; errors.transport++;
    }
    return;
  }
}
function releaseHeldCatalog() { releaseCatalog?.(); }
let browser: Browser | undefined, context: Context | undefined, failed = false, inconclusive = false;
const pass = (name: string) => report.groups.push(name);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const clock = () => (fixture.store.controls.now = Date.now());
function bounded<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("CANDIDATE_DEADLINE")), ms); })])
    .finally(() => { if (timer !== undefined) clearTimeout(timer); });
}
async function whenIdle() {
  if (!active) return;
  let listener!: () => void;
  await bounded(new Promise<void>((resolve) => { listener = resolve; idle.add(listener); })).finally(() => idle.delete(listener));
}
async function freshFixture(window = 86400000, seedServices = true) {
  assert.equal(active, 0); fixture = await createCandidateSelectionFixture(Date.now(), window, () => `synthetic-${randomUUID()}`, seedServices);
  assert.deepEqual(fixture.completionReceipt, { schema: "keyatlas.candidate-batch-saved.v1", state: "saved",
    batchReference: fixture.locator.batchReference, dataGeneration: fixture.locator.dataGeneration });
  fixture.store.controls.beforeEntry = () => { clock(); };
  fixture.store.controls.beforeCommit = () => { clock(); };
}
async function emptyServiceFixture() {
  // A genuinely unseeded synthetic catalog, not deletion/reset of old rows.
  await freshFixture(86400000, false);
}
function noPrivate(value: unknown) {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!["ownerId", "sessionId", "sessionRevision", "cookie", "authority", "source", "analysisOperationId",
      "mailboxBindingId", "candidateIndex", "fingerprint", "operationId", "replayed", "quote"].includes(key), "CANDIDATE_PRIVATE_RESPONSE");
    noPrivate(child);
  }
}
function observeServerSpan(ordinal: number | null | undefined, event: ServerDiagnosticEvent,
  response: ServerResponse, status: number | null = response.headersSent ? response.statusCode : null) {
  nativeDiagnostics?.serverEvent(ordinal, event, { status, headersSent: response.headersSent,
    writableEnded: response.writableEnded, writableFinished: response.writableFinished, destroyed: response.destroyed });
}
async function bridge(message: IncomingMessage, response: ServerResponse) {
  active++; responses.add(response);
  const nativeSpan = nativeDiagnostics?.serverStarted(message.method, message.url);
  const abort = new AbortController(), timer = setTimeout(() => {
    if (nativeDiagnostics) observeServerSpan(nativeSpan, "timeout", response);
    abort.abort(); response.destroy();
  }, 12000);
  response.on("error", () => undefined); message.on("error", () => undefined);
  response.once("close", () => { if (!response.writableEnded) abort.abort(); });
  if (nativeDiagnostics) {
    response.once("finish", () => observeServerSpan(nativeSpan, "finish", response));
    response.once("close", () => observeServerSpan(nativeSpan, "close", response));
    response.once("error", () => observeServerSpan(nativeSpan, "error", response));
  }
  try {
    assert.equal(message.headers.host, new URL(origin).host);
    assert.equal(message.headers["sec-fetch-site"], "same-origin");
    assert.equal(message.headers.cookie, `synthetic-session=${COOKIE}`);
    assert.equal(message.headers.authorization, undefined);
    assert.equal(message.method, "POST"); assert.equal(message.headers.origin, origin);
    const completionRead = message.url === "/__candidate_completion";
    const candidateRead = message.url === "/api/inbox/batch", catalogRead = message.url === "/api/catalog/list";
    const candidateDiscard = message.url === "/api/inbox/discard";
    const catalogCreate = message.url === "/api/catalog/create", catalogUpdate = message.url === "/api/catalog/update";
    const catalogDelete = message.url === "/api/catalog/delete";
    const catalogMutation = catalogCreate || catalogUpdate || catalogDelete;
    assert.equal(message.headers["x-keyatlas-request"], completionRead ? "synthetic-completion-observation"
      : candidateRead ? INBOX_REQUEST_HEADER : candidateDiscard ? INBOX_DISCARD_REQUEST_HEADER
        : catalogRead || catalogMutation ? CATALOG_REQUEST_HEADER : REVIEW_REQUEST_HEADER);
    const chunks: Buffer[] = []; let count = 0;
    for await (const raw of message) { const part = Buffer.from(raw); count += part.length;
      assert.ok(count <= MAX_REVIEW_REQUEST_BYTES); chunks.push(part); }
    const body = Buffer.concat(chunks), headers = new Headers();
    if (completionRead) {
      assert.equal(body.toString("utf8"), "{}"); completions++;
      const counts = fixture.readAnalysisCounts();
      const completion = invalidNextCompletion ? { ...fixture.completionReceipt, dataGeneration: 2 } : fixture.completionReceipt;
      invalidNextCompletion = false;
      if (holdNextCompletion) {
        holdNextCompletion = false;
        await new Promise<void>((resolve) => {
          const finish = () => { abort.signal.removeEventListener("abort", finish); resolve(); };
          releaseCompletion = finish; abort.signal.addEventListener("abort", finish, { once: true });
          if (abort.signal.aborted) finish();
        });
        releaseCompletion = null;
      }
      assert.deepEqual(fixture.readAnalysisCounts(), counts, "COMPLETION_MUST_NOT_RERUN_ANALYSIS");
      noPrivate(completion);
      if (abort.signal.aborted) { completionAborts++; return; }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      if (nativeDiagnostics) observeServerSpan(nativeSpan, "end_attempt", response, 200);
      response.end(JSON.stringify(completion)); return;
    }
    for (const [key, value] of Object.entries(message.headers)) if (value !== undefined)
      for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
    const result = await (candidateRead ? inboxHandler : candidateDiscard ? discardHandler : catalogRead || catalogMutation ? catalogHandler : handler)(new Request(origin + message.url, { method: "POST", headers, body: new Uint8Array(body), signal: abort.signal }));
    const bytes = new Uint8Array(await result.arrayBuffer()); assert.ok(bytes.length <= MAX_REVIEW_RESPONSE_BYTES);
    const text = new TextDecoder().decode(bytes), parsed: unknown = JSON.parse(text);
    let createReceipt: Extract<ReturnType<typeof decodeCatalogSuccess>, { kind: "receipt" }> | null = null;
    if (catalogMutation && result.status === 200) {
      // Only the documented public receipt may echo the client operation ID.
      // Never weaken the private-field rejection on list/inbox/review responses.
      const envelope = parsed as { ok: unknown; value: unknown };
      assert.deepEqual(Object.keys(envelope).sort(), ["ok", "value"]); assert.equal(envelope.ok, true);
      const decoded = decodeCatalogSuccess(catalogCreate ? "create" : catalogUpdate ? "update" : "delete", envelope.value); assert.equal(decoded?.kind, "receipt");
      assert.ok(decoded?.kind === "receipt"); createReceipt = decoded;
      assert.equal(decoded.receipt.operationId, (JSON.parse(body.toString("utf8")) as { operationId: string }).operationId);
      noPrivate(decoded.receipt.service);
    } else noPrivate(parsed);
    assert.ok(!text.includes(SYNTHETIC_PRIVATE));
    assert.match(result.headers.get("cache-control") ?? "", /no-store/);
    assert.ok(!result.headers.has("set-cookie") && !result.headers.has("access-control-allow-origin"));
    if (catalogMutation && holdNextCreateReply) {
      holdNextCreateReply = false;
      await new Promise<void>((resolve) => {
        const finish = () => { abort.signal.removeEventListener("abort", finish); resolve(); };
        releaseCreateReply = finish; abort.signal.addEventListener("abort", finish, { once: true });
        if (abort.signal.aborted) finish();
      });
      releaseCreateReply = null;
    }
    if (message.url === "/api/review/preview" && holdNextPreviewReply) {
      // Test-only scheduling gate after the real preview handler completes.
      // Preserve its response and transaction; delay only transport observation.
      holdNextPreviewReply = false;
      await new Promise<void>((resolve) => {
        const finish = () => { abort.signal.removeEventListener("abort", finish); resolve(); };
        releasePreviewReply = finish; abort.signal.addEventListener("abort", finish, { once: true });
        if (abort.signal.aborted) finish();
      });
      releasePreviewReply = null;
    }
    if (message.url === "/api/review/get" && holdNextGetReply) {
      // Delay transport only after the actual read handler; no fabricated DTO.
      holdNextGetReply = false;
      await new Promise<void>((resolve) => {
        const finish = () => { abort.signal.removeEventListener("abort", finish); resolve(); };
        releaseGetReply = finish; abort.signal.addEventListener("abort", finish, { once: true });
        if (abort.signal.aborted) finish();
      });
      releaseGetReply = null;
    }
    if (candidateRead) reads.push({ status: result.status, code: result.status === 200 ? null : (JSON.parse(text) as { code: string }).code,
      requestBytes: body.length, responseBytes: bytes.length });
    else if (candidateDiscard) {
      assert.ok(body.length <= 1024 && bytes.length <= 2048);
      discardWire.push({ status: result.status, digest: digest(body), requestBytes: body.length, responseBytes: bytes.length });
    }
    else if (catalogRead) catalogWire.push({ status: result.status, code: result.status === 200 ? null : (JSON.parse(text) as { code: string }).code,
      cursor: (JSON.parse(body.toString("utf8")) as { cursor: unknown }).cursor !== null, requestBytes: body.length, responseBytes: bytes.length });
    else if (catalogMutation) catalogMutationWire.push({ action: catalogCreate ? "create" : catalogUpdate ? "update" : "delete", status: result.status,
      code: result.status === 200 ? null : (JSON.parse(text) as { code: string }).code, digest: digest(body),
      replayed: createReceipt?.receipt.replayed ?? null, state: createReceipt?.receipt.service.state ?? null,
      responseWriteAttempted: !abort.signal.aborted && !response.destroyed,
      requestBytes: body.length, responseBytes: bytes.length });
    else wire.push({ action: message.url!.split("/").at(-1)!, status: result.status, digest: digest(body), requestBytes: body.length, responseBytes: bytes.length });
    if (!abort.signal.aborted && !response.destroyed) {
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (nativeDiagnostics) observeServerSpan(nativeSpan, "end_attempt", response, result.status);
      response.end(bytes);
    }
  } catch { errors.bridge++; response.destroy(); }
  finally {
    clearTimeout(timer);
    if (nativeDiagnostics) observeServerSpan(nativeSpan, "bridge_released", response);
    responses.delete(response); active--; if (!active) for (const done of idle) done();
  }
}
const server = createServer((request, response) => {
  response.setHeader("cache-control", "max-age=0");
  response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  if (request.url === "/api/catalog/list" || request.url === "/api/catalog/create" || request.url === "/api/catalog/update" || request.url === "/api/catalog/delete" || request.url === "/api/inbox/batch" || request.url === "/api/inbox/discard" || request.url === "/__candidate_completion") { void bridge(request, response); return; }
  if (/^\/api\/review\/(preview|confirm|reject|delete|get|list)$/.test(request.url ?? "")) { void bridge(request, response); return; }
  if (request.method !== "GET" && request.method !== "HEAD") { response.statusCode = 405; response.end(); return; }
  if (request.url === "/__candidate.html") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); }
  else if (request.url === "/__candidate_away.html") { response.setHeader("content-type", "text/html; charset=utf-8");
    response.end('<!doctype html><html><head><link rel="icon" href="data:,"></head><body>Public synthetic away document</body></html>'); }
  else if (assets.has(request.url ?? "")) { const asset = assets.get(request.url!)!; response.setHeader("content-type", asset.type); response.end(asset.body); }
  else { response.statusCode = 404; response.end(); }
});
server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
const panel = (page: Page) => page.getByTestId("review-workspace-panel");
const form = (page: Page) => page.getByRole("form", { name: "선택한 혜택 초안" });
const click = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).click();
async function closed(page: Page) { await expect(panel(page)).toHaveAttribute("data-open", "no"); await expect(page.getByTestId("review-workspace-content")).toHaveCount(0); }
async function traceReadHelper(page: Page, helper: ReadHelperTrace["helper"], route: "/api/inbox/batch" | "/api/catalog/list",
  expectedPhase: ReadHelperTrace["expectedPhase"], responses: readonly { status: number }[], read: () => Promise<void>) {
  const before = responses.length;
  const probeBefore = await page.evaluate(() => window.candidateReadTransportSnapshot?.());
  assert.ok(probeBefore, "READ_HELPER_SIGNAL_PROBE_MISSING");
  const trace: ReadHelperTrace = { helper, ordinal: ++readHelperOrdinal, expectedPhase, requestCount: 0, wireDelta: 0,
    loadedPhaseObserved: false, oneSuccessfulWireObserved: false, helperCompleted: false, transportAtHelperCompletion: null };
  const observeRequest = (request: BrowserRequest) => {
    if (request.url() !== origin + route || request.method() !== "POST") return;
    trace.requestCount++;
    requestReadHelpers.set(request, trace);
  };
  // Observe this page's exact request objects, not merely a matching stage. No
  // extra Fetch/body read, pending request-wait promise, or cancellation rule.
  page.on("request", observeRequest);
  try {
    await read();
    trace.loadedPhaseObserved = true;
    trace.wireDelta = responses.length - before;
    // The bridge records before response.end; this is supporting host evidence,
    // not an exact-request native terminal/body-consumption observation.
    trace.oneSuccessfulWireObserved = trace.wireDelta === 1 && responses[before]?.status === 200;
    assert.equal(trace.requestCount, 1, "READ_HELPER_EXPECTS_ONE_REQUEST");
    assert.equal(trace.wireDelta, 1, "READ_HELPER_EXPECTS_ONE_NEW_WIRE");
    assert.equal(trace.oneSuccessfulWireObserved, true, "READ_HELPER_EXPECTS_HTTP_200");
    const probeAfter = await page.evaluate(() => window.candidateReadTransportSnapshot?.());
    assert.ok(probeAfter, "READ_HELPER_SIGNAL_PROBE_DISAPPEARED");
    assert.equal(probeAfter.dropped, probeBefore.dropped, "READ_HELPER_SIGNAL_PROBE_OVERFLOW");
    assert.equal(probeAfter.total - probeBefore.total, 1, "READ_HELPER_EXPECTS_ONE_SIGNAL_OBSERVATION");
    const observations = probeAfter.records.filter((item) => item.ordinal > probeBefore.total);
    assert.equal(observations.length, 1, "READ_HELPER_SIGNAL_CORRELATION_AMBIGUOUS");
    assert.equal(observations[0]!.route, route, "READ_HELPER_SIGNAL_ROUTE_MISMATCH");
    // One native Request and one same-route probe call in this helper window
    // establish unique correlation, not cross-realm object identity or causality.
    trace.transportAtHelperCompletion = observations[0]!;
    const counts = helper === "nextCatalog" ? readSignalCounts.catalog : readSignalCounts.candidate;
    counts.total++; if (observations[0]!.abortObserved) counts.abortObserved++;
    trace.helperCompleted = true;
  } finally {
    trace.wireDelta = responses.length - before;
    page.off("request", observeRequest);
  }
}
async function reload(page: Page) {
  await traceReadHelper(page, "reload", "/api/inbox/batch", "ready", reads, async () => {
    await click(page, "후보 불러오기·새로 확인"); await expect(page.getByTestId("candidate-loader")).toHaveAttribute("data-phase", "ready");
  });
}
async function nextCatalog(page: Page, phase: "more" | "end_observed" = "end_observed") {
  await traceReadHelper(page, "nextCatalog", "/api/catalog/list", phase, catalogWire, async () => {
    await click(page, "서비스 다음 목록 불러오기"); await expect(page.getByTestId("catalog-selection")).toHaveAttribute("data-phase", phase);
  });
}
async function receiveCompletion(page: Page) {
  const before = { catalog: catalogWire.length, reads: reads.length, review: wire.length, analysis: fixture.readAnalysisCounts() };
  const previous = completions;
  await click(page, "저장 결과 받기·다시 확인");
  await expect(page.getByTestId("analysis-delivery")).toHaveAttribute("data-phase", "saved");
  assert.equal(completions, previous + 1);
  await expect(page.getByRole("button", { name: "후보 불러오기·새로 확인", exact: true })).toBeDisabled();
  assert.deepEqual({ catalog: catalogWire.length, reads: reads.length, review: wire.length, analysis: fixture.readAnalysisCounts() }, before);
  await page.getByRole("button", { name: "이 후보 묶음 검토하기", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("analysis-delivery")).toHaveAttribute("data-phase", "selected");
  report.observations.deliverySelectFocus = await page.evaluate(() => ({
    bodyFocused: document.activeElement === document.body,
    disabledButtonFocused: document.activeElement instanceof HTMLButtonElement && document.activeElement.disabled,
    statusFocused: document.activeElement === document.querySelector('[data-testid="analysis-delivery"] [role="status"]'),
  }));
  await expect(page.getByTestId("analysis-delivery").getByRole("status")).toBeFocused();
  await expect(page.getByRole("button", { name: "후보 불러오기·새로 확인", exact: true })).toBeEnabled();
  assert.deepEqual({ catalog: catalogWire.length, reads: reads.length, review: wire.length, analysis: fixture.readAnalysisCounts() }, before);
}
const createPanel = (page: Page) => page.getByTestId("catalog-service-create-panel");
const updatePanel = (page: Page) => page.getByTestId("catalog-service-update-panel");
const deletePanel = (page: Page) => page.getByTestId("catalog-service-delete-panel");
async function observedService(serviceId: string) {
  const result = await createServiceCatalog(fixture.store.catalogDependencies).get({ serviceId });
  assert.ok(result.ok); const value = decodeCatalogSuccess("get", result.value);
  assert.ok(value?.kind === "view"); return value.view;
}
async function previewUpdate(page: Page, serviceId: string, name: string, provider = "",
  labels?: { planName: string; accountLabel: string }) {
  const before = { mutations: catalogMutationWire.length, reads: catalogWire.length, review: wire.length };
  await page.getByLabel("수정할 서비스", { exact: true }).selectOption(serviceId);
  await page.getByLabel("수정할 서비스 이름", { exact: true }).fill(name);
  await page.getByLabel("수정할 제공자 (선택)", { exact: true }).fill(provider);
  if (labels !== undefined) {
    await page.getByLabel("수정할 요금제 이름 (선택)", { exact: true }).fill(labels.planName);
    await page.getByLabel("수정할 계정 표시 이름 (선택)", { exact: true }).fill(labels.accountLabel);
  }
  await click(page, "수정 내용 미리보기"); await expect(updatePanel(page)).toHaveAttribute("data-phase", "preview");
  await expect(updatePanel(page)).toContainText(name);
  assert.deepEqual({ mutations: catalogMutationWire.length, reads: catalogWire.length, review: wire.length }, before);
}
async function saveUpdate(page: Page, phase: "completed" | "uncertain" = "completed") {
  const before = { catalog: catalogWire.length, inbox: reads.length, review: wire.length, completion: completions };
  await click(page, "이 내용으로 서비스 기록 수정");
  await expect(updatePanel(page)).toHaveAttribute("data-phase", phase); await whenIdle();
  assert.deepEqual({ catalog: catalogWire.length, inbox: reads.length, review: wire.length, completion: completions }, before);
  await expect(page.getByTestId("catalog-selection")).toHaveAttribute("data-phase", "restart_required");
}
async function previewDelete(page: Page, serviceId: string) {
  const before = { mutations: catalogMutationWire.length, reads: catalogWire.length, review: wire.length };
  await page.getByLabel("삭제할 서비스", { exact: true }).selectOption(serviceId);
  await click(page, "서비스 삭제 대상 미리보기");
  await expect(deletePanel(page)).toHaveAttribute("data-phase", "preview");
  await expect(page.getByTestId("catalog-service-delete-preview")).toContainText(serviceId);
  await expect(page.getByRole("button", { name: "이 서비스 기록 삭제", exact: true })).toBeDisabled();
  assert.deepEqual({ mutations: catalogMutationWire.length, reads: catalogWire.length, review: wire.length }, before);
}
async function saveDelete(page: Page, phase: "completed" | "uncertain" = "completed") {
  const before = { catalog: catalogWire.length, inbox: reads.length, review: wire.length, completion: completions };
  await page.getByLabel("서비스 삭제 확인 문구", { exact: true }).fill("삭제");
  await click(page, "이 서비스 기록 삭제");
  await expect(deletePanel(page)).toHaveAttribute("data-phase", phase); await whenIdle();
  assert.deepEqual({ catalog: catalogWire.length, inbox: reads.length, review: wire.length, completion: completions }, before);
  await expect(page.getByTestId("catalog-selection")).toHaveAttribute("data-phase", "restart_required");
}
async function previewCreate(page: Page, name: string, provider = "", labels?: { planName: string; accountLabel: string }) {
  await page.getByLabel("서비스 이름", { exact: true }).fill(name);
  await page.getByLabel("제공자 (선택)", { exact: true }).fill(provider);
  if (labels !== undefined) {
    await page.getByLabel("요금제 이름 (선택)", { exact: true }).fill(labels.planName);
    await page.getByLabel("계정 표시 이름 (선택)", { exact: true }).fill(labels.accountLabel);
  }
  const before = { mutations: catalogMutationWire.length, reads: catalogWire.length, review: wire.length };
  await click(page, "등록 내용 미리보기");
  await expect(createPanel(page)).toHaveAttribute("data-phase", "preview");
  await expect(createPanel(page)).toContainText(name);
  assert.deepEqual({ mutations: catalogMutationWire.length, reads: catalogWire.length, review: wire.length }, before);
}
async function saveCreate(page: Page, phase: "completed" | "uncertain" = "completed") {
  const before = { catalog: catalogWire.length, inbox: reads.length, review: wire.length, completion: completions };
  await click(page, "이 내용으로 서비스 기록 저장");
  await expect(createPanel(page)).toHaveAttribute("data-phase", phase);
  await whenIdle();
  assert.deepEqual({ catalog: catalogWire.length, inbox: reads.length, review: wire.length, completion: completions }, before);
  await expect(page.getByTestId("catalog-selection")).toHaveAttribute("data-phase", "restart_required");
}
async function open(page: Page) {
  const before = { catalog: catalogWire.length, reads: reads.length, review: wire.length, completions };
  await click(page, "Open"); await expect(panel(page)).toHaveAttribute("data-open", "yes");
  await expect(page.getByTestId("catalog-selection")).toHaveAttribute("data-phase", "ready");
  assert.deepEqual({ catalog: catalogWire.length, reads: reads.length, review: wire.length, completions }, before);
  await receiveCompletion(page);
  await nextCatalog(page); await reload(page); await expect(page.getByTestId("candidate-picker")).toHaveAttribute("data-state", "ready");
}

async function inspectCatalogWithoutChangingPendingCommand(page: Page) {
  const counts = () => ({ native: nativeApiRequestStarts, catalog: catalogWire.length, inbox: reads.length,
    review: wire.length, mutation: catalogMutationWire.length, completion: completions });
  const before = counts(), rows = fixture.store.snapshot();
  const toggles = page.getByTestId("catalog-service-detail-toggle"), detail = page.getByTestId("catalog-service-detail-disclosure");
  const search = page.getByTestId("catalog-service-details-search");
  await expect(search).toHaveValue("");
  const target = await toggles.first().getAttribute("data-service-id"); assert.ok(target);
  await toggles.first().focus(); await page.keyboard.press("Enter"); await expect(detail).toHaveCount(1);
  await search.fill(target.toUpperCase()); await expect(detail).toHaveCount(0);
  await expect(page.locator(`[data-testid="catalog-service-detail-toggle"][data-service-id="${target}"]`)).toHaveCount(1);
  await search.fill("SYNTHETIC_NO_LOADED_SERVICE_MATCH"); await expect(toggles).toHaveCount(0);
  await page.getByTestId("catalog-service-details-search-clear").click();
  await expect(search).toHaveValue(""); await expect(detail).toHaveCount(0);
  await toggles.first().focus(); await page.keyboard.press("Enter"); await expect(detail).toHaveCount(1);
  await detail.getByRole("button", { name: "상세 닫기", exact: true }).focus(); await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0); await whenIdle();
  assert.deepEqual(counts(), before); assert.deepEqual(fixture.store.snapshot(), rows);
}
async function choose(page: Page, candidate: number, service: number, name?: string) {
  await page.getByLabel("검토할 후보", { exact: true }).selectOption(fixture.batch.candidates[candidate]!.candidateId);
  await page.getByLabel("연결할 기존 서비스", { exact: true }).selectOption(fixture.services[service]!.serviceId);
  if (name !== undefined) await page.getByLabel("이름 없는 후보에 붙일 혜택 이름", { exact: true }).fill(name);
  await click(page, "검토할 내용으로 가져오기"); await expect(form(page)).toHaveCount(1);
}
async function attachNativeNetworkDiagnostics(page: Page) {
  const diagnostics = nativeDiagnostics;
  if (!diagnostics) return;
  const ordinal = diagnostics.sessionOpened();
  if (ordinal === null) return;
  let session: Awaited<ReturnType<Context["newCDPSession"]>>;
  try { session = await bounded(context!.newCDPSession(page)); }
  catch { diagnostics.issue("ATTACH_FAILED"); return; }
  const request = (payload: unknown) => diagnostics.observe(ordinal, "requestWillBeSent", payload);
  const response = (payload: unknown) => diagnostics.observe(ordinal, "responseReceived", payload);
  const finished = (payload: unknown) => diagnostics.observe(ordinal, "loadingFinished", payload);
  const failed = (payload: unknown) => diagnostics.observe(ordinal, "loadingFailed", payload);
  const closed = () => diagnostics.sessionClosed(ordinal);
  session.on("Network.requestWillBeSent", request); session.on("Network.responseReceived", response);
  session.on("Network.loadingFinished", finished); session.on("Network.loadingFailed", failed);
  session.on("close", closed);
  nativeDiagnosticDetachers.push(() => {
    session.off("Network.requestWillBeSent", request); session.off("Network.responseReceived", response);
    session.off("Network.loadingFinished", finished); session.off("Network.loadingFailed", failed); session.off("close", closed);
  });
  try { await bounded(session.send("Network.enable")); }
  catch { diagnostics.issue("ENABLE_FAILED"); }
}
async function newPage() {
  const page = await context!.newPage();
  if (nativeDiagnostics) await attachNativeNetworkDiagnostics(page);
  await page.goto(origin + "/__candidate.html");
  const host = page.getByTestId("candidate-host");
  await expect(host).toHaveAttribute("data-hydrated", "yes");
  try {
    // Installed React 19 hydrates without the fresh-placement DEV flag. Keep
    // initial hydration evidence distinct from the actual new keyed subtree.
    await expect(host).toHaveAttribute("data-effect-setups", "1");
    await expect(host).toHaveAttribute("data-effect-cleanups", "0");
    await page.getByRole("button", { name: "Remount test host", exact: true }).click();
    await expect(host).toHaveAttribute("data-hydrated", "yes");
    await expect(host).toHaveAttribute("data-effect-setups", developmentEffects ? "2" : "1");
    await expect(host).toHaveAttribute("data-effect-cleanups", developmentEffects ? "1" : "0");
  } catch {
    report.observations.effectProbeFailure = { setups: await host.getAttribute("data-effect-setups"),
      cleanups: await host.getAttribute("data-effect-cleanups"), developmentEffects };
    throw Error("CANDIDATE_EFFECT_REPLAY_MISMATCH");
  }
  return page;
}
async function closePage(page: Page) {
  assert.ok(![...expectedAbortArms.values()].some((entry) => entry.page === page), "CANDIDATE_UNCONSUMED_ABORT_ARM");
  if (cleanupExperiment) await recordCleanupExperiment(page);
  errors.csp += await page.evaluate(() => document.documentElement.dataset.candidateCsp === "yes" ? 1 : 0);
  await bounded(page.close()); assert.equal(page.isClosed(), true);
}
async function recordCleanupExperiment(page: Page) {
  if (!cleanupExperiment) return;
  const sample = await page.evaluate((key) => {
    const value = (globalThis as unknown as Record<string, unknown>)[key];
    if (value === undefined) return { performSuccess: 0, performOther: 0, discardInvoked: 0, discardOmitted: 0, overflow: false };
    if (value === null || typeof value !== "object") throw Error("CANDIDATE_EXPERIMENT_COUNTER_INVALID");
    const record = value as Record<string, unknown>;
    const counts = [record.performSuccess, record.performOther, record.discardInvoked, record.discardOmitted];
    if (counts.some((count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      || typeof record.overflow !== "boolean") throw Error("CANDIDATE_EXPERIMENT_COUNTER_INVALID");
    return { performSuccess: record.performSuccess as number, performOther: record.performOther as number,
      discardInvoked: record.discardInvoked as number, discardOmitted: record.discardOmitted as number, overflow: record.overflow };
  }, CANDIDATE_CLEANUP_EXPERIMENT_KEY);
  cleanupExperimentDocuments.push(sample);
  assert.equal(sample.overflow, false, "CANDIDATE_EXPERIMENT_COUNTER_OVERFLOW");
  assert.equal(sample.performSuccess + sample.performOther, sample.discardInvoked + sample.discardOmitted);
  if (cleanupExperiment === "observe") assert.equal(sample.discardOmitted, 0);
  else assert.equal(sample.discardOmitted, sample.performSuccess);
}
async function browserPrivacy(page: Page) {
  errors.csp += await page.evaluate(() => document.documentElement.dataset.candidateCsp === "yes" ? 1 : 0);
  assert.deepEqual(await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length,
    databases: (await indexedDB.databases()).length, caches: (await caches.keys()).length, cookie: document.cookie })),
  { local: 0, session: 0, databases: 0, caches: 0, cookie: "" });
}
async function observeLifecycle(page: Page) {
  return page.evaluate(() => {
    window.candidateProbe?.detach();
    const probe = { marker: crypto.randomUUID(), events: [] as EventSample[], record(event: Event) {
      probe.events.push({ type: event.type, trusted: event.isTrusted, persisted: event instanceof PageTransitionEvent ? event.persisted : null,
        open: document.querySelector('[data-testid="review-workspace-panel"]')?.getAttribute("data-open") ?? null,
        privateNodes: document.querySelectorAll('[data-testid="review-workspace-content"],[data-testid="catalog-service-create-content"],[data-testid="catalog-service-update-content"],[data-testid="catalog-service-delete-content"],[data-testid="catalog-service-details-content"]').length });
    }, detach() { window.removeEventListener("pagehide", probe.record); window.removeEventListener("pageshow", probe.record); } };
    window.candidateProbe = probe; window.addEventListener("pagehide", probe.record); window.addEventListener("pageshow", probe.record);
    return probe.marker;
  });
}
async function recordLifecycle(page: Page, marker: string, key: string) {
  const returned = await page.evaluate(() => window.candidateProbe ? { marker: window.candidateProbe.marker, events: window.candidateProbe.events } : null);
  const sameDocument = returned?.marker === marker;
  const events = sameDocument ? returned.events : [];
  const evidence = classifyNativeLifecycleEvidence(sameDocument, events);
  // Keep failed observation evidence too; the assertion below still rejects it.
  report.observations[key] = { ...evidence, sameDocument, events };
  // Observed event-time exposure is a failure even when BFCache was unavailable.
  assert.ok(events.every((event) => event.open === "no" && event.privateNodes === 0));
  if (!evidence.bfcacheObserved) inconclusive = true;
  return evidence.bfcacheObserved;
}
async function controlledVisibility(page: Page, hidden: boolean) {
  // Deliberately controlled hook/DOM regression, not a native browser event.
  // The installed headed AND headless tab probes did not produce visibilitychange.
  return page.evaluate((nextHidden) => {
    Object.defineProperty(document, "hidden", { configurable: true, value: nextHidden });
    const event = new Event("visibilitychange"); document.dispatchEvent(event);
    return { trusted: event.isTrusted, controlledHidden: document.hidden,
      nativeVisibilityState: document.visibilityState,
      open: document.querySelector('[data-testid="review-workspace-panel"]')?.getAttribute("data-open") ?? null,
      privateNodes: document.querySelectorAll('[data-testid="review-workspace-content"],[data-testid="catalog-service-create-content"],[data-testid="catalog-service-update-content"],[data-testid="catalog-service-delete-content"],[data-testid="catalog-service-details-content"]').length };
  }, hidden);
}
async function completionProbeSnapshot(page: Page) {
  return page.evaluate(() => window.candidateCompletionProbe!.snapshot());
}
async function beginControlledCompletion(page: Page, port: "A" | "B") {
  const before = await completionProbeSnapshot(page);
  await click(page, "저장 결과 받기·다시 확인");
  await expect(page.getByTestId("analysis-delivery")).toHaveAttribute("data-phase", "receiving");
  await expect.poll(async () => (await completionProbeSnapshot(page)).requests.length).toBe(before.requests.length + 1);
  const request = (await completionProbeSnapshot(page)).requests.at(-1);
  assert.ok(request && request.port === port && !request.aborted && !request.settled);
  return request.id;
}
async function settleControlledCompletion(page: Page, id: number, outcome: "resolve" | "reject" | "poison") {
  assert.equal(await page.evaluate(async ({ id, outcome }) => {
    const probe = window.candidateCompletionProbe!;
    const accepted = outcome === "poison" ? probe.settlePoison(id) : probe.settle(id, outcome);
    // Real task boundary: drain actual Promise reactions without replacing clocks.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return accepted;
  }, { id, outcome }), true);
}
try {
  assert.equal(args[0], "--synthetic-only", "CANDIDATE_SYNTHETIC_ACK_REQUIRED");
  assert.ok(args.length >= 1 && args.length <= 6 && new Set(args).size === args.length
    && args.slice(1).every((flag) => flag === "--development-effects" || flag === "--bootstrap-diagnostic" || flag === "--discard-only"
      || flag === "--native-network-diagnostics" || flag === "--bootstrap-after-history"
      || flag === "--candidate-cleanup-experiment=observe" || flag === "--candidate-cleanup-experiment=omit_perform_success_discard"),
  "CANDIDATE_DIAGNOSTIC_FLAGS_INVALID");
  assert.ok(args.filter((flag) => flag.startsWith("--candidate-cleanup-experiment=")).length <= 1,
    "CANDIDATE_EXPERIMENT_VARIANT_AMBIGUOUS");
  assert.ok(!bootstrapAfterHistory || bootstrapDiagnostic, "CANDIDATE_HISTORY_REQUIRES_BOOTSTRAP_DIAGNOSTIC");
  assert.ok(!discardOnly || (!bootstrapDiagnostic && !bootstrapAfterHistory && !cleanupExperiment), "CANDIDATE_DISCARD_MODE_CONFLICT");
  if (discardOnly) report.limits.push("Focused discard regression only; the earlier full composition groups are NOT executed in this mode");
  assert.ok(browserChannel === "chrome" || browserChannel === "msedge", "CANDIDATE_BROWSER_CHANNEL_INVALID");
  report.stage = "fixture_bundle";
  let cleanupTransforms = 0;
  const cleanupTarget = fileURLToPath(new URL("../src/domain/candidate-batch-client.ts", import.meta.url)).replaceAll("\\", "/");
  if (cleanupExperiment) {
    report.scope = "TRANSFORMED_CANDIDATE_CLEANUP_DIAGNOSTIC_SYNTHETIC_HTTP";
    report.limits.push("In-memory candidate perform-success cleanup experiment, not the unmodified product or a production fix; counters and source transform may affect timing",
      "performSuccess is before final caller/context/clock/redaction delivery fences; OMIT also skips discard for a perform-success whose final delivery later fails; later life.close failure cleanup remains unchanged",
      "Counter snapshots cover retained documents at explicit close/final cleanup only, not cross-document identity, EOF/native-terminal ordering or exhaustive lost-document coverage; zero does not prove no earlier execution");
  }
  const bundle = await build({ root: fileURLToPath(new URL("../", import.meta.url)), configFile: false, envDir: false, envPrefix: [],
    plugins: cleanupExperiment ? [{ name: "synthetic-candidate-cleanup-experiment", enforce: "pre", transform(code, id) {
      if (id.replaceAll("\\", "/") !== cleanupTarget) return null;
      assert.equal(++cleanupTransforms, 1, "CANDIDATE_EXPERIMENT_MODULE_DUPLICATED");
      const transformed = transformCandidateCleanupExperiment(code, cleanupExperiment);
      report.observations.cleanupExperimentBuild = { variant: cleanupExperiment, originalSha256: digest(code),
        transformedSha256: digest(transformed), sourceSites: 1, productFileWritten: false };
      return { code: transformed, map: null };
    } }] : [],
    ...(developmentEffects ? { define: { "process.env.NODE_ENV": JSON.stringify("development") } } : {}),
    logLevel: "silent", esbuild: { jsx: "automatic" }, build: { write: false, emptyOutDir: false,
      ...(developmentEffects ? { minify: false as const } : {}), rollupOptions: {
      input: fileURLToPath(new URL("./fixtures/candidate-review-fixture.tsx", import.meta.url)), output: { entryFileNames: "fixture.js" } } } });
  assert.equal(cleanupTransforms, cleanupExperiment ? 1 : 0, "CANDIDATE_EXPERIMENT_MODULE_COVERAGE");
  assert.ok(!Array.isArray(bundle) && "output" in bundle);
  for (const asset of bundle.output) assets.set(`/${asset.fileName}`, { body: asset.type === "chunk" ? asset.code : asset.source,
    type: asset.fileName.endsWith(".css") ? "text/css" : "text/javascript" });
  report.observations.bundle = [...assets.entries()].map(([path, value]) => ({ path, sha256: digest(value.body), bytes: Buffer.byteLength(value.body) }));
  await freshFixture();
  for (const asset of assets.values()) assert.equal(new TextDecoder().decode(typeof asset.body === "string" ? new TextEncoder().encode(asset.body) : asset.body)
    .includes(fixture.locator.batchReference), false, "BATCH_REFERENCE_NOT_IN_BROWSER_BUNDLE");
  await bounded(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }));
  const address = server.address(); assert.ok(address && typeof address === "object"); origin = `http://127.0.0.1:${address.port}`;
  if (nativeNetworkDiagnosticsEnabled) {
    nativeDiagnostics = createNativeNetworkDiagnostics(origin);
    report.limits.push("Opt-in public CDP Network.enable adds observers and setup awaits; CDP/server listeners and synchronous event recording may perturb timing or BFCache behavior, so diagnostic runs are not equivalent to default runs",
      "Native diagnostics retain fixed routes and safe ordinals only; CDP request identity, Playwright Request identity and server span identity are not joined by URL",
      "Diagnostic COMPLETE means observed terminal/start-count coverage only, not successful transport or causal proof; missing terminals, independent route-count mismatches, observer errors or capacity loss are explicitly INCOMPLETE");
  }
  const beforeSSR = fixture.store.controls.transactions;
  const markup = renderToString(createElement(StrictMode, null, createElement(CandidateReviewHarness, { origin })));
  assert.ok(markup.includes('data-open="no"') && !markup.includes('data-testid="candidate-picker"'));
  assert.ok(!markup.includes("Synthetic trial offer") && !markup.includes("Synthetic Service Plus"));
  assert.ok(!markup.includes(fixture.locator.batchReference) && markup.includes('data-testid="analysis-delivery" data-phase="closed"'));
  assert.equal(fixture.store.controls.transactions, beforeSSR);
  html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="fixture-root">${markup}</div><script type="module" src="/fixture.js"></script></body></html>`;
  handler = createReviewHttpHandler({ trustedOrigin: origin, now: clock, newId: () => fixture.store.dependencies.newId(),
    transaction: (authority, action) => fixture.store.dependencies.transaction(authority, action),
    readSession: async ({ cookie }) => cookie === `synthetic-session=${COOKIE}` ? structuredClone(fixture.store.controls.authority) : null,
    admit: async (request) => ({ allowed: true, surface: REVIEW_REQUEST_HEADER, requestId: request.requestId,
      action: request.action, authority: request.authority, expiresAt: request.notAfter }) });
  inboxHandler = createInboxHttpHandler({ trustedOrigin: origin, now: clock, newId: () => fixture.store.dependencies.newId(),
    transaction: (authority, action) => fixture.store.referenceDependencies.transaction(authority, action),
    readSession: async ({ cookie }) => cookie === `synthetic-session=${COOKIE}` ? structuredClone(fixture.store.controls.authority) : null,
    resolveBatch: (request, signal) => {
      if (!revokeDuringReferenceRead) return fixture.references.resolve(request, signal);
      revokeDuringReferenceRead = false;
      // One test-only adapter hook changes real synthetic session state inside
      // the actual resolver, rather than fabricating an HTTP error response.
      return createCandidateBatchReferences({ ...fixture.store.referenceDependencies,
        readReference: async (reference, abortSignal) => {
          const row = await fixture.store.referenceDependencies.readReference(reference, abortSignal);
          const authority = fixture.store.controls.authority as ReviewAuthority;
          fixture.store.controls.authority = { ...authority, sessionRevision: authority.sessionRevision + 1 };
          return row;
        } }).resolve(request, signal);
    },
    admit: async (request, signal) => {
      if (holdNextRead) { holdNextRead = false;
        await new Promise<void>((resolve) => {
          const finish = () => { signal.removeEventListener("abort", finish); resolve(); };
          releaseRead = finish; signal.addEventListener("abort", finish, { once: true });
          if (signal.aborted) finish();
        });
        releaseRead = null;
      }
      return { allowed: true, surface: INBOX_REQUEST_HEADER, requestId: request.requestId,
        action: request.action, authority: request.authority, expiresAt: request.notAfter };
    } });
  discardHandler = createInboxDiscardHttpHandler({ trustedOrigin: origin, now: clock, newId: () => fixture.store.dependencies.newId(),
    transaction: (authority, task) => fixture.store.referenceDependencies.transaction(authority, task),
    readSession: async ({ cookie }) => cookie === `synthetic-session=${COOKIE}` ? structuredClone(fixture.store.controls.authority) : null,
    resolveBatch: (request, signal) => fixture.references.resolve(request, signal),
    admit: async (request, signal) => {
      if (holdNextDiscard) {
        holdNextDiscard = false;
        await new Promise<void>((resolve) => {
          const finish = () => { signal.removeEventListener("abort", finish); resolve(); };
          releaseDiscard = finish; signal.addEventListener("abort", finish, { once: true });
          if (signal.aborted) finish();
        });
        releaseDiscard = null;
      }
      return { allowed: true, surface: INBOX_DISCARD_REQUEST_HEADER, requestId: request.requestId,
        action: "discard", authority: request.authority, expiresAt: request.notAfter };
    } });
  catalogHandler = createCatalogHttpHandler({ trustedOrigin: origin, now: clock, newId: () => fixture.store.dependencies.newId(),
    transaction: async (authority, action) => {
      const before = fixture.store.rows.catalogOperations.size;
      const value = await fixture.store.catalogDependencies.transaction(authority, action);
      if ((failNextCreatedAcknowledgement || failNextUpdatedAcknowledgement || failNextDeletedAcknowledgement) && fixture.store.rows.catalogOperations.size === before + 1) {
        failNextCreatedAcknowledgement = false; failNextUpdatedAcknowledgement = false; failNextDeletedAcknowledgement = false;
        // Actual committed operation, followed by adapter acknowledgement loss.
        // No forged success payload or claim of network packet loss.
        throw new Error(SYNTHETIC_PRIVATE);
      }
      return value;
    },
    readSession: async ({ cookie }) => cookie === `synthetic-session=${COOKIE}` ? structuredClone(fixture.store.controls.authority) : null,
    admit: async (request, signal) => {
      if (holdNextCatalog) { holdNextCatalog = false;
        await new Promise<void>((resolve) => {
          const finish = () => { signal.removeEventListener("abort", finish); resolve(); };
          releaseCatalog = finish; signal.addEventListener("abort", finish, { once: true });
          if (signal.aborted) finish();
        });
        releaseCatalog = null;
      }
      return { allowed: true, requestId: request.requestId, action: request.action, authority: request.authority, expiresAt: request.notAfter };
    } });
  browser = await chromium.launch({ channel: browserChannel, headless: true, ignoreDefaultArgs: ["--disable-back-forward-cache"] });
  report.observations.browser = { channel: browserChannel, version: browser.version() };
  context = await browser.newContext({ serviceWorkers: "block" });
  context.on("request", (request) => {
    requestStages.set(request, report.stage);
    nativeDiagnostics?.observePlaywrightRequestStart(request.url());
    const requestLocation = new URL(request.url());
    if (requestLocation.origin === origin && (requestLocation.pathname.startsWith("/api/")
      || requestLocation.pathname === "/__candidate_completion")) nativeApiRequestStarts++;
    if (new URL(request.url()).origin !== origin) errors.external++;
    observeExpectedAbortRequest(request);
  });
  context.on("response", (response) => { responseStatuses.set(response.request(), response.status()); });
  context.on("requestfailed", (request) => {
    if (expectedReadAborts.has(request) && request.url() === origin + "/api/inbox/batch" && request.failure()?.errorText === "net::ERR_ABORTED") {
      expectedReadAborts.delete(request); matchedReadAborts++;
    } else if (expectedCatalogAborts.has(request) && request.url() === origin + "/api/catalog/list" && request.failure()?.errorText === "net::ERR_ABORTED") {
      expectedCatalogAborts.delete(request); matchedCatalogAborts++;
    } else if (expectedCompletionAborts.has(request) && request.url() === origin + "/__candidate_completion" && request.failure()?.errorText === "net::ERR_ABORTED") {
      expectedCompletionAborts.delete(request); matchedCompletionAborts++;
    } else if (expectedCreateAborts.has(request) && request.url() === origin + "/api/catalog/create" && request.failure()?.errorText === "net::ERR_ABORTED") {
      expectedCreateAborts.delete(request); matchedCreateAborts++;
    } else if (expectedUpdateAborts.has(request) && request.url() === origin + "/api/catalog/update" && request.failure()?.errorText === "net::ERR_ABORTED") {
      expectedUpdateAborts.delete(request); matchedUpdateAborts++;
    } else if (expectedDeleteAborts.has(request) && request.url() === origin + "/api/catalog/delete" && request.failure()?.errorText === "net::ERR_ABORTED") {
      expectedDeleteAborts.delete(request); matchedDeleteAborts++;
    } else {
      errors.transport++;
      const samples = (report.observations.unexpectedTransport ??= []) as unknown[];
      if (samples.length < 8) samples.push(observeUnexpectedTransport(request, {
        stage: report.stage, origin, requestStages, responseStatuses, requestReadHelpers,
      }));
    }
  });
  context.on("page", (page) => {
    page.setDefaultTimeout(8000); page.on("pageerror", () => errors.page++); page.on("websocket", () => errors.websocket++);
    page.on("dialog", async (dialog) => { errors.page++; await dialog.dismiss(); });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      if (expected503 && message.text() === "Failed to load resource: the server responded with a status of 503 (Service Unavailable)"
        && message.location().url === origin + "/api/review/confirm") { expected503 = false; matched503++; }
      else if (expected401 && message.text() === "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
        && message.location().url === origin + "/api/inbox/batch") { expected401 = false; matched401++; }
      else if (expected404 && message.text() === "Failed to load resource: the server responded with a status of 404 (Not Found)"
        && message.location().url === origin + "/api/inbox/batch") { expected404 = false; matched404++; }
      else if (expected403 && message.text() === "Failed to load resource: the server responded with a status of 403 (Forbidden)"
        && message.location().url === origin + "/api/inbox/batch") { expected403 = false; matched403++; }
      else if (expectedCatalog401 && message.text() === "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
        && message.location().url === origin + "/api/catalog/list") { expectedCatalog401 = false; matchedCatalog401++; }
      else if (expectedCatalog409 && message.text() === "Failed to load resource: the server responded with a status of 409 (Conflict)"
        && message.location().url === origin + "/api/catalog/list") { expectedCatalog409 = false; matchedCatalog409++; }
      else if (expectedCreate503 && message.text() === "Failed to load resource: the server responded with a status of 503 (Service Unavailable)"
        && message.location().url === origin + "/api/catalog/create") { expectedCreate503 = false; matchedCreate503++; }
      else if (expectedCreate401 && message.text() === "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
        && message.location().url === origin + "/api/catalog/create") { expectedCreate401 = false; matchedCreate401++; }
      else if (expectedUpdate503 && message.text() === "Failed to load resource: the server responded with a status of 503 (Service Unavailable)"
        && message.location().url === origin + "/api/catalog/update") { expectedUpdate503 = false; matchedUpdate503++; }
      else if (expectedUpdate409 && message.text() === "Failed to load resource: the server responded with a status of 409 (Conflict)"
        && message.location().url === origin + "/api/catalog/update") { expectedUpdate409 = false; matchedUpdate409++; }
      else if (expectedUpdate401 && message.text() === "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
        && message.location().url === origin + "/api/catalog/update") { expectedUpdate401 = false; matchedUpdate401++; }
      else if (expectedDelete503 && message.text() === "Failed to load resource: the server responded with a status of 503 (Service Unavailable)"
        && message.location().url === origin + "/api/catalog/delete") { expectedDelete503 = false; matchedDelete503++; }
      else if (expectedDelete409 && message.text() === "Failed to load resource: the server responded with a status of 409 (Conflict)"
        && message.location().url === origin + "/api/catalog/delete") { expectedDelete409 = false; matchedDelete409++; }
      else if (expectedDelete401 && message.text() === "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
        && message.location().url === origin + "/api/catalog/delete") { expectedDelete401 = false; matchedDelete401++; }
      else if (expectedDiscardStatus !== null && message.location().url === origin + "/api/inbox/discard"
        && message.text() === `Failed to load resource: the server responded with a status of ${expectedDiscardStatus} (${({ 401: "Unauthorized", 404: "Not Found", 409: "Conflict", 503: "Service Unavailable" } as Record<number, string>)[expectedDiscardStatus]})`) {
        matchedDiscardStatuses.push(expectedDiscardStatus); expectedDiscardStatus = null;
      } else {
        errors.console++;
        // Bounded enum-only diagnostics. Keep every unexpected event failing;
        // never print raw console text, URLs, payloads or user-controlled values.
        const entries = (report.observations.unexpectedConsole ??= []) as { stage: string; code: string }[];
        if (entries.length < 16) {
          const resource503 = message.text() === "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
          const httpCode = /^Failed to load resource: the server responded with a status of (400|401|403|404|408|409|415|429|500|503) /.exec(message.text())?.[1];
          const code = resource503 && message.location().url === origin + "/api/catalog/create" ? "CATALOG_CREATE_503"
            : resource503 && message.location().url === origin + "/api/catalog/update" ? "CATALOG_UPDATE_503"
              : httpCode ? `HTTP_${httpCode}` : /Maximum update depth exceeded|Minified React error #185/.test(message.text()) ? "REACT_UPDATE_DEPTH" : "OTHER";
          entries.push({ stage: report.stage, code });
        }
      }
    });
  });
  await context.addInitScript(() => document.addEventListener("securitypolicyviolation", () => { document.documentElement.dataset.candidateCsp = "yes"; }));
  await context.addCookies([{ name: "synthetic-session", value: COOKIE, url: origin, httpOnly: true, sameSite: "Strict" }]);
  let page = await newPage(); await closed(page); assert.equal(wire.length, 0); assert.equal(catalogWire.length, 0); assert.equal(reads.length, 0);
  report.observations.reactEffects = { mode: developmentEffects ? "development" : "production",
    initialHydration: { setups: 1, cleanups: 0 },
    explicitKeyedRemount: { setups: developmentEffects ? 2 : 1, interveningCleanups: developmentEffects ? 1 : 0 },
    measuredOnEveryNewDocument: true, automaticHttp: 0 };
  pass("closed_ssr_hydration_no_observation_or_review_request");

  if (bootstrapDiagnostic) {
    type BootstrapHistorySample = { lifecycle: "NATIVE_BFCACHE" | "NATIVE_HISTORY_ONLY"; evidenceKey: string;
      completionRequests: number; serverCompletionAborts: number; catalogReadRequests: number; candidateReadRequests: number;
      reviewRequests: number; mutationRequests: number; nativeApiRequests: number; closedBeforeReopen: boolean };
    const diagnostic: { plannedCycles: number; completedCycles: number; historyRequested: boolean; historyCycles: number; cycles: {
      cycle: number; seededServices: boolean; expectedCatalogRows: number; candidates: number;
      completionObservations: number; catalogReadRequests: number; candidateReadRequests: number;
      createRequests: number; committedServices: number | null; closed: boolean; privacyChecked: boolean;
      pageClosed: boolean; completed: boolean; history: BootstrapHistorySample | null;
    }[] } = { plannedCycles: BOOTSTRAP_CYCLES, completedCycles: 0, historyRequested: bootstrapAfterHistory, historyCycles: 0, cycles: [] };
    report.observations.bootstrapDiagnostic = diagnostic;
    for (let cycle = 1; cycle <= BOOTSTRAP_CYCLES; cycle++) {
      const seedServices = cycle % 2 === 1, expectedCatalogRows = seedServices ? 2 : 0;
      const sample = { cycle, seededServices: seedServices, expectedCatalogRows, candidates: 0,
        completionObservations: 0, catalogReadRequests: 0, candidateReadRequests: 0, createRequests: 0,
        committedServices: null as number | null, closed: false, privacyChecked: false, pageClosed: false, completed: false,
        history: null as BootstrapHistorySample | null };
      diagnostic.cycles.push(sample);
      report.stage = `bootstrap_cycle_${cycle}_${seedServices ? "seeded" : "empty"}_fresh_document`;
      // The first fresh seeded fixture/page is the common setup above. Later
      // cycles acquire only new fixtures/pages, never reset old service rows.
      if (cycle > 1) {
        await whenIdle(); await bounded(freshFixture(86400000, seedServices)); page = await newPage(); await closed(page);
      }
      assert.equal(fixture.services.length, expectedCatalogRows); assert.equal(fixture.store.rows.services.size, expectedCatalogRows);
      assert.equal(fixture.batch.candidates.length, 2);
      if (bootstrapAfterHistory) {
        report.stage = `bootstrap_cycle_${cycle}_pending_completion_native_back`;
        const historyBefore: { completion: number; aborts: number; api: number; catalog: number; candidate: number;
          review: number; mutation: number; analysis: Readonly<{ quota: number; mailbox: number; analysis: number }> } =
        { completion: completions, aborts: completionAborts, api: nativeApiRequestStarts,
          catalog: catalogWire.length, candidate: reads.length, review: wire.length, mutation: catalogMutationWire.length,
          analysis: fixture.readAnalysisCounts() };
        await click(page, "Open"); await expect(panel(page)).toHaveAttribute("data-open", "yes");
        // Match the full runner's passive-after-owner listener ordering. This
        // does not claim to cover observers installed before the product owner.
        const marker = await observeLifecycle(page);
        holdNextCompletion = true; armExpectedAbort("/__candidate_completion", page);
        await click(page, "저장 결과 받기·다시 확인");
        await expect(page.getByTestId("analysis-delivery")).toHaveAttribute("data-phase", "receiving");
        // State readiness for the actual server hold, not a timing sleep or a
        // requestfinished barrier. Exact expected-abort identity stays unchanged.
        await expect.poll(() => releaseCompletion !== null).toBe(true);
        await page.getByRole("link", { name: "Leave document", exact: true }).click();
        await expect(page).toHaveURL(origin + "/__candidate_away.html"); await whenIdle();
        assert.equal(completionAborts - historyBefore.aborts, 1);
        assert.equal(completions - historyBefore.completion, 1);
        assert.equal(releaseCompletion, null); assert.equal(holdNextCompletion, false); assert.equal(expectedAbortArms.has("/__candidate_completion"), false);
        report.stage = `bootstrap_cycle_${cycle}_native_history_return`;
        await page.goBack({ waitUntil: "commit" }); await expect(page).toHaveURL(origin + "/__candidate.html");
        await closed(page);
        await expect(page.getByTestId("analysis-delivery")).toHaveAttribute("data-phase", "closed");
        await expect(page.getByTestId("catalog-selection")).toHaveAttribute("data-phase", "closed");
        await expect(page.getByTestId("candidate-picker")).toHaveCount(0);
        // A restored document must deliver its actual pageshow before examining
        // persisted. A different document cannot certify the old marker/events.
        await page.waitForFunction((expectedMarker) => window.candidateProbe?.marker !== expectedMarker
          || window.candidateProbe.events.some((event) => event.type === "pageshow"), marker);
        const evidenceKey = `bootstrap_cycle_${cycle}_native_history_lifecycle`;
        const persisted = await recordLifecycle(page, marker, evidenceKey);
        const history: BootstrapHistorySample = { lifecycle: persisted ? "NATIVE_BFCACHE" : "NATIVE_HISTORY_ONLY", evidenceKey,
          completionRequests: completions - historyBefore.completion, serverCompletionAborts: completionAborts - historyBefore.aborts,
          catalogReadRequests: catalogWire.length - historyBefore.catalog, candidateReadRequests: reads.length - historyBefore.candidate,
          reviewRequests: wire.length - historyBefore.review, mutationRequests: catalogMutationWire.length - historyBefore.mutation,
          nativeApiRequests: nativeApiRequestStarts - historyBefore.api, closedBeforeReopen: true };
        sample.history = history;
        assert.equal(history.completionRequests, 1); assert.equal(history.serverCompletionAborts, 1);
        assert.equal(history.nativeApiRequests, 1); assert.equal(history.catalogReadRequests, 0); assert.equal(history.candidateReadRequests, 0);
        assert.equal(history.reviewRequests, 0); assert.equal(history.mutationRequests, 0);
        assert.deepEqual(fixture.readAnalysisCounts(), historyBefore.analysis);
        diagnostic.historyCycles++;
        pass(`bootstrap_cycle_${cycle}_pending_completion_native_return_closed_${persisted ? "bfcache" : "history_only"}`);
      }
      // History setup has its own counters above; the original Open/read/create
      // interval below still requires exactly four native API requests.
      const before: { completion: number; catalog: number; candidate: number; review: number; mutation: number;
        api: number; operations: number; analysis: Readonly<{ quota: number; mailbox: number; analysis: number }> } =
      { completion: completions, catalog: catalogWire.length, candidate: reads.length,
        review: wire.length, mutation: catalogMutationWire.length, api: nativeApiRequestStarts,
        operations: fixture.store.rows.catalogOperations.size, analysis: fixture.readAnalysisCounts() };
      report.stage = `bootstrap_cycle_${cycle}_${seedServices ? "seeded" : "empty"}_open`;
      await open(page);
      await expect(page.getByTestId("catalog-selection")).toHaveAttribute("data-rows", String(expectedCatalogRows));
      await expect(page.getByLabel("검토할 후보", { exact: true }).locator("option")).toHaveCount(3);
      sample.candidates = 2; sample.completionObservations = completions - before.completion;
      sample.catalogReadRequests = catalogWire.length - before.catalog; sample.candidateReadRequests = reads.length - before.candidate;
      assert.equal(sample.completionObservations, 1); assert.equal(sample.catalogReadRequests, 1); assert.equal(sample.candidateReadRequests, 1);
      assert.equal(catalogWire.at(-1)?.status, 200); assert.equal(reads.at(-1)?.status, 200);
      report.stage = `bootstrap_cycle_${cycle}_${seedServices ? "seeded" : "empty"}_create`;
      await previewCreate(page, `부트스트랩 합성 서비스 ${cycle}`); await saveCreate(page);
      sample.createRequests = catalogMutationWire.length - before.mutation;
      sample.committedServices = fixture.store.rows.services.size;
      assert.equal(sample.createRequests, 1); assert.equal(catalogMutationWire.at(-1)?.action, "create");
      assert.equal(catalogMutationWire.at(-1)?.status, 200); assert.equal(sample.committedServices, expectedCatalogRows + 1);
      assert.equal(fixture.store.rows.catalogOperations.size, before.operations + 1); assert.equal(fixture.store.rows.benefits.size, 0);
      assert.equal(wire.length, before.review); assert.equal(nativeApiRequestStarts - before.api, 4);
      assert.deepEqual(fixture.readAnalysisCounts(), before.analysis);
      report.stage = `bootstrap_cycle_${cycle}_${seedServices ? "seeded" : "empty"}_close`;
      await click(page, "Close"); await closed(page); sample.closed = true;
      await browserPrivacy(page); sample.privacyChecked = true;
      await closePage(page); sample.pageClosed = true;
      // No requestfinished wait, delay or error reset: late native failures stay
      // in the same exact-request unexpectedTransport/error observations.
      sample.completed = true; diagnostic.completedCycles++;
      pass(`bootstrap_cycle_${cycle}_${seedServices ? "seeded_two" : "empty_zero"}_read_create_close`);
    }
    assert.equal(diagnostic.completedCycles, BOOTSTRAP_CYCLES);
    assert.equal(diagnostic.historyCycles, bootstrapAfterHistory ? BOOTSTRAP_CYCLES : 0);
  } else {
  if (!discardOnly) {
  report.stage = "completion_delivery_recovery";
  await click(page, "Open"); await expect(panel(page)).toHaveAttribute("data-open", "yes");
  assert.equal(completions, 0); assert.deepEqual(fixture.readAnalysisCounts(), { quota: 1, mailbox: 1, analysis: 1 });
  invalidNextCompletion = true;
  await click(page, "저장 결과 받기·다시 확인");
  await expect(page.getByTestId("analysis-delivery")).toHaveAttribute("data-phase", "unconfirmed");
  await expect(page.getByRole("button", { name: "이 후보 묶음 검토하기", exact: true })).toBeDisabled();
  assert.equal(reads.length, 0); assert.equal(catalogWire.length, 0); assert.equal(wire.length, 0);
  await receiveCompletion(page);
  pass("run_specific_receipt_not_in_bundle_or_ssr_wrong_generation_closed_explicit_receive_select_no_analysis_or_read");
  holdNextCompletion = true; armExpectedAbort("/__candidate_completion", page);
  await page.getByRole("button", { name: "저장 결과 받기·다시 확인", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("analysis-delivery")).toHaveAttribute("data-phase", "receiving");
  await expect(page.getByTestId("analysis-delivery").getByRole("status")).toBeFocused();
  await bounded((async () => { while (!releaseCompletion) await delay(20); })());
  await page.getByRole("button", { name: "결과 확인 취소", exact: true }).focus();
  await page.keyboard.press("Enter"); await whenIdle();
  await expect(page.getByTestId("analysis-delivery")).toHaveAttribute("data-phase", "idle");
  await expect(page.getByTestId("analysis-delivery").getByRole("status")).toBeFocused();
  assert.equal(completionAborts, 1); assert.equal(reads.length, 0);
  await receiveCompletion(page); await click(page, "Close"); await closed(page);
  assert.deepEqual(fixture.readAnalysisCounts(), { quota: 1, mailbox: 1, analysis: 1 });
  pass("pending_completion_explicit_cancel_aborts_then_manual_recheck_never_reruns_mail_or_quota");

  report.stage = "delivery_focus_async_and_reentrant_revocation";
  await click(page, "Open"); await expect(panel(page)).toHaveAttribute("data-open", "yes");
  holdNextCompletion = true;
  await page.getByRole("button", { name: "저장 결과 받기·다시 확인", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("analysis-delivery")).toHaveAttribute("data-phase", "receiving");
  await expect(page.getByTestId("analysis-delivery").getByRole("status")).toBeFocused();
  await bounded((async () => { while (!releaseCompletion) await delay(20); })());
  await page.getByRole("button", { name: "Close", exact: true }).focus();
  releaseHeldCompletion();
  await expect(page.getByTestId("analysis-delivery")).toHaveAttribute("data-phase", "saved");
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await whenIdle();
  const beforeReentrantDelivery = { completions, reads: reads.length, catalog: catalogWire.length, review: wire.length };
  await page.evaluate(() => {
    const status = document.querySelector('[data-testid="analysis-delivery"] [role="status"]');
    const buttons = [...document.querySelectorAll("button")];
    status?.addEventListener("focus", () => {
      buttons.find((item) => item.textContent === "저장 결과 받기·다시 확인")?.click();
      buttons.find((item) => item.textContent === "Close")?.click();
      buttons.find((item) => item.textContent === "Open")?.click();
    }, { once: true });
  });
  await page.getByRole("button", { name: "저장 결과 받기·다시 확인", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toHaveAttribute("data-open", "yes");
  await expect(page.getByTestId("analysis-delivery")).toHaveAttribute("data-phase", "idle");
  await whenIdle();
  assert.deepEqual({ completions, reads: reads.length, catalog: catalogWire.length, review: wire.length }, beforeReentrantDelivery);
  await receiveCompletion(page); await click(page, "Close"); await closed(page);
  report.observations.deliveryFocusSafety = { receiveCancelSelectKeepOwnedStatusFocus: true,
    asyncCompletionStealsFocus: false, synchronousFocusReentryOldScopeHttp: 0, freshManualActionWorks: true };
  pass("delivery_explicit_actions_keep_focus_without_async_steal_or_reentrant_old_scope_dispatch");

  report.stage = "completion_real_timeout";
  await click(page, "Open"); await expect(panel(page)).toHaveAttribute("data-open", "yes");
  holdNextCompletion = true; armExpectedAbort("/__candidate_completion", page);
  const timeoutStarted = performance.now();
  await click(page, "저장 결과 받기·다시 확인");
  await bounded((async () => { while (!releaseCompletion) await delay(20); })());
  await expect(page.getByTestId("analysis-delivery")).toHaveAttribute("data-phase", "unconfirmed", { timeout: 11500 });
  await whenIdle();
  const timeoutElapsed = performance.now() - timeoutStarted;
  assert.ok(timeoutElapsed >= 10000 && timeoutElapsed < 12000, "COMPLETION_TIMEOUT_WINDOW");
  assert.equal(completionAborts, 2); assert.equal(reads.length, 0);
  assert.deepEqual(fixture.readAnalysisCounts(), { quota: 1, mailbox: 1, analysis: 1 });
  await receiveCompletion(page); await click(page, "Close"); await closed(page);
  report.observations.completionTimeout = { actualTimeoutMs: 10000, observedElapsedMs: Math.round(timeoutElapsed),
    analysisRerun: false, automaticCandidateRead: false, observedServerAbort: true };
  pass("actual_10s_completion_timeout_aborts_marks_unconfirmed_manual_recheck_no_analysis_replay");

  report.stage = "completion_pending_native_back";
  await click(page, "Open"); await expect(panel(page)).toHaveAttribute("data-open", "yes");
  holdNextCompletion = true; armExpectedAbort("/__candidate_completion", page);
  await click(page, "저장 결과 받기·다시 확인");
  await bounded((async () => { while (!releaseCompletion) await delay(20); })());
  await page.getByRole("link", { name: "Leave document", exact: true }).click();
  await expect(page).toHaveURL(origin + "/__candidate_away.html"); await whenIdle();
  const completionBeforeBack = completions;
  assert.equal(completionAborts, 3);
  await page.goBack({ waitUntil: "commit" }); await closed(page);
  await expect(page.getByTestId("analysis-delivery")).toHaveAttribute("data-phase", "closed");
  await delay(200); assert.equal(completions, completionBeforeBack);
  assert.equal(reads.length, 0); assert.equal(catalogWire.length, 0); assert.equal(wire.length, 0);
  assert.deepEqual(fixture.readAnalysisCounts(), { quota: 1, mailbox: 1, analysis: 1 });
  pass("pending_completion_native_pagehide_aborts_back_stays_closed_no_replay_or_auto_read");

  report.stage = "explicit_selection"; await open(page); assert.equal(catalogWire.length, 1); assert.equal(wire.length, 0);
  const candidates = page.getByLabel("검토할 후보", { exact: true }), services = page.getByLabel("연결할 기존 서비스", { exact: true });
  await expect(candidates).toHaveValue(""); await expect(services).toHaveValue(""); await expect(form(page)).toHaveCount(0);
  await candidates.selectOption(fixture.batch.candidates[0]!.candidateId); await expect(services).toHaveValue("");
  await services.selectOption(fixture.services[1]!.serviceId); await click(page, "검토할 내용으로 가져오기");
  await expect(form(page)).toHaveCount(0); assert.equal(wire.length, 0);
  await page.getByLabel("이름 없는 후보에 붙일 혜택 이름", { exact: true }).fill("선택한 합성 크레딧");
  await click(page, "검토할 내용으로 가져오기"); await expect(form(page)).toHaveCount(1);
  await expect(form(page).getByLabel("기록된 잔량", { exact: true })).toHaveValue(""); assert.equal(wire.length, 0);
  pass("explicit_distinct_candidate_and_service_selection_missing_name_blocks_without_http");

  report.stage = "catalog_restart"; const beforeRestart = catalogWire.length;
  await click(page, "서비스 목록 처음부터 다시 확인"); await expect(form(page)).toHaveCount(0);
  await expect(page.getByTestId("candidate-picker")).toHaveAttribute("data-state", "invalid"); assert.equal(wire.length, 0);
  assert.equal(catalogWire.length, beforeRestart);
  await nextCatalog(page); await expect(page.getByTestId("candidate-picker")).toHaveAttribute("data-state", "ready");
  await expect(candidates).toHaveValue(""); await choose(page, 0, 1, "선택한 합성 크레딧");
  pass("catalog_restart_clears_draft_no_auto_http_explicit_page_requires_reselection");

  report.stage = "preview_save_refresh"; await form(page).getByLabel("기록된 잔량", { exact: true }).fill("0");
  await click(page, "미리보기 요청"); const preview = page.getByTestId("review-panel-preview"); await expect(preview).toHaveCount(1);
  await expect(preview).toContainText("Synthetic Service Plus"); await expect(page.getByTestId("review-panel-preview-remainingAmount")).toHaveText("0");
  await expect(page.getByTestId("review-panel-preview-remainingAmount").locator("..")).toContainText("사용자가 수정한 값");
  assert.equal(await preview.locator("dl").evaluate((node) => node.children.length === 13 && [...node.children].every((group) =>
    group.tagName === "DIV" && group.children[0]?.tagName === "DT" && group.children.length >= 2
    && [...group.children].slice(1).every((description) => description.tagName === "DD"))), true);
  pass("actual_preview_description_list_uniform_groups_preserve_nine_value_origins_and_four_timestamps");
  assert.equal(fixture.store.rows.benefits.size, 0);
  const confirm = page.getByRole("button", { name: "이 내용으로 기록 저장", exact: true });
  await confirm.focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("review-panel-status")).toContainText("기록");
  await expect(page.getByTestId("review-panel-rows").locator("li")).toHaveCount(1); await whenIdle();
  assert.equal(fixture.store.rows.benefits.size, 1);
  const saved = [...fixture.store.rows.benefits.values()][0]!;
  assert.equal(saved.content?.serviceId, fixture.services[1]!.serviceId); assert.equal(saved.content?.values.remainingAmount, 0);
  await click(page, "목록 새로 확인"); await click(page, "첫 페이지 불러오기"); await expect(panel(page)).toHaveAttribute("data-list", "end_observed");
  await reload(page);
  await expect(candidates.locator("option")).toHaveCount(2); await expect(form(page)).toHaveCount(0);
  const refreshed = await fixture.refresh(); assert.equal(refreshed.candidates[0]!.state, "accepted"); assert.equal(refreshed.candidates[0]!.content, null);
  assert.deepEqual(refreshed.candidates[1], fixture.batch.candidates[1]);
  pass("actual_preview_corrected_zero_confirm_selected_service_list_and_accepted_refresh_preserve_other_candidate");

  report.stage = "saved_observation_details";
  const detail = page.getByTestId("review-record-details"), detailToggle = page.getByTestId("review-detail-toggle").first();
  const disclosureIO = () => ({ nativeApiRequestStarts, review: wire.length, catalog: catalogWire.length, mutations: catalogMutationWire.length,
    inbox: reads.length, completion: completions });
  const beforeDisclosure = disclosureIO();
  await expect(detail).toHaveCount(0); await expect(detailToggle).toHaveAttribute("aria-expanded", "false");
  await detailToggle.focus(); await page.keyboard.press("Enter"); await expect(detail).toBeVisible();
  await expect(detailToggle).toBeFocused(); await expect(detailToggle).toHaveAttribute("aria-expanded", "true");
  assert.equal(await detailToggle.getAttribute("aria-controls"), await detail.getAttribute("id"));
  assert.equal(await detail.locator("dl").evaluate((node) => node.children.length === 14 && [...node.children].every((group) =>
    group.tagName === "DIV" && group.children[0]?.tagName === "DT" && group.children.length >= 2
    && [...group.children].slice(1).every((description) => description.tagName === "DD"))), true);
  pass("actual_saved_detail_description_list_uniform_groups_preserve_fields_and_metadata");
  assert.ok(saved.content);
  for (const [field, value] of Object.entries(saved.content.values)) {
    await expect(page.getByTestId(`reviewed-benefit-detail-value-${field}`)).toHaveText(value === null ? "모름" : String(value));
    const key = field as keyof typeof saved.content.valueOrigins;
    await expect(page.getByTestId(`reviewed-benefit-detail-origin-${field}`))
      .toHaveText(saved.content.valueOrigins[key] === "user-corrected" ? "사용자가 수정한 값" : "메일에서 추출된 값");
  }
  await expect(detail.locator('[data-testid^="reviewed-benefit-detail-value-"]')).toHaveCount(9);
  await expect(page.getByTestId("reviewed-benefit-detail-service")).toHaveText(saved.content.serviceNameAtReview);
  for (const [key, value] of Object.entries({ receivedAt: saved.content.source.receivedAt,
    extractedAt: saved.content.source.extractedAt, sourceObservedAt: saved.content.source.values.observedAt,
    reviewedAt: saved.content.reviewedAt })) {
    await expect(page.getByTestId(`reviewed-benefit-detail-${key}`)).toHaveText(value === null ? "모름" : String(value));
  }
  for (const reason of saved.content.source.reviewReasons) await expect(detail.locator(`[data-review-reason="${reason}"]`)).toHaveText(reason);
  await expect(detail).toContainText("새 조회나 현재 잔액 검증이 아닙니다");
  const detailClose = detail.getByRole("button", { name: "상세 보기 닫기", exact: true });
  await detailClose.focus(); await page.keyboard.press("Escape"); await expect(detail).toHaveCount(0);
  await expect(detailToggle).toBeFocused();
  await page.keyboard.press("Enter"); await expect(detail).toBeVisible();
  await click(page, "불러온 지난 기록"); await expect(detail).toHaveCount(0);
  await click(page, "불러온 확인할 기록"); await expect(detail).toHaveCount(0);
  await expect(detailToggle).toHaveAttribute("aria-expanded", "false");
  await whenIdle(); assert.deepEqual(disclosureIO(), beforeDisclosure);
  pass("saved_detail_explicit_keyboard_disclosure_exact_nine_values_origins_times_escape_focus_and_filter_no_io");

  // An unchanged revision is not a row replacement. A deliberately delayed real
  // get must retain that selection and must not steal focus moved elsewhere.
  await detailToggle.click(); holdNextGetReply = true;
  const beforeGet = wire.length;
  await click(page, "이 기록 다시 확인");
  await bounded((async () => { while (!releaseGetReply) await delay(20); })());
  await page.getByRole("button", { name: "Close", exact: true }).focus();
  releaseHeldGetReply(); await whenIdle();
  await expect(page.getByTestId("review-panel-status")).toContainText("현재 저장 관찰을 다시 확인했습니다");
  assert.equal(wire.length, beforeGet + 1); assert.equal(wire.at(-1)?.action, "get");
  await expect(detail).toBeVisible(); await expect(page.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  // Controlled DOM invocation leaves focus inside the disappearing disclosure;
  // the real restart operation must settle it on the panel status, not body.
  await detailClose.focus();
  await page.getByRole("button", { name: "목록 새로 확인", exact: true }).evaluate((node) => {
    if (!(node instanceof HTMLButtonElement)) throw Error("CANDIDATE_DETAIL_RESTART_BUTTON_MISSING");
    node.click();
  });
  await expect(detail).toHaveCount(0); await expect(page.getByTestId("review-panel-status")).toBeFocused();
  await click(page, "첫 페이지 불러오기"); await expect(panel(page)).toHaveAttribute("data-list", "end_observed");
  await expect(detail).toHaveCount(0); await expect(detailToggle).toHaveAttribute("aria-expanded", "false");
  pass("same_revision_delayed_get_preserves_detail_and_external_focus_restart_discards_selection_without_auto_reopen");

  report.stage = "mobile_keyboard";
  for (const width of [320, 360]) { await page.setViewportSize({ width, height: 800 });
    await click(page, "불러온 확인할 기록"); await detailToggle.click(); await expect(detail).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "CANDIDATE_DETAIL_OVERFLOW");
    await detailClose.focus(); await page.keyboard.press("Escape"); await expect(detailToggle).toBeFocused();
    const button = page.getByRole("button", { name: "불러온 지난 기록", exact: true }); await button.focus(); await page.keyboard.press("Enter");
    await expect(button).toBeFocused();
    const measured = { width, focusVisible: await button.evaluate((node) => node.matches(":focus-visible")),
      documentWidth: await page.evaluate(() => document.documentElement.scrollWidth),
      overflowing: await page.evaluate(() => [...document.querySelectorAll("fieldset,select,input,section,main,h1,p")]
        .filter((node) => node.getBoundingClientRect().right > innerWidth).slice(0, 10).map((node) => ({
          tag: node.tagName, testid: node.getAttribute("data-testid"), right: node.getBoundingClientRect().right,
          minWidth: getComputedStyle(node).minWidth }))) };
    report.observations.mobile = [...(report.observations.mobile as unknown[] ?? []), measured];
    assert.equal(measured.focusVisible, true, "CANDIDATE_FOCUS_NOT_VISIBLE");
    assert.ok(measured.documentWidth <= width, "CANDIDATE_OVERFLOW"); }
  await page.setViewportSize({ width: 1280, height: 900 });
  await click(page, "불러온 확인할 기록");
  // Create a second observation using the remaining real staged candidate, so
  // a focus callback can open a genuinely different row during old-detail close.
  report.stage = "saved_detail_focus_reentry";
  await choose(page, 1, 0); await click(page, "미리보기 요청");
  await expect(page.getByTestId("review-panel-preview")).toHaveCount(1); await click(page, "이 내용으로 기록 저장");
  const rowToggles = page.getByTestId("review-detail-toggle"); await expect(rowToggles).toHaveCount(2); await whenIdle();
  const beforeReentry = disclosureIO();
  await rowToggles.nth(0).click(); await expect(detail).toBeVisible();
  await page.evaluate(() => {
    const buttons = document.querySelectorAll<HTMLButtonElement>('[data-testid="review-detail-toggle"]');
    buttons[0]!.addEventListener("focus", () => buttons[1]!.click(), { once: true });
  });
  await detailClose.focus(); await page.keyboard.press("Escape");
  await expect(rowToggles.nth(0)).toHaveAttribute("aria-expanded", "false");
  await expect(rowToggles.nth(1)).toHaveAttribute("aria-expanded", "true");
  await expect(detail).toContainText("Synthetic trial offer"); await whenIdle();
  assert.deepEqual(disclosureIO(), beforeReentry);
  pass("controlled_focus_callback_opens_second_saved_detail_without_old_close_overwriting_new_selection");

  report.stage = "saved_detail_native_history";
  const detailMarker = await observeLifecycle(page), beforeDetailNavigation = disclosureIO();
  await page.getByRole("link", { name: "Leave document", exact: true }).click();
  await expect(page).toHaveURL(origin + "/__candidate_away.html"); await page.goBack({ waitUntil: "commit" });
  await expect(page).toHaveURL(origin + "/__candidate.html"); await closed(page); await expect(detail).toHaveCount(0);
  if (await recordLifecycle(page, detailMarker, "savedDetailBfcache")) pass("native_saved_detail_bfcache_event_time_private_dom_closed_no_automatic_reopen");
  assert.deepEqual(disclosureIO(), beforeDetailNavigation);
  await open(page); await click(page, "첫 페이지 불러오기"); await expect(panel(page)).toHaveAttribute("data-list", "end_observed");
  await expect(detail).toHaveCount(0); await expect(rowToggles).toHaveCount(2);
  await rowToggles.nth(1).click(); await expect(detail).toContainText("Synthetic trial offer");
  report.stage = "saved_detail_delete";
  const selectedRow = page.getByTestId("review-panel-rows").locator(":scope > li").nth(1);
  await selectedRow.getByRole("button", { name: "기록 삭제 검토", exact: true }).click();
  await page.getByLabel("삭제 확인 문구", { exact: true }).fill("삭제"); await click(page, "앱 기록 삭제");
  await expect(detail).toHaveCount(0); await expect(rowToggles).toHaveCount(1); await whenIdle();
  assert.equal([...fixture.store.rows.benefits.values()].filter((row) => row.state === "deleted" && row.content === null).length, 1);
  await click(page, "목록 새로 확인"); await click(page, "첫 페이지 불러오기");
  await expect(panel(page)).toHaveAttribute("data-list", "end_observed"); await expect(rowToggles).toHaveCount(1); await expect(detail).toHaveCount(0);
  pass("actual_explicit_delete_tombstone_removes_open_detail_and_readback_does_not_resurrect_it");
  await click(page, "Close"); await closed(page);
  pass("320_360px_keyboard_filter_focus_and_closed_selection_dom");

  // New owned synthetic store/document, not undoing a previous mutation or
  // copying private server rows into a fake UI. Actual staging is repeated.
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page); await choose(page, 0, 1, "원래 요청 합성 혜택");
  await click(page, "미리보기 요청"); await expect(page.getByTestId("review-panel-preview")).toHaveCount(1);
  report.stage = "uncertain_commit"; const beforeCommit = fixture.store.controls.commits, beforeWire = wire.length;
  expected503 = true; fixture.store.controls.afterCommit = () => { delete fixture.store.controls.afterCommit; throw new Error(SYNTHETIC_PRIVATE); };
  await click(page, "이 내용으로 기록 저장"); const reconciliation = page.getByRole("group", { name: "결과 재확인", exact: true });
  await expect(reconciliation).toBeVisible(); await expect(page.getByTestId("review-panel-status")).toContainText("같은 요청으로 결과를 다시 확인하세요");
  await whenIdle(); assert.equal(fixture.store.controls.commits, beforeCommit + 1); assert.equal(fixture.store.rows.benefits.size, 1);
  assert.equal(wire[beforeWire]?.status, 503); let committedRows = fixture.store.snapshot();
  await receiveCompletion(page); await expect(reconciliation).toContainText("원래 요청 합성 혜택");
  await reload(page); await expect(reconciliation).toContainText("원래 요청 합성 혜택");
  await click(page, "서비스 목록 처음부터 다시 확인"); await expect(reconciliation).toContainText("원래 요청 합성 혜택");
  await nextCatalog(page); await expect(reconciliation).toContainText("원래 요청 합성 혜택");
  // Creating an unrelated service must not reset the existing review command.
  await previewCreate(page, "새 합성 서비스", "직접 입력한 합성 제공자"); await saveCreate(page);
  await expect(reconciliation).toContainText("원래 요청 합성 혜택");
  await expect(reconciliation).toContainText("Synthetic Service Plus");
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  committedRows = fixture.store.snapshot();
  await choose(page, 1, 0); await expect(reconciliation).toContainText("원래 요청 합성 혜택");
  await expect(reconciliation).toContainText("Synthetic Service Plus"); await expect(form(page).getByLabel("혜택 이름", { exact: true })).toHaveValue("Synthetic trial offer");
  await inspectCatalogWithoutChangingPendingCommand(page);
  await expect(reconciliation).toContainText("원래 요청 합성 혜택");
  await expect(reconciliation).toContainText("Synthetic Service Plus");
  pass("read_only_service_details_and_local_search_preserve_original_uncertain_benefit_without_http_or_writes");
  const beforeRetry = wire.length; await delay(200); assert.equal(wire.length, beforeRetry);
  await click(page, "같은 요청의 결과 다시 확인"); await expect(reconciliation).toHaveCount(0); await whenIdle();
  assert.deepEqual(fixture.store.snapshot(), committedRows); assert.equal(wire.length, beforeRetry + 1);
  assert.equal(wire[beforeWire]!.digest, wire.at(-1)!.digest); assert.equal(wire.at(-1)!.status, 200);
  await reload(page);
  await expect(page.getByLabel("검토할 후보", { exact: true }).locator("option")).toHaveCount(2);
  assert.equal(matched503, 1); assert.equal(expected503, false);
  pass("postcommit_503_new_selection_preserves_original_facts_and_identical_command_retry_then_actual_refresh");
  pass("unrelated_explicit_service_creation_preserves_uncertain_review_command_without_automatic_list_or_review_io");

  // Separate clean document prevents Chrome replaying the earlier expected
  // console resource error during BFCache restore; no error allowlist widening.
  await click(page, "Close"); await closed(page); await closePage(page); await whenIdle(); await freshFixture(5000);
  page = await newPage(); await open(page); await choose(page, 0, 0, "짧은 접근 합성 혜택");
  await page.getByLabel("이름 없는 후보에 붙일 혜택 이름", { exact: true }).focus();
  const deadline = fixture.batch.candidates[0]!.accessExpiresAt, expiryRequests = wire.length;
  report.stage = "real_access_expiry";
  await page.evaluate(() => { window.candidateExpiryObserved = null;
    const observer = new MutationObserver(() => { if (!document.querySelector('form[aria-label="선택한 혜택 초안"]')) {
      window.candidateExpiryObserved = Date.now(); observer.disconnect(); } }); observer.observe(document.body, { childList: true, subtree: true }); });
  await expect(form(page)).toHaveCount(0, { timeout: 7000 });
  await expect(page.getByLabel("검토할 후보", { exact: true }).locator("option")).toHaveCount(1);
  await expect(page.getByTestId("candidate-picker").getByRole("status")).toBeFocused();
  const observedExpiry = await page.evaluate(() => window.candidateExpiryObserved);
  assert.ok(observedExpiry !== null && observedExpiry !== undefined && observedExpiry >= deadline, "CANDIDATE_EARLY_EXPIRY");
  assert.equal(wire.length, expiryRequests); const expired = await fixture.refresh(); assert.ok(expired.candidates.every((row) => row.state === "expired" && row.content === null));
  report.observations.expiry = { grantWindowMs: 5000, observedAfterDeadlineMs: observedExpiry - deadline,
    removedNameInputFocusRestored: true, automaticReviewRequests: 0 };
  pass("real_foreground_access_deadline_clears_selected_draft_no_http_matches_inbox_expired_projection");

  await click(page, "Close"); await closed(page); await closePage(page); await whenIdle(); await freshFixture(); page = await newPage();
  await open(page); await choose(page, 1, 0); await click(page, "미리보기 요청"); await expect(page.getByTestId("review-panel-preview")).toHaveCount(1);
  report.stage = "native_history";
  const marker = await observeLifecycle(page);
  const link = page.getByRole("link", { name: "Leave document", exact: true }); assert.equal(await link.getAttribute("href"), "/__candidate_away.html");
  const beforeNavigationRequests = wire.length, beforeNavigationObservations = catalogWire.length, beforeNavigationReads = reads.length,
    beforeNavigationCompletions = completions;
  await link.click(); await expect(page).toHaveURL(origin + "/__candidate_away.html"); await page.goBack({ waitUntil: "commit" });
  await expect(page).toHaveURL(origin + "/__candidate.html"); await closed(page);
  if (await recordLifecycle(page, marker, "bfcache")) pass("trusted_persisted_bfcache_same_document_removes_candidate_editor_preview_no_auto_reopen");
  await delay(300); await closed(page); assert.equal(wire.length, beforeNavigationRequests); assert.equal(catalogWire.length, beforeNavigationObservations);
  assert.equal(reads.length, beforeNavigationReads);
  assert.equal(completions, beforeNavigationCompletions);
  await expect(page.getByTestId("analysis-delivery")).toHaveAttribute("data-phase", "closed");

  report.stage = "pending_read_cancel";
  await open(page); holdNextRead = true; armExpectedAbort("/api/inbox/batch", page);
  await click(page, "후보 불러오기·새로 확인");
  await expect(page.getByTestId("candidate-loader")).toHaveAttribute("data-phase", "loading");
  await bounded((async () => { while (!releaseRead) await delay(20); })());
  await page.getByRole("button", { name: "후보 조회 취소", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("candidate-loader")).toHaveAttribute("data-phase", "idle");
  report.observations.candidateCancelFocus = await page.evaluate(() => ({
    body: document.activeElement === document.body,
    status: document.activeElement === document.querySelector('[data-testid="candidate-loader"] > [role="status"]'),
    disabledButton: document.activeElement instanceof HTMLButtonElement && document.activeElement.disabled,
  }));
  await expect(page.getByTestId("candidate-loader").locator(':scope > [role="status"]')).toBeFocused();
  await expect(page.getByRole("button", { name: "후보 불러오기·새로 확인", exact: true })).toBeEnabled();
  await whenIdle(); await reload(page); await whenIdle();
  assert.equal(reads.filter((read) => read.code === "API_ABORTED").length, 1, "CANDIDATE_CANCEL_SERVER_ABORT_COUNT");
  pass("actual_pending_inbox_read_explicit_cancel_clears_loading_then_manual_reload");

  report.stage = "pending_read_native_navigation";
  holdNextRead = true; armExpectedAbort("/api/inbox/batch", page);
  await click(page, "후보 불러오기·새로 확인");
  await expect(page.getByTestId("candidate-loader")).toHaveAttribute("data-phase", "loading");
  await bounded((async () => { while (!releaseRead) await delay(20); })());
  await click(page, "Close"); await closed(page); await whenIdle();
  assert.equal(reads.filter((read) => read.code === "API_ABORTED").length, 2, "CANDIDATE_CLOSE_SERVER_ABORT_COUNT");
  // Reopen without an implicit candidate request, then prove pending native
  // navigation also releases loading and cannot reopen its lease after back.
  await open(page); await whenIdle(); holdNextRead = true; armExpectedAbort("/api/inbox/batch", page);
  await click(page, "후보 불러오기·새로 확인");
  await bounded((async () => { while (!releaseRead) await delay(20); })());
  await page.getByRole("link", { name: "Leave document", exact: true }).click();
  await expect(page).toHaveURL(origin + "/__candidate_away.html"); await whenIdle();
  const closedReads = reads.length;
  await page.goBack({ waitUntil: "commit" }); await closed(page);
  await expect(page.getByRole("button", { name: "Open", exact: true })).toBeEnabled();
  await delay(200); assert.equal(reads.length, closedReads, "CANDIDATE_UNEXPECTED_AUTO_READ");
  await open(page); await whenIdle();
  const serverAborts = reads.filter((read) => read.status === 408 && read.code === "API_ABORTED").length;
  assert.equal(serverAborts, 3, "CANDIDATE_SERVER_ABORT_COUNT");
  // Chrome/CDP may omit requestfailed for a fetch abandoned on native BFCache
  // navigation. The actual server signal + API_ABORTED receipt, cleared DOM and
  // explicit reopen are primary evidence; do not count an omitted CDP event.
  assert.equal(expectedAbortArms.has("/api/inbox/batch"), false, "CANDIDATE_MISSING_READ_REQUEST");
  report.observations.pendingReads = { serverAborts, matchedReadAborts, requestFailedEventsNotObserved: expectedReadAborts.size,
    statuses: reads.map((read) => read.status), automaticReadAfterBack: false };
  pass("pending_close_and_native_back_abort_reads_restore_manual_open_without_auto_fetch");

  report.stage = "read_authority_revocation";
  fixture.store.controls.authority = null; expected401 = true;
  await click(page, "후보 불러오기·새로 확인"); await closed(page); await whenIdle();
  await expect(page.getByTestId("candidate-loader")).toHaveAttribute("data-phase", "closed");
  assert.equal(reads.at(-1)?.code, "API_AUTH_REQUIRED");
  const revokedReadCount = reads.length; await delay(200); assert.equal(reads.length, revokedReadCount);
  assert.equal(matched401, 1); assert.equal(expected401, false);
  pass("actual_inbox_auth_rejection_closes_existing_review_lease_no_auto_reopen");

  // List data is now supplied by the real catalog HTTP/client/store path. These
  // extra services and the deletion go through the real catalog controller;
  // neither fetch responses nor browser source values are injected.
  report.stage = "catalog_partial_pages";
  await closePage(page); await whenIdle(); await freshFixture();
  const catalog = createServiceCatalog(fixture.store.catalogDependencies);
  for (let index = 0; index < 50; index++) {
    const added = await catalog.create({ operationId: `synthetic-extra-service-${index}`, decision: "create",
      profile: { name: `Synthetic extra service ${index}`, provider: null, planName: null, accountLabel: null,
        timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null } });
    assert.equal(added.ok, true, "CANDIDATE_CATALOG_SEED_FAILED");
  }
  page = await newPage(); const pageStart = catalogWire.length;
  await click(page, "Open"); await expect(panel(page)).toHaveAttribute("data-open", "yes");
  assert.equal(catalogWire.length, pageStart);
  await receiveCompletion(page);
  await nextCatalog(page, "more"); await reload(page);
  const catalogPanel = page.getByTestId("catalog-selection"), serviceChoices = page.getByLabel("연결할 기존 서비스", { exact: true });
  await expect(catalogPanel).toHaveAttribute("data-pages", "1"); await expect(catalogPanel).toHaveAttribute("data-rows", "50");
  await expect(catalogPanel.getByRole("status")).toContainText("일부"); await expect(serviceChoices.locator("option")).toHaveCount(51);
  await delay(200); assert.equal(catalogWire.length, pageStart + 1);
  await nextCatalog(page); await expect(catalogPanel).toHaveAttribute("data-pages", "2");
  await expect(catalogPanel).toHaveAttribute("data-rows", "52"); await expect(serviceChoices.locator("option")).toHaveCount(53);
  await expect(catalogPanel.getByRole("status")).toContainText("증명은 아닙니다");
  await expect(page.getByRole("button", { name: "서비스 다음 목록 불러오기", exact: true })).toBeDisabled();
  assert.equal(catalogWire.length, pageStart + 2); assert.equal(fixture.store.rows.benefits.size, 0);
  assert.deepEqual(catalogWire.slice(pageStart).map((request) => request.cursor), [false, true]);
  pass("actual_catalog_52_services_two_explicit_pages_partial_labels_and_no_automatic_selection_or_save");

  report.stage = "catalog_revision_and_deleted_selection";
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page, "more");
  await choose(page, 0, 0, "삭제 확인 합성 혜택"); await click(page, "미리보기 요청");
  await expect(page.getByTestId("review-panel-preview")).toHaveCount(1); await whenIdle();
  const removed = await catalog.remove({ operationId: "synthetic-delete-selected-service", decision: "delete",
    serviceId: fixture.services[0]!.serviceId, expectedRevision: fixture.services[0]!.serviceRevision });
  assert.equal(removed.ok, true, "CANDIDATE_CATALOG_DELETE_FAILED");
  expectedCatalog409 = true; await click(page, "서비스 다음 목록 불러오기");
  await expect(catalogPanel).toHaveAttribute("data-phase", "restart_required");
  await expect(form(page)).toHaveCount(0); await expect(page.getByTestId("review-panel-preview")).toHaveCount(0);
  await whenIdle(); assert.equal(catalogWire.at(-1)?.code, "API_CONFLICT");
  assert.equal(matchedCatalog409, 1); assert.equal(expectedCatalog409, false);
  await expect(page.getByRole("button", { name: "서비스 다음 목록 불러오기", exact: true })).toBeDisabled();
  const conflictRequests = catalogWire.length;
  await click(page, "서비스 목록 처음부터 다시 확인"); assert.equal(catalogWire.length, conflictRequests);
  await nextCatalog(page, "more"); await nextCatalog(page); await expect(serviceChoices).toHaveValue("");
  await expect(serviceChoices.locator(`option[value="${fixture.services[0]!.serviceId}"]`)).toHaveCount(0);
  await expect(serviceChoices.locator("option")).toHaveCount(52);
  assert.equal(catalogWire[conflictRequests]?.cursor, false); assert.equal(fixture.store.rows.benefits.size, 0);
  pass("actual_midpage_catalog_delete_conflicts_old_cursor_requires_manual_restart_and_hides_deleted_selection_preview");

  // A clean document avoids attributing replayed expected resource errors to a
  // new BFCache navigation. Native signals are not simulated in the product.
  report.stage = "catalog_pending_cancel_and_back";
  await click(page, "Close"); await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  await click(page, "서비스 목록 처음부터 다시 확인"); holdNextCatalog = true; armExpectedAbort("/api/catalog/list", page);
  await click(page, "서비스 다음 목록 불러오기");
  await expect(page.getByTestId("catalog-selection")).toHaveAttribute("data-phase", "loading");
  await bounded((async () => { while (!releaseCatalog) await delay(20); })());
  await page.getByRole("button", { name: "서비스 조회 취소", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("catalog-selection")).toHaveAttribute("data-phase", "restart_required");
  report.observations.catalogCancelFocus = await page.evaluate(() => ({
    body: document.activeElement === document.body,
    status: document.activeElement === document.querySelector('[data-testid="catalog-selection"] [role="status"]'),
    disabledButton: document.activeElement instanceof HTMLButtonElement && document.activeElement.disabled,
  }));
  await expect(page.getByTestId("catalog-selection").getByRole("status")).toBeFocused();
  await expect(form(page)).toHaveCount(0); await whenIdle();
  assert.equal(catalogWire.filter((request) => request.code === "API_ABORTED").length, 1);
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await click(page, "서비스 목록 처음부터 다시 확인"); holdNextCatalog = true; armExpectedAbort("/api/catalog/list", page);
  await click(page, "서비스 다음 목록 불러오기"); await bounded((async () => { while (!releaseCatalog) await delay(20); })());
  await page.getByRole("link", { name: "Leave document", exact: true }).click();
  await expect(page).toHaveURL(origin + "/__candidate_away.html"); await whenIdle();
  const catalogBack = catalogWire.length, candidateBack = reads.length;
  await page.goBack({ waitUntil: "commit" }); await closed(page);
  await expect(page.getByTestId("catalog-selection")).toHaveAttribute("data-phase", "closed");
  await delay(200); assert.equal(catalogWire.length, catalogBack); assert.equal(reads.length, candidateBack);
  assert.equal(catalogWire.filter((request) => request.status === 408 && request.code === "API_ABORTED").length, 2);
  assert.equal(expectedAbortArms.has("/api/catalog/list"), false); await open(page);
  report.observations.pendingCatalog = { serverAborts: 2, matchedCatalogAborts,
    requestFailedEventsNotObserved: expectedCatalogAborts.size, automaticReadAfterBack: false };
  pass("actual_pending_catalog_cancel_and_native_back_abort_clear_services_no_auto_read_manual_reopen");

  report.stage = "catalog_cancel_focus_ownership_and_reentry";
  for (const mode of ["external", "focus-reentry", "abort-external", "abort-body", "abort-close"] as const) {
    await browserPrivacy(page); await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
    await click(page, "서비스 목록 처음부터 다시 확인");
    await page.evaluate((mode) => {
      const selection = document.querySelector('[data-testid="catalog-selection"]');
      const status = selection?.querySelector('[role="status"]');
      const external = document.querySelector<HTMLAnchorElement>('a[href="/__candidate_away.html"]');
      const buttons = [...document.querySelectorAll("button")];
      const closeButton = buttons.find((item) => item.textContent === "Close");
      const restartButton = buttons.find((item) => item.textContent === "서비스 목록 처음부터 다시 확인");
      const nextButton = buttons.find((item) => item.textContent === "서비스 다음 목록 불러오기");
      const cancelButton = buttons.find((item) => item.textContent === "서비스 조회 취소");
      if (!(status instanceof HTMLElement) || !external || !closeButton || !restartButton || !nextButton || !cancelButton) throw Error("SYNTHETIC_CANCEL_FOCUS_TARGET");
      if (mode === "focus-reentry") status.addEventListener("focus", () => {
        status.dataset.cancelReentry = "yes";
        status.dataset.cancelReentryDisabled = JSON.stringify([restartButton.disabled, nextButton.disabled, cancelButton.disabled]);
        restartButton.click(); nextButton.click(); cancelButton.click();
      }, { once: true });
      if (mode.startsWith("abort-")) {
        const original = window.fetch;
        window.fetch = (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          if (new URL(url, location.href).pathname === "/api/catalog/list") {
            window.fetch = original;
            const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
            if (!signal) throw Error("SYNTHETIC_CANCEL_SIGNAL_MISSING");
            signal.addEventListener("abort", () => {
              external.dataset.cancelAbort = "yes";
              if (mode === "abort-close") closeButton.click();
              if (mode === "abort-body") { document.body.tabIndex = -1; document.body.focus(); }
              else external.focus();
            }, { once: true });
          }
          return original.call(window, input, init);
        };
      }
    }, mode);
    holdNextCatalog = true; armExpectedAbort("/api/catalog/list", page);
    await click(page, "서비스 다음 목록 불러오기"); await bounded((async () => { while (!releaseCatalog) await delay(20); })());
    const cancelReads = nativeApiRequestStarts, cancelWrites = catalogMutationWire.length, cancelRows = fixture.store.snapshot();
    const cancelButton = page.getByRole("button", { name: "서비스 조회 취소", exact: true });
    const external = page.getByRole("link", { name: "Leave document", exact: true });
    if (mode === "external") {
      await external.focus(); await cancelButton.evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) throw Error("SYNTHETIC_CANCEL_BUTTON_MISSING");
        button.click();
      });
    }
    else { await cancelButton.focus(); await page.keyboard.press("Enter"); }
    await whenIdle();
    if (mode === "abort-close") await closed(page);
    else await expect(page.getByTestId("catalog-selection")).toHaveAttribute("data-phase", "restart_required");
    if (mode === "focus-reentry") {
      await expect(page.getByTestId("catalog-selection-status")).toHaveAttribute("data-cancel-reentry", "yes");
      await expect(page.getByTestId("catalog-selection-status")).toBeFocused();
      report.observations.cancelReentryDisabled = JSON.parse((await page.getByTestId("catalog-selection-status").getAttribute("data-cancel-reentry-disabled"))!);
    } else if (mode === "abort-body") await expect(page.locator("body")).toBeFocused();
    else await expect(external).toBeFocused();
    if (mode.startsWith("abort-")) await expect(external).toHaveAttribute("data-cancel-abort", "yes");
    assert.equal(nativeApiRequestStarts, cancelReads); assert.equal(catalogMutationWire.length, cancelWrites);
    assert.deepEqual(fixture.store.snapshot(), cancelRows); assert.equal(catalogWire.at(-1)?.code, "API_ABORTED");
    assert.equal(expectedAbortArms.has("/api/catalog/list"), false);
    pass(`catalog_cancel_${mode}_keeps_focus_ownership_and_no_extra_io_or_saved_row_changes`);
  }

  report.stage = "candidate_cancel_focus_ownership_and_reentry";
  for (const mode of ["external", "focus-reentry", "abort-external", "abort-body", "abort-close"] as const) {
    await browserPrivacy(page); await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
    await page.evaluate((mode) => {
      const status = document.querySelector('[data-testid="candidate-loader-status"]');
      const external = document.querySelector<HTMLAnchorElement>('a[href="/__candidate_away.html"]');
      const buttons = [...document.querySelectorAll("button")];
      const closeButton = buttons.find((item) => item.textContent === "Close");
      const reloadButton = buttons.find((item) => item.textContent === "후보 불러오기·새로 확인");
      const cancelButton = buttons.find((item) => item.textContent === "후보 조회 취소");
      if (!(status instanceof HTMLElement) || !external || !closeButton || !reloadButton || !cancelButton) throw Error("SYNTHETIC_CANDIDATE_CANCEL_FOCUS_TARGET");
      if (mode === "focus-reentry") status.addEventListener("focus", () => {
        status.dataset.cancelReentry = "yes";
        status.dataset.cancelReentryDisabled = JSON.stringify([reloadButton.disabled, cancelButton.disabled]);
        reloadButton.click(); cancelButton.click();
      }, { once: true });
      if (mode.startsWith("abort-")) {
        const original = window.fetch;
        window.fetch = (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          if (new URL(url, location.href).pathname === "/api/inbox/batch") {
            window.fetch = original;
            const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
            if (!signal) throw Error("SYNTHETIC_CANDIDATE_CANCEL_SIGNAL_MISSING");
            signal.addEventListener("abort", () => {
              external.dataset.cancelAbort = "yes";
              if (mode === "abort-close") closeButton.click();
              if (mode === "abort-body") { document.body.tabIndex = -1; document.body.focus(); }
              else external.focus();
            }, { once: true });
          }
          return original.call(window, input, init);
        };
      }
    }, mode);
    holdNextRead = true; armExpectedAbort("/api/inbox/batch", page);
    await click(page, "후보 불러오기·새로 확인"); await bounded((async () => { while (!releaseRead) await delay(20); })());
    const cancelReads = nativeApiRequestStarts, cancelWrites = catalogMutationWire.length, cancelRows = fixture.store.snapshot();
    const cancelButton = page.getByRole("button", { name: "후보 조회 취소", exact: true });
    const external = page.getByRole("link", { name: "Leave document", exact: true });
    if (mode === "external") {
      await external.focus(); await cancelButton.evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) throw Error("SYNTHETIC_CANDIDATE_CANCEL_BUTTON_MISSING");
        button.click();
      });
    } else { await cancelButton.focus(); await page.keyboard.press("Enter"); }
    await whenIdle();
    if (mode === "abort-close") await closed(page);
    else await expect(page.getByTestId("candidate-loader")).toHaveAttribute("data-phase", "idle");
    if (mode === "focus-reentry") {
      await expect(page.getByTestId("candidate-loader-status")).toHaveAttribute("data-cancel-reentry", "yes");
      await expect(page.getByTestId("candidate-loader-status")).toBeFocused();
      report.observations.candidateCancelReentryDisabled = JSON.parse((await page.getByTestId("candidate-loader-status").getAttribute("data-cancel-reentry-disabled"))!);
    } else if (mode === "abort-body") await expect(page.locator("body")).toBeFocused();
    else await expect(external).toBeFocused();
    if (mode.startsWith("abort-")) await expect(external).toHaveAttribute("data-cancel-abort", "yes");
    assert.equal(nativeApiRequestStarts, cancelReads); assert.equal(catalogMutationWire.length, cancelWrites);
    assert.deepEqual(fixture.store.snapshot(), cancelRows); assert.equal(reads.at(-1)?.code, "API_ABORTED");
    assert.equal(expectedAbortArms.has("/api/inbox/batch"), false);
    if (mode !== "abort-close") {
      await reload(page); await whenIdle();
      assert.equal(nativeApiRequestStarts, cancelReads + 1); assert.equal(reads.at(-1)?.status, 200);
      assert.deepEqual(fixture.store.snapshot(), cancelRows);
    }
    pass(`candidate_cancel_${mode}_keeps_focus_ownership_no_extra_io_and_allows_later_manual_read`);
  }
  await open(page);

  report.stage = "catalog_authority_revocation";
  await choose(page, 1, 0); await expect(form(page)).toHaveCount(1);
  await click(page, "서비스 목록 처음부터 다시 확인"); fixture.store.controls.authority = null; expectedCatalog401 = true;
  await click(page, "서비스 다음 목록 불러오기"); await closed(page); await whenIdle();
  await expect(page.getByTestId("catalog-selection")).toHaveAttribute("data-phase", "closed");
  await expect(page.getByTestId("candidate-loader")).toHaveAttribute("data-phase", "closed");
  assert.equal(catalogWire.at(-1)?.code, "API_AUTH_REQUIRED");
  assert.equal(matchedCatalog401, 1); assert.equal(expectedCatalog401, false);
  const afterCatalogAuth = { catalog: catalogWire.length, candidate: reads.length, review: wire.length };
  await delay(200); assert.deepEqual({ catalog: catalogWire.length, candidate: reads.length, review: wire.length }, afterCatalogAuth);
  pass("actual_catalog_auth_rejection_closes_same_review_and_candidate_lease_no_auto_reopen");

  report.stage = "actual_reference_retirement";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  await choose(page, 1, 0); await expect(form(page)).toHaveCount(1);
  const beforeRetirement = fixture.store.snapshot();
  const retired = await fixture.references.retire({ batchReference: fixture.locator.batchReference,
    expectedRevision: 1, decision: "retire" });
  assert.equal(retired.ok, true); expected404 = true;
  // Retirement is a server action in this test host, not a public HTTP write
  // endpoint or a promise to retract already delivered JS values. Explicit
  // reload clears the old selection before observing the now unavailable alias.
  await click(page, "후보 불러오기·새로 확인");
  await expect(page.getByTestId("candidate-loader")).toHaveAttribute("data-phase", "failed");
  await expect(form(page)).toHaveCount(0); await whenIdle();
  assert.equal(reads.at(-1)?.code, "API_NOT_FOUND"); assert.equal(matched404, 1); assert.equal(expected404, false);
  assert.deepEqual(fixture.store.rows.candidates, beforeRetirement.candidates);
  assert.deepEqual(fixture.store.rows.batches, beforeRetirement.batches);
  assert.deepEqual(fixture.store.rows.benefits, beforeRetirement.benefits);
  const afterRetirementReads = reads.length; await delay(200); assert.equal(reads.length, afterRetirementReads);
  report.observations.retirement = { actualIssuerAndResolver: true, explicitReloadStatus: 404,
    originalCandidatesPreserved: true, automaticRetry: false, publicWriteRoute: false };
  await click(page, "Close"); await closed(page);
  pass("actual_reference_retirement_explicit_reload_404_clears_draft_preserves_saved_rows_no_auto_retry");

  report.stage = "actual_resolver_authority_change";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  await choose(page, 1, 0); await click(page, "미리보기 요청");
  await expect(page.getByTestId("review-panel-preview")).toHaveCount(1);
  const beforeResolverFailure = fixture.store.snapshot();
  revokeDuringReferenceRead = true; expected403 = true;
  await click(page, "후보 불러오기·새로 확인"); await closed(page); await whenIdle();
  await expect(page.getByTestId("candidate-loader")).toHaveAttribute("data-phase", "closed");
  await expect(page.getByTestId("catalog-selection")).toHaveAttribute("data-phase", "closed");
  assert.equal(reads.at(-1)?.code, "API_SESSION_CHANGED"); assert.equal(matched403, 1);
  assert.equal(expected403, false); assert.equal(revokeDuringReferenceRead, false);
  assert.deepEqual(fixture.store.snapshot(), beforeResolverFailure);
  const afterResolverFailure = { catalog: catalogWire.length, candidate: reads.length, review: wire.length };
  await delay(200); assert.deepEqual({ catalog: catalogWire.length, candidate: reads.length, review: wire.length }, afterResolverFailure);
  pass("actual_resolver_session_change_returns_403_closes_shared_workspace_preview_no_auto_retry");

  report.stage = "empty_catalog_explicit_create";
  await closePage(page); await whenIdle(); await emptyServiceFixture(); page = await newPage();
  const beforeEmpty = catalogMutationWire.length;
  await click(page, "Open"); await expect(panel(page)).toHaveAttribute("data-open", "yes");
  await receiveCompletion(page); await nextCatalog(page); await reload(page);
  await expect(page.getByTestId("catalog-selection")).toHaveAttribute("data-rows", "0");
  assert.equal(fixture.store.rows.services.size, 0); assert.equal(catalogMutationWire.length, beforeEmpty);
  await previewCreate(page, "첫 합성 서비스", "합성 제공자");
  await page.keyboard.press("Escape");
  await expect(createPanel(page)).toHaveAttribute("data-phase", "editing");
  assert.equal(catalogMutationWire.length, beforeEmpty);
  await previewCreate(page, "첫 합성 서비스", "합성 제공자");
  await saveCreate(page); assert.equal(catalogMutationWire.length, beforeEmpty + 1);
  assert.equal(fixture.store.rows.services.size, 1); assert.equal(fixture.store.rows.catalogOperations.size, 1);
  const firstService = [...fixture.store.rows.services.values()][0]!;
  const firstObservation = await createServiceCatalog(fixture.store.catalogDependencies).get({ serviceId: firstService.id });
  assert.ok(firstObservation.ok);
  assert.deepEqual(firstObservation.value.profile, { name: "첫 합성 서비스", provider: "합성 제공자", planName: null,
    accountLabel: null, timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null });
  assert.equal(fixture.store.rows.benefits.size, 0);
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  const firstChoices = page.getByLabel("연결할 기존 서비스", { exact: true });
  await expect(firstChoices).toHaveValue(""); await expect(firstChoices.locator("option")).toHaveCount(2);
  await page.getByLabel("검토할 후보", { exact: true }).selectOption(fixture.batch.candidates[1]!.candidateId);
  await firstChoices.selectOption(firstService.id); await click(page, "검토할 내용으로 가져오기");
  await expect(form(page)).toHaveCount(1); await click(page, "미리보기 요청");
  await expect(page.getByTestId("review-panel-preview")).toContainText("첫 합성 서비스");
  await click(page, "이 내용으로 기록 저장");
  await expect(page.getByTestId("review-panel-rows").locator("li")).toHaveCount(1); await whenIdle();
  assert.equal([...fixture.store.rows.benefits.values()][0]!.content?.serviceId, firstService.id);
  assert.deepEqual(fixture.readAnalysisCounts(), { quota: 1, mailbox: 1, analysis: 1 });
  pass("actual_empty_catalog_preview_escape_no_write_explicit_create_manual_list_explicit_select_review_save");

  report.stage = "create_ack_loss_same_command_retry";
  await click(page, "새 서비스 등록 준비");
  await previewCreate(page, "응답 유실 합성 서비스");
  const beforeCreate = { calls: catalogMutationWire.length, services: fixture.store.rows.services.size,
    operations: fixture.store.rows.catalogOperations.size };
  expectedCreate503 = true; failNextCreatedAcknowledgement = true;
  await saveCreate(page, "uncertain");
  assert.equal(failNextCreatedAcknowledgement, false);
  assert.equal(fixture.store.rows.services.size, beforeCreate.services + 1);
  assert.equal(fixture.store.rows.catalogOperations.size, beforeCreate.operations + 1);
  assert.equal(catalogMutationWire[beforeCreate.calls]?.status, 503);
  await expect(page.getByLabel("서비스 이름", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "새 서비스 등록 준비", exact: true })).toHaveCount(0);
  const createEscapeRetry = createPanel(page).getByRole("button", { name: "같은 서비스 등록 요청의 결과 다시 확인", exact: true });
  const beforeCreateEscape = { catalog: catalogWire.length, reads: reads.length, review: wire.length,
    mutations: catalogMutationWire.length, completions, rows: fixture.store.snapshot() };
  await createEscapeRetry.focus(); await page.keyboard.press("Escape");
  await expect(createEscapeRetry).toBeFocused(); await expect(createPanel(page)).toHaveAttribute("data-phase", "uncertain");
  await expect(createPanel(page)).toContainText("응답 유실 합성 서비스");
  await expect(page.getByLabel("서비스 이름", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "새 서비스 등록 준비", exact: true })).toHaveCount(0);
  await whenIdle();
  assert.deepEqual({ catalog: catalogWire.length, reads: reads.length, review: wire.length,
    mutations: catalogMutationWire.length, completions, rows: fixture.store.snapshot() }, beforeCreateEscape);
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await expect(createPanel(page)).toHaveAttribute("data-phase", "uncertain");
  await expect(createPanel(page)).toContainText("응답 유실 합성 서비스");
  const acknowledgedRows = fixture.store.snapshot();
  await delay(200); assert.equal(catalogMutationWire.length, beforeCreate.calls + 1);
  await click(page, "같은 서비스 등록 요청의 결과 다시 확인");
  await expect(createPanel(page)).toHaveAttribute("data-phase", "completed"); await whenIdle();
  assert.equal(catalogMutationWire.at(-1)?.digest, catalogMutationWire[beforeCreate.calls]?.digest);
  assert.equal(catalogMutationWire.at(-1)?.replayed, true); assert.equal(catalogMutationWire.at(-1)?.state, "live");
  assert.deepEqual(fixture.store.snapshot(), acknowledgedRows);
  pass("actual_create_committed_then_adapter_ack_failure_manual_catalog_restart_preserves_identical_retry_no_duplicate");
  assert.deepEqual(catalogMutationWire.slice(beforeCreate.calls).map(({ action, status }) => ({ action, status })),
    [{ action: "create", status: 503 }, { action: "create", status: 200 }]);
  report.observations.uncertainCreateEscape = { keyboardEscape: true, retryFocusRetained: true,
    originalCommandRetained: true, additionalHttpOnEscape: 0, editingExposed: false,
    explicitRetryDigestUnchanged: true, additionalRowsOrOperationsOnReplay: 0 };
  pass("keyboard_escape_cannot_discard_sent_uncertain_create_or_start_new_write_original_retry_preserved");

  report.stage = "create_replay_current_tombstone";
  await click(page, "새 서비스 등록 준비"); await previewCreate(page, "삭제 재확인 합성 서비스");
  const beforeDeletedCreate = catalogMutationWire.length;
  expectedCreate503 = true; failNextCreatedAcknowledgement = true; await saveCreate(page, "uncertain");
  const createdForDeletion = [...fixture.store.rows.services.values()].find((row) => row.name === "삭제 재확인 합성 서비스");
  assert.ok(createdForDeletion);
  const removedCreated = await createServiceCatalog(fixture.store.catalogDependencies).remove({ operationId: "synthetic-created-service-delete",
    decision: "delete", serviceId: createdForDeletion.id, expectedRevision: createdForDeletion.revision });
  assert.equal(removedCreated.ok, true); const deletedRows = fixture.store.snapshot();
  await click(page, "같은 서비스 등록 요청의 결과 다시 확인");
  await expect(createPanel(page)).toHaveAttribute("data-phase", "completed");
  await expect(page.getByTestId("catalog-service-create-result")).toHaveAttribute("data-service-state", "deleted");
  await expect(createPanel(page)).toContainText("삭제"); await whenIdle();
  assert.equal(catalogMutationWire.at(-1)?.digest, catalogMutationWire[beforeDeletedCreate]?.digest);
  assert.equal(catalogMutationWire.at(-1)?.replayed, true); assert.equal(catalogMutationWire.at(-1)?.state, "deleted");
  assert.deepEqual(fixture.store.snapshot(), deletedRows);
  assert.equal(matchedCreate503, 2); assert.equal(expectedCreate503, false);
  pass("same_create_command_replay_returns_current_deleted_null_profile_without_resurrection_or_duplicate");

  report.stage = "create_authority_rejection";
  await click(page, "새 서비스 등록 준비"); await previewCreate(page, "권한 종료 합성 서비스");
  const beforeCreateRevoke = fixture.store.snapshot(); fixture.store.controls.authority = null; expectedCreate401 = true;
  await click(page, "이 내용으로 서비스 기록 저장"); await closed(page); await whenIdle();
  await expect(createPanel(page)).toHaveAttribute("data-phase", "closed");
  await expect(page.getByTestId("catalog-service-create-content")).toHaveCount(0);
  assert.equal(catalogMutationWire.at(-1)?.code, "API_AUTH_REQUIRED");
  assert.equal(matchedCreate401, 1); assert.equal(expectedCreate401, false);
  assert.deepEqual(fixture.store.snapshot(), beforeCreateRevoke);
  const afterCreateRevoke = catalogMutationWire.length; await delay(200); assert.equal(catalogMutationWire.length, afterCreateRevoke);
  pass("actual_create_auth_rejection_closes_shared_review_lease_clears_private_create_dom_no_auto_retry");

  report.stage = "create_focus_reentrant_close";
  await closePage(page); await whenIdle(); await emptyServiceFixture(); page = await newPage(); await open(page);
  await page.getByLabel("서비스 이름", { exact: true }).fill("동기 닫기 합성 서비스");
  const focusCounts = { mutations: catalogMutationWire.length, rows: fixture.store.rows.services.size };
  await page.evaluate(() => document.querySelector('[data-testid="catalog-service-create-status"]')?.addEventListener("focus", () => {
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Close")?.click();
  }, { once: true }));
  await click(page, "등록 내용 미리보기"); await closed(page);
  await expect(page.getByTestId("catalog-service-create-content")).toHaveCount(0);
  assert.deepEqual({ mutations: catalogMutationWire.length, rows: fixture.store.rows.services.size }, focusCounts);
  await open(page); await expect(createPanel(page)).toHaveAttribute("data-phase", "editing");
  await expect(page.getByLabel("서비스 이름", { exact: true })).toHaveValue("");
  pass("native_focus_listener_closing_during_preview_cannot_publish_old_command_or_input_in_new_lease");

  report.stage = "create_synchronous_duplicate_submission";
  await previewCreate(page, "연속 클릭 합성 서비스");
  const beforeRepeatedCreate = catalogMutationWire.length;
  holdNextCatalog = true;
  const clickAttempts = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "이 내용으로 서비스 기록 저장");
    const status = document.querySelector('[data-testid="catalog-service-create-status"]');
    if (!button || !status) throw Error("CANDIDATE_CREATE_BUTTON_MISSING");
    let attempts = 0;
    button.focus(); status.addEventListener("focus", () => { attempts++; button.click(); }, { once: true });
    for (let index = 0; index < 3; index++) { attempts++; button.click(); }
    return attempts;
  });
  assert.equal(clickAttempts, 4, "THREE_DOM_ATTEMPTS_PLUS_SYNCHRONOUS_FOCUS_REENTRY");
  await bounded((async () => { while (!releaseCatalog) await delay(20); })());
  await expect(createPanel(page)).toHaveAttribute("data-phase", "pending");
  await delay(150); assert.equal(catalogMutationWire.length, beforeRepeatedCreate);
  assert.equal(fixture.store.rows.services.size, 0); assert.equal(fixture.store.rows.catalogOperations.size, 0);
  releaseHeldCatalog(); await whenIdle(); await expect(createPanel(page)).toHaveAttribute("data-phase", "completed");
  assert.equal(catalogMutationWire.length, beforeRepeatedCreate + 1);
  assert.equal(fixture.store.rows.services.size, 1); assert.equal(fixture.store.rows.catalogOperations.size, 1);
  report.observations.duplicateCreate = { programmaticNativeDomAttempts: clickAttempts,
    synchronousFocusReentry: true, actualHttp: 1, committedRows: 1, operationRows: 1 };
  pass("synchronous_dom_repeated_save_and_focus_reentry_dispatch_once_commit_one_service_and_operation");
  report.stage = "create_pending_close_bootstrap";
  await click(page, "Close"); await closed(page); await closePage(page); await whenIdle();
  await emptyServiceFixture(); page = await newPage(); await open(page);

  report.stage = "create_pending_close";
  await previewCreate(page, "대기 중 닫기 합성 서비스");
  const beforePendingCreate = fixture.store.snapshot(), mutationsBeforePending = catalogMutationWire.length;
  holdNextCatalog = true; armExpectedAbort("/api/catalog/create", page);
  await click(page, "이 내용으로 서비스 기록 저장");
  await expect(createPanel(page)).toHaveAttribute("data-phase", "pending");
  await bounded((async () => { while (!releaseCatalog) await delay(20); })());
  await click(page, "Close"); await closed(page); await whenIdle();
  assert.equal(catalogMutationWire.length, mutationsBeforePending + 1);
  assert.equal(catalogMutationWire.at(-1)?.code, "API_ABORTED");
  assert.deepEqual(fixture.store.snapshot(), beforePendingCreate);
  await open(page); await expect(createPanel(page)).toHaveAttribute("data-phase", "editing");
  await expect(page.getByLabel("서비스 이름", { exact: true })).toHaveValue("");
  assert.equal(catalogMutationWire.length, mutationsBeforePending + 1);
  pass("close_aborts_pending_create_admission_no_commit_or_old_command_replay_on_new_open");

  report.stage = "create_transport_replacement";
  await previewCreate(page, "전송기 변경 합성 서비스");
  expectedCreate503 = true; failNextCreatedAcknowledgement = true; await saveCreate(page, "uncertain");
  const beforeTransport = { rows: fixture.store.snapshot(), mutations: catalogMutationWire.length };
  await click(page, "Replace test transport"); await closed(page);
  await expect(createPanel(page)).toHaveAttribute("data-phase", "closed");
  await expect(page.getByTestId("catalog-service-create-content")).toHaveCount(0);
  await delay(200); assert.equal(catalogMutationWire.length, beforeTransport.mutations);
  assert.deepEqual(fixture.store.snapshot(), beforeTransport.rows);
  await open(page); await expect(createPanel(page)).toHaveAttribute("data-phase", "editing");
  await expect(page.getByLabel("서비스 이름", { exact: true })).toHaveValue("");
  assert.equal(catalogMutationWire.length, beforeTransport.mutations);
  await click(page, "Close"); await closed(page);
  pass("same_lease_transport_replacement_closes_shared_workspace_preserves_server_commit_no_silent_fresh_retry");

  report.stage = "create_pending_native_back";
  // Clean document avoids replaying an earlier expected resource error from the
  // browser console; do not relax the unexpected-console-error assertion.
  await closePage(page); await whenIdle(); await emptyServiceFixture(); page = await newPage(); await open(page);
  await previewCreate(page, "뒤로가기 전 합성 서비스"); holdNextCatalog = true; armExpectedAbort("/api/catalog/create", page);
  const beforeCreateBack = fixture.store.snapshot();
  await click(page, "이 내용으로 서비스 기록 저장");
  await bounded((async () => { while (!releaseCatalog) await delay(20); })());
  const pendingCreateMarker = await observeLifecycle(page);
  await page.getByRole("link", { name: "Leave document", exact: true }).click();
  await expect(page).toHaveURL(origin + "/__candidate_away.html"); await whenIdle();
  assert.equal(catalogMutationWire.at(-1)?.code, "API_ABORTED");
  assert.deepEqual(fixture.store.snapshot(), beforeCreateBack);
  const nativeCreateCount = catalogMutationWire.length;
  await page.goBack({ waitUntil: "commit" }); await closed(page);
  await expect(page.getByTestId("catalog-service-create-content")).toHaveCount(0);
  await recordLifecycle(page, pendingCreateMarker, "pendingCreateLifecycle");
  await delay(200); assert.equal(catalogMutationWire.length, nativeCreateCount);
  await open(page); await expect(page.getByLabel("서비스 이름", { exact: true })).toHaveValue("");
  assert.equal(catalogMutationWire.length, nativeCreateCount);
  pass("native_back_during_create_admission_aborts_without_commit_and_restores_closed_without_replay");

  report.stage = "create_committed_pending_ack_native_back";
  await previewCreate(page, "저장 후 응답 대기 합성 서비스"); holdNextCreateReply = true; armExpectedAbort("/api/catalog/create", page);
  await click(page, "이 내용으로 서비스 기록 저장");
  await bounded((async () => { while (!releaseCreateReply) await delay(20); })());
  await expect(createPanel(page)).toHaveAttribute("data-phase", "pending");
  assert.equal(fixture.store.rows.services.size, 1); assert.equal(fixture.store.rows.catalogOperations.size, 1);
  const committedBeforeBack = fixture.store.snapshot();
  const committedCreateMarker = await observeLifecycle(page);
  await page.getByRole("link", { name: "Leave document", exact: true }).click();
  await expect(page).toHaveURL(origin + "/__candidate_away.html"); await whenIdle();
  assert.equal(catalogMutationWire.at(-1)?.status, 200, "CANDIDATE_INTERNAL_CREATE_COMMITTED");
  assert.equal(catalogMutationWire.at(-1)?.responseWriteAttempted, false);
  const committedBackCount = catalogMutationWire.length;
  await page.goBack({ waitUntil: "commit" }); await closed(page);
  await expect(page.getByTestId("catalog-service-create-content")).toHaveCount(0);
  await recordLifecycle(page, committedCreateMarker, "committedCreateLifecycle");
  await delay(200); assert.equal(catalogMutationWire.length, committedBackCount);
  assert.deepEqual(fixture.store.snapshot(), committedBeforeBack);
  // The old per-lease command is deliberately not resurrected. This does not
  // establish durable cross-session reconciliation or imply rollback.
  pass("native_back_after_create_commit_before_ack_preserves_server_row_closes_private_dom_no_replay_or_rollback_claim");

  const retiredControlCases = [
    { action: "create", focus: "search" }, { action: "create", focus: "clear" },
    { action: "create", focus: "opener" }, { action: "create", focus: "external" },
    { action: "create", focus: "reentry" }, { action: "update", focus: "search" },
    { action: "update", focus: "external" },
  ] as const;
  const retiredControlObservations: unknown[] = [];
  report.observations.catalogRetiredControls = retiredControlObservations;
  for (const scenario of retiredControlCases) {
    report.stage = `catalog_controls_${scenario.focus}_during_committed_${scenario.action}_ack`;
    await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
    if (scenario.action === "create") await previewCreate(page, "검색 초점 확인 합성 서비스");
    else await previewUpdate(page, fixture.services[0]!.serviceId, "검색 초점 확인 합성 수정");
    const commandPanel = scenario.action === "create" ? createPanel(page) : updatePanel(page);
    const beforeSearchAckWrite = catalogMutationWire.length;
    holdNextCreateReply = true;
    await click(page, scenario.action === "create" ? "이 내용으로 서비스 기록 저장" : "이 내용으로 서비스 기록 수정");
    await bounded((async () => { while (!releaseCreateReply) await delay(20); })());
    await expect(commandPanel).toHaveAttribute("data-phase", "pending");
    // Commit already happened. Only its acknowledgement is held; do not await
    // global idle while deliberately keeping this one request open.
    const searchAckCommittedRows = fixture.store.snapshot();
    await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
    const ackSearch = page.getByTestId("catalog-service-details-search");
    await ackSearch.fill("합성");
    const focusedControl = scenario.focus === "external" ? page.getByRole("button", { name: "Open", exact: true })
      : scenario.focus === "clear" ? page.getByTestId("catalog-service-details-search-clear")
      : scenario.focus === "opener" ? page.getByTestId("catalog-service-detail-toggle").first() : ackSearch;
    await focusedControl.focus(); await expect(focusedControl).toBeFocused();
    if (scenario.focus === "reentry") await page.evaluate(() => {
      const status = document.querySelector<HTMLElement>('[data-testid="catalog-service-details-status"]');
      const opener = document.querySelector<HTMLButtonElement>('[data-testid="catalog-service-detail-toggle"]');
      const clear = document.querySelector<HTMLButtonElement>('[data-testid="catalog-service-details-search-clear"]');
      if (!status || !opener || !clear) throw Error("CANDIDATE_RETIRED_CONTROLS_MISSING");
      status.addEventListener("focus", () => {
        status.dataset.reentry = "yes";
        status.dataset.oldOpenerConnected = String(opener.isConnected);
        status.dataset.oldClearConnected = String(clear.isConnected);
        opener.click(); clear.click();
      }, { once: true });
    });
    const beforeSearchAckRequests = nativeApiRequestStarts;
    releaseHeldCreateReply(); await whenIdle();
    await expect(commandPanel).toHaveAttribute("data-phase", "completed");
    await expect(ackSearch).toHaveCount(0);
    await expect(page.getByTestId("catalog-service-details")).toHaveCount(0);
    const status = page.getByTestId("catalog-service-details-status");
    const focused = await page.evaluate(() => ({ body: document.activeElement === document.body,
      status: document.activeElement === document.querySelector('[data-testid="catalog-service-details-status"]') }));
    retiredControlObservations.push({ ...scenario, ...focused, extraHttp: nativeApiRequestStarts - beforeSearchAckRequests,
      mutations: catalogMutationWire.length - beforeSearchAckWrite,
      reentry: await status.getAttribute("data-reentry"), openerConnectedAtReentry: await status.getAttribute("data-old-opener-connected"),
      clearConnectedAtReentry: await status.getAttribute("data-old-clear-connected") });
    assert.equal(nativeApiRequestStarts, beforeSearchAckRequests);
    assert.equal(catalogMutationWire.length, beforeSearchAckWrite + 1);
    assert.deepEqual(fixture.store.snapshot(), searchAckCommittedRows);
    if (scenario.focus === "external") await expect(focusedControl).toBeFocused();
    else await expect(status).toBeFocused();
    if (scenario.focus === "reentry") {
      await expect(status).toHaveAttribute("data-reentry", "yes");
      await expect(status).toHaveAttribute("data-old-opener-connected", "true");
      await expect(status).toHaveAttribute("data-old-clear-connected", "true");
    }
    await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
    await expect(ackSearch).toHaveValue("");
    await expect(page.getByTestId("catalog-service-details")).toHaveCount(0);
    await page.getByTestId("catalog-service-detail-toggle").first().click();
    await expect(page.getByTestId("catalog-service-details")).toHaveCount(1);
    assert.equal(catalogMutationWire.length, beforeSearchAckWrite + 1);
    assert.deepEqual(fixture.store.snapshot(), searchAckCommittedRows);
    pass(`committed_${scenario.action}_ack_retired_${scenario.focus}_owned_focus_and_explicit_recovery_no_extra_write`);
  }

  report.stage = "update_exact_profile_and_history";
  await closePage(page); await whenIdle(); await freshFixture();
  const updateServiceId = fixture.services[0]!.serviceId;
  const extraProfile = { ...fixture.services[0]!.profile!, provider: "합성 원래 제공자", planName: "합성 보존 요금제",
    accountLabel: "합성 표시 이름", timezone: "Asia/Seoul", subscriptionStatus: "trial" as const,
    trialEndsAt: "2027-01-01", notes: "합성 메모\n보존할 둘째 줄" };
  assert.ok((await createServiceCatalog(fixture.store.catalogDependencies).update({ serviceId: updateServiceId,
    expectedRevision: 1, operationId: "synthetic-enriched-service", decision: "update", profile: extraProfile })).ok);
  page = await newPage(); await open(page); await choose(page, 1, 0);
  await click(page, "미리보기 요청"); await click(page, "이 내용으로 기록 저장");
  await expect(page.getByTestId("review-panel-rows").locator("li")).toHaveCount(1); await whenIdle();
  const beforeRenameBenefits = structuredClone(fixture.store.rows.benefits);
  await reload(page); await choose(page, 0, 0, "이름 변경 전 합성 초안");
  await click(page, "미리보기 요청"); await expect(page.getByTestId("review-panel-preview")).toHaveCount(1);
  await previewUpdate(page, updateServiceId, "수정된 합성 서비스", "수정된 합성 제공자");
  await expect(page.getByTestId("catalog-service-update-preview")).toContainText(extraProfile.planName);
  await expect(page.getByTestId("catalog-service-update-preview")).toContainText(extraProfile.notes);
  await expect(page.getByTestId("catalog-service-update-preview")).toContainText("원래 버전: 2");
  const mutationsBeforeUpdateEscape = catalogMutationWire.length;
  await page.getByRole("button", { name: "이 내용으로 서비스 기록 수정", exact: true }).focus();
  await page.keyboard.press("Escape"); await expect(updatePanel(page)).toHaveAttribute("data-phase", "editing");
  assert.equal(catalogMutationWire.length, mutationsBeforeUpdateEscape);
  await click(page, "수정 내용 미리보기"); await saveUpdate(page);
  const renamed = await observedService(updateServiceId);
  assert.equal(renamed.serviceRevision, 3);
  assert.deepEqual(renamed.profile, { ...extraProfile, name: "수정된 합성 서비스", provider: "수정된 합성 제공자" });
  assert.deepEqual(fixture.store.rows.benefits, beforeRenameBenefits);
  assert.equal([...fixture.store.rows.previews.values()].filter((entry) => entry.state === "pending").length, 0);
  await expect(page.getByTestId("review-panel-preview")).toHaveCount(0);
  await expect(page.getByTestId("catalog-service-update-result")).toContainText("수정된 합성 서비스");
  pass("actual_update_exact_id_revision_preserves_six_profile_fields_and_saved_benefit_history_erases_pending_preview");

  report.stage = "update_unsent_observation_change";
  await click(page, "다른 서비스 수정 준비"); await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await previewUpdate(page, updateServiceId, "보내지 않을 합성 수정");
  const beforeUnsentUpdate = catalogMutationWire.length;
  await click(page, "서비스 목록 처음부터 다시 확인");
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "selecting");
  await expect(page.getByTestId("catalog-service-update-preview")).toHaveCount(0);
  await expect(page.getByLabel("수정할 서비스 이름", { exact: true })).toHaveCount(0);
  assert.equal(catalogMutationWire.length, beforeUnsentUpdate);
  await nextCatalog(page); await expect(page.getByLabel("수정할 서비스", { exact: true })).toHaveValue("");
  pass("catalog_observation_restart_discards_only_unsent_update_draft_and_preview_without_write");

  report.stage = "update_ack_loss_same_command";
  await previewUpdate(page, updateServiceId, "응답 유실 합성 수정", "재확인 제공자");
  const beforeUpdateAck = catalogMutationWire.length;
  expectedUpdate503 = true; failNextUpdatedAcknowledgement = true; await saveUpdate(page, "uncertain");
  const updateCommitted = fixture.store.snapshot();
  const updateEscapeRetry = updatePanel(page).getByRole("button", { name: "같은 서비스 수정 요청의 결과 다시 확인", exact: true });
  const beforeUpdateEscape = { catalog: catalogWire.length, reads: reads.length, review: wire.length,
    mutations: catalogMutationWire.length, completions, rows: fixture.store.snapshot() };
  await updateEscapeRetry.focus(); await page.keyboard.press("Escape");
  await expect(updateEscapeRetry).toBeFocused(); await expect(updatePanel(page)).toHaveAttribute("data-phase", "uncertain");
  await expect(page.getByTestId("catalog-service-update-preview")).toContainText("응답 유실 합성 수정");
  await expect(page.getByLabel("수정할 서비스", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("수정할 서비스 이름", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "다른 서비스 수정 준비", exact: true })).toHaveCount(0);
  await whenIdle();
  assert.deepEqual({ catalog: catalogWire.length, reads: reads.length, review: wire.length,
    mutations: catalogMutationWire.length, completions, rows: fixture.store.snapshot() }, beforeUpdateEscape);
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "uncertain");
  await expect(page.getByLabel("수정할 서비스", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("catalog-service-update-preview")).toContainText("응답 유실 합성 수정");
  await inspectCatalogWithoutChangingPendingCommand(page);
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "uncertain");
  await expect(page.getByTestId("catalog-service-update-preview")).toContainText("응답 유실 합성 수정");
  pass("read_only_service_details_and_local_search_preserve_uncertain_catalog_update_before_identical_retry");
  await click(page, "같은 서비스 수정 요청의 결과 다시 확인");
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "completed"); await whenIdle();
  assert.equal(catalogMutationWire.at(-1)?.digest, catalogMutationWire[beforeUpdateAck]?.digest);
  assert.equal(catalogMutationWire.at(-1)?.replayed, true); assert.deepEqual(fixture.store.snapshot(), updateCommitted);
  assert.equal(matchedUpdate503, 1); assert.equal(expectedUpdate503, false);
  pass("actual_update_commit_ack_failure_list_restart_preserves_original_request_identical_retry_without_second_revision");
  assert.deepEqual(catalogMutationWire.slice(beforeUpdateAck).map(({ action, status }) => ({ action, status })),
    [{ action: "update", status: 503 }, { action: "update", status: 200 }]);
  report.observations.uncertainUpdateEscape = { keyboardEscape: true, retryFocusRetained: true,
    originalCommandRetained: true, additionalHttpOnEscape: 0, editingExposed: false,
    explicitRetryDigestUnchanged: true, additionalRevisionOrOperationsOnReplay: 0 };
  pass("keyboard_escape_cannot_discard_sent_uncertain_update_or_start_new_write_original_retry_preserved");

  report.stage = "update_revision_conflict";
  await click(page, "다른 서비스 수정 준비"); await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await previewUpdate(page, updateServiceId, "충돌로 보존할 합성 요청");
  const currentBeforeConflict = await observedService(updateServiceId); assert.ok(currentBeforeConflict.profile);
  assert.ok((await createServiceCatalog(fixture.store.catalogDependencies).update({ serviceId: updateServiceId,
    expectedRevision: currentBeforeConflict.serviceRevision, operationId: "synthetic-other-writer-update", decision: "update",
    profile: { ...currentBeforeConflict.profile, name: "다른 작성자의 합성 수정" } })).ok);
  const conflictRows = fixture.store.snapshot(); expectedUpdate409 = true; await saveUpdate(page, "uncertain");
  assert.equal(catalogMutationWire.at(-1)?.code, "API_CONFLICT"); assert.deepEqual(fixture.store.snapshot(), conflictRows);
  await expect(page.getByTestId("catalog-service-update-status")).toContainText("자동 덮어쓰지 않습니다");
  assert.equal(matchedUpdate409, 1); assert.equal(expectedUpdate409, false);
  pass("actual_stale_update_revision_conflicts_without_auto_rebase_overwrite_or_new_command");

  report.stage = "update_deleted_current_replay";
  await click(page, "Close"); await closed(page); await closePage(page); await whenIdle(); await freshFixture();
  page = await newPage(); await open(page); const deletedUpdateId = fixture.services[0]!.serviceId;
  await previewUpdate(page, deletedUpdateId, "삭제 전 합성 수정");
  expectedUpdate503 = true; failNextUpdatedAcknowledgement = true; await saveUpdate(page, "uncertain");
  const deletedUpdateRequest = catalogMutationWire.at(-1)!;
  const beforeUpdateDelete = await observedService(deletedUpdateId);
  assert.ok((await createServiceCatalog(fixture.store.catalogDependencies).remove({ serviceId: deletedUpdateId,
    expectedRevision: beforeUpdateDelete.serviceRevision, operationId: "synthetic-delete-after-update", decision: "delete" })).ok);
  const deletedUpdateRows = fixture.store.snapshot();
  await click(page, "같은 서비스 수정 요청의 결과 다시 확인");
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "completed"); await whenIdle();
  await expect(page.getByTestId("catalog-service-update-result")).toHaveAttribute("data-service-state", "deleted");
  await expect(page.getByTestId("catalog-service-update-preview")).toHaveCount(0);
  assert.equal(catalogMutationWire.at(-1)?.digest, deletedUpdateRequest.digest);
  assert.equal(catalogMutationWire.at(-1)?.replayed, true); assert.equal(catalogMutationWire.at(-1)?.state, "deleted");
  assert.deepEqual(fixture.store.snapshot(), deletedUpdateRows);
  pass("original_update_retry_returns_current_deleted_state_without_resurrection_or_previous_profile");

  report.stage = "update_authority_rejection";
  await click(page, "다른 서비스 수정 준비"); await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await previewUpdate(page, fixture.services[1]!.serviceId, "권한 종료 합성 수정");
  const beforeUpdateAuthority = fixture.store.snapshot(); fixture.store.controls.authority = null; expectedUpdate401 = true;
  await click(page, "이 내용으로 서비스 기록 수정"); await closed(page); await whenIdle();
  await expect(page.getByTestId("catalog-service-update-content")).toHaveCount(0);
  await expect(page.getByTestId("catalog-service-create-content")).toHaveCount(0);
  assert.equal(catalogMutationWire.at(-1)?.code, "API_AUTH_REQUIRED"); assert.deepEqual(fixture.store.snapshot(), beforeUpdateAuthority);
  assert.equal(matchedUpdate401, 1); assert.equal(expectedUpdate401, false);
  pass("actual_update_auth_rejection_closes_shared_review_create_update_private_dom_without_mutation");

  report.stage = "update_preserves_uncertain_benefit";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  await choose(page, 0, 0, "수정 전 보존할 합성 혜택"); holdNextPreviewReply = true;
  await click(page, "미리보기 요청");
  await expect.poll(() => releasePreviewReply !== null).toBe(true);
  const prematurelyCapturedIndex = wire.length;
  releaseHeldPreviewReply();
  // Click completion is not HTTP completion. The old early wire index could
  // point at preview, and installing afterCommit there could target preview.
  await expect(page.getByTestId("review-panel-preview")).toHaveCount(1); await whenIdle();
  assert.equal(wire.length, prematurelyCapturedIndex + 1);
  assert.equal(wire[prematurelyCapturedIndex]?.action, "preview");
  const beforeUncertainBenefit = wire.length;
  expected503 = true; fixture.store.controls.afterCommit = () => { delete fixture.store.controls.afterCommit; throw Error(SYNTHETIC_PRIVATE); };
  await click(page, "이 내용으로 기록 저장");
  const preservedReview = page.getByRole("group", { name: "결과 재확인", exact: true }); await expect(preservedReview).toBeVisible();
  await whenIdle(); const uncertainBenefits = structuredClone(fixture.store.rows.benefits);
  await previewUpdate(page, fixture.services[0]!.serviceId, "혜택 저장 후 합성 이름 수정"); await saveUpdate(page);
  await expect(preservedReview).toContainText("수정 전 보존할 합성 혜택");
  assert.deepEqual(fixture.store.rows.benefits, uncertainBenefits);
  await click(page, "같은 요청의 결과 다시 확인");
  await expect(preservedReview).toHaveCount(0); await whenIdle();
  assert.deepEqual(wire.slice(beforeUncertainBenefit).map(({ action, status }) => ({ action, status })),
    [{ action: "confirm", status: 503 }, { action: "confirm", status: 200 }]);
  assert.equal(wire.at(-1)?.digest, wire[beforeUncertainBenefit]?.digest);
  assert.notEqual(wire.at(-1)?.digest, wire[prematurelyCapturedIndex]?.digest);
  assert.deepEqual(fixture.store.rows.benefits, uncertainBenefits);
  assert.equal(matched503, 2); assert.equal(expected503, false);
  report.observations.uncertainBenefitPreviewOrdering = { heldActualPreviewReply: true,
    earlyIndexWouldPointToPreview: true, earlyDigestComparisonWouldFail: true,
    confirmRequestsIncludingExplicitRetry: 2, failureInjectionAfterPreviewIdle: true };
  pass("service_rename_preserves_uncertain_benefit_facts_original_confirm_digest_and_review_time_history");

  report.stage = "update_focus_reentrant_observation_change";
  await click(page, "다른 서비스 수정 준비"); await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await previewUpdate(page, fixture.services[1]!.serviceId, "보내기 전 폐기할 합성 수정");
  const beforeUpdateFocus = { rows: fixture.store.snapshot(), mutations: catalogMutationWire.length };
  await page.evaluate(() => document.querySelector('[data-testid="catalog-service-update-status"]')?.addEventListener("focus", () => {
    [...document.querySelectorAll("button")].find((button) => button.textContent === "서비스 목록 처음부터 다시 확인")?.click();
  }, { once: true }));
  await click(page, "이 내용으로 서비스 기록 수정");
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "selecting");
  await expect(page.getByTestId("catalog-service-update-preview")).toHaveCount(0);
  assert.equal(catalogMutationWire.length, beforeUpdateFocus.mutations); assert.deepEqual(fixture.store.snapshot(), beforeUpdateFocus.rows);
  pass("native_focus_reentrant_catalog_restart_before_update_dispatch_discards_unsent_command_without_http");

  report.stage = "update_pending_native_back";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  await previewUpdate(page, fixture.services[0]!.serviceId, "이탈 전 합성 수정");
  holdNextCatalog = true; armExpectedAbort("/api/catalog/update", page); const beforePendingUpdate = fixture.store.snapshot();
  await click(page, "이 내용으로 서비스 기록 수정");
  await bounded((async () => { while (!releaseCatalog) await delay(20); })());
  const pendingUpdateMarker = await observeLifecycle(page);
  await page.getByRole("link", { name: "Leave document", exact: true }).click();
  await expect(page).toHaveURL(origin + "/__candidate_away.html"); await whenIdle();
  assert.equal(catalogMutationWire.at(-1)?.code, "API_ABORTED"); assert.deepEqual(fixture.store.snapshot(), beforePendingUpdate);
  const pendingUpdateRequests = catalogMutationWire.length;
  await page.goBack({ waitUntil: "commit" }); await closed(page);
  await recordLifecycle(page, pendingUpdateMarker, "pendingUpdateLifecycle");
  await expect(page.getByTestId("catalog-service-update-content")).toHaveCount(0);
  await delay(200); assert.equal(catalogMutationWire.length, pendingUpdateRequests);
  pass("native_update_admission_abort_preserves_rows_and_event_time_private_dom_closed_on_persisted_back");

  report.stage = "update_committed_pending_ack_native_back";
  await open(page); await previewUpdate(page, fixture.services[0]!.serviceId, "저장 후 이탈 합성 수정");
  holdNextCreateReply = true; armExpectedAbort("/api/catalog/update", page);
  await click(page, "이 내용으로 서비스 기록 수정");
  await bounded((async () => { while (!releaseCreateReply) await delay(20); })());
  assert.equal((await observedService(fixture.services[0]!.serviceId)).profile?.name, "저장 후 이탈 합성 수정");
  const committedUpdateRows = fixture.store.snapshot(), committedUpdateMarker = await observeLifecycle(page);
  await page.getByRole("link", { name: "Leave document", exact: true }).click();
  await expect(page).toHaveURL(origin + "/__candidate_away.html"); await whenIdle();
  assert.equal(catalogMutationWire.at(-1)?.status, 200); assert.equal(catalogMutationWire.at(-1)?.responseWriteAttempted, false);
  const committedUpdateRequests = catalogMutationWire.length;
  await page.goBack({ waitUntil: "commit" }); await closed(page);
  await recordLifecycle(page, committedUpdateMarker, "committedUpdateLifecycle");
  await expect(page.getByTestId("catalog-service-update-content")).toHaveCount(0);
  await delay(200); assert.equal(catalogMutationWire.length, committedUpdateRequests);
  assert.deepEqual(fixture.store.snapshot(), committedUpdateRows);
  pass("native_update_commit_before_ack_preserves_saved_revision_no_replay_and_event_time_private_dom_closed");

  report.stage = "update_empty_invalid_selection_recovery";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  const beforeEmptyChoice = { mutations: catalogMutationWire.length, reads: catalogWire.length, rows: fixture.store.snapshot() };
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "selecting");
  await page.getByLabel("수정할 서비스", { exact: true }).evaluate((element) => {
    const select = element as HTMLSelectElement;
    select.value = "synthetic-missing-service";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "selecting");
  await page.getByLabel("수정할 서비스", { exact: true }).selectOption(fixture.services[0]!.serviceId);
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "editing");
  await page.getByLabel("수정할 서비스", { exact: true }).selectOption("");
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "selecting");
  await page.getByLabel("수정할 서비스", { exact: true }).selectOption(fixture.services[1]!.serviceId);
  await expect(page.getByLabel("수정할 서비스 이름", { exact: true })).toHaveValue(fixture.services[1]!.profile!.name);
  assert.equal(catalogMutationWire.length, beforeEmptyChoice.mutations); assert.equal(catalogWire.length, beforeEmptyChoice.reads);
  assert.deepEqual(fixture.store.snapshot(), beforeEmptyChoice.rows);
  pass("native_empty_invalid_selection_cannot_poison_next_manual_selection_or_trigger_http");

  report.stage = "catalog_input_validation_and_preview_cancel";
  const beforeInvalidFields = { mutations: catalogMutationWire.length, rows: fixture.store.snapshot(), requests: nativeApiRequestStarts };
  for (const label of ["서비스 이름", "수정할 서비스 이름"]) {
    const name = page.getByLabel(label, { exact: true });
    await expect(name).toHaveAttribute("aria-required", "true");
    await expect(name).toHaveAccessibleDescription("서비스 이름은 필수입니다. 비우거나 공백만 입력할 수 없습니다. 합성 서비스 이름만 사용하세요.");
    assert.equal(await name.getAttribute("required"), null, "SYNTHETIC_NAME_NATIVE_VALIDATION_UNCHANGED");
  }
  await page.getByLabel("수정할 서비스 이름", { exact: true }).fill("");
  await click(page, "수정 내용 미리보기");
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "editing");
  await expect(page.getByTestId("catalog-service-update-preview")).toHaveCount(0);
  await expect(page.getByTestId("catalog-service-update-status")).toContainText("앞뒤 공백·금지 문자는 허용하지 않습니다");
  await expect(page.getByTestId("catalog-service-update-status")).toContainText("서비스 이름은 필수이며 비울 수 없습니다.");
  await page.getByLabel("수정할 서비스 이름", { exact: true }).fill("합성 정상 이름");
  await page.getByLabel("수정할 제공자 (선택)", { exact: true }).fill(" ");
  await click(page, "수정 내용 미리보기");
  await expect(page.getByTestId("catalog-service-update-preview")).toHaveCount(0);
  await page.getByLabel("수정할 제공자 (선택)", { exact: true }).fill("");
  await click(page, "수정 내용 미리보기"); await expect(updatePanel(page)).toHaveAttribute("data-phase", "preview");
  await click(page, "수정 미리보기 취소");
  await expect(page.getByLabel("수정할 서비스 이름", { exact: true })).toHaveValue("합성 정상 이름");
  await page.getByLabel("서비스 이름", { exact: true }).fill("");
  await click(page, "등록 내용 미리보기");
  await expect(page.getByTestId("catalog-service-create-preview")).toHaveCount(0);
  await expect(page.getByTestId("catalog-service-create-status")).toContainText("서비스 이름은 필수이며 비울 수 없습니다.");
  await page.getByLabel("서비스 이름", { exact: true }).fill(" ");
  await click(page, "등록 내용 미리보기");
  await expect(page.getByTestId("catalog-service-create-preview")).toHaveCount(0);
  await expect(page.getByTestId("catalog-service-create-status")).toContainText("앞뒤 공백·금지 문자는 허용하지 않습니다");
  await page.getByLabel("서비스 이름", { exact: true }).fill("합성 등록 이름");
  await page.getByLabel("제공자 (선택)", { exact: true }).fill(" ");
  await click(page, "등록 내용 미리보기"); await expect(page.getByTestId("catalog-service-create-preview")).toHaveCount(0);
  await page.getByLabel("제공자 (선택)", { exact: true }).fill("");
  await click(page, "등록 내용 미리보기"); await click(page, "미리보기 취소");
  await expect(page.getByLabel("서비스 이름", { exact: true })).toHaveValue("합성 등록 이름");
  assert.equal(catalogMutationWire.length, beforeInvalidFields.mutations); assert.deepEqual(fixture.store.snapshot(), beforeInvalidFields.rows);
  assert.equal(nativeApiRequestStarts, beforeInvalidFields.requests);
  report.observations.requiredServiceName = { exactAccessibleLabelsPreserved: true, ariaRequired: true,
    linkedRequiredHint: true, emptyCreateAndUpdateExplanation: true, nativeRequiredAttributeAdded: false, extraHttp: 0 };
  pass("invalid_empty_whitespace_fields_block_preview_and_corrected_cancel_preserves_input_without_write");

  report.stage = "update_mobile_untrusted_text_rendering";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage();
  await page.setViewportSize({ width: 320, height: 840 }); await open(page);
  const literalMarkup = "합성 <img src=x onerror=alert(1)>", longProvider = "합성제공자".repeat(30);
  const mobileId = fixture.services[0]!.serviceId, beforeMobilePreview = catalogMutationWire.length;
  await page.getByLabel("수정할 서비스", { exact: true }).selectOption(mobileId);
  await page.getByLabel("수정할 서비스 이름", { exact: true }).fill(literalMarkup);
  await page.getByLabel("수정할 제공자 (선택)", { exact: true }).fill(longProvider);
  await page.getByRole("button", { name: "수정 내용 미리보기", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "preview");
  await expect(page.getByTestId("catalog-service-update-preview")).toContainText(literalMarkup);
  await expect(page.getByTestId("catalog-service-update-preview").locator("img,svg,script")).toHaveCount(0);
  assert.equal(catalogMutationWire.length, beforeMobilePreview);
  const updateMobileLayout = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.equal(updateMobileLayout.viewport, 320); assert.ok(updateMobileLayout.documentWidth <= 320);
  await page.getByRole("button", { name: "이 내용으로 서비스 기록 수정", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "completed"); await whenIdle();
  await expect(page.getByTestId("catalog-service-update-result")).toContainText(literalMarkup);
  await expect(page.getByTestId("catalog-service-update-result").locator("img,svg,script")).toHaveCount(0);
  const storedMarkup = await observedService(mobileId);
  assert.equal(storedMarkup.profile?.name, literalMarkup); assert.equal(storedMarkup.profile?.provider, longProvider);
  assert.equal(catalogMutationWire.length, beforeMobilePreview + 1);
  report.observations.updateMobileText = { width: 320, horizontalOverflow: false,
    keyboardPreviewAndConfirm: true, literalMarkupPersistedAsText: true, injectedElements: 0 };
  await click(page, "Close"); await closed(page);
  pass("320px_keyboard_update_preserves_literal_markup_as_text_without_injected_elements_or_horizontal_overflow");

  report.stage = "controlled_visibility_unsent_preview";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  await choose(page, 1, 0); await click(page, "미리보기 요청");
  await expect(page.getByTestId("review-panel-preview")).toHaveCount(1);
  await previewUpdate(page, fixture.services[0]!.serviceId, "숨기기 전 합성 수정");
  await page.getByLabel("서비스 이름", { exact: true }).fill("숨기기 전 합성 등록");
  await click(page, "등록 내용 미리보기");
  await expect(page.getByTestId("catalog-service-create-preview")).toHaveCount(1);
  await expect(page.getByTestId("catalog-service-update-preview")).toHaveCount(1);
  await expect(page.getByTestId("review-panel-preview")).toHaveCount(1);
  const beforeControlledHide = { mutations: catalogMutationWire.length, review: wire.length, rows: fixture.store.snapshot() };
  const controlledHidden = await controlledVisibility(page, true);
  assert.equal(controlledHidden.trusted, false); assert.equal(controlledHidden.controlledHidden, true);
  assert.equal(controlledHidden.open, "no"); assert.equal(controlledHidden.privateNodes, 0);
  await closed(page); await whenIdle();
  const controlledVisible = await controlledVisibility(page, false);
  assert.equal(controlledVisible.open, "no"); assert.equal(controlledVisible.privateNodes, 0);
  await delay(100); assert.equal(catalogMutationWire.length, beforeControlledHide.mutations);
  assert.equal(wire.length, beforeControlledHide.review); assert.deepEqual(fixture.store.snapshot(), beforeControlledHide.rows);
  await page.evaluate(() => { Reflect.deleteProperty(document, "hidden"); });
  report.observations.controlledUnsentVisibility = { method: "own-property override plus untrusted Event",
    nativeTabHideVerified: false, hidden: controlledHidden, returned: controlledVisible, writes: 0, automaticReopen: false };
  pass("controlled_untrusted_visibility_change_closes_all_private_preview_dom_synchronously_without_write_or_auto_reopen");

  report.stage = "controlled_initially_hidden_mount";
  const beforeHiddenMount = { catalog: catalogWire.length, reads: reads.length, review: wire.length, completions, mutations: catalogMutationWire.length };
  await controlledVisibility(page, true);
  await click(page, "Open"); await closed(page);
  const hiddenMounted = await controlledVisibility(page, true);
  assert.equal(hiddenMounted.open, "no"); assert.equal(hiddenMounted.privateNodes, 0);
  await controlledVisibility(page, false); await closed(page); await delay(100);
  assert.deepEqual({ catalog: catalogWire.length, reads: reads.length, review: wire.length, completions, mutations: catalogMutationWire.length }, beforeHiddenMount);
  await page.evaluate(() => { Reflect.deleteProperty(document, "hidden"); });
  await open(page); await expect(panel(page)).toHaveAttribute("data-open", "yes");
  report.observations.controlledHiddenMount = { nativeTabHideVerified: false, finalPrivateNodes: 0,
    automaticHttp: 0, visibleAloneReopens: false, freshExplicitScopeWorks: true,
    activationCountNotAsserted: true };
  pass("controlled_initial_hidden_mount_stays_closed_without_http_visible_alone_cannot_reopen_fresh_explicit_scope_works");

  report.stage = "controlled_visibility_committed_pending_ack";
  await previewUpdate(page, fixture.services[0]!.serviceId, "非表示前に保存した合成名");
  holdNextCreateReply = true; armExpectedAbort("/api/catalog/update", page);
  const beforeHiddenDispatch = { requests: catalogMutationWire.length, startedAt: performance.now() };
  await click(page, "이 내용으로 서비스 기록 수정");
  await bounded((async () => { while (!releaseCreateReply) await delay(20); })());
  const hiddenCommitRows = fixture.store.snapshot();
  assert.equal((await observedService(fixture.services[0]!.serviceId)).profile?.name, "非表示前に保存した合成名");
  const controlledCommittedHide = await controlledVisibility(page, true);
  assert.equal(controlledCommittedHide.open, "no"); assert.equal(controlledCommittedHide.privateNodes, 0);
  await closed(page); await whenIdle();
  const controlledAbortElapsedMs = performance.now() - beforeHiddenDispatch.startedAt;
  assert.ok(controlledAbortElapsedMs < 8000, "CANDIDATE_HIDE_ABORT_MUST_PRECEDE_CLIENT_TIMEOUT");
  assert.equal(catalogMutationWire.length, beforeHiddenDispatch.requests + 1);
  assert.equal(catalogMutationWire.at(-1)?.status, 200); assert.equal(catalogMutationWire.at(-1)?.responseWriteAttempted, false);
  const afterHiddenCommit = { mutations: catalogMutationWire.length, review: wire.length, catalog: catalogWire.length, reads: reads.length, completions };
  await controlledVisibility(page, false); await closed(page); await delay(100);
  assert.deepEqual(fixture.store.snapshot(), hiddenCommitRows);
  assert.deepEqual({ mutations: catalogMutationWire.length, review: wire.length, catalog: catalogWire.length, reads: reads.length, completions }, afterHiddenCommit);
  await page.evaluate(() => { Reflect.deleteProperty(document, "hidden"); });
  report.observations.controlledCommittedVisibility = { nativeTabHideVerified: false,
    untrustedEvent: true, responseWriteAttempted: false, privateNodes: 0, committedRowPreserved: true, automaticReplay: false,
    actualRequests: catalogMutationWire.length - beforeHiddenDispatch.requests, controlledAbortElapsedMs };
  pass("controlled_visibility_after_actual_commit_before_ack_closes_dom_aborts_response_preserves_revision_no_replay");

  // This is a guarantee of the real sibling composition, not proof that the
  // update panel alone owns transport-replacement revocation. The create panel
  // can also revoke the shared workspace during the same React commit.
  for (const replacementPhase of ["before_commit", "after_commit"] as const) {
    report.stage = `update_transport_replacement_${replacementPhase}`;
    await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
    const targetId = fixture.services[0]!.serviceId, beforeRow = await observedService(targetId);
    const changedName = "연결 교체 전 합성 수정";
    await previewUpdate(page, targetId, changedName);
    const beforeRows = fixture.store.snapshot();
    const beforeReplacementDispatch: { mutations: number; review: number; catalog: number; reads: number;
      completions: number; startedAt: number } = { mutations: catalogMutationWire.length, review: wire.length,
      catalog: catalogWire.length, reads: reads.length, completions, startedAt: performance.now() };
    if (replacementPhase === "before_commit") holdNextCatalog = true;
    else holdNextCreateReply = true;
    armExpectedAbort("/api/catalog/update", page);
    await click(page, "이 내용으로 서비스 기록 수정");
    await bounded((async () => {
      while (!(replacementPhase === "before_commit" ? releaseCatalog : releaseCreateReply)) await delay(20);
    })());
    const heldRows = fixture.store.snapshot(), heldRow = await observedService(targetId);
    if (replacementPhase === "before_commit") assert.deepEqual(heldRows, beforeRows);
    else {
      assert.equal(heldRow.profile?.name, changedName);
      assert.equal(heldRow.serviceRevision, beforeRow.serviceRevision + 1);
    }
    await click(page, "Replace test transport"); await closed(page); await whenIdle();
    const abortElapsedMs = performance.now() - beforeReplacementDispatch.startedAt;
    assert.ok(abortElapsedMs < 8000, "CANDIDATE_REPLACEMENT_ABORT_MUST_PRECEDE_CLIENT_TIMEOUT");
    await expect(page.getByTestId("catalog-service-create-content")).toHaveCount(0);
    await expect(page.getByTestId("catalog-service-update-content")).toHaveCount(0);
    const replacedResponse = catalogMutationWire.at(-1);
    assert.equal(catalogMutationWire.length, beforeReplacementDispatch.mutations + 1);
    assert.equal(replacedResponse?.action, "update");
    assert.equal(replacedResponse?.status, replacementPhase === "before_commit" ? 408 : 200);
    assert.equal(replacedResponse?.code, replacementPhase === "before_commit" ? "API_ABORTED" : null);
    assert.equal(replacedResponse?.responseWriteAttempted, false);
    assert.deepEqual(fixture.store.snapshot(), heldRows);
    await delay(100);
    assert.deepEqual({ mutations: catalogMutationWire.length, review: wire.length, catalog: catalogWire.length,
      reads: reads.length, completions }, { mutations: beforeReplacementDispatch.mutations + 1,
      review: beforeReplacementDispatch.review, catalog: beforeReplacementDispatch.catalog,
      reads: beforeReplacementDispatch.reads, completions: beforeReplacementDispatch.completions });
    // A new explicit scope permits manual reads, never replays the old command.
    await open(page); await expect(updatePanel(page)).toHaveAttribute("data-phase", "selecting");
    await expect(page.getByTestId("catalog-service-update-preview")).toHaveCount(0);
    await expect(updatePanel(page).getByRole("button", { name: "같은 서비스 수정 요청의 결과 다시 확인", exact: true })).toHaveCount(0);
    assert.equal(catalogMutationWire.length, beforeReplacementDispatch.mutations + 1);
    assert.deepEqual(await observedService(targetId), heldRow);
    report.observations[`updateTransportReplacement_${replacementPhase}`] = {
      scope: "sibling composition, not isolated update panel", actualRequests: 1, abortElapsedMs,
      privateContentClosed: true, responseWriteAttempted: false, originalRequestReplay: false,
      serverRowChangedBeforeReplacement: replacementPhase === "after_commit", rowPreservedAfterReplacement: true,
      freshScopeExplicitReadsOnly: true };
    pass(`actual_update_${replacementPhase}_transport_replacement_closes_shared_scope_aborts_ack_preserves_rows_no_auto_replay`);
  }

  report.stage = "controlled_completion_port_aba_with_uncertain_review";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  await choose(page, 0, 0, "완료 포트 교체 중 보존할 합성 혜택"); await click(page, "미리보기 요청");
  await expect(page.getByTestId("review-panel-preview")).toHaveCount(1); await whenIdle();
  const beforePortConfirm = wire.length;
  expected503 = true;
  fixture.store.controls.afterCommit = () => { delete fixture.store.controls.afterCommit; throw Error(SYNTHETIC_PRIVATE); };
  await click(page, "이 내용으로 기록 저장");
  const portRetry = page.getByRole("group", { name: "결과 재확인", exact: true });
  await expect(portRetry).toBeVisible(); await whenIdle();
  const portBenefits = structuredClone(fixture.store.rows.benefits), portAnalysis = fixture.readAnalysisCounts();
  const beforePortReads = { catalog: catalogWire.length, reads: reads.length, completions, mutations: catalogMutationWire.length };
  const deliveryPanel = page.getByTestId("analysis-delivery");
  await click(page, "Use controlled completion A"); await expect(deliveryPanel).toHaveAttribute("data-phase", "idle");
  const staleA = await beginControlledCompletion(page, "A");
  await click(page, "Use controlled completion B"); await expect(deliveryPanel).toHaveAttribute("data-phase", "idle");
  assert.equal((await completionProbeSnapshot(page)).requests.find((row) => row.id === staleA)?.aborted, true);
  assert.equal((await completionProbeSnapshot(page)).callsB, 0);
  const selectedB = await beginControlledCompletion(page, "B");
  await settleControlledCompletion(page, selectedB, "resolve"); await expect(deliveryPanel).toHaveAttribute("data-phase", "saved");
  await click(page, "이 후보 묶음 검토하기"); await expect(deliveryPanel).toHaveAttribute("data-phase", "selected");
  assert.deepEqual({ catalog: catalogWire.length, reads: reads.length, completions, mutations: catalogMutationWire.length }, beforePortReads);
  // Controlled receipts are syntactically valid test locators, NOT authority.
  // Verify the explicitly selected B locator is sent, then actual resolver404.
  const selectedReferenceRequest = page.waitForRequest((request) => request.url() === origin + "/api/inbox/batch" && request.method() === "POST");
  expected404 = true; await click(page, "후보 불러오기·새로 확인");
  assert.equal((await selectedReferenceRequest).postDataJSON().batchReference, `synthetic-port-B-${selectedB}`);
  await expect(page.getByTestId("candidate-loader")).toHaveAttribute("data-phase", "failed"); await whenIdle();
  assert.equal(reads.at(-1)?.code, "API_NOT_FOUND"); assert.equal(expected404, false);
  const staleB = await beginControlledCompletion(page, "B");
  await click(page, "Use controlled completion A"); await expect(deliveryPanel).toHaveAttribute("data-phase", "idle");
  assert.equal((await completionProbeSnapshot(page)).requests.find((row) => row.id === staleB)?.aborted, true);
  // A is the original function object again. Old A success and old B rejection
  // must neither publish nor clear the new A owner's idle state.
  await settleControlledCompletion(page, staleA, "poison");
  await settleControlledCompletion(page, staleB, "reject");
  await expect(deliveryPanel).toHaveAttribute("data-phase", "idle");
  assert.equal((await completionProbeSnapshot(page)).payloadInspections, 0);
  assert.equal((await completionProbeSnapshot(page)).callsA, 1);
  assert.equal((await completionProbeSnapshot(page)).callsB, 2);
  await expect(portRetry).toContainText("완료 포트 교체 중 보존할 합성 혜택");
  const freshA = await beginControlledCompletion(page, "A");
  await settleControlledCompletion(page, freshA, "resolve"); await expect(deliveryPanel).toHaveAttribute("data-phase", "saved");
  await click(page, "이 후보 묶음 검토하기"); await expect(deliveryPanel).toHaveAttribute("data-phase", "selected");
  await click(page, "같은 요청의 결과 다시 확인"); await expect(portRetry).toHaveCount(0); await whenIdle();
  assert.deepEqual(wire.slice(beforePortConfirm).map(({ action, status }) => ({ action, status })),
    [{ action: "confirm", status: 503 }, { action: "confirm", status: 200 }]);
  assert.equal(wire.at(-1)?.digest, wire[beforePortConfirm]?.digest);
  assert.deepEqual(fixture.store.rows.benefits, portBenefits); assert.deepEqual(fixture.readAnalysisCounts(), portAnalysis);
  assert.deepEqual({ catalog: catalogWire.length, reads: reads.length, completions, mutations: catalogMutationWire.length },
    { ...beforePortReads, reads: beforePortReads.reads + 1 });
  report.observations.controlledCompletionPortABA = { nonCooperativeInjectedPromise: true, nativeProviderEvidence: false,
    stalePayloadReflections: 0, oldAAndBAborted: true, automaticBCalls: 0, exactBLocatorExplicitReadStatus: 404,
    originalConfirmDigestPreserved: true, duplicateBenefitRows: 0, analysisReplay: false };
  pass("controlled_completion_port_A_B_A_late_success_rejection_do_not_publish_preserves_original_uncertain_review_request");

  report.stage = "controlled_current_completion_poison_control";
  const currentPoison = await beginControlledCompletion(page, "A");
  await settleControlledCompletion(page, currentPoison, "poison");
  await expect(deliveryPanel).toHaveAttribute("data-phase", "unconfirmed");
  assert.equal((await completionProbeSnapshot(page)).payloadInspections, 1);
  await expect(page.locator("body")).not.toContainText("SYNTHETIC_PROBE_INSPECTED");
  await expect(page.locator("body")).not.toContainText("SYNTHETIC_PROBE_REJECTED");
  report.observations.completionPoisonControl = { currentPayloadReflections: 1, malformedReceiptAccepted: false };
  pass("current_poison_receipt_positive_control_reflects_once_and_rejects_without_private_error_output");

  report.stage = "controlled_completion_cancel_late_and_new_scope";
  const beforeLateCompletion = { catalog: catalogWire.length, reads: reads.length, completions, review: wire.length,
    mutations: catalogMutationWire.length, rows: fixture.store.snapshot(), analysis: fixture.readAnalysisCounts() };
  const cancelledCompletion = await beginControlledCompletion(page, "A");
  await click(page, "결과 확인 취소"); await expect(deliveryPanel).toHaveAttribute("data-phase", "idle");
  assert.equal((await completionProbeSnapshot(page)).requests.find((row) => row.id === cancelledCompletion)?.aborted, true);
  const afterCancelCompletion = await beginControlledCompletion(page, "A");
  await settleControlledCompletion(page, cancelledCompletion, "poison");
  await expect(deliveryPanel).toHaveAttribute("data-phase", "receiving");
  assert.equal((await completionProbeSnapshot(page)).payloadInspections, 1);
  await settleControlledCompletion(page, afterCancelCompletion, "resolve");
  await expect(deliveryPanel).toHaveAttribute("data-phase", "saved");
  const oldScopeCompletion = await beginControlledCompletion(page, "A");
  await click(page, "Close"); await closed(page);
  assert.equal((await completionProbeSnapshot(page)).requests.find((row) => row.id === oldScopeCompletion)?.aborted, true);
  const callsBeforeFreshScope = (await completionProbeSnapshot(page)).callsA;
  await click(page, "Open"); await expect(panel(page)).toHaveAttribute("data-open", "yes");
  await expect(deliveryPanel).toHaveAttribute("data-phase", "idle");
  assert.equal((await completionProbeSnapshot(page)).callsA, callsBeforeFreshScope);
  const newScopeCompletion = await beginControlledCompletion(page, "A");
  await settleControlledCompletion(page, oldScopeCompletion, "resolve");
  await expect(deliveryPanel).toHaveAttribute("data-phase", "receiving");
  await settleControlledCompletion(page, newScopeCompletion, "resolve");
  await expect(deliveryPanel).toHaveAttribute("data-phase", "saved");
  assert.equal((await completionProbeSnapshot(page)).payloadInspections, 1);
  assert.ok((await completionProbeSnapshot(page)).requests.every((row) => row.settled));
  assert.deepEqual({ catalog: catalogWire.length, reads: reads.length, completions, review: wire.length,
    mutations: catalogMutationWire.length, rows: fixture.store.snapshot(), analysis: fixture.readAnalysisCounts() }, beforeLateCompletion);
  report.observations.controlledCompletionLate = { ignoredAbortPromiseSettled: true, cancelThenNewRequestPreserved: true,
    closeThenNewLeasePreserved: true, allProbePromisesSettled: true, automaticReadsOrWrites: 0,
    stalePayloadAdditionalReflections: 0 };
  pass("controlled_abort_ignoring_completion_late_after_cancel_and_scope_reopen_cannot_replace_current_pending_receipt");

  report.stage = "mutation_receipt_observation_is_not_latest_list";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  await previewCreate(page, "합성 등록 응답 이름"); await saveCreate(page);
  const receiptCreated = [...fixture.store.rows.services.values()].find((row) => row.name === "합성 등록 응답 이름");
  assert.ok(receiptCreated);
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  const receiptUpdatedId = fixture.services[0]!.serviceId;
  await previewUpdate(page, receiptUpdatedId, "합성 수정 응답 이름"); await saveUpdate(page);
  const beforeIndependentWrites = { mutations: catalogMutationWire.length, reads: catalogWire.length, review: wire.length };
  for (const [serviceId, name, operationId] of [
    [receiptCreated.id, "합성 새 목록 등록 이름", "synthetic-later-create-observation"],
    [receiptUpdatedId, "합성 새 목록 수정 이름", "synthetic-later-update-observation"],
  ] as const) {
    const previous = await observedService(serviceId); assert.ok(previous.profile);
    assert.ok((await createServiceCatalog(fixture.store.catalogDependencies).update({ serviceId,
      expectedRevision: previous.serviceRevision, operationId, decision: "update", profile: { ...previous.profile, name } })).ok);
    assert.equal((await observedService(serviceId)).serviceRevision, previous.serviceRevision + 1);
  }
  assert.deepEqual({ mutations: catalogMutationWire.length, reads: catalogWire.length, review: wire.length }, beforeIndependentWrites);
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page); await whenIdle();
  const freshServiceChoices = page.getByLabel("연결할 기존 서비스", { exact: true });
  await expect(freshServiceChoices).toContainText("합성 새 목록 등록 이름");
  await expect(freshServiceChoices).toContainText("합성 새 목록 수정 이름");
  const createReceiptResult = page.getByTestId("catalog-service-create-result");
  const updateReceiptResult = page.getByTestId("catalog-service-update-result");
  await expect(createReceiptResult).toContainText("합성 등록 응답 이름");
  await expect(updateReceiptResult).toContainText("합성 수정 응답 이름");
  assert.equal(catalogMutationWire.length, beforeIndependentWrites.mutations);
  report.observations.receiptObservation = { actualSeparateServerUpdates: 2, laterListNamesObserved: true,
    originalResponseNamesRetained: true, automaticMutationOrReplay: false };
  await expect(createReceiptResult).toContainText("등록 응답 당시 확인한 기록");
  await expect(updateReceiptResult).toContainText("수정 응답 당시 확인한 기록");
  await expect(createReceiptResult).not.toContainText("현재 앱 기록");
  await expect(updateReceiptResult).not.toContainText("현재 앱 기록");
  pass("create_update_receipt_snapshots_are_labeled_as_response_time_not_newer_manually_loaded_catalog");

  report.stage = "delete_explicit_choice_confirmation_cancel";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  const deleteChoiceBefore = { mutations: catalogMutationWire.length, reads: catalogWire.length, review: wire.length,
    rows: fixture.store.snapshot() };
  await expect(deletePanel(page)).toHaveAttribute("data-phase", "selecting");
  await page.getByLabel("삭제할 서비스", { exact: true }).evaluate((element) => {
    const select = element as HTMLSelectElement; select.value = "synthetic-absent-delete-target";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(deletePanel(page)).toHaveAttribute("data-phase", "selecting");
  await page.getByLabel("삭제할 서비스", { exact: true }).selectOption(fixture.services[1]!.serviceId);
  await expect(deletePanel(page)).toHaveAttribute("data-phase", "selected");
  await page.getByLabel("삭제할 서비스", { exact: true }).selectOption("");
  await expect(deletePanel(page)).toHaveAttribute("data-phase", "selecting");
  await previewDelete(page, fixture.services[0]!.serviceId);
  await page.getByLabel("서비스 삭제 확인 문구", { exact: true }).fill("지움");
  const deleteConfirm = page.getByRole("button", { name: "이 서비스 기록 삭제", exact: true });
  await expect(deleteConfirm).toBeDisabled();
  // A controlled DOM attempt removes only the button's presentation gate; the
  // component's exact-phrase check must independently reject its stale handler.
  await deleteConfirm.evaluate((element) => { const button = element as HTMLButtonElement; button.disabled = false; button.click(); });
  await expect(deletePanel(page)).toHaveAttribute("data-phase", "preview");
  await page.getByLabel("서비스 삭제 확인 문구", { exact: true }).focus(); await page.keyboard.press("Escape");
  await expect(deletePanel(page)).toHaveAttribute("data-phase", "selected");
  await expect(page.getByTestId("catalog-service-delete-preview")).toHaveCount(0);
  await click(page, "서비스 삭제 대상 미리보기");
  await page.getByLabel("서비스 삭제 확인 문구", { exact: true }).fill("삭제");
  await page.evaluate(() => {
    const oldConfirm = [...document.querySelectorAll("button")].find((button) => button.textContent === "이 서비스 기록 삭제");
    document.querySelector('[data-testid="catalog-service-delete-status"]')?.addEventListener("focus", () => oldConfirm?.click(), { once: true });
  });
  await click(page, "서비스 삭제 미리보기 취소");
  await expect(deletePanel(page)).toHaveAttribute("data-phase", "selected");
  await expect(page.getByTestId("catalog-service-delete-preview")).toHaveCount(0); await whenIdle();
  assert.deepEqual({ mutations: catalogMutationWire.length, reads: catalogWire.length, review: wire.length,
    rows: fixture.store.snapshot() }, deleteChoiceBefore);
  pass("delete_empty_invalid_choice_recovers_exact_phrase_required_escape_and_focus_reentrant_cancel_send_no_request");

  report.stage = "delete_unsent_catalog_change";
  await click(page, "서비스 삭제 대상 미리보기");
  await page.getByLabel("서비스 삭제 확인 문구", { exact: true }).fill("삭제");
  await click(page, "서비스 목록 처음부터 다시 확인");
  await expect(deletePanel(page)).toHaveAttribute("data-phase", "selecting");
  await expect(page.getByTestId("catalog-service-delete-preview")).toHaveCount(0);
  assert.equal(catalogMutationWire.length, deleteChoiceBefore.mutations);
  await nextCatalog(page); await expect(page.getByLabel("삭제할 서비스", { exact: true })).toHaveValue("");
  pass("catalog_restart_discards_unsent_delete_target_confirmation_and_command_without_write");

  report.stage = "delete_actual_tombstone_no_profile";
  const deletedServiceId = fixture.services[0]!.serviceId, deletedServiceName = fixture.services[0]!.profile!.name;
  await choose(page, 0, 0, "삭제 전 미리보기만 만든 합성 혜택"); await click(page, "미리보기 요청");
  await expect(page.getByTestId("review-panel-preview")).toHaveCount(1); await whenIdle();
  await previewDelete(page, deletedServiceId);
  await expect(page.getByTestId("catalog-service-delete-preview")).toContainText("원래 버전: 1");
  const beforeActualDelete = { mutations: catalogMutationWire.length, operations: fixture.store.rows.catalogOperations.size,
    revisions: new Map(fixture.store.rows.catalogRevisions) };
  await saveDelete(page);
  const deletedService = await observedService(deletedServiceId);
  assert.equal(deletedService.state, "deleted"); assert.equal(deletedService.profile, null); assert.equal(deletedService.serviceRevision, 2);
  assert.equal(fixture.store.rows.catalogOperations.size, beforeActualDelete.operations + 1);
  for (const [key, revision] of beforeActualDelete.revisions) assert.equal(fixture.store.rows.catalogRevisions.get(key), revision + 1);
  assert.equal(fixture.store.rows.benefits.size, 0);
  assert.equal([...fixture.store.rows.previews.values()].filter((entry) => entry.state === "pending").length, 0);
  await expect(page.getByTestId("review-panel-preview")).toHaveCount(0);
  await expect(page.getByTestId("catalog-service-delete-preview")).toHaveCount(0);
  const deletedResult = page.getByTestId("catalog-service-delete-result");
  await expect(deletedResult).toHaveAttribute("data-service-state", "deleted");
  await expect(deletedResult).toContainText("삭제 응답 당시"); await expect(deletedResult).not.toContainText(deletedServiceName);
  assert.equal(catalogMutationWire.length, beforeActualDelete.mutations + 1);
  assert.deepEqual({ action: catalogMutationWire.at(-1)?.action, status: catalogMutationWire.at(-1)?.status,
    state: catalogMutationWire.at(-1)?.state, replayed: catalogMutationWire.at(-1)?.replayed },
  { action: "delete", status: 200, state: "deleted", replayed: false });
  await click(page, "다른 서비스 삭제 준비"); await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  assert.deepEqual(await page.getByLabel("삭제할 서비스", { exact: true }).locator("option").evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value)), ["", fixture.services[1]!.serviceId]);
  assert.equal(catalogMutationWire.length, beforeActualDelete.mutations + 1);
  pass("actual_delete_exact_revision_tombstones_service_erases_pending_preview_no_previous_profile_or_cascade");

  report.stage = "delete_ack_loss_original_command";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  await previewDelete(page, fixture.services[0]!.serviceId);
  const beforeDeleteAck = catalogMutationWire.length;
  expectedDelete503 = true; failNextDeletedAcknowledgement = true; await saveDelete(page, "uncertain");
  const committedDelete = fixture.store.snapshot();
  assert.equal((await observedService(fixture.services[0]!.serviceId)).state, "deleted");
  const deleteRetry = page.getByRole("button", { name: "같은 서비스 삭제 요청의 결과 다시 확인", exact: true });
  await deleteRetry.focus(); await page.keyboard.press("Escape");
  await expect(deleteRetry).toBeFocused(); await expect(deletePanel(page)).toHaveAttribute("data-phase", "uncertain");
  await expect(page.getByLabel("삭제할 서비스", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("서비스 삭제 확인 문구", { exact: true })).toHaveCount(0);
  assert.equal(catalogMutationWire.length, beforeDeleteAck + 1);
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await expect(deletePanel(page)).toHaveAttribute("data-phase", "uncertain");
  await expect(page.getByTestId("catalog-service-delete-preview")).toContainText("원래 버전: 1");
  await click(page, "같은 서비스 삭제 요청의 결과 다시 확인");
  await expect(deletePanel(page)).toHaveAttribute("data-phase", "completed"); await whenIdle();
  assert.equal(catalogMutationWire.at(-1)?.digest, catalogMutationWire[beforeDeleteAck]?.digest);
  assert.equal(catalogMutationWire.at(-1)?.replayed, true); assert.deepEqual(fixture.store.snapshot(), committedDelete);
  assert.deepEqual(catalogMutationWire.slice(beforeDeleteAck).map(({ action, status }) => ({ action, status })),
    [{ action: "delete", status: 503 }, { action: "delete", status: 200 }]);
  await expect(page.getByTestId("catalog-service-delete-result")).toContainText("원래 삭제 요청을 재확인한 응답 당시");
  await expect(page.getByTestId("catalog-service-delete-preview")).toHaveCount(0);
  assert.equal(expectedDelete503, false); assert.equal(matchedDelete503, 1);
  pass("actual_delete_ack_loss_escape_list_restart_preserve_identical_original_retry_no_duplicate_tombstone_or_revision");

  report.stage = "delete_stale_revision_no_rebase";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  const staleDeleteId = fixture.services[0]!.serviceId;
  await previewDelete(page, staleDeleteId);
  assert.ok((await createServiceCatalog(fixture.store.catalogDependencies).update({ serviceId: staleDeleteId,
    expectedRevision: 1, operationId: "synthetic-write-before-delete", decision: "update",
    profile: { ...fixture.services[0]!.profile!, name: "삭제 전에 다른 작성자가 수정한 합성 서비스" } })).ok);
  const staleDeleteRows = fixture.store.snapshot(); expectedDelete409 = true; await saveDelete(page, "uncertain");
  const staleDeleteDigest = catalogMutationWire.at(-1)?.digest;
  assert.equal(catalogMutationWire.at(-1)?.code, "API_CONFLICT"); assert.deepEqual(fixture.store.snapshot(), staleDeleteRows);
  await expect(page.getByTestId("catalog-service-delete-status")).toContainText("원인을 단정하거나 새 버전으로 자동 삭제하지 않습니다");
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await expect(page.getByTestId("catalog-service-delete-preview")).toContainText("원래 버전: 1");
  expectedDelete409 = true; await click(page, "같은 서비스 삭제 요청의 결과 다시 확인");
  await expect(deletePanel(page)).toHaveAttribute("data-phase", "uncertain"); await whenIdle();
  assert.equal(catalogMutationWire.at(-1)?.digest, staleDeleteDigest); assert.equal(catalogMutationWire.at(-1)?.code, "API_CONFLICT");
  assert.deepEqual(fixture.store.snapshot(), staleDeleteRows); assert.equal(expectedDelete409, false); assert.equal(matchedDelete409, 2);
  pass("actual_delete_cas_conflict_keeps_original_revision_after_new_list_and_replay_never_rebases_or_guesses_cause");

  for (const expiry of [null, "2020-01-01T00:00:00.000Z"] as const) {
    report.stage = expiry === null ? "delete_retained_live_benefit" : "delete_retained_expired_benefit";
    await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
    await choose(page, 0, 0, "서비스 삭제에서 보존할 합성 혜택");
    if (expiry !== null) await form(page).getByLabel("기록된 만료일", { exact: true }).fill(expiry);
    await click(page, "미리보기 요청"); await expect(page.getByTestId("review-panel-preview")).toHaveCount(1);
    await click(page, "이 내용으로 기록 저장");
    if (expiry !== null) {
      // Expired retained benefits belong to the explicitly selected history
      // filter, not the default review list. Verify both views before deletion.
      await click(page, "불러온 지난 기록");
      await expect(page.getByTestId("review-panel-rows").locator("li")).toHaveCount(1);
      await click(page, "불러온 확인할 기록");
      await expect(page.getByTestId("review-panel-rows").locator("li")).toHaveCount(0);
    } else await expect(page.getByTestId("review-panel-rows").locator("li")).toHaveCount(1);
    await whenIdle();
    const keptBenefit = [...fixture.store.rows.benefits.values()][0]!;
    assert.equal(keptBenefit.state, "live"); assert.equal(keptBenefit.content?.values.expiresAt, expiry);
    if (expiry !== null) assert.ok(Date.parse(expiry) < clock());
    await previewDelete(page, fixture.services[0]!.serviceId);
    const beforeGuardDelete = fixture.store.snapshot(); expectedDelete409 = true; await saveDelete(page, "uncertain");
    assert.equal(catalogMutationWire.at(-1)?.code, "API_CONFLICT"); assert.deepEqual(fixture.store.snapshot(), beforeGuardDelete);
    assert.equal((await observedService(fixture.services[0]!.serviceId)).state, "live");
    await expect(page.getByTestId("catalog-service-delete-status")).toContainText("원인을 단정하거나 새 버전으로 자동 삭제하지 않습니다");
    assert.equal(expectedDelete409, false);
    pass(expiry === null ? "actual_delete_retained_live_benefit_guard_no_cascade_or_service_mutation"
      : "actual_delete_retained_expired_benefit_still_live_guard_no_hidden_history_cascade");
  }
  assert.equal(matchedDelete409, 4);

  report.stage = "delete_authority_rejection";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  await previewDelete(page, fixture.services[0]!.serviceId);
  await page.getByLabel("서비스 삭제 확인 문구", { exact: true }).fill("삭제");
  const beforeDeleteAuthority = fixture.store.snapshot(); fixture.store.controls.authority = null; expectedDelete401 = true;
  await click(page, "이 서비스 기록 삭제"); await closed(page); await whenIdle();
  await expect(page.getByTestId("catalog-service-delete-content")).toHaveCount(0);
  await expect(page.getByTestId("catalog-service-create-content")).toHaveCount(0);
  await expect(page.getByTestId("catalog-service-update-content")).toHaveCount(0);
  assert.equal(catalogMutationWire.at(-1)?.code, "API_AUTH_REQUIRED"); assert.deepEqual(fixture.store.snapshot(), beforeDeleteAuthority);
  assert.equal(expectedDelete401, false); assert.equal(matchedDelete401, 1);
  pass("actual_delete_auth_rejection_closes_shared_private_scope_without_deleting_records");

  for (const deletePhase of ["before_commit", "after_commit"] as const) {
    report.stage = `delete_native_back_${deletePhase}`;
    // New clean documents avoid replaying previous expected resource errors.
    await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
    await previewDelete(page, fixture.services[0]!.serviceId);
    await page.getByLabel("서비스 삭제 확인 문구", { exact: true }).fill("삭제");
    const deleteBackRows = fixture.store.snapshot(), deleteBackRequests = catalogMutationWire.length;
    if (deletePhase === "before_commit") holdNextCatalog = true;
    else holdNextCreateReply = true;
    armExpectedAbort("/api/catalog/delete", page);
    await click(page, "이 서비스 기록 삭제");
    await bounded((async () => { while (!(deletePhase === "before_commit" ? releaseCatalog : releaseCreateReply)) await delay(20); })());
    await expect(deletePanel(page)).toHaveAttribute("data-phase", "pending");
    const heldDeleteRows = fixture.store.snapshot();
    if (deletePhase === "before_commit") assert.deepEqual(heldDeleteRows, deleteBackRows);
    else {
      const heldDelete = await observedService(fixture.services[0]!.serviceId);
      assert.equal(heldDelete.state, "deleted"); assert.equal(heldDelete.profile, null); assert.equal(heldDelete.serviceRevision, 2);
    }
    const deleteBackMarker = await observeLifecycle(page);
    await page.getByRole("link", { name: "Leave document", exact: true }).click();
    await expect(page).toHaveURL(origin + "/__candidate_away.html"); await whenIdle();
    assert.equal(catalogMutationWire.length, deleteBackRequests + 1);
    assert.equal(catalogMutationWire.at(-1)?.action, "delete");
    assert.equal(catalogMutationWire.at(-1)?.status, deletePhase === "before_commit" ? 408 : 200);
    assert.equal(catalogMutationWire.at(-1)?.code, deletePhase === "before_commit" ? "API_ABORTED" : null);
    assert.equal(catalogMutationWire.at(-1)?.responseWriteAttempted, false);
    await page.goBack({ waitUntil: "commit" }); await closed(page);
    await recordLifecycle(page, deleteBackMarker, `deleteLifecycle_${deletePhase}`);
    await expect(page.getByTestId("catalog-service-delete-content")).toHaveCount(0);
    await delay(100); assert.equal(catalogMutationWire.length, deleteBackRequests + 1); assert.deepEqual(fixture.store.snapshot(), heldDeleteRows);
    await open(page); await expect(deletePanel(page)).toHaveAttribute("data-phase", "selecting");
    await expect(page.getByTestId("catalog-service-delete-preview")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "같은 서비스 삭제 요청의 결과 다시 확인", exact: true })).toHaveCount(0);
    assert.equal(catalogMutationWire.length, deleteBackRequests + 1); assert.deepEqual(fixture.store.snapshot(), heldDeleteRows);
    pass(`native_delete_${deletePhase}_back_revokes_private_dom_original_command_and_preserves_actual_server_state_without_replay`);
  }

  const cancelFocusResults: { action: string; listenerFired: boolean; phase: string | null;
    mutationDelta: number; serverRowsPreserved: boolean; previewNodes: number; unsentNamePreserved: boolean;
    unsentLabelsPreserved: boolean }[] = [];
  report.observations.cancelFocus = cancelFocusResults;
  for (const action of ["create", "update"] as const) {
    report.stage = `${action}_cancel_focus_reentry`;
    await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
    const unsentName = action === "create" ? "취소할 합성 등록" : "취소할 합성 수정";
    const unsentLabels = { planName: "취소할 합성 요금제", accountLabel: "취소할 합성 표시" };
    if (action === "create") await previewCreate(page, unsentName, "합성 제공자", unsentLabels);
    else await previewUpdate(page, fixture.services[0]!.serviceId, unsentName, "합성 제공자", unsentLabels);
    const beforeCancel = { mutations: catalogMutationWire.length, rows: fixture.store.snapshot() };
    await page.evaluate(({ action }) => {
      const status = document.querySelector(`[data-testid="catalog-service-${action}-status"]`);
      const label = action === "create" ? "이 내용으로 서비스 기록 저장" : "이 내용으로 서비스 기록 수정";
      const confirm = [...document.querySelectorAll("button")].find((button) => button.textContent === label);
      if (!(status instanceof HTMLElement) || !confirm) throw Error("SYNTHETIC_CANCEL_TARGET");
      status.addEventListener("focus", () => { status.dataset.cancelReentry = "yes"; confirm.click(); }, { once: true });
    }, { action });
    await click(page, action === "create" ? "미리보기 취소" : "수정 미리보기 취소");
    const panel = action === "create" ? createPanel(page) : updatePanel(page);
    await expect(page.getByTestId(`catalog-service-${action}-status`)).toHaveAttribute("data-cancel-reentry", "yes");
    await expect.poll(() => panel.getAttribute("data-phase")).not.toBe("pending");
    await whenIdle();
    const nameInput = page.getByLabel(action === "create" ? "서비스 이름" : "수정할 서비스 이름", { exact: true });
    const planInput = page.getByLabel(action === "create" ? "요금제 이름 (선택)" : "수정할 요금제 이름 (선택)", { exact: true });
    const accountInput = page.getByLabel(action === "create" ? "계정 표시 이름 (선택)" : "수정할 계정 표시 이름 (선택)", { exact: true });
    cancelFocusResults.push({ action, listenerFired: true, phase: await panel.getAttribute("data-phase"),
      mutationDelta: catalogMutationWire.length - beforeCancel.mutations,
      serverRowsPreserved: isDeepStrictEqual(fixture.store.snapshot(), beforeCancel.rows),
      previewNodes: await page.getByTestId(`catalog-service-${action}-preview`).count(),
      unsentNamePreserved: await nameInput.count() === 1 && await nameInput.inputValue() === unsentName,
      unsentLabelsPreserved: await planInput.count() === 1 && await accountInput.count() === 1
        && await planInput.inputValue() === unsentLabels.planName && await accountInput.inputValue() === unsentLabels.accountLabel });
  }
  // Collect both real outcomes before asserting, so a RED create result does not
  // hide whether the distinct update path also dispatched an unwanted write.
  for (const result of cancelFocusResults) {
    assert.deepEqual(result, { action: result.action, listenerFired: true, phase: "editing", mutationDelta: 0,
      serverRowsPreserved: true, previewNodes: 0, unsentNamePreserved: true, unsentLabelsPreserved: true });
    pass(`${result.action}_cancel_revokes_before_synchronous_focus_reentry_no_mutation_and_keeps_unsent_fields`);
  }

  report.stage = "update_optional_labels_exact_values";
  await closePage(page); await whenIdle(); await freshFixture();
  const labelServiceId = fixture.services[0]!.serviceId;
  const originalLabelProfile = { ...fixture.services[0]!.profile!, provider: "합성 원래 제공자", planName: "기존 합성 요금제",
    accountLabel: "기존 합성 표시", timezone: "Asia/Seoul", subscriptionStatus: "trial" as const,
    trialEndsAt: "2027-01-01T00:00:00.123456789+09:00", notes: "합성 보존 메모\n둘째 줄" };
  assert.ok((await createServiceCatalog(fixture.store.catalogDependencies).update({ serviceId: labelServiceId,
    expectedRevision: 1, operationId: "synthetic-label-setup", decision: "update", profile: originalLabelProfile })).ok);
  page = await newPage(); await page.setViewportSize({ width: 320, height: 740 }); await open(page);
  await page.getByLabel("수정할 서비스", { exact: true }).selectOption(labelServiceId);
  const planInput = page.getByLabel("수정할 요금제 이름 (선택)", { exact: true });
  const accountInput = page.getByLabel("수정할 계정 표시 이름 (선택)", { exact: true });
  await expect(planInput).toHaveValue(originalLabelProfile.planName);
  await expect(accountInput).toHaveValue(originalLabelProfile.accountLabel);
  for (const input of [planInput, accountInput]) {
    await expect(input).toHaveAttribute("maxlength", "160"); await expect(input).toHaveAttribute("autocomplete", "off");
    await expect(input).toHaveAttribute("spellcheck", "false"); await expect(input).toBeEnabled();
    const described = await input.getAttribute("aria-describedby"); assert.ok(described);
    await expect(page.locator(`[id="${described}"]`)).toContainText("실제 개인정보·비밀번호·API 키는 입력하지 마세요");
  }
  const beforeInvalidLabel = { mutations: catalogMutationWire.length, catalog: catalogWire.length, rows: fixture.store.snapshot() };
  for (const [input, value] of [[planInput, "  "], [accountInput, " 앞 공백"]] as const) {
    await planInput.fill(""); await accountInput.fill(""); await input.fill(value);
    await click(page, "수정 내용 미리보기"); await expect(updatePanel(page)).toHaveAttribute("data-phase", "editing");
    await expect(page.getByTestId("catalog-service-update-status")).toContainText("앞뒤 공백·금지 문자는 허용하지 않습니다");
    await expect(input).toHaveValue(value); await expect(page.getByTestId("catalog-service-update-preview")).toHaveCount(0);
  }
  assert.deepEqual({ mutations: catalogMutationWire.length, catalog: catalogWire.length, rows: fixture.store.snapshot() }, beforeInvalidLabel);
  pass("optional_label_accessible_inputs_and_invalid_whitespace_preserved_without_preview_or_http");

  const changedLabels = { planName: "합성  요금제 e\u0301", accountLabel: "합성 <b>표시</b> 😀" };
  await planInput.fill(changedLabels.planName); await accountInput.fill(changedLabels.accountLabel);
  await accountInput.focus(); await page.keyboard.press("Tab");
  for (const field of ["timezone", "subscription-status", "trial-ends-at"]) {
    await expect(page.getByTestId(`catalog-service-update-${field}`)).toBeFocused(); await page.keyboard.press("Tab");
  }
  await expect(page.getByTestId("catalog-service-update-notes")).toBeFocused(); await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "수정 내용 미리보기", exact: true })).toBeFocused();
  await page.keyboard.press("Enter"); await expect(updatePanel(page)).toHaveAttribute("data-phase", "preview");
  const labelPreview = page.getByTestId("catalog-service-update-preview");
  await expect(labelPreview).toContainText(changedLabels.planName); await expect(labelPreview).toContainText(changedLabels.accountLabel);
  await expect(labelPreview.locator("b,script,img")).toHaveCount(0);
  assert.equal(await updatePanel(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
  await saveUpdate(page);
  const labelsUpdated = await observedService(labelServiceId);
  assert.equal(labelsUpdated.serviceRevision, 3);
  assert.deepEqual(labelsUpdated.profile, { ...originalLabelProfile, ...changedLabels });
  pass("optional_labels_keyboard_mobile_literal_unicode_update_preserves_other_six_exact_facts");

  report.stage = "update_optional_labels_clear_and_reconcile";
  await click(page, "다른 서비스 수정 준비"); await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await previewUpdate(page, labelServiceId, originalLabelProfile.name, originalLabelProfile.provider,
    { planName: "", accountLabel: "" });
  const beforeLabelAck = catalogMutationWire.length;
  expectedUpdate503 = true; failNextUpdatedAcknowledgement = true; await saveUpdate(page, "uncertain");
  const labelAckRows = fixture.store.snapshot();
  assert.deepEqual((await observedService(labelServiceId)).profile, { ...originalLabelProfile, planName: null, accountLabel: null });
  await expect(planInput).toHaveCount(0); await expect(accountInput).toHaveCount(0);
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "uncertain");
  await click(page, "같은 서비스 수정 요청의 결과 다시 확인");
  await expect(updatePanel(page)).toHaveAttribute("data-phase", "completed"); await whenIdle();
  assert.deepEqual(catalogMutationWire.slice(beforeLabelAck).map(({ action, status }) => ({ action, status })),
    [{ action: "update", status: 503 }, { action: "update", status: 200 }]);
  assert.equal(catalogMutationWire.at(-1)?.digest, catalogMutationWire[beforeLabelAck]?.digest);
  assert.equal(catalogMutationWire.at(-1)?.replayed, true); assert.deepEqual(fixture.store.snapshot(), labelAckRows);
  pass("optional_labels_exact_empty_to_null_unknown_ack_replays_identical_command_without_duplicate_revision");

  report.stage = "benefit_delete_cancel_commit_focus";
  for (const method of ["click", "escape"] as const) {
    await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
    await choose(page, 0, 0, "취소 경계 합성 혜택"); await click(page, "미리보기 요청");
    await expect(page.getByTestId("review-panel-preview")).toHaveCount(1); await click(page, "이 내용으로 기록 저장");
    const benefitRows = page.getByTestId("review-panel-rows").locator("li"); await expect(benefitRows).toHaveCount(1); await whenIdle();
    const retainedBenefit = [...fixture.store.rows.benefits.values()][0]!;
    await benefitRows.first().getByRole("button", { name: "기록 삭제 검토", exact: true }).click();
    const group = page.getByRole("group", { name: "앱 기록 삭제 확인", exact: true });
    await group.getByLabel("삭제 확인 문구", { exact: true }).fill("삭제");
    const beforeCancel: { review: number; api: number; mutations: number; rows: ReturnType<typeof fixture.store.snapshot> } =
      { review: wire.length, api: nativeApiRequestStarts, mutations: catalogMutationWire.length, rows: fixture.store.snapshot() };
    await page.evaluate(() => {
      const status = document.querySelector('[data-testid="review-panel-status"]');
      const confirm = [...document.querySelectorAll("button")].find((button) => button.textContent === "앱 기록 삭제");
      if (!(status instanceof HTMLElement) || !confirm) throw Error("SYNTHETIC_BENEFIT_CANCEL_TARGET");
      status.addEventListener("focus", () => { status.dataset.benefitCancelReentry = "yes"; confirm.click(); }, { once: true });
    });
    const cancel = group.getByRole("button", { name: "삭제 취소", exact: true });
    if (method === "click") await cancel.click(); else { await cancel.focus(); await page.keyboard.press("Escape"); }
    await expect(page.getByTestId("review-panel-status")).toHaveAttribute("data-benefit-cancel-reentry", "yes");
    await expect(page.getByTestId("review-panel-status")).toBeFocused(); await expect(group).toHaveCount(0); await whenIdle();
    assert.deepEqual({ review: wire.length, api: nativeApiRequestStarts, mutations: catalogMutationWire.length, rows: fixture.store.snapshot() }, beforeCancel);
    assert.equal(fixture.store.rows.benefits.get(retainedBenefit.id)?.state, "live");
    await benefitRows.first().getByRole("button", { name: "기록 삭제 검토", exact: true }).click();
    await expect(group.getByLabel("삭제 확인 문구", { exact: true })).toHaveValue("");
    await expect(group.getByRole("button", { name: "앱 기록 삭제", exact: true })).toBeDisabled();
    await group.getByLabel("삭제 확인 문구", { exact: true }).fill("삭제");
    await group.getByRole("button", { name: "앱 기록 삭제", exact: true }).click();
    await expect(benefitRows).toHaveCount(0); await whenIdle();
    assert.equal(wire.length, beforeCancel.review + 1); assert.equal(wire.at(-1)?.action, "delete"); assert.equal(wire.at(-1)?.status, 200);
    assert.equal(fixture.store.rows.benefits.get(retainedBenefit.id)?.state, "deleted");
    assert.equal(fixture.store.rows.benefits.get(retainedBenefit.id)?.content, null);
    pass(`benefit_delete_${method}_cancel_commit_focus_reentry_no_write_and_fresh_positive_delete`);
  }

  report.stage = "create_optional_labels";
  await closePage(page); await whenIdle(); await emptyServiceFixture(); page = await newPage();
  await page.setViewportSize({ width: 320, height: 740 }); await open(page);
  const createPlanInput = page.getByLabel("요금제 이름 (선택)", { exact: true });
  const createAccountInput = page.getByLabel("계정 표시 이름 (선택)", { exact: true });
  for (const input of [createPlanInput, createAccountInput]) {
    await expect(input).toHaveValue(""); await expect(input).toHaveAttribute("maxlength", "160");
    await expect(input).toHaveAttribute("autocomplete", "off"); await expect(input).toHaveAttribute("spellcheck", "false");
    await expect(input).toBeEnabled(); const hint = await input.getAttribute("aria-describedby"); assert.ok(hint);
    await expect(page.locator(`[id="${hint}"]`)).toContainText("실제 개인정보·비밀번호·API 키는 입력하지 마세요");
  }
  await page.getByLabel("서비스 이름", { exact: true }).fill("새 합성 서비스");
  const invalidCreateBaseline = { mutations: catalogMutationWire.length, catalog: catalogWire.length, rows: fixture.store.snapshot() };
  for (const [input, value] of [[createPlanInput, "  "], [createAccountInput, " 뒤 공백 "]] as const) {
    await createPlanInput.fill(""); await createAccountInput.fill(""); await input.fill(value);
    await click(page, "등록 내용 미리보기"); await expect(createPanel(page)).toHaveAttribute("data-phase", "editing");
    await expect(page.getByTestId("catalog-service-create-status")).toContainText("앞뒤 공백·금지 문자는 허용하지 않습니다");
    await expect(input).toHaveValue(value); await expect(page.getByTestId("catalog-service-create-preview")).toHaveCount(0);
  }
  assert.deepEqual({ mutations: catalogMutationWire.length, catalog: catalogWire.length, rows: fixture.store.snapshot() }, invalidCreateBaseline);
  pass("create_optional_label_input_contract_and_invalid_whitespace_no_preview_or_write");

  const createdLabels = { planName: "😀".repeat(80), accountLabel: "합성 <b>표시</b> e\u0301" };
  await createPlanInput.fill(createdLabels.planName); await createAccountInput.fill(createdLabels.accountLabel);
  await createAccountInput.focus(); await page.keyboard.press("Tab");
  for (const field of ["timezone", "subscription-status", "trial-ends-at"]) {
    await expect(page.getByTestId(`catalog-service-create-${field}`)).toBeFocused(); await page.keyboard.press("Tab");
  }
  await expect(page.getByTestId("catalog-service-create-notes")).toBeFocused(); await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "등록 내용 미리보기", exact: true })).toBeFocused();
  await page.keyboard.press("Enter"); await expect(createPanel(page)).toHaveAttribute("data-phase", "preview");
  await expect(page.getByTestId("catalog-service-create-preview")).toContainText(createdLabels.planName);
  await expect(page.getByTestId("catalog-service-create-preview")).toContainText(createdLabels.accountLabel);
  await expect(page.getByTestId("catalog-service-create-preview").locator("b,script,img")).toHaveCount(0);
  assert.equal(await createPanel(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
  const beforeCreateLabelsAck = catalogMutationWire.length;
  expectedCreate503 = true; failNextCreatedAcknowledgement = true; await saveCreate(page, "uncertain");
  const originalCreatedLabelRows = fixture.store.snapshot();
  assert.equal(fixture.store.rows.services.size, 1);
  const createdLabelId = [...fixture.store.rows.services.keys()][0]!;
  const labelCreated = await observedService(createdLabelId);
  assert.equal(labelCreated.serviceRevision, 1);
  assert.deepEqual(labelCreated.profile, { name: "새 합성 서비스", provider: null, ...createdLabels,
    timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null });
  await expect(createPlanInput).toHaveCount(0); await expect(createAccountInput).toHaveCount(0);
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await expect(createPanel(page)).toHaveAttribute("data-phase", "uncertain");
  await click(page, "같은 서비스 등록 요청의 결과 다시 확인"); await expect(createPanel(page)).toHaveAttribute("data-phase", "completed");
  await whenIdle(); assert.deepEqual(fixture.store.snapshot(), originalCreatedLabelRows);
  assert.deepEqual(catalogMutationWire.slice(beforeCreateLabelsAck).map(({ action, status }) => ({ action, status })),
    [{ action: "create", status: 503 }, { action: "create", status: 200 }]);
  assert.equal(catalogMutationWire.at(-1)?.digest, catalogMutationWire[beforeCreateLabelsAck]?.digest);
  assert.equal(catalogMutationWire.at(-1)?.replayed, true);
  pass("create_optional_labels_utf16_boundary_literal_keyboard_mobile_and_exact_ack_replay_no_duplicate_or_inferred_facts");

  await click(page, "새 서비스 등록 준비");
  for (const label of ["서비스 이름", "제공자 (선택)", "요금제 이름 (선택)", "계정 표시 이름 (선택)", "서비스 메모 (선택)"]) {
    await expect(page.getByLabel(label, { exact: true })).toHaveValue("");
  }
  await previewCreate(page, "선택 항목 없는 합성 서비스"); await saveCreate(page);
  const emptyLabelsId = [...fixture.store.rows.services.keys()].find((id) => id !== createdLabelId)!; assert.ok(emptyLabelsId);
  assert.deepEqual((await observedService(emptyLabelsId)).profile, { name: "선택 항목 없는 합성 서비스", provider: null,
    planName: null, accountLabel: null, timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null });
  pass("fresh_create_clears_labels_and_notes_and_empty_optional_values_remain_unknown_null");

  report.stage = "service_notes_input_contract";
  await closePage(page); await whenIdle(); await freshFixture(86400000, false); page = await newPage(); await open(page);
  await page.setViewportSize({ width: 360, height: 780 });
  const createNotes = page.getByTestId("catalog-service-create-notes");
  await expect(createNotes).toHaveAccessibleName("서비스 메모 (선택)");
  await expect(createNotes).toHaveAttribute("maxlength", "2048"); await expect(createNotes).toHaveAttribute("rows", "4");
  await expect(createNotes).toHaveAttribute("autocomplete", "off"); await expect(createNotes).toHaveAttribute("spellcheck", "false");
  await page.getByLabel("서비스 이름", { exact: true }).fill("메모를 가진 합성 서비스");
  const noteWritesBefore = catalogMutationWire.length;
  const setRawNote = async (field: ReturnType<Page["getByTestId"]>, value: string) => {
    await field.evaluate((element, raw) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, raw);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  };
  for (const invalid of [" ", " leading", "trailing ", "last\n", "internal\ttab", "x\u202ey", "x".repeat(2049)]) {
    await setRawNote(createNotes, invalid); await click(page, "등록 내용 미리보기");
    await expect(createPanel(page)).toHaveAttribute("data-phase", "editing");
    await expect(createNotes).toHaveValue(invalid); await expect(page.getByTestId("catalog-service-create-preview")).toHaveCount(0);
    assert.equal(catalogMutationWire.length, noteWritesBefore);
  }
  pass("service_create_notes_invalid_whitespace_control_and_2049_units_preserved_without_preview_or_write");

  report.stage = "service_notes_create_literal_cancel_and_ack";
  const notesPrefix = "SYNTHETIC notes  with spaces\n<img src=x onerror=alert(1)>\n";
  const noteBudget = 2048 - notesPrefix.length;
  const createNoteText = notesPrefix + "\u{1f331}".repeat(Math.floor(noteBudget / 2)) + "x".repeat(noteBudget % 2);
  assert.equal(createNoteText.length, 2048);
  await createNotes.fill(createNoteText); await click(page, "등록 내용 미리보기");
  await expect(createPanel(page)).toHaveAttribute("data-phase", "preview");
  const createNotePreview = page.getByTestId("catalog-service-create-preview");
  assert.ok((await createNotePreview.locator("dd").allTextContents()).includes(createNoteText));
  assert.equal(await createNotePreview.locator("dd").evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).whiteSpace === "pre-wrap")), true);
  assert.equal(await createNotePreview.locator("img,script,textarea").count(), 0);
  await createNotePreview.getByRole("button", { name: "미리보기 취소", exact: true }).focus(); await page.keyboard.press("Escape");
  await expect(page.getByTestId("catalog-service-create-status")).toBeFocused();
  await expect(createNotes).toHaveValue(createNoteText); assert.equal(catalogMutationWire.length, noteWritesBefore);
  await click(page, "등록 내용 미리보기");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const create503BeforeNotes = matchedCreate503;
  expectedCreate503 = true; failNextCreatedAcknowledgement = true; await saveCreate(page, "uncertain");
  await expect(createNotes).toHaveCount(0);
  const noteServiceId = [...fixture.store.rows.services.keys()][0]!; assert.ok(noteServiceId);
  const noteCreated = await observedService(noteServiceId); assert.equal(noteCreated.profile?.notes, createNoteText);
  assert.deepEqual(noteCreated.profile, { name: "메모를 가진 합성 서비스", provider: null, planName: null,
    accountLabel: null, timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: createNoteText });
  const notesCreatedRows = fixture.store.snapshot();
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await click(page, "같은 서비스 등록 요청의 결과 다시 확인"); await expect(createPanel(page)).toHaveAttribute("data-phase", "completed");
  await whenIdle(); assert.deepEqual(fixture.store.snapshot(), notesCreatedRows);
  assert.equal(catalogMutationWire.at(-1)?.digest, catalogMutationWire[noteWritesBefore]?.digest);
  assert.equal(catalogMutationWire.at(-1)?.replayed, true); assert.equal(matchedCreate503, create503BeforeNotes + 1);
  assert.deepEqual(catalogMutationWire.slice(noteWritesBefore).map(({ action, status }) => ({ action, status })),
    [{ action: "create", status: 503 }, { action: "create", status: 200 }]);
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await page.locator(`[data-testid="catalog-service-detail-toggle"][data-service-id="${noteServiceId}"]`).click();
  assert.equal(await page.getByTestId("catalog-service-detail-value-notes").textContent(), createNoteText);
  await page.getByTestId("catalog-service-detail-disclosure").getByRole("button", { name: "상세 닫기", exact: true }).click();
  pass("service_create_notes_2048_units_literal_multiline_mobile_cancel_same_command_retry_and_explicit_readback");

  report.stage = "service_notes_update_existing_value_and_invalid";
  // Seed non-default values through the actual test-only catalog domain before
  // the user's explicit refresh. A notes-only edit must not reset these facts.
  assert.ok((await createServiceCatalog(fixture.store.catalogDependencies).update({ serviceId: noteServiceId,
    expectedRevision: noteCreated.serviceRevision, operationId: "synthetic-notes-nondefault-fixture", decision: "update",
    profile: { ...noteCreated.profile!, provider: "Synthetic notes provider", planName: "Synthetic notes plan",
      accountLabel: "Synthetic notes account", timezone: "Asia/Seoul", subscriptionStatus: "trial",
      trialEndsAt: "2028-02-29T12:34:56.123456789+09:00" } })).ok);
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await page.getByLabel("수정할 서비스", { exact: true }).selectOption(noteServiceId);
  const updateNotes = page.getByTestId("catalog-service-update-notes");
  await expect(updateNotes).toHaveAccessibleName("수정할 서비스 메모 (선택)");
  await expect(updateNotes).toHaveValue(createNoteText); await expect(updateNotes).toHaveAttribute("maxlength", "2048");
  const updateNoteWrites = catalogMutationWire.length, beforeNoteUpdate = await observedService(noteServiceId);
  for (const invalid of [" leading", "trailing ", "first\n", "x\ty", "x".repeat(2049)]) {
    await setRawNote(updateNotes, invalid); await click(page, "수정 내용 미리보기");
    await expect(updatePanel(page)).toHaveAttribute("data-phase", "editing"); await expect(updateNotes).toHaveValue(invalid);
    await expect(page.getByTestId("catalog-service-update-preview")).toHaveCount(0);
    assert.equal(catalogMutationWire.length, updateNoteWrites);
  }
  pass("service_update_notes_prefills_exact_original_rejects_invalid_without_silent_trim_or_write");

  report.stage = "service_notes_update_literal_cancel_and_ack";
  const updatedNoteText = "SYNTHETIC  revised note\n<script>not executed</script>\n끝 \u{1f331}";
  await updateNotes.fill(""); await updateNotes.focus(); await page.keyboard.insertText(updatedNoteText);
  await click(page, "수정 내용 미리보기"); await expect(updatePanel(page)).toHaveAttribute("data-phase", "preview");
  const updateNotePreview = page.getByTestId("catalog-service-update-preview");
  const notePreviewValues = await updateNotePreview.locator("dd").allTextContents();
  assert.ok(notePreviewValues.includes(`수정 전: ${createNoteText}`)); assert.ok(notePreviewValues.includes(`수정 후: ${updatedNoteText}`));
  assert.equal(await updateNotePreview.locator("dd").evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).whiteSpace === "pre-wrap")), true);
  assert.equal(await updateNotePreview.locator("img,script,textarea").count(), 0);
  await updateNotePreview.getByRole("button", { name: "수정 미리보기 취소", exact: true }).focus(); await page.keyboard.press("Escape");
  await expect(page.getByTestId("catalog-service-update-status")).toBeFocused();
  await expect(updateNotes).toHaveValue(updatedNoteText); assert.equal(catalogMutationWire.length, updateNoteWrites);
  await click(page, "수정 내용 미리보기");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const update503BeforeNotes = matchedUpdate503;
  expectedUpdate503 = true; failNextUpdatedAcknowledgement = true; await saveUpdate(page, "uncertain");
  await expect(updateNotes).toHaveCount(0);
  const notesUpdatedRows = fixture.store.snapshot(), noteUpdated = await observedService(noteServiceId);
  assert.deepEqual(noteUpdated.profile, { ...beforeNoteUpdate.profile, notes: updatedNoteText });
  assert.equal(noteUpdated.serviceRevision, beforeNoteUpdate.serviceRevision + 1);
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await click(page, "같은 서비스 수정 요청의 결과 다시 확인"); await expect(updatePanel(page)).toHaveAttribute("data-phase", "completed");
  await whenIdle(); assert.deepEqual(fixture.store.snapshot(), notesUpdatedRows);
  assert.equal(catalogMutationWire.at(-1)?.digest, catalogMutationWire[updateNoteWrites]?.digest);
  assert.equal(catalogMutationWire.at(-1)?.replayed, true); assert.equal(matchedUpdate503, update503BeforeNotes + 1);
  assert.deepEqual(catalogMutationWire.slice(updateNoteWrites).map(({ action, status }) => ({ action, status })),
    [{ action: "update", status: 503 }, { action: "update", status: 200 }]);
  pass("service_update_notes_literal_before_after_cancel_mobile_original_ack_retry_preserves_other_seven_fields");

  report.stage = "service_notes_clear_null_and_new_create_reset";
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await click(page, "다른 서비스 수정 준비"); await page.getByLabel("수정할 서비스", { exact: true }).selectOption(noteServiceId);
  await expect(updateNotes).toHaveValue(updatedNoteText); await updateNotes.fill("");
  await click(page, "수정 내용 미리보기"); await saveUpdate(page);
  const clearedNotes = await observedService(noteServiceId);
  assert.deepEqual(clearedNotes.profile, { ...noteUpdated.profile, notes: null });
  assert.equal(clearedNotes.serviceRevision, noteUpdated.serviceRevision + 1);
  await click(page, "새 서비스 등록 준비"); await expect(createNotes).toHaveValue("");
  await createNotes.fill("SYNTHETIC unsent local note");
  const writesBeforeNoteClose = catalogMutationWire.length;
  await click(page, "Close"); await closed(page); await expect(createNotes).toHaveCount(0); await expect(updateNotes).toHaveCount(0);
  await click(page, "Open"); await expect(createNotes).toHaveValue("");
  assert.equal(catalogMutationWire.length, writesBeforeNoteClose);
  pass("service_notes_exact_empty_is_null_fresh_create_and_new_scope_do_not_restore_old_notes");

  report.stage = "service_notes_native_history_retirement";
  // Isolate native history from intentional create/update 503 console history.
  // Restoring that earlier document can replay its resource errors without a
  // new request. Keep every unexpected-console event fatal, not allowlisted.
  // Inspect this document's session storage before closing it; a new page would
  // otherwise lose evidence of a mistakenly persisted note in the previous one.
  await browserPrivacy(page);
  await closePage(page); await whenIdle(); await emptyServiceFixture(); page = await newPage(); await open(page);
  const nativeDraftNotes = page.getByTestId("catalog-service-create-notes");
  await nativeDraftNotes.fill("SYNTHETIC unsent note before native history");
  const notesHistoryWrites = catalogMutationWire.length;
  const notesHistoryMarker = await observeLifecycle(page), notesHistoryReads = nativeApiRequestStarts;
  await page.getByRole("link", { name: "Leave document", exact: true }).click();
  await expect(page).toHaveURL(origin + "/__candidate_away.html");
  await page.goBack({ waitUntil: "commit" }); await closed(page);
  await expect(nativeDraftNotes).toHaveCount(0); await expect(page.getByTestId("catalog-service-details-content")).toHaveCount(0);
  await recordLifecycle(page, notesHistoryMarker, "serviceNotesLifecycle");
  assert.equal(nativeApiRequestStarts, notesHistoryReads); assert.equal(catalogMutationWire.length, notesHistoryWrites);
  pass("service_notes_native_bfcache_retires_unsent_text_and_keeps_composition_closed_without_automatic_http");

  report.stage = "manual_service_facts_inputs_and_invalid";
  await browserPrivacy(page); await closePage(page); await whenIdle(); await emptyServiceFixture(); page = await newPage(); await open(page);
  await page.setViewportSize({ width: 360, height: 780 });
  const manual = (action: "create" | "update", key: string) => page.getByTestId(`catalog-service-${action}-${key}`);
  const setRawInput = async (field: ReturnType<typeof manual>, value: string) => {
    await field.evaluate((element, raw) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, raw);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  };
  for (const [key, length] of [["timezone", "64"], ["trial-ends-at", "40"]] as const) {
    await expect(manual("create", key)).toHaveAttribute("type", "text");
    await expect(manual("create", key)).toHaveAttribute("maxlength", length);
    await expect(manual("create", key)).toHaveAttribute("autocomplete", "off");
    await expect(manual("create", key)).toHaveAttribute("spellcheck", "false");
    await expect(manual("create", key)).toHaveValue("");
    const described = await manual("create", key).getAttribute("aria-describedby"); assert.ok(described);
  }
  await expect(manual("create", "subscription-status")).toHaveValue("unknown");
  const allowedStatuses = ["active", "trial", "trial_ended", "paused", "cancelled", "unknown"];
  assert.deepEqual(await manual("create", "subscription-status").locator("option").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLOptionElement).value).sort()), [...allowedStatuses].sort());
  await page.getByLabel("서비스 이름", { exact: true }).fill("합성 수동 기록 서비스");
  await page.getByLabel("제공자 (선택)", { exact: true }).fill("Synthetic manual provider");
  await page.getByLabel("요금제 이름 (선택)", { exact: true }).fill("Synthetic manual plan");
  await page.getByLabel("계정 표시 이름 (선택)", { exact: true }).fill("Synthetic manual account");
  await manual("create", "notes").fill("SYNTHETIC manual facts\nkeep  spaces");
  const manualWritesBefore = catalogMutationWire.length, manualReadsBefore = nativeApiRequestStarts;
  for (const [key, invalid] of [["timezone", " Mars/Synthetic"], ["timezone", "Mars/Synthetic"], ["timezone", "x".repeat(65)],
    ["trial-ends-at", "2027-02-29"], ["trial-ends-at", "2028-02-29T12:34:56"], ["trial-ends-at", "2028-02-29T12:34:56-00:00"],
    ["trial-ends-at", "2028-02-29T12:34:56+14:01"], ["trial-ends-at", " 2028-02-29"], ["trial-ends-at", "x".repeat(41)]] as const) {
    await manual("create", "timezone").fill(""); await manual("create", "trial-ends-at").fill("");
    await setRawInput(manual("create", key), invalid); await click(page, "등록 내용 미리보기");
    await expect(createPanel(page)).toHaveAttribute("data-phase", "editing");
    await expect(manual("create", key)).toHaveValue(invalid);
    await expect(page.getByTestId("catalog-service-create-preview")).toHaveCount(0);
    assert.equal(catalogMutationWire.length, manualWritesBefore); assert.equal(nativeApiRequestStarts, manualReadsBefore);
  }
  pass("manual_fact_text_inputs_and_invalid_zone_date_offset_lengths_preserve_raw_value_without_io");

  report.stage = "manual_service_facts_create_literal_and_retry";
  await manual("create", "timezone").fill("Asia/Seoul"); await manual("create", "trial-ends-at").fill("2028-02-29");
  for (const state of allowedStatuses) {
    await manual("create", "subscription-status").selectOption(state);
    await expect(manual("create", "subscription-status")).toHaveValue(state);
    await expect(manual("create", "trial-ends-at")).toHaveValue("2028-02-29");
    await expect(manual("create", "timezone")).toHaveValue("Asia/Seoul");
  }
  await manual("create", "subscription-status").selectOption("trial");
  const manualCreateProfile = { name: "합성 수동 기록 서비스", provider: "Synthetic manual provider", planName: "Synthetic manual plan", accountLabel: "Synthetic manual account",
    timezone: "Asia/Seoul", subscriptionStatus: "trial", trialEndsAt: "2028-02-29", notes: "SYNTHETIC manual facts\nkeep  spaces" };
  await click(page, "등록 내용 미리보기"); await expect(createPanel(page)).toHaveAttribute("data-phase", "preview");
  const manualPreview = page.getByTestId("catalog-service-create-preview");
  for (const literal of ["Asia/Seoul", "trial", "2028-02-29"]) assert.ok((await manualPreview.locator("dd").allTextContents()).includes(literal));
  assert.equal(await createPanel(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
  assert.equal(nativeApiRequestStarts, manualReadsBefore); assert.equal(catalogMutationWire.length, manualWritesBefore);
  expectedCreate503 = true; failNextCreatedAcknowledgement = true; await saveCreate(page, "uncertain");
  for (const key of ["timezone", "subscription-status", "trial-ends-at"]) await expect(manual("create", key)).toHaveCount(0);
  const manualId = [...fixture.store.rows.services.keys()][0]!; assert.ok(manualId);
  const manualCreated = await observedService(manualId); assert.deepEqual(manualCreated.profile, manualCreateProfile);
  assert.equal(manualCreated.serviceRevision, 1);
  const manualCreateRows = fixture.store.snapshot();
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await click(page, "같은 서비스 등록 요청의 결과 다시 확인"); await expect(createPanel(page)).toHaveAttribute("data-phase", "completed");
  await whenIdle(); assert.deepEqual(fixture.store.snapshot(), manualCreateRows);
  assert.deepEqual(catalogMutationWire.slice(manualWritesBefore).map(({ action, status }) => ({ action, status })),
    [{ action: "create", status: 503 }, { action: "create", status: 200 }]);
  assert.equal(catalogMutationWire.at(-1)?.digest, catalogMutationWire[manualWritesBefore]?.digest); assert.equal(catalogMutationWire.at(-1)?.replayed, true);
  pass("manual_create_six_status_choices_no_inference_date_only_exact_roundtrip_mobile_and_original_ack_retry");

  report.stage = "manual_service_facts_update_precision_cancel_retry";
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await page.getByLabel("수정할 서비스", { exact: true }).selectOption(manualId);
  await expect(manual("update", "timezone")).toHaveValue("Asia/Seoul");
  await expect(manual("update", "subscription-status")).toHaveValue("trial");
  await expect(manual("update", "trial-ends-at")).toHaveValue("2028-02-29");
  const manualUpdateBefore = catalogMutationWire.length, manualUpdateReadsBefore = nativeApiRequestStarts;
  for (const [key, invalid] of [["timezone", " UTC"], ["trial-ends-at", "2028-02-29T12:34:56"], ["trial-ends-at", "2028-02-30"]] as const) {
    await manual("update", "timezone").fill("Asia/Seoul"); await manual("update", "trial-ends-at").fill("2028-02-29");
    await setRawInput(manual("update", key), invalid); await click(page, "수정 내용 미리보기");
    await expect(updatePanel(page)).toHaveAttribute("data-phase", "editing"); await expect(manual("update", key)).toHaveValue(invalid);
    await expect(page.getByTestId("catalog-service-update-preview")).toHaveCount(0); assert.equal(catalogMutationWire.length, manualUpdateBefore);
  }
  const manualChanged = { ...manualCreateProfile, timezone: "UTC", subscriptionStatus: "active", trialEndsAt: "2000-02-29T12:34:56.123456789+09:00" };
  await manual("update", "timezone").fill(manualChanged.timezone);
  await manual("update", "subscription-status").selectOption(manualChanged.subscriptionStatus);
  await manual("update", "trial-ends-at").fill(manualChanged.trialEndsAt);
  await click(page, "수정 내용 미리보기"); await expect(updatePanel(page)).toHaveAttribute("data-phase", "preview");
  const manualUpdatePreview = page.getByTestId("catalog-service-update-preview");
  const manualDd = await manualUpdatePreview.locator("dd").allTextContents();
  for (const literal of ["UTC", "active", manualChanged.trialEndsAt]) assert.ok(manualDd.includes(`수정 후: ${literal}`));
  await manualUpdatePreview.getByRole("button", { name: "수정 미리보기 취소", exact: true }).focus(); await page.keyboard.press("Escape");
  await expect(page.getByTestId("catalog-service-update-status")).toBeFocused();
  await expect(manual("update", "trial-ends-at")).toHaveValue(manualChanged.trialEndsAt); assert.equal(catalogMutationWire.length, manualUpdateBefore);
  await click(page, "수정 내용 미리보기");
  assert.equal(nativeApiRequestStarts, manualUpdateReadsBefore); assert.equal(catalogMutationWire.length, manualUpdateBefore);
  expectedUpdate503 = true; failNextUpdatedAcknowledgement = true; await saveUpdate(page, "uncertain");
  const manualUpdated = await observedService(manualId), manualUpdatedRows = fixture.store.snapshot();
  assert.deepEqual(manualUpdated.profile, manualChanged); assert.equal(manualUpdated.serviceRevision, 2);
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await click(page, "같은 서비스 수정 요청의 결과 다시 확인"); await expect(updatePanel(page)).toHaveAttribute("data-phase", "completed");
  await whenIdle(); assert.deepEqual(fixture.store.snapshot(), manualUpdatedRows);
  assert.deepEqual(catalogMutationWire.slice(manualUpdateBefore).map(({ action, status }) => ({ action, status })),
    [{ action: "update", status: 503 }, { action: "update", status: 200 }]);
  assert.equal(catalogMutationWire.at(-1)?.digest, catalogMutationWire[manualUpdateBefore]?.digest); assert.equal(catalogMutationWire.at(-1)?.replayed, true);
  pass("manual_update_prefill_validation_exact_offset_nine_fraction_past_date_without_inferred_status_cancel_and_retry");

  report.stage = "manual_service_facts_clear_and_reset";
  await click(page, "서비스 목록 처음부터 다시 확인"); await nextCatalog(page);
  await click(page, "다른 서비스 수정 준비"); await page.getByLabel("수정할 서비스", { exact: true }).selectOption(manualId);
  await expect(manual("update", "timezone")).toHaveValue(manualChanged.timezone);
  await expect(manual("update", "subscription-status")).toHaveValue(manualChanged.subscriptionStatus);
  await expect(manual("update", "trial-ends-at")).toHaveValue(manualChanged.trialEndsAt);
  await manual("update", "timezone").fill(""); await manual("update", "trial-ends-at").fill("");
  await manual("update", "subscription-status").selectOption("unknown"); await click(page, "수정 내용 미리보기"); await saveUpdate(page);
  const manualCleared = await observedService(manualId);
  assert.deepEqual(manualCleared.profile, { ...manualChanged, timezone: null, subscriptionStatus: "unknown", trialEndsAt: null });
  assert.equal(manualCleared.serviceRevision, 3);
  await click(page, "새 서비스 등록 준비");
  await expect(manual("create", "timezone")).toHaveValue(""); await expect(manual("create", "trial-ends-at")).toHaveValue("");
  await expect(manual("create", "subscription-status")).toHaveValue("unknown"); await expect(manual("create", "notes")).toHaveValue("");
  await browserPrivacy(page);
  pass("manual_facts_exact_empty_null_unknown_enum_preserves_other_fields_new_create_reset_and_page_storage_empty");

  report.stage = "manual_service_facts_native_unsent_close";
  await closePage(page); await whenIdle(); await emptyServiceFixture(); page = await newPage(); await open(page);
  await manual("create", "timezone").fill("Asia/Seoul"); await manual("create", "subscription-status").selectOption("trial_ended");
  await manual("create", "trial-ends-at").fill("2000-02-29T12:34:56Z"); await manual("create", "notes").fill("SYNTHETIC unsent manual fact");
  const manualHistoryWrites = catalogMutationWire.length, manualHistoryReads = nativeApiRequestStarts, manualMarker = await observeLifecycle(page);
  await browserPrivacy(page); await page.getByRole("link", { name: "Leave document", exact: true }).click();
  await expect(page).toHaveURL(origin + "/__candidate_away.html"); await page.goBack({ waitUntil: "commit" }); await closed(page);
  for (const key of ["timezone", "subscription-status", "trial-ends-at", "notes"]) await expect(manual("create", key)).toHaveCount(0);
  await recordLifecycle(page, manualMarker, "serviceManualFactsLifecycle");
  assert.equal(nativeApiRequestStarts, manualHistoryReads); assert.equal(catalogMutationWire.length, manualHistoryWrites);
  pass("manual_fact_unsent_draft_native_bfcache_retirement_without_automatic_http_or_save");

  }
  report.stage = "discard_intent_and_stale_callbacks";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  const discardPanel = () => page.getByTestId("candidate-discard");
  const discardTarget = () => page.getByLabel("폐기할 후보 식별자", { exact: true });
  const prepareDiscard = async (index: number) => {
    await discardTarget().selectOption(fixture.batch.candidates[index]!.candidateId);
    await click(page, "후보 폐기 대상 확인"); await expect(discardPanel()).toHaveAttribute("data-phase", "prepared");
  };
  // Controlled retained-React-callback check, distinct from native user input.
  const retainClick = async (label: string) => page.getByRole("button", { name: label, exact: true }).evaluate((node) => {
    const key = Object.keys(node).find((item) => item.startsWith("__reactProps$"));
    if (!key) throw Error("CANDIDATE_REACT_CALLBACK_UNAVAILABLE");
    const callback = (node as unknown as Record<string, { onClick?: () => void }>)[key]?.onClick;
    if (typeof callback !== "function") throw Error("CANDIDATE_REACT_CALLBACK_UNAVAILABLE");
    (window as unknown as { discardOldClick: () => void }).discardOldClick = callback;
  });
  const invokeRetained = async () => page.evaluate(() => {
    const saved = window as unknown as { discardOldClick?: () => void }; const callback = saved.discardOldClick;
    delete saved.discardOldClick; callback?.();
  });
  const discardBefore = discardWire.length;
  await discardTarget().selectOption(fixture.batch.candidates[0]!.candidateId); await retainClick("후보 폐기 대상 확인");
  await discardTarget().selectOption(fixture.batch.candidates[1]!.candidateId); await invokeRetained();
  await expect(discardPanel()).toHaveAttribute("data-phase", "idle"); assert.equal(discardWire.length, discardBefore);
  await click(page, "후보 폐기 대상 확인"); await expect(discardPanel()).toHaveAttribute("data-phase", "prepared");
  await expect(page.getByTestId("candidate-discard-target")).toContainText(fixture.batch.candidates[1]!.candidateId);
  await page.getByLabel("폐기 확인 문구", { exact: true }).fill("폐기"); await retainClick("이 후보 내용 폐기");
  await page.getByLabel("폐기 확인 문구", { exact: true }).fill(""); await invokeRetained();
  await expect(discardPanel()).toHaveAttribute("data-phase", "prepared"); assert.equal(discardWire.length, discardBefore);
  await page.getByLabel("폐기 확인 문구", { exact: true }).focus(); await page.keyboard.press("Escape");
  await expect(discardPanel()).toHaveAttribute("data-phase", "idle"); await expect(page.getByTestId("candidate-discard-status")).toBeFocused();
  assert.equal(discardWire.length, discardBefore);
  await prepareDiscard(1); await reload(page); await expect(discardPanel()).toHaveAttribute("data-phase", "idle");
  assert.equal(discardWire.length, discardBefore);
  pass("discard_explicit_target_confirmation_escape_refresh_and_retained_callback_fences_no_implicit_http");

  report.stage = "discard_preserves_uncertain_confirm";
  await choose(page, 0, 0, "폐기와 별개로 보존할 합성 혜택"); await click(page, "미리보기 요청");
  await expect(page.getByTestId("review-panel-preview")).toHaveCount(1); await whenIdle();
  const confirmIndex = wire.length;
  fixture.store.controls.afterCommit = () => { delete fixture.store.controls.afterCommit; throw Error(SYNTHETIC_PRIVATE); };
  expected503 = true; await click(page, "이 내용으로 기록 저장");
  await expect(page.getByRole("button", { name: "같은 요청의 결과 다시 확인", exact: true })).toBeEnabled(); await whenIdle();
  const savedBenefits = structuredClone([...fixture.store.rows.benefits]);
  const acceptedCandidate = structuredClone(fixture.store.rows.candidates.get(fixture.batch.candidates[0]!.candidateId));
  await prepareDiscard(1); await page.getByLabel("폐기 확인 문구", { exact: true }).fill("폐기");
  holdNextDiscard = true; await click(page, "이 후보 내용 폐기");
  await expect.poll(() => releaseDiscard !== null).toBe(true);
  await expect(discardPanel()).toHaveAttribute("data-phase", "sending");
  await expect(page.getByTestId("candidate-discard-status")).toBeFocused();
  releaseHeldDiscard(); await expect(discardPanel()).toHaveAttribute("data-phase", "succeeded"); await whenIdle();
  await expect(page.getByTestId("candidate-loader")).toHaveAttribute("data-phase", "idle");
  await expect(page.getByRole("button", { name: "같은 요청의 결과 다시 확인", exact: true })).toBeEnabled();
  assert.deepEqual([...fixture.store.rows.benefits], savedBenefits);
  assert.deepEqual(fixture.store.rows.candidates.get(fixture.batch.candidates[0]!.candidateId), acceptedCandidate);
  assert.equal(fixture.store.rows.candidates.get(fixture.batch.candidates[1]!.candidateId)?.state, "deleted");
  await click(page, "같은 요청의 결과 다시 확인"); await expect(page.getByRole("group", { name: "결과 재확인", exact: true })).toHaveCount(0);
  await whenIdle(); assert.equal(wire.at(-1)?.digest, wire[confirmIndex]?.digest); assert.deepEqual([...fixture.store.rows.benefits], savedBenefits);
  pass("discard_held_request_keeps_focus_success_preserves_accepted_benefit_and_original_uncertain_confirm");

  report.stage = "discard_lost_ack_exact_reconcile";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  await prepareDiscard(1); await page.getByLabel("폐기 확인 문구", { exact: true }).fill("폐기");
  expectedDiscardStatus = 503;
  fixture.store.controls.afterCommit = () => { delete fixture.store.controls.afterCommit; throw Error(SYNTHETIC_PRIVATE); };
  await click(page, "이 후보 내용 폐기"); await expect(discardPanel()).toHaveAttribute("data-phase", "uncertain"); await whenIdle();
  const committedDiscard = fixture.store.snapshot(), firstDiscard = discardWire.at(-1)!;
  assert.equal(firstDiscard.status, 503); const beforeDiscardRefresh = discardWire.length;
  await receiveCompletion(page); await expect(discardPanel()).toHaveAttribute("data-phase", "uncertain");
  await reload(page); await expect(discardPanel()).toHaveAttribute("data-phase", "uncertain");
  await expect(page.getByTestId("candidate-discard-target")).toContainText(fixture.batch.candidates[1]!.candidateId);
  assert.equal(discardWire.length, beforeDiscardRefresh);
  await click(page, "같은 폐기 요청 결과 다시 확인"); await expect(discardPanel()).toHaveAttribute("data-phase", "succeeded"); await whenIdle();
  assert.equal(discardWire.at(-1)?.digest, firstDiscard.digest); assert.equal(discardWire.at(-1)?.status, 200);
  assert.deepEqual(fixture.store.snapshot(), committedDiscard);
  pass("discard_lost_ack_preserves_exact_original_request_across_receipt_and_batch_refresh_no_reanalysis_or_second_erasure");

  report.stage = "discard_postcommit_conflict_is_uncertain";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page);
  await prepareDiscard(0); await page.getByLabel("폐기 확인 문구", { exact: true }).fill("폐기");
  fixture.store.controls.afterCommit = () => {
    delete fixture.store.controls.afterCommit;
    const row = fixture.store.rows.batchReferences.get(fixture.locator.batchReference)!;
    fixture.store.rows.batchReferences.set(fixture.locator.batchReference, { ...row, state: "retired", revision: 2 });
  };
  expectedDiscardStatus = 409; await click(page, "이 후보 내용 폐기");
  await expect(discardPanel()).toHaveAttribute("data-phase", "uncertain"); await whenIdle();
  const retiredDiscard = discardWire.at(-1)!, retiredRows = fixture.store.snapshot();
  assert.equal(retiredDiscard.status, 409); assert.equal(fixture.store.rows.candidates.get(fixture.batch.candidates[0]!.candidateId)?.state, "deleted");
  expectedDiscardStatus = 404; await click(page, "같은 폐기 요청 결과 다시 확인");
  await expect(discardPanel()).toHaveAttribute("data-phase", "uncertain"); await whenIdle();
  assert.equal(discardWire.at(-1)?.status, 404); assert.equal(discardWire.at(-1)?.digest, retiredDiscard.digest);
  assert.deepEqual(fixture.store.snapshot(), retiredRows); await expect(discardTarget()).toBeDisabled();
  pass("discard_first_409_after_commit_and_replay_404_never_claim_no_commit_or_replace_original_request");

  report.stage = "discard_expired_content_and_authority";
  await closePage(page); await whenIdle(); await freshFixture(5000); page = await newPage(); await open(page);
  await expect.poll(() => Date.now(), { timeout: 7000 }).toBeGreaterThanOrEqual(fixture.batch.candidates[0]!.accessExpiresAt);
  await reload(page);
  assert.ok((await fixture.refresh()).candidates.every((entry) => entry.state === "expired" && entry.content === null));
  await prepareDiscard(1); await expect(discardPanel()).not.toContainText("Synthetic trial offer");
  await expect(discardPanel()).not.toContainText("Synthetic Service");
  await page.getByLabel("폐기 확인 문구", { exact: true }).fill("폐기"); await click(page, "이 후보 내용 폐기");
  await expect(discardPanel()).toHaveAttribute("data-phase", "succeeded"); await whenIdle();
  assert.equal(fixture.store.rows.candidates.get(fixture.batch.candidates[1]!.candidateId)?.state, "deleted");
  pass("discard_expired_pending_candidate_by_id_without_content_reexposure_or_access_renewal");
  await reload(page); await prepareDiscard(0); await page.getByLabel("폐기 확인 문구", { exact: true }).fill("폐기");
  const beforeDiscardAuthority = fixture.store.snapshot(); fixture.store.controls.authority = null; expectedDiscardStatus = 401;
  await click(page, "이 후보 내용 폐기"); await closed(page); await expect(discardPanel()).toHaveAttribute("data-phase", "closed"); await whenIdle();
  assert.deepEqual(fixture.store.snapshot(), beforeDiscardAuthority); await expect(page.getByTestId("candidate-discard-target")).toHaveCount(0);
  pass("discard_authority_rejection_closes_shared_workspace_without_erasure");

  report.stage = "discard_native_history";
  await closePage(page); await whenIdle(); await freshFixture(); page = await newPage(); await open(page); await prepareDiscard(0);
  await page.getByLabel("폐기 확인 문구", { exact: true }).fill("폐기");
  const discardMarker = await observeLifecycle(page), beforeDiscardHistory = nativeApiRequestStarts, discardHistoryWrites = discardWire.length;
  await page.getByRole("link", { name: "Leave document", exact: true }).click();
  await expect(page).toHaveURL(origin + "/__candidate_away.html"); await page.goBack({ waitUntil: "commit" }); await closed(page);
  await expect(discardPanel()).toHaveAttribute("data-phase", "closed"); await expect(page.getByTestId("candidate-discard-target")).toHaveCount(0);
  await recordLifecycle(page, discardMarker, "candidateDiscardLifecycle");
  assert.equal(nativeApiRequestStarts, beforeDiscardHistory); assert.equal(discardWire.length, discardHistoryWrites);
  pass("discard_prepared_confirmation_native_history_retires_without_automatic_request_or_reopen");
  }

  report.stage = "privacy_and_idle"; await whenIdle();
  assert.equal(expectedAbortArms.size, 0, "CANDIDATE_UNCONSUMED_ABORT_ARM");
  if (!bootstrapDiagnostic) await browserPrivacy(page);
  assert.deepEqual(errors, { bridge: 0, page: 0, console: 0, external: 0, websocket: 0, csp: 0, transport: 0 });
  assert.ok(wire.every((item) => item.status === 200 || item.status === 503));
  assert.equal(wire.filter((item) => item.status === 503).length, bootstrapDiagnostic ? 0 : discardOnly ? 1 : 4);
  assert.equal(expectedDiscardStatus, null);
  assert.ok(discardWire.every((item) => [200, 401, 404, 409, 503].includes(item.status)));
  assert.ok(reads.every((item) => [200, 408, 401, 403, 404].includes(item.status)));
  assert.ok(catalogWire.every((item) => [200, 408, 409, 401].includes(item.status)));
  assert.ok(catalogMutationWire.every((item) => [200, 503, 401, 408, 409].includes(item.status)));
  report.observations.http = { reviewRequests: wire.length, actualCatalogRequests: catalogWire.length, candidateReadRequests: reads.length,
    candidateDiscardRequests: discardWire.length, matchedDiscardStatuses, discardRequestDigests: discardWire,
    completionObservations: completions, completionAborts, matchedCompletionAborts,
    serviceCreateRequests: catalogMutationWire.filter((item) => item.action === "create").length,
    serviceUpdateRequests: catalogMutationWire.filter((item) => item.action === "update").length,
    serviceDeleteRequests: catalogMutationWire.filter((item) => item.action === "delete").length,
    expectedDelete503: matchedDelete503, expectedDelete409: matchedDelete409, expectedDelete401: matchedDelete401,
    expectedUpdate503: matchedUpdate503, expectedUpdate409: matchedUpdate409, expectedUpdate401: matchedUpdate401,
    expectedCreate503: matchedCreate503, expectedCreate401: matchedCreate401,
    matchedCreateAborts, createAbortEventsNotObserved: expectedCreateAborts.size,
    matchedUpdateAborts, updateAbortEventsNotObserved: expectedUpdateAborts.size,
    matchedDeleteAborts, deleteAbortEventsNotObserved: expectedDeleteAborts.size,
    mutationRequestDigests: catalogMutationWire.map(({ action, status, digest, replayed, state, responseWriteAttempted }) => ({ action, status, digest, replayed, state, responseWriteAttempted })),
    completionAbortEventsNotObserved: expectedCompletionAborts.size,
    observedExpectedReadAbortEvents: matchedReadAborts, expected401: matched401, expected403: matched403,
    expected404: matched404, expected503: matched503,
    expectedCatalog409: matchedCatalog409, expectedCatalog401: matchedCatalog401, observedExpectedCatalogAbortEvents: matchedCatalogAborts,
    maxRequestBytes: wire.length ? Math.max(...wire.map((item) => item.requestBytes)) : 0,
    maxResponseBytes: wire.length ? Math.max(...wire.map((item) => item.responseBytes)) : 0 };
  pass("bounded_minimal_responses_no_external_requests_unexpected_errors_or_browser_storage");
} catch (error) {
  report.observations.failureWireSummary = {
    catalog: catalogWire.slice(-4).map(({ status, code }) => ({ status, code })),
    candidates: reads.slice(-4).map(({ status, code }) => ({ status, code })),
    discard: discardWire.slice(-4).map(({ status }) => ({ status })),
  };
  failed = true; report.observations.failureClass = error instanceof Error ? error.name : "unknown";
  report.observations.failureCode = error instanceof Error ? /^CANDIDATE_[A-Z_]+/.exec(error.message)?.[0] ?? "UNCLASSIFIED" : "UNCLASSIFIED";
  report.observations.failureAction = error instanceof Error ? /^(?:locator|page)\.[A-Za-z]+/.exec(error.message)?.[0] ?? null : null;
  const ownLocation = error instanceof Error ? /verify-candidate-review-browser\.ts:(\d+):(\d+)/.exec(error.stack ?? "") : null;
  // Diagnostic location only: never print assertion actual/expected values,
  // response bodies, private payloads or the raw error/stack.
  report.observations.failureLocation = ownLocation ? { line: Number(ownLocation[1]), column: Number(ownLocation[2]) } : null;
} finally {
  report.observations.expectedAbortArming = { ...expectedAbortArmCounts, pending: expectedAbortArms.size };
  if (cleanupExperiment && context) {
    try { for (const openPage of context.pages()) if (!openPage.isClosed()) await recordCleanupExperiment(openPage); }
    catch { failed = true; report.observations.cleanupExperimentObservationFailed = true; }
    report.observations.cleanupExperimentDocuments = cleanupExperimentDocuments;
  }
  releaseHeldRead(); releaseHeldCatalog(); releaseHeldCompletion(); releaseHeldCreateReply(); releaseHeldPreviewReply(); releaseHeldGetReply();
  releaseHeldDiscard();
  if (fixture) delete fixture.store.controls.afterCommit;
  const cleanupErrors: string[] = [];
  nativeDiagnostics?.setPhase("CONTEXT_CLOSE");
  try { await bounded(context?.close() ?? Promise.resolve(), 5000); } catch { cleanupErrors.push("CONTEXT_CLOSE"); }
  nativeDiagnostics?.setPhase("BROWSER_CLOSE");
  try { await bounded(browser?.close() ?? Promise.resolve(), 15000); } catch { cleanupErrors.push("BROWSER_CLOSE"); }
  nativeDiagnostics?.setPhase("SERVER_CLOSE");
  try {
    const socketCloses = [...sockets].map((socket) => new Promise<void>((resolve) => socket.once("close", resolve)));
    for (const response of responses) response.destroy(); for (const socket of sockets) socket.destroy();
    await bounded(Promise.all([new Promise<void>((resolve, reject) => { if (!server.listening) { resolve(); return; }
      server.close((error) => error ? reject(error) : resolve()); }), ...socketCloses, whenIdle()]));
    assert.equal(server.listening, false); assert.equal(sockets.size, 0); assert.equal(active, 0); assert.equal(browser?.isConnected() ?? false, false);
  } catch { cleanupErrors.push("SERVER_SOCKET_CLOSE"); }
  const cleanup = cleanupErrors.length === 0; if (cleanup) pass("owned_context_browser_listener_socket_cleanup"); else failed = true;
  // A callback delivered while closing the owned browser must not leave a PASS
  // report with nonzero unexpected-error counters after the earlier assertion.
  if (Object.values(errors).some((count) => count !== 0)) failed = true;
  if (nativeDiagnostics) {
    for (const detach of nativeDiagnosticDetachers) {
      try { detach(); } catch { nativeDiagnostics.issue("OBSERVER_ERROR"); }
    }
    const observations = nativeDiagnostics.snapshot();
    report.observations.nativeNetworkDiagnostics = observations;
    if (observations.status === "INCOMPLETE") inconclusive = true;
  }
  report.status = failed ? "FAIL" : inconclusive ? "INCONCLUSIVE" : "PASS";
  report.observations.readSignals = readSignalCounts;
  console.log(JSON.stringify({ ...report, endedAt: new Date().toISOString(), errors, cleanup, cleanupErrors }, null, 2));
  process.exitCode = failed ? 1 : inconclusive ? 2 : 0;
}
