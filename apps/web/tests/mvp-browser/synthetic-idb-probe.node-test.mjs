import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { IDBFactory } from "fake-indexeddb";
import { probeSyntheticArchive } from "./synthetic-idb-probe.mjs";

// Offline synthetic regressions only: these do not establish browser UI,
// Playwright transport, actual persistence, or real-vault safety evidence.
const DATABASE = "keyatlas-synthetic-vault-v1";
const acknowledgement = "keyatlas-m05a-synthetic-only";
const readOptions = () => ({ action: "read", acknowledgement });
const upgradeOptions = () => ({ action: "upgrade-future", acknowledgement });
const absent = Symbol("absent synthetic archive");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function seed(factory, { name = DATABASE, version = 1, archive = new Uint8Array([1, 2, 3]),
  bundle = true, rows = [], stores = [] } = {}) {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onerror = () => reject(new Error("SYNTHETIC_SEED_FAILED"));
    request.onupgradeneeded = () => {
      if (bundle) {
        const store = request.result.createObjectStore("bundle");
        if (archive !== absent) store.put(archive, "archive");
        for (const [key, value] of rows) store.put(value, key);
      }
      for (const [storeName, entries] of stores) {
        const store = request.result.createObjectStore(storeName);
        for (const [key, value] of entries) store.put(value, key);
      }
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
  });
}

function connection(factory, name = DATABASE) {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("SYNTHETIC_OPEN_FAILED"));
  });
}

async function contents(factory, name = DATABASE) {
  const database = await connection(factory, name);
  try {
    const stores = Array.from(database.objectStoreNames).sort();
    const result = { version: database.version, stores: {} };
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(stores, "readonly");
      transaction.onabort = transaction.onerror = () => reject(new Error("SYNTHETIC_READ_FAILED"));
      transaction.oncomplete = resolve;
      for (const storeName of stores) {
        const store = transaction.objectStore(storeName);
        const keys = store.getAllKeys();
        const values = store.getAll();
        values.onsuccess = () => { result.stores[storeName] = keys.result.map((key, index) => [key, values.result[index]]); };
      }
    });
    return result;
  } finally {
    database.close();
  }
}

function harness(indexedDB, overrides = {}) {
  const timers = new Map();
  const scheduled = [];
  // Evaluate only the function source, with no module helpers/closures available.
  // Host intrinsics model a single page realm also used by fake-indexeddb values.
  const probe = runInNewContext(`(${probeSyntheticArchive.toString()})`, {
    indexedDB, crypto: webcrypto, performance: { now: () => 0 },
    Object, Reflect, Array, Uint8Array, Number, Set, WeakSet, Error, Promise, JSON,
    setTimeout(callback, milliseconds) {
      const id = Symbol("timer");
      timers.set(id, callback);
      scheduled.push(milliseconds);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    ...overrides,
  });
  return {
    // page.evaluate also transfers a serializable result into the caller realm.
    probe: async (options) => structuredClone(await probe(options)),
    timers, scheduled, expire() { for (const callback of [...timers.values()]) callback(); },
  };
}

function instrument(factory, configure = () => {}) {
  const calls = [];
  const opened = new Set();
  return {
    calls, opened,
    indexedDB: {
      open(...arguments_) {
        calls.push(arguments_);
        const request = factory.open(...arguments_);
        request.addEventListener("success", () => {
          const database = request.result;
          opened.add(database);
          const close = database.close.bind(database);
          database.close = () => { opened.delete(database); close(); };
          configure(database);
        });
        return request;
      },
      databases() { assert.fail("probe must not enumerate databases"); },
      deleteDatabase() { assert.fail("probe must not delete databases"); },
    },
  };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.constructor, Error);
    assert.equal(error.message, code);
    assert.deepEqual(Object.keys(error), []);
    return true;
  });
}

test("serialized read selects only bundle/archive and returns bounded metadata", async () => {
  const factory = new IDBFactory();
  const archive = new Uint8Array([11, 12, 13]);
  await seed(factory, { archive, rows: [["aaa-decoy", new Uint8Array([99])], ["archive-copy", "synthetic-decoy"]],
    stores: [["z-sentinel", [["archive", new Uint8Array([88])]]]] });
  const tracked = instrument(factory);
  const h = harness(tracked.indexedDB);
  assert.deepEqual(await h.probe(readOptions()), {
    version: 1, stores: ["bundle", "z-sentinel"], archive: { bytes: 3, sha256: digest(archive) },
  });
  assert.deepEqual(tracked.calls, [[DATABASE]]);
  assert.equal(tracked.opened.size, 0);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.scheduled, [3000]);
});

