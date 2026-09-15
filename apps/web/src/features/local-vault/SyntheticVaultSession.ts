import {
  SYNTHETIC_TOOL_ERROR_CODES_V1, SYNTHETIC_TOOL_FILTERS_V1, SYNTHETIC_TOOL_MAX_RESULTS,
  SYNTHETIC_TOOL_QUERY_MAX_BYTES, SyntheticCatalogToolCatalogResultV1, SyntheticCatalogToolErrorResultV1,
  SyntheticCatalogToolResultV1, SyntheticFilterCatalogActionV1,
  SyntheticSearchCatalogActionV1, SyntheticToolActionV1,
  SyntheticToolFilterV1,
  CATALOG_ERROR_CODES_V1,
  CatalogAdapterError,
  type LocalCatalogEntryV1,
} from "../../bridge/catalogProtocol";
import {
  SyntheticStorageError,
  type SyntheticCiphertextStore,
} from "../../storage/SyntheticCiphertextStore";

export interface SyntheticVaultWorker {
  create(): Promise<Uint8Array>;
  open(bytes: Uint8Array): Promise<readonly LocalCatalogEntryV1[]>;
  cancel(): void;
}

export interface SyntheticVaultSessionState {
  readonly phase: "locked" | "busy" | "empty" | "open" | "error";
  readonly entries: readonly LocalCatalogEntryV1[];
  readonly errorCode: string | null;
}

const EMPTY_ENTRIES: readonly LocalCatalogEntryV1[] = Object.freeze([]);
const STORAGE_ERROR_CODES = new Set([
  "unavailable", "blocked", "incompatible", "corrupt", "invalid-bytes",
  "quota", "aborted", "failed",
]);
const CATALOG_ERROR_CODES = new Set<string>(CATALOG_ERROR_CODES_V1);
const SYNTHETIC_TOOL_ERROR_CODES = new Set<string>(SYNTHETIC_TOOL_ERROR_CODES_V1);

function emptyState(phase: "locked" | "busy" | "empty" | "error", errorCode: string | null = null): SyntheticVaultSessionState {
  return Object.freeze({ phase, entries: EMPTY_ENTRIES, errorCode });
}

function fixedErrorCode(error: unknown): string {
  try {
    if (error instanceof CatalogAdapterError) {
      const code = error.code;
      if (CATALOG_ERROR_CODES.has(code)) return code;
    }
    if (error instanceof SyntheticStorageError) {
      const code = error.code;
      if (STORAGE_ERROR_CODES.has(code)) return code;
    }
  } catch {
    // A thrown proxy or a hostile error-code accessor is still untrusted data.
  }
  return "OPERATION_FAILED";
}

/** Snapshot only the locally displayable fields; never retain worker-owned rows. */
function snapshotEntries(entries: readonly LocalCatalogEntryV1[]): readonly LocalCatalogEntryV1[] {
  return Object.freeze(entries.map((entry) => Object.freeze({
    reference: entry.reference,
    itemName: entry.itemName,
    providerName: entry.providerName,
    credentialType: entry.credentialType,
    status: entry.status,
    connectionCount: entry.connectionCount,
    secretFieldCount: entry.secretFieldCount,
    mcpConnectionCount: entry.mcpConnectionCount,
    connections: Object.freeze(entry.connections.map((connection) => Object.freeze({
      label: connection.label,
      consumerType: connection.consumerType,
    }))),
  })));
}

/**
 * Owns one synthetic local-vault UI session. Lock invalidates every pending
 * continuation; a write already committing may finish ciphertext-only, but can
 * never repopulate this session. JS strings retained by callers cannot be erased.
 */
export class SyntheticVaultSession {
  readonly #store: SyntheticCiphertextStore;
  readonly #worker: SyntheticVaultWorker;
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #state: SyntheticVaultSessionState = emptyState("locked");

  constructor(store: SyntheticCiphertextStore, worker: SyntheticVaultWorker) {
    this.#store = store;
    this.#worker = worker;
  }

