import { createCandidateInbox } from "../inbox/candidate-inbox";
import { projectCandidateBatch } from "../inbox/presentation";
import type { ReviewAuthority, ReviewErrorCode } from "../review/contracts";
import { objectFields, parseAuthority, parseId, parseRevision, ReviewFailure } from "../review/validation";
import { BodyReadFailure, readBoundedJson } from "./bounded-json";
import { HttpBoundaryFailure, RequestLifetime } from "./request-lifetime";
import { INBOX_HTTP_PATH, INBOX_REQUEST_HEADER, MAX_INBOX_REQUEST_BYTES,
  MAX_INBOX_RESPONSE_BYTES, MAX_INBOX_REQUEST_MS, type InboxAdmissionRequest,
  type InboxBatchMapping, type InboxHttpDependencies, type InboxHttpError,
  type InboxSessionContext } from "./inbox-http-contracts";

const STATUS: Readonly<Record<InboxHttpError, number>> = {
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
function failure(code: InboxHttpError, extras: Readonly<Record<string, string>> = {}) {
  return reply({ ok: false, code }, STATUS[code], extras);
}
function sameAuthority(left: ReviewAuthority, right: ReviewAuthority) {
  return left.ownerId === right.ownerId && left.sessionId === right.sessionId
    && left.sessionRevision === right.sessionRevision && left.dataGeneration === right.dataGeneration
    && left.expiresAt === right.expiresAt;
}
function configuration(deps: InboxHttpDependencies) {
  try {
    const url = new URL(deps.trustedOrigin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.origin !== deps.trustedOrigin || url.username || url.password
      || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) throw new Error();
    const timeoutMs = deps.requestTimeoutMs === undefined ? MAX_INBOX_REQUEST_MS : deps.requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_INBOX_REQUEST_MS) throw new Error();
    for (const fn of [deps.readSession, deps.admit, deps.resolveBatch, deps.transaction, deps.now, deps.newId]) {
      if (typeof fn !== "function") throw new Error();
    }
    return Object.freeze({ origin: url.origin, timeoutMs });
  } catch { throw new Error("API_CONFIGURATION_INVALID"); }
}
function serviceError(code: ReviewErrorCode): InboxHttpError {
  switch (code) {
    case "REVIEW_INPUT_INVALID": return "API_INPUT_INVALID";
    case "REVIEW_AUTH_REQUIRED": return "API_AUTH_REQUIRED";
    case "REVIEW_AUTHORITY_CHANGED": return "API_SESSION_CHANGED";
    case "REVIEW_NOT_FOUND": return "API_NOT_FOUND";
    case "REVIEW_CONFLICT": case "REVIEW_OPERATION_CONFLICT": return "API_CONFLICT";
    default: return "API_UNAVAILABLE";
  }
}
function errorCode(error: unknown): InboxHttpError {
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
  catch { /* Do not expose body or cancellation reason. */ }
}

/** Unmounted, read-only Fetch composition. No alias issuance, auth, grants,
 * staging, public route, provider or DB is activated by constructing it. */