test("missing database read aborts implicit creation", async () => {
  const factory = new IDBFactory();
  await rejectsCode(harness(factory).probe(readOptions()), "QA_IDB_MISSING");
  const oldVersion = await new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onerror = () => reject(new Error("SYNTHETIC_CHECK_FAILED"));
    let old;
    request.onupgradeneeded = (event) => { old = event.oldVersion; };
    request.onsuccess = () => { request.result.close(); resolve(old); };
  });
  assert.equal(oldVersion, 0);
});

test("missing store or exact archive key fails without selecting another row", async () => {
  const withoutStore = new IDBFactory();
  await seed(withoutStore, { bundle: false, stores: [["other", [["archive", new Uint8Array([3])]]]] });
  await rejectsCode(harness(withoutStore).probe(readOptions()), "QA_IDB_SCHEMA");
  const withoutKey = new IDBFactory();
  await seed(withoutKey, { archive: absent, rows: [["aaa", new Uint8Array([2])]] });
  await rejectsCode(harness(withoutKey).probe(readOptions()), "QA_IDB_ARCHIVE_INVALID");
});

test("corrupt and empty archive values fail with fixed errors", async () => {
  for (const archive of [null, undefined, "synthetic-invalid", [1, 2], { bytes: [1] },
    new ArrayBuffer(1), new Uint16Array([1]), new DataView(new ArrayBuffer(1)), new Uint8Array(0)]) {
    const factory = new IDBFactory();
    // Explicit undefined is written instead of seed's default fixture.
    await seed(factory, { archive: absent, rows: [["archive", archive]] });
    await rejectsCode(harness(factory).probe(readOptions()), "QA_IDB_ARCHIVE_INVALID");
  }
});

test("archive size includes exact minimum and maximum but rejects overflow", async () => {
  for (const length of [1, 524288, 524289]) {
    const factory = new IDBFactory();
    const archive = new Uint8Array(length);
    await seed(factory, { archive });
    const promise = harness(factory).probe(readOptions());
    if (length > 524288) await rejectsCode(promise, "QA_IDB_ARCHIVE_TOO_LARGE");
    else assert.deepEqual((await promise).archive, { bytes: length, sha256: digest(archive) });
  }
});

test("archive hash covers the view bytes, not unrelated backing-buffer bytes", async () => {
  const factory = new IDBFactory();
  const archive = new Uint8Array([90, 4, 5, 6, 91]).subarray(1, 4);
  await seed(factory, { archive });
  assert.deepEqual((await harness(factory).probe(readOptions())).archive, { bytes: 3, sha256: digest(archive) });
});

test("unknown actions, acknowledgement, extras, symbols and getters never open a DB", async () => {
  let opens = 0;
  let getters = 0;
  const accessor = { acknowledgement };
  Object.defineProperty(accessor, "action", { enumerable: true, get() { getters += 1; return "read"; } });
  const invalid = [null, [], {}, { action: "read" }, { action: "remove", acknowledgement },
    { action: "read", acknowledgement: "wrong" }, { ...readOptions(), timeoutMs: 1 },
    { ...readOptions(), databaseName: "other" }, { ...readOptions(), [Symbol("extra")]: true },
    Object.create(readOptions()), accessor];
  const h = harness({ open() { opens += 1; throw new Error("unexpected"); } });
  for (const options of invalid) await rejectsCode(h.probe(options), "QA_IDB_OPTIONS");
  assert.equal(opens, 0);
  assert.equal(getters, 0);
  assert.equal(h.scheduled.length, 0);
});

test("throwing input reflection stays a fixed options error", async () => {
  const input = new Proxy({}, { getPrototypeOf() { throw new Error("synthetic private diagnostic"); } });
  await rejectsCode(harness(new IDBFactory()).probe(input), "QA_IDB_OPTIONS");
});

test("store count and name limits are bounded before returning metadata", async () => {
  for (const stores of [Array.from({ length: 32 }, (_, index) => [`extra-${index}`, []]),
    [["x".repeat(129), []]], [["control\nname", []]], [["\ud800", []]]]) {
    const factory = new IDBFactory();
    await seed(factory, { stores });
    await rejectsCode(harness(factory).probe(readOptions()), "QA_IDB_METADATA");
  }
  const factory = new IDBFactory();
  await seed(factory, { stores: Array.from({ length: 31 }, (_, index) =>
    [index === 0 ? "x".repeat(128) : `extra-${index}`, []]) });
  assert.equal((await harness(factory).probe(readOptions())).stores.length, 32);
});

