import { describe, expect, it, vi } from "vitest";

import { CatalogAdapterError, type LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import { SyntheticStorageError, type SyntheticCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import { SyntheticVaultSession, type SyntheticVaultWorker } from "./SyntheticVaultSession";

function entry(itemName = "Synthetic item"): LocalCatalogEntryV1 {
  return {
    reference: 0, itemName, providerName: "Demo provider", credentialType: "api_key",
    issuerAccountIdentifier: "demo-account", issuerOrganizationOrWorkspace: null,
    issuerProject: "demo-project", issuerEnvironment: "demo",
    status: "active", connectionCount: 1, secretFieldCount: 1, mcpConnectionCount: 1,
    connections: [{ label: "Demo consumer", consumerType: "mcp_server" }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flush() { for (let index = 0; index < 10; index += 1) await Promise.resolve(); }

function fixture() {
  const store = {
    read: vi.fn<SyntheticCiphertextStore["read"]>().mockResolvedValue(null),
    createIfAbsent: vi.fn<SyntheticCiphertextStore["createIfAbsent"]>().mockResolvedValue("created"),
  };
  const worker = {
    create: vi.fn<SyntheticVaultWorker["create"]>().mockResolvedValue(new Uint8Array([1])),
    open: vi.fn<SyntheticVaultWorker["open"]>().mockResolvedValue([entry()]),
    cancel: vi.fn<SyntheticVaultWorker["cancel"]>(),
  };
  return { store, worker, session: new SyntheticVaultSession(store, worker) };
}

describe("SyntheticVaultSession", () => {
  it("changes the ephemeral view identity across lock/reopen even for identical data", async () => {
    const { session, store } = fixture();
    store.read.mockResolvedValue(new Uint8Array([1]));
    const initial = session.viewGeneration;
    await session.open();
    expect(session.state.phase).toBe("open");
    const opened = session.viewGeneration;
    expect(opened).toBeGreaterThan(initial);
    session.lock();
    const locked = session.viewGeneration;
    expect(locked).toBeGreaterThan(opened);
    await session.open();
    expect(session.state.phase).toBe("open");
    expect(session.viewGeneration).toBeGreaterThan(locked);
    expect(session.viewGeneration).toBe(session.viewGeneration);
  });

  it("starts locked with a stable frozen empty snapshot and no side effects", () => {
    const { session, store, worker } = fixture();
    expect(session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
    expect(session.state).toBe(session.state);
    expect(Object.isFrozen(session.state)).toBe(true);
    expect(Object.isFrozen(session.state.entries)).toBe(true);
    expect(store.read).not.toHaveBeenCalled();
    expect(worker.cancel).not.toHaveBeenCalled();
  });

  it("opening absent storage is empty and never creates a demo", async () => {
    const { session, store, worker } = fixture();
    const phases: string[] = [];
    session.subscribe(() => { phases.push(session.state.phase); });
    await expect(session.open()).resolves.toBeUndefined();
    expect(phases).toEqual(["busy", "empty"]);
    expect(session.state).toEqual({ phase: "empty", entries: [], errorCode: null });
    expect(worker.create).not.toHaveBeenCalled();
    expect(worker.open).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    expect(worker.cancel).toHaveBeenCalledOnce();
  });

  it("opens existing storage without creating or writing", async () => {
    const { session, store, worker } = fixture();
    const bytes = new Uint8Array([7]);
    store.read.mockResolvedValue(bytes);
    await session.open();
    expect(worker.open).toHaveBeenCalledWith(bytes);
    expect(session.state.phase).toBe("open");
    expect(worker.create).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });

  it("create first opens a preexisting archive without replacing it", async () => {
    const { session, store, worker } = fixture();
    const bytes = new Uint8Array([7]);
    store.read.mockResolvedValue(bytes);
    await session.create();
    expect(store.read).toHaveBeenCalledOnce();
    expect(worker.open).toHaveBeenCalledWith(bytes);
    expect(worker.create).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });

  it.each(["created", "exists"] as const)("rereads the authoritative archive after atomic create returns %s", async (outcome) => {
    const { session, store, worker } = fixture();
    const candidate = new Uint8Array([1]);
    const saved = new Uint8Array([9]);
    store.read.mockResolvedValueOnce(null).mockResolvedValueOnce(saved);
    store.createIfAbsent.mockResolvedValue(outcome);
    worker.create.mockResolvedValue(candidate);
    await session.create();
    expect(store.createIfAbsent).toHaveBeenCalledWith(candidate);
    expect(store.read).toHaveBeenCalledTimes(2);
    expect(worker.open).toHaveBeenCalledOnce();
    expect(worker.open).toHaveBeenCalledWith(saved);
    expect(session.state.phase).toBe("open");
  });

  it("both concurrent sessions open the winner's saved archive", async () => {
    let saved: Uint8Array | null = null;
    const store: SyntheticCiphertextStore = {
      async read() { return saved; },
      async createIfAbsent(bytes) {
        if (saved !== null) return "exists";
        saved = bytes;
        return "created";
      },
    };
    const first = fixture().worker;
    const second = fixture().worker;
    first.create.mockResolvedValue(new Uint8Array([11]));
    second.create.mockResolvedValue(new Uint8Array([22]));
    const firstSession = new SyntheticVaultSession(store, first);
    const secondSession = new SyntheticVaultSession(store, second);
    await Promise.all([firstSession.create(), secondSession.create()]);
    expect(first.create).toHaveBeenCalledOnce();
    expect(second.create).toHaveBeenCalledOnce();
    expect(first.open).toHaveBeenCalledWith(saved);
    expect(second.open).toHaveBeenCalledWith(saved);
    expect(firstSession.state.phase).toBe("open");
    expect(secondSession.state.phase).toBe("open");
  });

  it("does not fall back to a candidate if committed storage cannot be reread", async () => {
    const { session, worker } = fixture();
    await expect(session.create()).resolves.toBeUndefined();
    expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "OPERATION_FAILED" });
    expect(worker.open).not.toHaveBeenCalled();
  });

  it("snapshots and freezes only allowlisted entry and connection fields", async () => {
    const { session, store, worker } = fixture();
    store.read.mockResolvedValue(new Uint8Array([1]));
    const row = { ...entry(), unknown: "not-a-display-field" };
    worker.open.mockResolvedValue([row]);
    await session.open();
    const snapshot = session.state;
    const savedRow = snapshot.entries[0]!;
    expect(snapshot).toBe(session.state);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(savedRow)).toBe(true);
    expect(Object.isFrozen(savedRow.connections)).toBe(true);
    expect(Object.isFrozen(savedRow.connections[0])).toBe(true);
    expect(savedRow).not.toHaveProperty("unknown");
    expect(savedRow).toMatchObject({ issuerAccountIdentifier: "demo-account", issuerOrganizationOrWorkspace: null,
      issuerProject: "demo-project", issuerEnvironment: "demo" });
    row.itemName = "Changed worker-owned row";
    row.issuerAccountIdentifier = "changed-account";
    row.issuerProject = "changed-project";
    expect(savedRow.itemName).toBe("Synthetic item");
    expect(savedRow.issuerAccountIdentifier).toBe("demo-account");
    expect(savedRow.issuerProject).toBe("demo-project");
  });

  it("clears previously displayed entries immediately on each new operation", async () => {
    const { session, store } = fixture();
    store.read.mockResolvedValue(new Uint8Array([1]));
    await session.open();
    const pending = deferred<Uint8Array | null>();
    store.read.mockReturnValueOnce(pending.promise);
    const operation = session.create();
    expect(session.state).toEqual({ phase: "busy", entries: [], errorCode: null });
    session.lock();
    pending.resolve(null);
    await operation;
  });

  it.each(["initial-read", "worker-create", "commit", "authoritative-read", "worker-open"])(
    "lock during %s prevents stale display and later writes", async (stage) => {
      const { session, store, worker } = fixture();
      const blocked = deferred<unknown>();
      store.read.mockResolvedValueOnce(null).mockResolvedValue(new Uint8Array([9]));
      let value: unknown;
      if (stage === "initial-read") {
        store.read.mockReset().mockReturnValueOnce(blocked.promise as Promise<Uint8Array | null>);
        value = null;
      } else if (stage === "worker-create") {
        worker.create.mockReturnValueOnce(blocked.promise as Promise<Uint8Array>);
        value = new Uint8Array([1]);
      } else if (stage === "commit") {
        store.createIfAbsent.mockReturnValueOnce(blocked.promise as Promise<"created">);
        value = "created";
      } else if (stage === "authoritative-read") {
        store.read.mockReset().mockResolvedValueOnce(null).mockReturnValueOnce(blocked.promise as Promise<Uint8Array | null>);
        value = new Uint8Array([9]);
      } else {
        worker.open.mockReturnValueOnce(blocked.promise as Promise<readonly LocalCatalogEntryV1[]>);
        value = [entry()];
      }
      const operation = session.create();
      await flush();
      expect(session.state.phase).toBe("busy");
      const callsBeforeLock = { read: store.read.mock.calls.length, write: store.createIfAbsent.mock.calls.length };
      session.lock();
      const locked = session.state;
      blocked.resolve(value);
      await expect(operation).resolves.toBeUndefined();
      expect(session.state).toBe(locked);
      expect(session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
      expect(store.read).toHaveBeenCalledTimes(callsBeforeLock.read);
      expect(store.createIfAbsent).toHaveBeenCalledTimes(callsBeforeLock.write);
      if (stage === "initial-read" || stage === "worker-create") expect(store.createIfAbsent).not.toHaveBeenCalled();
      if (stage !== "worker-open") expect(worker.open).not.toHaveBeenCalled();
    },
  );

  it("a pending commit may complete ciphertext but cannot reopen a locked session", async () => {
    const { session, store, worker } = fixture();
    const commit = deferred<"created">();
    let persisted: Uint8Array | null = null;
    store.createIfAbsent.mockImplementation(async (bytes) => {
      await commit.promise;
      persisted = bytes;
      return "created";
    });
    const operation = session.create();
    await flush();
    session.lock();
    commit.resolve("created");
    await operation;
    expect(persisted).toEqual(new Uint8Array([1]));
    expect(session.state.phase).toBe("locked");
    expect(worker.open).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("a stale worker %s cannot overwrite newer state", async (result) => {
    const { session, store, worker } = fixture();
    const old = deferred<readonly LocalCatalogEntryV1[]>();
    store.read.mockResolvedValue(new Uint8Array([1]));
    worker.open.mockReturnValueOnce(old.promise).mockResolvedValueOnce([entry("Newest")]);
    const first = session.open();
    await flush();
    await session.open();
    const latest = session.state;
    if (result === "resolve") old.resolve([entry("Stale")]);
    else old.reject(new CatalogAdapterError("AUTHENTICATION_FAILED"));
    await expect(first).resolves.toBeUndefined();
    expect(session.state).toBe(latest);
    expect(session.state.entries[0]?.itemName).toBe("Newest");
  });

  it("a rejection after lock is ignored", async () => {
    const { session, store } = fixture();
    const read = deferred<Uint8Array | null>();
    store.read.mockReturnValueOnce(read.promise);
    const operation = session.open();
    session.lock();
    const locked = session.state;
    read.reject(new SyntheticStorageError("corrupt"));
    await expect(operation).resolves.toBeUndefined();
    expect(session.state).toBe(locked);
  });

  it.each(["corrupt", "incompatible", "quota", "blocked", "unavailable"] as const)(
    "a %s read failure preserves storage and creates no replacement", async (code) => {
      const { session, store, worker } = fixture();
      store.read.mockRejectedValue(new SyntheticStorageError(code));
      await expect(session.create()).resolves.toBeUndefined();
      expect(session.state).toEqual({ phase: "error", entries: [], errorCode: code });
      expect(store.createIfAbsent).not.toHaveBeenCalled();
      expect(worker.create).not.toHaveBeenCalled();
      expect(worker.open).not.toHaveBeenCalled();
    },
  );

  it.each(["AUTHENTICATION_FAILED", "UPGRADE_REQUIRED", "INVALID_ARCHIVE"] as const)(
    "a %s archive-open failure never rewrites saved bytes", async (code) => {
      const { session, store, worker } = fixture();
      const saved = new Uint8Array([9]);
      store.read.mockResolvedValue(saved);
      worker.open.mockRejectedValue(new CatalogAdapterError(code));
      await expect(session.create()).resolves.toBeUndefined();
      expect(session.state).toEqual({ phase: "error", entries: [], errorCode: code });
      expect(store.createIfAbsent).not.toHaveBeenCalled();
      expect(worker.create).not.toHaveBeenCalled();
      expect(saved).toEqual(new Uint8Array([9]));
    },
  );

  it("a commit failure displays no candidate entries", async () => {
    const { session, store, worker } = fixture();
    store.createIfAbsent.mockRejectedValue(new SyntheticStorageError("quota"));
    await expect(session.create()).resolves.toBeUndefined();
    expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "quota" });
    expect(store.read).toHaveBeenCalledOnce();
    expect(worker.open).not.toHaveBeenCalled();
  });

  it.each([
    new Error("private error text"), "private string", { code: "UPGRADE_REQUIRED" },
    Object.assign(new CatalogAdapterError("INVALID_ARCHIVE"), { code: "private code" }),
    Object.assign(new SyntheticStorageError("failed"), { code: "private code" }),
    Object.defineProperty(new CatalogAdapterError("INVALID_ARCHIVE"), "code", { get() { throw new Error("private getter"); } }),
  ])("reduces unknown or tampered errors to a fixed code", async (error) => {
    const { session, store } = fixture();
    store.read.mockRejectedValue(error);
    await expect(session.open()).resolves.toBeUndefined();
    expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "OPERATION_FAILED" });
  });

  it("reads an allowlisted error code only once", async () => {
    const { session, store } = fixture();
    const code = vi.fn().mockReturnValueOnce("INVALID_ARCHIVE").mockReturnValue("private second value");
    const error = Object.defineProperty(new CatalogAdapterError("INVALID_ARCHIVE"), "code", { get: code });
    store.read.mockRejectedValue(error);
    await session.open();
    expect(session.state.errorCode).toBe("INVALID_ARCHIVE");
    expect(code).toHaveBeenCalledOnce();
  });

  it("cancellation failure is normalized and lock still clears all rows", async () => {
    const { session, worker } = fixture();
    worker.cancel.mockImplementation(() => { throw new Error("private cancellation error"); });
    await expect(session.open()).resolves.toBeUndefined();
    expect(session.state.errorCode).toBe("OPERATION_FAILED");
    expect(() => session.lock()).not.toThrow();
    expect(session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
  });

  it("supports subscription teardown without affecting remaining listeners", async () => {
    const { session } = fixture();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = session.subscribe(first);
    session.subscribe(second);
    await session.open();
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    unsubscribe();
    unsubscribe();
    session.lock();
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(3);
  });

  it("subscriber exceptions cannot escape operations or prevent other notifications", async () => {
    const { session } = fixture();
    const second = vi.fn();
    session.subscribe(() => { throw new Error("private subscriber error"); });
    session.subscribe(second);
    await expect(session.open()).resolves.toBeUndefined();
    expect(session.state.phase).toBe("empty");
    expect(second).toHaveBeenCalledTimes(2);
    expect(() => session.lock()).not.toThrow();
  });

  it("a subscriber can lock during busy notification before any storage operation", async () => {
    const { session, store } = fixture();
    session.subscribe(() => { if (session.state.phase === "busy") session.lock(); });
    await session.create();
    expect(session.state.phase).toBe("locked");
    expect(store.read).not.toHaveBeenCalled();
  });

  it("a reentrant error-code accessor cannot replace the locked state", async () => {
    const { session, store } = fixture();
    const error = Object.defineProperty(new CatalogAdapterError("INVALID_ARCHIVE"), "code", {
      get() { session.lock(); return "INVALID_ARCHIVE"; },
    });
    store.read.mockRejectedValue(error);
    await session.open();
    expect(session.state.phase).toBe("locked");
  });

  it("a reentrant row accessor cannot replace the locked state", async () => {
    const { session, store, worker } = fixture();
    const row = Object.defineProperty(entry(), "itemName", {
      get() { session.lock(); return "Synthetic item"; },
    });
    store.read.mockResolvedValue(new Uint8Array([1]));
    worker.open.mockResolvedValue([row]);
    await session.open();
    expect(session.state.phase).toBe("locked");
  });
});
