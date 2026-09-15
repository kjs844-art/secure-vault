import type { SyntheticCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import { MAX_SYNTHETIC_ARCHIVE_BYTES } from "../../storage/SyntheticCiphertextStore";
import type { SyntheticVaultWorker } from "./SyntheticVaultSession";

export const SYNTHETIC_BACKUP_FILENAME = "keyatlas-synthetic-v1.katldemo";
const MAGIC = new Uint8Array([75, 65, 84, 76, 68, 69, 77, 79]); // KATLDEMO
const LEGACY_SYNTHETIC_RECORD_COUNT = 3;
const MAX_SYNTHETIC_RECORD_COUNT = 128;
const ERROR_MESSAGES = {
  EMPTY: "No synthetic archive is saved.",
  EXISTS: "A local archive already exists and has been preserved.",
  INVALID_BACKUP: "This is not a supported synthetic backup.",
  UNSUPPORTED_VERSION: "This synthetic backup version is not supported.",
  LIMIT_EXCEEDED: "Synthetic backups must not exceed 524288 bytes.",
  VALIDATION_FAILED: "The synthetic backup could not be authenticated.",
  STORAGE_FAILED: "Local storage failed; no automatic repair was attempted.",
  READBACK_FAILED: "Saved bytes could not be confirmed; no repair was attempted.",
  CANCELLED: "The synthetic backup operation was cancelled.",
  BUSY: "A synthetic backup operation is already running.",
} as const;

export type SyntheticBackupErrorCode = keyof typeof ERROR_MESSAGES;

export class SyntheticBackupError extends Error {
  readonly code: SyntheticBackupErrorCode;
  constructor(code: SyntheticBackupErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SyntheticBackupError";
    this.code = code;
  }
}

/** Cheap identification only. Existing Rust/WASM remains the full validator. */
function snapshotArchive(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    throw new SyntheticBackupError("INVALID_BACKUP");
  }
  if (value.byteLength > MAX_SYNTHETIC_ARCHIVE_BYTES) {
    throw new SyntheticBackupError("LIMIT_EXCEEDED");
  }
  if (value.byteLength < 16) throw new SyntheticBackupError("INVALID_BACKUP");
  const bytes = new Uint8Array(value);
  if (!MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new SyntheticBackupError("INVALID_BACKUP");
  }
  const header = new DataView(bytes.buffer);
  const version = header.getUint32(8, true);
  const count = header.getUint32(12, true);
  if (version !== 1 && version !== 2 && version !== 3) throw new SyntheticBackupError("UNSUPPORTED_VERSION");
  if (count < LEGACY_SYNTHETIC_RECORD_COUNT || count > MAX_SYNTHETIC_RECORD_COUNT
      || (version === 1 && count !== LEGACY_SYNTHETIC_RECORD_COUNT)) {
    throw new SyntheticBackupError("INVALID_BACKUP");
  }
  if (version === 3) {
    if (bytes.byteLength < 20) throw new SyntheticBackupError("INVALID_BACKUP");
    const revisions = header.getUint32(16, true);
    if (revisions < count || revisions > 512) throw new SyntheticBackupError("INVALID_BACKUP");
  }
  // v3 retains historical revisions. Header acceptance does not authenticate
  // framing, head indexes or any records; the existing Worker/Rust path does.
  return bytes;
}

/**
 * Synthetic-only ciphertext transport, not account recovery or secret export.
 * Never creates keys, exposes metadata, replaces archives, or repairs storage.
 * Cancellation cannot undo an already-started IndexedDB commit.
 */
export class SyntheticVaultBackup {
  readonly #store: SyntheticCiphertextStore;
  readonly #worker: Pick<SyntheticVaultWorker, "open" | "cancel">;
  #generation = 0;
  #busy = false;

  constructor(store: SyntheticCiphertextStore, worker: Pick<SyntheticVaultWorker, "open" | "cancel">) {
    this.#store = store;
    this.#worker = worker;
  }

  cancel(): void {
    this.#generation += 1;
    this.#busy = false;
    try { this.#worker.cancel(); } catch { /* Cancellation still invalidates every continuation. */ }
  }

  async exportArchive(): Promise<Uint8Array> {
    return this.#run(async (check) => {
      const stored = await this.#storage(() => this.#store.read());
      check();
      if (stored === null) throw new SyntheticBackupError("EMPTY");
      const snapshot = snapshotArchive(stored);
      await this.#validate(snapshot);
      check();
      return snapshot;
    });
  }

  async restoreArchive(input: Uint8Array): Promise<void> {
    return this.#run(async (check) => {
      // Copy before the first await: the file buffer may be changed by its owner.
      const snapshot = snapshotArchive(input);
      const existing = await this.#storage(() => this.#store.read());
      check();
      if (existing !== null) throw new SyntheticBackupError("EXISTS");
      await this.#validate(snapshot);
      check();
      // Atomic add preserves another tab's winner, even after our empty read.
      const outcome = await this.#storage(() => this.#store.createIfAbsent(new Uint8Array(snapshot)));
      check();
      if (outcome !== "created") throw new SyntheticBackupError("EXISTS");
      const saved = await this.#storage(() => this.#store.read());
      check();
      if (!(saved instanceof Uint8Array) || saved.byteLength !== snapshot.byteLength
          || !snapshot.every((byte, index) => saved[index] === byte)) {
        throw new SyntheticBackupError("READBACK_FAILED");
      }
      // Deliberately stay locked: callers must explicitly open the saved vault.
    });
  }

  async #validate(bytes: Uint8Array): Promise<void> {
    try {
      // The existing Worker authenticates all records. Do not retain its rows.
      await this.#worker.open(new Uint8Array(bytes));
    } catch {
      throw new SyntheticBackupError("VALIDATION_FAILED");
    }
  }

  async #storage<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch { throw new SyntheticBackupError("STORAGE_FAILED"); }
  }

  async #run<T>(operation: (check: () => void) => Promise<T>): Promise<T> {
    if (this.#busy) throw new SyntheticBackupError("BUSY");
    this.#busy = true;
    const generation = ++this.#generation;
    const check = () => {
      if (generation !== this.#generation) throw new SyntheticBackupError("CANCELLED");
    };
    try {
      const result = await operation(check);
      check();
      return result;
    } catch (error: unknown) {
      check();
      // Reconstruct errors: even a tampered instance must not leak its message.
      let code: SyntheticBackupErrorCode = "INVALID_BACKUP";
      try {
        if (error instanceof SyntheticBackupError) {
          const candidate = error.code;
          if (typeof candidate === "string" && Object.hasOwn(ERROR_MESSAGES, candidate)) code = candidate;
        }
      } catch { /* Ignore untrusted accessors. */ }
      check();
      throw new SyntheticBackupError(code);
    } finally {
      if (generation === this.#generation) this.#busy = false;
    }
  }
}
