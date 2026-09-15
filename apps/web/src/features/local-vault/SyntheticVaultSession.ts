import {
  CATALOG_ERROR_CODES_V1,
  CatalogAdapterError,
  type LocalCatalogEntryV1,
} from "../../bridge/catalogProtocol";
import {
  MAX_SYNTHETIC_ARCHIVE_BYTES,
  SyntheticStorageError,
  type SyntheticCiphertextStore,
  type SyntheticMutableCiphertextStore,
} from "../../storage/SyntheticCiphertextStore";
import { parseSyntheticRegistration, type SyntheticRegistrationSelection } from "./syntheticRegistration";
import { parseSyntheticConnectionEdit, type SyntheticConnectionEditSelection } from "./syntheticConnectionEdit";

export interface SyntheticVaultWorker {
  create(): Promise<Uint8Array>;
  open(bytes: Uint8Array): Promise<readonly LocalCatalogEntryV1[]>;
  cancel(): void;
}

export interface SyntheticRegistrationWorker extends SyntheticVaultWorker {
  append(bytes: Uint8Array, selection: SyntheticRegistrationSelection): Promise<Uint8Array>;
}

export interface SyntheticConnectionEditWorker extends SyntheticVaultWorker {
  editConnections(bytes: Uint8Array, selection: SyntheticConnectionEditSelection): Promise<Uint8Array>;
}

class RegistrationStateError extends Error {
  constructor(readonly code: "REGISTRATION_UNAVAILABLE" | "CONNECTION_EDIT_UNAVAILABLE" | "STORAGE_CONFLICT" | "STORAGE_MISSING") {
    super(code);
  }
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
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), "byteLength",
)!.get!;

function copyArchive(value: Uint8Array): Uint8Array {
  let length: number;
  try {
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new Error();
    // Own byteLength/length properties cannot replace the native view's bounds.
    length = typedArrayByteLength.call(value) as number;
  } catch {
    throw new CatalogAdapterError("INVALID_ARCHIVE");
  }
  if (length < 1) throw new CatalogAdapterError("INVALID_ARCHIVE");
  if (length > MAX_SYNTHETIC_ARCHIVE_BYTES) throw new CatalogAdapterError("LIMITS_EXCEEDED");
  try { return new Uint8Array(value); }
  catch { throw new CatalogAdapterError("INVALID_ARCHIVE"); }
}

