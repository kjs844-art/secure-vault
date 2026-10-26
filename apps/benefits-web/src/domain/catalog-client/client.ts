/**
 * Small browser catalog client. create/update/delete/get/list against exact
 * POST paths of the same trusted origin, with runtime response validation.
 * No real auth/operational integration: the running SSR app keeps every
 * /api/catalog route 503 INTEGRATION_NOT_CONNECTED.
 */
import { snapshotCatalogRequest, type CatalogRequest } from "./requests.ts";
import { catalogErrorStatus, decodeCatalogError, decodeCatalogSuccessForRequest,
  type CatalogHttpErrorCode, type CatalogSuccess } from "./responses.ts";

export { CATALOG_VIEW_SCHEMA } from "./responses.ts";
export type {
  CatalogSuccess, CatalogReceiptView, CatalogServiceView, CatalogPageView, CatalogCursorView,
  CatalogServiceProfileView, CatalogSubscriptionStatus, CatalogHttpErrorCode,
} from "./responses.ts";
export type {
  CatalogRequest, CatalogCreateRequest, CatalogUpdateRequest, CatalogDeleteRequest,
  CatalogGetRequest, CatalogListRequest, CatalogServiceProfileInput,
} from "./requests.ts";
export { createCatalogCreateRequest, createCatalogUpdateRequest, createCatalogDeleteRequest,
  createCatalogGetRequest, createCatalogListRequest } from "./requests.ts";

export const CATALOG_REQUEST_HEADER = "catalog-v1" as const;
export const MAX_CATALOG_RESPONSE_BODY_BYTES = 1048576;
export const DEFAULT_CATALOG_TIMEOUT_MS = 10000;

export interface CatalogTransport {
  (request: Request, signal: AbortSignal): Promise<Response>;
}
export interface CatalogViewContext {
  /** Fresh opaque namespace on every account/session/view reset. Never reuse. */
  readonly viewScope: string;
  readonly dataGeneration: number;
}
export interface CatalogClientConfig {
  /** Exact trusted origin, e.g. the page's own origin. Operator/UI supplied. */
  readonly origin: string;
  readonly fetch: CatalogTransport;
  /** Local display fence only, NOT server authentication. Null while signed out. */
  readonly readViewContext: () => CatalogViewContext | null;
  /** Positive integer milliseconds, <= DEFAULT_CATALOG_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}
export type CatalogCallFailure =
  | { readonly kind: "error"; readonly code: CatalogHttpErrorCode; readonly retriableAfterMs: number | null }
  | { readonly kind: "invalid"; readonly reason: "REQUEST" | "STATUS" | "BODY" | "ENVELOPE" | "HEADERS" }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" }
  | { readonly kind: "stale" };
export type CatalogCallResult = CatalogCallSuccess | CatalogCallFailure;
export interface CatalogCallSuccess {
  readonly kind: "success";
  /** Keep this original context when applying later; never relabel at delivery. */
  readonly capturedScope: CatalogViewContext;
  readonly success: CatalogSuccess;
}

function invalidConfiguration(): never { throw new Error("CATALOG_CLIENT_CONFIG_INVALID"); }
function configure(config: CatalogClientConfig) {
  let url: URL;
  try { url = new URL(config.origin); } catch { invalidConfiguration(); }
  if (url.origin !== config.origin || url.username || url.password || url.pathname !== "/"
    || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) invalidConfiguration();
  const timeoutMs = config.timeoutMs === undefined ? DEFAULT_CATALOG_TIMEOUT_MS : config.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_CATALOG_TIMEOUT_MS) invalidConfiguration();
  if (typeof config.fetch !== "function" || typeof config.readViewContext !== "function") invalidConfiguration();
  return Object.freeze({ origin: url.origin, timeoutMs, fetch: config.fetch, readViewContext: config.readViewContext });
}

