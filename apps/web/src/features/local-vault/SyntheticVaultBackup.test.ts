import { Buffer } from "node:buffer";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

import { CatalogAdapterError, type LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import {
  createSyntheticCiphertextStore,
  MAX_SYNTHETIC_ARCHIVE_BYTES,
  SyntheticStorageError,
  type SyntheticCiphertextStore,
} from "../../storage/SyntheticCiphertextStore";
import { SyntheticBackupError, SyntheticVaultBackup } from "./SyntheticVaultBackup";
import type { SyntheticVaultWorker } from "./SyntheticVaultSession";

type ValidationWorker = Pick<SyntheticVaultWorker, "open" | "cancel">;

/** Fake bytes with a plausible header, NOT an authenticated Rust/WASM archive. */
function fakeArchive(length = 32, marker = 7): Uint8Array {
  const bytes = new Uint8Array(length).fill(marker);
  bytes.set(new TextEncoder().encode("KATLDEMO"));
  const header = new DataView(bytes.buffer);
  header.setUint32(8, 1, true);
  header.setUint32(12, 3, true);
  return bytes;
}

function sharedArchive(): Uint8Array {
  const source = fakeArchive();
  const bytes = new Uint8Array(new SharedArrayBuffer(source.byteLength));
  bytes.set(source);
  return bytes;
}

/** Compare every visible byte without Vitest enumerating half a million properties. */
function expectArchiveBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(Object.getPrototypeOf(actual)).toBe(Uint8Array.prototype);
  expect(Object.getPrototypeOf(expected)).toBe(Uint8Array.prototype);
  expect(actual.byteLength).toBe(expected.byteLength);
  const actualBytes = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  const expectedBytes = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
  expect(actualBytes.equals(expectedBytes)).toBe(true);
}

