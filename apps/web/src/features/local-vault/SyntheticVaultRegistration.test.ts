import { describe, expect, it, vi } from "vitest";
import { CatalogAdapterError, type LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import type { SyntheticMutableCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import { SyntheticVaultSession, type SyntheticRegistrationWorker } from "./SyntheticVaultSession";

const selection = () => ({ profileId: 1, credentialId: 0, connectionIds: [0, 2] });
const oldBytes = new Uint8Array([1]);
const newBytes = new Uint8Array([1, 2]);
function rows(name: string): readonly LocalCatalogEntryV1[] {
  return [{ reference: 0, itemName: name, providerName: "Example", credentialType: "api_key",
    issuerAccountIdentifier: "demo-account", issuerOrganizationOrWorkspace: null,
    issuerProject: "demo-project", issuerEnvironment: "demo",
    status: "active", connectionCount: 0, mcpConnectionCount: 0, secretFieldCount: 1, connections: [] }];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
function fixture() {
  let saved: Uint8Array | null = oldBytes;
  const store = {
    read: vi.fn<SyntheticMutableCiphertextStore["read"]>(async () => saved),
    createIfAbsent: vi.fn<SyntheticMutableCiphertextStore["createIfAbsent"]>(),
    compareAndSwapArchive: vi.fn<SyntheticMutableCiphertextStore["compareAndSwapArchive"]>(async (before, next) => {
      if (saved === null) return "missing";
      if (before.length !== saved.length || before.some((v, i) => v !== saved![i])) return "conflict";
      saved = new Uint8Array(next);
      return "updated";
    }),
  };
  const worker = {
    create: vi.fn<SyntheticRegistrationWorker["create"]>(),
    open: vi.fn<SyntheticRegistrationWorker["open"]>(async (bytes) => rows(bytes.length === 1 ? "old" : "saved")),
    append: vi.fn<SyntheticRegistrationWorker["append"]>().mockResolvedValue(newBytes),
    cancel: vi.fn(),
  };
  return { store, worker, session: new SyntheticVaultSession(store, worker), saved: () => saved };
}

describe("synthetic registration session", () => {
  it("does nothing while locked and does not implicitly create or unlock", async () => {
    const { session, store, worker } = fixture();
    await session.register(selection());
    expect(session.state.phase).toBe("locked");
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.append).not.toHaveBeenCalled();
  });
  it("clears old UI, authenticates append, CAS commits, rereads and authenticates stored bytes", async () => {
    const { session, store, worker, saved } = fixture();
    await session.open();
    const generation = session.viewGeneration;
    const phases: string[] = [];
    session.subscribe(() => { phases.push(session.state.phase); });
    const promise = session.register(selection());
    expect(session.state.entries).toEqual([]);
    await promise;
    expect(phases).toEqual(["busy", "open"]);
    expect(session.viewGeneration).toBeGreaterThan(generation);
    expect(worker.append).toHaveBeenCalledWith(oldBytes, selection());
    expect(store.compareAndSwapArchive).toHaveBeenCalledWith(oldBytes, newBytes);
    expect(worker.open).toHaveBeenLastCalledWith(saved());
    expect(session.state.entries[0]!.itemName).toBe("saved");
    expect(store.read).toHaveBeenCalledTimes(3);
    expect(worker.create).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });
  it("a second registration while busy cannot supersede the pending write", async () => {
    const { session, worker } = fixture();
    await session.open();
    const gate = deferred<Uint8Array>();
    worker.append.mockReturnValue(gate.promise);
    const pending = session.register(selection());
    await flush();
    await session.register(selection());
    expect(worker.append).toHaveBeenCalledOnce();
    gate.resolve(newBytes);
    await pending;
    expect(session.state.phase).toBe("open");
  });
  it("snapshots selection before async storage reads", async () => {
    const { session, store, worker } = fixture();
    await session.open();
    const gate = deferred<Uint8Array | null>();
    store.read.mockReturnValueOnce(gate.promise);
    const input = selection();
    const pending = session.register(input);
    input.profileId = 0;
    input.connectionIds.push(1);
    gate.resolve(oldBytes);
    await pending;
    expect(worker.append).toHaveBeenCalledWith(oldBytes, selection());
  });
  it.each(["conflict", "missing"] as const)("does not retry or show a candidate when CAS returns %s", async (outcome) => {
    const { session, store, worker } = fixture();
    await session.open();
    store.compareAndSwapArchive.mockResolvedValue(outcome);
    await session.register(selection());
    expect(session.state).toEqual({ phase: "error", entries: [], errorCode: outcome === "missing" ? "STORAGE_MISSING" : "STORAGE_CONFLICT" });
    expect(worker.open).toHaveBeenCalledOnce();
    expect(store.compareAndSwapArchive).toHaveBeenCalledOnce();
  });
  it.each(["read", "append", "commit", "reread", "reopen"])("failures at %s never publish candidate rows or reset data", async (stage) => {
    const { session, store, worker } = fixture();
    await session.open();
    const error = new Error("private details");
    if (stage === "read") store.read.mockRejectedValueOnce(error);
    if (stage === "append") worker.append.mockRejectedValueOnce(error);
    if (stage === "commit") store.compareAndSwapArchive.mockRejectedValueOnce(error);
    if (stage === "reread") store.read.mockResolvedValueOnce(oldBytes).mockRejectedValueOnce(error);
    if (stage === "reopen") worker.open.mockRejectedValueOnce(error);
    await session.register(selection());
    expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "OPERATION_FAILED" });
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    if (stage === "read" || stage === "append") expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
  });
  it.each([null, new Uint8Array([9])])("does not use candidate as fallback when saved readback is %j", async (readback) => {
    const { session, store, worker } = fixture();
    await session.open();
    store.read.mockResolvedValueOnce(oldBytes).mockResolvedValueOnce(readback);
    await session.register(selection());
    expect(session.state.errorCode).toBe(readback === null ? "STORAGE_MISSING" : "STORAGE_CONFLICT");
    expect(session.state.entries).toEqual([]);
    expect(worker.open).toHaveBeenCalledOnce();
  });
  it.each(["read", "append", "commit", "reread", "reopen"])("lock during %s prevents every late UI publication", async (stage) => {
    const { session, store, worker } = fixture();
    await session.open();
    const gate = deferred<never>();
    if (stage === "read") store.read.mockReturnValueOnce(gate.promise);
    if (stage === "append") worker.append.mockReturnValueOnce(gate.promise);
    if (stage === "commit") store.compareAndSwapArchive.mockReturnValueOnce(gate.promise);
    if (stage === "reread") store.read.mockResolvedValueOnce(oldBytes).mockReturnValueOnce(gate.promise);
    if (stage === "reopen") worker.open.mockReturnValueOnce(gate.promise);
    const pending = session.register(selection());
    await flush();
    // Prove the requested stage was entered before applying the lock.
    expect(store.read).toHaveBeenCalledTimes(stage === "reread" || stage === "reopen" ? 3 : 2);
    expect(worker.append).toHaveBeenCalledTimes(stage === "read" ? 0 : 1);
    expect(store.compareAndSwapArchive).toHaveBeenCalledTimes(stage === "read" || stage === "append" ? 0 : 1);
    expect(worker.open).toHaveBeenCalledTimes(stage === "reopen" ? 2 : 1);
    session.lock();
    const value = stage === "read" ? oldBytes : stage === "commit" ? "updated" : stage === "reopen" ? rows("late") : newBytes;
    gate.resolve(value as never);
    await pending;
    expect(session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
    if (stage === "read" || stage === "append") expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
  });
  it("a subscriber lock at busy notification prevents work", async () => {
    const { session, store, worker } = fixture();
    await session.open();
    session.subscribe(() => { if (session.state.phase === "busy") session.lock(); });
    await session.register(selection());
    expect(store.read).toHaveBeenCalledOnce();
    expect(worker.append).not.toHaveBeenCalled();
    expect(session.state.phase).toBe("locked");
  });
  it("late rejected append after lock/reopen cannot replace the newer open state", async () => {
    const { session, worker } = fixture();
    await session.open();
    const gate = deferred<Uint8Array>();
    worker.append.mockReturnValueOnce(gate.promise);
    const pending = session.register(selection());
    await flush();
    expect(worker.append).toHaveBeenCalledOnce();
    session.lock();
    await session.open();
    const current = session.state;
    gate.reject(new CatalogAdapterError("AUTHENTICATION_FAILED"));
    await pending;
    expect(session.state).toBe(current);
    expect(session.state.phase).toBe("open");
  });
  it("rejects invalid input and keeps fixed errors", async () => {
    const { session, store, worker } = fixture();
    await session.open();
    await session.register({ ...selection(), secret: "DEMO_VALUE_ONLY" });
    expect(session.state.errorCode).toBe("INVALID_ARCHIVE");
    expect(store.read).toHaveBeenCalledOnce();
    expect(worker.append).not.toHaveBeenCalled();
    await session.open();
    worker.append.mockRejectedValueOnce(new CatalogAdapterError("AUTHENTICATION_FAILED"));
    await session.register(selection());
    expect(session.state.errorCode).toBe("AUTHENTICATION_FAILED");
  });
  it("reports missing registration capability without modifying storage", async () => {
    const { store, worker } = fixture();
    const session = new SyntheticVaultSession({ read: store.read, createIfAbsent: store.createIfAbsent }, worker);
    await session.open();
    await session.register(selection());
    expect(session.state.errorCode).toBe("REGISTRATION_UNAVAILABLE");
    expect(worker.append).not.toHaveBeenCalled();
  });
  it("two writers sharing a prior archive have exactly one winner, no lost update", async () => {
    const { session, store, worker, saved } = fixture();
    const second = new SyntheticVaultSession(store, { ...worker, append: vi.fn(async () => new Uint8Array([1, 3])) });
    await Promise.all([session.open(), second.open()]);
    await Promise.all([session.register(selection()), second.register(selection())]);
    expect([session.state.phase, second.state.phase].sort()).toEqual(["error", "open"]);
    expect([session.state.errorCode, second.state.errorCode]).toContain("STORAGE_CONFLICT");
    expect(saved()!.length).toBe(2);
    expect(store.compareAndSwapArchive).toHaveBeenCalledTimes(2);
  });

  it.each([
    [2, 0, []], [0, 1, []], [1, 2, []],
    [2, 1, [0]], [2, 2, [2]], [2, 3, []],
  ])("rejects mismatched Password tuple (%i, %i, %j) before reading storage or calling append", async (profileId, credentialId, connectionIds) => {
    const { session, store, worker, saved } = fixture();
    await session.open();
    store.read.mockClear();
    worker.open.mockClear();
    await session.register({ profileId, credentialId, connectionIds });
    expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "INVALID_ARCHIVE" });
    expect(store.read).not.toHaveBeenCalled();
    expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
    expect(worker.append).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
    expect(saved()).toEqual(oldBytes);
  });

  it.each([1, 2])("owns Password form %i selection before awaiting storage", async (credentialId) => {
    const { session, store, worker } = fixture();
    await session.open();
    const gate = deferred<Uint8Array | null>();
    store.read.mockReturnValueOnce(gate.promise);
    const input = { profileId: 2, credentialId, connectionIds: [] as number[] };
    const pending = session.register(input);
    input.profileId = 0;
    input.credentialId = 0;
    input.connectionIds.push(0);
    gate.resolve(oldBytes);
    await pending;
    expect(worker.append).toHaveBeenCalledWith(oldBytes, { profileId: 2, credentialId, connectionIds: [] });
    expect(session.state.phase).toBe("open");
  });

  it.each([1, 2])("keeps stored bytes and clears candidate views when Password form %i loses CAS", async (credentialId) => {
    const { session, store, worker, saved } = fixture();
    await session.open();
    store.compareAndSwapArchive.mockResolvedValueOnce("conflict");
    await session.register({ profileId: 2, credentialId, connectionIds: [] });
    expect(worker.append).toHaveBeenCalledOnce();
    expect(store.compareAndSwapArchive).toHaveBeenCalledOnce();
    expect(worker.open).toHaveBeenCalledOnce();
    expect(saved()).toEqual(oldBytes);
    expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "STORAGE_CONFLICT" });
    expect(worker.create).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });
});
