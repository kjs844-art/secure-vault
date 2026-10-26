/**
 * In-memory review command/lease ownership, not authentication or durable retry.
 * No UI mount, automatic decision/retry/operation ID, storage or real integration.
 * Callers must revoke on hide/logout/navigation and still fence UI result apply.
 */
import { createReviewClient, DEFAULT_REVIEW_TIMEOUT_MS, type ReviewClientConfig,
  type ReviewCallResult, type ReviewViewContext, type ReviewTransport } from "./client.ts";
import { snapshotReviewRequest, type ReviewRequest } from "./requests.ts";

export const MAX_REVIEW_PREPARED_COMMANDS = 64;
declare const leaseBrand: unique symbol;
declare const commandBrand: unique symbol;
export type ReviewCommandLease = { readonly [leaseBrand]: true };
export type ReviewPreparedCommand = { readonly [commandBrand]: true };
export type ReviewCommandOwnerConfig = Omit<ReviewClientConfig, "readViewContext">;
export interface ReviewCommandSnapshot extends ReviewViewContext { readonly lease: ReviewCommandLease }
export type ReviewPrepareResult =
  | { readonly kind: "prepared"; readonly command: ReviewPreparedCommand }
  | { readonly kind: "inactive" | "invalid" | "disposed" | "capacity" };
export type ReviewExecuteResult = ReviewCallResult | { readonly kind: "busy" | "consumed" };

interface ActiveView { readonly context: ReviewViewContext; readonly snapshot: ReviewCommandSnapshot }
interface CommandRecord {
  readonly view: ActiveView;
  readonly request: ReviewRequest;
  attempted: boolean;
  running: AbortController | null;
}
function invalidConfiguration(): never { throw new Error("REVIEW_COMMAND_OWNER_CONFIG_INVALID"); }
function configure(input: ReviewCommandOwnerConfig) {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) invalidConfiguration();
    const prototype = Object.getPrototypeOf(input), fields = Object.getOwnPropertyDescriptors(input);
    if (prototype !== Object.prototype && prototype !== null) invalidConfiguration();
    const allowed = ["origin", "fetch", "timeoutMs", "now"];
    for (const key of Reflect.ownKeys(fields)) {
      if (typeof key !== "string" || !allowed.includes(key)) invalidConfiguration();
      const field = fields[key]!;
      if (!field.enumerable || !Object.hasOwn(field, "value")) invalidConfiguration();
    }
    const origin: unknown = fields.origin?.value, fetch: unknown = fields.fetch?.value;
    const timeout: unknown = fields.timeoutMs?.value, now: unknown = fields.now?.value;
    const timeoutMs = timeout === undefined ? DEFAULT_REVIEW_TIMEOUT_MS : timeout;
    if (typeof origin !== "string" || typeof fetch !== "function"
      || typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1 || timeoutMs > DEFAULT_REVIEW_TIMEOUT_MS
      || (now !== undefined && typeof now !== "function")) invalidConfiguration();
    return Object.freeze({ origin, fetch: fetch as ReviewTransport, timeoutMs,
      now: (now === undefined ? Date.now : now) as () => number });
  } catch { return invalidConfiguration(); }
}
function key(input: unknown): object | null { return input !== null && typeof input === "object" ? input : null; }
function stale(): ReviewExecuteResult { return Object.freeze({ kind: "stale" }); }
function invalidRequest(): ReviewExecuteResult { return Object.freeze({ kind: "invalid", reason: "REQUEST" }); }

