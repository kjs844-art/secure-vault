import { createReviewService } from "../review/review-service";
import { projectReviewPreview } from "../review/preview-presentation";
import { projectReviewedBenefit } from "../review/presentation";
import { projectReviewedBenefitPage } from "../review/page-presentation";
import type { ReviewAuthority, ReviewErrorCode } from "../review/contracts";
import { objectFields, parseAuthority, parseId } from "../review/validation";
import { BodyReadFailure, readBoundedJson } from "./bounded-json";
import { HttpBoundaryFailure, RequestLifetime } from "./request-lifetime";
import { REVIEW_HTTP_ACTIONS, REVIEW_HTTP_PREFIX, REVIEW_REQUEST_HEADER,
  MAX_REVIEW_REQUEST_BYTES, MAX_REVIEW_RESPONSE_BYTES, MAX_REVIEW_REQUEST_MS,
  type ReviewHttpAction, type ReviewHttpDependencies, type ReviewHttpError,
  type ReviewAdmissionRequest, type ReviewSessionContext } from "./review-http-contracts";

const STATUS: Readonly<Record<ReviewHttpError, number>> = {
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
function failure(code: ReviewHttpError, extras: Readonly<Record<string, string>> = {}) {
  return reply({ ok: false, code }, STATUS[code], extras);
}
function sameAuthority(left: ReviewAuthority, right: ReviewAuthority) {
  return left.ownerId === right.ownerId && left.sessionId === right.sessionId
    && left.sessionRevision === right.sessionRevision && left.dataGeneration === right.dataGeneration
    && left.expiresAt === right.expiresAt;
}
function configuration(deps: ReviewHttpDependencies) {
  try {
    const url = new URL(deps.trustedOrigin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.origin !== deps.trustedOrigin || url.username || url.password
      || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) throw new Error();
    const timeoutMs = deps.requestTimeoutMs === undefined ? MAX_REVIEW_REQUEST_MS : deps.requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REVIEW_REQUEST_MS) throw new Error();
    for (const fn of [deps.readSession, deps.admit, deps.transaction, deps.now, deps.newId]) {
      if (typeof fn !== "function") throw new Error();
    }
    return Object.freeze({ origin: url.origin, timeoutMs });
  } catch { throw new Error("API_CONFIGURATION_INVALID"); }
}
function reviewError(code: ReviewErrorCode): ReviewHttpError {
  switch (code) {
    case "REVIEW_INPUT_INVALID": return "API_INPUT_INVALID";
    case "REVIEW_AUTH_REQUIRED": return "API_AUTH_REQUIRED";
    case "REVIEW_AUTHORITY_CHANGED": return "API_SESSION_CHANGED";
    case "REVIEW_NOT_FOUND": return "API_NOT_FOUND";
    case "REVIEW_CONFLICT": case "REVIEW_OPERATION_CONFLICT":
    case "REVIEW_PREVIEW_EXPIRED": case "REVIEW_PREVIEW_UNAVAILABLE": return "API_CONFLICT";
    default: return "API_UNAVAILABLE";
  }
}
function errorCode(error: unknown): ReviewHttpError {
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
  try { if (request.body && !request.body.locked) void request.body.cancel().catch(() => undefined); }
  catch { /* No body, adapter exception or cancellation-reason logging. */ }
}

/** Trusted internal service dispatch; never serialize its private source fields. */
async function dispatch(service: ReturnType<typeof createReviewService>, action: ReviewHttpAction, command: unknown) {
  switch (action) {
    case "preview": {
      const result = await service.preview(command);
      return result.ok ? { ok: true as const, value: projectReviewPreview(result.value) } : result;
    }
    case "confirm": case "delete": case "get": {
      const result = await (action === "confirm" ? service.confirm : action === "delete" ? service.remove : service.get)(command);
      return result.ok ? { ok: true as const, value: projectReviewedBenefit(result.value) } : result;
    }
    case "list": {
      const result = await service.list(command);
      return result.ok ? { ok: true as const, value: projectReviewedBenefitPage(result.value) } : result;
    }
    case "reject": {
      const result = await service.reject(command);
      // Exact fresh response, not a pass-through of any future private fields.
      return result.ok ? { ok: true as const, value: { previewId: result.value.previewId, state: "revoked" as const } } : result;
    }
  }
}

/**
 * Unmounted Fetch composition. Actual runtime /api/review remains disconnected.
 * Cookie-based same-origin actions only; POST reads keep IDs/cursors out of URLs.
 * This is not auth/session issuance, a DB adapter, or permission to use real data.
 */
