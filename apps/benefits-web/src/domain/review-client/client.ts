/**
 * Browser review transport composition, NOT mounted UI/auth/provider wiring.
 * No ambient Fetch, storage, cookie parsing, logging or automatic retry.
 * Runtime /api/review still denies requests with 503. Trusted adapters only.
 */
import { snapshotReviewRequest, type ReviewRequest } from "./requests.ts";
import { decodeReviewError, decodeReviewSuccess, type ReviewHttpErrorCode, type ReviewSuccess } from "./responses.ts";

export const REVIEW_REQUEST_HEADER = "review-v1" as const;
export const MAX_REVIEW_RESPONSE_BODY_BYTES = 1048576;
export const MAX_REVIEW_CLIENT_REQUEST_BYTES = 16384;
export const DEFAULT_REVIEW_TIMEOUT_MS = 10000;

export interface ReviewTransport { (request: Request, signal: AbortSignal): Promise<Response> }
export interface ReviewViewContext {
  /** Fresh namespace on every verified account/session/view reset. Not authority. */
  readonly viewScope: string;
  readonly dataGeneration: number;
}
export interface ReviewClientConfig {
  readonly origin: string;
  readonly fetch: ReviewTransport;
  /** Trusted synchronous snapshot reader; must not mutate authority or commands. */
  readonly readViewContext: () => ReviewViewContext | null;
  readonly timeoutMs?: number;
  /** Trusted side-effect-free wall clock; must not change view state. Defaults to Date.now. */
  readonly now?: () => number;
}
export type ReviewCallFailure =
  | { readonly kind: "error"; readonly code: ReviewHttpErrorCode; readonly retriableAfterMs: number | null }
  | { readonly kind: "invalid"; readonly reason: "REQUEST" | "STATUS" | "BODY" | "HEADERS" | "ENVELOPE" | "CLOCK" }
  | { readonly kind: "stale" | "timeout" | "aborted" | "network" };
export interface ReviewCallSuccess {
  readonly kind: "success";
  readonly capturedScope: ReviewViewContext;
  readonly success: ReviewSuccess;
}
export type ReviewCallResult = ReviewCallSuccess | ReviewCallFailure;

