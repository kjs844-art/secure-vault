/** This store accepts opaque ciphertext only. Encryption belongs to its caller. */
export const SYNTHETIC_VAULT_DATABASE_NAME = "keyatlas-synthetic-vault-v1";
export const MAX_SYNTHETIC_ARCHIVE_BYTES = 512 * 1024;
export const MAX_SYNTHETIC_CONFLICT_ARCHIVES = 8;

const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = "bundle";
const BUNDLE_KEY = "archive";
const CONFLICT_KEY_PREFIX = "conflict:";
const CONFLICT_ID_PATTERN = /^[0-9a-f]{32}$/;
const CONFLICT_ID_BYTES = 16;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), "byteLength",
)!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), "buffer",
)!.get!;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype, "byteLength",
)!.get!;

export type SyntheticStorageErrorCode =
  | "unavailable"
  | "blocked"
  | "incompatible"
  | "corrupt"
  | "invalid-bytes"
  | "invalid-conflict-id"
  | "outbox-full"
  | "quota"
  | "aborted"
  | "failed";

const ERROR_MESSAGES: Record<SyntheticStorageErrorCode, string> = {
  unavailable: "Local encrypted storage is unavailable.",
  blocked: "Local encrypted storage is blocked by another connection.",
  incompatible: "Local encrypted storage has an unsupported database format.",
  corrupt: "The saved encrypted archive is invalid; it has been preserved.",
  "invalid-bytes": "The encrypted archive must contain 1 to 524288 bytes.",
  "invalid-conflict-id": "The encrypted conflict identifier is invalid.",
  "outbox-full": "The encrypted conflict outbox is full.",
  quota: "Local encrypted storage has insufficient space.",
  aborted: "The local encrypted storage transaction was aborted.",
  failed: "The local encrypted storage operation failed.",
};

export class SyntheticStorageError extends Error {
  readonly code: SyntheticStorageErrorCode;

  constructor(code: SyntheticStorageErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SyntheticStorageError";
    this.code = code;
  }
}

export interface SyntheticCiphertextStore {
  read(): Promise<Uint8Array | null>;
  createIfAbsent(bytes: Uint8Array): Promise<"created" | "exists">;
}

export interface SyntheticMutableCiphertextStore extends SyntheticCiphertextStore {
  /**
   * Internal opaque-byte capability for a caller that authenticates its archive.
   * This checks concurrent changes, not authenticity, origin or rollback history.
   * A missing archive is never created by this operation.
   */
  compareAndSwapArchive(
    expected: Uint8Array,
    next: Uint8Array,
  ): Promise<"updated" | "conflict" | "missing">;
}

export interface SyntheticConflictArchive {
  readonly conflictId: string;
  readonly bytes: Uint8Array;
}

export type SyntheticConflictPreservingCasResult =
  | { readonly kind: "updated" }
  | { readonly kind: "conflict-preserved"; readonly conflictId: string }
  | { readonly kind: "missing" };

export type SyntheticConflictPreservationResult =
  | { readonly kind: "already-current" }
  | { readonly kind: "conflict-preserved"; readonly conflictId: string }
  | { readonly kind: "missing" };

export type SyntheticConflictIdSource = (target: Uint8Array<ArrayBuffer>) => void;

/** Opaque ciphertext-only conflict capability. Callers authenticate archives. */
export interface SyntheticConflictCiphertextStore extends SyntheticMutableCiphertextStore {
  compareAndSwapArchivePreservingConflict(
    expected: Uint8Array,
    next: Uint8Array,
  ): Promise<SyntheticConflictPreservingCasResult>;
  preserveConflictArchiveIfCurrentDiffers(
    candidate: Uint8Array,
  ): Promise<SyntheticConflictPreservationResult>;
  listConflictArchives(): Promise<readonly SyntheticConflictArchive[]>;
  deleteConflictArchiveIfEqual(
    conflictId: string,
    expected: Uint8Array,
  ): Promise<"deleted" | "missing" | "changed">;
}

