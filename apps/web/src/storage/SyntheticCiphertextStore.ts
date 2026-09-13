/** This store accepts opaque ciphertext only. Encryption belongs to its caller. */
export const SYNTHETIC_VAULT_DATABASE_NAME = "keyatlas-synthetic-vault-v1";
export const MAX_SYNTHETIC_ARCHIVE_BYTES = 512 * 1024;

const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = "bundle";
const BUNDLE_KEY = "archive";

export type SyntheticStorageErrorCode =
  | "unavailable"
  | "blocked"
  | "incompatible"
  | "corrupt"
  | "invalid-bytes"
  | "quota"
  | "aborted"
  | "failed";

const ERROR_MESSAGES: Record<SyntheticStorageErrorCode, string> = {
  unavailable: "Local encrypted storage is unavailable.",
  blocked: "Local encrypted storage is blocked by another connection.",
  incompatible: "Local encrypted storage has an unsupported database format.",
  corrupt: "The saved encrypted archive is invalid; it has been preserved.",
  "invalid-bytes": "The encrypted archive must contain 1 to 524288 bytes.",
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

function fixedError(error: unknown): SyntheticStorageError {
  if (error instanceof SyntheticStorageError) return error;
  // Do not expose browser error messages: they may contain data or identifiers.
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  if (name === "VersionError") return new SyntheticStorageError("incompatible");
  if (name === "QuotaExceededError") return new SyntheticStorageError("quota");
  if (name === "AbortError") return new SyntheticStorageError("aborted");
  if (name === "SecurityError" || name === "InvalidStateError") {
    return new SyntheticStorageError("unavailable");
  }
  return new SyntheticStorageError("failed");
}

function copyBytes(value: unknown, code: "corrupt" | "invalid-bytes"): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype ||
    value.byteLength < 1 ||
    value.byteLength > MAX_SYNTHETIC_ARCHIVE_BYTES
  ) {
    throw new SyntheticStorageError(code);
  }
  return new Uint8Array(value);
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

type Operation = { kind: "read" } | { kind: "create"; bytes: Uint8Array };
type OperationResult = Uint8Array | null | "created" | "exists";

async function transact(
  factory: IDBFactory | undefined,
  operation: Operation,
): Promise<OperationResult> {
  const database = await openDatabase(factory);
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(
        OBJECT_STORE_NAME,
        operation.kind === "read" ? "readonly" : "readwrite",
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

      // Presence is checked by key, so an existing undefined/corrupt value cannot
      // masquerade as an empty database. Two keys are enough to detect extras.
      const keysRequest = store.getAllKeys(undefined, 2);
      keysRequest.onerror = () => { failure = fixedError(keysRequest.error); };
      keysRequest.onsuccess = () => {
        const keys = keysRequest.result;
        if (keys.length > 1 || (keys.length === 1 && keys[0] !== BUNDLE_KEY)) {
          fail(new SyntheticStorageError("corrupt"));
          return;
        }
        if (keys.length === 0) {
          if (operation.kind === "read") {
            result = null;
            return;
          }
          try {
            // add, not put: an existing archive must never be overwritten.
            const addRequest = store.add(operation.bytes, BUNDLE_KEY);
            addRequest.onerror = () => { failure = fixedError(addRequest.error); };
            addRequest.onsuccess = () => { result = "created"; };
          } catch (error) {
            fail(error);
          }
          return;
        }

        const readRequest = store.get(BUNDLE_KEY);
        readRequest.onerror = () => { failure = fixedError(readRequest.error); };
        readRequest.onsuccess = () => {
          try {
            const bytes = copyBytes(readRequest.result, "corrupt");
            result = operation.kind === "read" ? bytes : "exists";
          } catch (error) {
            fail(error);
          }
        };
      };
    } catch (error) {
      fail(error);
    }
  });
}

export function createSyntheticCiphertextStore(factory?: IDBFactory): SyntheticCiphertextStore {
  const resolveFactory = () => {
    try {
      return factory ?? globalThis.indexedDB;
    } catch {
      throw new SyntheticStorageError("unavailable");
    }
  };
  return {
    async read() {
      return await transact(resolveFactory(), { kind: "read" }) as Uint8Array | null;
    },
    async createIfAbsent(bytes) {
      // Snapshot and validate synchronously before any asynchronous database work.
      const snapshot = copyBytes(bytes, "invalid-bytes");
      return await transact(resolveFactory(), { kind: "create", bytes: snapshot }) as "created" | "exists";
    },
  };
}
