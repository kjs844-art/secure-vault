/**
 * Small browser catalog client. create/update/delete/get/list against exact
 * POST paths of the same trusted origin, with runtime response validation.
 * No real auth/operational integration: the running SSR app keeps every
 * /api/catalog route 503 INTEGRATION_NOT_CONNECTED.
 */
import type { CatalogRequest } from "./requests.ts";
import { decodeCatalogError, decodeCatalogSuccess, type CatalogHttpErrorCode, type CatalogSuccess } from "./responses.ts";

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
export interface CatalogClientConfig {
  /** Exact trusted origin, e.g. the page's own origin. Operator/UI supplied. */
  readonly origin: string;
  readonly fetch: CatalogTransport;
  /** Positive integer milliseconds, <= DEFAULT_CATALOG_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}
export type CatalogCallFailure =
  | { readonly kind: "error"; readonly code: CatalogHttpErrorCode; readonly retriableAfterMs: number | null }
  | { readonly kind: "invalid"; readonly reason: "STATUS" | "BODY" | "ENVELOPE" | "HEADERS" }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };
export type CatalogCallResult = CatalogCallSuccess | CatalogCallFailure;
export interface CatalogCallSuccess {
  readonly kind: "success";
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
  if (typeof config.fetch !== "function") invalidConfiguration();
  return Object.freeze({ origin: url.origin, timeoutMs, fetch: config.fetch });
}

const TIMEOUT = Symbol("catalog-timeout");
const ABORTED = Symbol("catalog-aborted");
const INVALID_BODY = Symbol("catalog-invalid-body");

function createLifetime(timeoutMs: number, callerSignal?: AbortSignal) {
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let failure: typeof TIMEOUT | typeof ABORTED | undefined;
  function stop(reason: typeof TIMEOUT | typeof ABORTED) {
    if (failure !== undefined) return;
    failure = reason;
    controller.abort();
  }
  function refresh() {
    if (performance.now() >= deadline) stop(TIMEOUT);
  }
  function check() {
    refresh();
    if (failure !== undefined) throw failure;
  }
  const onAbort = () => stop(performance.now() >= deadline ? TIMEOUT : ABORTED);
  const timer = setTimeout(() => stop(TIMEOUT), timeoutMs);
  callerSignal?.addEventListener("abort", onAbort, { once: true });
  if (callerSignal?.aborted) onAbort();
  return {
    signal: controller.signal,
    check,
    hasStopped: () => failure !== undefined,
    async wait<T>(pending: Promise<T>): Promise<T> {
      let rejectStopped!: (reason: unknown) => void;
      const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
      const onStop = () => rejectStopped(failure);
      controller.signal.addEventListener("abort", onStop, { once: true });
      if (controller.signal.aborted) onStop();
      try {
        refresh();
        const value = await Promise.race([pending, stopped]);
        check();
        return value;
      } finally {
        // Do not retain one pending cancellation handler for every body chunk.
        controller.signal.removeEventListener("abort", onStop);
      }
    },
    close() {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
    },
  };
}

function discardResponse(response: Response | undefined) {
  try {
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
  } catch { /* Cleanup must not expose adapter errors or block the result. */ }
}

async function readBoundedBody(response: Response, lifetime: ReturnType<typeof createLifetime>) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    if (response.body === null) throw INVALID_BODY;
    reader = response.body.getReader();
    const bytes = new Uint8Array(MAX_CATALOG_RESPONSE_BODY_BYTES);
    let length = 0;
    while (true) {
      const part = await lifetime.wait(reader.read());
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)
        || part.value.byteLength > MAX_CATALOG_RESPONSE_BODY_BYTES - length) throw INVALID_BODY;
      bytes.set(part.value, length);
      length += part.value.byteLength;
    }
    complete = true;
    return bytes.subarray(0, length);
  } catch {
    lifetime.check();
    throw INVALID_BODY;
  } finally {
    if (reader) {
      if (!complete) {
        try { void reader.cancel().catch(() => undefined); } catch { /* Best effort only. */ }
      }
      reader.releaseLock();
    }
  }
}