function fixedError(error: unknown): SyntheticStorageError {
  try {
    if (error instanceof SyntheticStorageError) return error;
    // Do not expose browser error messages: they may contain data or identifiers.
    const name = error instanceof Error || error instanceof DOMException ? error.name : "";
    if (name === "VersionError") return new SyntheticStorageError("incompatible");
    if (name === "QuotaExceededError") return new SyntheticStorageError("quota");
    if (name === "AbortError") return new SyntheticStorageError("aborted");
    if (name === "SecurityError" || name === "InvalidStateError") {
      return new SyntheticStorageError("unavailable");
    }
  } catch {
    // Even inspecting an unknown thrown value can throw (for example a getter).
  }
  return new SyntheticStorageError("failed");
}

function copyBytes(value: unknown, code: "corrupt" | "invalid-bytes"): Uint8Array {
  try {
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
      throw new SyntheticStorageError(code);
    }
    // SharedArrayBuffer can change concurrently while it is copied. The native
    // ArrayBuffer getter brand-checks and rejects shared backing stores.
    const buffer = typedArrayBuffer.call(value) as ArrayBufferLike;
    arrayBufferByteLength.call(buffer);
    // An own byteLength property can lie; inspect the native view's real length.
    const length = typedArrayByteLength.call(value) as number;
    if (length < 1 || length > MAX_SYNTHETIC_ARCHIVE_BYTES) {
      throw new SyntheticStorageError(code);
    }
    return new Uint8Array(value);
  } catch {
    // Reject detached/forged views or throwing inspection without leaking data.
    throw new SyntheticStorageError(code);
  }
}

function conflictKey(conflictId: unknown): string {
  if (typeof conflictId !== "string" || !CONFLICT_ID_PATTERN.test(conflictId)) {
    throw new SyntheticStorageError("invalid-conflict-id");
  }
  return `${CONFLICT_KEY_PREFIX}${conflictId}`;
}

function defaultConflictIdSource(target: Uint8Array<ArrayBuffer>): void {
  let provider: Crypto;
  try {
    provider = globalThis.crypto;
  } catch {
    throw new SyntheticStorageError("unavailable");
  }
  if (!provider || typeof provider.getRandomValues !== "function") {
    throw new SyntheticStorageError("unavailable");
  }
  provider.getRandomValues(target);
}

function createConflictId(source: SyntheticConflictIdSource): string {
  try {
    const random = new Uint8Array(CONFLICT_ID_BYTES);
    source(random);
    if (typedArrayByteLength.call(random) !== CONFLICT_ID_BYTES) {
      throw new SyntheticStorageError("failed");
    }
    let result = "";
    for (let index = 0; index < CONFLICT_ID_BYTES; index += 1) {
      result += random[index]!.toString(16).padStart(2, "0");
    }
    random.fill(0);
    return result;
  } catch (error) {
    throw fixedError(error);
  }
}

function openDatabase(factory: IDBFactory | undefined): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!factory) {
      reject(new SyntheticStorageError("unavailable"));
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = factory.open(SYNTHETIC_VAULT_DATABASE_NAME, DATABASE_VERSION);
    } catch (error) {
      reject(fixedError(error));
      return;
    }

    let rejected = false;
    let upgradeError: SyntheticStorageError | undefined;
    request.onblocked = () => {
      rejected = true;
      reject(new SyntheticStorageError("blocked"));
    };
    request.onupgradeneeded = (event) => {
      const database = request.result;
      // Only initialize a genuinely new database. Never migrate or repair data.
      if (rejected || event.oldVersion !== 0 || database.objectStoreNames.length !== 0) {
        upgradeError = new SyntheticStorageError("incompatible");
        request.transaction?.abort();
        return;
      }
      try {
        database.createObjectStore(OBJECT_STORE_NAME);
      } catch (error) {
        upgradeError = fixedError(error);
        request.transaction?.abort();
      }
    };
    request.onerror = () => reject(upgradeError ?? fixedError(request.error));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (rejected) {
        database.close();
        return;
      }
      if (
        database.version !== DATABASE_VERSION ||
        database.objectStoreNames.length !== 1 ||
        !database.objectStoreNames.contains(OBJECT_STORE_NAME)
      ) {
        database.close();
        reject(new SyntheticStorageError("incompatible"));
        return;
      }
      resolve(database);
    };
  });
}

