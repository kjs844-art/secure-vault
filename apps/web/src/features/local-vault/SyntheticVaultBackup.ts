import type { SyntheticCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import {
  MAX_SYNTHETIC_ARCHIVE_BYTES,
  MAX_SYNTHETIC_CONFLICT_ARCHIVES,
} from "../../storage/SyntheticCiphertextStore";
import type { SyntheticVaultWorker } from "./SyntheticVaultSession";

export const SYNTHETIC_BACKUP_FILENAME = "keyatlas-synthetic-v1.katldemo";
const MAGIC = new Uint8Array([75, 65, 84, 76, 68, 69, 77, 79]); // KATLDEMO
const LEGACY_SYNTHETIC_RECORD_COUNT = 3;
const MAX_SYNTHETIC_RECORD_COUNT = 128;
const CONFLICT_ID_PATTERN = /^[0-9a-f]{32}$/;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, "byteLength",
)!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, "buffer",
)!.get!;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype, "byteLength",
)!.get!;
const ERROR_MESSAGES = {
  EMPTY: "No synthetic archive is saved.",
  EXISTS: "A local archive already exists and has been preserved.",
  INVALID_BACKUP: "This is not a supported synthetic backup.",
  UNSUPPORTED_VERSION: "This synthetic backup version is not supported.",
  LIMIT_EXCEEDED: "Synthetic backups must not exceed 524288 bytes.",
  VALIDATION_FAILED: "The synthetic backup could not be authenticated.",
  STORAGE_FAILED: "Local storage failed; no automatic repair was attempted.",
  UNRESOLVED_CONFLICTS: "Unresolved encrypted conflicts must be reviewed before backup export.",
  STALE_BACKUP: "The saved archive changed during backup validation; prepare a new backup.",
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
  let length: number;
  try {
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new Error();
    const buffer = typedArrayBuffer.call(value);
    // Reject SharedArrayBuffer-backed views before copying: shared memory can
    // change concurrently, so it cannot provide a synchronous snapshot.
    arrayBufferByteLength.call(buffer);
    length = typedArrayByteLength.call(value) as number;
  } catch {
    throw new SyntheticBackupError("INVALID_BACKUP");
  }
  if (length > MAX_SYNTHETIC_ARCHIVE_BYTES) {
    throw new SyntheticBackupError("LIMIT_EXCEEDED");
  }
  if (length < 16) throw new SyntheticBackupError("INVALID_BACKUP");
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(value); }
  catch { throw new SyntheticBackupError("INVALID_BACKUP"); }
  if (!MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new SyntheticBackupError("INVALID_BACKUP");
  }
  const header = new DataView(bytes.buffer);
  const version = header.getUint32(8, true);
  const count = header.getUint32(12, true);
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4) throw new SyntheticBackupError("UNSUPPORTED_VERSION");
  if (count < LEGACY_SYNTHETIC_RECORD_COUNT || count > MAX_SYNTHETIC_RECORD_COUNT
      || (version === 1 && count !== LEGACY_SYNTHETIC_RECORD_COUNT)) {
    throw new SyntheticBackupError("INVALID_BACKUP");
  }
  if (version === 3 || version === 4) {
    if (bytes.byteLength < (version === 4 ? 24 : 20)) throw new SyntheticBackupError("INVALID_BACKUP");
    const revisions = header.getUint32(16, true);
    if (revisions < count || revisions > 512) throw new SyntheticBackupError("INVALID_BACKUP");
    if (version === 4 && revisions + header.getUint32(20, true) > 512) {
      throw new SyntheticBackupError("INVALID_BACKUP");
    }
  }
  // v3/v4 retain history; v4 also carries encrypted staged siblings. Header
  // acceptance authenticates nothing: Worker/Rust validates every envelope.
  return bytes;
}

function sameSnapshotBytes(left: Uint8Array, right: Uint8Array): boolean {
  const length = typedArrayByteLength.call(left) as number;
  if (length !== typedArrayByteLength.call(right)) return false;
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function snapshotConflictBytes(value: unknown): Uint8Array {
  try {
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new Error();
    const buffer = typedArrayBuffer.call(value);
    arrayBufferByteLength.call(buffer);
    const length = typedArrayByteLength.call(value) as number;
    if (length < 1 || length > MAX_SYNTHETIC_ARCHIVE_BYTES) throw new Error();
    return new Uint8Array(value);
  } catch {
    throw new SyntheticBackupError("STORAGE_FAILED");
  }
}

function snapshotConflictList(value: unknown): Uint8Array[] {
  const snapshots: Uint8Array[] = [];
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error();
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.enumerable
        || lengthDescriptor.configurable) throw new Error();
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SYNTHETIC_CONFLICT_ARCHIVES) {
      throw new Error();
    }
    const listKeys = Reflect.ownKeys(value);
    if (listKeys.length !== length + 1 || !listKeys.includes("length")) throw new Error();
    const ids = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const indexKey = String(index);
      if (!listKeys.includes(indexKey)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, indexKey);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
      const entry = descriptor.value as unknown;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error();
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) throw new Error();
      const fields = Object.getOwnPropertyDescriptors(entry);
      if (Reflect.ownKeys(fields).length !== 2) throw new Error();
      const idDescriptor = fields.conflictId;
      const bytesDescriptor = fields.bytes;
      if (!idDescriptor || !("value" in idDescriptor) || !idDescriptor.enumerable
          || !bytesDescriptor || !("value" in bytesDescriptor) || !bytesDescriptor.enumerable) {
        throw new Error();
      }
      const conflictId = idDescriptor.value;
      if (typeof conflictId !== "string" || !CONFLICT_ID_PATTERN.test(conflictId)
          || ids.has(conflictId)) throw new Error();
      ids.add(conflictId);
      snapshots.push(snapshotConflictBytes(bytesDescriptor.value));
    }
    return snapshots;
  } catch {
    for (const snapshot of snapshots) snapshot.fill(0);
    throw new SyntheticBackupError("STORAGE_FAILED");
  }
}

