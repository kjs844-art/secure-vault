/**
 * In-memory scope/command owner; not authentication or durable retry storage.
 * No automatic retry, UI routing, persistence or real integration is enabled.
 */
import { createCatalogClient, type CatalogCallResult, type CatalogClientConfig,
  type CatalogViewContext } from "./client.ts";
import { snapshotCatalogRequest, type CatalogRequest } from "./requests.ts";
import { createCatalogViewState, reduceCatalogViewState, type CatalogViewState } from "./view-state.ts";

export const MAX_CATALOG_VIEW_COMMANDS = 64;
declare const commandBrand: unique symbol;
export type CatalogViewCommand = { readonly [commandBrand]: true };
export type CatalogPrepareResult =
  | { readonly kind: "prepared"; readonly command: CatalogViewCommand }
  | { readonly kind: "inactive" | "invalid" | "disposed" | "capacity" };
export type CatalogResetResult = { readonly kind: "active" | "invalid" | "disposed" };
export type CatalogViewControllerConfig = Omit<CatalogClientConfig, "readViewContext">;

interface CommandRecord {
  readonly context: CatalogViewContext;
  readonly request: CatalogRequest;
  running: AbortController | null;
}

function invalidRequest(): CatalogCallResult { return Object.freeze({ kind: "invalid", reason: "REQUEST" }); }
function stale(): CatalogCallResult { return Object.freeze({ kind: "stale" }); }
function key(input: unknown): object | null { return typeof input === "object" && input !== null ? input : null; }

export function createCatalogViewController(config: CatalogViewControllerConfig) {
  let namespace: string;
  try {
    namespace = globalThis.crypto.randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(namespace)) throw new Error();
  } catch { throw new Error("CATALOG_VIEW_CONTROLLER_CONFIG_INVALID"); }

  let context: CatalogViewContext | null = null;
  let state: CatalogViewState | null = null;
  let epoch = 0;
  let disposed = false;
  let transitionDepth = 0;
  let preparedCount = 0;
  let records = new WeakMap<object, CommandRecord>();
  const issued = new WeakSet<object>();
  const flights = new Set<AbortController>();
  const client = createCatalogClient({ ...config, readViewContext: () => context });

  function invalidate(): number {
    // Invalidate before abort: synchronous abort callbacks cannot see old rows
    // or dispatch old commands. Never reuse an epoch, even after invalid reset.
    context = null;
    state = null;
    records = new WeakMap();
    preparedCount = 0;
    if (epoch === Number.MAX_SAFE_INTEGER) disposed = true;
    else epoch++;
    const capturedEpoch = epoch;
    transitionDepth++;
    try { for (const controller of [...flights]) controller.abort(); }
    finally { transitionDepth--; }
    return capturedEpoch;
  }

  function reset(dataGeneration: unknown): CatalogResetResult {
    if (disposed) return Object.freeze({ kind: "disposed" });
    // Reentrant clear/dispose is allowed, but an abort listener cannot undo a
    // logout by activating a new scope inside the transition.
    if (transitionDepth > 0) return Object.freeze({ kind: "invalid" });
    const capturedEpoch = invalidate();
    if (disposed) return Object.freeze({ kind: "disposed" });
    if (epoch !== capturedEpoch || typeof dataGeneration !== "number"
      || !Number.isSafeInteger(dataGeneration) || dataGeneration < 1) return Object.freeze({ kind: "invalid" });
    context = Object.freeze({ viewScope: `catalog:${namespace}:${epoch}`, dataGeneration });
    state = createCatalogViewState(context.viewScope, context.dataGeneration);
    return Object.freeze({ kind: "active" });
  }

  function clear(): void { if (!disposed) invalidate(); }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    invalidate();
  }

  function prepare(input: unknown): CatalogPrepareResult {
    if (disposed) return Object.freeze({ kind: "disposed" });
    const captured = context;
    if (captured === null || transitionDepth > 0) return Object.freeze({ kind: "inactive" });
    if (preparedCount >= MAX_CATALOG_VIEW_COMMANDS) return Object.freeze({ kind: "capacity" });
    let request: CatalogRequest;
    try { request = snapshotCatalogRequest(input); }
    catch { return Object.freeze({ kind: "invalid" }); }
    if (disposed) return Object.freeze({ kind: "disposed" });
    if (context !== captured) return Object.freeze({ kind: "inactive" });
    // Account for synchronous reentrancy during an unknown object's traps.
    if (preparedCount >= MAX_CATALOG_VIEW_COMMANDS) return Object.freeze({ kind: "capacity" });
    const command = Object.freeze({}) as CatalogViewCommand;
    records.set(command, { context: captured, request, running: null });
    issued.add(command);
    preparedCount++;
    return Object.freeze({ kind: "prepared", command });
  }

  async function execute(input: unknown): Promise<CatalogCallResult> {
    const token = key(input);
    if (token === null || !issued.has(token)) return invalidRequest();
    const record = records.get(token);
    if (!record || disposed || context !== record.context) return stale();
    // Explicit same-token retry is supported only after its earlier call ends.
    if (record.running !== null || flights.size >= MAX_CATALOG_VIEW_COMMANDS) return invalidRequest();
    const controller = new AbortController();
    record.running = controller;
    flights.add(controller);
    try {
      let result: CatalogCallResult;
      try { result = await client(record.request, controller.signal); }
      catch { result = Object.freeze({ kind: "invalid", reason: "BODY" }); }
      // Includes failures: an old-account error must not overwrite current UI.
      if (disposed || context !== record.context || records.get(token) !== record || state === null) return stale();
      state = reduceCatalogViewState(state, { type: "response", result });
      return result;
    } finally {
      record.running = null;
      flights.delete(controller);
    }
  }

  function release(input: unknown): void {
    const token = key(input);
    if (token === null) return;
    const record = records.get(token);
    if (!record) return;
    records.delete(token);
    preparedCount--;
    record.running?.abort();
  }

  // UI renders snapshot(), not execute() payloads: results are per-call
  // observations and can be older than a row already retained by the reducer.
  return Object.freeze({ snapshot: (): CatalogViewState | null => state, reset, clear, dispose, prepare, execute, release });
}

// Capacity counts explicit prepared allocations until release/reset, not GC.
// Weak records do not keep abandoned tokens alive. Flights are separately
// bounded until settled; release cannot bypass the concurrent-call cap.
// Returned snapshots/results remain readable by their holders after logout.