type Operation =
  | { kind: "read" }
  | { kind: "create"; bytes: Uint8Array }
  | { kind: "compare-and-swap"; expected: Uint8Array; next: Uint8Array }
  | { kind: "compare-and-swap-preserving-conflict"; expected: Uint8Array; next: Uint8Array }
  | { kind: "preserve-if-current-differs"; candidate: Uint8Array }
  | { kind: "list-conflicts" }
  | { kind: "delete-conflict"; conflictId: string; expected: Uint8Array };
type OperationResult = Uint8Array | null | "created" | "exists" | "updated" | "conflict" | "missing"
  | "deleted" | "changed" | SyntheticConflictPreservingCasResult
  | SyntheticConflictPreservationResult
  | readonly SyntheticConflictArchive[];

interface StoredConflictArchive {
  readonly key: string;
  readonly conflictId: string;
  readonly bytes: Uint8Array;
}

interface InspectedKeyspace {
  readonly archive: Uint8Array | null;
  readonly conflicts: readonly StoredConflictArchive[];
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function transact(
  factory: IDBFactory | undefined,
  operation: Operation,
  conflictIdSource: SyntheticConflictIdSource,
): Promise<OperationResult> {
  const database = await openDatabase(factory);
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(
        OBJECT_STORE_NAME,
        operation.kind === "read" || operation.kind === "list-conflicts" ? "readonly" : "readwrite",
      );
    } catch (error) {
      database.close();
      reject(fixedError(error));
      return;
    }

    let result: OperationResult | undefined;
    let failure: SyntheticStorageError | undefined;
    transaction.oncomplete = () => {
      database.close();
      // Request success alone is not proof that the transaction committed.
      if (failure || result === undefined) {
        reject(failure ?? new SyntheticStorageError("failed"));
      } else {
        resolve(result);
      }
    };
    transaction.onabort = () => {
      database.close();
      reject(failure ?? fixedError(transaction.error ?? new DOMException("", "AbortError")));
    };
    transaction.onerror = () => {
      failure ??= fixedError(transaction.error);
    };

    const fail = (error: unknown) => {
      failure = fixedError(error);
      try {
        transaction.abort();
      } catch {
        database.close();
        reject(failure);
      }
    };