function viewContext(read: CatalogClientConfig["readViewContext"]): CatalogViewContext | null {
  try {
    const value: unknown = read();
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("viewScope") || !keys.includes("dataGeneration")) return null;
    const scope = Object.getOwnPropertyDescriptor(value, "viewScope");
    const generation = Object.getOwnPropertyDescriptor(value, "dataGeneration");
    if (!scope || !("value" in scope) || !scope.enumerable
      || !generation || !("value" in generation) || !generation.enumerable
      || typeof scope.value !== "string" || scope.value.trim() !== scope.value
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope.value)
      || !Number.isSafeInteger(generation.value) || generation.value < 1) return null;
    return Object.freeze({ viewScope: scope.value as string, dataGeneration: generation.value as number });
  } catch { return null; }
}
function sameContext(captured: CatalogViewContext, current: CatalogViewContext | null): boolean {
  return current !== null && current.viewScope === captured.viewScope
    && current.dataGeneration === captured.dataGeneration;
}

const TIMEOUT = Symbol("catalog-timeout");
const ABORTED = Symbol("catalog-aborted");
const STALE = Symbol("catalog-stale");
const INVALID_BODY = Symbol("catalog-invalid-body");

function createLifetime(timeoutMs: number, callerSignal?: AbortSignal) {
  // Brand-check before allocating resources, without invoking instance getters.
  const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
  const initiallyAborted = callerSignal !== undefined && abortedGetter.call(callerSignal) as boolean;
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let failure: typeof TIMEOUT | typeof ABORTED | undefined;
  function stop(reason: typeof TIMEOUT | typeof ABORTED) {
    if (failure !== undefined) return;
    failure = reason;
    controller.abort();
  }
  function check() {
    if (performance.now() >= deadline) stop(TIMEOUT);
    if (failure !== undefined) throw failure;
  }
  const onAbort = () => stop(performance.now() >= deadline ? TIMEOUT : ABORTED);
  if (callerSignal !== undefined) EventTarget.prototype.addEventListener.call(callerSignal, "abort", onAbort, { once: true });
  const timer = setTimeout(() => stop(TIMEOUT), timeoutMs);
  if (initiallyAborted) onAbort();
  return {
    signal: controller.signal,
    check,
    // Each wait owns one abort listener and removes it when settled. A single
    // shared pending Promise.race operand would retain handlers for every chunk.
    async wait<T>(pending: Promise<T>): Promise<T> {
      let rejectStopped!: (reason: unknown) => void;
      const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
      const onStop = () => rejectStopped(failure);
      controller.signal.addEventListener("abort", onStop, { once: true });
      // Attach both outcomes before checking: late source failures remain handled.
      const raced = Promise.race([pending, stopped]);
      if (performance.now() >= deadline) stop(TIMEOUT);
      if (controller.signal.aborted) onStop();
      try {
        const result = await raced;
        check();
        return result;
      } finally { controller.signal.removeEventListener("abort", onStop); }
    },
    close() {
      clearTimeout(timer);
      if (callerSignal !== undefined) EventTarget.prototype.removeEventListener.call(callerSignal, "abort", onAbort);
    },
  };
}

function discardResponse(response: Response | undefined) {
  try {
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  } catch { /* Cleanup must not reject or delay the public result. */ }
}

