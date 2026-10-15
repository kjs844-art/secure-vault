import { describe, expect, it, vi } from "vitest";
import { CatalogAdapterError, type LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import {
  SyntheticStorageError,
  type SyntheticConflictCiphertextStore,
  type SyntheticMutableCiphertextStore,
} from "../../storage/SyntheticCiphertextStore";
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
  let saved: Uint8Array | null = oldBytes.slice();
  const appendInputs: Array<{ bytes: Uint8Array; selection: ReturnType<typeof selection> }> = [];
  const openInputs: Uint8Array[] = [];
  const casInputs: Array<{ before: Uint8Array; next: Uint8Array }> = [];
  const store = {
    read: vi.fn<SyntheticMutableCiphertextStore["read"]>(async () => saved?.slice() ?? null),
    createIfAbsent: vi.fn<SyntheticMutableCiphertextStore["createIfAbsent"]>(),
    compareAndSwapArchive: vi.fn<SyntheticMutableCiphertextStore["compareAndSwapArchive"]>(async (before, next) => {
      casInputs.push({ before: before.slice(), next: next.slice() });
      if (saved === null) return "missing";
      if (before.length !== saved.length || before.some((v, i) => v !== saved![i])) return "conflict";
      saved = new Uint8Array(next);
      return "updated";
    }),
  };
  const worker = {
    create: vi.fn<SyntheticRegistrationWorker["create"]>(),
    open: vi.fn<SyntheticRegistrationWorker["open"]>(async (bytes) => {
      openInputs.push(bytes.slice());
      return rows(bytes.length === 1 ? "old" : "saved");
    }),
    append: vi.fn<SyntheticRegistrationWorker["append"]>(async (bytes, selected) => {
      appendInputs.push({ bytes: bytes.slice(), selection: { ...selected, connectionIds: [...selected.connectionIds] } });
      return newBytes.slice();
    }),
    cancel: vi.fn(),
  };
  return {
    store,
    worker,
    session: new SyntheticVaultSession(store, worker),
    saved: () => saved,
    replace: (bytes: Uint8Array | null) => { saved = bytes?.slice() ?? null; },
    appendInputs,
    openInputs,
    casInputs,
  };
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
      base.replace(next);
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
  return {
    ...base,
    store,
    preservingCas,
    preserveAfterReadback,
    session: new SyntheticVaultSession(store, base.worker),
  };
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
    const { session, store, worker, appendInputs, openInputs, casInputs } = fixture();
    await session.open();
    const generation = session.viewGeneration;
    const phases: string[] = [];
    session.subscribe(() => { phases.push(session.state.phase); });
    const promise = session.register(selection());
    expect(session.state.entries).toEqual([]);
    await promise;
    expect(phases).toEqual(["busy", "open"]);
    expect(session.viewGeneration).toBeGreaterThan(generation);
    expect(appendInputs).toEqual([{ bytes: oldBytes, selection: selection() }]);
    expect(casInputs).toEqual([{ before: oldBytes, next: newBytes }]);
    expect(openInputs).toEqual([oldBytes, newBytes, newBytes]);
    expect(worker.open).toHaveBeenCalledTimes(3);
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
    gate.resolve(newBytes.slice());
    await pending;
    expect(session.state.phase).toBe("open");
  });
  it("snapshots selection before async storage reads", async () => {
    const { session, store, appendInputs } = fixture();
    await session.open();
    const gate = deferred<Uint8Array | null>();
    store.read.mockReturnValueOnce(gate.promise);
    const input = selection();
    const pending = session.register(input);
    input.profileId = 0;
    input.connectionIds.push(1);
    gate.resolve(oldBytes.slice());
    await pending;
    expect(appendInputs).toEqual([{ bytes: oldBytes, selection: selection() }]);
  });
  it.each(["conflict", "missing"] as const)("legacy store keeps %s without retrying or showing a candidate", async (outcome) => {
    const { session, store, worker } = fixture();
    await session.open();
    store.compareAndSwapArchive.mockResolvedValue(outcome);
    await session.register(selection());
    expect(session.state).toEqual({ phase: "error", entries: [], errorCode: outcome === "missing" ? "STORAGE_MISSING" : "STORAGE_CONFLICT" });
    expect(worker.open).toHaveBeenCalledTimes(2);
    expect(store.compareAndSwapArchive).toHaveBeenCalledOnce();
  });
  it.each(["read", "append", "candidate-auth", "commit", "reread", "reopen"])("failures at %s never publish candidate rows or reset data", async (stage) => {
    const { session, store, worker } = fixture();
    await session.open();
    const error = new Error("private details");
    if (stage === "read") store.read.mockRejectedValueOnce(error);
    if (stage === "append") worker.append.mockRejectedValueOnce(error);
    if (stage === "candidate-auth") worker.open.mockRejectedValueOnce(error);
    if (stage === "commit") store.compareAndSwapArchive.mockRejectedValueOnce(error);
    if (stage === "reread") store.read.mockResolvedValueOnce(oldBytes.slice()).mockRejectedValueOnce(error);
    if (stage === "reopen") {
      worker.open.mockResolvedValueOnce(rows("candidate-auth")).mockRejectedValueOnce(error);
    }
    await session.register(selection());
    expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "OPERATION_FAILED" });
    expect(store.createIfAbsent).not.toHaveBeenCalled();
    if (stage === "read" || stage === "append" || stage === "candidate-auth") {
      expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
    }
  });
  it.each([null, new Uint8Array([9])])("does not use candidate as fallback when saved readback is %j", async (readback) => {
    const { session, store, worker } = fixture();
    await session.open();
    store.read.mockResolvedValueOnce(oldBytes.slice()).mockResolvedValueOnce(readback?.slice() ?? null);
    await session.register(selection());
    expect(session.state.errorCode).toBe(readback === null ? "STORAGE_MISSING" : "STORAGE_CONFLICT");
    expect(session.state.entries).toEqual([]);
    expect(worker.open).toHaveBeenCalledTimes(2);
  });
  it.each(["read", "append", "candidate-auth", "commit", "reread", "reopen"])("lock during %s prevents every late UI publication", async (stage) => {
    const { session, store, worker } = fixture();
    await session.open();
    const gate = deferred<never>();
    if (stage === "read") store.read.mockReturnValueOnce(gate.promise);
    if (stage === "append") worker.append.mockReturnValueOnce(gate.promise);
    if (stage === "candidate-auth") worker.open.mockReturnValueOnce(gate.promise);
    if (stage === "commit") store.compareAndSwapArchive.mockReturnValueOnce(gate.promise);
    if (stage === "reread") store.read.mockResolvedValueOnce(oldBytes.slice()).mockReturnValueOnce(gate.promise);
    if (stage === "reopen") {
      worker.open.mockResolvedValueOnce(rows("candidate-auth")).mockReturnValueOnce(gate.promise);
    }
    const pending = session.register(selection());
    await flush();
    // Prove the requested stage was entered before applying the lock.
    expect(store.read).toHaveBeenCalledTimes(stage === "reread" || stage === "reopen" ? 3 : 2);
    expect(worker.append).toHaveBeenCalledTimes(stage === "read" ? 0 : 1);
    expect(store.compareAndSwapArchive).toHaveBeenCalledTimes(
      stage === "read" || stage === "append" || stage === "candidate-auth" ? 0 : 1,
    );
    expect(worker.open).toHaveBeenCalledTimes(
      stage === "read" || stage === "append" ? 1 : stage === "reopen" ? 3 : 2,
    );
    session.lock();
    const value = stage === "read" ? oldBytes.slice()
      : stage === "candidate-auth" || stage === "reopen" ? rows("late")
        : stage === "commit" ? "updated" : newBytes.slice();
    gate.resolve(value as never);
    await pending;
    expect(session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
    if (stage === "read" || stage === "append" || stage === "candidate-auth") {
      expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
    }
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
    gate.resolve(oldBytes.slice());
    await pending;
    expect(worker.append.mock.calls[0]?.[1]).toEqual({ profileId: 2, credentialId, connectionIds: [] });
    expect(session.state.phase).toBe("open");
  });

  it.each([1, 2])("keeps stored bytes and clears candidate views when Password form %i loses CAS", async (credentialId) => {
    const { session, store, worker, saved } = fixture();
    await session.open();
    store.compareAndSwapArchive.mockResolvedValueOnce("conflict");
    await session.register({ profileId: 2, credentialId, connectionIds: [] });
    expect(worker.append).toHaveBeenCalledOnce();
    expect(store.compareAndSwapArchive).toHaveBeenCalledOnce();
    expect(worker.open).toHaveBeenCalledTimes(2);
    expect(saved()).toEqual(oldBytes);
    expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "STORAGE_CONFLICT" });
    expect(worker.create).not.toHaveBeenCalled();
    expect(store.createIfAbsent).not.toHaveBeenCalled();
  });

  describe("atomic conflict-preserving registration store capability", () => {
    it("authenticates the candidate before CAS and skips the pre-CAS storage read", async () => {
      const fixture = preservingFixture();
      await fixture.session.open();
      fixture.store.read.mockClear();
      fixture.worker.open.mockClear();
      fixture.worker.append.mockClear();
      fixture.store.compareAndSwapArchive.mockClear();
      const events: string[] = [];
      fixture.worker.append.mockImplementationOnce(async (bytes, selected) => {
        events.push("append");
        expect(bytes).toEqual(oldBytes);
        expect(selected).toEqual(selection());
        return newBytes.slice();
      });
      fixture.worker.open
        .mockImplementationOnce(async (bytes) => {
          events.push("candidate-auth");
          expect(bytes).toEqual(newBytes);
          bytes.fill(9);
          return rows("uncommitted");
        })
        .mockImplementationOnce(async (bytes) => {
          events.push("saved-auth");
          expect(bytes).toEqual(newBytes);
          return rows("saved");
        });
      fixture.preservingCas.mockImplementationOnce(async (before, next) => {
        events.push("atomic-cas");
        expect(before).toEqual(oldBytes);
        expect(next).toEqual(newBytes);
        before.fill(7);
        next.fill(8);
        fixture.replace(newBytes);
        return { kind: "updated" };
      });
      fixture.store.read.mockImplementationOnce(async () => {
        events.push("readback");
        return fixture.saved()?.slice() ?? null;
      });

      await fixture.session.register(selection());

      expect(events).toEqual(["append", "candidate-auth", "atomic-cas", "readback", "saved-auth"]);
      expect(fixture.store.read).toHaveBeenCalledOnce();
      expect(fixture.worker.open).toHaveBeenCalledTimes(2);
      expect(fixture.store.compareAndSwapArchive).not.toHaveBeenCalled();
      expect(fixture.session.state).toMatchObject({ phase: "open", errorCode: null });
      expect(fixture.session.state.entries[0]!.itemName).toBe("saved");
      expect(fixture.session.state.entries[0]!.itemName).not.toBe("uncommitted");
    });

    it("performs zero storage writes when candidate authentication fails", async () => {
      const { session, store, worker, preservingCas, preserveAfterReadback, saved } = preservingFixture();
      await session.open();
      worker.open.mockRejectedValueOnce(new CatalogAdapterError("AUTHENTICATION_FAILED"));

      await session.register(selection());

      expect(session.state).toEqual({
        phase: "error", entries: [], errorCode: "AUTHENTICATION_FAILED",
      });
      expect(preservingCas).not.toHaveBeenCalled();
      expect(preserveAfterReadback).not.toHaveBeenCalled();
      expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
      expect(store.read).toHaveBeenCalledOnce();
      expect(saved()).toEqual(oldBytes);
    });

    it("reports an atomic CAS loser as durably conflict-preserved", async () => {
      const { session, store, worker, preservingCas, preserveAfterReadback, saved } = preservingFixture();
      await session.open();
      preservingCas.mockResolvedValueOnce({
        kind: "conflict-preserved", conflictId: "a".repeat(32),
      });

      await session.register(selection());

      expect(session.state).toEqual({
        phase: "error", entries: [], errorCode: "STORAGE_CONFLICT_PRESERVED",
      });
      expect(saved()).toEqual(oldBytes);
      expect(store.read).toHaveBeenCalledOnce();
      expect(worker.open).toHaveBeenCalledTimes(2);
      expect(preserveAfterReadback).not.toHaveBeenCalled();
      expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
    });

    it("preserves the exact candidate after post-CAS displacement", async () => {
      const { session, store, preservingCas, preserveAfterReadback, replace, saved } = preservingFixture();
      await session.open();
      preservingCas.mockImplementationOnce(async (before, next) => {
        expect(before).toEqual(oldBytes);
        expect(next).toEqual(newBytes);
        replace(newBytes);
        next.fill(8);
        replace(new Uint8Array([1, 3]));
        return { kind: "updated" };
      });
      preserveAfterReadback.mockImplementationOnce(async (candidate) => {
        expect(candidate).toEqual(newBytes);
        candidate.fill(7);
        return { kind: "conflict-preserved", conflictId: "b".repeat(32) };
      });

      await session.register(selection());

      expect(session.state).toEqual({
        phase: "error", entries: [], errorCode: "STORAGE_CONFLICT_PRESERVED",
      });
      expect(preserveAfterReadback).toHaveBeenCalledOnce();
      expect(saved()).toEqual(new Uint8Array([1, 3]));
      expect(store.read).toHaveBeenCalledTimes(2);
      expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
    });

    it("does not mislabel a post-CAS preservation failure as preserved", async () => {
      const { session, preservingCas, preserveAfterReadback, replace } = preservingFixture();
      await session.open();
      preservingCas.mockImplementationOnce(async () => {
        replace(new Uint8Array([1, 3]));
        return { kind: "updated" };
      });
      preserveAfterReadback.mockRejectedValueOnce(new SyntheticStorageError("outbox-full"));

      await session.register(selection());

      expect(session.state).toEqual({ phase: "error", entries: [], errorCode: "outbox-full" });
      expect(session.state.errorCode).not.toBe("STORAGE_CONFLICT_PRESERVED");
    });

    it("lock cancels and wipes a late append result before any storage write", async () => {
      const { session, store, worker, preservingCas } = preservingFixture();
      await session.open();
      const gate = deferred<Uint8Array>();
      const lateCandidate = new Uint8Array([4, 5, 6]);
      worker.append.mockReturnValueOnce(gate.promise);
      const pending = session.register(selection());
      await flush();
      expect(worker.append).toHaveBeenCalledOnce();
      const cancelsBeforeLock = worker.cancel.mock.calls.length;

      session.lock();
      gate.resolve(lateCandidate);
      await pending;

      expect(worker.cancel).toHaveBeenCalledTimes(cancelsBeforeLock + 1);
      expect(lateCandidate).toEqual(new Uint8Array([0, 0, 0]));
      expect(session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
      expect(preservingCas).not.toHaveBeenCalled();
      expect(store.compareAndSwapArchive).not.toHaveBeenCalled();
      expect(store.read).toHaveBeenCalledOnce();
    });

    it("lock during candidate authentication prevents the atomic storage call", async () => {
      const { session, store, worker, preservingCas } = preservingFixture();
      await session.open();
      const gate = deferred<readonly LocalCatalogEntryV1[]>();
      worker.open.mockReturnValueOnce(gate.promise);
      const pending = session.register(selection());
      await flush();
      expect(preservingCas).not.toHaveBeenCalled();

      session.lock();
      gate.resolve(rows("late-candidate"));
      await pending;

      expect(session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
      expect(preservingCas).not.toHaveBeenCalled();
      expect(store.read).toHaveBeenCalledOnce();
    });

    it("a late atomic completion after lock cannot read back, preserve or publish", async () => {
      const { session, store, preservingCas, preserveAfterReadback } = preservingFixture();
      await session.open();
      const gate = deferred<{ kind: "conflict-preserved"; conflictId: string }>();
      preservingCas.mockReturnValueOnce(gate.promise);
      const pending = session.register(selection());
      await flush();
      expect(preservingCas).toHaveBeenCalledOnce();

      session.lock();
      gate.resolve({ kind: "conflict-preserved", conflictId: "c".repeat(32) });
      await pending;

      expect(session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
      expect(store.read).toHaveBeenCalledOnce();
      expect(preserveAfterReadback).not.toHaveBeenCalled();
    });
  });
});