function invalidConfiguration(): never { throw new Error("REVIEW_CLIENT_CONFIG_INVALID"); }
function configure(config: ReviewClientConfig) {
  try {
    const url = new URL(config.origin);
    if (url.origin !== config.origin || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || (url.protocol !== "https:" && !(url.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) invalidConfiguration();
    const timeoutMs = config.timeoutMs === undefined ? DEFAULT_REVIEW_TIMEOUT_MS : config.timeoutMs;
    const now = config.now === undefined ? Date.now : config.now;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_REVIEW_TIMEOUT_MS
      || typeof config.fetch !== "function" || typeof config.readViewContext !== "function" || typeof now !== "function") {
      invalidConfiguration();
    }
    return Object.freeze({ origin: url.origin, fetch: config.fetch, readViewContext: config.readViewContext, timeoutMs, now });
  } catch { return invalidConfiguration(); }
}
function viewContext(read: ReviewClientConfig["readViewContext"]): ReviewViewContext | null {
  try {
    const value: unknown = read();
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 2 || !keys.includes("viewScope") || !keys.includes("dataGeneration")) return null;
    const scope = descriptors.viewScope, generation = descriptors.dataGeneration;
    if (!scope || !Object.hasOwn(scope, "value") || !scope.enumerable || !generation
      || !Object.hasOwn(generation, "value") || !generation.enumerable || typeof scope.value !== "string"
      || scope.value.trim() !== scope.value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope.value)
      || !Number.isSafeInteger(generation.value) || generation.value < 1) return null;
    return Object.freeze({ viewScope: scope.value as string, dataGeneration: generation.value as number });
  } catch { return null; }
}
function sameContext(a: ReviewViewContext, b: ReviewViewContext | null) {
  return b !== null && a.viewScope === b.viewScope && a.dataGeneration === b.dataGeneration;
}
const TIMEOUT = Symbol("review-timeout"), ABORTED = Symbol("review-aborted"), STALE = Symbol("review-stale");
const CLOCK = Symbol("review-clock"), BODY = Symbol("review-body");
function createLifetime(timeoutMs: number, now: () => number, caller?: AbortSignal) {
  const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
  // Brand check occurs before creating listeners or timers.
  const initiallyAborted = caller !== undefined && nativeAborted.call(caller) as boolean;
  const controller = new AbortController(), deadline = performance.now() + timeoutMs;
  let reason: typeof TIMEOUT | typeof ABORTED | undefined;
  let lastTime: number | undefined;
  function stop(value: typeof TIMEOUT | typeof ABORTED) {
    if (reason !== undefined) return;
    reason = value; controller.abort();
  }
  function check() {
    if (performance.now() >= deadline) stop(TIMEOUT);
    // Cleanup can synchronously cancel the caller after its listener is removed.
    // Observe the native signal through the final delivery check as well.
    else if (caller !== undefined && nativeAborted.call(caller)) stop(ABORTED);
    if (reason !== undefined) throw reason;
  }
  const onAbort = () => stop(performance.now() >= deadline ? TIMEOUT : ABORTED);
  if (caller !== undefined) EventTarget.prototype.addEventListener.call(caller, "abort", onAbort, { once: true });
  const timer = setTimeout(() => stop(TIMEOUT), timeoutMs);
  if (initiallyAborted) onAbort();
  return {
    signal: controller.signal, check,
    time() {
      check();
      let value: unknown;
      try { value = now(); } catch { throw CLOCK; }
      check();
      if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)
        || value < 0 || value > 253402300799999 || (lastTime !== undefined && value < lastTime)) throw CLOCK;
      lastTime = value; return value;
    },
    async wait<T>(pending: Promise<T>): Promise<T> {
      let rejectStopped!: (reason: unknown) => void;
      const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
      const onStop = () => rejectStopped(reason);
      controller.signal.addEventListener("abort", onStop, { once: true });
      // Attach pending outcomes before checking, including late adapter rejection.
      const raced = Promise.race([pending, stopped]);
      if (performance.now() >= deadline) stop(TIMEOUT);
      if (controller.signal.aborted) onStop();
      try { const result = await raced; check(); return result; }
      finally { controller.signal.removeEventListener("abort", onStop); }
    },
    close() {
      clearTimeout(timer);
      if (caller !== undefined) EventTarget.prototype.removeEventListener.call(caller, "abort", onAbort);
      // Cooperative cleanup, not proof that a detached adapter/server write stopped.
      controller.abort();
    },
  };
}
function discard(response: Response | undefined) {
  try { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined); }
  catch { /* No untrusted cleanup detail escapes. */ }
}
async function readBody(response: Response, lifetime: ReturnType<typeof createLifetime>, check: () => void) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, complete = false;
  try {
    if (response.body === null) throw BODY;
    reader = response.body.getReader();
    const bytes = new Uint8Array(MAX_REVIEW_RESPONSE_BODY_BYTES);
    let length = 0, reads = 0;
    while (true) {
      check();
      const part = await lifetime.wait(reader.read());
      check();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > bytes.length - length) throw BODY;
      bytes.set(part.value, length); length += part.value.byteLength;
      if (++reads % 64 === 0) {
        let yieldTimer: ReturnType<typeof setTimeout> | undefined;
        try { await lifetime.wait(new Promise<void>((resolve) => { yieldTimer = setTimeout(resolve, 0); })); }
        finally { if (yieldTimer !== undefined) clearTimeout(yieldTimer); }
      }
    }
    const declared = response.headers.get("content-length"), encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    // Native Fetch can decompress yet preserve compressed Content-Length.
    if ((encoding === undefined || encoding === "identity") && declared !== null && Number(declared) !== length) throw BODY;
    complete = true; return bytes.subarray(0, length);
  } catch (error) { check(); if (error === CLOCK) throw error; throw BODY; }
  finally {
    if (reader) {
      if (!complete) try { void reader.cancel().catch(() => undefined); } catch { /* Best effort, not awaited. */ }
      try { reader.releaseLock(); } catch { /* A broken source cannot override the result. */ }
    }
  }
}

