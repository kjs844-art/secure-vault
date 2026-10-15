import { describe, expect, it, vi } from "vitest";
import { CatalogAdapterError, type LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import {
  MAX_SYNTHETIC_CONFLICT_ARCHIVES,
  SyntheticStorageError,
  type SyntheticCiphertextStore,
  type SyntheticConflictArchive,
  type SyntheticConflictCiphertextStore,
} from "../../storage/SyntheticCiphertextStore";
import { SyntheticVaultSession, type SyntheticVaultWorker } from "./SyntheticVaultSession";

function conflictId(value: number): string { return value.toString(16).padStart(32, "0"); }

function rows(itemName: string): readonly LocalCatalogEntryV1[] {
  return [{
    reference: 0, itemName, providerName: "Synthetic provider", credentialType: "api_key",
    issuerAccountIdentifier: "demo-account", issuerOrganizationOrWorkspace: null,
    issuerProject: "demo-project", issuerEnvironment: "demo", status: "active",
    connectionCount: 0, secretFieldCount: 1, mcpConnectionCount: 0, connections: [],
  }];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flush() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }

function fixture(initial: readonly SyntheticConflictArchive[] = [
  { conflictId: conflictId(1), bytes: new Uint8Array([2]) },
]) {
  const listConflictArchives = vi.fn<SyntheticConflictCiphertextStore["listConflictArchives"]>(async () =>
    initial.map((conflict) => Object.freeze({
      conflictId: conflict.conflictId, bytes: new Uint8Array(conflict.bytes),
    })));
  const deleteConflictArchiveIfEqual = vi.fn<SyntheticConflictCiphertextStore["deleteConflictArchiveIfEqual"]>()
    .mockResolvedValue("deleted");
  const store = {
    read: vi.fn<SyntheticCiphertextStore["read"]>().mockResolvedValue(new Uint8Array([1])),
    createIfAbsent: vi.fn<SyntheticCiphertextStore["createIfAbsent"]>().mockResolvedValue("exists"),
    listConflictArchives,
    deleteConflictArchiveIfEqual,
  };
  const worker = {
    create: vi.fn<SyntheticVaultWorker["create"]>().mockResolvedValue(new Uint8Array([1])),
    open: vi.fn<SyntheticVaultWorker["open"]>(async (bytes) => rows(`archive-${bytes[0]}`)),
    cancel: vi.fn<SyntheticVaultWorker["cancel"]>(),
  };
  return {
    store, worker, listConflictArchives, deleteConflictArchiveIfEqual,
    session: new SyntheticVaultSession(store, worker),
  };
}

async function openFixture(value = fixture()) {
  await value.session.open();
  expect(value.session.state.phase).toBe("open");
  value.worker.open.mockClear();
  value.worker.cancel.mockClear();
  return value;
}

describe("synthetic conflict review session", () => {
  it("starts with a stable frozen empty review and no storage access", () => {
    const { session, listConflictArchives } = fixture();
    expect(session.conflictReviewState).toEqual({
      phase: "idle", reviewVersion: 0, items: [], pendingReference: null, errorCode: null,
    });
    expect(Object.isFrozen(session.conflictReviewState)).toBe(true);
    expect(Object.isFrozen(session.conflictReviewState.items)).toBe(true);
    expect(listConflictArchives).not.toHaveBeenCalled();
  });

  it("does nothing while locked or for a stale vault generation", async () => {
    const f = fixture();
    await f.session.loadConflictReviews(f.session.viewGeneration);
    expect(f.listConflictArchives).not.toHaveBeenCalled();
    await f.session.open();
    await f.session.loadConflictReviews(f.session.viewGeneration - 1);
    expect(f.listConflictArchives).not.toHaveBeenCalled();
  });

  it("publishes only positional references and authenticated catalog projections", async () => {
    const f = await openFixture(fixture([
      { conflictId: conflictId(7), bytes: new Uint8Array([2]) },
      { conflictId: conflictId(8), bytes: new Uint8Array([3]) },
    ]));
    await f.session.loadConflictReviews(f.session.viewGeneration);
    expect(f.session.conflictReviewState.phase).toBe("ready");
    expect(f.session.conflictReviewState.items.map((item) => ({
      reference: item.reference, name: item.entries[0]?.itemName,
    }))).toEqual([
      { reference: 0, name: "archive-2" },
      { reference: 1, name: "archive-3" },
    ]);
    expect(f.worker.open).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.session.conflictReviewState)).not.toContain(conflictId(7));
    expect(JSON.stringify(f.session.conflictReviewState)).not.toContain(conflictId(8));
    expect(Object.keys(f.session.conflictReviewState.items[0]!)).toEqual(["reference", "entries"]);
  });

  it("authenticates every candidate before publishing any item", async () => {
    const f = await openFixture(fixture([
      { conflictId: conflictId(1), bytes: new Uint8Array([2]) },
      { conflictId: conflictId(2), bytes: new Uint8Array([3]) },
    ]));
    const second = deferred<readonly LocalCatalogEntryV1[]>();
    f.worker.open.mockResolvedValueOnce(rows("first")).mockReturnValueOnce(second.promise);
    const pending = f.session.loadConflictReviews(f.session.viewGeneration);
    await flush();
    expect(f.session.conflictReviewState).toMatchObject({ phase: "loading", items: [] });
    second.resolve(rows("second"));
    await pending;
    expect(f.session.conflictReviewState.items.map((item) => item.entries[0]?.itemName))
      .toEqual(["first", "second"]);
  });

  it("publishes no partial catalog when any candidate authentication fails", async () => {
    const f = await openFixture(fixture([
      { conflictId: conflictId(1), bytes: new Uint8Array([2]) },
      { conflictId: conflictId(2), bytes: new Uint8Array([3]) },
    ]));
    f.worker.open.mockResolvedValueOnce(rows("first"))
      .mockRejectedValueOnce(new CatalogAdapterError("INVALID_ARCHIVE"));
    await f.session.loadConflictReviews(f.session.viewGeneration);
    expect(f.session.conflictReviewState).toMatchObject({
      phase: "error", items: [], pendingReference: null, errorCode: "INVALID_ARCHIVE",
    });
    expect(f.deleteConflictArchiveIfEqual).not.toHaveBeenCalled();
  });

  it("accepts an empty list without starting a worker", async () => {
    const f = await openFixture(fixture([]));
    await f.session.loadConflictReviews(f.session.viewGeneration);
    expect(f.session.conflictReviewState).toMatchObject({ phase: "ready", items: [] });
    expect(f.worker.open).not.toHaveBeenCalled();
  });

  it.each([
    ["over limit", Array.from({ length: MAX_SYNTHETIC_CONFLICT_ARCHIVES + 1 }, (_, index) => ({
      conflictId: conflictId(index + 1), bytes: new Uint8Array([index + 2]),
    }))],
    ["duplicate ID", [
      { conflictId: conflictId(1), bytes: new Uint8Array([2]) },
      { conflictId: conflictId(1), bytes: new Uint8Array([3]) },
    ]],
    ["invalid ID", [{ conflictId: "ABC", bytes: new Uint8Array([2]) }]],
    ["invalid bytes", [{ conflictId: conflictId(1), bytes: new Uint8Array() }]],
  ])("rejects a %s list before publishing or deleting", async (_name, value) => {
    const f = await openFixture();
    f.listConflictArchives.mockResolvedValueOnce(value as readonly SyntheticConflictArchive[]);
    await f.session.loadConflictReviews(f.session.viewGeneration);
    expect(f.session.conflictReviewState).toMatchObject({
      phase: "error", items: [], errorCode: "corrupt",
    });
    expect(f.worker.open).not.toHaveBeenCalled();
    expect(f.deleteConflictArchiveIfEqual).not.toHaveBeenCalled();
  });

  it("requires both explicit discard steps and uses the exact private byte snapshot", async () => {
    const source = { conflictId: conflictId(5), bytes: new Uint8Array([2, 3, 4]) };
    const f = await openFixture();
    f.listConflictArchives.mockResolvedValueOnce([source]);
    let observed: { id: string; bytes: Uint8Array } | undefined;
    f.deleteConflictArchiveIfEqual.mockImplementationOnce(async (id, bytes) => {
      observed = { id, bytes: new Uint8Array(bytes) };
      return "deleted";
    });
    await f.session.loadConflictReviews(f.session.viewGeneration);
    const version = f.session.conflictReviewState.reviewVersion;
    source.bytes.fill(9);

    await f.session.confirmConflictDiscard(version, 0);
    expect(f.deleteConflictArchiveIfEqual).not.toHaveBeenCalled();
    f.session.requestConflictDiscard(version, 0);
    expect(f.session.conflictReviewState.phase).toBe("confirm-discard");
    expect(f.deleteConflictArchiveIfEqual).not.toHaveBeenCalled();
    await f.session.confirmConflictDiscard(version, 0);

    expect(observed).toEqual({ id: conflictId(5), bytes: new Uint8Array([2, 3, 4]) });
    expect(f.session.conflictReviewState).toMatchObject({
      phase: "discarded", items: [], pendingReference: null, errorCode: null,
    });
    expect(f.listConflictArchives).toHaveBeenCalledOnce();
    expect(f.session.state.phase).toBe("open");
  });

  it("cancel and stale references never call delete", async () => {
    const f = await openFixture();
    await f.session.loadConflictReviews(f.session.viewGeneration);
    const version = f.session.conflictReviewState.reviewVersion;
    f.session.requestConflictDiscard(version - 1, 0);
    expect(f.session.conflictReviewState.phase).toBe("ready");
    f.session.requestConflictDiscard(version, 0);
    await f.session.confirmConflictDiscard(version, 1);
    await f.session.confirmConflictDiscard(version - 1, 0);
    expect(f.deleteConflictArchiveIfEqual).not.toHaveBeenCalled();
    f.session.cancelConflictDiscard(version);
    expect(f.session.conflictReviewState.phase).toBe("ready");
    expect(f.deleteConflictArchiveIfEqual).not.toHaveBeenCalled();
  });

  it.each(["changed", "missing"] as const)("treats %s as stale without relisting or changing the current view", async (result) => {
    const f = await openFixture();
    f.deleteConflictArchiveIfEqual.mockResolvedValueOnce(result);
    await f.session.loadConflictReviews(f.session.viewGeneration);
    const version = f.session.conflictReviewState.reviewVersion;
    f.session.requestConflictDiscard(version, 0);
    await f.session.confirmConflictDiscard(version, 0);
    expect(f.session.conflictReviewState).toMatchObject({
      phase: "error", items: [], errorCode: "CONFLICT_REVIEW_STALE",
    });
    expect(f.listConflictArchives).toHaveBeenCalledOnce();
    expect(f.store.read).toHaveBeenCalledOnce();
    expect(f.session.state.phase).toBe("open");
  });

  it.each([
    [new SyntheticStorageError("quota"), "quota"],
    [new Error("private diagnostic"), "OPERATION_FAILED"],
  ])("normalizes delete failure without automatic retry", async (failure, code) => {
    const f = await openFixture();
    f.deleteConflictArchiveIfEqual.mockRejectedValueOnce(failure);
    await f.session.loadConflictReviews(f.session.viewGeneration);
    const version = f.session.conflictReviewState.reviewVersion;
    f.session.requestConflictDiscard(version, 0);
    await f.session.confirmConflictDiscard(version, 0);
    expect(f.session.conflictReviewState).toMatchObject({ phase: "error", items: [], errorCode: code });
    expect(f.deleteConflictArchiveIfEqual).toHaveBeenCalledOnce();
    expect(f.listConflictArchives).toHaveBeenCalledOnce();
    expect(f.store.read).toHaveBeenCalledOnce();
  });

  it("reports an unavailable review capability without reading candidates", async () => {
    const store = {
      read: vi.fn().mockResolvedValue(new Uint8Array([1])),
      createIfAbsent: vi.fn().mockResolvedValue("exists" as const),
    };
    const worker = {
      create: vi.fn().mockResolvedValue(new Uint8Array([1])),
      open: vi.fn().mockResolvedValue(rows("current")),
      cancel: vi.fn(),
    };
    const session = new SyntheticVaultSession(store, worker);
    await session.open();
    worker.open.mockClear();
    await session.loadConflictReviews(session.viewGeneration);
    expect(session.conflictReviewState).toMatchObject({
      phase: "error", items: [], errorCode: "CONFLICT_REVIEW_UNAVAILABLE",
    });
    expect(worker.open).not.toHaveBeenCalled();
  });

  it("lock during list prevents late authentication and publication", async () => {
    const f = await openFixture();
    const gate = deferred<readonly SyntheticConflictArchive[]>();
    f.listConflictArchives.mockReturnValueOnce(gate.promise);
    const pending = f.session.loadConflictReviews(f.session.viewGeneration);
    await flush();
    f.session.lock();
    gate.resolve([{ conflictId: conflictId(1), bytes: new Uint8Array([2]) }]);
    await pending;
    expect(f.session.state.phase).toBe("locked");
    expect(f.session.conflictReviewState).toMatchObject({ phase: "idle", items: [] });
    expect(f.worker.open).not.toHaveBeenCalled();
  });

  it("lock during candidate authentication prevents late plaintext publication", async () => {
    const f = await openFixture();
    const gate = deferred<readonly LocalCatalogEntryV1[]>();
    f.worker.open.mockReturnValueOnce(gate.promise);
    const pending = f.session.loadConflictReviews(f.session.viewGeneration);
    await flush();
    f.session.lock();
    gate.resolve(rows("late plaintext"));
    await pending;
    expect(f.session.state.phase).toBe("locked");
    expect(f.session.conflictReviewState).toMatchObject({ phase: "idle", items: [] });
    expect(JSON.stringify(f.session.conflictReviewState)).not.toContain("late plaintext");
  });

  it("lock during an explicitly confirmed delete prevents stale UI publication", async () => {
    const f = await openFixture();
    const gate = deferred<"deleted" | "missing" | "changed">();
    f.deleteConflictArchiveIfEqual.mockReturnValueOnce(gate.promise);
    await f.session.loadConflictReviews(f.session.viewGeneration);
    const version = f.session.conflictReviewState.reviewVersion;
    f.session.requestConflictDiscard(version, 0);
    const pending = f.session.confirmConflictDiscard(version, 0);
    await flush();
    f.session.lock();
    gate.resolve("deleted");
    await pending;
    expect(f.session.state.phase).toBe("locked");
    expect(f.session.conflictReviewState).toMatchObject({ phase: "idle", items: [] });
  });

  it("every new vault operation invalidates prior review references", async () => {
    const f = await openFixture();
    await f.session.loadConflictReviews(f.session.viewGeneration);
    const firstVersion = f.session.conflictReviewState.reviewVersion;
    await f.session.open();
    expect(f.session.conflictReviewState.phase).toBe("idle");
    expect(f.session.conflictReviewState.reviewVersion).toBeGreaterThan(firstVersion);

    await f.session.loadConflictReviews(f.session.viewGeneration);
    const secondVersion = f.session.conflictReviewState.reviewVersion;
    await f.session.register(null);
    expect(f.session.conflictReviewState.phase).toBe("idle");
    expect(f.session.conflictReviewState.reviewVersion).toBeGreaterThan(secondVersion);

    await f.session.open();
    await f.session.loadConflictReviews(f.session.viewGeneration);
    const thirdVersion = f.session.conflictReviewState.reviewVersion;
    await f.session.editConnections(f.session.viewGeneration, null);
    expect(f.session.conflictReviewState.phase).toBe("idle");
    expect(f.session.conflictReviewState.reviewVersion).toBeGreaterThan(thirdVersion);
  });
});
