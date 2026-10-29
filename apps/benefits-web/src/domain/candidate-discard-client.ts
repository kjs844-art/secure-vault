/** Explicit pending-candidate discard transport; no ambient Fetch, persistence,
 * automatic retry, candidate content or server authority. Cancellation and
 * missing acknowledgement never prove that a write was rolled back. */
import type { CandidateBatchContext, CandidateBatchTransport } from "./candidate-batch-client.ts";

export const CANDIDATE_DISCARD_REQUEST_HEADER = "candidate-inbox-discard-v1" as const;
export const MAX_CANDIDATE_DISCARD_RESPONSE_BYTES = 2048;
export const DEFAULT_CANDIDATE_DISCARD_TIMEOUT_MS = 10000;
export interface CandidateDiscardClientConfig {
  readonly origin: string;
  readonly fetch: CandidateBatchTransport;
  /** Trusted synchronous observational reader; a fresh bindingId is host-owned. */
  readonly readContext: () => CandidateBatchContext | null;
  readonly timeoutMs?: number;
  /** Trusted side-effect-free wall clock. Monotonic performance time bounds I/O. */
  readonly now?: () => number;
}
const ERROR_STATUS = Object.freeze({
  API_NOT_FOUND: 404, API_METHOD_NOT_ALLOWED: 405, API_REQUEST_REJECTED: 403,
  API_MEDIA_TYPE: 415, API_BODY_TOO_LARGE: 413, API_INPUT_INVALID: 400,
  API_AUTH_REQUIRED: 401, API_SESSION_CHANGED: 403, API_RATE_LIMITED: 429,
  API_CONFLICT: 409, API_UNAVAILABLE: 503, API_TIMEOUT: 408, API_ABORTED: 408,
});
export type CandidateDiscardHttpErrorCode = keyof typeof ERROR_STATUS;
export interface CandidateDiscardRequest {
  readonly batchReference: string;
  readonly candidateId: string;
  readonly expectedRevision: number;
  readonly decision: "discard";
}
export interface CandidateDiscardReceipt {
  readonly batchReference: string;
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly state: "deleted";
  readonly content: null;
}
export type CandidateDiscardFailure = (
  | Readonly<{ kind: "error"; code: CandidateDiscardHttpErrorCode; retriableAfterMs: number | null }>
  | Readonly<{ kind: "invalid"; reason: "REQUEST" | "STATUS" | "HEADERS" | "BODY" | "ENVELOPE" | "CLOCK" }>
  | Readonly<{ kind: "stale" | "timeout" | "aborted" | "network" }>
) & Readonly<{ dispatched: boolean }>;
export type CandidateDiscardCallResult =
  | Readonly<{ kind: "success"; context: CandidateBatchContext; receipt: CandidateDiscardReceipt }>
  | CandidateDiscardFailure;
export type CandidateDiscardCall = (request: unknown, signal?: AbortSignal) => Promise<CandidateDiscardCallResult>;
export const MAX_CANDIDATE_DISCARD_REQUEST_BYTES = 1024;

