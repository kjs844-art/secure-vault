import { createServiceCatalog } from "../catalog/service-catalog";
import type { ReviewAuthority, ReviewErrorCode } from "../review/contracts";
import { objectFields, parseAuthority, parseId } from "../review/validation";
import { BodyReadFailure, readBoundedJson } from "./bounded-json";
import {
  CATALOG_HTTP_ACTIONS, CATALOG_HTTP_PREFIX, CATALOG_REQUEST_HEADER,
  MAX_CATALOG_REQUEST_BYTES, MAX_CATALOG_REQUEST_MS, MAX_CATALOG_RESPONSE_BYTES,
  type CatalogAdmissionRequest, type CatalogHttpAction, type CatalogHttpDependencies,
  type CatalogHttpError, type CatalogSessionContext,
} from "./catalog-http-contracts";
import { HttpBoundaryFailure, RequestLifetime } from "./request-lifetime";

const STATUS: Readonly<Record<CatalogHttpError, number>> = {
  API_NOT_FOUND: 404, API_METHOD_NOT_ALLOWED: 405, API_REQUEST_REJECTED: 403,
  API_MEDIA_TYPE: 415, API_BODY_TOO_LARGE: 413, API_INPUT_INVALID: 400,
  API_AUTH_REQUIRED: 401, API_SESSION_CHANGED: 403, API_RATE_LIMITED: 429,
  API_CONFLICT: 409, API_UNAVAILABLE: 503, API_TIMEOUT: 408, API_ABORTED: 408,
};
function reply(value: unknown, status: number, extras: Readonly<Record<string, string>> = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", ...extras,
  } });
}
function failure(code: CatalogHttpError, extras: Readonly<Record<string, string>> = {}) {
  return reply({ ok: false, code }, STATUS[code], extras);
}
function sameAuthority(left: ReviewAuthority, right: ReviewAuthority) {
  return left.ownerId === right.ownerId && left.sessionId === right.sessionId
    && left.sessionRevision === right.sessionRevision && left.dataGeneration === right.dataGeneration
    && left.expiresAt === right.expiresAt;
}
function configuration(deps: CatalogHttpDependencies) {
  try {
    const url = new URL(deps.trustedOrigin);
    const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.origin !== deps.trustedOrigin || url.username || url.password
      || (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal))) throw new Error();
    const timeoutMs = deps.requestTimeoutMs === undefined ? MAX_CATALOG_REQUEST_MS : deps.requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CATALOG_REQUEST_MS) throw new Error();
    for (const fn of [deps.readSession, deps.admit, deps.transaction, deps.now, deps.newId]) {
      if (typeof fn !== "function") throw new Error();
    }
    return Object.freeze({ origin: url.origin, timeoutMs });
  } catch { throw new Error("API_CONFIGURATION_INVALID"); }
}
function reviewError(code: ReviewErrorCode): CatalogHttpError {
  switch (code) {
    case "REVIEW_INPUT_INVALID": return "API_INPUT_INVALID";
    case "REVIEW_AUTH_REQUIRED": return "API_AUTH_REQUIRED";
    case "REVIEW_AUTHORITY_CHANGED": return "API_SESSION_CHANGED";
    case "REVIEW_NOT_FOUND": return "API_NOT_FOUND";
    case "REVIEW_CONFLICT":
    case "REVIEW_OPERATION_CONFLICT": return "API_CONFLICT";
    default: return "API_UNAVAILABLE";
  }
}
function errorCode(error: unknown): CatalogHttpError {
  if (error instanceof HttpBoundaryFailure) return error.code;
  if (error instanceof BodyReadFailure) {
    switch (error.code) {
      case "BODY_INVALID": return "API_INPUT_INVALID";
      case "BODY_TOO_LARGE": return "API_BODY_TOO_LARGE";
      case "BODY_MEDIA_TYPE": return "API_MEDIA_TYPE";
      case "BODY_TIMEOUT": return "API_TIMEOUT";
      case "BODY_ABORTED": return "API_ABORTED";
    }
  }
  return "API_UNAVAILABLE";
}
function cancelUnreadBody(request: Request) {
  // Do not wait forever for an uncooperative stream's cancel callback.
  try { if (request.body && !request.body.locked) void request.body.cancel().catch(() => undefined); }
  catch { /* Body is already consumed or cancelled. No content/error logging. */ }
}

/**
 * Provider-independent Fetch adapter. NOT connected to the production entry.
 * POST for reads avoids private IDs/cursors in URLs. Same-origin cookie sessions
 * only; this is not a general bearer-token/public API or a credential issuer.
 */