    try {
      const store = transaction.objectStore(OBJECT_STORE_NAME);
      if (store.keyPath !== null || store.autoIncrement || store.indexNames.length !== 0) {
        fail(new SyntheticStorageError("incompatible"));
        return;
      }

      // The existing v1 object-store schema remains unchanged. Its logical
      // keyspace is strictly one archive plus at most eight opaque conflicts.
      // One extra key is enough to detect an over-limit/corrupt database.
      const keysRequest = store.getAllKeys(undefined, MAX_SYNTHETIC_CONFLICT_ARCHIVES + 2);
      keysRequest.onerror = () => { failure = fixedError(keysRequest.error); };
      keysRequest.onsuccess = () => {
        const keys = keysRequest.result;
        if (keys.length > MAX_SYNTHETIC_CONFLICT_ARCHIVES + 1) {
          fail(new SyntheticStorageError("corrupt"));
          return;
        }

        let hasArchive = false;
        const conflictIds = new Map<string, string>();
        for (const key of keys) {
          if (key === BUNDLE_KEY) {
            if (hasArchive) { fail(new SyntheticStorageError("corrupt")); return; }
            hasArchive = true;
            continue;
          }
          if (typeof key !== "string" || !key.startsWith(CONFLICT_KEY_PREFIX)) {
            fail(new SyntheticStorageError("corrupt"));
            return;
          }
          const conflictId = key.slice(CONFLICT_KEY_PREFIX.length);
          if (!CONFLICT_ID_PATTERN.test(conflictId) || conflictIds.has(conflictId)) {
            fail(new SyntheticStorageError("corrupt"));
            return;
          }
          conflictIds.set(conflictId, key);
        }
        if (!hasArchive && conflictIds.size !== 0) {
          fail(new SyntheticStorageError("corrupt"));
          return;
        }

        if (keys.length === 0) {
          perform(Object.freeze({ archive: null, conflicts: Object.freeze([]) }));
          return;
        }

        const values = new Map<string, Uint8Array>();
        let remaining = keys.length;
        for (const key of keys) {
          let readRequest: IDBRequest;
          try { readRequest = store.get(key); }
          catch (error) { fail(error); return; }
          readRequest.onerror = () => { failure = fixedError(readRequest.error); };
          readRequest.onsuccess = () => {
            if (failure) return;
            try {
              values.set(String(key), copyBytes(readRequest.result, "corrupt"));
              remaining -= 1;
              if (remaining !== 0) return;
              const conflicts = [...conflictIds.entries()]
                .map(([conflictId, key]) => Object.freeze({
                  key,
                  conflictId,
                  bytes: values.get(key)!,
                }))
                .sort((left, right) => left.conflictId < right.conflictId ? -1
                  : left.conflictId > right.conflictId ? 1 : 0);
              perform(Object.freeze({
                archive: hasArchive ? values.get(BUNDLE_KEY)! : null,
                conflicts: Object.freeze(conflicts),
              }));
            } catch (error) {
              fail(error);
            }
          };
        }
      };

      function perform(keyspace: InspectedKeyspace): void {
        try {
          const bytes = keyspace.archive;
          const preserveConflict = (candidate: Uint8Array): void => {
            if (keyspace.conflicts.length >= MAX_SYNTHETIC_CONFLICT_ARCHIVES) {
              fail(new SyntheticStorageError("outbox-full"));
              return;
            }
            const conflictId = createConflictId(conflictIdSource);
            const key = `${CONFLICT_KEY_PREFIX}${conflictId}`;
            if (keyspace.conflicts.some((entry) => entry.key === key)) {
              fail(new SyntheticStorageError("failed"));
              return;
            }
            const addRequest = store.add(candidate, key);
            addRequest.onerror = () => { failure = fixedError(addRequest.error); };
            addRequest.onsuccess = () => {
              result = Object.freeze({ kind: "conflict-preserved" as const, conflictId });
            };
          };
          if (operation.kind === "read") {
            result = bytes === null ? null : new Uint8Array(bytes);
            return;
          }
          if (operation.kind === "list-conflicts") {
            result = Object.freeze(keyspace.conflicts.map((conflict) => Object.freeze({
              conflictId: conflict.conflictId,
              bytes: new Uint8Array(conflict.bytes),
            })));
            return;
          }
          if (operation.kind === "create") {
            if (bytes !== null) { result = "exists"; return; }
            const addRequest = store.add(operation.bytes, BUNDLE_KEY);
            addRequest.onerror = () => { failure = fixedError(addRequest.error); };
            addRequest.onsuccess = () => { result = "created"; };
            return;
          }
          if (operation.kind === "delete-conflict") {
            const conflict = keyspace.conflicts.find((entry) => entry.conflictId === operation.conflictId);
            if (!conflict) { result = "missing"; return; }
            if (!equalBytes(conflict.bytes, operation.expected)) { result = "changed"; return; }
            const deleteRequest = store.delete(conflict.key);
            deleteRequest.onerror = () => { failure = fixedError(deleteRequest.error); };
            deleteRequest.onsuccess = () => { result = "deleted"; };
            return;
          }
          if (operation.kind === "preserve-if-current-differs") {
            if (bytes === null) { result = Object.freeze({ kind: "missing" as const }); return; }
            if (equalBytes(bytes, operation.candidate)) {
              result = Object.freeze({ kind: "already-current" as const });
              return;
            }
            preserveConflict(operation.candidate);
            return;
          }
          if (bytes === null) {
            result = operation.kind === "compare-and-swap"
              ? "missing" : Object.freeze({ kind: "missing" as const });
            return;
          }
          if (!equalBytes(bytes, operation.expected)) {
            if (operation.kind === "compare-and-swap") { result = "conflict"; return; }
            preserveConflict(operation.next);
            return;
          }
          // Validation, comparison and replacement share this transaction.
          const putRequest = store.put(operation.next, BUNDLE_KEY);
          putRequest.onerror = () => { failure = fixedError(putRequest.error); };
          putRequest.onsuccess = () => {
            result = operation.kind === "compare-and-swap"
              ? "updated" : Object.freeze({ kind: "updated" as const });
          };
        } catch (error) {
          fail(error);
        }
      }
    } catch (error) {
      fail(error);
    }
  });
}

