/**
 * Bounded in-memory catalog observations. No I/O, authentication or complete
 * list-snapshot claim. The UI owns fresh, never-reused scopes and must discard
 * its old references on logout/account/view reset; returned objects are not
 * revocable and aborting a request cannot undo a server-side commit.
 */
import type { CatalogCallResult, CatalogViewContext } from "./client.ts";
import { decodeCatalogSuccess, type CatalogServiceView, type CatalogSuccess } from "./responses.ts";

export const MAX_CATALOG_VIEW_ENTRIES = 1000;

export interface CatalogViewState extends CatalogViewContext {
  /** Deletion tombstones count toward the bound. Page absence is not deletion. */
  readonly entries: readonly CatalogServiceView[];
  /** Highest accepted page revision, not proof of a full/current dataset. */
  readonly catalogRevision: number | null;
  /** Sticky until a fresh-scope reset. False does NOT certify list freshness. */
  readonly refreshRequired: boolean;
}

export type CatalogViewEvent =
  | { readonly type: "reset"; readonly viewScope: string; readonly dataGeneration: number }
  | { readonly type: "response"; readonly result: CatalogCallResult };

function invalid(): never { throw new Error("CATALOG_VIEW_STATE_INVALID"); }
function descriptors(input: unknown): PropertyDescriptorMap {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  return Object.getOwnPropertyDescriptors(input);
}
function exact(fields: PropertyDescriptorMap, keys: readonly string[]): void {
  const actual = Reflect.ownKeys(fields);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))) invalid();
}
function value(fields: PropertyDescriptorMap, key: string): unknown {
  const field = fields[key];
  if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return invalid();
  return field.value as unknown;
}
function scope(input: unknown): string {
  if (typeof input !== "string" || input.trim() !== input
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)) return invalid();
  return input;
}
function generation(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) return invalid();
  return input;
}

export function createCatalogViewState(viewScope: string, dataGeneration: number): CatalogViewState {
  return Object.freeze({ viewScope: scope(viewScope), dataGeneration: generation(dataGeneration),
    entries: Object.freeze([]), catalogRevision: null, refreshRequired: false });
}

function refresh(state: CatalogViewState): CatalogViewState {
  return state.refreshRequired ? state : Object.freeze({ ...state, refreshRequired: true });
}

function matchesScope(state: CatalogViewState, input: unknown): boolean {
  const fields = descriptors(input);
  exact(fields, ["viewScope", "dataGeneration"]);
  return scope(value(fields, "viewScope")) === state.viewScope
    && generation(value(fields, "dataGeneration")) === state.dataGeneration;
}

function decodeSuccess(input: unknown): CatalogSuccess | null {
  const fields = descriptors(input);
  const kind = value(fields, "kind");
  if (kind === "receipt") {
    exact(fields, ["kind", "receipt"]);
    // Receipts share a schema, including CURRENT-state replay tombstones. This
    // does not repeat request correlation or infer the original mutation action.
    return decodeCatalogSuccess("create", value(fields, "receipt"));
  }
  if (kind === "view") {
    exact(fields, ["kind", "view"]);
    return decodeCatalogSuccess("get", value(fields, "view"));
  }
  if (kind === "page") {
    exact(fields, ["kind", "page"]);
    return decodeCatalogSuccess("list", value(fields, "page"));
  }
  return null;
}

function merge(state: CatalogViewState, incoming: CatalogSuccess): CatalogViewState {
  const rows = incoming.kind === "page" ? incoming.page.services
    : [incoming.kind === "receipt" ? incoming.receipt.service : incoming.view];
  const incomingGeneration = incoming.kind === "page" ? incoming.page.dataGeneration : rows[0]!.dataGeneration;
  if (incomingGeneration !== state.dataGeneration) return state;
  if (incoming.kind === "page" && state.catalogRevision !== null
    && incoming.page.catalogRevision < state.catalogRevision) return refresh(state);

  const positions = new Map(state.entries.map((row, index) => [row.serviceId, index]));
  const newCount = rows.reduce((count, row) => count + (positions.has(row.serviceId) ? 0 : 1), 0);
  // Page decoder has already rejected duplicates. Preflight the entire batch
  // before replacing any row or advancing the accepted page revision.
  if (state.entries.length + newCount > MAX_CATALOG_VIEW_ENTRIES) return refresh(state);

  let entries: CatalogServiceView[] | undefined;
  for (const row of rows) {
    const index = positions.get(row.serviceId);
    if (index !== undefined) {
      const previous = state.entries[index]!;
      if (row.serviceRevision <= previous.serviceRevision
        || (previous.state === "deleted" && row.state === "live")) continue;
    }
    entries ??= [...state.entries];
    if (index === undefined) entries.push(row);
    else entries[index] = row;
  }
  const catalogRevision = incoming.kind === "page" ? incoming.page.catalogRevision : state.catalogRevision;
  // Even replay carries no collection revision. Later partial pages cannot
  // clear this warning; there is deliberately no "completed full list" event.
  const refreshRequired = state.refreshRequired || incoming.kind === "receipt";
  if (!entries && catalogRevision === state.catalogRevision && refreshRequired === state.refreshRequired) return state;
  return Object.freeze({ viewScope: state.viewScope, dataGeneration: state.dataGeneration,
    entries: entries ? Object.freeze(entries) : state.entries, catalogRevision, refreshRequired });
}

/**
 * State must come from this constructor/reducer, not unvalidated persistence.
 * Pass the unchanged client result, NEVER attach the current scope after await.
 * Both captured fields are checked before success data is inspected. Failures
 * preserve observations; no failure result is proof of server-side rollback.
 *
 * The unknown boundary rejects malformed data, but it does not authenticate
 * events or make arbitrary JavaScript/proxies safe. No cursor is retained:
 * pagination sequencing and full snapshot freshness remain caller concerns.
 */
export function reduceCatalogViewState(state: CatalogViewState, event: unknown): CatalogViewState {
  try {
    const fields = descriptors(event);
    const type = value(fields, "type");
    if (type === "reset") {
      exact(fields, ["type", "viewScope", "dataGeneration"]);
      const nextScope = scope(value(fields, "viewScope"));
      // A generation-only reset cannot safely distinguish queued old results.
      if (nextScope === state.viewScope) return state;
      return createCatalogViewState(nextScope, generation(value(fields, "dataGeneration")));
    }
    if (type !== "response") return state;
    exact(fields, ["type", "result"]);
    const result = descriptors(value(fields, "result"));
    // Failure details are deliberately never read or merged into display state.
    if (value(result, "kind") !== "success") return state;
    exact(result, ["kind", "capturedScope", "success"]);
    if (!matchesScope(state, value(result, "capturedScope"))) return state;
    const incoming = decodeSuccess(value(result, "success"));
    return incoming === null ? state : merge(state, incoming);
  } catch {
    return state;
  }
}
