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

export function createCatalogClient(config: CatalogClientConfig) {
  const settings = configure(config);
  return async function call(request: CatalogRequest): Promise<CatalogCallResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("CATALOG_TIMEOUT")), settings.timeoutMs);
    const retriableAfterMs = (seconds: number) => Math.min(seconds, 60) * 1000;
    try {
      let response: Response;
      try {
        response = await settings.fetch(new Request(settings.origin + "/api/catalog/" + request.action, {
          method: "POST",
          headers: { "content-type": "application/json", "x-keyatlas-request": CATALOG_REQUEST_HEADER },
          credentials: "same-origin",
          redirect: "error",
          body: JSON.stringify(request.body),
          signal: controller.signal,
        }), controller.signal);
      } catch {
        if (controller.signal.reason instanceof Error
          && controller.signal.reason.message === "CATALOG_TIMEOUT") return { kind: "timeout" };
        return { kind: "aborted" };
      }
      if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status > 599) {
        return { kind: "invalid", reason: "STATUS" };
      }
      if (!response.headers.has("content-type")) return { kind: "invalid", reason: "HEADERS" };
      if (response.headers.has("set-cookie")) return { kind: "invalid", reason: "HEADERS" };
      const cacheControl = response.headers.get("cache-control");
      if (cacheControl === null || !cacheControl.includes("no-store")) return { kind: "invalid", reason: "HEADERS" };
      const contentType = response.headers.get("content-type")!;
      if (contentType !== "application/json" && !contentType.startsWith("application/json;")) {
        return { kind: "invalid", reason: "HEADERS" };
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_CATALOG_RESPONSE_BODY_BYTES)) {
        return { kind: "invalid", reason: "HEADERS" };
      }
      const rawBody = await response.arrayBuffer();
      if (rawBody.byteLength > MAX_CATALOG_RESPONSE_BODY_BYTES) return { kind: "invalid", reason: "BODY" };
      const textBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody);
      let payload: unknown;
      try { payload = JSON.parse(textBody); } catch { return { kind: "invalid", reason: "BODY" }; }
      const fields = typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? Object.keys(payload) : [];
      if (fields.length !== 2 || !fields.includes("ok")
        || (payload as { ok: unknown }).ok !== (response.status === 200)) return { kind: "invalid", reason: "ENVELOPE" };
      if (response.status !== 200) {
        const code = decodeCatalogError(payload);
        if (code === null) return { kind: "invalid", reason: "ENVELOPE" };
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter === null || !/^\d+$/.test(retryAfter) || Number(retryAfter) < 1 || Number(retryAfter) > 60) {
            return { kind: "invalid", reason: "HEADERS" };
          }
          return Object.freeze({ kind: "error", code, retriableAfterMs: retriableAfterMs(Number(retryAfter)) });
        }
        return Object.freeze({ kind: "error", code, retriableAfterMs: null });
      }
      const success = decodeCatalogSuccess(request.action, (payload as { value: unknown }).value);
      if (success === null) return { kind: "invalid", reason: "ENVELOPE" };
      return Object.freeze({ kind: "success", success });
    } finally {
      clearTimeout(timer);
    }
  };
}