export function createSyntheticCiphertextStore(
  factory?: IDBFactory,
  conflictIdSource: SyntheticConflictIdSource = defaultConflictIdSource,
): SyntheticConflictCiphertextStore {
  const resolveFactory = () => {
    try {
      return factory ?? globalThis.indexedDB;
    } catch {
      throw new SyntheticStorageError("unavailable");
    }
  };
  return {
    async read() {
      return await transact(resolveFactory(), { kind: "read" }, conflictIdSource) as Uint8Array | null;
    },
    async createIfAbsent(bytes) {
      // Snapshot and validate synchronously before any asynchronous database work.
      const snapshot = copyBytes(bytes, "invalid-bytes");
      return await transact(resolveFactory(), { kind: "create", bytes: snapshot }, conflictIdSource) as "created" | "exists";
    },
    async compareAndSwapArchive(expected, next) {
      // Snapshot both inputs before resolving/opening the database or awaiting.
      const expectedSnapshot = copyBytes(expected, "invalid-bytes");
      const nextSnapshot = copyBytes(next, "invalid-bytes");
      return await transact(resolveFactory(), {
        kind: "compare-and-swap", expected: expectedSnapshot, next: nextSnapshot,
      }, conflictIdSource) as "updated" | "conflict" | "missing";
    },
    async compareAndSwapArchivePreservingConflict(expected, next) {
      const expectedSnapshot = copyBytes(expected, "invalid-bytes");
      const nextSnapshot = copyBytes(next, "invalid-bytes");
      return await transact(resolveFactory(), {
        kind: "compare-and-swap-preserving-conflict",
        expected: expectedSnapshot,
        next: nextSnapshot,
      }, conflictIdSource) as SyntheticConflictPreservingCasResult;
    },
    async preserveConflictArchiveIfCurrentDiffers(candidate) {
      const candidateSnapshot = copyBytes(candidate, "invalid-bytes");
      return await transact(resolveFactory(), {
        kind: "preserve-if-current-differs",
        candidate: candidateSnapshot,
      }, conflictIdSource) as SyntheticConflictPreservationResult;
    },
    async listConflictArchives() {
      return (await transact(resolveFactory(), { kind: "list-conflicts" }, conflictIdSource)) as SyntheticConflictArchive[];
    },
    async deleteConflictArchiveIfEqual(conflictId, expected) {
      const key = conflictKey(conflictId);
      const expectedSnapshot = copyBytes(expected, "invalid-bytes");
      return await transact(resolveFactory(), {
        kind: "delete-conflict",
        conflictId: key.slice(CONFLICT_KEY_PREFIX.length),
        expected: expectedSnapshot,
      }, conflictIdSource) as "deleted" | "missing" | "changed";
    },
  };
}
