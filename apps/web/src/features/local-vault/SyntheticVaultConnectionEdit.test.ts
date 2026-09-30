import { describe, expect, it, vi } from "vitest";
import { CatalogAdapterError, type LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import {
  MAX_SYNTHETIC_ARCHIVE_BYTES,
  SyntheticStorageError,
  type SyntheticConflictCiphertextStore,
  type SyntheticMutableCiphertextStore,
} from "../../storage/SyntheticCiphertextStore";
import { SyntheticVaultSession, type SyntheticConnectionEditWorker, type SyntheticRegistrationWorker } from "./SyntheticVaultSession";

const original = new Uint8Array([1, 2]);
const candidate = new Uint8Array([1, 2, 3]);
const selected = () => ({ reference: 0, connectionIds: [2, 0] });
function rows(name: string): readonly LocalCatalogEntryV1[] {
  return [{ reference: 0, itemName: name, providerName: "Example", credentialType: "api_key",
    issuerAccountIdentifier: "demo-account", issuerOrganizationOrWorkspace: null,
    issuerProject: "demo-project", issuerEnvironment: "demo", status: "active",
    connectionCount: 0, mcpConnectionCount: 0, secretFieldCount: 1, connections: [] }];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }
function invalidLengthArchive(kind: string): Uint8Array {
  const bytes = kind === "shared" ? new Uint8Array(new SharedArrayBuffer(2))
    : new Uint8Array(kind === "oversized" ? MAX_SYNTHETIC_ARCHIVE_BYTES + 1 : kind === "detached" ? 2 : 0);
  if (kind === "detached") structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  if (kind === "shared") Object.defineProperty(bytes, "buffer", { value: new ArrayBuffer(2) });
  return Object.defineProperty(bytes, "byteLength", { value: 1 });
}
function fixture() {
  let saved: Uint8Array | null = original.slice();
  const store = {
    read: vi.fn<SyntheticMutableCiphertextStore["read"]>(async () => saved),
    createIfAbsent: vi.fn<SyntheticMutableCiphertextStore["createIfAbsent"]>(async (bytes) => {
      if (saved !== null) return "exists";
      saved = bytes.slice(); return "created";
    }),
    compareAndSwapArchive: vi.fn<SyntheticMutableCiphertextStore["compareAndSwapArchive"]>(async (before, next) => {
      if (saved === null) return "missing";
      if (before.length !== saved.length || before.some((byte, index) => byte !== saved![index])) return "conflict";
      saved = next.slice(); return "updated";
    }),
  };
  const worker = {
    create: vi.fn<SyntheticConnectionEditWorker["create"]>().mockResolvedValue(original.slice()),
    open: vi.fn<SyntheticConnectionEditWorker["open"]>(async (bytes) => rows(bytes.length === 2 ? "original" : "saved")),
    editConnections: vi.fn<SyntheticConnectionEditWorker["editConnections"]>().mockImplementation(async () => candidate.slice()),
    append: vi.fn<SyntheticRegistrationWorker["append"]>().mockImplementation(async () => candidate.slice()),
    cancel: vi.fn(),
  };
  return { store, worker, session: new SyntheticVaultSession(store, worker),
    saved: () => saved, replace: (bytes: Uint8Array | null) => { saved = bytes; } };
}

function preservingFixture() {
  const base = fixture();
  const preservingCas = vi.fn<SyntheticConflictCiphertextStore["compareAndSwapArchivePreservingConflict"]>(
    async (before, next) => {
      const saved = base.saved();
      if (saved === null) return { kind: "missing" };
      if (before.length !== saved.length || before.some((byte, index) => byte !== saved[index])) {
        return { kind: "conflict-preserved", conflictId: "0".repeat(31) + "1" };
      }
      base.replace(next.slice());
      return { kind: "updated" };
    },
  );
  const preserveAfterReadback = vi.fn<SyntheticConflictCiphertextStore["preserveConflictArchiveIfCurrentDiffers"]>(
    async (next) => {
      const saved = base.saved();
      if (saved === null) return { kind: "missing" };
      if (next.length === saved.length && next.every((byte, index) => byte === saved[index])) {
        return { kind: "already-current" };
      }
      return { kind: "conflict-preserved", conflictId: "0".repeat(31) + "2" };
    },
  );
  const store = Object.assign(base.store, {
    compareAndSwapArchivePreservingConflict: preservingCas,
    preserveConflictArchiveIfCurrentDiffers: preserveAfterReadback,
  });
  return { ...base, store, preservingCas, preserveAfterReadback,
    session: new SyntheticVaultSession(store, base.worker) };
}

describe("snapshot-bound synthetic connection edit session", () => {
  it.each(["empty", "oversized", "detached", "shared"])("rejects %s stored bytes despite a spoofed byteLength before open", async (kind) => {
    const { session, store, worker, replace } = fixture();
    replace(invalidLengthArchive(kind));
    await session.open();
    expect(session.state).toEqual({ phase: "error", entries: [], errorCode: kind === "oversized" ? "LIMITS_EXCEEDED" : "INVALID_ARCHIVE" });
    expect(worker.open).not.toHaveBeenCalled();
    expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });
  it.each(["empty", "oversized", "detached", "shared"])("rejects %s candidates despite spoofed byteLength before commit", async (kind) => {
    const { session, store, worker } = fixture(); await session.open();
    worker.editConnections.mockResolvedValueOnce(invalidLengthArchive(kind));
    await session.editConnections(session.viewGeneration, selected());
    expect(session.state.errorCode).toBe(kind === "oversized" ? "LIMITS_EXCEEDED" : "INVALID_ARCHIVE");
    expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
    expect(worker.open).toHaveBeenCalledOnce();
  });
  it("uses native lengths and indexed comparisons without evaluating byteLength/length/method shadows", async () => {
    const { session, store, worker, replace } = fixture();
    const shadow = vi.fn(() => { throw new Error("unused shadow"); });
    const initiallySaved = Object.defineProperties(original.slice(), {
      buffer: { get: shadow }, byteLength: { get: shadow }, length: { get: shadow },
      every: { get: shadow }, some: { get: shadow },
    });
    replace(initiallySaved); await session.open();
    expect(session.state.phase).toBe("open");
    expect(shadow).not.toHaveBeenCalled();
    const changed = Object.defineProperties(new Uint8Array([1, 2, 99]), {
      buffer: { get: shadow }, byteLength: { value: 2 }, length: { value: 2 },
      every: { get: shadow }, some: { get: shadow },
    });
    replace(changed);
    await session.editConnections(session.viewGeneration, selected());
    expect(session.state.errorCode).toBe("STORAGE_CONFLICT");
    expect(worker.editConnections).not.toHaveBeenCalled();
    expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
    expect(shadow).not.toHaveBeenCalled();
  });
  it("rejects a SharedArrayBuffer-backed current archive before invoking the edit worker", async () => {
    const { session, store, worker, replace } = fixture();
    await session.open();
    replace(new Uint8Array(new SharedArrayBuffer(2)));
    await session.editConnections(session.viewGeneration, selected());
    expect(session.state.errorCode).toBe("STORAGE_CONFLICT");
    expect(worker.editConnections).not.toHaveBeenCalled();
    expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
  });
  it("cannot hide a longer saved readback using own length/byteLength or equality methods", async () => {
    const { session, store, worker } = fixture(); await session.open();
    const shadow = vi.fn(() => true);
    const readback = Object.defineProperties(new Uint8Array([1, 2, 3, 9]), {
      length: { value: 3 }, byteLength: { value: 3 }, every: { value: shadow }, some: { value: shadow },
    });
    store.read.mockResolvedValueOnce(original).mockResolvedValueOnce(readback);
    await session.editConnections(session.viewGeneration, selected());
    expect(session.state.errorCode).toBe("STORAGE_CONFLICT");
    expect(worker.open).toHaveBeenCalledTimes(2);
    expect(shadow).not.toHaveBeenCalled();
  });
  it("does not authenticate a registration readback with forged length and equality methods", async () => {
    const { session, store, worker } = fixture(); await session.open();
    const shadow = vi.fn(() => false);
    const readback = Object.defineProperties(new Uint8Array([1, 2, 3, 9]), {
      length: { value: 3 }, byteLength: { value: 3 }, some: { value: shadow },
    });
    store.read.mockResolvedValueOnce(original.slice()).mockResolvedValueOnce(readback);
    await session.register({ profileId: 0, credentialId: 0, connectionIds: [] });
    expect(session.state.errorCode).toBe("STORAGE_CONFLICT");
    expect(worker.open).toHaveBeenCalledTimes(2);
    expect(shadow).not.toHaveBeenCalled();
  });
  it("does nothing when locked or stale, without inspecting selection or resetting state", async () => {
    const { session, store, worker } = fixture();
    await session.editConnections(0, selected());
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.cancel).not.toHaveBeenCalled();
    await session.open();
    const oldGeneration = session.viewGeneration;
    session.lock(); await session.open();
    const currentState = session.state;
    const inspect = vi.fn(() => { throw new Error(); });
    const hostile = new Proxy({}, { getPrototypeOf: inspect });
    const reads = store.read.mock.calls.length;
    const cancels = worker.cancel.mock.calls.length;
    await session.editConnections(oldGeneration, hostile);
    expect(session.state).toBe(currentState);
    expect(store.read).toHaveBeenCalledTimes(reads);
    expect(worker.cancel).toHaveBeenCalledTimes(cancels);
    expect(worker.editConnections).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });
  it("authenticates a candidate before CAS and publishes only an exact CAS readback", async () => {
    const { session, store, worker } = fixture();
    await session.open();
    const generation = session.viewGeneration;
    const phases: string[] = [];
    session.subscribe(() => { phases.push(session.state.phase); });
    const operation = session.editConnections(generation, selected());
    expect(session.state.entries).toEqual([]);
    await operation;
    expect(phases).toEqual(["busy", "open"]);
    expect(worker.editConnections).toHaveBeenCalledWith(original, selected());
    expect(store.compareAndSwapArchive).toHaveBeenCalledWith(original, candidate);
    expect(worker.open).toHaveBeenLastCalledWith(candidate);
    expect(worker.open).toHaveBeenCalledTimes(3);
    expect(session.state.entries[0]!.itemName).toBe("saved");
    expect(Object.keys(session.state).sort()).toEqual(["entries", "errorCode", "phase"]);
    expect(store.read).toHaveBeenCalledTimes(3);
    await session.editConnections(session.viewGeneration, selected());
    expect(worker.editConnections).toHaveBeenLastCalledWith(candidate, selected());
    expect(session.state.phase).toBe("open");
    expect(worker.create).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });
  it.each([null, new Uint8Array(), new Uint8Array([9, 2]), new Uint8Array([1, 2, 3])])(
    "rejects a missing/changed displayed archive before worker edit or any write: %j", async (changed) => {
      const { session, store, worker, replace, saved } = fixture();
      await session.open(); replace(changed);
      await session.editConnections(session.viewGeneration, selected());
      expect(session.state).toEqual({ phase: "error", entries: [], errorCode: changed === null ? "STORAGE_MISSING" : "STORAGE_CONFLICT" });
      expect(worker.editConnections).not.toHaveBeenCalled();
      expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
      expect(saved()).toEqual(changed);
    },
  );
  it("owns the displayed bytes independently of store and worker argument mutations", async () => {
    const { session, store, worker, saved } = fixture();
    worker.open.mockImplementationOnce(async (bytes) => { bytes.fill(7); return rows("original"); });
    await session.open();
    expect(saved()).toEqual(original);
    worker.editConnections.mockImplementationOnce(async (bytes) => { bytes.fill(8); return candidate.slice(); });
    await session.editConnections(session.viewGeneration, selected());
    expect(store.compareAndSwapArchive).toHaveBeenCalledWith(original, candidate);
    expect(session.state.phase).toBe("open");
    saved()![0] = 9;
    await session.editConnections(session.viewGeneration, selected());
    expect(session.state.errorCode).toBe("STORAGE_CONFLICT");
    expect(worker.editConnections).toHaveBeenCalledOnce();
  });
  it.each(["create", "register"])("records only authenticated saved bytes after %s", async (operation) => {
    const { session, store, worker, replace, saved } = fixture();
    if (operation === "create") { replace(null); await session.create(); }
    else {
      await session.open();
      store.read.mockImplementation(async () => saved()?.slice() ?? null);
      await session.register({ profileId: 0, credentialId: 0, connectionIds: [] });
    }
    expect(session.state.phase).toBe("open");
    await session.editConnections(session.viewGeneration, selected());
    expect(worker.editConnections).toHaveBeenCalledWith(operation === "create" ? original : candidate, selected());
    expect(session.state.phase).toBe("open");
  });
  it("copies the selection before the first storage await", async () => {
    const { session, store, worker } = fixture(); await session.open();
    const gate = deferred<Uint8Array | null>(); store.read.mockReturnValueOnce(gate.promise);
    const input = selected(); const pending = session.editConnections(session.viewGeneration, input);
    input.reference = 1; input.connectionIds.length = 0;
    gate.resolve(original); await pending;
    expect(worker.editConnections).toHaveBeenCalledWith(original, selected());
  });
  it.each(["conflict", "missing"] as const)("preserves the store and does not retry a losing CAS: %s", async (outcome) => {
    const { session, store, worker, saved } = fixture(); await session.open();
    store.compareAndSwapArchive.mockResolvedValueOnce(outcome);
    await session.editConnections(session.viewGeneration, selected());
    expect(session.state.errorCode).toBe(outcome === "missing" ? "STORAGE_MISSING" : "STORAGE_CONFLICT");
    expect(session.state.entries).toEqual([]);
    expect(worker.open).toHaveBeenCalledTimes(2);
    expect(store.compareAndSwapArchive).toHaveBeenCalledOnce();
    expect(saved()).toEqual(original);
  });
  it.each([null, new Uint8Array(), new Uint8Array([9])])("never falls back to a candidate on changed/missing readback %j", async (readback) => {
    const { session, store, worker } = fixture(); await session.open();
    store.read.mockResolvedValueOnce(original).mockResolvedValueOnce(readback);
    await session.editConnections(session.viewGeneration, selected());
    expect(session.state.errorCode).toBe(readback === null ? "STORAGE_MISSING" : "STORAGE_CONFLICT");
    expect(worker.open).toHaveBeenCalledTimes(2);
  });
  it("protects the candidate comparison from store and worker-owned mutation", async () => {
    const { session, store, worker } = fixture(); await session.open();
    const returned = candidate.slice(); worker.editConnections.mockResolvedValueOnce(returned);
    store.compareAndSwapArchive.mockImplementationOnce(async (before, next) => {
      before.fill(0); next.fill(0); returned.fill(0); return "updated";
    });
    store.read.mockResolvedValueOnce(original).mockResolvedValueOnce(new Uint8Array(candidate.length));
    await session.editConnections(session.viewGeneration, selected());
    expect(session.state.errorCode).toBe("STORAGE_CONFLICT");
    expect(worker.open).toHaveBeenCalledTimes(2);
  });
  it.each(["read", "edit", "commit", "reread", "reopen"])("clears views and uses fixed failures at %s", async (stage) => {
    const { session, store, worker } = fixture(); await session.open();
    const error = new Error("PRIVATE_ERROR");
    if (stage === "read") store.read.mockRejectedValueOnce(error);
    if (stage === "edit") worker.editConnections.mockRejectedValueOnce(error);
    if (stage === "commit") store.compareAndSwapArchive.mockRejectedValueOnce(error);
    if (stage === "reread") store.read.mockResolvedValueOnce(original).mockRejectedValueOnce(error);
    if (stage === "reopen") {
      worker.open.mockResolvedValueOnce(rows("candidate-auth"));
      worker.open.mockRejectedValueOnce(new CatalogAdapterError("AUTHENTICATION_FAILED"));
    }
    await session.editConnections(session.viewGeneration, selected());
    expect(session.state).toEqual({ phase: "error", entries: [], errorCode: stage === "reopen" ? "AUTHENTICATION_FAILED" : "OPERATION_FAILED" });
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    if (stage === "read" || stage === "edit") expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
  });
  it("legacy fallback authenticates a candidate before committing it", async () => {
    const { session, store, worker, saved } = fixture();
    await session.open();
    worker.open.mockRejectedValueOnce(new CatalogAdapterError("AUTHENTICATION_FAILED"));
    await session.editConnections(session.viewGeneration, selected());
    expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "AUTHENTICATION_FAILED" });
    expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
    expect(saved()).toEqual(original);
  });
  it.each(["read", "edit", "commit", "reread", "reopen"])("lock during %s prevents all later publication", async (stage) => {
    const { session, store, worker } = fixture(); await session.open();
    const gate = deferred<never>();
    if (stage === "read") store.read.mockReturnValueOnce(gate.promise);
    if (stage === "edit") worker.editConnections.mockReturnValueOnce(gate.promise);
    if (stage === "commit") store.compareAndSwapArchive.mockReturnValueOnce(gate.promise);
    if (stage === "reread") store.read.mockResolvedValueOnce(original).mockReturnValueOnce(gate.promise);
    if (stage === "reopen") {
      worker.open.mockResolvedValueOnce(rows("candidate-auth"));
      worker.open.mockReturnValueOnce(gate.promise);
    }
    const pending = session.editConnections(session.viewGeneration, selected()); await flush();
    expect(store.read).toHaveBeenCalledTimes(stage === "reread" || stage === "reopen" ? 3 : 2);
    expect(worker.editConnections).toHaveBeenCalledTimes(stage === "read" ? 0 : 1);
    expect(store.compareAndSwapArchive).toHaveBeenCalledTimes(stage === "read" || stage === "edit" ? 0 : 1);
    expect(worker.open).toHaveBeenCalledTimes(
      stage === "commit" || stage === "reread" ? 2 : stage === "reopen" ? 3 : 1,
    );
    session.lock();
    gate.resolve((stage === "read" ? original : stage === "commit" ? "updated" : stage === "reopen" ? rows("late") : candidate) as never);
    await pending;
    expect(session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
    if (stage === "read" || stage === "edit") expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
  });
  it("a stale rejection after lock/reopen cannot reset the new view", async () => {
    const { session, worker } = fixture(); await session.open();
    const gate = deferred<Uint8Array>(); worker.editConnections.mockReturnValueOnce(gate.promise);
    const pending = session.editConnections(session.viewGeneration, selected()); await flush();
    session.lock(); await session.open(); const current = session.state;
    gate.reject(new Error("PRIVATE_ERROR")); await pending;
    expect(session.state).toBe(current);
  });
  it("a second edit while busy cannot cancel the first", async () => {
    const { session, worker } = fixture(); await session.open(); const generation = session.viewGeneration;
    const gate = deferred<Uint8Array>(); worker.editConnections.mockReturnValueOnce(gate.promise);
    const pending = session.editConnections(generation, selected()); await flush();
    await session.editConnections(generation, selected());
    expect(worker.editConnections).toHaveBeenCalledOnce();
    gate.resolve(candidate); await pending;
    expect(session.state.phase).toBe("open");
  });
  it("a busy subscriber lock prevents storage work", async () => {
    const { session, worker, store } = fixture(); await session.open();
    session.subscribe(() => { if (session.state.phase === "busy") session.lock(); });
    await session.editConnections(session.viewGeneration, selected());
    expect(session.state.phase).toBe("locked");
    expect(store.read).toHaveBeenCalledOnce(); expect(worker.editConnections).not.toHaveBeenCalled();
  });
  it("rejects invalid input, unavailable capability and oversized candidate before writes", async () => {
    const { session, store, worker } = fixture(); await session.open();
    await session.editConnections(session.viewGeneration, { ...selected(), recordId: "private" });
    expect(session.state.errorCode).toBe("INVALID_ARCHIVE"); expect(store.read).toHaveBeenCalledOnce();
    await session.open(); worker.editConnections.mockResolvedValueOnce(new Uint8Array(MAX_SYNTHETIC_ARCHIVE_BYTES + 1));
    await session.editConnections(session.viewGeneration, selected());
    expect(session.state.errorCode).toBe("LIMITS_EXCEEDED"); expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
    const unavailable = new SyntheticVaultSession({ read: store.read, createIfAbsent: store.createIfAbsent }, worker);
    await unavailable.open(); await unavailable.editConnections(unavailable.viewGeneration, selected());
    expect(unavailable.state.errorCode).toBe("CONNECTION_EDIT_UNAVAILABLE");
  });
  it("two displayed snapshots race with one CAS winner, without overwrite or retry", async () => {
    const { session, store, worker, saved } = fixture();
    const second = new SyntheticVaultSession(store, { ...worker,
      editConnections: vi.fn(async () => new Uint8Array([1, 2, 4])) });
    await Promise.all([session.open(), second.open()]);
    await Promise.all([session.editConnections(session.viewGeneration, selected()), second.editConnections(second.viewGeneration, selected())]);
    expect([session.state.phase, second.state.phase].sort()).toEqual(["error", "open"]);
    expect([session.state.errorCode, second.state.errorCode]).toContain("STORAGE_CONFLICT");
    expect(store.compareAndSwapArchive).toHaveBeenCalledTimes(2);
    expect(saved()!.length).toBe(3);
  });

  describe("atomic conflict-preserving store capability", () => {
    it("authenticates an owned candidate before CAS without a pre-CAS storage read", async () => {
      const { session, store, worker, preservingCas, replace, saved } = preservingFixture();
      await session.open();
      store.read.mockClear();
      worker.open.mockClear();
      worker.editConnections.mockClear();
      store.compareAndSwapArchive.mockClear();
      const events: string[] = [];
      worker.editConnections.mockImplementationOnce(async () => { events.push("edit"); return candidate.slice(); });
      worker.open
        .mockImplementationOnce(async (bytes) => { events.push("candidate-auth"); bytes.fill(0); return rows("uncommitted"); })
        .mockImplementationOnce(async () => { events.push("saved-auth"); return rows("saved"); });
      preservingCas.mockImplementationOnce(async (before, next) => {
        events.push("atomic-cas");
        expect(before).toEqual(original);
        expect(next).toEqual(candidate);
        before.fill(7); next.fill(8);
        replace(candidate.slice());
        return { kind: "updated" };
      });
      store.read.mockImplementationOnce(async () => { events.push("readback"); return saved(); });

      await session.editConnections(session.viewGeneration, selected());

      expect(events).toEqual(["edit", "candidate-auth", "atomic-cas", "readback", "saved-auth"]);
      expect(store.read).toHaveBeenCalledOnce();
      expect(worker.open).toHaveBeenCalledTimes(2);
      expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
      expect(session.state).toMatchObject({ phase: "open", errorCode: null });
      expect(session.state.entries[0]!.itemName).toBe("saved");
      expect(session.state.entries[0]!.itemName).not.toBe("uncommitted");
    });

    it("reports a durably preserved loser distinctly and never publishes it as success", async () => {
      const { session, store, worker, preservingCas, saved } = preservingFixture();
      await session.open();
      preservingCas.mockResolvedValueOnce({
        kind: "conflict-preserved", conflictId: "a".repeat(32),
      });
      await session.editConnections(session.viewGeneration, selected());
      expect(session.state).toEqual({
        phase: "error", entries: [], errorCode: "STORAGE_CONFLICT_PRESERVED",
      });
      expect(saved()).toEqual(original);
      expect(store.read).toHaveBeenCalledOnce();
      expect(worker.open).toHaveBeenCalledTimes(2);
      expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
    });

    it("preserves a candidate when another writer changes storage after an updated CAS", async () => {
      const { session, store, preservingCas, preserveAfterReadback, replace } = preservingFixture();
      await session.open();
      preservingCas.mockImplementationOnce(async () => {
        replace(new Uint8Array([1, 2, 4]));
        return { kind: "updated" };
      });
      await session.editConnections(session.viewGeneration, selected());
      expect(session.state).toEqual({
        phase: "error", entries: [], errorCode: "STORAGE_CONFLICT_PRESERVED",
      });
      expect(preserveAfterReadback).toHaveBeenCalledExactlyOnceWith(candidate);
      expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
      expect(store.read).toHaveBeenCalledTimes(2);
    });

    it("does not claim preservation when post-CAS outbox persistence fails", async () => {
      const { session, preservingCas, preserveAfterReadback, replace } = preservingFixture();
      await session.open();
      preservingCas.mockImplementationOnce(async () => {
        replace(new Uint8Array([1, 2, 4]));
        return { kind: "updated" };
      });
      preserveAfterReadback.mockRejectedValueOnce(new SyntheticStorageError("outbox-full"));
      await session.editConnections(session.viewGeneration, selected());
      expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "outbox-full" });
    });

    it("maps an atomic missing result without storing, retrying or reading back", async () => {
      const { session, store, worker, preservingCas, saved } = preservingFixture();
      await session.open();
      preservingCas.mockResolvedValueOnce({ kind: "missing" });
      await session.editConnections(session.viewGeneration, selected());
      expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "STORAGE_MISSING" });
      expect(saved()).toEqual(original);
      expect(store.read).toHaveBeenCalledOnce();
      expect(worker.open).toHaveBeenCalledTimes(2);
      expect(preservingCas).toHaveBeenCalledOnce();
    });

    it.each(["outbox-full", "quota", "failed"] as const)(
      "keeps the fixed storage failure distinct when atomic preservation fails: %s", async (code) => {
        const { session, store, preservingCas, saved } = preservingFixture();
        await session.open();
        preservingCas.mockRejectedValueOnce(new SyntheticStorageError(code));
        await session.editConnections(session.viewGeneration, selected());
        expect(session.state).toEqual({ phase: "error", entries: [], errorCode: code });
        expect(saved()).toEqual(original);
        expect(store.read).toHaveBeenCalledOnce();
        expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
      },
    );

    it("does not touch storage when pre-commit candidate authentication fails", async () => {
      const { session, store, worker, preservingCas, saved } = preservingFixture();
      await session.open();
      worker.open.mockRejectedValueOnce(new CatalogAdapterError("AUTHENTICATION_FAILED"));
      await session.editConnections(session.viewGeneration, selected());
      expect(session.state).toEqual({
        phase: "error", entries: [], errorCode: "AUTHENTICATION_FAILED",
      });
      expect(preservingCas).not.toHaveBeenCalled();
      expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
      expect(store.read).toHaveBeenCalledOnce();
      expect(saved()).toEqual(original);
    });

    it("rejects a SharedArrayBuffer candidate before authentication or storage", async () => {
      const { session, store, worker, preservingCas } = preservingFixture();
      await session.open();
      worker.editConnections.mockResolvedValueOnce(new Uint8Array(new SharedArrayBuffer(2)));
      await session.editConnections(session.viewGeneration, selected());
      expect(session.state.errorCode).toBe("INVALID_ARCHIVE");
      expect(worker.open).toHaveBeenCalledOnce();
      expect(preservingCas).not.toHaveBeenCalled();
      expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
    });

    it("normalizes hostile atomic result objects without invoking accessors or reading back", async () => {
      const { session, store, preservingCas } = preservingFixture();
      await session.open();
      const getter = vi.fn(() => "updated");
      preservingCas.mockResolvedValueOnce(Object.defineProperty({}, "kind", {
        enumerable: true, get: getter,
      }) as never);
      await session.editConnections(session.viewGeneration, selected());
      expect(getter).not.toHaveBeenCalled();
      expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "OPERATION_FAILED" });
      expect(store.read).toHaveBeenCalledOnce();
    });

    it.each([
      { kind: "updated", extra: "private" },
      { kind: "conflict-preserved", conflictId: "INVALID" },
      { kind: "unknown" },
      null,
    ])("rejects malformed atomic outcomes without a readback: %j", async (outcome) => {
      const { session, store, preservingCas } = preservingFixture();
      await session.open();
      preservingCas.mockResolvedValueOnce(outcome as never);
      await session.editConnections(session.viewGeneration, selected());
      expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "OPERATION_FAILED" });
      expect(store.read).toHaveBeenCalledOnce();
    });

    it("a reentrant hostile result cannot replace a locked state", async () => {
      const fixture = preservingFixture();
      await fixture.session.open();
      const hostile = new Proxy({}, {
        ownKeys() { fixture.session.lock(); throw new Error("private trap"); },
      });
      fixture.preservingCas.mockResolvedValueOnce(hostile as never);
      await fixture.session.editConnections(fixture.session.viewGeneration, selected());
      expect(fixture.session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
      expect(fixture.store.read).toHaveBeenCalledOnce();
    });

    it("lock during candidate authentication prevents the atomic storage call", async () => {
      const { session, worker, preservingCas } = preservingFixture();
      await session.open();
      const gate = deferred<readonly LocalCatalogEntryV1[]>();
      worker.open.mockReturnValueOnce(gate.promise);
      const pending = session.editConnections(session.viewGeneration, selected());
      await flush();
      expect(preservingCas).not.toHaveBeenCalled();
      session.lock();
      gate.resolve(rows("late-candidate"));
      await pending;
      expect(session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
      expect(preservingCas).not.toHaveBeenCalled();
    });

    it("a late atomic completion after lock cannot read back or reopen the UI", async () => {
      const { session, store, preservingCas } = preservingFixture();
      await session.open();
      const gate = deferred<{ kind: "conflict-preserved"; conflictId: string }>();
      preservingCas.mockReturnValueOnce(gate.promise);
      const pending = session.editConnections(session.viewGeneration, selected());
      await flush();
      expect(preservingCas).toHaveBeenCalledOnce();
      session.lock();
      gate.resolve({ kind: "conflict-preserved", conflictId: "b".repeat(32) });
      await pending;
      expect(session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
      expect(store.read).toHaveBeenCalledOnce();
    });
  });
});
