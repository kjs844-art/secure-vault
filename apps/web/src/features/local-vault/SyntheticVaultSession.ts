import {
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

  // Ephemeral UI identity only, never a stored record ID or authorization token.
  // A fresh key lets React discard view-local search state even if it batches
  // an intervening lock and reopen into one committed render.
  get viewGeneration(): number { return this.#generation; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async create(): Promise<void> { await this.#run(true); }
  async open(): Promise<void> { await this.#run(false); }

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
