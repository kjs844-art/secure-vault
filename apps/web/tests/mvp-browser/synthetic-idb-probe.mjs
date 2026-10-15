/**
 * Synthetic QA only, in a newly created isolated browser context. This function
 * must remain self-contained so page.evaluate(probeSyntheticArchive, options)
 * does not need an imported helper or a module closure in the browser.
 *
 * An error/timeout does not promise rollback of an already committed version
 * change. This never enumerates databases, chooses another database, deletes a
 * database, or writes/deletes a store or record.
 */
export async function probeSyntheticArchive(options) {
  const databaseName = "keyatlas-synthetic-vault-v1";
  const timeoutMs = 3000;
  const maximumBytes = 524288;
  const knownErrors = new WeakSet();
  const connections = new Set();
  const transactions = new Set();
  const pending = new Set();
  let stopped = false;
  let timer;
  let deadline;

  function failure(code) {
    const error = new Error(code);
    knownErrors.add(error);
    return error;
  }
  function close(database) {
    if (!database) return;
    try { database.close(); } catch { /* Never reflect an IDB exception. */ }
    connections.delete(database);
  }
  function abort(transaction) {
    try { transaction?.abort(); } catch { /* It may already have completed. */ }
  }
  function stop() {
    stopped = true;
    for (const reject of [...pending]) reject(failure("QA_IDB_ABORT"));
    for (const transaction of [...transactions]) abort(transaction);
    for (const database of [...connections]) close(database);
  }
  function check() {
    if (stopped || performance.now() >= deadline) throw failure("QA_IDB_TIMEOUT");
  }
  function open(version) {
    check();
    return new Promise((resolve, reject) => {
      let request;
      let database;
      let settled = false;
      let upgraded = false;
      function rejectOpen(error) {
        if (settled) return;
        settled = true;
        pending.delete(rejectOpen);
        abort(request?.transaction);
        close(database);
        reject(error);
      }
      pending.add(rejectOpen);
      try {
        request = version === undefined
          ? indexedDB.open(databaseName) : indexedDB.open(databaseName, version);
        request.onblocked = () => rejectOpen(failure("QA_IDB_BLOCKED"));
        request.onerror = () => rejectOpen(failure("QA_IDB_ERROR"));
        request.onupgradeneeded = (event) => {
          try {
            database = request.result;
            connections.add(database);
            // An open request cannot be cancelled. Keep this late-event handler
            // even after blocked/timeout, so it cannot subsequently commit.
            if (settled || stopped) {
              abort(request.transaction);
              close(database);
              return;
            }
            check();
            if (version === undefined) {
              rejectOpen(failure("QA_IDB_MISSING"));
              return;
            }
            if (event.oldVersion !== 1 || event.newVersion !== 99) {
              rejectOpen(failure("QA_IDB_VERSION"));
              return;
            }
            upgraded = true;
            // Version-only upgrade: preserve ALL existing stores and records.
            const transaction = request.transaction;
            transactions.add(transaction);
            transaction.onabort = () => {
              transactions.delete(transaction);
              rejectOpen(failure("QA_IDB_ABORT"));
            };
            transaction.onerror = () => rejectOpen(failure("QA_IDB_ERROR"));
            transaction.oncomplete = () => transactions.delete(transaction);
          } catch (error) {
            rejectOpen(knownErrors.has(error) ? error : failure("QA_IDB_ERROR"));
          }
        };
        request.onsuccess = () => {
          try {
            database = request.result;
            connections.add(database);
            if (settled || stopped) {
              close(database);
              return;
            }
            check();
            if (version !== undefined && (!upgraded || database.version !== 99)) {
              rejectOpen(failure("QA_IDB_VERSION"));
              return;
            }
            database.onversionchange = () => close(database);
            settled = true;
            pending.delete(rejectOpen);
            resolve(database);
          } catch (error) {
            rejectOpen(knownErrors.has(error) ? error : failure("QA_IDB_ERROR"));
          }
        };
      } catch {
        rejectOpen(failure("QA_IDB_ERROR"));
      }
    });
  }
  function read(database) {
    check();
    return new Promise((resolve, reject) => {
      let transaction;
      let bytes;
      let settled = false;
      function rejectRead(error) {
        if (settled) return;
        settled = true;
        pending.delete(rejectRead);
        transactions.delete(transaction);
        abort(transaction);
        close(database);
        reject(error);
      }
      pending.add(rejectRead);
      try {
        const version = database.version;
        const names = database.objectStoreNames;
        if (!Number.isSafeInteger(version) || version < 1 || names.length > 32) {
          throw failure("QA_IDB_METADATA");
        }
        const stores = Array.from(names);
        if (stores.some((name) => typeof name !== "string" || name.length < 1 || name.length > 128
          || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(name))) {
          throw failure("QA_IDB_METADATA");
        }
        stores.sort();
        if (!stores.includes("bundle")) throw failure("QA_IDB_SCHEMA");
        transaction = database.transaction("bundle", "readonly");
        transactions.add(transaction);
        transaction.onabort = () => rejectRead(failure("QA_IDB_ABORT"));
        transaction.onerror = () => rejectRead(failure("QA_IDB_ERROR"));
        transaction.oncomplete = () => {
          if (settled) return;
          try {
            check();
            if (bytes === undefined) throw failure("QA_IDB_ARCHIVE_INVALID");
            settled = true;
            pending.delete(rejectRead);
            transactions.delete(transaction);
            close(database);
            resolve({ version, stores, bytes });
          } catch (error) {
            rejectRead(knownErrors.has(error) ? error : failure("QA_IDB_ERROR"));
          }
        };
        const request = transaction.objectStore("bundle").get("archive");
        request.onerror = () => rejectRead(failure("QA_IDB_ERROR"));
        request.onsuccess = () => {
          if (settled) return;
          try {
            check();
            const value = request.result;
            if (value === null || typeof value !== "object"
              || Object.getPrototypeOf(value) !== Uint8Array.prototype || value.byteLength < 1) {
              throw failure("QA_IDB_ARCHIVE_INVALID");
            }
            if (value.byteLength > maximumBytes) throw failure("QA_IDB_ARCHIVE_TOO_LARGE");
            bytes = new Uint8Array(value);
          } catch (error) {
            rejectRead(knownErrors.has(error) ? error : failure("QA_IDB_ERROR"));
          }
        };
      } catch (error) {
        rejectRead(knownErrors.has(error) ? error : failure("QA_IDB_ERROR"));
      }
    });
  }
  async function snapshot() {
    const value = await read(await open());
    check();
    let digest;
    try {
      digest = await crypto.subtle.digest("SHA-256", value.bytes);
    } catch {
      throw failure("QA_IDB_HASH");
    }
    check();
    return {
      version: value.version,
      stores: value.stores,
      archive: { bytes: value.bytes.byteLength,
        sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") },
    };
  }

  try {
    let action;
    try {
      if (options === null || typeof options !== "object" || Array.isArray(options)
        || (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)) {
        throw failure("QA_IDB_OPTIONS");
      }
      const descriptors = Object.getOwnPropertyDescriptors(options);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.length !== 2 || !keys.includes("action") || !keys.includes("acknowledgement")
        || keys.some((key) => !Object.hasOwn(descriptors[key], "value") || !descriptors[key].enumerable)
        || descriptors.acknowledgement.value !== "keyatlas-m05a-synthetic-only"
        || !["read", "upgrade-future"].includes(descriptors.action.value)) throw failure("QA_IDB_OPTIONS");
      action = descriptors.action.value;
    } catch {
      throw failure("QA_IDB_OPTIONS");
    }
    if (typeof indexedDB === "undefined" || typeof indexedDB.open !== "function") {
      throw failure("QA_IDB_UNAVAILABLE");
    }
    deadline = performance.now() + timeoutMs;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(failure("QA_IDB_TIMEOUT"));
        stop();
      }, timeoutMs);
    });
    const work = async () => {
      const before = await snapshot();
      if (action === "read") return before;
      if (before.version !== 1) throw failure("QA_IDB_VERSION");
      const upgraded = await open(99);
      close(upgraded);
      const after = await snapshot();
      if (after.version !== 99 || JSON.stringify(before.stores) !== JSON.stringify(after.stores)
        || before.archive.bytes !== after.archive.bytes || before.archive.sha256 !== after.archive.sha256) {
        throw failure("QA_IDB_CHANGED");
      }
      return after;
    };
    return await Promise.race([work(), timeout]);
  } catch (error) {
    throw knownErrors.has(error) ? error : failure("QA_IDB_ERROR");
  } finally {
    clearTimeout(timer);
    stop();
  }
}