function sameArchive(left: Uint8Array, right: Uint8Array): boolean {
  try {
    if (!(left instanceof Uint8Array) || Object.getPrototypeOf(left) !== Uint8Array.prototype
        || !(right instanceof Uint8Array) || Object.getPrototypeOf(right) !== Uint8Array.prototype) return false;
    const length = typedArrayByteLength.call(left) as number;
    if (length < 1 || length > MAX_SYNTHETIC_ARCHIVE_BYTES || length !== typedArrayByteLength.call(right)) return false;
    for (let index = 0; index < length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  } catch { return false; }
}

function emptyState(phase: "locked" | "busy" | "empty" | "error", errorCode: string | null = null): SyntheticVaultSessionState {
  return Object.freeze({ phase, entries: EMPTY_ENTRIES, errorCode });
}

function fixedErrorCode(error: unknown): string {
  try {
    if (error instanceof RegistrationStateError) return error.code;
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
    issuerAccountIdentifier: entry.issuerAccountIdentifier,
    issuerOrganizationOrWorkspace: entry.issuerOrganizationOrWorkspace,
    issuerProject: entry.issuerProject,
    issuerEnvironment: entry.issuerEnvironment,
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
  readonly #store: SyntheticCiphertextStore & Partial<SyntheticMutableCiphertextStore>;
  readonly #worker: SyntheticVaultWorker & Partial<SyntheticRegistrationWorker & SyntheticConnectionEditWorker>;
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #state: SyntheticVaultSessionState = emptyState("locked");
  // Owned, bounded ciphertext only. Never exposed through state, tools, or rows.
  #displayedArchive: Uint8Array | undefined;

  constructor(
    store: SyntheticCiphertextStore & Partial<SyntheticMutableCiphertextStore>,
    worker: SyntheticVaultWorker & Partial<SyntheticRegistrationWorker & SyntheticConnectionEditWorker>,
  ) {
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

  /** No implicit unlock, retry or create. Only the reread/authenticated saved result is shown. */
  async register(input: unknown): Promise<void> {
    if (this.#state.phase !== "open") return;
    const generation = ++this.#generation;
    this.#forgetArchive();
    this.#state = emptyState("busy");
    try {
      this.#worker.cancel();
      this.#notify();
      if (!this.#isCurrent(generation)) return;
      const selection = parseSyntheticRegistration(input);
      if (!this.#isCurrent(generation)) return;
      if (!this.#store.compareAndSwapArchive || !this.#worker.append) {
        throw new RegistrationStateError("REGISTRATION_UNAVAILABLE");
      }
      const before = await this.#store.read();
      if (!this.#isCurrent(generation)) return;
      if (before === null) throw new RegistrationStateError("STORAGE_MISSING");
      // Rust authenticates every existing envelope before producing an append candidate.
      const candidate = await this.#worker.append(before, selection);
      if (!this.#isCurrent(generation)) return;
      const committed = await this.#store.compareAndSwapArchive(before, candidate);
      if (!this.#isCurrent(generation)) return;
      if (committed !== "updated") {
        throw new RegistrationStateError(committed === "missing" ? "STORAGE_MISSING" : "STORAGE_CONFLICT");
      }
      const saved = await this.#store.read();
      if (!this.#isCurrent(generation)) return;
      if (saved === null) throw new RegistrationStateError("STORAGE_MISSING");
      // A later writer may already have changed storage. Do not confirm our candidate
      // based on a different archive or silently retry an ambiguous commit.
      if (!sameArchive(candidate, saved)) {
        throw new RegistrationStateError("STORAGE_CONFLICT");
      }
      const authenticatedArchive = copyArchive(saved);
      if (!this.#isCurrent(generation)) return;
      const entries = await this.#worker.open(new Uint8Array(authenticatedArchive));
      if (!this.#isCurrent(generation)) return;
      const snapshot = snapshotEntries(entries);
      if (!this.#isCurrent(generation)) return;
      this.#displayedArchive = authenticatedArchive;
      this.#state = Object.freeze({ phase: "open", entries: snapshot, errorCode: null });
      this.#notify();
    } catch (error: unknown) {
      if (!this.#isCurrent(generation)) return;
      const code = fixedErrorCode(error);
      if (!this.#isCurrent(generation)) return;
      this.#state = emptyState("error", code);
      this.#notify();
    }
  }

  /**
   * Bind a positional reference to the exact archive used for the selected view.
   * No implicit unlock, retry, overwrite or durable losing-candidate outbox.
   */
  async editConnections(expectedGeneration: number, input: unknown): Promise<void> {
    if (this.#state.phase !== "open" || expectedGeneration !== this.#generation || !this.#displayedArchive) return;
    const before = new Uint8Array(this.#displayedArchive);
    const generation = ++this.#generation;
    this.#forgetArchive();
    this.#state = emptyState("busy");
    try {
      this.#worker.cancel();
      this.#notify();
      if (!this.#isCurrent(generation)) return;
      const selection = parseSyntheticConnectionEdit(input);
      if (!this.#isCurrent(generation)) return;
      if (!this.#store.compareAndSwapArchive || !this.#worker.editConnections) {
        throw new RegistrationStateError("CONNECTION_EDIT_UNAVAILABLE");
      }
      const current = await this.#store.read();
      if (!this.#isCurrent(generation)) return;
      if (current === null) throw new RegistrationStateError("STORAGE_MISSING");
      if (!sameArchive(before, current)) throw new RegistrationStateError("STORAGE_CONFLICT");
      if (!this.#isCurrent(generation)) return;
      // Separate owned copies protect comparison baselines from injected ports.
      const edited = await this.#worker.editConnections(new Uint8Array(before), selection);
      if (!this.#isCurrent(generation)) return;
      const candidate = copyArchive(edited);
      if (!this.#isCurrent(generation)) return;
      const committed = await this.#store.compareAndSwapArchive(new Uint8Array(before), new Uint8Array(candidate));
      if (!this.#isCurrent(generation)) return;
      if (committed !== "updated") {
        throw new RegistrationStateError(committed === "missing" ? "STORAGE_MISSING" : "STORAGE_CONFLICT");
      }
      const saved = await this.#store.read();
      if (!this.#isCurrent(generation)) return;
      if (saved === null) throw new RegistrationStateError("STORAGE_MISSING");
      if (!sameArchive(candidate, saved)) throw new RegistrationStateError("STORAGE_CONFLICT");
      const authenticatedArchive = copyArchive(saved);
      if (!sameArchive(candidate, authenticatedArchive)) throw new RegistrationStateError("STORAGE_CONFLICT");
      if (!this.#isCurrent(generation)) return;
      const entries = await this.#worker.open(new Uint8Array(authenticatedArchive));
      if (!this.#isCurrent(generation)) return;
      const snapshot = snapshotEntries(entries);
      if (!this.#isCurrent(generation)) return;
      this.#displayedArchive = authenticatedArchive;
      this.#state = Object.freeze({ phase: "open", entries: snapshot, errorCode: null });
      this.#notify();
    } catch (error: unknown) {
      if (!this.#isCurrent(generation)) return;
      const code = fixedErrorCode(error);
      if (!this.#isCurrent(generation)) return;
      this.#state = emptyState("error", code);
      this.#notify();
    }
  }

  lock(): void {
    this.#generation += 1;
    this.#forgetArchive();
    this.#state = emptyState("locked");
    try { this.#worker.cancel(); } catch { /* Cleared state stays locked even if cleanup fails. */ }
    this.#notify();
  }

  async #run(allowCreation: boolean): Promise<void> {
    const generation = ++this.#generation;
    this.#forgetArchive();
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
        const authenticatedArchive = copyArchive(bytes);
        if (!this.#isCurrent(generation)) return;
        const entries = await this.#worker.open(new Uint8Array(authenticatedArchive));
        if (!this.#isCurrent(generation)) return;
        const snapshot = snapshotEntries(entries);
        if (!this.#isCurrent(generation)) return;
        this.#displayedArchive = authenticatedArchive;
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

  #forgetArchive(): void {
    this.#displayedArchive?.fill(0);
    this.#displayedArchive = undefined;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* UI subscribers cannot corrupt the storage operation. */ }
    }
  }
}