async function readBoundedBody(response: Response, lifetime: ReturnType<typeof createLifetime>, checkContext: () => void): Promise<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    if (response.body === null) throw INVALID_BODY;
    reader = response.body.getReader();
    const bytes = new Uint8Array(MAX_CATALOG_RESPONSE_BODY_BYTES);
    let length = 0;
    let reads = 0;
    while (true) {
      checkContext();
      const part = await lifetime.wait(reader.read());
      checkContext();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)
        || part.value.byteLength > MAX_CATALOG_RESPONSE_BODY_BYTES - length) throw INVALID_BODY;
      bytes.set(part.value, length);
      length += part.value.byteLength;
      // A source emitting immediate empty chunks must not starve the event loop.
      if (++reads % 64 === 0) {
        let yieldTimer: ReturnType<typeof setTimeout> | undefined;
        try { await lifetime.wait(new Promise<void>((resolve) => { yieldTimer = setTimeout(resolve, 0); })); }
        finally { if (yieldTimer !== undefined) clearTimeout(yieldTimer); }
      }
    }
    const declared = response.headers.get("content-length");
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    // Fetch can decompress bytes while preserving the encoded Content-Length.
    // Always cap decoded bytes; compare byte counts only for identity encoding.
    if ((encoding === undefined || encoding === "identity") && declared !== null
      && Number(declared) !== length) throw INVALID_BODY;
    complete = true;
    return bytes.subarray(0, length);
  } catch {
    checkContext();
    throw INVALID_BODY;
  } finally {
    if (reader) {
      if (!complete) {
        try { void reader.cancel().catch(() => undefined); } catch { /* Best effort; never await an untrusted source. */ }
      }
      try { reader.releaseLock(); } catch { /* Do not expose cleanup errors. */ }
    }
  }
}