export function createReviewCommandOwner(config: ReviewCommandOwnerConfig) {
  const settings = configure(config);
  let active: ActiveView | null = null;
  let disposed = false, transitionDepth = 0, preparedCount = 0;
  let activationNumber = 0;
  let activationAttempt: { readonly previousLease: ReviewCommandLease | null } | null = null;
  let records = new WeakMap<object, CommandRecord>();
  const issued = new WeakSet<object>(), flights = new Set<AbortController>();
  let lastTime: number | undefined;
  // One observational clock history spans the client and the owner's await
  // boundary. A rollback does not become valid merely because a call settled.
  function time(): number {
    const value: unknown = settings.now();
    if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)
      || value < 0 || value > 253402300799999 || (lastTime !== undefined && value < lastTime)) {
      throw new Error("REVIEW_COMMAND_CLOCK_INVALID");
    }
    lastTime = value;
    return value;
  }
  // Construction validates configuration but samples no clock/UUID and performs
  // no transport, timer, DOM or subscription work. Runtime crypto is used only
  // on explicit activation, with no predictable fallback on failure.
  let client: ReturnType<typeof createReviewClient>;
  try { client = createReviewClient({ ...settings, now: time, readViewContext: () => active?.context ?? null }); }
  catch { return invalidConfiguration(); }

  function revoke(): void {
    active = null;
    records = new WeakMap();
    preparedCount = 0;
    transitionDepth++;
    try { for (const controller of [...flights]) controller.abort(); }
    finally { transitionDepth--; }
  }
  function activate(dataGeneration: unknown): ReviewCommandLease | null {
    if (disposed || transitionDepth > 0) return null;
    const attempt = { previousLease: active?.snapshot.lease ?? null };
    activationAttempt = attempt;
    transitionDepth++;
    try {
      revoke();
      if (activationNumber === Number.MAX_SAFE_INTEGER) { disposed = true; return null; }
      activationNumber++;
      if (disposed || activationAttempt !== attempt || typeof dataGeneration !== "number"
        || !Number.isSafeInteger(dataGeneration) || dataGeneration < 1) return null;
      let namespace: string;
      try {
        namespace = globalThis.crypto.randomUUID();
        if (typeof namespace !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(namespace)) return null;
      } catch { return null; }
      if (disposed || activationAttempt !== attempt) return null;
      const context = Object.freeze({ viewScope: `review:${namespace}:${activationNumber}`, dataGeneration });
      const lease = Object.freeze({}) as ReviewCommandLease;
      active = { context, snapshot: Object.freeze({ ...context, lease }) };
      return lease;
    } finally {
      if (activationAttempt === attempt) activationAttempt = null;
      transitionDepth--;
    }
  }
  function deactivate(lease: unknown): void {
    if (disposed || lease === null || lease === undefined) return;
    if (active?.snapshot.lease !== lease && activationAttempt?.previousLease !== lease) return;
    activationAttempt = null;
    revoke();
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    activationAttempt = null;
    revoke();
  }
  function current(lease: unknown): ActiveView | null {
    return !disposed && active !== null && active.snapshot.lease === lease ? active : null;
  }
  function prepare(lease: unknown, input: unknown): ReviewPrepareResult {
    if (disposed) return Object.freeze({ kind: "disposed" });
    const view = current(lease);
    if (view === null || transitionDepth > 0) return Object.freeze({ kind: "inactive" });
    if (preparedCount >= MAX_REVIEW_PREPARED_COMMANDS) return Object.freeze({ kind: "capacity" });
    let request: ReviewRequest | null = null;
    transitionDepth++;
    try { request = snapshotReviewRequest(input); }
    catch { /* Fixed invalid result below, without exposing input or trap errors. */ }
    finally { transitionDepth--; }
    if (disposed) return Object.freeze({ kind: "disposed" });
    if (active !== view) return Object.freeze({ kind: "inactive" });
    if (request === null || (request.action === "list" && request.body.cursor !== null
      && request.body.cursor.dataGeneration !== view.context.dataGeneration)) return Object.freeze({ kind: "invalid" });
    const command = Object.freeze({}) as ReviewPreparedCommand;
    records.set(command, { view, request, attempted: false, running: null });
    issued.add(command);
    preparedCount++;
    return Object.freeze({ kind: "prepared", command });
  }
  function retained(token: object, record: CommandRecord): boolean {
    return !disposed && active === record.view && records.get(token) === record;
  }
  async function execute(lease: unknown, input: unknown): Promise<ReviewExecuteResult> {
    const view = current(lease);
    if (view === null || transitionDepth > 0) return stale();
    const token = key(input);
    if (token === null || !issued.has(token)) return invalidRequest();
    const record = records.get(token);
    if (!record || record.view !== view) return stale();
    if (record.running !== null || flights.size >= MAX_REVIEW_PREPARED_COMMANDS) return Object.freeze({ kind: "busy" });
    // Preview/reject have no operation ledger: a consumed handle cannot silently
    // repeat an uncertain command. A deliberate new action requires new prepare.
    if (record.attempted && (record.request.action === "preview" || record.request.action === "reject")) {
      return Object.freeze({ kind: "consumed" });
    }
    const controller = new AbortController();
    record.attempted = true;
    record.running = controller;
    flights.add(controller);
    try {
      let result: ReviewCallResult;
      try { result = await client(record.request, controller.signal); }
      catch { result = Object.freeze({ kind: "invalid", reason: "BODY" }); }
      // An old failure must not overwrite a new view either. No result is stored
      // here; each is a scoped observation, not a reconciled row cache.
      if (!retained(token, record)) return stale();
      if (result.kind === "success") {
        let deliveredAt: number;
        try { deliveredAt = time(); }
        catch {
          return retained(token, record) ? Object.freeze({ kind: "invalid", reason: "CLOCK" }) : stale();
        }
        if (!retained(token, record)) return stale();
        if (result.success.kind === "preview" && result.success.preview.expiresAt <= deliveredAt) {
          return Object.freeze({ kind: "invalid", reason: "ENVELOPE" });
        }
      }
      return result;
    } finally {
      record.running = null;
      flights.delete(controller);
    }
  }
  function release(lease: unknown, input: unknown): void {
    const view = current(lease), token = key(input);
    if (view === null || token === null) return;
    const record = records.get(token);
    if (!record || record.view !== view) return;
    records.delete(token);
    preparedCount--;
    // Remove ownership BEFORE synchronous abort callbacks run.
    transitionDepth++;
    try { record.running?.abort(); }
    finally { transitionDepth--; }
  }
  return Object.freeze({ getSnapshot: (): ReviewCommandSnapshot | null => active?.snapshot ?? null,
    activate, deactivate, dispose, prepare, execute, release });
}

// Capacity counts explicit prepared allocations until release/revoke, not GC.
// Awaited flights stay bounded until settled, including after release/revoke;
// uncooperative detached transports are not proven stopped by local cancellation.
// Retained results/tokens cannot be erased; all token authority is local identity.
export type ReviewCommandOwner = ReturnType<typeof createReviewCommandOwner>;
