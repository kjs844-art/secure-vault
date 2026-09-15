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

function withHeader(version: number, count = 3): Uint8Array {
  const bytes = fakeArchive();
  const header = new DataView(bytes.buffer);
  header.setUint32(8, version, true);
  header.setUint32(12, count, true);
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

function fixture(initial: Uint8Array | null = null) {
  let saved = initial;
  const store = {
    read: vi.fn<SyntheticCiphertextStore["read"]>().mockImplementation(async () => saved),
    createIfAbsent: vi.fn<SyntheticCiphertextStore["createIfAbsent"]>().mockImplementation(async (bytes) => {
      if (saved !== null) return "exists";
      saved = new Uint8Array(bytes);
      return "created";
    }),
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
  ["null", null],
  ["undefined", undefined],
];

describe("SyntheticVaultBackup with fake bytes and an injected test worker", () => {
  it("constructs without reading, writing, validating, or cancelling", () => {
    const { store, worker } = fixture();
    expect(store.read).not.toHaveBeenCalled();
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
    expect(store.read).toHaveBeenCalledOnce();
    const workerBytes = worker.open.mock.calls[0]![0];
    expect(workerBytes).toEqual(expected);
    expect(workerBytes).not.toBe(saved);
    saved.fill(0);
    workerBytes.fill(9);
    validation.resolve([]);
    const exported = await pending;
    expect(exported).toEqual(expected);
    expect(exported).not.toBe(saved);
    expect(exported).not.toBe(workerBytes);
    expect(exported.buffer).not.toBe(workerBytes.buffer);
    exported.fill(4);
    expect(saved).toEqual(new Uint8Array(32));
    expect(store.read).toHaveBeenCalledOnce();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });

  it("returns EMPTY for absent storage without validating or creating", async () => {
    const { backup, store, worker } = fixture();
    await expect(backup.exportArchive()).rejects.toMatchObject({ code: "EMPTY" });
    expect(store.read).toHaveBeenCalledOnce();
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
      await expect(backup.exportArchive()).resolves.toEqual(fakeArchive(length));
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

  it.each([[1, 3], [2, 3], [2, 4], [2, 128]])(
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

  it.each([0, 3, 0xffff_ffff])("refuses unsupported archive version %i without storage or validation", async (version) => {
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
    ["future version", withHeader(3), "UNSUPPORTED_VERSION"],
    ["v2 low count", withHeader(2, 2), "INVALID_BACKUP"],
    ["v2 excessive count", withHeader(2, 129), "INVALID_BACKUP"],
    ["oversized", fakeArchive(MAX_SYNTHETIC_ARCHIVE_BYTES + 1), "LIMIT_EXCEEDED"],
    ["subclass", new ArchiveSubclass(fakeArchive()), "INVALID_BACKUP"],
  ] as const)("refuses to export %s saved bytes without rewriting them", async (_label, bytes, code) => {
    const expected = new Uint8Array(bytes);
    const { backup, store, worker } = fixture(bytes);
    await expect(backup.exportArchive()).rejects.toMatchObject({ code });
    expect(new Uint8Array(bytes)).toEqual(expected);
    expect(store.read).toHaveBeenCalledOnce();
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

  it.each(["export-read", "restore-read", "create", "readback"])(
    "normalizes a %s storage failure and never retries", async (stage) => {
      const { backup, store, worker } = fixture(stage === "export-read" ? fakeArchive() : null);
      const failure = new SyntheticStorageError("quota");
      Object.assign(failure, { message: "SYNTHETIC_PRIVATE_STORAGE_MESSAGE", code: "SYNTHETIC_PRIVATE_STORAGE_CODE" });
      if (stage === "create") store.createIfAbsent.mockRejectedValueOnce(failure);
      else if (stage === "readback") store.read.mockResolvedValueOnce(null).mockRejectedValueOnce(failure);
      else store.read.mockRejectedValueOnce(failure);
      const operation = stage === "export-read" ? backup.exportArchive() : backup.restoreArchive(fakeArchive());
      await expect(operation).rejects.toMatchObject({
        name: "SyntheticBackupError", code: "STORAGE_FAILED", message: new SyntheticBackupError("STORAGE_FAILED").message,
      });
      expect(store.read).toHaveBeenCalledTimes(stage === "readback" ? 2 : 1);
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

  it.each(["initial-read", "validation"])("cancel during export %s never yields an archive", async (stage) => {
    const { backup, store, worker } = fixture(fakeArchive());
    const blocked = stageGate<unknown>();
    if (stage === "initial-read") store.read.mockImplementationOnce(() => blocked.run() as Promise<Uint8Array | null>);
    else worker.open.mockImplementationOnce(() => blocked.run() as Promise<readonly LocalCatalogEntryV1[]>);
    const pending = backup.exportArchive();
    const rejection = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await blocked.entered;
    expect(store.read).toHaveBeenCalledOnce();
    expect(worker.open).toHaveBeenCalledTimes(stage === "initial-read" ? 0 : 1);
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    backup.cancel();
    blocked.resolve(stage === "initial-read" ? fakeArchive() : []);
    await rejection;
    expect(worker.open).toHaveBeenCalledTimes(stage === "initial-read" ? 0 : 1);
    expect(store.createIfAbsent).not.toHaveBeenCalled();
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
    const read = deferred<Uint8Array | null>();
    store.read.mockReturnValueOnce(read.promise);
    const first = backup.exportArchive();
    await expect(second === "export" ? backup.exportArchive() : backup.restoreArchive(fakeArchive()))
      .rejects.toMatchObject({ code: "BUSY" });
    expect(store.read).toHaveBeenCalledOnce();
    expect(worker.cancel).not.toHaveBeenCalled();
    read.resolve(fakeArchive());
    await expect(first).resolves.toEqual(fakeArchive());
    await expect(backup.exportArchive()).resolves.toEqual(fakeArchive());
  });

  it.each(["resolve", "reject"] as const)("a stale %s cannot clear BUSY on a newer operation", async (outcome) => {
    const { backup, store } = fixture(fakeArchive());
    const oldRead = deferred<Uint8Array | null>();
    const newRead = deferred<Uint8Array | null>();
    store.read.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const oldOperation = backup.exportArchive();
    const oldRejection = expect(oldOperation).rejects.toMatchObject({ code: "CANCELLED" });
    backup.cancel();
    const newOperation = backup.exportArchive();
    if (outcome === "resolve") oldRead.resolve(fakeArchive());
    else oldRead.reject(new Error("SYNTHETIC_PRIVATE_OLD_FAILURE"));
    await oldRejection;
    await expect(backup.exportArchive()).rejects.toMatchObject({ code: "BUSY" });
    expect(store.read).toHaveBeenCalledTimes(2);
    newRead.resolve(fakeArchive());
    await expect(newOperation).resolves.toEqual(fakeArchive());
  });

  it("allows a new operation after validation failure", async () => {
    const { backup, worker } = fixture(fakeArchive());
    worker.open.mockRejectedValueOnce(new Error("SYNTHETIC_FAILURE"));
    await expect(backup.exportArchive()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(backup.exportArchive()).resolves.toEqual(fakeArchive());
  });

  it("cancel remains safe when worker cleanup throws and a new operation can begin", async () => {
    const { backup, store, worker } = fixture(fakeArchive());
    const read = deferred<Uint8Array | null>();
    store.read.mockReturnValueOnce(read.promise);
    worker.cancel.mockImplementation(() => { throw new Error("SYNTHETIC_PRIVATE_CLEANUP_FAILURE"); });
    const pending = backup.exportArchive();
    const rejection = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(() => backup.cancel()).not.toThrow();
    read.resolve(fakeArchive());
    await rejection;
    await expect(backup.exportArchive()).resolves.toEqual(fakeArchive());
  });

  it("sanitizes tampered backup errors and reads their code accessor only once", async () => {
    const { backup, store, worker } = fixture();
    const code = vi.fn().mockReturnValueOnce("INVALID_BACKUP").mockReturnValue("SYNTHETIC_PRIVATE_CODE");
    const error = Object.defineProperty(new SyntheticBackupError("INVALID_BACKUP"), "code", { get: code });
    error.message = "SYNTHETIC_PRIVATE_MESSAGE";
    const input = Object.defineProperty(fakeArchive(), "byteLength", { get() { throw error; } });
    await expect(backup.restoreArchive(input)).rejects.toMatchObject({
      code: "INVALID_BACKUP", message: new SyntheticBackupError("INVALID_BACKUP").message,
    });
    expect(code).toHaveBeenCalledOnce();
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  });

  it("preserves cancellation triggered by a reentrant error-code accessor", async () => {
    const { backup, store, worker } = fixture();
    const error = Object.defineProperty(new SyntheticBackupError("INVALID_BACKUP"), "code", {
      get() { backup.cancel(); return "INVALID_BACKUP"; },
    });
    const input = Object.defineProperty(fakeArchive(), "byteLength", { get() { throw error; } });
    await expect(backup.restoreArchive(input)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
  });
});

describe("SyntheticVaultBackup with fake IndexedDB and fake validation (not real WASM proof)", () => {
  it.each([[1, 3], [2, 4]])("round-trips v%i count %i exact bytes across separate database factories and new store instances", async (version, count) => {
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