export function createCatalogClient(config: CatalogClientConfig) {
  const settings = configure(config);
  // Same-object retry fence, not durable authority. New objects/clients are not
  // covered. The controller must discard old commands/cursors on every reset.
  const requestScopes = new WeakMap<CatalogRequest, CatalogViewContext>();
  return async function call(request: CatalogRequest, signal?: AbortSignal): Promise<CatalogCallResult> {
    const context = viewContext(settings.readViewContext);
    if (context === null) return Object.freeze({ kind: "stale" });
    let captured: CatalogRequest;
    try { captured = snapshotCatalogRequest(request); }
    catch { return Object.freeze({ kind: "invalid", reason: "REQUEST" }); }
    if (captured.action === "list" && captured.body.cursor !== null
      && captured.body.cursor.dataGeneration !== context.dataGeneration) return Object.freeze({ kind: "invalid", reason: "REQUEST" });
    const previous = requestScopes.get(request);
    if (previous && !sameContext(previous, context)) return Object.freeze({ kind: "stale" });
    let lifetime: ReturnType<typeof createLifetime>;
    try { lifetime = createLifetime(settings.timeoutMs, signal); }
    catch { return Object.freeze({ kind: "invalid", reason: "REQUEST" }); }
    requestScopes.set(request, context);
    const requestUrl = settings.origin + "/api/catalog/" + captured.action;
    let response: Response | undefined, completedReadSuccess = false;
    const retriableAfterMs = (seconds: number) => Math.min(seconds, 60) * 1000;
    function checkContext() {
      lifetime.check();
      if (!sameContext(context!, viewContext(settings.readViewContext))) throw STALE;
      lifetime.check();
    }
    function finish(result: CatalogCallResult): CatalogCallResult {
      checkContext();
      return Object.freeze(result);
    }
    try {
      try {
        checkContext();
        const pending = settings.fetch(new Request(requestUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "x-keyatlas-request": CATALOG_REQUEST_HEADER },
          credentials: "same-origin",
          redirect: "error",
          body: JSON.stringify(captured.body),
          signal: lifetime.signal,
        }), lifetime.signal);
        // Adapters may ignore abort. Their late responses must not replace a
        // returned timeout, retain an unread body, or leak a rejected promise.
        const tracked = pending.then((arrived) => {
          // Retain the arrived response BEFORE wait's post-await deadline check:
          // otherwise expiry between fulfillment and continuation leaks its body.
          response = arrived;
          if (lifetime.signal.aborted) discardResponse(arrived);
          return arrived;
        });
        response = await lifetime.wait(tracked);
      } catch {
        checkContext();
        return finish({ kind: "aborted" });
      }
      checkContext();
      if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status > 599) {
        return finish({ kind: "invalid", reason: "STATUS" });
      }
      if (!response.headers.has("content-type")) return finish({ kind: "invalid", reason: "HEADERS" });
      // Native Fetch already enforces redirect:error. Also reject an injected
      // adapter's redirected/off-target response before consuming its body.
      // Empty URLs are valid for synthetic/new Response fixtures, not authority.
      if (response.redirected || (response.url !== "" && response.url !== requestUrl)) {
        return finish({ kind: "invalid", reason: "HEADERS" });
      }
      // Browser Fetch filters Set-Cookie from Response headers. This catches
      // exposed adapter headers only; cookie policy still belongs to the server.
      if (response.headers.has("set-cookie")) return finish({ kind: "invalid", reason: "HEADERS" });
      const cacheControl = response.headers.get("cache-control");
      if (cacheControl === null || !cacheControl.split(",").some((part) => part.trim().toLowerCase() === "no-store")) {
        return finish({ kind: "invalid", reason: "HEADERS" });
      }
      const contentType = response.headers.get("content-type")!;
      if (!/^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/i.test(contentType)) {
        return finish({ kind: "invalid", reason: "HEADERS" });
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_CATALOG_RESPONSE_BODY_BYTES)) {
        return finish({ kind: "invalid", reason: "HEADERS" });
      }
      const rawBody = await readBoundedBody(response, lifetime, checkContext);
      let payload: unknown;
      try {
        const textBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody);
        payload = JSON.parse(textBody);
      } catch { return finish({ kind: "invalid", reason: "BODY" }); }
      checkContext();
      const fields = typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? Object.keys(payload) : [];
      if (fields.length !== 2 || !fields.includes("ok")
        || (payload as { ok: unknown }).ok !== (response.status === 200)) return finish({ kind: "invalid", reason: "ENVELOPE" });
      if (response.status !== 200) {
        const code = decodeCatalogError(payload);
        if (code === null || catalogErrorStatus(code) !== response.status) return finish({ kind: "invalid", reason: "ENVELOPE" });
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter === null || !/^\d+$/.test(retryAfter) || Number(retryAfter) < 1 || Number(retryAfter) > 60) {
            return finish({ kind: "invalid", reason: "HEADERS" });
          }
          return finish({ kind: "error", code, retriableAfterMs: retriableAfterMs(Number(retryAfter)) });
        }
        return finish({ kind: "error", code, retriableAfterMs: null });
      }
      const success = decodeCatalogSuccessForRequest(captured, (payload as { value: unknown }).value);
      checkContext();
      if (success === null) return finish({ kind: "invalid", reason: "ENVELOPE" });
      const generation = success.kind === "receipt" ? success.receipt.service.dataGeneration
        : success.kind === "view" ? success.view.dataGeneration : success.page.dataGeneration;
      if (generation !== context.dataGeneration) return finish({ kind: "invalid", reason: "ENVELOPE" });
      const result = finish({ kind: "success", capturedScope: context, success });
      // readBoundedBody reached actual EOF and checked byte length; decoding,
      // request correlation, generation and final scope/deadline also passed.
      // Mutation receipts deliberately retain their existing cleanup behavior.
      completedReadSuccess = captured.action === "get" || captured.action === "list";
      return result;
    } catch (error) {
      // No adapter exception or body text escapes the result-only boundary.
      // A prior view's failure must not become the current view's error. Context
      // invalidation outranks cancellation; first-stop wins within one context.
      if (error === STALE || !sameContext(context, viewContext(settings.readViewContext))) return Object.freeze({ kind: "stale" });
      try { lifetime.check(); } catch (stopped) {
        return Object.freeze({ kind: stopped === TIMEOUT ? "timeout" : "aborted" });
      }
      return Object.freeze({ kind: "invalid", reason: "BODY" });
    } finally {
      lifetime.close();
      if (!completedReadSuccess) discardResponse(response);
    }
  };
}
