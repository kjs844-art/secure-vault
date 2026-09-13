import { IDBDatabase as FakeDatabase, IDBFactory, IDBObjectStore as FakeObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSyntheticCiphertextStore,
  MAX_SYNTHETIC_ARCHIVE_BYTES,
  SYNTHETIC_VAULT_DATABASE_NAME,
  SyntheticStorageError,
} from "./SyntheticCiphertextStore";

let factory: IDBFactory;

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

  it.each([
    ["empty", new Uint8Array()],
    ["oversized", new Uint8Array(MAX_SYNTHETIC_ARCHIVE_BYTES + 1)],
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
    expect(await rawRecords()).toEqual(before);
  });

  it.each([false, true])("preserves unexpected keys (known key also present: %s)", async (withArchive) => {
    await seed(new Uint8Array([8]), "future-key");
    if (withArchive) await seed(new Uint8Array([1]));
    const before = await rawRecords();
    const store = createSyntheticCiphertextStore(factory);
    await expect(store.read()).rejects.toMatchObject({ code: "corrupt" });
    await expect(store.createIfAbsent(new Uint8Array([99]))).rejects.toMatchObject({ code: "corrupt" });
    expect(await rawRecords()).toEqual(before);
  });

  it("refuses a newer database version without resetting or overwriting it", async () => {
    await seed(new Uint8Array([80]), "archive", 2);
    const store = createSyntheticCiphertextStore(factory);
    await expect(store.read()).rejects.toMatchObject({ code: "incompatible" });
    await expect(store.createIfAbsent(new Uint8Array([99]))).rejects.toMatchObject({ code: "incompatible" });
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

  it("fails closed when IndexedDB is unavailable, without an in-memory fallback", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const store = createSyntheticCiphertextStore();
    await expect(store.read()).rejects.toMatchObject({ code: "unavailable" });
    await expect(store.createIfAbsent(new Uint8Array([1]))).rejects.toMatchObject({ code: "unavailable" });
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
});