export function createReviewHttpHandler(deps: ReviewHttpDependencies) {
  const config = configuration(deps);
  return async (request: Request): Promise<Response> => {
    let lifetime: RequestLifetime | undefined;
    try {
      const url = new URL(request.url);
      const route = url.pathname.startsWith(REVIEW_HTTP_PREFIX) ? url.pathname.slice(REVIEW_HTTP_PREFIX.length) : "";
      if (!(REVIEW_HTTP_ACTIONS as readonly string[]).includes(route)) return failure("API_NOT_FOUND");
      if (request.method !== "POST") return failure("API_METHOD_NOT_ALLOWED", { Allow: "POST" });
      const action = route as ReviewHttpAction;
      if (url.origin !== config.origin || url.search || url.hash || url.username || url.password
        || request.headers.get("origin") !== config.origin
        || request.headers.get("x-keyatlas-request") !== REVIEW_REQUEST_HEADER
        || (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin")
        || request.headers.has("authorization")) return failure("API_REQUEST_REJECTED");
      const cookie = request.headers.get("cookie");
      if (cookie !== null && (cookie.length > 4096 || /[^\u0020-\u007e]/u.test(cookie))) return failure("API_REQUEST_REJECTED");
      if (cookie === null || cookie.trim() === "") return failure("API_AUTH_REQUIRED");
      const context: ReviewSessionContext = Object.freeze({ cookie });
      const life = new RequestLifetime(deps.now, request.signal, config.timeoutMs);
      lifetime = life;
      const initial = await life.run(() => deps.readSession(context, life.signal));
      const initialNow = life.now();
      let authority: ReviewAuthority;
      try { authority = parseAuthority(initial, initialNow); }
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
      const admission: ReviewAdmissionRequest = Object.freeze({ surface: REVIEW_REQUEST_HEADER,
        requestId: parseId(deps.newId()), action, authority, notAfter: life.notAfter });
      const rawPermit = await life.run(() => deps.admit(admission, life.signal));
      await readAuthority();
      let permit: Record<string, unknown>;
      try {
        if (objectFields(rawPermit, ["allowed"], false).allowed === false) {
          const denied = objectFields(rawPermit, ["allowed", "retryAfterSeconds"]);
          if (typeof denied.retryAfterSeconds !== "number" || !Number.isSafeInteger(denied.retryAfterSeconds)
            || denied.retryAfterSeconds < 1 || denied.retryAfterSeconds > 60) throw new Error();
          return failure("API_RATE_LIMITED", { "Retry-After": String(denied.retryAfterSeconds) });
        }
        permit = objectFields(rawPermit, ["allowed", "surface", "requestId", "action", "authority", "expiresAt"]);
        if (permit.allowed !== true || permit.surface !== REVIEW_REQUEST_HEADER || permit.requestId !== admission.requestId
          || permit.action !== action || !sameAuthority(parseAuthority(objectFields(permit.authority,
            ["ownerId", "sessionId", "sessionRevision", "dataGeneration", "expiresAt"]), life.now()), authority)
          || typeof permit.expiresAt !== "number" || !Number.isSafeInteger(permit.expiresAt)
          || permit.expiresAt <= life.now() || permit.expiresAt > admission.notAfter) throw new Error();
      } catch { life.now(); return failure("API_UNAVAILABLE"); }
      life.tighten(permit.expiresAt as number, "API_TIMEOUT");
      const command = await life.run(() => readBoundedJson(request, {
        maxBytes: MAX_REVIEW_REQUEST_BYTES, timeoutMs: config.timeoutMs, signal: life.signal,
      }));
      await readAuthority();
      const service = createReviewService({ now: () => life.now(), newId: () => deps.newId(), readAuthority,
        transaction: async (observed, task) => {
          life.now();
          if (!sameAuthority(authority, observed)) throw new HttpBoundaryFailure("API_SESSION_CHANGED");
          return life.run(() => deps.transaction(authority, async (tx) => {
            tx.limitCommitTime(life.notAfter);
            await readAuthority();
            const result = await task(tx);
            await readAuthority(); life.now();
            return result;
          }));
        },
      });
      const result = await life.run(() => dispatch(service, action, command));
      await readAuthority();
      if (!result.ok) return failure(reviewError(result.code));
      const serialized = JSON.stringify(result);
      if (new TextEncoder().encode(serialized).byteLength > MAX_REVIEW_RESPONSE_BYTES) return failure("API_UNAVAILABLE");
      await readAuthority();
      const finalTime = life.now();
      // A preview is a deadline-bound display, unlike a saved observation.
      // The five-minute cap can be shortened by candidate/session expiry, even
      // before the HTTP budget ends. Never inherit it for already saved rows.
      if (action === "preview" && (!("expiresAt" in result.value) || result.value.expiresAt <= finalTime)) {
        return failure("API_CONFLICT");
      }
      return new Response(serialized, { status: 200, headers: reply(null, 200).headers });
    } catch (error) {
      // A late error/disconnect may follow commit. No payload and no rollback
      // promise: only explicit same-command/operation-ID retry can reconcile it.
      try { lifetime?.now(); } catch (expired) { return failure(errorCode(expired)); }
      return failure(errorCode(error));
    } finally { lifetime?.finish(); cancelUnreadBody(request); }
  };
}