export function createReviewClient(config: ReviewClientConfig) {
  const settings = configure(config);
  // Same-object command fence. New objects/clients bypass this local identity;
  // callers still need a scoped command owner and must discard old UI references.
  const commands = new WeakMap<ReviewRequest, { context: ReviewViewContext; json: string; action: ReviewRequest["action"] }>();
  return async function call(request: ReviewRequest, signal?: AbortSignal): Promise<ReviewCallResult> {
    const observedContext = viewContext(settings.readViewContext);
    if (observedContext === null) return Object.freeze({ kind: "stale" });
    const context: ReviewViewContext = observedContext;
    let captured: ReviewRequest, json: string;
    try {
      captured = snapshotReviewRequest(request); json = JSON.stringify(captured.body);
      if (new TextEncoder().encode(json).byteLength > MAX_REVIEW_CLIENT_REQUEST_BYTES) throw BODY;
    } catch { return Object.freeze({ kind: "invalid", reason: "REQUEST" }); }
    const previous = commands.get(request);
    if (previous && !sameContext(previous.context, context)) return Object.freeze({ kind: "stale" });
    if (previous && (previous.action !== captured.action || previous.json !== json)) return Object.freeze({ kind: "invalid", reason: "REQUEST" });
    if (captured.action === "list" && captured.body.cursor !== null
      && captured.body.cursor.dataGeneration !== context.dataGeneration) return Object.freeze({ kind: "invalid", reason: "REQUEST" });
    let lifetime: ReturnType<typeof createLifetime>;
    try { lifetime = createLifetime(settings.timeoutMs, settings.now, signal); }
    catch { return Object.freeze({ kind: "invalid", reason: "REQUEST" }); }
    commands.set(request, { context, json, action: captured.action });
    const url = settings.origin + "/api/review/" + captured.action;
    let response: Response | undefined;
    function check() {
      lifetime.check();
      if (!sameContext(context!, viewContext(settings.readViewContext))) throw STALE;
      const time = lifetime.time();
      // Trusted clocks can still be test/reentrant adapters. A context changed
      // while sampling time must not be labelled as the captured context.
      if (!sameContext(context!, viewContext(settings.readViewContext))) throw STALE;
      lifetime.check();
      return time;
    }
    function finish(result: ReviewCallResult): ReviewCallResult { check(); return Object.freeze(result); }
    function classify(error: unknown): ReviewCallFailure {
      if (error === STALE || !sameContext(context!, viewContext(settings.readViewContext))) return Object.freeze({ kind: "stale" });
      try { lifetime.check(); } catch (stopped) { return Object.freeze({ kind: stopped === TIMEOUT ? "timeout" : "aborted" }); }
      return Object.freeze({ kind: "invalid", reason: error === CLOCK ? "CLOCK" : "BODY" });
    }
    async function perform(): Promise<ReviewCallResult> {
      try {
        check();
        const pending = settings.fetch(new Request(url, { method: "POST",
          headers: { "content-type": "application/json", "x-keyatlas-request": REVIEW_REQUEST_HEADER },
          credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
          body: json, signal: lifetime.signal }), lifetime.signal);
        response = await lifetime.wait(pending.then((arrived) => {
          // Assign before wait's post-await timeout check to avoid unread-body leaks.
          response = arrived;
          if (lifetime.signal.aborted) discard(arrived);
          return arrived;
        }));
      } catch (error) { check(); if (error === CLOCK) throw error; return finish({ kind: "network" }); }
      check();
      if (response === undefined) return finish({ kind: "invalid", reason: "STATUS" });
      if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status > 599) {
        return finish({ kind: "invalid", reason: "STATUS" });
      }
      const type = response.headers.get("content-type"), length = response.headers.get("content-length");
      if (response.redirected || (response.url !== "" && response.url !== url) || response.headers.has("set-cookie")
        || type === null || !/^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/i.test(type)
        || !response.headers.get("cache-control")?.split(",").some((part) => part.trim().toLowerCase() === "no-store")
        || (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REVIEW_RESPONSE_BODY_BYTES))) {
        return finish({ kind: "invalid", reason: "HEADERS" });
      }
      const bytes = await readBody(response, lifetime, check);
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
      catch { return finish({ kind: "invalid", reason: "BODY" }); }
      check();
      if (response.status !== 200) {
        const code = decodeReviewError(payload, response.status);
        if (code === null) return finish({ kind: "invalid", reason: "ENVELOPE" });
        if (response.status === 429) {
          const retry = response.headers.get("retry-after");
          if (retry === null || !/^\d+$/.test(retry) || Number(retry) < 1 || Number(retry) > 60) {
            return finish({ kind: "invalid", reason: "HEADERS" });
          }
          return finish({ kind: "error", code, retriableAfterMs: Number(retry) * 1000 });
        }
        return finish({ kind: "error", code, retriableAfterMs: null });
      }
      const success = decodeReviewSuccess(payload, captured, context.dataGeneration, lifetime.time());
      check();
      if (success === null) return finish({ kind: "invalid", reason: "ENVELOPE" });
      return finish({ kind: "success", capturedScope: context, success });
    }
    let result: ReviewCallResult;
    try { result = await perform().catch(classify); }
    finally {
      // Abort/cancel can synchronously call trusted adapter listeners. Complete
      // owned cleanup BEFORE deciding which scope may receive this result.
      lifetime.close(); discard(response);
    }
    try {
      lifetime.check();
      if (!sameContext(context, viewContext(settings.readViewContext))) throw STALE;
      // Last user-port call on successful delivery. Read clock AFTER final
      // context/cleanup, not before a potentially time-consuming context read.
      // These trusted ports are observational: arbitrary malicious alternating
      // side effects cannot be made atomic by finitely re-reading two callbacks.
      const deliveryTime = lifetime.time();
      if (result.kind === "success" && result.success.kind === "preview"
        && result.success.preview.expiresAt <= deliveryTime) return Object.freeze({ kind: "invalid", reason: "ENVELOPE" });
      return result;
    } catch (error) { return classify(error); }
  };
}