export function createInboxHttpHandler(deps: InboxHttpDependencies) {
  const config = configuration(deps);
  return async (request: Request): Promise<Response> => {
    let lifetime: RequestLifetime | undefined;
    try {
      const url = new URL(request.url);
      if (url.pathname !== INBOX_HTTP_PATH) return failure("API_NOT_FOUND");
      if (request.method !== "POST") return failure("API_METHOD_NOT_ALLOWED", { Allow: "POST" });
      if (url.origin !== config.origin || url.search || url.hash || url.username || url.password
        || request.headers.get("origin") !== config.origin
        || request.headers.get("x-keyatlas-request") !== INBOX_REQUEST_HEADER
        || (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin")
        || request.headers.has("authorization")) return failure("API_REQUEST_REJECTED");
      const cookie = request.headers.get("cookie");
      if (cookie !== null && (cookie.length > 4096 || /[^\u0020-\u007e]/u.test(cookie))) return failure("API_REQUEST_REJECTED");
      if (cookie === null || cookie.trim() === "") return failure("API_AUTH_REQUIRED");
      const context: InboxSessionContext = Object.freeze({ cookie });
      const life = new RequestLifetime(deps.now, request.signal, config.timeoutMs);
      lifetime = life;
      const initial = await life.run(() => deps.readSession(context, life.signal));
      let authority: ReviewAuthority;
      try { authority = parseAuthority(initial, life.now()); }
      catch { life.now(); return failure("API_AUTH_REQUIRED"); }
      life.tighten(authority.expiresAt, "API_SESSION_CHANGED");
      const readAuthority = async () => {
        const raw = await life.run(() => deps.readSession(context, life.signal));
        let current: ReviewAuthority;
        try { current = parseAuthority(raw, life.now()); }
        catch { throw new HttpBoundaryFailure("API_SESSION_CHANGED"); }
        if (!sameAuthority(authority, current)) throw new HttpBoundaryFailure("API_SESSION_CHANGED");
        return authority;
      };
      const admission: InboxAdmissionRequest = Object.freeze({ surface: INBOX_REQUEST_HEADER,
        requestId: parseId(deps.newId()), action: "batch", authority, notAfter: life.notAfter });
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
        if (permit.allowed !== true || permit.surface !== INBOX_REQUEST_HEADER || permit.requestId !== admission.requestId
          || permit.action !== "batch" || !sameAuthority(parseAuthority(objectFields(permit.authority,
            ["ownerId", "sessionId", "sessionRevision", "dataGeneration", "expiresAt"]), life.now()), authority)
          || typeof permit.expiresAt !== "number" || !Number.isSafeInteger(permit.expiresAt)
          || permit.expiresAt <= life.now() || permit.expiresAt > admission.notAfter) throw new Error();
      } catch { life.now(); return failure("API_UNAVAILABLE"); }
      life.tighten(permit.expiresAt as number, "API_TIMEOUT");
      const command = await life.run(() => readBoundedJson(request, {
        maxBytes: MAX_INBOX_REQUEST_BYTES, timeoutMs: config.timeoutMs, signal: life.signal,
      }));
      let batchReference: string;
      try { batchReference = parseId(objectFields(command, ["batchReference"]).batchReference); }
      catch { return failure("API_INPUT_INVALID"); }
      // Sticky boundary failures survive the service's deliberate fixed-error
      // conversion, including a mapping that changes then changes back (ABA).
      let boundaryFailure: HttpBoundaryFailure | null = null;
      const resolve = async (expected?: InboxBatchMapping): Promise<InboxBatchMapping> => {
        try {
          await readAuthority();
          const raw = await life.run(() => deps.resolveBatch(Object.freeze({ batchReference, authority }), life.signal));
          await readAuthority();
          if (raw === null) throw new HttpBoundaryFailure(expected ? "API_CONFLICT" : "API_NOT_FOUND");
          let mapping: InboxBatchMapping;
          try {
            const fields = objectFields(raw, ["batchReference", "ownerId", "dataGeneration", "analysisOperationId"]);
            mapping = Object.freeze({ batchReference: parseId(fields.batchReference), ownerId: parseId(fields.ownerId),
              dataGeneration: parseRevision(fields.dataGeneration), analysisOperationId: parseId(fields.analysisOperationId) });
          } catch { throw new HttpBoundaryFailure("API_UNAVAILABLE"); }
          if (mapping.batchReference !== batchReference || mapping.ownerId !== authority.ownerId
            || mapping.dataGeneration !== authority.dataGeneration) {
            throw new HttpBoundaryFailure(expected ? "API_CONFLICT" : "API_NOT_FOUND");
          }
          if (expected && mapping.analysisOperationId !== expected.analysisOperationId) throw new HttpBoundaryFailure("API_CONFLICT");
          return mapping;
        } catch (error) {
          // The real resolver can reject after detecting a session change
          // before our next session observation. Preserve that fixed category
          // (and its sticky failure), rather than downgrading it to retryable 503.
          const converted = error instanceof ReviewFailure ? new HttpBoundaryFailure(serviceError(error.code)) : error;
          if (converted instanceof HttpBoundaryFailure) boundaryFailure ??= converted;
          throw converted;
        }
      };
      const mapping = await resolve();
      const inbox = createCandidateInbox({ now: () => life.now(), newId: () => deps.newId(), readAuthority,
        // Stage is not exposed. Never treat these as live grant implementations.
        isAnalysisAuthorized: async () => false, readStagingGrant: async () => null,
        transaction: async (observed, task) => {
          if (!sameAuthority(authority, observed)) throw new HttpBoundaryFailure("API_SESSION_CHANGED");
          await resolve(mapping);
          return life.run(() => deps.transaction(authority, async (tx) => {
            tx.limitCommitTime(life.notAfter);
            await resolve(mapping);
            // Atomic storage predicate: repeated direct reads cannot prove that
            // the alias remained active/current through commit. No renewal/write.
            tx.requireBatchReference(mapping);
            const result = await task(tx);
            await resolve(mapping); life.now();
            return result;
          }));
        },
      });
      const result = await life.run(() => inbox.listBatch({ analysisOperationId: mapping.analysisOperationId }));
      await resolve(mapping);
      if (boundaryFailure !== null) throw boundaryFailure;
      if (!result.ok) return failure(serviceError(result.code));
      const batch = projectCandidateBatch(result.value, life.now());
      const serialized = JSON.stringify({ ok: true, value: { batchReference, batch } });
      if (new TextEncoder().encode(serialized).byteLength > MAX_INBOX_RESPONSE_BYTES) return failure("API_UNAVAILABLE");
      const finalTime = life.now();
      // No await after projection. If serialization itself crosses a pending
      // access deadline, suppress the whole stale payload; an explicit new read
      // can return expired/null. This is not deletion or authority revocation.
      if (batch.candidates.some((row) => row.state === "pending" && row.accessExpiresAt <= finalTime)) {
        return failure("API_CONFLICT");
      }
      return new Response(serialized, { status: 200, headers: reply(null, 200).headers });
    } catch (error) {
      try { lifetime?.now(); } catch (expired) { return failure(errorCode(expired)); }
      return failure(errorCode(error));
    } finally { lifetime?.finish(); cancelUnreadBody(request); }
  };
}