function withHeader(version: number, count = 3, revisions = count, stages = 0): Uint8Array {
  const bytes = fakeArchive();
  const header = new DataView(bytes.buffer);
  header.setUint32(8, version, true);
  header.setUint32(12, count, true);
  if (version === 3 || version === 4) header.setUint32(16, revisions, true);
  if (version === 4) header.setUint32(20, stages, true);
  return bytes;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function stageGate<T>() {
  const entered = deferred<void>();
  const outcome = deferred<T>();
  return {
    entered: entered.promise,
    resolve: outcome.resolve,
    reject: outcome.reject,
    run() {
      entered.resolve();
      return outcome.promise;
    },
  };
}

async function flush() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

function fakeWorker() {
  return {
    // This injected test worker trusts the fixture. Actual WASM tests are separate.
    open: vi.fn<ValidationWorker["open"]>().mockResolvedValue([]),
    cancel: vi.fn<ValidationWorker["cancel"]>(),
  };
}

function backupSnapshot(archive: unknown = fakeArchive(), conflicts: unknown = []) {
  return { archive, conflicts };
}

function fixture(initial: Uint8Array | null = null) {
  let saved = initial;
  const store = {
    read: vi.fn<SyntheticCiphertextStore["read"]>().mockImplementation(async () => saved),
    createIfAbsent: vi.fn<SyntheticCiphertextStore["createIfAbsent"]>().mockImplementation(async (bytes) => {
      if (saved !== null) return "exists";
      saved = new Uint8Array(bytes);
      return "created";
    }),
    readBackupSnapshot: vi.fn<() => Promise<unknown>>()
      .mockImplementation(async () => backupSnapshot(saved)),
    listConflictArchives: vi.fn().mockResolvedValue([]),
  };
  const worker = fakeWorker();
  return { store, worker, backup: new SyntheticVaultBackup(store, worker) };
}

class ArchiveSubclass extends Uint8Array {}

const invalidInputs: [string, unknown][] = [
  ["empty bytes", new Uint8Array()],
  ["truncated header", new Uint8Array(15)],
  ["wrong magic", new Uint8Array(32)],
  ["text", "SYNTHETIC_PRIVATE_TEST_MARKER"],
  ["plain object", { bytes: fakeArchive() }],
  ["array", [75, 65, 84, 76]],
  ["ArrayBuffer", new ArrayBuffer(32)],
  ["DataView", new DataView(new ArrayBuffer(32))],
  ["other typed array", new Uint16Array(32)],
  ["Uint8Array subclass", new ArchiveSubclass(fakeArchive())],
  ["SharedArrayBuffer view", sharedArchive()],
  ["null", null],
  ["undefined", undefined],
];

describe("test-only exact archive byte assertion", () => {
  it.each([0, Math.floor(MAX_SYNTHETIC_ARCHIVE_BYTES / 2), MAX_SYNTHETIC_ARCHIVE_BYTES - 1])(
    "rejects a one-byte difference at offset %i", (offset) => {
      const expected = fakeArchive(MAX_SYNTHETIC_ARCHIVE_BYTES);
      const actual = expected.slice();
      actual[offset] = actual[offset]! ^ 1;
      expect(() => expectArchiveBytesEqual(actual, expected)).toThrow();
    },
  );

  it.each([-1, 1])("rejects a length difference of %i byte", (difference) => {
    expect(() => expectArchiveBytesEqual(fakeArchive(32 + difference), fakeArchive())).toThrow();
  });

  it("compares only the visible bytes of views with different offsets and backing lengths", () => {
    const expectedBacking = new Uint8Array(80).fill(99);
    const actualBacking = new Uint8Array(96).fill(11);
    expectedBacking.set(fakeArchive(), 12);
    actualBacking.set(fakeArchive(), 20);
    expectArchiveBytesEqual(actualBacking.subarray(20, 52), expectedBacking.subarray(12, 44));
  });

  it("rejects another typed-array type even when its visible bytes match", () => {
    const actual = new Uint16Array(16) as unknown as Uint8Array;
    expect(() => expectArchiveBytesEqual(actual, new Uint8Array(32))).toThrow();
  });
});

describe("SyntheticVaultBackup with fake bytes and an injected test worker", () => {
  it("constructs without reading, writing, validating, or cancelling", () => {
    const { store, worker } = fixture();
    expect(store.read).not.toHaveBeenCalled();
    expect(store.readBackupSnapshot).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
    expect(worker.cancel).not.toHaveBeenCalled();
  });

  it("exports one saved snapshot only after validation and returns independent bytes", async () => {
    const saved = fakeArchive();
    const expected = new Uint8Array(saved);
    const { backup, store, worker } = fixture(saved);
    const validation = deferred<readonly LocalCatalogEntryV1[]>();
    worker.open.mockReturnValueOnce(validation.promise);
    const pending = backup.exportArchive();
    const completed = vi.fn();
    void pending.then(completed);
    await flush();
    expect(completed).not.toHaveBeenCalled();
    expect(store.readBackupSnapshot).toHaveBeenCalledOnce();
    expect(store.read).not.toHaveBeenCalled();
    const workerBytes = worker.open.mock.calls[0]![0];
    expect(workerBytes).toEqual(expected);
    expect(workerBytes).not.toBe(saved);
    workerBytes.fill(9);
    validation.resolve([]);
    const exported = await pending;
    expect(exported).toEqual(expected);
    expect(exported).not.toBe(saved);
    expect(exported).not.toBe(workerBytes);
    expect(exported.buffer).not.toBe(workerBytes.buffer);
    exported.fill(4);
    expect(saved).toEqual(expected);
    expect(store.read).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(store.readBackupSnapshot).toHaveBeenCalledTimes(2);
    expect(store.listConflictArchives).not.toHaveBeenCalled();
  });

  it("authenticates an unresolved conflict and refuses export while preserving adapter-owned bytes", async () => {
    const conflictBytes = fakeArchive(32, 41);
    const expected = conflictBytes.slice();
    const { backup, store, worker } = fixture(fakeArchive());
    store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot(fakeArchive(), [{
      conflictId: "00112233445566778899aabbccddeeff",
      bytes: conflictBytes,
    }]));
    await expect(backup.exportArchive()).rejects.toMatchObject({
      code: "UNRESOLVED_CONFLICTS",
      message: new SyntheticBackupError("UNRESOLVED_CONFLICTS").message,
    });
    expect(store.read).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(worker.open).toHaveBeenCalledOnce();
    expect(worker.open.mock.calls[0]![0]).toEqual(expected);
    expect(worker.open.mock.calls[0]![0]).not.toBe(conflictBytes);
    expect(conflictBytes).toEqual(expected);
  });

  it.each([
    ["invalid identifier", [{ conflictId: "PRIVATE_ID", bytes: fakeArchive() }]],
    ["duplicate identifier", [
      { conflictId: "00112233445566778899aabbccddeeff", bytes: fakeArchive() },
      { conflictId: "00112233445566778899aabbccddeeff", bytes: fakeArchive() },
    ]],
    ["shared bytes", [{ conflictId: "00112233445566778899aabbccddeeff", bytes: sharedArchive() }]],
    ["missing bytes", [{ conflictId: "00112233445566778899aabbccddeeff" }]],
  ] as const)("fails closed for a malformed conflict list with %s", async (_label, conflicts) => {
    const { backup, store, worker } = fixture(fakeArchive());
    store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot(fakeArchive(), conflicts));
    await expect(backup.exportArchive()).rejects.toMatchObject({ code: "STORAGE_FAILED" });
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  });

  it("preserves adapter-owned bytes when another conflict field is malformed", async () => {
    const bytes = fakeArchive();
    const expected = bytes.slice();
    const { backup, store } = fixture(fakeArchive());
    store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot(fakeArchive(), [{ conflictId: "bad", bytes }]));
    await expect(backup.exportArchive()).rejects.toMatchObject({ code: "STORAGE_FAILED" });
    expect(bytes).toEqual(expected);
  });

  it("rejects conflict accessors without invoking them or changing an ordinary own bytes field", async () => {
    const bytes = fakeArchive();
    const accessor = vi.fn(() => { throw new Error("PRIVATE_CONFLICT_ACCESSOR"); });
    const entry = Object.defineProperties({}, {
      conflictId: { get: accessor, enumerable: true },
      bytes: { value: bytes, enumerable: true },
    });
    const { backup, store, worker } = fixture(fakeArchive());
    store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot(fakeArchive(), [entry]));
    await expect(backup.exportArchive()).rejects.toMatchObject({ code: "STORAGE_FAILED" });
    expect(accessor).not.toHaveBeenCalled();
    expect(bytes).toEqual(fakeArchive());
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  });

  it.each(["entry-extra-field", "array-extra-field"] as const)(
    "rejects an exact-shape violation (%s), preserves bytes, and exports nothing", async (kind) => {
      const bytes = fakeArchive();
      const entry = {
        conflictId: "00112233445566778899aabbccddeeff",
        bytes,
        ...(kind === "entry-extra-field" ? { note: "PRIVATE_EXTRA" } : {}),
      };
      const list = [entry];
      if (kind === "array-extra-field") Object.defineProperty(list, "extra", { value: true, enumerable: true });
      const { backup, store, worker } = fixture(fakeArchive());
      store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot(fakeArchive(), list));
      await expect(backup.exportArchive()).rejects.toMatchObject({ code: "STORAGE_FAILED" });
      expect(bytes).toEqual(fakeArchive());
      expect(store.read).not.toHaveBeenCalled();
      expect(worker.open).not.toHaveBeenCalled();
    },
  );

  it("normalizes a hostile conflict-list Proxy without reading its values or exporting", async () => {
    const valueRead = vi.fn(() => { throw new Error("PRIVATE_PROXY_GET"); });
    const descriptorRead = vi.fn(() => { throw new Error("PRIVATE_PROXY_DESCRIPTOR"); });
    const raw = new Proxy([{
      conflictId: "00112233445566778899aabbccddeeff",
      bytes: fakeArchive(),
    }], {
      // Promise resolution is specified to inspect `then`; allow only that
      // protocol access so the backup guard receives the hostile value.
      get(_target, key) { return key === "then" ? undefined : valueRead(); },
      getOwnPropertyDescriptor: descriptorRead,
    });
    const { backup, store, worker } = fixture(fakeArchive());
    store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot(fakeArchive(), raw));
    await expect(backup.exportArchive()).rejects.toMatchObject({
      code: "STORAGE_FAILED",
      message: new SyntheticBackupError("STORAGE_FAILED").message,
    });
    expect(valueRead).not.toHaveBeenCalled();
    expect(descriptorRead).toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  });

  it("fails closed when the atomic snapshot capability is missing without falling back to separate reads", async () => {
    const stored = fakeArchive();
    const store = {
      read: vi.fn().mockResolvedValue(stored),
      createIfAbsent: vi.fn<SyntheticCiphertextStore["createIfAbsent"]>().mockResolvedValue("exists"),
      listConflictArchives: vi.fn().mockResolvedValue([]),
    };
    const worker = fakeWorker();
    await expect(new SyntheticVaultBackup(store, worker).exportArchive())
      .rejects.toMatchObject({ code: "STORAGE_FAILED" });
    expect(store.read).not.toHaveBeenCalled();
    expect(store.listConflictArchives).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  });

  it("fails closed when the atomic snapshot rejects without falling back or exporting", async () => {
    const { backup, store, worker } = fixture(fakeArchive());
    store.readBackupSnapshot.mockRejectedValueOnce(new Error("PRIVATE_CONFLICT_STORAGE_FAILURE"));
    await expect(backup.exportArchive()).rejects.toMatchObject({
      code: "STORAGE_FAILED",
      message: new SyntheticBackupError("STORAGE_FAILED").message,
    });
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  });

  it("rechecks immediately before returning and blocks a conflict inserted during main validation", async () => {
    const lateConflict = fakeArchive(32, 53);
    const { backup, store, worker } = fixture(fakeArchive());
    store.readBackupSnapshot
      .mockResolvedValueOnce(backupSnapshot())
      .mockResolvedValueOnce(backupSnapshot(fakeArchive(), [{
        conflictId: "ffeeddccbbaa99887766554433221100",
        bytes: lateConflict,
      }]));
    await expect(backup.exportArchive()).rejects.toMatchObject({ code: "UNRESOLVED_CONFLICTS" });
    expect(store.readBackupSnapshot).toHaveBeenCalledTimes(2);
    expect(store.listConflictArchives).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.open).toHaveBeenCalledTimes(2);
    expect(lateConflict).toEqual(fakeArchive(32, 53));
  });

  it.each([
    ["missing", null],
    ["changed value", fakeArchive(32, 61)],
    ["matching prefix with an extra byte", fakeArchive(33)],
    ["shorter archive", fakeArchive(31)],
  ] as const)("rejects a %s final archive as STALE_BACKUP without writing or changing either result", async (_label, finalArchive) => {
    const initial = fakeArchive();
    const expectedFinal = finalArchive?.slice() ?? null;
    const { backup, store, worker } = fixture(initial);
    store.readBackupSnapshot
      .mockResolvedValueOnce(backupSnapshot(initial))
      .mockResolvedValueOnce(backupSnapshot(finalArchive));
    await expect(backup.exportArchive()).rejects.toMatchObject({
      code: "STALE_BACKUP", message: new SyntheticBackupError("STALE_BACKUP").message,
    });
    expect(store.readBackupSnapshot).toHaveBeenCalledTimes(2);
    expect(store.read).not.toHaveBeenCalled();
    expect(store.listConflictArchives).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(worker.open).toHaveBeenCalledOnce();
    expect(initial).toEqual(fakeArchive());
    expect(finalArchive).toEqual(expectedFinal);
  });

  it("detects adapter-owned archive mutation during validation and preserves the updated bytes", async () => {
    const saved = fakeArchive();
    const { backup, store, worker } = fixture(saved);
    worker.open.mockImplementationOnce(async () => {
      saved[saved.length - 1] = 62;
      return [];
    });
    await expect(backup.exportArchive()).rejects.toMatchObject({ code: "STALE_BACKUP" });
    expect(saved[saved.length - 1]).toBe(62);
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });

  describe.each(["initial", "final"] as const)("%s atomic snapshot boundary", (stage) => {
    const badSnapshots: readonly [string, unknown][] = [
      ["null wrapper", null],
      ["array wrapper", []],
      ["missing archive", { conflicts: [] }],
      ["missing conflicts", { archive: fakeArchive() }],
      ["extra field", { ...backupSnapshot(), extra: "PRIVATE_EXTRA" }],
      ["symbol field", { ...backupSnapshot(), [Symbol("private")]: true }],
      ["inherited fields", Object.create(backupSnapshot())],
      ["non-array conflicts", backupSnapshot(fakeArchive(), {})],
      ["sparse conflicts", backupSnapshot(fakeArchive(), new Array(1))],
      ["too many conflicts", backupSnapshot(fakeArchive(), Array.from({ length: 9 }, (_, index) => ({
        conflictId: index.toString(16).padStart(32, "0"), bytes: fakeArchive(),
      })))],
      ["conflicts without an archive", backupSnapshot(null, [{
        conflictId: "00112233445566778899aabbccddeeff", bytes: fakeArchive(),
      }])],
    ];

    it.each(badSnapshots)("rejects %s with a fixed storage error", async (_label, raw) => {
      const { backup, store, worker } = fixture(fakeArchive());
      if (stage === "final") store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot());
      store.readBackupSnapshot.mockResolvedValueOnce(raw);
      await expect(backup.exportArchive()).rejects.toMatchObject({
        code: "STORAGE_FAILED", message: new SyntheticBackupError("STORAGE_FAILED").message,
      });
      expect(worker.open).toHaveBeenCalledTimes(stage === "final" ? 1 : 0);
      expect(store.read).not.toHaveBeenCalled();
      expect(store.listConflictArchives).not.toHaveBeenCalled();
      expect(store.createIfAbsent).not.toHaveBeenCalled();
    });

    it.each(["archive", "conflicts"] as const)("rejects a %s accessor without executing it", async (field) => {
      const raw = backupSnapshot();
      const getter = vi.fn(() => { throw new Error("PRIVATE_SNAPSHOT_GETTER"); });
      Object.defineProperty(raw, field, { get: getter, enumerable: true });
      const { backup, store, worker } = fixture(fakeArchive());
      if (stage === "final") store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot());
      store.readBackupSnapshot.mockResolvedValueOnce(raw);
      await expect(backup.exportArchive()).rejects.toMatchObject({ code: "STORAGE_FAILED" });
      expect(getter).not.toHaveBeenCalled();
      expect(worker.open).toHaveBeenCalledTimes(stage === "final" ? 1 : 0);
    });

    it("normalizes descriptor failures without reading arbitrary wrapper values", async () => {
      const valueRead = vi.fn(() => { throw new Error("PRIVATE_WRAPPER_GET"); });
      const raw = new Proxy(backupSnapshot(), {
        get(_target, key) { return key === "then" ? undefined : valueRead(); },
        getOwnPropertyDescriptor() { throw new Error("PRIVATE_WRAPPER_DESCRIPTOR"); },
      });
      const { backup, store } = fixture(fakeArchive());
      if (stage === "final") store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot());
      store.readBackupSnapshot.mockResolvedValueOnce(raw);
      await expect(backup.exportArchive()).rejects.toMatchObject({
        code: "STORAGE_FAILED", message: new SyntheticBackupError("STORAGE_FAILED").message,
      });
      expect(valueRead).not.toHaveBeenCalled();
    });

    it("rejects a shared conflict backing buffer without mutating it", async () => {
      const bytes = sharedArchive();
      const expected = new Uint8Array(bytes);
      const { backup, store } = fixture(fakeArchive());
      if (stage === "final") store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot());
      store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot(fakeArchive(), [{
        conflictId: "00112233445566778899aabbccddeeff", bytes,
      }]));
      await expect(backup.exportArchive()).rejects.toMatchObject({ code: "STORAGE_FAILED" });
      expect(bytes).toEqual(expected);
    });

    it("preserves raw conflict and archive buffers when conflict authentication fails", async () => {
      const archive = fakeArchive();
      const bytes = fakeArchive(32, 68);
      const { backup, store, worker } = fixture(archive);
      if (stage === "final") {
        store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot(archive));
        worker.open.mockResolvedValueOnce([]);
      }
      store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot(archive, [{
        conflictId: "00112233445566778899aabbccddeeff", bytes,
      }]));
      worker.open.mockRejectedValueOnce(new Error("PRIVATE_INVALID_CONFLICT"));
      await expect(backup.exportArchive()).rejects.toMatchObject({ code: "STORAGE_FAILED" });
      expect(archive).toEqual(fakeArchive());
      expect(bytes).toEqual(fakeArchive(32, 68));
      expect(store.createIfAbsent).not.toHaveBeenCalled();
    });
  });

  it("honors cancellation queued during final snapshot inspection before returning an archive", async () => {
    const rawArchive = fakeArchive();
    const { backup, store, worker } = fixture(rawArchive);
    let queued = false;
    const raw = new Proxy(backupSnapshot(rawArchive), {
      getOwnPropertyDescriptor(target, key) {
        if (!queued) {
          queued = true;
          queueMicrotask(() => backup.cancel());
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot(rawArchive)).mockResolvedValueOnce(raw);
    await expect(backup.exportArchive()).rejects.toMatchObject({ code: "CANCELLED" });
    expect(queued).toBe(true);
    expect(worker.open).toHaveBeenCalledOnce();
    expect(rawArchive).toEqual(fakeArchive());
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });

  it("returns EMPTY for absent storage without validating or creating", async () => {
    const { backup, store, worker } = fixture();
    await expect(backup.exportArchive()).rejects.toMatchObject({ code: "EMPTY" });
    expect(store.readBackupSnapshot).toHaveBeenCalledOnce();
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });

  it("snapshots restore input synchronously and validates a different copy before creating", async () => {
    const { backup, store, worker } = fixture();
    const original = fakeArchive();
    const expected = new Uint8Array(original);
    const initialRead = deferred<Uint8Array | null>();
    const validation = deferred<readonly LocalCatalogEntryV1[]>();
    store.read.mockReturnValueOnce(initialRead.promise);
    worker.open.mockReturnValueOnce(validation.promise);
    const pending = backup.restoreArchive(original);
    original.fill(0);
    expect(store.read).toHaveBeenCalledOnce();
    expect(worker.open).not.toHaveBeenCalled();
    initialRead.resolve(null);
    await flush();
    const workerBytes = worker.open.mock.calls[0]![0];
    expect(workerBytes).toEqual(expected);
    expect(workerBytes.buffer).not.toBe(original.buffer);
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    workerBytes.fill(8);
    validation.resolve([]);
    await expect(pending).resolves.toBeUndefined();
    const createBytes = store.createIfAbsent.mock.calls[0]![0];
    expect(createBytes).toEqual(expected);
    expect(createBytes).not.toBe(workerBytes);
    expect(createBytes).not.toBe(original);
    expect(await store.read()).toEqual(expected);
  });

  it("orders restore as empty read, full validation, commit, exact readback, success", async () => {
    const events: string[] = [];
    const bytes = fakeArchive();
    let saved: Uint8Array | null = null;
    const store: SyntheticCiphertextStore = {
      async read() { events.push(saved === null ? "empty-read" : "readback"); return saved; },
      async createIfAbsent(candidate) { events.push("commit"); saved = new Uint8Array(candidate); return "created"; },
    };
    const worker = fakeWorker();
    worker.open.mockImplementation(async () => { events.push("validate"); return []; });
    await new SyntheticVaultBackup(store, worker).restoreArchive(bytes);
    events.push("success");
    expect(events).toEqual(["empty-read", "validate", "commit", "readback", "success"]);
  });

  it("discards worker metadata without reading or publishing it", async () => {
    const { backup, worker } = fixture();
    const rows = new Proxy([] as LocalCatalogEntryV1[], {
      get() { throw new Error("SYNTHETIC_PRIVATE_METADATA_MUST_NOT_BE_READ"); },
    });
    // Avoid returning a Proxy directly from a Promise: Promise assimilation reads then.
    worker.open.mockResolvedValue([rows as unknown as LocalCatalogEntryV1]);
    await expect(backup.restoreArchive(fakeArchive())).resolves.toBeUndefined();
    await expect(backup.exportArchive()).resolves.toEqual(fakeArchive());
  });

  it("accepts a bounded subarray and exports only its visible bytes", async () => {
    const backing = new Uint8Array(80).fill(99);
    backing.set(fakeArchive(), 12);
    const view = backing.subarray(12, 44);
    const { backup, store } = fixture();
    await backup.restoreArchive(view);
    const exported = await backup.exportArchive();
    expect(exported).toEqual(fakeArchive());
    expect(exported.byteOffset).toBe(0);
    expect(exported.buffer.byteLength).toBe(32);
    expect(store.createIfAbsent.mock.calls[0]![0].buffer).not.toBe(backing.buffer);
  });

  it.each([16, MAX_SYNTHETIC_ARCHIVE_BYTES])(
    "delegates the %i-byte boundary to the test worker (not real framing validation)", async (length) => {
      const { backup, worker } = fixture();
      await backup.restoreArchive(fakeArchive(length));
      const exported = await backup.exportArchive();
      expectArchiveBytesEqual(exported, fakeArchive(length));
      expect(worker.open).toHaveBeenCalledTimes(2);
    },
  );

  it.each(invalidInputs)("rejects %s restore input before any storage or worker call", async (_label, input) => {
    const { backup, store, worker } = fixture();
    await expect(backup.restoreArchive(input as Uint8Array)).rejects.toMatchObject({ code: "INVALID_BACKUP" });
    expect(store.read).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  });

  it("rejects a SharedArrayBuffer-backed stored archive before worker validation", async () => {
    const { backup, store, worker } = fixture(sharedArchive());
    await expect(backup.exportArchive()).rejects.toMatchObject({ code: "INVALID_BACKUP" });
    expect(store.readBackupSnapshot).toHaveBeenCalledOnce();
    expect(store.read).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  });

  it.each([[1, 3], [2, 3], [2, 4], [2, 128], [3, 3], [3, 128], [4, 3], [4, 128]])(
    "delegates supported archive v%i count %i to full validation and preserves its exact bytes", async (version, count) => {
      const bytes = withHeader(version, count);
      const expected = bytes.slice();
      const { backup, store, worker } = fixture();
      await backup.restoreArchive(bytes);
      const exported = await backup.exportArchive();
      expect(exported).toEqual(expected);
      expect(exported.buffer).not.toBe(bytes.buffer);
      expect(bytes).toEqual(expected);
      expect(await store.read()).toEqual(expected);
      expect(worker.open).toHaveBeenCalledTimes(2);
      for (const [validated] of worker.open.mock.calls) {
        expect(validated).toEqual(expected);
        expect(validated.buffer).not.toBe(bytes.buffer);
      }
    },
  );

  it.each([0, 5, 0xffff_ffff])("refuses unsupported archive version %i without storage or validation", async (version) => {
    const { backup, store, worker } = fixture();
    await expect(backup.restoreArchive(withHeader(version))).rejects.toMatchObject({ code: "UNSUPPORTED_VERSION" });
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });

  it.each([0, 2, 4, 0xffff_ffff])("refuses invalid synthetic record count %i", async (count) => {
    const { backup, store, worker } = fixture();
    await expect(backup.restoreArchive(withHeader(1, count))).rejects.toMatchObject({ code: "INVALID_BACKUP" });
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 129, 0xffff_ffff])("refuses invalid v2 record count %i before storage or validation", async (count) => {
    const { backup, store, worker } = fixture();
    const bytes = withHeader(2, count);
    const expected = bytes.slice();
    await expect(backup.restoreArchive(bytes)).rejects.toMatchObject({ code: "INVALID_BACKUP" });
    expect(bytes).toEqual(expected);
    expect(store.read).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  });

  it.each([
    [3, 3], [3, 4], [128, 128], [128, 512],
  ])("accepts bounded v3 header with %i heads and %i revisions only through full authentication", async (heads, revisions) => {
    const bytes = withHeader(3, heads, revisions);
    const { backup, store, worker } = fixture();
    await backup.restoreArchive(bytes);
    expect(worker.open).toHaveBeenCalledWith(bytes);
    expect(await store.read()).toEqual(bytes);
  });

  it.each([
    withHeader(3).slice(0, 16), withHeader(3).slice(0, 19),
    withHeader(3, 2, 3), withHeader(3, 129, 129),
    withHeader(3, 3, 2), withHeader(3, 3, 513), withHeader(3, 3, 0xffff_ffff),
  ])("rejects invalid v3 header bounds before storage or worker", async (bytes) => {
    const { backup, store, worker } = fixture();
    await expect(backup.restoreArchive(bytes)).rejects.toHaveProperty("code", "INVALID_BACKUP");
    expect(store.read).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  });

  it("a plausible 20-byte v3 header still requires authenticated framing and records", async () => {
    const { backup, store, worker } = fixture();
    worker.open.mockRejectedValueOnce(new CatalogAdapterError("INVALID_ARCHIVE"));
    await expect(backup.restoreArchive(withHeader(3).slice(0, 20))).rejects.toHaveProperty("code", "VALIDATION_FAILED");
    expect(worker.open).toHaveBeenCalledOnce();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });

  it.each([
    withHeader(4).slice(0, 20), withHeader(4).slice(0, 23),
    withHeader(4, 3, 2, 1), withHeader(4, 3, 512, 1),
    withHeader(4, 3, 3, 510), withHeader(4, 3, 3, 0xffff_ffff),
  ])("rejects v4 combined stage/revision bounds before storage or authentication", async (bytes) => {
    const { backup, store, worker } = fixture();
    await expect(backup.restoreArchive(bytes)).rejects.toHaveProperty("code", "INVALID_BACKUP");
    expect(store.read).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  });

  it("a bounded v4 header still requires every canonical and staged envelope to authenticate", async () => {
    const { backup, store, worker } = fixture();
    worker.open.mockRejectedValueOnce(new CatalogAdapterError("AUTHENTICATION_FAILED"));
    await expect(backup.restoreArchive(withHeader(4, 3, 3, 509)))
      .rejects.toHaveProperty("code", "VALIDATION_FAILED");
    expect(worker.open).toHaveBeenCalledOnce();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });

  it.each(["export", "restore"] as const)("requires full validation for v2 %s and preserves bytes on validation failure", async (operation) => {
    const bytes = withHeader(2, 4);
    const expected = bytes.slice();
    const { backup, store, worker } = fixture(operation === "export" ? bytes : null);
    worker.open.mockRejectedValueOnce(new CatalogAdapterError("INVALID_ARCHIVE"));
    await expect(operation === "export" ? backup.exportArchive() : backup.restoreArchive(bytes))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(worker.open).toHaveBeenCalledOnce();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(bytes).toEqual(expected);
    expect(await store.read()).toEqual(operation === "export" ? expected : null);
  });

  it("rejects oversized input before copying into storage or invoking the worker", async () => {
    const { backup, store, worker } = fixture();
    await expect(backup.restoreArchive(fakeArchive(MAX_SYNTHETIC_ARCHIVE_BYTES + 1)))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(store.read).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  });

  it.each([
    ["bad header", new Uint8Array(32), "INVALID_BACKUP"],
    ["future version", withHeader(5), "UNSUPPORTED_VERSION"],
    ["v2 low count", withHeader(2, 2), "INVALID_BACKUP"],
    ["v2 excessive count", withHeader(2, 129), "INVALID_BACKUP"],
    ["oversized", fakeArchive(MAX_SYNTHETIC_ARCHIVE_BYTES + 1), "LIMIT_EXCEEDED"],
    ["subclass", new ArchiveSubclass(fakeArchive()), "INVALID_BACKUP"],
  ] as const)("refuses to export %s saved bytes without rewriting them", async (_label, bytes, code) => {
    const expected = new Uint8Array(bytes);
    const { backup, store, worker } = fixture(bytes);
    await expect(backup.exportArchive()).rejects.toMatchObject({ code });
    expectArchiveBytesEqual(new Uint8Array(bytes), expected);
    expect(store.readBackupSnapshot).toHaveBeenCalledOnce();
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });

  it.each([fakeArchive(), new Uint8Array(), withHeader(2, 4), withHeader(2, 129), withHeader(9)])(
    "preserves any preexisting bytes and refuses restore before worker validation", async (existing) => {
      const expected = new Uint8Array(existing);
      const { backup, store, worker } = fixture(existing);
      await expect(backup.restoreArchive(fakeArchive())).rejects.toMatchObject({ code: "EXISTS" });
      expect(existing).toEqual(expected);
      expect(store.read).toHaveBeenCalledOnce();
      expect(worker.open).not.toHaveBeenCalled();
      expect(store.createIfAbsent).not.toHaveBeenCalled();
    },
  );

  it("reports EXISTS when another writer wins after validation without retrying or reading its rows", async () => {
    const { backup, store, worker } = fixture();
    store.createIfAbsent.mockResolvedValueOnce("exists");
    await expect(backup.restoreArchive(fakeArchive())).rejects.toMatchObject({ code: "EXISTS" });
    expect(store.read).toHaveBeenCalledOnce();
    expect(store.createIfAbsent).toHaveBeenCalledOnce();
    expect(worker.open).toHaveBeenCalledOnce();
  });

  it.each([null, new Uint8Array(16), fakeArchive(32, 99)])(
    "reports failed readback without attempting a repair", async (saved) => {
      const { backup, store, worker } = fixture();
      store.read.mockResolvedValueOnce(null).mockResolvedValueOnce(saved);
      await expect(backup.restoreArchive(fakeArchive())).rejects.toMatchObject({ code: "READBACK_FAILED" });
      expect(store.read).toHaveBeenCalledTimes(2);
      expect(store.createIfAbsent).toHaveBeenCalledOnce();
      expect(worker.open).toHaveBeenCalledOnce();
    },
  );

  it("rejects a SharedArrayBuffer readback without reporting restore success", async () => {
    const { backup, store, worker } = fixture();
    store.read.mockResolvedValueOnce(null).mockResolvedValueOnce(sharedArchive());
    await expect(backup.restoreArchive(fakeArchive())).rejects.toMatchObject({ code: "READBACK_FAILED" });
    expect(store.read).toHaveBeenCalledTimes(2);
    expect(store.createIfAbsent).toHaveBeenCalledOnce();
    expect(worker.open).toHaveBeenCalledOnce();
  });

  it("uses the native readback length and rejects a longer matching prefix", async () => {
    const readback = fakeArchive(33);
    Object.defineProperty(readback, "byteLength", { value: 32, enumerable: true });
    const { backup, store, worker } = fixture();
    store.read.mockResolvedValueOnce(null).mockResolvedValueOnce(readback);
    await expect(backup.restoreArchive(fakeArchive())).rejects.toMatchObject({ code: "READBACK_FAILED" });
    expect(store.read).toHaveBeenCalledTimes(2);
    expect(store.createIfAbsent).toHaveBeenCalledOnce();
    expect(worker.open).toHaveBeenCalledOnce();
  });

  it.each(["export-read", "restore-read", "create", "readback"])(
    "normalizes a %s storage failure and never retries", async (stage) => {
      const { backup, store, worker } = fixture(stage === "export-read" ? fakeArchive() : null);
      const failure = new SyntheticStorageError("quota");
      Object.assign(failure, { message: "SYNTHETIC_PRIVATE_STORAGE_MESSAGE", code: "SYNTHETIC_PRIVATE_STORAGE_CODE" });
      if (stage === "create") store.createIfAbsent.mockRejectedValueOnce(failure);
      else if (stage === "readback") store.read.mockResolvedValueOnce(null).mockRejectedValueOnce(failure);
      else if (stage === "export-read") store.readBackupSnapshot.mockRejectedValueOnce(failure);
      else store.read.mockRejectedValueOnce(failure);
      const operation = stage === "export-read" ? backup.exportArchive() : backup.restoreArchive(fakeArchive());
      await expect(operation).rejects.toMatchObject({
        name: "SyntheticBackupError", code: "STORAGE_FAILED", message: new SyntheticBackupError("STORAGE_FAILED").message,
      });
      expect(store.read).toHaveBeenCalledTimes(stage === "export-read" ? 0 : stage === "readback" ? 2 : 1);
      expect(store.readBackupSnapshot).toHaveBeenCalledTimes(stage === "export-read" ? 1 : 0);
      expect(store.createIfAbsent).toHaveBeenCalledTimes(stage === "create" || stage === "readback" ? 1 : 0);
      expect(worker.open).toHaveBeenCalledTimes(stage === "create" || stage === "readback" ? 1 : 0);
    },
  );

  it.each(["export", "restore"] as const)("normalizes failed %s validation without exposing worker error text", async (operation) => {
    const bytes = fakeArchive();
    const { backup, store, worker } = fixture(operation === "export" ? bytes : null);
    worker.open.mockRejectedValueOnce(Object.assign(new CatalogAdapterError("AUTHENTICATION_FAILED"), {
      message: "SYNTHETIC_PRIVATE_WORKER_MESSAGE", code: "SYNTHETIC_PRIVATE_WORKER_CODE",
    }));
    await expect(operation === "export" ? backup.exportArchive() : backup.restoreArchive(bytes))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED", message: new SyntheticBackupError("VALIDATION_FAILED").message });
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(bytes).toEqual(fakeArchive());
  });

  it("does not inspect hostile rejection properties from a worker", async () => {
    const { backup, store, worker } = fixture();
    const accessor = vi.fn(() => { throw new Error("SYNTHETIC_PRIVATE_GETTER"); });
    worker.open.mockRejectedValueOnce(Object.defineProperty({}, "code", { get: accessor }));
    await expect(backup.restoreArchive(fakeArchive())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(accessor).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });

  it.each(["initial-read", "validation", "commit", "readback"])(
    "cancel during restore %s blocks every later continuation", async (stage) => {
      const { backup, store, worker } = fixture();
      const blocked = stageGate<unknown>();
      let result: unknown;
      if (stage === "initial-read") {
        store.read.mockImplementationOnce(() => blocked.run() as Promise<Uint8Array | null>);
        result = null;
      } else if (stage === "validation") {
        worker.open.mockImplementationOnce(() => blocked.run() as Promise<readonly LocalCatalogEntryV1[]>);
        result = [];
      } else if (stage === "commit") {
        store.createIfAbsent.mockImplementationOnce(() => blocked.run() as Promise<"created">);
        result = "created";
      } else {
        store.read.mockResolvedValueOnce(null).mockImplementationOnce(() => blocked.run() as Promise<Uint8Array | null>);
        result = fakeArchive();
      }
      const operation = backup.restoreArchive(fakeArchive());
      const rejection = expect(operation).rejects.toMatchObject({ code: "CANCELLED" });
      await blocked.entered;
      const before = {
        reads: stage === "readback" ? 2 : 1,
        creates: stage === "commit" || stage === "readback" ? 1 : 0,
        opens: stage === "initial-read" ? 0 : 1,
      };
      expect(store.read).toHaveBeenCalledTimes(before.reads);
      expect(store.createIfAbsent).toHaveBeenCalledTimes(before.creates);
      expect(worker.open).toHaveBeenCalledTimes(before.opens);
      backup.cancel();
      expect(worker.cancel).toHaveBeenCalledOnce();
      blocked.resolve(result);
      await rejection;
      expect(store.read).toHaveBeenCalledTimes(before.reads);
      expect(store.createIfAbsent).toHaveBeenCalledTimes(before.creates);
      expect(worker.open).toHaveBeenCalledTimes(before.opens);
      if (stage === "initial-read" || stage === "validation") expect(store.createIfAbsent).not.toHaveBeenCalled();
    },
  );

  it.each(["initial-read", "validation", "final-read"])("cancel during export %s never yields an archive", async (stage) => {
    const raw = fakeArchive();
    const { backup, store, worker } = fixture(raw);
    const blocked = stageGate<unknown>();
    if (stage === "initial-read") store.readBackupSnapshot.mockImplementationOnce(blocked.run);
    else if (stage === "final-read") store.readBackupSnapshot
      .mockResolvedValueOnce(backupSnapshot(raw)).mockImplementationOnce(blocked.run);
    else worker.open.mockImplementationOnce(() => blocked.run() as Promise<readonly LocalCatalogEntryV1[]>);
    const pending = backup.exportArchive();
    const rejection = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await blocked.entered;
    expect(store.readBackupSnapshot).toHaveBeenCalledTimes(stage === "final-read" ? 2 : 1);
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.open).toHaveBeenCalledTimes(stage === "initial-read" ? 0 : 1);
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    backup.cancel();
    blocked.resolve(stage === "validation" ? [] : backupSnapshot(raw));
    await rejection;
    expect(worker.open).toHaveBeenCalledTimes(stage === "initial-read" ? 0 : 1);
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(raw).toEqual(fakeArchive());
  });

  it("normalizes a rejected final snapshot after cancellation without leaking adapter text", async () => {
    const raw = fakeArchive();
    const { backup, store } = fixture(raw);
    const blocked = stageGate<unknown>();
    store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot(raw)).mockImplementationOnce(blocked.run);
    const pending = backup.exportArchive();
    const rejection = expect(pending).rejects.toMatchObject({
      code: "CANCELLED", message: new SyntheticBackupError("CANCELLED").message,
    });
    await blocked.entered;
    backup.cancel();
    blocked.reject(new Error("PRIVATE_FINAL_SNAPSHOT_FAILURE"));
    await rejection;
    expect(raw).toEqual(fakeArchive());
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });

  it.each(["initial", "final"] as const)("cancels during %s conflict authentication without clearing raw conflict bytes", async (stage) => {
    const archive = fakeArchive();
    const conflict = fakeArchive(32, 75);
    const { backup, store, worker } = fixture(archive);
    if (stage === "final") {
      store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot(archive));
      worker.open.mockResolvedValueOnce([]);
    }
    store.readBackupSnapshot.mockResolvedValueOnce(backupSnapshot(archive, [{
      conflictId: "00112233445566778899aabbccddeeff", bytes: conflict,
    }]));
    const blocked = stageGate<readonly LocalCatalogEntryV1[]>();
    worker.open.mockImplementationOnce(blocked.run);
    const pending = backup.exportArchive();
    const rejection = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await blocked.entered;
    backup.cancel();
    blocked.resolve([]);
    await rejection;
    expect(archive).toEqual(fakeArchive());
    expect(conflict).toEqual(fakeArchive(32, 75));
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(store.readBackupSnapshot).toHaveBeenCalledTimes(stage === "initial" ? 1 : 2);
  });

  it("allows an already-started commit to finish but does not report late success or readback", async () => {
    const { backup, store } = fixture();
    const commit = stageGate<void>();
    let persisted: Uint8Array | null = null;
    store.createIfAbsent.mockImplementationOnce(async (bytes) => {
      await commit.run();
      persisted = new Uint8Array(bytes);
      return "created";
    });
    const pending = backup.restoreArchive(fakeArchive());
    const rejection = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await commit.entered;
    expect(store.createIfAbsent).toHaveBeenCalledOnce();
    backup.cancel();
    commit.resolve();
    await rejection;
    expect(persisted).toEqual(fakeArchive());
    expect(store.read).toHaveBeenCalledOnce();
  });

  it.each(["initial-read", "validation", "commit", "readback"])(
    "normalizes a late %s rejection after cancellation to CANCELLED", async (stage) => {
      const { backup, store, worker } = fixture();
      const blocked = stageGate<unknown>();
      if (stage === "initial-read") store.read.mockImplementationOnce(() => blocked.run() as Promise<Uint8Array | null>);
      else if (stage === "validation") worker.open.mockImplementationOnce(() => blocked.run() as Promise<readonly LocalCatalogEntryV1[]>);
      else if (stage === "commit") store.createIfAbsent.mockImplementationOnce(() => blocked.run() as Promise<"created">);
      else store.read.mockResolvedValueOnce(null).mockImplementationOnce(() => blocked.run() as Promise<Uint8Array | null>);
      const pending = backup.restoreArchive(fakeArchive());
      const rejection = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
      await blocked.entered;
      const before = {
        reads: stage === "readback" ? 2 : 1,
        creates: stage === "commit" || stage === "readback" ? 1 : 0,
        opens: stage === "initial-read" ? 0 : 1,
      };
      expect(store.read).toHaveBeenCalledTimes(before.reads);
      expect(store.createIfAbsent).toHaveBeenCalledTimes(before.creates);
      expect(worker.open).toHaveBeenCalledTimes(before.opens);
      backup.cancel();
      blocked.reject(new Error("SYNTHETIC_PRIVATE_LATE_FAILURE"));
      await rejection;
      expect(store.read).toHaveBeenCalledTimes(before.reads);
      expect(store.createIfAbsent).toHaveBeenCalledTimes(before.creates);
      expect(worker.open).toHaveBeenCalledTimes(before.opens);
    },
  );

  it.each(["export", "restore"] as const)("rejects a concurrent %s as BUSY without invalidating the first operation", async (second) => {
    const { backup, store, worker } = fixture(fakeArchive());
    const read = deferred<ReturnType<typeof backupSnapshot>>();
    store.readBackupSnapshot.mockReturnValueOnce(read.promise);
    const first = backup.exportArchive();
    await expect(second === "export" ? backup.exportArchive() : backup.restoreArchive(fakeArchive()))
      .rejects.toMatchObject({ code: "BUSY" });
    expect(store.readBackupSnapshot).toHaveBeenCalledOnce();
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.cancel).not.toHaveBeenCalled();
    read.resolve(backupSnapshot());
    await expect(first).resolves.toEqual(fakeArchive());
    await expect(backup.exportArchive()).resolves.toEqual(fakeArchive());
  });

  it.each(["resolve", "reject"] as const)("a stale %s cannot clear BUSY on a newer operation", async (outcome) => {
    const { backup, store } = fixture(fakeArchive());
    const oldList = deferred<ReturnType<typeof backupSnapshot>>();
    const newList = deferred<ReturnType<typeof backupSnapshot>>();
    store.readBackupSnapshot
      .mockReturnValueOnce(oldList.promise)
      .mockReturnValueOnce(newList.promise);
    const oldOperation = backup.exportArchive();
    const oldRejection = expect(oldOperation).rejects.toMatchObject({ code: "CANCELLED" });
    backup.cancel();
    const newOperation = backup.exportArchive();
    if (outcome === "resolve") oldList.resolve(backupSnapshot());
    else oldList.reject(new Error("SYNTHETIC_PRIVATE_OLD_FAILURE"));
    await oldRejection;
    await expect(backup.exportArchive()).rejects.toMatchObject({ code: "BUSY" });
    expect(store.read).not.toHaveBeenCalled();
    newList.resolve(backupSnapshot());
    await expect(newOperation).resolves.toEqual(fakeArchive());
    expect(store.read).not.toHaveBeenCalled();
    expect(store.readBackupSnapshot).toHaveBeenCalledTimes(3);
  });

  it("allows a new operation after validation failure", async () => {
    const { backup, worker } = fixture(fakeArchive());
    worker.open.mockRejectedValueOnce(new Error("SYNTHETIC_FAILURE"));
    await expect(backup.exportArchive()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(backup.exportArchive()).resolves.toEqual(fakeArchive());
  });

  it("cancel remains safe when worker cleanup throws and a new operation can begin", async () => {
    const { backup, store, worker } = fixture(fakeArchive());
    const read = deferred<ReturnType<typeof backupSnapshot>>();
    store.readBackupSnapshot.mockReturnValueOnce(read.promise);
    worker.cancel.mockImplementation(() => { throw new Error("SYNTHETIC_PRIVATE_CLEANUP_FAILURE"); });
    const pending = backup.exportArchive();
    const rejection = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(() => backup.cancel()).not.toThrow();
    read.resolve(backupSnapshot());
    await rejection;
    await expect(backup.exportArchive()).resolves.toEqual(fakeArchive());
  });

  it("snapshots ordinary bytes without inspecting buffer, byteLength, length or iterator shadows", async () => {
    const { backup, worker } = fixture();
    const shadow = vi.fn(() => { throw new Error("SYNTHETIC_PRIVATE_SHADOW"); });
    const input = Object.defineProperties(fakeArchive(), {
      buffer: { get: shadow }, byteLength: { get: shadow },
      length: { get: shadow }, [Symbol.iterator]: { get: shadow },
    });
    await expect(backup.restoreArchive(input)).resolves.toBeUndefined();
    expect(worker.open).toHaveBeenCalledOnce();
    expect(shadow).not.toHaveBeenCalled();
  });
});