export function createCatalogHttpHandler(deps: CatalogHttpDependencies) {
  const config = configuration(deps);
  return async (request: Request): Promise<Response> => {
    let lifetime: RequestLifetime | undefined;
    try {
      const url = new URL(request.url);
      const route = url.pathname.startsWith(CATALOG_HTTP_PREFIX) ? url.pathname.slice(CATALOG_HTTP_PREFIX.length) : "";
      if (!(CATALOG_HTTP_ACTIONS as readonly string[]).includes(route)) return failure("API_NOT_FOUND");
      if (request.method !== "POST") return failure("API_METHOD_NOT_ALLOWED", { Allow: "POST" });
      const action = route as CatalogHttpAction;
      if (url.origin !== config.origin || url.search || url.hash || url.username || url.password
        || request.headers.get("origin") !== config.origin
        || request.headers.get("x-keyatlas-request") !== CATALOG_REQUEST_HEADER
        || (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin")
        || request.headers.has("authorization")) return failure("API_REQUEST_REJECTED");
      const cookie = request.headers.get("cookie");
      if (cookie !== null && (cookie.length > 4096 || /[^\u0020-\u007e]/u.test(cookie))) return failure("API_REQUEST_REJECTED");
      if (cookie === null || cookie.trim() === "") return failure("API_AUTH_REQUIRED");
      const context: CatalogSessionContext = Object.freeze({ cookie });
      const life = new RequestLifetime(deps.now, request.signal, config.timeoutMs);
      lifetime = life;
      const initialSession = await life.run(() => deps.readSession(context, life.signal));
      const initialNow = life.now();
      let authority: ReviewAuthority;
      try { authority = parseAuthority(initialSession, initialNow); }
      catch { return failure("API_AUTH_REQUIRED"); }
      life.tighten(authority.expiresAt, "API_SESSION_CHANGED");

      const readAuthority = async () => {
        const raw = await life.run(() => deps.readSession(context, life.signal));
        let current: ReviewAuthority;
        try { current = parseAuthority(raw, life.now()); }
        catch { throw new HttpBoundaryFailure("API_SESSION_CHANGED"); }
        if (!sameAuthority(authority, current)) throw new HttpBoundaryFailure("API_SESSION_CHANGED");
        return authority;
      };
      const admission: CatalogAdmissionRequest = Object.freeze({ requestId: parseId(deps.newId()), action,
        authority, notAfter: life.notAfter });
      const rawPermit = await life.run(() => deps.admit(admission, life.signal));
      await readAuthority();
      // Adapter receipts are unknown until matched to this exact principal/action/request.
      let permit: Record<string, unknown>;
      try {
        const tag = objectFields(rawPermit, ["allowed"], false).allowed;
        if (tag === false) {
          const denied = objectFields(rawPermit, ["allowed", "retryAfterSeconds"]);
          if (typeof denied.retryAfterSeconds !== "number" || !Number.isSafeInteger(denied.retryAfterSeconds)
            || denied.retryAfterSeconds < 1 || denied.retryAfterSeconds > 60) throw new Error();
          return failure("API_RATE_LIMITED", { "Retry-After": String(denied.retryAfterSeconds) });
        }
        permit = objectFields(rawPermit, ["allowed", "requestId", "action", "authority", "expiresAt"]);
        if (permit.allowed !== true || permit.requestId !== admission.requestId || permit.action !== action
          || !sameAuthority(parseAuthority(objectFields(permit.authority,
            ["ownerId", "sessionId", "sessionRevision", "dataGeneration", "expiresAt"]), life.now()), authority)
          || typeof permit.expiresAt !== "number" || !Number.isSafeInteger(permit.expiresAt)
          || permit.expiresAt <= life.now() || permit.expiresAt > admission.notAfter) throw new Error();
      } catch {
        life.now();
        return failure("API_UNAVAILABLE");
      }
      life.tighten(permit.expiresAt as number, "API_TIMEOUT");
      const command = await life.run(() => readBoundedJson(request, {
        maxBytes: MAX_CATALOG_REQUEST_BYTES, timeoutMs: config.timeoutMs, signal: life.signal,
      }));
      await readAuthority();

      const catalog = createServiceCatalog({
        now: () => life.now(), newId: () => deps.newId(), readAuthority,
        transaction: async (observedAuthority, task) => {
          life.now();
          if (!sameAuthority(authority, observedAuthority)) throw new HttpBoundaryFailure("API_SESSION_CHANGED");
          return life.run(() => deps.transaction(authority, async (tx) => {
            tx.limitCommitTime(life.notAfter);
            await readAuthority();
            const result = await task(tx);
            await readAuthority();
            life.now();
            return result;
          }));
        },
      });
      const dispatch = action === "delete" ? catalog.remove : catalog[action];
      const result = await life.run<Awaited<ReturnType<typeof dispatch>>>(() => dispatch(command));
      await readAuthority();
      if (!result.ok) return failure(reviewError(result.code));
      const serialized = JSON.stringify(result);
      if (new TextEncoder().encode(serialized).byteLength > MAX_CATALOG_RESPONSE_BYTES) return failure("API_UNAVAILABLE");
      // Serialize/check size before the final session check, never after authority expires.
      await readAuthority();
      life.now();
      const response = reply(null, 200);
      return new Response(serialized, { status: 200, headers: response.headers });
    } catch (error) {
      // Cancellation/timeout may race a committed write. Return no payload and
      // do not promise rollback; the caller can retry the SAME operation ID.
      // A stream may report its abort before the lifetime's timeout rejection.
      // Keep the real request-lifetime reason instead of calling a timeout a user abort.
      try { lifetime?.now(); }
      catch (expired) { return failure(errorCode(expired)); }
      return failure(errorCode(error));
    } finally {
      lifetime?.finish();
      cancelUnreadBody(request);
    }
  };
}
