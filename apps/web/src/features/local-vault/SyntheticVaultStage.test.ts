import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { CatalogAdapterError, type LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import type { LocalRotationStageV1 } from "../../bridge/rotationStageProtocol";
import { createSyntheticCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import { SyntheticVaultSession, type SyntheticRotationStageWorker } from "./SyntheticVaultSession";

const original = new Uint8Array([1, 2]);
const staged = new Uint8Array([1, 2, 3]);
const cutover = new Uint8Array([1, 2, 3, 4]);
const racer = new Uint8Array([7, 8]);
const selection = { reference: 0, mcp: "user_confirmed", cli: "pending", ci: "pending", supersededRevocation: "pending" } as const;

function rows(): readonly LocalCatalogEntryV1[] {
  return [0, 1].map((reference): LocalCatalogEntryV1 => ({
    reference, credentialType: "api_key", itemName: "Example API key", providerName: "Example service",
    issuerAccountIdentifier: null, issuerOrganizationOrWorkspace: null, issuerProject: null,
    issuerEnvironment: null, status: "active", connectionCount: 0, secretFieldCount: 1,
    mcpConnectionCount: 0, connections: [],
  }));
}

function projection(ready = false): LocalRotationStageV1 {
  return { baseGeneration: "initial_0001", targetGeneration: "rotated_0002",
    entries: [{ fixture: "mcp", requiredForCutover: true, completion: "user_confirmed" }],
    revocation: ready ? "user_confirmed" : "pending", remainingRequired: 0, remainingOptional: 0, readyForCutover: ready };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(ready = false) {
  const database = new IDBFactory();
  const store = createSyntheticCiphertextStore(database);
  await store.createIfAbsent(original);
  const worker = {
    create: vi.fn<SyntheticRotationStageWorker["create"]>(async () => original.slice()),
    open: vi.fn<SyntheticRotationStageWorker["open"]>(async () => rows()),
    cancel: vi.fn(),
    inspectRotationStage: vi.fn<SyntheticRotationStageWorker["inspectRotationStage"]>(async () => projection(ready)),
    saveRotationStage: vi.fn<SyntheticRotationStageWorker["saveRotationStage"]>(async () => staged.slice()),
    createRotationCutoverFromStage: vi.fn<SyntheticRotationStageWorker["createRotationCutoverFromStage"]>(async () => cutover.slice()),
  };
  const session = new SyntheticVaultSession(store, worker);
  await session.open();
  return { database, store, worker, session };
}

describe("durable rotation session with mock crypto and real fake-IDB transactions", () => {
  it("authenticates before and after CAS and restores a partial receipt in a fresh session", async () => {
    const f = await fixture();
    await f.session.saveRotationStage(f.session.viewGeneration, selection);
    expect(f.session.state.phase).toBe("open");
    expect(await f.store.read()).toEqual(staged);
    expect(f.worker.open).toHaveBeenCalledTimes(3);
    f.session.lock();
    const next = new SyntheticVaultSession(createSyntheticCiphertextStore(f.database), f.worker);
    await next.open();
    const receipt = await next.inspectRotationStage(next.viewGeneration, 0);
    expect(receipt?.stage).toEqual(projection());
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt?.stage?.entries)).toBe(true);
    await next.commitRotationCutoverFromStage(next.viewGeneration, receipt!.reviewVersion);
    expect(f.worker.createRotationCutoverFromStage).not.toHaveBeenCalled();
    expect(await f.store.read()).toEqual(staged);
  });

  it("commits only a ready reviewed saved snapshot and rejects duplicate or stale consent", async () => {
    const f = await fixture(true);
    const generation = f.session.viewGeneration;
    const receipt = await f.session.inspectRotationStage(generation, 0);
    await f.session.commitRotationCutoverFromStage(generation, receipt!.reviewVersion - 1);
    expect(f.worker.createRotationCutoverFromStage).not.toHaveBeenCalled();
    await f.session.commitRotationCutoverFromStage(generation, receipt!.reviewVersion);
    await f.session.commitRotationCutoverFromStage(generation, receipt!.reviewVersion);
    expect(f.worker.createRotationCutoverFromStage).toHaveBeenCalledTimes(1);
    expect(await f.store.read()).toEqual(cutover);
    expect(f.session.rotationStageReviewState.phase).toBe("idle");
  });

  it("distinguishes absent progress from an invalid authenticated projection", async () => {
    const f = await fixture();
    f.worker.inspectRotationStage.mockResolvedValueOnce(null);
    const receipt = await f.session.inspectRotationStage(f.session.viewGeneration, 0);
    expect(receipt?.stage).toBeNull();
    expect(f.session.rotationStageReviewState.phase).toBe("ready");
    f.worker.inspectRotationStage.mockResolvedValueOnce({ ...projection(), readyForCutover: true });
    expect(await f.session.inspectRotationStage(f.session.viewGeneration, 0)).toBeNull();
    expect(f.session.rotationStageReviewState.errorCode).toBe("INVALID_CATALOG");
    expect(await f.store.read()).toEqual(original);
  });

  it("preserves a losing stage in the conflict outbox and never retries or replaces the winner", async () => {
    const f = await fixture();
    expect(await f.store.compareAndSwapArchive(original, racer)).toBe("updated");
    await f.session.saveRotationStage(f.session.viewGeneration, selection);
    expect(f.session.state.errorCode).toBe("STORAGE_CONFLICT_PRESERVED");
    expect(await f.store.read()).toEqual(racer);
    expect((await f.store.listConflictArchives()).map((item) => item.bytes)).toEqual([staged]);
    expect(f.worker.saveRotationStage).toHaveBeenCalledTimes(1);
  });

  it("rejects a candidate before storage if complete-archive authentication fails", async () => {
    const f = await fixture();
    f.worker.open.mockRejectedValueOnce(new CatalogAdapterError("AUTHENTICATION_FAILED"));
    await f.session.saveRotationStage(f.session.viewGeneration, selection);
    expect(f.session.state.errorCode).toBe("AUTHENTICATION_FAILED");
    expect(await f.store.read()).toEqual(original);
    expect(await f.store.listConflictArchives()).toEqual([]);
  });

  it.each(["save", "finalize"] as const)("capacity rejection on %s never starts CAS, retries, or changes saved bytes", async (operation) => {
    const f = await fixture(true);
    const cas = vi.spyOn(f.store, "compareAndSwapArchivePreservingConflict");
    const generation = f.session.viewGeneration;
    if (operation === "save") {
      f.worker.saveRotationStage.mockRejectedValueOnce(new CatalogAdapterError("LIMITS_EXCEEDED"));
      await f.session.saveRotationStage(generation, selection);
      expect(f.worker.saveRotationStage).toHaveBeenCalledTimes(1);
    } else {
      const receipt = await f.session.inspectRotationStage(generation, 0);
      f.worker.createRotationCutoverFromStage.mockRejectedValueOnce(new CatalogAdapterError("LIMITS_EXCEEDED"));
      await f.session.commitRotationCutoverFromStage(generation, receipt!.reviewVersion);
      expect(f.worker.createRotationCutoverFromStage).toHaveBeenCalledTimes(1);
    }
    expect(f.session.state.phase).toBe("error");
    expect(f.session.state.errorCode).toBe("LIMITS_EXCEEDED");
    expect(cas).not.toHaveBeenCalled();
    expect(await f.store.read()).toEqual(original);
    expect(await f.store.listConflictArchives()).toEqual([]);
    await f.session.open();
    expect(f.session.state.phase).toBe("open");
    const restored = await f.session.inspectRotationStage(f.session.viewGeneration, 0);
    expect(restored?.stage).toEqual(projection(true));
    expect(await f.store.read()).toEqual(original);
    expect(cas).not.toHaveBeenCalled();
  });

  it("locking during candidate creation wipes late ciphertext and never writes or reopens", async () => {
    const f = await fixture();
    const pending = deferred<Uint8Array>();
    f.worker.saveRotationStage.mockReturnValueOnce(pending.promise);
    const action = f.session.saveRotationStage(f.session.viewGeneration, selection);
    f.session.lock();
    const late = staged.slice();
    pending.resolve(late);
    await action;
    expect(late).toEqual(new Uint8Array(staged.length));
    expect(f.session.state.phase).toBe("locked");
    expect(await f.store.read()).toEqual(original);
  });

  it("post-CAS displacement preserves the candidate and does not publish a successful stage", async () => {
    const f = await fixture();
    const originalCas = f.store.compareAndSwapArchivePreservingConflict.bind(f.store);
    const store = { ...f.store, compareAndSwapArchivePreservingConflict: async (before: Uint8Array, next: Uint8Array) => {
      const result = await originalCas(before, next);
      await f.store.compareAndSwapArchive(next, racer);
      return result;
    } };
    const session = new SyntheticVaultSession(store, f.worker);
    await session.open();
    await session.saveRotationStage(session.viewGeneration, selection);
    expect(session.state.errorCode).toBe("STORAGE_CONFLICT_PRESERVED");
    expect(await f.store.read()).toEqual(racer);
    expect((await f.store.listConflictArchives()).map((item) => item.bytes)).toEqual([staged]);
  });

  it("selection inspection reentry cannot write after locking", async () => {
    const f = await fixture();
    const hostile = new Proxy(selection, { ownKeys(target) { f.session.lock(); return Reflect.ownKeys(target); } });
    await f.session.saveRotationStage(f.session.viewGeneration, hostile);
    expect(f.worker.saveRotationStage).not.toHaveBeenCalled();
    expect(await f.store.read()).toEqual(original);
    expect(f.session.state.phase).toBe("locked");
  });

  it("selection parsing cannot start a stage write while a reviewed conflict deletion begins", async () => {
    const f = await fixture();
    await f.store.compareAndSwapArchivePreservingConflict(racer, staged);
    const deleting = deferred<"deleted">();
    const remove = vi.fn(async () => deleting.promise);
    const store = { ...f.store, deleteConflictArchiveIfEqual: remove };
    const session = new SyntheticVaultSession(store, f.worker);
    await session.open();
    await session.loadConflictReviews(session.viewGeneration);
    const version = session.conflictReviewState.reviewVersion;
    session.requestConflictDiscard(version, 0);
    let action: Promise<void> | undefined;
    const input = new Proxy(selection, { ownKeys(target) {
      action = session.confirmConflictDiscard(version, 0);
      return Reflect.ownKeys(target);
    } });
    await session.saveRotationStage(session.viewGeneration, input);
    expect(session.conflictReviewState.phase).toBe("discarding");
    expect(remove).toHaveBeenCalledOnce();
    expect(f.worker.saveRotationStage).not.toHaveBeenCalled();
    expect(await f.store.read()).toEqual(original);
    deleting.resolve("deleted");
    await action;
  });

  it("a final ready notification that starts another review revokes the first receipt", async () => {
    const f = await fixture(true);
    const generation = f.session.viewGeneration;
    let redirected = false;
    let next: ReturnType<SyntheticVaultSession["inspectRotationStage"]> | undefined;
    const unsubscribe = f.session.subscribe(() => {
      if (!redirected && f.session.rotationStageReviewState.phase === "ready") {
        redirected = true;
        next = f.session.inspectRotationStage(generation, 1);
      }
    });
    const first = await f.session.inspectRotationStage(generation, 0);
    expect(first).toBeNull();
    const second = await next;
    expect(second?.reference).toBe(1);
    unsubscribe();
    f.session.lock();
    expect(f.session.rotationStageReviewState.stage).toBeNull();
    expect(await f.store.read()).toEqual(original);
  });
});