describe("SyntheticVaultBackup with fake IndexedDB and fake validation (not real WASM proof)", () => {
  it("rejects a canonical update committed by another store during validation and preserves the winner", async () => {
    const factory = new IDBFactory();
    const source = createSyntheticCiphertextStore(factory);
    const competitor = createSyntheticCiphertextStore(factory);
    const original = fakeArchive();
    const winner = fakeArchive(32, 82);
    await source.createIfAbsent(original);
    const worker = fakeWorker();
    worker.open.mockImplementationOnce(async () => {
      expect(await competitor.compareAndSwapArchive(original, winner)).toBe("updated");
      return [];
    });
    await expect(new SyntheticVaultBackup(source, worker).exportArchive())
      .rejects.toMatchObject({ code: "STALE_BACKUP" });
    expect(await source.read()).toEqual(winner);
    expect(await source.listConflictArchives()).toEqual([]);
    expect(worker.open).toHaveBeenCalledOnce();
  });

  it("rejects a conflict committed by another store during validation without deleting either archive", async () => {
    const factory = new IDBFactory();
    const source = createSyntheticCiphertextStore(factory);
    const competitor = createSyntheticCiphertextStore(factory);
    const original = fakeArchive();
    const candidate = fakeArchive(32, 83);
    await source.createIfAbsent(original);
    const worker = fakeWorker();
    worker.open.mockImplementationOnce(async () => {
      expect(await competitor.compareAndSwapArchivePreservingConflict(fakeArchive(32, 84), candidate))
        .toMatchObject({ kind: "conflict-preserved" });
      return [];
    });
    await expect(new SyntheticVaultBackup(source, worker).exportArchive())
      .rejects.toMatchObject({ code: "UNRESOLVED_CONFLICTS" });
    expect(await source.read()).toEqual(original);
    const conflicts = await source.listConflictArchives();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.bytes).toEqual(candidate);
    expect(worker.open).toHaveBeenCalledTimes(2);
  });

  it.each([[1, 3], [2, 4], [3, 4], [4, 4]])("round-trips v%i count %i exact bytes across separate database factories and new store instances", async (version, count) => {
    const sourceFactory = new IDBFactory();
    const destinationFactory = new IDBFactory();
    const source = createSyntheticCiphertextStore(sourceFactory);
    const destination = createSyntheticCiphertextStore(destinationFactory);
    const bytes = withHeader(version, count);
    await source.createIfAbsent(bytes);
    const exported = await new SyntheticVaultBackup(source, fakeWorker()).exportArchive();
    await new SyntheticVaultBackup(destination, fakeWorker()).restoreArchive(exported);
    exported.fill(0);
    expect(await createSyntheticCiphertextStore(sourceFactory).read()).toEqual(bytes);
    expect(await createSyntheticCiphertextStore(destinationFactory).read()).toEqual(bytes);
    expect(await new SyntheticVaultBackup(createSyntheticCiphertextStore(destinationFactory), fakeWorker()).exportArchive())
      .toEqual(bytes);
  });

  it("preserves a preexisting IndexedDB archive without invoking the test worker", async () => {
    const factory = new IDBFactory();
    const store = createSyntheticCiphertextStore(factory);
    const original = fakeArchive(32, 44);
    await store.createIfAbsent(original);
    const worker = fakeWorker();
    await expect(new SyntheticVaultBackup(store, worker).restoreArchive(fakeArchive(32, 77)))
      .rejects.toMatchObject({ code: "EXISTS" });
    expect(await createSyntheticCiphertextStore(factory).read()).toEqual(original);
    expect(worker.open).not.toHaveBeenCalled();
  });

  it("preserves a competing IndexedDB winner inserted during validation", async () => {
    const factory = new IDBFactory();
    const restoringStore = createSyntheticCiphertextStore(factory);
    const competitor = createSyntheticCiphertextStore(factory);
    const winner = fakeArchive(32, 99);
    const worker = fakeWorker();
    worker.open.mockImplementationOnce(async () => {
      expect(await competitor.createIfAbsent(winner)).toBe("created");
      return [];
    });
    await expect(new SyntheticVaultBackup(restoringStore, worker).restoreArchive(fakeArchive()))
      .rejects.toMatchObject({ code: "EXISTS" });
    expect(await createSyntheticCiphertextStore(factory).read()).toEqual(winner);
    expect(worker.open).toHaveBeenCalledOnce();
  });
});