test("transaction abort after get success does not return a successful read", async () => {
  const factory = new IDBFactory();
  await seed(factory);
  let getSucceeded = false;
  const tracked = instrument(factory, (database) => {
    const transaction = database.transaction.bind(database);
    database.transaction = (...args) => {
      const tx = transaction(...args);
      const objectStore = tx.objectStore.bind(tx);
      tx.objectStore = (...storeArgs) => {
        const store = objectStore(...storeArgs);
        const get = store.get.bind(store);
        store.get = (...keyArgs) => {
          const request = get(...keyArgs);
          request.addEventListener("success", () => {
            getSucceeded = true;
            queueMicrotask(() => tx.abort());
          });
          return request;
        };
        return store;
      };
      return tx;
    };
  });
  await rejectsCode(harness(tracked.indexedDB).probe(readOptions()), "QA_IDB_ABORT");
  assert.equal(getSucceeded, true);
  assert.equal(tracked.opened.size, 0);
});

test("hash runs only after transaction completion and connection close", async () => {
  const factory = new IDBFactory();
  await seed(factory);
  let completed = false;
  const tracked = instrument(factory, (database) => {
    const transaction = database.transaction.bind(database);
    database.transaction = (...args) => {
      const tx = transaction(...args);
      tx.addEventListener("complete", () => { completed = true; });
      return tx;
    };
  });
  const h = harness(tracked.indexedDB, { crypto: { subtle: { digest(...args) {
    assert.equal(completed, true);
    assert.equal(tracked.opened.size, 0);
    return webcrypto.subtle.digest(...args);
  } } } });
  await h.probe(readOptions());
});

test("read and upgrade never touch a different synthetic database", async () => {
  const factory = new IDBFactory();
  const otherName = "other-synthetic-probe-fixture";
  await seed(factory, { name: otherName, archive: new Uint8Array([7, 8]) });
  await seed(factory);
  const original = await contents(factory, otherName);
  const tracked = instrument(factory);
  const h = harness(tracked.indexedDB);
  await h.probe(readOptions());
  await h.probe(upgradeOptions());
  assert.equal(tracked.calls.every(([name]) => name === DATABASE), true);
  assert.deepEqual(await contents(factory, otherName), original);
});

test("version-only upgrade preserves every extra store, sentinel and conflicting row", async () => {
  const factory = new IDBFactory();
  await seed(factory, { rows: [["conflict", { synthetic: true }], ["archive-extra", new Uint8Array([77])]],
    stores: [["future-store", [["marker", "existing-synthetic-marker"]]],
      ["aaa-sentinel", [["archive", new Uint8Array([66])], [42, { synthetic: "unchanged" }]]]] });
  const before = await contents(factory);
  const tracked = instrument(factory);
  const h = harness(tracked.indexedDB);
  const result = await h.probe(upgradeOptions());
  const after = await contents(factory);
  assert.equal(result.version, 99);
  assert.deepEqual(result.stores, ["aaa-sentinel", "bundle", "future-store"]);
  assert.deepEqual(after, { ...before, version: 99 });
  assert.deepEqual(tracked.calls, [[DATABASE], [DATABASE, 99], [DATABASE]]);
  assert.equal(tracked.opened.size, 0);
  assert.equal(h.timers.size, 0);
});

test("upgrade refuses missing, corrupt or non-v1 databases without changing existing data", async () => {
  await rejectsCode(harness(new IDBFactory()).probe(upgradeOptions()), "QA_IDB_MISSING");
  for (const configuration of [{ archive: "invalid" }, { version: 2 }, { version: 99 }, { version: 100 }]) {
    const factory = new IDBFactory();
    await seed(factory, configuration);
    const before = await contents(factory);
    const code = configuration.archive ? "QA_IDB_ARCHIVE_INVALID" : "QA_IDB_VERSION";
    await rejectsCode(harness(factory).probe(upgradeOptions()), code);
    assert.deepEqual(await contents(factory), before);
  }
});

test("blocked upgrade rejects and aborts its later upgrade after the blocker closes", async () => {
  const factory = new IDBFactory();
  await seed(factory);
  const blocker = await connection(factory);
  try {
    const h = harness(factory);
    await rejectsCode(h.probe(upgradeOptions()), "QA_IDB_BLOCKED");
    assert.equal(h.timers.size, 0);
  } finally {
    blocker.close();
  }
  // This read is queued behind the formerly blocked open request.
  assert.equal((await contents(factory)).version, 1);
});