  get state(): SyntheticVaultSessionState { return this.#state; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async create(): Promise<void> { await this.#run(true); }
  async open(): Promise<void> { await this.#run(false); }
  async executeTool(action: SyntheticToolActionV1 | unknown): Promise<SyntheticCatalogToolResultV1> {
    const generation = this.#generation;
    await Promise.resolve();
    if (!this.#isCurrent(generation)) return { kind: "error", code: "VAULT_LOCKED" };
    try {
      if (!isSyntheticToolAction(action)) {
        return { kind: "error", code: "INVALID_TOOL" };
      }
      if (!this.#isCurrent(generation)) return { kind: "error", code: "VAULT_LOCKED" };
      switch (action.op) {
        case "search_catalog":
          return executeSearch(action, this.#state.phase, this.#state.entries, this.#isCurrent(generation));
        case "filter_catalog":
          return executeFilter(action, this.#state.phase, this.#state.entries, this.#isCurrent(generation));
        case "lock_vault":
          this.lock();
          return { kind: "ok", action: "lock_vault" };
        default:
          return { kind: "error", code: "INVALID_TOOL" };
      }
    } catch (error: unknown) {
      if (!this.#isCurrent(generation)) return { kind: "error", code: "VAULT_LOCKED" };
      return fixedToolErrorCode(error);
    }
  }

  lock(): void {
    this.#generation += 1;
    this.#state = emptyState("locked");
    try { this.#worker.cancel(); } catch { /* Cleared state stays locked even if cleanup fails. */ }
    this.#notify();
  }

  async #run(allowCreation: boolean): Promise<void> {
    const generation = ++this.#generation;
    this.#state = emptyState("busy");
    try {
      this.#worker.cancel();
      this.#notify();
      if (!this.#isCurrent(generation)) return;

      let bytes = await this.#store.read();
      if (!this.#isCurrent(generation)) return;
      if (bytes === null && allowCreation) {
        const candidate = await this.#worker.create();
        if (!this.#isCurrent(generation)) return;
        await this.#store.createIfAbsent(candidate);
        if (!this.#isCurrent(generation)) return;
        // Another tab may have won the atomic create. Always open the saved
        // archive, never the uncommitted candidate or an in-memory substitute.
        bytes = await this.#store.read();
        if (!this.#isCurrent(generation)) return;
        if (bytes === null) throw new Error("OPERATION_FAILED");
      }

      if (bytes === null) {
        this.#state = emptyState("empty");
      } else {
        const entries = await this.#worker.open(bytes);
        if (!this.#isCurrent(generation)) return;
        const snapshot = snapshotEntries(entries);
        if (!this.#isCurrent(generation)) return;
        this.#state = Object.freeze({ phase: "open", entries: snapshot, errorCode: null });
      }
      this.#notify();
    } catch (error: unknown) {
      if (!this.#isCurrent(generation)) return;
      const errorCode = fixedErrorCode(error);
      if (!this.#isCurrent(generation)) return;
      this.#state = emptyState("error", errorCode);
      this.#notify();
    }
  }

  #isCurrent(generation: number): boolean { return generation === this.#generation; }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* UI subscribers cannot corrupt the storage operation. */ }
    }
  }
}

function isSyntheticToolAction(value: unknown): value is SyntheticToolActionV1 {
  const operation = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { op?: unknown }).op
    : undefined;
  return operation === "search_catalog" || operation === "filter_catalog" || operation === "lock_vault";
}

function filterCatalogRows(
  entries: readonly LocalCatalogEntryV1[],
  filter: SyntheticToolFilterV1,
): readonly LocalCatalogEntryV1[] {
  if (filter === "no_connection") {
    return entries.filter((entry) => entry.connectionCount === 0);
  }
  if (filter === "mcp_connection") {
    return entries.filter((entry) => entry.mcpConnectionCount > 0);
  }
  return entries;
}

function executeSearch(
  action: SyntheticSearchCatalogActionV1,
  phase: SyntheticVaultSessionState["phase"],
  entries: readonly LocalCatalogEntryV1[],
  isCurrent: boolean,
): SyntheticCatalogToolCatalogResultV1 | SyntheticCatalogToolErrorResultV1 {
  if (phase !== "open") return { kind: "error", code: "VAULT_LOCKED" };
  if (!isCurrent) return { kind: "error", code: "VAULT_LOCKED" };

  if (typeof action.query !== "string" || action.query.length > SYNTHETIC_TOOL_QUERY_MAX_BYTES) {
    return { kind: "error", code: "INVALID_PAYLOAD" };
  }
  if (
    action.maxResults !== undefined &&
    (typeof action.maxResults !== "number" ||
      !Number.isSafeInteger(action.maxResults) ||
      action.maxResults < 0 ||
      action.maxResults > SYNTHETIC_TOOL_MAX_RESULTS)
  ) {
    return { kind: "error", code: "LIMIT_EXCEEDED" };
  }

  const query = action.query.trim();
  const lowerQuery = query.toLowerCase();
  const limit = action.maxResults ?? SYNTHETIC_TOOL_MAX_RESULTS;
  const matches = entries.filter((entry) => {
    if (lowerQuery.length === 0) return true;
    const provider = entry.providerName.toLowerCase();
    const item = entry.itemName.toLowerCase();
    return provider.includes(lowerQuery) || item.includes(lowerQuery);
  });
  if (!isCurrent) return { kind: "error", code: "VAULT_LOCKED" };
  const matched = Object.freeze(
    Object.isFrozen(matches) || matches.length === 0 ? matches : matches.slice(0, limit),
  );
  return {
    kind: "catalog",
    count: matched.length,
    filter: "all",
    query,
    entries: matched,
  };
}

function executeFilter(
  action: SyntheticFilterCatalogActionV1,
  phase: SyntheticVaultSessionState["phase"],
  entries: readonly LocalCatalogEntryV1[],
  isCurrent: boolean,
): SyntheticCatalogToolCatalogResultV1 | SyntheticCatalogToolErrorResultV1 {
  if (phase !== "open") return { kind: "error", code: "VAULT_LOCKED" };
  if (!isCurrent) return { kind: "error", code: "VAULT_LOCKED" };
  if (!SYNTHETIC_TOOL_FILTERS_V1.some((value) => value === action.filter)) {
    return { kind: "error", code: "INVALID_PAYLOAD" };
  }

  const filtered = filterCatalogRows(entries, action.filter);
  if (!isCurrent) return { kind: "error", code: "VAULT_LOCKED" };

  return {
    kind: "catalog",
    count: filtered.length,
    filter: action.filter,
    query: "",
    entries: Object.freeze([...filtered]),
  };
}

function fixedToolErrorCode(error: unknown): SyntheticCatalogToolErrorResultV1 {
  if (error instanceof Object && "code" in (error as Record<string, unknown>)) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && SYNTHETIC_TOOL_ERROR_CODES.has(code)) {
      return { kind: "error", code };
    }
  }
  return { kind: "error", code: "OPERATION_FAILED" };
}