export function createCatalogClient(config: CatalogClientConfig) {
  const settings = configure(config);
  // The UI can abort a captured scope on logout/switch; response application
  // still needs its own captured-scope/revision checks. No authority is sent here.
  return async function call(request: CatalogRequest, signal?: AbortSignal): Promise<CatalogCallResult> {
    const lifetime = createLifetime(settings.timeoutMs, signal);
    let response: Response | undefined;
    const retriableAfterMs = (seconds: number) => Math.min(seconds, 60) * 1000;
    function finish(result: CatalogCallResult): CatalogCallResult {
      lifetime.check();
      return Object.freeze(result);
    }
    try {
      lifetime.check();
      try {
        const pending = settings.fetch(new Request(settings.origin + "/api/catalog/" + request.action, {
          method: "POST",
          headers: { "content-type": "application/json", "x-keyatlas-request": CATALOG_REQUEST_HEADER },
          credentials: "same-origin",
          redirect: "error",
          body: JSON.stringify(request.body),
          signal: lifetime.signal,
        }), lifetime.signal);
        // An injected transport may ignore abort. Dispose of its eventual body
        // without waiting for it or allowing it to replace the returned timeout.
        void pending.then((late) => { if (lifetime.hasStopped()) discardResponse(late); }, () => undefined);
        response = await lifetime.wait(pending);
      } catch {
        lifetime.check();
        return finish({ kind: "aborted" });
      }
      if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status > 599) {
        return finish({ kind: "invalid", reason: "STATUS" });
      }
      if (!response.headers.has("content-type")) return finish({ kind: "invalid", reason: "HEADERS" });
      if (response.headers.has("set-cookie")) return finish({ kind: "invalid", reason: "HEADERS" });
      const cacheControl = response.headers.get("cache-control");
      if (cacheControl === null || !cacheControl.includes("no-store")) return finish({ kind: "invalid", reason: "HEADERS" });
      const contentType = response.headers.get("content-type")!;
      if (contentType !== "application/json" && !contentType.startsWith("application/json;")) {
        return finish({ kind: "invalid", reason: "HEADERS" });
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_CATALOG_RESPONSE_BODY_BYTES)) {
        return finish({ kind: "invalid", reason: "HEADERS" });
      }
      const rawBody = await readBoundedBody(response, lifetime);
      let payload: unknown;
      try {
        const textBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody);
        payload = JSON.parse(textBody);
      } catch { return finish({ kind: "invalid", reason: "BODY" }); }
      const fields = typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? Object.keys(payload) : [];
      if (fields.length !== 2 || !fields.includes("ok")
        || (payload as { ok: unknown }).ok !== (response.status === 200)) return finish({ kind: "invalid", reason: "ENVELOPE" });
      if (response.status !== 200) {
        const code = decodeCatalogError(payload);
        if (code === null) return finish({ kind: "invalid", reason: "ENVELOPE" });
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter === null || !/^\d+$/.test(retryAfter) || Number(retryAfter) < 1 || Number(retryAfter) > 60) {
            return finish({ kind: "invalid", reason: "HEADERS" });
          }
          return finish({ kind: "error", code, retriableAfterMs: retriableAfterMs(Number(retryAfter)) });
        }
        return finish({ kind: "error", code, retriableAfterMs: null });
      }
      const success = decodeCatalogSuccess(request.action, (payload as { value: unknown }).value);
      if (success === null) return finish({ kind: "invalid", reason: "ENVELOPE" });
      return finish({ kind: "success", success });
    } catch (error) {
      try { lifetime.check(); } catch (stopped) {
        return Object.freeze({ kind: stopped === TIMEOUT ? "timeout" : "aborted" });
      }
      if (error === INVALID_BODY) return Object.freeze({ kind: "invalid", reason: "BODY" });
      throw error;
    } finally {
      discardResponse(response);
      lifetime.close();
    }
  };
}