function fields(input: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(input), names = Reflect.ownKeys(descriptors);
  if (keys.some((key) => !Object.hasOwn(descriptors, key))
    || names.some((key) => typeof key !== "string" || (!keys.includes(key) && !optional.includes(key)))) throw new Error();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of names as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
function context(read: CandidateDiscardClientConfig["readContext"]): CandidateBatchContext | null {
  try {
    const { bindingId, dataGeneration, batchReference } = fields(read(), ["bindingId", "dataGeneration", "batchReference"]);
    if (!id(bindingId) || !id(batchReference) || typeof dataGeneration !== "number"
      || !Number.isSafeInteger(dataGeneration) || dataGeneration < 1) return null;
    return Object.freeze({ bindingId, dataGeneration, batchReference });
  } catch { return null; }
}
function matches(a: CandidateBatchContext, b: CandidateBatchContext | null) {
  return b !== null && a.bindingId === b.bindingId && a.dataGeneration === b.dataGeneration && a.batchReference === b.batchReference;
}
function configure(input: CandidateDiscardClientConfig) {
  try {
    const raw = fields(input, ["origin", "fetch", "readContext"], ["timeoutMs", "now"]);
    const origin = raw.origin, fetch = raw.fetch, readContext = raw.readContext;
    const timeoutMs = raw.timeoutMs === undefined ? DEFAULT_CANDIDATE_DISCARD_TIMEOUT_MS : raw.timeoutMs;
    const now = raw.now === undefined ? Date.now : raw.now;
    if (typeof origin !== "string" || typeof timeoutMs !== "number") throw new Error();
    const url = new URL(origin);
    if (origin !== url.origin || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      || typeof fetch !== "function" || typeof readContext !== "function" || typeof now !== "function"
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_CANDIDATE_DISCARD_TIMEOUT_MS) throw new Error();
    return Object.freeze({ origin, fetch: fetch as CandidateBatchTransport,
      readContext: readContext as CandidateDiscardClientConfig["readContext"], timeoutMs, now: now as () => number });
  } catch { throw new Error("CANDIDATE_DISCARD_CLIENT_CONFIG_INVALID"); }
}
const TIMEOUT = Symbol(), ABORTED = Symbol(), STALE = Symbol(), CLOCK = Symbol(), BODY = Symbol();
function lifetime(timeoutMs: number, now: () => number, caller?: AbortSignal) {
  const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
  // Native brand check before any timer, listener or network call.
  const initial = caller !== undefined && aborted.call(caller) as boolean;
  const controller = new AbortController(), deadline = performance.now() + timeoutMs;
  let reason: typeof TIMEOUT | typeof ABORTED | undefined, previousTime: number | undefined;
  function stop(value: typeof TIMEOUT | typeof ABORTED) {
    if (reason === undefined) { reason = value; controller.abort(); }
  }
  function check() {
    if (performance.now() >= deadline) stop(TIMEOUT);
    else if (caller !== undefined && aborted.call(caller)) stop(ABORTED);
    if (reason !== undefined) throw reason;
  }
  const onAbort = () => stop(performance.now() >= deadline ? TIMEOUT : ABORTED);
  if (caller !== undefined) EventTarget.prototype.addEventListener.call(caller, "abort", onAbort, { once: true });
  const timer = setTimeout(() => stop(TIMEOUT), timeoutMs);
  if (initial) onAbort();
  return {
    signal: controller.signal, check,
    time() {
      check(); let time: unknown;
      try { time = now(); } catch { throw CLOCK; }
      check();
      if (typeof time !== "number" || !Number.isSafeInteger(time) || Object.is(time, -0)
        || time < 0 || time > 253402300799999 || (previousTime !== undefined && time < previousTime)) throw CLOCK;
      previousTime = time; return time;
    },
    async wait<T>(pending: Promise<T>): Promise<T> {
      let reject!: (reason: unknown) => void;
      const stopped = new Promise<never>((_resolve, no) => { reject = no; });
      const onStop = () => reject(reason);
      controller.signal.addEventListener("abort", onStop, { once: true });
      const raced = Promise.race([pending, stopped]); // Observe detached late rejection too.
      if (performance.now() >= deadline) stop(TIMEOUT);
      if (controller.signal.aborted) onStop();
      try { const result = await raced; check(); return result; }
      finally { controller.signal.removeEventListener("abort", onStop); }
    },
    close(completedSuccess = false) {
      clearTimeout(timer);
      if (caller !== undefined) EventTarget.prototype.removeEventListener.call(caller, "abort", onAbort);
      // A validated response read through EOF has no pending transport to stop.
      // All other paths retain cooperative abort, not a claim of server cancellation.
      if (!completedSuccess) controller.abort();
    },
  };
}
function discard(response: Response | undefined) {
  try { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined); }
  catch { /* No adapter detail escapes. */ }
}
async function body(response: Response, life: ReturnType<typeof lifetime>, check: () => void) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, complete = false;
  try {
    if (response.body === null) throw BODY;
    reader = response.body.getReader();
    const buffer = new Uint8Array(MAX_CANDIDATE_DISCARD_RESPONSE_BYTES);
    let length = 0, reads = 0;
    while (true) {
      check(); const part = await life.wait(reader.read()); check();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > buffer.length - length) throw BODY;
      buffer.set(part.value, length); length += part.value.byteLength;
      if (++reads % 64 === 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await life.wait(new Promise<void>((resolve) => { timer = setTimeout(resolve, 0); })); }
        finally { if (timer !== undefined) clearTimeout(timer); }
      }
    }
    const declared = response.headers.get("content-length"), encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if ((encoding === undefined || encoding === "identity") && declared !== null && Number(declared) !== length) throw BODY;
    complete = true; return buffer.subarray(0, length);
  } catch (error) { check(); if (error === CLOCK) throw error; throw BODY; }
  finally {
    if (reader) {
      if (!complete) try { void reader.cancel().catch(() => undefined); } catch { /* Best effort only. */ }
      try { reader.releaseLock(); } catch { /* A failed source cannot replace the result. */ }
    }
  }
}
export function snapshotCandidateDiscardRequest(input: unknown): CandidateDiscardRequest | null {
  try {
    const raw = fields(input, ["batchReference", "candidateId", "expectedRevision", "decision"]);
    if (!id(raw.batchReference) || !id(raw.candidateId) || raw.decision !== "discard"
      || typeof raw.expectedRevision !== "number" || !Number.isSafeInteger(raw.expectedRevision)
      || raw.expectedRevision < 1) return null;
    return Object.freeze({ batchReference: raw.batchReference, candidateId: raw.candidateId,
      expectedRevision: raw.expectedRevision, decision: "discard" });
  } catch { return null; }
}
function decodeSuccess(input: unknown, expected: CandidateDiscardRequest): CandidateDiscardReceipt | null {
  try {
    const envelope = fields(input, ["ok", "value"]);
    if (envelope.ok !== true) return null;
    const value = fields(envelope.value, ["batchReference", "candidateId", "candidateRevision", "state", "content"]);
    if (value.batchReference !== expected.batchReference || value.candidateId !== expected.candidateId
      || !Number.isSafeInteger(value.candidateRevision) || value.candidateRevision !== expected.expectedRevision + 1
      || value.state !== "deleted" || value.content !== null) return null;
    return Object.freeze({ batchReference: expected.batchReference, candidateId: expected.candidateId,
      candidateRevision: value.candidateRevision as number, state: "deleted", content: null });
  } catch { return null; }
}
function decodeError(input: unknown, status: number): CandidateDiscardHttpErrorCode | null {
  try {
    const envelope = fields(input, ["ok", "code"]);
    if (envelope.ok !== false || typeof envelope.code !== "string" || !Object.hasOwn(ERROR_STATUS, envelope.code)) return null;
    const code = envelope.code as CandidateDiscardHttpErrorCode;
    return ERROR_STATUS[code] === status ? code : null;
  } catch { return null; }
}
export function createCandidateDiscardClient(config: CandidateDiscardClientConfig) {
  const settings = configure(config), url = settings.origin + "/api/inbox/discard";
  return async function discardCandidate(input: unknown, signal?: AbortSignal): Promise<CandidateDiscardCallResult> {
    let dispatched = false;
    const captured = context(settings.readContext);
    if (captured === null) return Object.freeze({ kind: "stale", dispatched });
    const request = snapshotCandidateDiscardRequest(input);
    if (!request || request.batchReference !== captured.batchReference)
      return Object.freeze({ kind: "invalid", reason: "REQUEST", dispatched });
    const wire = JSON.stringify(request);
    if (new TextEncoder().encode(wire).byteLength > MAX_CANDIDATE_DISCARD_REQUEST_BYTES)
      return Object.freeze({ kind: "invalid", reason: "REQUEST", dispatched });
    let life: ReturnType<typeof lifetime>;
    try { life = lifetime(settings.timeoutMs, settings.now, signal); }
    catch { return Object.freeze({ kind: "invalid", reason: "REQUEST", dispatched }); }
    let response: Response | undefined, completedSuccess = false;
    function check() {
      life.check();
      if (!matches(captured!, context(settings.readContext))) throw STALE;
      const time = life.time();
      if (!matches(captured!, context(settings.readContext))) throw STALE;
      life.check(); return time;
    }
    function finish(result: CandidateDiscardCallResult): CandidateDiscardCallResult { check(); return Object.freeze(result); }
    function classify(error: unknown): CandidateDiscardCallResult {
      if (error === STALE || !matches(captured!, context(settings.readContext))) return Object.freeze({ kind: "stale", dispatched });
      try { life.check(); } catch (stopped) { return Object.freeze({ kind: stopped === TIMEOUT ? "timeout" : "aborted", dispatched }); }
      return Object.freeze({ kind: "invalid", reason: error === CLOCK ? "CLOCK" : "BODY", dispatched });
    }
    async function perform(): Promise<CandidateDiscardCallResult> {
      try {
        check();
        const outgoing = new Request(url, { method: "POST", credentials: "same-origin", redirect: "error",
          cache: "no-store", referrerPolicy: "no-referrer", headers: { "content-type": "application/json",
            "x-keyatlas-request": CANDIDATE_DISCARD_REQUEST_HEADER }, body: wire,
          signal: life.signal });
        check();
        // Mark before invoking an injected adapter: even a synchronous throw can
        // follow dispatch. A transport exception cannot establish rollback.
        dispatched = true;
        const pending = settings.fetch(outgoing, life.signal);
        response = await life.wait(pending.then((arrived) => {
          response = arrived; if (life.signal.aborted) discard(arrived); return arrived;
        }));
      } catch (error) { check(); if (error === CLOCK) throw error; return finish({ kind: "network", dispatched }); }
      check();
      if (response === undefined || !Number.isSafeInteger(response.status) || response.status < 200 || response.status > 599)
        return finish({ kind: "invalid", reason: "STATUS", dispatched });
      const type = response.headers.get("content-type"), length = response.headers.get("content-length");
      if (response.redirected || (response.url !== "" && response.url !== url) || response.headers.has("set-cookie")
        || type === null || !/^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/i.test(type)
        || !response.headers.get("cache-control")?.split(",").some((part) => part.trim().toLowerCase() === "no-store")
        || (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_CANDIDATE_DISCARD_RESPONSE_BYTES)))
        return finish({ kind: "invalid", reason: "HEADERS", dispatched });
      const bytes = await body(response, life, check);
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
      catch { return finish({ kind: "invalid", reason: "BODY", dispatched }); }
      if (response.status !== 200) {
        const code = decodeError(payload, response.status);
        if (code === null) return finish({ kind: "invalid", reason: "ENVELOPE", dispatched });
        if (response.status === 429) {
          const retry = response.headers.get("retry-after");
          if (retry === null || !/^\d+$/.test(retry) || Number(retry) < 1 || Number(retry) > 60)
            return finish({ kind: "invalid", reason: "HEADERS", dispatched });
          return finish({ kind: "error", code, retriableAfterMs: Number(retry) * 1000, dispatched });
        }
        return finish({ kind: "error", code, retriableAfterMs: null, dispatched });
      }
      const receipt = decodeSuccess(payload, request!);
      if (receipt === null) return finish({ kind: "invalid", reason: "ENVELOPE", dispatched });
      const success = finish({ kind: "success", context: captured!, receipt });
      // body() returned only after real EOF and the declared byte-length check;
      // decoding and the perform-phase scope/caller/clock fences also passed.
      completedSuccess = true;
      return success;
    }
    let result: CandidateDiscardCallResult;
    try { result = await perform().catch(classify); }
    finally { life.close(completedSuccess); discard(response); }
    try {
      // Cleanup and final clock/context callbacks may revoke the view. No
      // receipt escapes unless all final delivery fences remain current.
      check();
      return result;
    } catch (error) {
      // A final-delivery failure still receives failed-operation cleanup.
      try { life.close(); } catch { /* Cleanup must not replace the fenced failure. */ }
      return classify(error);
    }
  };
}