test("late success after blocked rejection only closes its connection", async () => {
  const request = {};
  const h = harness({ open() { queueMicrotask(() => request.onblocked()); return request; } });
  await rejectsCode(h.probe(readOptions()), "QA_IDB_BLOCKED");
  let closes = 0;
  request.result = { close() { closes += 1; }, get version() { assert.fail("late success must not inspect metadata"); } };
  request.onsuccess();
  assert.equal(closes, 1);
});

test("open error and synchronous diagnostic exceptions are fixed and private", async () => {
  await rejectsCode(harness({ open() { throw new Error("synthetic private diagnostic"); } }).probe(readOptions()), "QA_IDB_ERROR");
  const request = {};
  const h = harness({ open() { queueMicrotask(() => request.onerror()); return request; } });
  await rejectsCode(h.probe(readOptions()), "QA_IDB_ERROR");
  assert.equal(h.timers.size, 0);
});

test("an unavailable IDB implementation is distinguished from an open error", async () => {
  await rejectsCode(harness(undefined).probe(readOptions()), "QA_IDB_UNAVAILABLE");
});

test("fixed whole-operation timeout bounds a never-settling open and closes late success", async () => {
  const request = {};
  const h = harness({ open() { return request; } });
  const outcome = rejectsCode(h.probe(readOptions()), "QA_IDB_TIMEOUT");
  assert.deepEqual(h.scheduled, [3000]);
  h.expire();
  await outcome;
  let closes = 0;
  request.result = { close() { closes += 1; } };
  request.onsuccess();
  assert.equal(closes, 1);
  assert.equal(h.timers.size, 0);
});

test("timeout aborts late upgradeneeded instead of implicitly creating a missing DB", async () => {
  const request = {};
  const h = harness({ open() { return request; } });
  const outcome = rejectsCode(h.probe(readOptions()), "QA_IDB_TIMEOUT");
  h.expire();
  await outcome;
  let aborts = 0;
  let closes = 0;
  request.transaction = { abort() { aborts += 1; } };
  request.result = { close() { closes += 1; } };
  request.onupgradeneeded({ oldVersion: 0, newVersion: 1 });
  assert.equal(aborts, 1);
  assert.equal(closes, 1);
});

test("hash failure is fixed and a never-settling hash remains bounded", async () => {
  const factory = new IDBFactory();
  await seed(factory);
  await rejectsCode(harness(factory, { crypto: { subtle: { digest() {
    return Promise.reject(new Error("synthetic private diagnostic"));
  } } } }).probe(readOptions()), "QA_IDB_HASH");
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const h = harness(factory, { crypto: { subtle: { digest() { entered(); return new Promise(() => {}); } } } });
  const outcome = rejectsCode(h.probe(readOptions()), "QA_IDB_TIMEOUT");
  await started;
  h.expire();
  await outcome;
  assert.equal(h.timers.size, 0);
});

test("upgrade rechecks oldVersion after a competing version change", async () => {
  const factory = new IDBFactory();
  await seed(factory);
  let hashes = 0;
  const h = harness(factory, { crypto: { subtle: { async digest(...args) {
    hashes += 1;
    if (hashes === 1) {
      await new Promise((resolve, reject) => {
        const request = factory.open(DATABASE, 2);
        request.onerror = () => reject(new Error("SYNTHETIC_VERSION_FAILED"));
        request.onsuccess = () => { request.result.close(); resolve(); };
      });
    }
    return webcrypto.subtle.digest(...args);
  } } } });
  await rejectsCode(h.probe(upgradeOptions()), "QA_IDB_VERSION");
  assert.equal((await contents(factory)).version, 2);
});

test("timeout after a committed upgrade does not claim or perform rollback", async () => {
  const factory = new IDBFactory();
  await seed(factory);
  let hashes = 0;
  let entered;
  const finalHash = new Promise((resolve) => { entered = resolve; });
  const h = harness(factory, { crypto: { subtle: { digest(...args) {
    hashes += 1;
    if (hashes === 1) return webcrypto.subtle.digest(...args);
    entered();
    return new Promise(() => {});
  } } } });
  const outcome = rejectsCode(h.probe(upgradeOptions()), "QA_IDB_TIMEOUT");
  await finalHash;
  h.expire();
  await outcome;
  assert.equal((await contents(factory)).version, 99);
  assert.equal(h.timers.size, 0);
});
