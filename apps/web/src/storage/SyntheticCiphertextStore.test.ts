import { IDBDatabase as FakeDatabase, IDBFactory, IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSyntheticCiphertextStore,
  MAX_SYNTHETIC_ARCHIVE_BYTES,
  MAX_SYNTHETIC_CONFLICT_ARCHIVES,
  SYNTHETIC_VAULT_DATABASE_NAME,
  SyntheticStorageError,
} from "./SyntheticCiphertextStore";

let factory: IDBFactory;

function sequentialConflictIds(start = 1) {
  let next = start;
  return (target: Uint8Array) => {
    target.fill(0);
    target[target.byteLength - 1] = next;
    next += 1;
  };
}

function hexConflictId(value: number): string {
  return value.toString(16).padStart(32, "0");
}

function openRaw(version = 1, upgrade?: (database: globalThis.IDBDatabase) => void) {
  return new Promise<globalThis.IDBDatabase>((resolve, reject) => {
    const request = factory.open(SYNTHETIC_VAULT_DATABASE_NAME, version);
    request.onupgradeneeded = () => {
      if (upgrade) upgrade(request.result);
      else request.result.createObjectStore("bundle");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function seed(value: unknown, key = "archive", version = 1) {
  const database = await openRaw(version);
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("bundle", "readwrite");
    transaction.objectStore("bundle").add(value, key);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onabort = () => { database.close(); reject(transaction.error); };
  });
}

async function rawRecords(version = 1) {
  const database = await openRaw(version);
  return new Promise<{ keys: IDBValidKey[]; values: unknown[] }>((resolve, reject) => {
    const transaction = database.transaction("bundle", "readonly");
    const store = transaction.objectStore("bundle");
    const keys = store.getAllKeys();
    const values = store.getAll();
    transaction.oncomplete = () => {
      database.close();
      resolve({ keys: keys.result, values: values.result });
    };
    transaction.onabort = () => { database.close(); reject(transaction.error); };
  });
}

beforeEach(() => { factory = new IDBFactory(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("synthetic ciphertext IndexedDB storage", () => {
  it("uses one explicitly synthetic database, store and ciphertext-only record", async () => {
    const open = vi.spyOn(factory, "open");
    const store = createSyntheticCiphertextStore(factory);
    expect(await store.read()).toBeNull();
    expect(await store.createIfAbsent(new Uint8Array([17, 34, 51]))).toBe("created");
    expect(await store.read()).toEqual(new Uint8Array([17, 34, 51]));
    expect(open.mock.calls.every(([name, version]) =>
      name === "keyatlas-synthetic-vault-v1" && version === 1)).toBe(true);
    const database = await openRaw();
    expect(Array.from(database.objectStoreNames)).toEqual(["bundle"]);
    database.close();
    expect(await rawRecords()).toEqual({
      keys: ["archive"], values: [new Uint8Array([17, 34, 51])],
    });
  });

  it("retains committed bytes through a new store instance", async () => {
    await createSyntheticCiphertextStore(factory).createIfAbsent(new Uint8Array([71]));
    expect(await createSyntheticCiphertextStore(factory).read()).toEqual(new Uint8Array([71]));
  });

  it("compares and replaces committed ciphertext across store instances", async () => {
    const original = new Uint8Array([17, 34, 51]);
    const replacement = new Uint8Array([68, 85]);
    await createSyntheticCiphertextStore(factory).createIfAbsent(original);
    await expect(createSyntheticCiphertextStore(factory).compareAndSwapArchive(original, replacement))
      .resolves.toBe("updated");
    expect(await createSyntheticCiphertextStore(factory).read()).toEqual(replacement);
  });

  it("validates, compares and writes inside one readwrite transaction", async () => {
    const original = new Uint8Array([1, 2, 3]);
    const replacement = new Uint8Array([4, 5, 6]);
    const store = createSyntheticCiphertextStore(factory);
    await store.createIfAbsent(original);
    const transactions: globalThis.IDBTransaction[] = [];
    const originalKeys = FakeObjectStore.prototype.getAllKeys;
    const originalGet = FakeObjectStore.prototype.get;
    const originalPut = FakeObjectStore.prototype.put;
    vi.spyOn(FakeObjectStore.prototype, "getAllKeys").mockImplementation(function (this: globalThis.IDBObjectStore, query, count) {
      transactions.push(this.transaction);
      return originalKeys.call(this, query, count);
    });
    vi.spyOn(FakeObjectStore.prototype, "get").mockImplementation(function (this: globalThis.IDBObjectStore, query) {
      transactions.push(this.transaction);
      return originalGet.call(this, query);
    });
    const put = vi.spyOn(FakeObjectStore.prototype, "put").mockImplementation(function (this: globalThis.IDBObjectStore, value, key) {
      transactions.push(this.transaction);
      return originalPut.call(this, value, key);
    });
    await expect(store.compareAndSwapArchive(original, replacement)).resolves.toBe("updated");
    expect(transactions).toHaveLength(3);
    expect(new Set(transactions).size).toBe(1);
    expect(transactions[0]?.mode).toBe("readwrite");
    expect(put).toHaveBeenCalledExactlyOnceWith(replacement, "archive");
  });

  it.each([0, 1, 2])("rejects equal-length ciphertext with a different byte at index %s", async (index) => {
    const original = new Uint8Array([1, 2, 3]);
    const expected = new Uint8Array(original);
    expected[index] = expected[index]! + 1;
    const store = createSyntheticCiphertextStore(factory);
    await store.createIfAbsent(original);
    const add = vi.spyOn(FakeObjectStore.prototype, "add");
    const put = vi.spyOn(FakeObjectStore.prototype, "put");
    await expect(store.compareAndSwapArchive(expected, new Uint8Array([9]))).resolves.toBe("conflict");
    expect(add).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await store.read()).toEqual(original);
  });

  it("rejects ciphertext of a different length without replacing it", async () => {
    const store = createSyntheticCiphertextStore(factory);
    await store.createIfAbsent(new Uint8Array([1, 2]));
    await expect(store.compareAndSwapArchive(new Uint8Array([1]), new Uint8Array([9])))
      .resolves.toBe("conflict");
    expect(await store.read()).toEqual(new Uint8Array([1, 2]));
  });

  it("atomically permits exactly one of two competing editors", async () => {
    const original = new Uint8Array([1, 2]);
    const first = createSyntheticCiphertextStore(factory);
    const second = createSyntheticCiphertextStore(factory);
    await first.createIfAbsent(original);
    const outcomes = await Promise.all([
      first.compareAndSwapArchive(original, new Uint8Array([11])),
      second.compareAndSwapArchive(original, new Uint8Array([22])),
    ]);
    expect([...outcomes].sort()).toEqual(["conflict", "updated"]);
    expect(await createSyntheticCiphertextStore(factory).read())
      .toEqual(new Uint8Array([outcomes[0] === "updated" ? 11 : 22]));
  });

  it("rejects a stale retry after an earlier update commits", async () => {
    const store = createSyntheticCiphertextStore(factory);
    const original = new Uint8Array([1, 2]);
    const updated = new Uint8Array([3, 4]);
    await store.createIfAbsent(original);
    await expect(store.compareAndSwapArchive(original, updated)).resolves.toBe("updated");
    await expect(store.compareAndSwapArchive(original, new Uint8Array([5, 6])))
      .resolves.toBe("conflict");
    expect(await store.read()).toEqual(updated);
  });

  it("snapshots both CAS inputs before database open or the first await", async () => {
    const store = createSyntheticCiphertextStore(factory);
    const expected = new Uint8Array([12, 34]);
    const next = new Uint8Array([56, 78]);
    await store.createIfAbsent(expected);
    const originalOpen = factory.open.bind(factory);
    vi.spyOn(factory, "open").mockImplementationOnce((name, version) => {
      expected.fill(0);
      next.fill(0);
      return originalOpen(name, version);
    });
    const pending = store.compareAndSwapArchive(expected, next);
    expected.fill(9);
    next.fill(9);
    await expect(pending).resolves.toBe("updated");
    expect(await store.read()).toEqual(new Uint8Array([56, 78]));
  });

  it.each([false, true])("returns missing without add or put (database already exists: %s)", async (initialized) => {
    const store = createSyntheticCiphertextStore(factory);
    if (initialized) await store.read();
    const add = vi.spyOn(FakeObjectStore.prototype, "add");
    const put = vi.spyOn(FakeObjectStore.prototype, "put");
    await expect(store.compareAndSwapArchive(new Uint8Array([1]), new Uint8Array([2])))
      .resolves.toBe("missing");
    expect(add).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await rawRecords()).toEqual({ keys: [], values: [] });
  });

  it("snapshots input before awaiting and returns independent output bytes", async () => {
    const store = createSyntheticCiphertextStore(factory);
    const input = new Uint8Array([12, 34]);
    const creation = store.createIfAbsent(input);
    input.fill(0);
    await creation;
    const read = await store.read();
    expect(read).toEqual(new Uint8Array([12, 34]));
    read?.fill(9);
    expect(await store.read()).toEqual(new Uint8Array([12, 34]));
  });

  it("does not replace an existing ciphertext archive", async () => {
    const store = createSyntheticCiphertextStore(factory);
    await store.createIfAbsent(new Uint8Array([1]));
    expect(await store.createIfAbsent(new Uint8Array([2]))).toBe("exists");
    expect(await store.read()).toEqual(new Uint8Array([1]));
  });

  it("atomically permits exactly one of two concurrent creators", async () => {
    const first = createSyntheticCiphertextStore(factory);
    const second = createSyntheticCiphertextStore(factory);
    const outcomes = await Promise.all([
      first.createIfAbsent(new Uint8Array([11])),
      second.createIfAbsent(new Uint8Array([22])),
    ]);
    expect([...outcomes].sort()).toEqual(["created", "exists"]);
    expect(await first.read()).toEqual(new Uint8Array([outcomes[0] === "created" ? 11 : 22]));
  });

  it("accepts the exact maximum byte count", async () => {
    const store = createSyntheticCiphertextStore(factory);
    await expect(store.createIfAbsent(new Uint8Array(MAX_SYNTHETIC_ARCHIVE_BYTES))).resolves.toBe("created");
    expect((await store.read())?.byteLength).toBe(512 * 1024);
  });

  it("accepts maximum-sized expected and next ciphertext for CAS", async () => {
    const store = createSyntheticCiphertextStore(factory);
    const original = new Uint8Array(MAX_SYNTHETIC_ARCHIVE_BYTES);
    const replacement = new Uint8Array(MAX_SYNTHETIC_ARCHIVE_BYTES).fill(1);
    await store.createIfAbsent(original);
    await expect(store.compareAndSwapArchive(original, replacement)).resolves.toBe("updated");
    expect(await store.read()).toEqual(replacement);
  }, 15_000);

  describe.each(["expected", "next"] as const)("CAS %s input", (argument) => {
    it.each([
      ["empty", new Uint8Array()],
      ["oversized", new Uint8Array(MAX_SYNTHETIC_ARCHIVE_BYTES + 1)],
      ["empty with shadowed byteLength", Object.defineProperty(new Uint8Array(), "byteLength", { value: 1 })],
      ["oversized with shadowed byteLength", Object.defineProperty(
        new Uint8Array(MAX_SYNTHETIC_ARCHIVE_BYTES + 1), "byteLength", { value: 1 },
      )],
      ["text", "plaintext"],
      ["object", { bytes: new Uint8Array([1]), note: "plaintext" }],
      ["array", [1, 2]],
      ["buffer", new ArrayBuffer(1)],
      ["wrong typed array", new Uint16Array([1])],
      ["subclass", new (class extends Uint8Array {})([1])],
      ["undefined", undefined],
      ["null", null],
    ])("rejects %s before touching the database", async (_label, value) => {
      const open = vi.spyOn(factory, "open");
      const valid = new Uint8Array([1]);
      await expect(createSyntheticCiphertextStore(factory).compareAndSwapArchive(
        argument === "expected" ? value as Uint8Array : valid,
        argument === "next" ? value as Uint8Array : valid,
      )).rejects.toMatchObject({ code: "invalid-bytes" });
      expect(open).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["empty", new Uint8Array()],
    ["oversized", new Uint8Array(MAX_SYNTHETIC_ARCHIVE_BYTES + 1)],
    ["empty with shadowed byteLength", Object.defineProperty(new Uint8Array(), "byteLength", { value: 1 })],
    ["oversized with shadowed byteLength", Object.defineProperty(
      new Uint8Array(MAX_SYNTHETIC_ARCHIVE_BYTES + 1), "byteLength", { value: 1 },
    )],
    ["text", "plaintext"],
    ["object", { bytes: new Uint8Array([1]), note: "plaintext" }],
    ["array", [1, 2]],
    ["buffer", new ArrayBuffer(1)],
    ["wrong typed array", new Uint16Array([1])],
    ["undefined", undefined],
  ])("rejects %s input before touching the database", async (_label, value) => {
    const open = vi.spyOn(factory, "open");
    await expect(createSyntheticCiphertextStore(factory).createIfAbsent(value as Uint8Array))
      .rejects.toMatchObject({ code: "invalid-bytes" });
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", new Uint8Array()],
    ["oversized", new Uint8Array(MAX_SYNTHETIC_ARCHIVE_BYTES + 1)],
    ["object", { format: 99, bytes: new Uint8Array([3]) }],
    ["text", "saved-unknown-value"],
    ["undefined", undefined],
    ["wrong typed array", new Uint16Array([1])],
  ])("preserves malformed %s values and fails closed", async (_label, value) => {
    await seed(value);
    const before = await rawRecords();
    const store = createSyntheticCiphertextStore(factory);
    await expect(store.read()).rejects.toMatchObject({ code: "corrupt" });
    await expect(store.createIfAbsent(new Uint8Array([99]))).rejects.toMatchObject({ code: "corrupt" });
    await expect(store.compareAndSwapArchive(new Uint8Array([1]), new Uint8Array([99])))
      .rejects.toMatchObject({ code: "corrupt" });
    expect(await rawRecords()).toEqual(before);
  });

  it.each([false, true])("preserves unexpected keys (known key also present: %s)", async (withArchive) => {
    await seed(new Uint8Array([8]), "future-key");
    if (withArchive) await seed(new Uint8Array([1]));
    const before = await rawRecords();
    const store = createSyntheticCiphertextStore(factory);
    await expect(store.read()).rejects.toMatchObject({ code: "corrupt" });
    await expect(store.createIfAbsent(new Uint8Array([99]))).rejects.toMatchObject({ code: "corrupt" });
    await expect(store.compareAndSwapArchive(new Uint8Array([1]), new Uint8Array([99])))
      .rejects.toMatchObject({ code: "corrupt" });
    expect(await rawRecords()).toEqual(before);
  });

  it("refuses a newer database version without resetting or overwriting it", async () => {
    await seed(new Uint8Array([80]), "archive", 2);
    const store = createSyntheticCiphertextStore(factory);
    await expect(store.read()).rejects.toMatchObject({ code: "incompatible" });
    await expect(store.createIfAbsent(new Uint8Array([99]))).rejects.toMatchObject({ code: "incompatible" });
    await expect(store.compareAndSwapArchive(new Uint8Array([80]), new Uint8Array([99])))
      .rejects.toMatchObject({ code: "incompatible" });
    expect(await rawRecords(2)).toEqual({ keys: ["archive"], values: [new Uint8Array([80])] });
  });

  it.each(["missing-store", "extra-store", "key-path", "auto-increment", "index"])(
    "refuses the incompatible %s schema without repairing it", async (schema) => {
      const database = await openRaw(1, (database) => {
        if (schema === "missing-store") { database.createObjectStore("unknown"); return; }
        const objectStore = database.createObjectStore("bundle", {
          keyPath: schema === "key-path" ? "id" : null,
          autoIncrement: schema === "auto-increment",
        });
        if (schema === "extra-store") database.createObjectStore("unknown");
        if (schema === "index") objectStore.createIndex("unexpected", "field");
      });
      const before = Array.from(database.objectStoreNames);
      database.close();
      const store = createSyntheticCiphertextStore(factory);
      await expect(store.read()).rejects.toMatchObject({ code: "incompatible" });
      await expect(store.createIfAbsent(new Uint8Array([99]))).rejects.toMatchObject({ code: "incompatible" });
      await expect(store.compareAndSwapArchive(new Uint8Array([1]), new Uint8Array([99])))
        .rejects.toMatchObject({ code: "incompatible" });
      const after = await openRaw();
      expect(after.version).toBe(1);
      expect(Array.from(after.objectStoreNames)).toEqual(before);
      after.close();
    },
  );

  it("reports a fixed quota failure and leaves no partial archive", async () => {
    const store = createSyntheticCiphertextStore(factory);
    await store.read();
    const add = vi.spyOn(FakeObjectStore.prototype, "add").mockImplementationOnce(() => {
      throw new DOMException("private browser diagnostic", "QuotaExceededError");
    });
    await expect(store.createIfAbsent(new Uint8Array([1]))).rejects.toMatchObject({
      code: "quota", message: "Local encrypted storage has insufficient space.",
    });
    add.mockRestore();
    expect(await store.read()).toBeNull();
  });

  it("rejects and rolls back if the transaction aborts after request success", async () => {
    const store = createSyntheticCiphertextStore(factory);
    await store.read();
    const originalAdd = FakeObjectStore.prototype.add;
    const add = vi.spyOn(FakeObjectStore.prototype, "add").mockImplementationOnce(function (this: globalThis.IDBObjectStore, value, key) {
      const request = originalAdd.call(this, value, key);
      request.addEventListener("success", () => { request.transaction?.abort(); });
      return request;
    });
    await expect(store.createIfAbsent(new Uint8Array([1]))).rejects.toMatchObject({ code: "aborted" });
    add.mockRestore();
    expect(await store.read()).toBeNull();
  });

  it("resolves only after the readwrite transaction completes", async () => {
    const events: string[] = [];
    const originalTransaction = FakeDatabase.prototype.transaction;
    vi.spyOn(FakeDatabase.prototype, "transaction").mockImplementation(function (this: globalThis.IDBDatabase, names, mode, options) {
      const transaction = originalTransaction.call(this, names, mode, options);
      if (mode === "readwrite") transaction.addEventListener("complete", () => { events.push("commit"); });
      return transaction;
    });
    await createSyntheticCiphertextStore(factory).createIfAbsent(new Uint8Array([1]));
    events.push("resolved");
    expect(events).toEqual(["commit", "resolved"]);
  });

  it.each([
    ["quota", new DOMException("private browser diagnostic", "QuotaExceededError"), "quota"],
    ["synchronous error", new Error("private browser diagnostic"), "failed"],
  ])("normalizes a %s from CAS read and leaves the archive untouched", async (_label, error, code) => {
    const store = createSyntheticCiphertextStore(factory);
    const original = new Uint8Array([1, 2, 3]);
    await store.createIfAbsent(original);
    const get = vi.spyOn(FakeObjectStore.prototype, "get").mockImplementationOnce(() => { throw error; });
    const put = vi.spyOn(FakeObjectStore.prototype, "put");
    await expect(store.compareAndSwapArchive(original, new Uint8Array([9, 8, 7])))
      .rejects.toEqual(new SyntheticStorageError(code as "quota" | "failed"));
    expect(put).not.toHaveBeenCalled();
    get.mockRestore();
    expect(await rawRecords()).toEqual({ keys: ["archive"], values: [original] });
  });

  it.each([
    ["quota", new DOMException("private browser diagnostic", "QuotaExceededError"), "quota"],
    ["synchronous error", new Error("private browser diagnostic"), "failed"],
  ])("rolls CAS back on a %s thrown after queuing put", async (_label, error, code) => {
    const store = createSyntheticCiphertextStore(factory);
    const original = new Uint8Array([1, 2, 3]);
    await store.createIfAbsent(original);
    const originalPut = FakeObjectStore.prototype.put;
    const put = vi.spyOn(FakeObjectStore.prototype, "put").mockImplementationOnce(function (this: globalThis.IDBObjectStore, value, key) {
      originalPut.call(this, value, key);
      throw error;
    });
    await expect(store.compareAndSwapArchive(original, new Uint8Array([9, 8, 7])))
      .rejects.toEqual(new SyntheticStorageError(code as "quota" | "failed"));
    put.mockRestore();
    expect(await rawRecords()).toEqual({ keys: ["archive"], values: [original] });
  });

  it("normalizes a CAS put request error and preserves committed ciphertext", async () => {
    const store = createSyntheticCiphertextStore(factory);
    const original = new Uint8Array([1, 2, 3]);
    await store.createIfAbsent(original);
    const originalPut = FakeObjectStore.prototype.put;
    const put = vi.spyOn(FakeObjectStore.prototype, "put").mockImplementationOnce(function (this: globalThis.IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      request.addEventListener("success", () => {
        // Inject an asynchronous browser quota failure before transaction commit.
        Object.defineProperty(request, "error", {
          value: new DOMException("private browser diagnostic", "QuotaExceededError"),
        });
        request.onerror?.call(request, new Event("error"));
        request.transaction?.abort();
      });
      return request;
    });
    await expect(store.compareAndSwapArchive(original, new Uint8Array([9, 8, 7])))
      .rejects.toEqual(new SyntheticStorageError("quota"));
    put.mockRestore();
    expect(await rawRecords()).toEqual({ keys: ["archive"], values: [original] });
  });

  it("rolls CAS back when the transaction aborts after put request success", async () => {
    const store = createSyntheticCiphertextStore(factory);
    const original = new Uint8Array([1, 2, 3]);
    await store.createIfAbsent(original);
    const events: string[] = [];
    const originalPut = FakeObjectStore.prototype.put;
    const put = vi.spyOn(FakeObjectStore.prototype, "put").mockImplementationOnce(function (this: globalThis.IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      request.addEventListener("success", () => {
        events.push("put-success");
        request.transaction?.abort();
      });
      return request;
    });
    await expect(store.compareAndSwapArchive(original, new Uint8Array([9, 8, 7])))
      .rejects.toEqual(new SyntheticStorageError("aborted"));
    expect(events).toEqual(["put-success"]);
    put.mockRestore();
    expect(await rawRecords()).toEqual({ keys: ["archive"], values: [original] });
  });

  it("does not resolve CAS at put success and resolves only after commit", async () => {
    const store = createSyntheticCiphertextStore(factory);
    const original = new Uint8Array([1]);
    await store.createIfAbsent(original);
    const events: string[] = [];
    const originalPut = FakeObjectStore.prototype.put;
    let resolved = false;
    vi.spyOn(FakeObjectStore.prototype, "put").mockImplementationOnce(function (this: globalThis.IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      request.addEventListener("success", () => {
        events.push("put-success");
        expect(resolved).toBe(false);
        queueMicrotask(() => { expect(resolved).toBe(false); });
      });
      this.transaction.addEventListener("complete", () => { events.push("commit"); });
      return request;
    });
    await expect(store.compareAndSwapArchive(original, new Uint8Array([2])).then((result) => {
      resolved = true;
      events.push("resolved");
      return result;
    })).resolves.toBe("updated");
    expect(events).toEqual(["put-success", "commit", "resolved"]);
  });

  it.each(["name-getter", "prototype-trap"])(
    "guards error normalization from a throwing %s during CAS", async (kind) => {
      const store = createSyntheticCiphertextStore(factory);
      const original = new Uint8Array([1]);
      await store.createIfAbsent(original);
      const thrown = kind === "name-getter"
        ? Object.defineProperty(new Error(), "name", { get() { throw new Error("private getter diagnostic"); } })
        : new Proxy({}, { getPrototypeOf() { throw new Error("private proxy diagnostic"); } });
      const put = vi.spyOn(FakeObjectStore.prototype, "put").mockImplementationOnce(() => { throw thrown; });
      await expect(store.compareAndSwapArchive(original, new Uint8Array([2])))
        .rejects.toEqual(new SyntheticStorageError("failed"));
      put.mockRestore();
      expect(await store.read()).toEqual(original);
    },
  );

  it("does not log ciphertext, inputs or browser diagnostics on CAS outcomes", async () => {
    const logs = ["debug", "info", "log", "warn", "error", "trace"] as const;
    const spies = logs.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const store = createSyntheticCiphertextStore(factory);
    const original = new Uint8Array([11, 22, 33]);
    const replacement = new Uint8Array([44, 55, 66]);
    await expect(store.compareAndSwapArchive(original, replacement)).resolves.toBe("missing");
    await store.createIfAbsent(original);
    await expect(store.compareAndSwapArchive(original, replacement)).resolves.toBe("updated");
    await expect(store.compareAndSwapArchive(original, replacement)).resolves.toBe("conflict");
    await expect(store.compareAndSwapArchive(replacement, "private plaintext" as unknown as Uint8Array))
      .rejects.toEqual(new SyntheticStorageError("invalid-bytes"));
    vi.spyOn(FakeObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("private browser diagnostic", "QuotaExceededError");
    });
    await expect(store.compareAndSwapArchive(replacement, original))
      .rejects.toEqual(new SyntheticStorageError("quota"));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed when IndexedDB is unavailable, without an in-memory fallback", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const store = createSyntheticCiphertextStore();
    await expect(store.read()).rejects.toMatchObject({ code: "unavailable" });
    await expect(store.createIfAbsent(new Uint8Array([1]))).rejects.toMatchObject({ code: "unavailable" });
    await expect(store.compareAndSwapArchive(new Uint8Array([1]), new Uint8Array([2])))
      .rejects.toMatchObject({ code: "unavailable" });
  });

  it("normalizes browser opening failures without exposing error text", async () => {
    vi.spyOn(factory, "open").mockImplementation(() => {
      throw new DOMException("private browser diagnostic", "SecurityError");
    });
    await expect(createSyntheticCiphertextStore(factory).read()).rejects.toEqual(
      new SyntheticStorageError("unavailable"),
    );
  });

  it("rejects blocked opens and closes a late successful connection", async () => {
    const close = vi.fn();
    const abort = vi.fn();
    const request = {
      result: { close }, transaction: { abort },
      onblocked: null, onupgradeneeded: null, onsuccess: null,
    } as unknown as IDBOpenDBRequest;
    vi.spyOn(factory, "open").mockReturnValue(request);
    const pending = createSyntheticCiphertextStore(factory).read();
    request.onblocked?.call(request, {} as IDBVersionChangeEvent);
    await expect(pending).rejects.toMatchObject({ code: "blocked" });
    request.onupgradeneeded?.call(request, { oldVersion: 0 } as IDBVersionChangeEvent);
    expect(abort).toHaveBeenCalledOnce();
    request.onsuccess?.call(request, new Event("success"));
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes its connection on versionchange", async () => {
    const originalOpen = factory.open.bind(factory);
    let captured: globalThis.IDBDatabase | undefined;
    vi.spyOn(factory, "open").mockImplementation((name, version) => {
      const request = originalOpen(name, version);
      request.addEventListener("success", () => { captured = request.result; });
      return request;
    });
    await createSyntheticCiphertextStore(factory).read();
    expect(captured).toBeDefined();
    const connection = captured!;
    const close = vi.spyOn(connection, "close");
    connection.onversionchange?.call(connection, new Event("versionchange") as IDBVersionChangeEvent);
    expect(close).toHaveBeenCalledOnce();
  });

  describe("atomic ciphertext backup snapshots", () => {
    it("returns the exact empty snapshot shape without creating archive records", async () => {
      const snapshot = await createSyntheticCiphertextStore(factory).readBackupSnapshot();
      expect(snapshot).toEqual({ archive: null, conflicts: [] });
      expect(Object.keys(snapshot).sort()).toEqual(["archive", "conflicts"]);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.conflicts)).toBe(true);
      expect(await rawRecords()).toEqual({ keys: [], values: [] });
    });

    it.each([false, true])("reads a committed archive/conflict pair from another store (conflict: %s)", async (withConflict) => {
      const writer = createSyntheticCiphertextStore(factory, sequentialConflictIds());
      const archive = new Uint8Array([1, 2]);
      const candidate = new Uint8Array([3, 4]);
      await writer.createIfAbsent(archive);
      if (withConflict) await writer.preserveConflictArchiveIfCurrentDiffers(candidate);
      const reader = createSyntheticCiphertextStore(factory);
      expect(await reader.readBackupSnapshot()).toEqual({
        archive,
        conflicts: withConflict ? [{ conflictId: hexConflictId(1), bytes: candidate }] : [],
      });
    });

    it("reads each bounded key once in one readonly transaction without mutations", async () => {
      const store = createSyntheticCiphertextStore(factory, sequentialConflictIds());
      await store.createIfAbsent(new Uint8Array([1]));
      await store.preserveConflictArchiveIfCurrentDiffers(new Uint8Array([2]));
      const transaction = vi.spyOn(FakeDatabase.prototype, "transaction");
      const keys = vi.spyOn(FakeObjectStore.prototype, "getAllKeys");
      const get = vi.spyOn(FakeObjectStore.prototype, "get");
      const add = vi.spyOn(FakeObjectStore.prototype, "add");
      const put = vi.spyOn(FakeObjectStore.prototype, "put");
      const remove = vi.spyOn(FakeObjectStore.prototype, "delete");
      const clear = vi.spyOn(FakeObjectStore.prototype, "clear");
      await store.readBackupSnapshot();
      expect(transaction).toHaveBeenCalledExactlyOnceWith("bundle", "readonly");
      expect(keys).toHaveBeenCalledExactlyOnceWith(undefined, MAX_SYNTHETIC_CONFLICT_ARCHIVES + 2);
      expect(get.mock.calls).toEqual([["archive"], [`conflict:${hexConflictId(1)}`]]);
      expect(add).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
    });

    it("resolves only after its readonly transaction completes", async () => {
      await seed(new Uint8Array([1]));
      const events: string[] = [];
      const originalGet = FakeObjectStore.prototype.get;
      vi.spyOn(FakeObjectStore.prototype, "get").mockImplementationOnce(function (
        this: globalThis.IDBObjectStore, key,
      ) {
        const request = originalGet.call(this, key);
        request.addEventListener("success", () => { events.push("read-success"); });
        this.transaction.addEventListener("complete", () => { events.push("complete"); });
        return request;
      });
      await createSyntheticCiphertextStore(factory).readBackupSnapshot();
      events.push("resolved");
      expect(events).toEqual(["read-success", "complete", "resolved"]);
    });

    it.each(["before", "after"] as const)("observes one consistent pair when a writer transaction starts %s the snapshot", async (ordering) => {
      await seed(new Uint8Array([1]));
      const writerDatabase = await openRaw();
      const updated = new Uint8Array([2]);
      const conflict = new Uint8Array([3]);
      const writePair = () => new Promise<void>((resolve, reject) => {
        const transaction = writerDatabase.transaction("bundle", "readwrite");
        const records = transaction.objectStore("bundle");
        records.put(updated, "archive");
        records.add(conflict, `conflict:${hexConflictId(1)}`);
        transaction.oncomplete = () => { writerDatabase.close(); resolve(); };
        transaction.onabort = () => { writerDatabase.close(); reject(transaction.error); };
      });
      let pendingWrite: Promise<void> | undefined;
      if (ordering === "before") {
        pendingWrite = writePair();
      } else {
        const originalKeys = FakeObjectStore.prototype.getAllKeys;
        vi.spyOn(FakeObjectStore.prototype, "getAllKeys").mockImplementationOnce(function (
          this: globalThis.IDBObjectStore, query, count,
        ) {
          const request = originalKeys.call(this, query, count);
          pendingWrite = writePair();
          return request;
        });
      }
      const reader = createSyntheticCiphertextStore(factory);
      const snapshot = await reader.readBackupSnapshot();
      expect(snapshot).toEqual(ordering === "before"
        ? { archive: updated, conflicts: [{ conflictId: hexConflictId(1), bytes: conflict }] }
        : { archive: new Uint8Array([1]), conflicts: [] });
      expect(pendingWrite).toBeDefined();
      await pendingWrite;
      // A snapshot never promises to include transactions created after it.
      expect(await createSyntheticCiphertextStore(factory).readBackupSnapshot()).toEqual({
        archive: updated, conflicts: [{ conflictId: hexConflictId(1), bytes: conflict }],
      });
    });

    it("never returns a snapshot if its transaction aborts after all read requests succeed", async () => {
      await seed(new Uint8Array([1]));
      await seed(new Uint8Array([2]), `conflict:${hexConflictId(1)}`);
      const before = await rawRecords();
      const originalGet = FakeObjectStore.prototype.get;
      vi.spyOn(FakeObjectStore.prototype, "get").mockImplementation(function (
        this: globalThis.IDBObjectStore, key,
      ) {
        const request = originalGet.call(this, key);
        if (key === `conflict:${hexConflictId(1)}`) {
          request.addEventListener("success", () => {
            queueMicrotask(() => { request.transaction?.abort(); });
          });
        }
        return request;
      });
      const resolved = vi.fn();
      await expect(createSyntheticCiphertextStore(factory).readBackupSnapshot().then(resolved))
        .rejects.toEqual(new SyntheticStorageError("aborted"));
      expect(resolved).not.toHaveBeenCalled();
      expect(await rawRecords()).toEqual(before);
    });

    it("normalizes read request failures without returning a partial snapshot", async () => {
      await seed(new Uint8Array([1]));
      const before = await rawRecords();
      const originalGet = FakeObjectStore.prototype.get;
      vi.spyOn(FakeObjectStore.prototype, "get").mockImplementationOnce(function (
        this: globalThis.IDBObjectStore, key,
      ) {
        const request = originalGet.call(this, key);
        request.addEventListener("success", () => {
          Object.defineProperty(request, "error", {
            value: new DOMException("private browser diagnostic", "QuotaExceededError"),
          });
          request.onerror?.call(request, new Event("error"));
          request.transaction?.abort();
        });
        return request;
      });
      await expect(createSyntheticCiphertextStore(factory).readBackupSnapshot())
        .rejects.toEqual(new SyntheticStorageError("quota"));
      expect(await rawRecords()).toEqual(before);
    });

    it.each(["archive", "oversized-archive", "conflict", "oversized-conflict", "orphan", "key", "over-limit"] as const)("preserves the raw %s corruption and refuses a snapshot", async (kind) => {
      if (kind === "archive") await seed("saved-unknown-value");
      else if (kind === "oversized-archive") await seed(new Uint8Array(MAX_SYNTHETIC_ARCHIVE_BYTES + 1));
      else if (kind !== "orphan") await seed(new Uint8Array([1]));
      if (kind === "conflict") await seed(new Uint8Array(), `conflict:${hexConflictId(1)}`);
      if (kind === "oversized-conflict") {
        await seed(new Uint8Array(MAX_SYNTHETIC_ARCHIVE_BYTES + 1), `conflict:${hexConflictId(1)}`);
      }
      if (kind === "orphan") await seed(new Uint8Array([2]), `conflict:${hexConflictId(1)}`);
      if (kind === "key") await seed(new Uint8Array([2]), "future-key");
      if (kind === "over-limit") {
        for (let index = 1; index <= MAX_SYNTHETIC_CONFLICT_ARCHIVES + 1; index += 1) {
          await seed(new Uint8Array([index]), `conflict:${hexConflictId(index)}`);
        }
      }
      const before = await rawRecords();
      await expect(createSyntheticCiphertextStore(factory).readBackupSnapshot())
        .rejects.toEqual(new SyntheticStorageError("corrupt"));
      expect(await rawRecords()).toEqual(before);
    });

    it("refuses a future database version without migrating or deleting it", async () => {
      await seed(new Uint8Array([9]), "archive", 2);
      const before = await rawRecords(2);
      await expect(createSyntheticCiphertextStore(factory).readBackupSnapshot())
        .rejects.toEqual(new SyntheticStorageError("incompatible"));
      expect(await rawRecords(2)).toEqual(before);
    });

    it("returns owned byte copies independent of storage, each other and later snapshots", async () => {
      const store = createSyntheticCiphertextStore(factory, sequentialConflictIds());
      const archive = new Uint8Array([1, 2]);
      const conflict = new Uint8Array([3, 4]);
      await store.createIfAbsent(archive);
      await store.preserveConflictArchiveIfCurrentDiffers(conflict);
      const first = await store.readBackupSnapshot();
      const second = await store.readBackupSnapshot();
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.conflicts)).toBe(true);
      expect(Object.isFrozen(first.conflicts[0])).toBe(true);
      expect(first.archive?.buffer).not.toBe(first.conflicts[0]!.bytes.buffer);
      first.archive?.fill(0);
      first.conflicts[0]!.bytes.fill(0);
      const expected = { archive, conflicts: [{ conflictId: hexConflictId(1), bytes: conflict }] };
      expect(second).toEqual(expected);
      expect(await store.readBackupSnapshot()).toEqual(expected);
      expect(await rawRecords()).toEqual({
        keys: ["archive", `conflict:${hexConflictId(1)}`], values: [archive, conflict],
      });
    });
  });

  describe("durable ciphertext-only conflict outbox", () => {
    it("rejects SharedArrayBuffer-backed inputs before opening IndexedDB", async () => {
      const open = vi.spyOn(factory, "open");
      const store = createSyntheticCiphertextStore(factory, sequentialConflictIds());
      const shared = () => Object.defineProperty(
        new Uint8Array(new SharedArrayBuffer(1)), "buffer", { value: new ArrayBuffer(1) },
      );
      const valid = new Uint8Array([1]);
      await expect(store.createIfAbsent(shared())).rejects.toEqual(new SyntheticStorageError("invalid-bytes"));
      await expect(store.compareAndSwapArchive(shared(), valid))
        .rejects.toEqual(new SyntheticStorageError("invalid-bytes"));
      await expect(store.compareAndSwapArchive(valid, shared()))
        .rejects.toEqual(new SyntheticStorageError("invalid-bytes"));
      await expect(store.compareAndSwapArchivePreservingConflict(shared(), valid))
        .rejects.toEqual(new SyntheticStorageError("invalid-bytes"));
      await expect(store.compareAndSwapArchivePreservingConflict(valid, shared()))
        .rejects.toEqual(new SyntheticStorageError("invalid-bytes"));
      await expect(store.preserveConflictArchiveIfCurrentDiffers(shared()))
        .rejects.toEqual(new SyntheticStorageError("invalid-bytes"));
      await expect(store.deleteConflictArchiveIfEqual(hexConflictId(1), shared()))
        .rejects.toEqual(new SyntheticStorageError("invalid-bytes"));
      expect(open).not.toHaveBeenCalled();
    });

    it("uses the native backing-buffer getter without evaluating an own shadow", async () => {
      const shadow = vi.fn(() => { throw new Error("private buffer getter"); });
      const input = Object.defineProperty(new Uint8Array([1, 2]), "buffer", { get: shadow });
      const store = createSyntheticCiphertextStore(factory, sequentialConflictIds());
      await expect(store.createIfAbsent(input)).resolves.toBe("created");
      expect(await store.read()).toEqual(new Uint8Array([1, 2]));
      expect(shadow).not.toHaveBeenCalled();
    });

    it("keeps the database name, version and single store while preserving a conflict", async () => {
      const original = new Uint8Array([1, 2, 3]);
      const candidate = new Uint8Array([4, 5, 6]);
      const store = createSyntheticCiphertextStore(factory, (target) => target.fill(0xab));
      await store.createIfAbsent(original);

      await expect(store.compareAndSwapArchivePreservingConflict(new Uint8Array([9]), candidate))
        .resolves.toEqual({ kind: "conflict-preserved", conflictId: "ab".repeat(16) });
      expect(await store.read()).toEqual(original);
      expect(await store.listConflictArchives()).toEqual([
        { conflictId: "ab".repeat(16), bytes: candidate },
      ]);

      const database = await openRaw();
      expect(database.version).toBe(1);
      expect(Array.from(database.objectStoreNames)).toEqual(["bundle"]);
      database.close();
      expect(await rawRecords()).toEqual({
        keys: ["archive", `conflict:${"ab".repeat(16)}`],
        values: [original, candidate],
      });
    });

    it("never creates an outbox row for a missing archive or a successful update", async () => {
      const random = vi.fn(sequentialConflictIds());
      const store = createSyntheticCiphertextStore(factory, random);
      await expect(store.compareAndSwapArchivePreservingConflict(
        new Uint8Array([1]), new Uint8Array([2]),
      )).resolves.toEqual({ kind: "missing" });
      expect(random).not.toHaveBeenCalled();
      expect(await store.listConflictArchives()).toEqual([]);

      await store.createIfAbsent(new Uint8Array([1]));
      await expect(store.compareAndSwapArchivePreservingConflict(
        new Uint8Array([1]), new Uint8Array([2]),
      )).resolves.toEqual({ kind: "updated" });
      expect(random).not.toHaveBeenCalled();
      expect(await store.read()).toEqual(new Uint8Array([2]));
      expect(await store.listConflictArchives()).toEqual([]);
    });

    it("atomically preserves a post-CAS candidate only when current bytes differ", async () => {
      const random = vi.fn(sequentialConflictIds());
      const store = createSyntheticCiphertextStore(factory, random);
      await expect(store.preserveConflictArchiveIfCurrentDiffers(new Uint8Array([2])))
        .resolves.toEqual({ kind: "missing" });
      expect(random).not.toHaveBeenCalled();
      const original = new Uint8Array([1]);
      await store.createIfAbsent(original);
      await expect(store.preserveConflictArchiveIfCurrentDiffers(original))
        .resolves.toEqual({ kind: "already-current" });
      expect(random).not.toHaveBeenCalled();
      const candidate = new Uint8Array([2]);
      const pending = store.preserveConflictArchiveIfCurrentDiffers(candidate);
      candidate.fill(9);
      await expect(pending).resolves.toEqual({
        kind: "conflict-preserved", conflictId: hexConflictId(1),
      });
      expect(await store.read()).toEqual(original);
      expect(await store.listConflictArchives()).toEqual([
        { conflictId: hexConflictId(1), bytes: new Uint8Array([2]) },
      ]);
    });

    it("atomically leaves one concurrent winner in the archive and the loser in the outbox", async () => {
      const original = new Uint8Array([1]);
      const candidates = [new Uint8Array([11]), new Uint8Array([22])];
      const stores = [
        createSyntheticCiphertextStore(factory, (target) => target.fill(0x11)),
        createSyntheticCiphertextStore(factory, (target) => target.fill(0x22)),
      ];
      await stores[0]!.createIfAbsent(original);
      const outcomes = await Promise.all(stores.map((store, index) =>
        store.compareAndSwapArchivePreservingConflict(original, candidates[index]!)));
      const winner = outcomes.findIndex((outcome) => outcome.kind === "updated");
      const loser = outcomes.findIndex((outcome) => outcome.kind === "conflict-preserved");
      expect(winner).toBeGreaterThanOrEqual(0);
      expect(loser).toBeGreaterThanOrEqual(0);
      expect(winner).not.toBe(loser);
      expect(await stores[0]!.read()).toEqual(candidates[winner]);
      expect(await stores[0]!.listConflictArchives()).toEqual([
        { conflictId: outcomes[loser]!.kind === "conflict-preserved"
          ? outcomes[loser]!.conflictId : "unreachable", bytes: candidates[loser]! },
      ]);
    });

    it("reports conflict preservation only after its transaction commits", async () => {
      const store = createSyntheticCiphertextStore(factory, sequentialConflictIds());
      await store.createIfAbsent(new Uint8Array([1]));
      const events: string[] = [];
      const originalAdd = FakeObjectStore.prototype.add;
      vi.spyOn(FakeObjectStore.prototype, "add").mockImplementationOnce(function (
        this: globalThis.IDBObjectStore, value, key,
      ) {
        const request = originalAdd.call(this, value, key);
        request.addEventListener("success", () => { events.push("add-success"); });
        this.transaction.addEventListener("complete", () => { events.push("commit"); });
        return request;
      });
      await expect(store.compareAndSwapArchivePreservingConflict(
        new Uint8Array([9]), new Uint8Array([2]),
      ).then((outcome) => { events.push("resolved"); return outcome; }))
        .resolves.toMatchObject({ kind: "conflict-preserved" });
      expect(events).toEqual(["add-success", "commit", "resolved"]);
    });

    it("rolls back a conflict row when the transaction aborts after add success", async () => {
      const original = new Uint8Array([1]);
      const store = createSyntheticCiphertextStore(factory, sequentialConflictIds());
      await store.createIfAbsent(original);
      const originalAdd = FakeObjectStore.prototype.add;
      vi.spyOn(FakeObjectStore.prototype, "add").mockImplementationOnce(function (
        this: globalThis.IDBObjectStore, value, key,
      ) {
        const request = originalAdd.call(this, value, key);
        request.addEventListener("success", () => { request.transaction?.abort(); });
        return request;
      });
      await expect(store.compareAndSwapArchivePreservingConflict(
        new Uint8Array([9]), new Uint8Array([2]),
      )).rejects.toEqual(new SyntheticStorageError("aborted"));
      expect(await rawRecords()).toEqual({ keys: ["archive"], values: [original] });
    });

    it("preserves the archive and existing outbox on a conflict add quota failure", async () => {
      const original = new Uint8Array([1]);
      const store = createSyntheticCiphertextStore(factory, sequentialConflictIds());
      await store.createIfAbsent(original);
      vi.spyOn(FakeObjectStore.prototype, "add").mockImplementationOnce(() => {
        throw new DOMException("private browser diagnostic", "QuotaExceededError");
      });
      await expect(store.compareAndSwapArchivePreservingConflict(
        new Uint8Array([9]), new Uint8Array([2]),
      )).rejects.toEqual(new SyntheticStorageError("quota"));
      expect(await rawRecords()).toEqual({ keys: ["archive"], values: [original] });
    });

    it("normalizes a conflict add request error and rolls its transaction back", async () => {
      const original = new Uint8Array([1]);
      const store = createSyntheticCiphertextStore(factory, sequentialConflictIds());
      await store.createIfAbsent(original);
      const originalAdd = FakeObjectStore.prototype.add;
      vi.spyOn(FakeObjectStore.prototype, "add").mockImplementationOnce(function (
        this: globalThis.IDBObjectStore, value, key,
      ) {
        const request = originalAdd.call(this, value, key);
        request.addEventListener("success", () => {
          Object.defineProperty(request, "error", {
            value: new DOMException("private browser diagnostic", "QuotaExceededError"),
          });
          request.onerror?.call(request, new Event("error"));
          request.transaction?.abort();
        });
        return request;
      });
      await expect(store.compareAndSwapArchivePreservingConflict(
        new Uint8Array([9]), new Uint8Array([2]),
      )).rejects.toEqual(new SyntheticStorageError("quota"));
      expect(await rawRecords()).toEqual({ keys: ["archive"], values: [original] });
    });

    it("keeps exactly eight conflicts and refuses a ninth without eviction or RNG use", async () => {
      const random = vi.fn(sequentialConflictIds());
      const store = createSyntheticCiphertextStore(factory, random);
      const original = new Uint8Array([1]);
      await store.createIfAbsent(original);
      for (let index = 0; index < MAX_SYNTHETIC_CONFLICT_ARCHIVES; index += 1) {
        await expect(store.compareAndSwapArchivePreservingConflict(
          new Uint8Array([0]), new Uint8Array([index + 10]),
        )).resolves.toMatchObject({ kind: "conflict-preserved" });
      }
      const before = await store.listConflictArchives();
      await expect(store.compareAndSwapArchivePreservingConflict(
        new Uint8Array([0]), new Uint8Array([99]),
      )).rejects.toEqual(new SyntheticStorageError("outbox-full"));
      expect(random).toHaveBeenCalledTimes(MAX_SYNTHETIC_CONFLICT_ARCHIVES);
      expect(await store.read()).toEqual(original);
      expect(await store.listConflictArchives()).toEqual(before);
    });

    it("fails closed and preserves an orphan conflict row", async () => {
      await seed(new Uint8Array([7]), `conflict:${hexConflictId(1)}`);
      const before = await rawRecords();
      const store = createSyntheticCiphertextStore(factory, sequentialConflictIds());
      await expect(store.read()).rejects.toEqual(new SyntheticStorageError("corrupt"));
      await expect(store.listConflictArchives()).rejects.toEqual(new SyntheticStorageError("corrupt"));
      expect(await rawRecords()).toEqual(before);
    });

    it("fails closed and preserves malformed conflict keys and values", async () => {
      await seed(new Uint8Array([1]));
      await seed("private plaintext", `conflict:${hexConflictId(1)}`);
      const beforeBadValue = await rawRecords();
      await expect(createSyntheticCiphertextStore(factory).read())
        .rejects.toEqual(new SyntheticStorageError("corrupt"));
      expect(await rawRecords()).toEqual(beforeBadValue);

      factory = new IDBFactory();
      await seed(new Uint8Array([1]));
      await seed(new Uint8Array([2]), "conflict:ABC");
      const beforeBadKey = await rawRecords();
      await expect(createSyntheticCiphertextStore(factory).listConflictArchives())
        .rejects.toEqual(new SyntheticStorageError("corrupt"));
      expect(await rawRecords()).toEqual(beforeBadKey);
    });

    it("fails closed and preserves a raw over-limit conflict keyspace", async () => {
      await seed(new Uint8Array([1]));
      for (let index = 1; index <= MAX_SYNTHETIC_CONFLICT_ARCHIVES + 1; index += 1) {
        await seed(new Uint8Array([index]), `conflict:${hexConflictId(index)}`);
      }
      const before = await rawRecords();
      await expect(createSyntheticCiphertextStore(factory).read())
        .rejects.toEqual(new SyntheticStorageError("corrupt"));
      expect(await rawRecords()).toEqual(before);
    });

    it("returns independent conflict copies and deletes only an exact authenticated byte snapshot", async () => {
      const store = createSyntheticCiphertextStore(factory, sequentialConflictIds());
      await store.createIfAbsent(new Uint8Array([1]));
      const candidate = new Uint8Array([7, 8, 9]);
      const outcome = await store.compareAndSwapArchivePreservingConflict(
        new Uint8Array([0]), candidate,
      );
      expect(outcome.kind).toBe("conflict-preserved");
      const conflictId = outcome.kind === "conflict-preserved" ? outcome.conflictId : "unreachable";
      const first = await store.listConflictArchives();
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first[0])).toBe(true);
      first[0]!.bytes.fill(0);
      expect(await store.listConflictArchives()).toEqual([{ conflictId, bytes: candidate }]);
      await expect(store.deleteConflictArchiveIfEqual(conflictId, new Uint8Array([7, 8, 0])))
        .resolves.toBe("changed");
      expect(await store.listConflictArchives()).toHaveLength(1);
      await expect(store.deleteConflictArchiveIfEqual(conflictId, candidate)).resolves.toBe("deleted");
      await expect(store.deleteConflictArchiveIfEqual(conflictId, candidate)).resolves.toBe("missing");
      expect(await store.listConflictArchives()).toEqual([]);
    });

    it("rejects invalid conflict IDs and bytes before opening the database", async () => {
      const open = vi.spyOn(factory, "open");
      const store = createSyntheticCiphertextStore(factory, sequentialConflictIds());
      await expect(store.deleteConflictArchiveIfEqual("ABC", new Uint8Array([1])))
        .rejects.toEqual(new SyntheticStorageError("invalid-conflict-id"));
      await expect(store.deleteConflictArchiveIfEqual(hexConflictId(1), new Uint8Array()))
        .rejects.toEqual(new SyntheticStorageError("invalid-bytes"));
      await expect(store.compareAndSwapArchivePreservingConflict(
        new Uint8Array(), new Uint8Array([1]),
      )).rejects.toEqual(new SyntheticStorageError("invalid-bytes"));
      expect(open).not.toHaveBeenCalled();
    });

    it.each(["throw", "detach"] as const)("fails closed when the conflict ID source %s", async (kind) => {
      const source = kind === "throw"
        ? () => { throw new Error("private RNG diagnostic"); }
        : (target: Uint8Array) => {
          structuredClone(target.buffer as ArrayBuffer, { transfer: [target.buffer as ArrayBuffer] });
        };
      const original = new Uint8Array([1]);
      const store = createSyntheticCiphertextStore(factory, source);
      await store.createIfAbsent(original);
      await expect(store.compareAndSwapArchivePreservingConflict(
        new Uint8Array([0]), new Uint8Array([2]),
      )).rejects.toEqual(new SyntheticStorageError("failed"));
      expect(await rawRecords()).toEqual({ keys: ["archive"], values: [original] });
    });

    it("refuses a generated ID collision without replacing the first conflict", async () => {
      const store = createSyntheticCiphertextStore(factory, (target) => target.fill(0));
      await store.createIfAbsent(new Uint8Array([1]));
      await expect(store.compareAndSwapArchivePreservingConflict(
        new Uint8Array([0]), new Uint8Array([2]),
      )).resolves.toEqual({ kind: "conflict-preserved", conflictId: "0".repeat(32) });
      await expect(store.compareAndSwapArchivePreservingConflict(
        new Uint8Array([0]), new Uint8Array([3]),
      )).rejects.toEqual(new SyntheticStorageError("failed"));
      expect(await store.listConflictArchives()).toEqual([
        { conflictId: "0".repeat(32), bytes: new Uint8Array([2]) },
      ]);
    });

    it("keeps existing CAS behavior while valid conflict rows are present", async () => {
      const store = createSyntheticCiphertextStore(factory, sequentialConflictIds());
      const original = new Uint8Array([1]);
      const replacement = new Uint8Array([2]);
      await store.createIfAbsent(original);
      await store.compareAndSwapArchivePreservingConflict(new Uint8Array([0]), new Uint8Array([9]));
      const conflicts = await store.listConflictArchives();
      await expect(store.compareAndSwapArchive(original, replacement)).resolves.toBe("updated");
      await expect(store.createIfAbsent(new Uint8Array([3]))).resolves.toBe("exists");
      expect(await store.read()).toEqual(replacement);
      expect(await store.listConflictArchives()).toEqual(conflicts);
    });

    it("never logs archive or conflict bytes, IDs, or browser diagnostics", async () => {
      const spies = (["debug", "info", "log", "warn", "error", "trace"] as const)
        .map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
      const store = createSyntheticCiphertextStore(factory, sequentialConflictIds());
      await store.createIfAbsent(new Uint8Array([1]));
      const outcome = await store.compareAndSwapArchivePreservingConflict(
        new Uint8Array([0]), new Uint8Array([2]),
      );
      const conflictId = outcome.kind === "conflict-preserved" ? outcome.conflictId : "unreachable";
      await store.listConflictArchives();
      await store.deleteConflictArchiveIfEqual(conflictId, new Uint8Array([9]));
      await store.deleteConflictArchiveIfEqual(conflictId, new Uint8Array([2]));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });
  });
});