interface OwnedBackupSnapshot {
  readonly archive: Uint8Array | null;
  readonly conflicts: Uint8Array[];
}

/** Do not trust a store adapter's shape, byte ownership, or property accessors. */
function snapshotBackupResult(value: unknown): OwnedBackupSnapshot {
  let archive: Uint8Array | null = null;
  let conflicts: Uint8Array[] = [];
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(fields).length !== 2) throw new Error();
    const archiveField = fields.archive;
    const conflictsField = fields.conflicts;
    if (!archiveField || !("value" in archiveField) || !archiveField.enumerable
        || !conflictsField || !("value" in conflictsField) || !conflictsField.enumerable) throw new Error();
    // Copy all inputs synchronously before authentication can yield. Raw adapter
    // buffers might alias canonical state, so never clear or mutate them.
    conflicts = snapshotConflictList(conflictsField.value);
    if (archiveField.value === null) {
      if (conflicts.length !== 0) throw new Error();
    } else {
      archive = snapshotArchive(archiveField.value);
    }
    return { archive, conflicts };
  } catch (error) {
    archive?.fill(0);
    for (const bytes of conflicts) bytes.fill(0);
    if (error instanceof SyntheticBackupError) throw error;
    throw new SyntheticBackupError("STORAGE_FAILED");
  }
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
    let first: OwnedBackupSnapshot | undefined;
    let last: OwnedBackupSnapshot | undefined;
    let transferred = false;
    let finalCheck: (() => void) | undefined;
    try {
      const result = await this.#run(async (check) => {
        finalCheck = check;
        first = await this.#readBackupSnapshot(check);
        check();
        await this.#assertNoUnresolvedConflicts(first.conflicts, check);
        check();
        if (first.archive === null) throw new SyntheticBackupError("EMPTY");
        await this.#validate(first.archive);
        check();
        last = await this.#readBackupSnapshot(check);
        check();
        await this.#assertNoUnresolvedConflicts(last.conflicts, check);
        check();
        if (last.archive === null || !sameSnapshotBytes(first.archive, last.archive)) {
          throw new SyntheticBackupError("STALE_BACKUP");
        }
        // Linearization point: the final readonly transaction. Later writes are
        // allowed and are not included in this point-in-time archive. This is
        // not a rollback/omission proof or a filesystem download confirmation.
        return first.archive;
      });
      // Cancellation can also occur between #run's completion and this outer
      // continuation. Keep ownership (and cleanup) until the final check.
      finalCheck!();
      transferred = true;
      return result;
    } finally {
      if (!transferred) first?.archive?.fill(0);
      for (const bytes of first?.conflicts ?? []) bytes.fill(0);
      last?.archive?.fill(0);
      for (const bytes of last?.conflicts ?? []) bytes.fill(0);
    }
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
      let savedSnapshot: Uint8Array;
      try {
        // Treat the storage adapter as untrusted at readback too. In particular,
        // a SharedArrayBuffer or an own byteLength shadow cannot prove that the
        // exact committed bytes remained stable while they were compared.
        if (saved === null) throw new Error();
        savedSnapshot = snapshotArchive(saved);
      } catch {
        throw new SyntheticBackupError("READBACK_FAILED");
      }
      if (!sameSnapshotBytes(snapshot, savedSnapshot)) {
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

  async #readBackupSnapshot(check: () => void): Promise<OwnedBackupSnapshot> {
    const raw: unknown = await this.#storage(async () => {
      const capability = (this.#store as SyntheticCiphertextStore & {
        readBackupSnapshot?: unknown;
      }).readBackupSnapshot;
      check();
      if (typeof capability !== "function") throw new Error("ATOMIC_SNAPSHOT_UNAVAILABLE");
      return await capability.call(this.#store);
    });
    check();
    // No fallback to separate archive/list reads: that would reintroduce a
    // torn snapshot when another tab commits between those transactions.
    return snapshotBackupResult(raw);
  }

  async #assertNoUnresolvedConflicts(snapshots: readonly Uint8Array[], check: () => void): Promise<void> {
    for (const snapshot of snapshots) {
      try {
        await this.#worker.open(new Uint8Array(snapshot));
      } catch {
        throw new SyntheticBackupError("STORAGE_FAILED");
      }
      check();
    }
    if (snapshots.length > 0) throw new SyntheticBackupError("UNRESOLVED_CONFLICTS");
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
