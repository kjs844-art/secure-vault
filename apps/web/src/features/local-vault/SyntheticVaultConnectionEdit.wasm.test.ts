import { readFile } from "node:fs/promises";
import { IDBFactory } from "fake-indexeddb";
import { beforeAll, describe, expect, it } from "vitest";
import init, { appendSyntheticRegistration, createSyntheticArchive, editSyntheticConnections, openSyntheticArchive } from "../../generated/vault-wasm-demo/vault_client_wasm.js";
import { WasmCatalogAdapter } from "../../bridge/WasmCatalogAdapter";
import { createSyntheticCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import { SyntheticVaultSession, type SyntheticConnectionEditWorker, type SyntheticRegistrationWorker } from "./SyntheticVaultSession";

/** Real WASM and fake IndexedDB; not browser Worker/cancellation or browser-storage evidence. */
function actualWorker(): SyntheticConnectionEditWorker & SyntheticRegistrationWorker {
  return {
    async create() { return createSyntheticArchive(); },
    async editConnections(bytes, selection) {
      return editSyntheticConnections(bytes, selection.reference, new Float64Array(selection.connectionIds));
    },
    async append(bytes, selection) {
      return appendSyntheticRegistration(bytes, selection.profileId, selection.credentialId, new Float64Array(selection.connectionIds));
    },
    async open(bytes) {
      const adapter = new WasmCatalogAdapter(() => openSyntheticArchive(bytes));
      try { return await adapter.load(); } finally { adapter.dispose(); }
    },
    cancel() { /* Inline harness does not terminate WASM operations. */ },
  };
}

describe("connection edit actual-WASM/session/IndexedDB adapter integration", { concurrent: false }, () => {
  beforeAll(async () => {
    const bytes = await readFile(new URL("../../generated/vault-wasm-demo/vault_client_wasm_bg.wasm", import.meta.url));
    await init({ module_or_path: new Uint8Array(bytes) });
  });

  it("edits a numeric reference repeatedly, preserves other metadata, and reopens saved v3 bytes", async () => {
    const database = new IDBFactory();
    const store = createSyntheticCiphertextStore(database);
    const session = new SyntheticVaultSession(store, actualWorker());
    await session.create();
    expect(session.state.phase).toBe("open");
    const originalRows = session.state.entries;
    let expected = [...originalRows];
    let revisionCount = 3;
    for (const connectionIds of [[2, 0], [], [1, 2, 0]]) {
      await session.editConnections(session.viewGeneration, { reference: 1, connectionIds });
      expect(session.state.phase).toBe("open");
      const row = session.state.entries[1]!;
      expect(session.state.entries[0]).toEqual(originalRows[0]);
      expect(session.state.entries[2]).toEqual(originalRows[2]);
      expect(row).toEqual({ ...originalRows[1], connectionCount: connectionIds.length,
        mcpConnectionCount: connectionIds.includes(0) ? 1 : 0,
        connections: connectionIds.map((id) => [
          { label: "Example MCP", consumerType: "mcp_server" },
          { label: "Example CLI", consumerType: "cli" },
          { label: "Example CI", consumerType: "ci_cd" },
        ][id]),
      });
      expected = [...session.state.entries];
      const bytes = (await store.read())!;
      const header = new DataView(bytes.buffer, bytes.byteOffset);
      expect(header.getUint32(8, true)).toBe(3);
      expect(header.getUint32(12, true)).toBe(3);
      expect(header.getUint32(16, true)).toBe(++revisionCount);
    }
    const saved = (await store.read())!;
    session.lock();
    const reopened = new SyntheticVaultSession(createSyntheticCiphertextStore(database), actualWorker());
    await reopened.open();
    expect(reopened.state.entries).toEqual(expected);
    expect(await store.read()).toEqual(saved);
    reopened.lock();
  }, 120_000);

  it("edits a v2 registration then appends on v3 without changing its edited rows", async () => {
    const store = createSyntheticCiphertextStore(new IDBFactory());
    const archive = appendSyntheticRegistration(createSyntheticArchive(), 1, 0, new Float64Array([0]));
    await store.createIfAbsent(archive);
    const session = new SyntheticVaultSession(store, actualWorker());
    await session.open();
    const before = session.state.entries;
    await session.editConnections(session.viewGeneration, { reference: 3, connectionIds: [2] });
    expect(session.state.phase).toBe("open");
    expect(session.state.entries.slice(0, 3)).toEqual(before.slice(0, 3));
    expect(session.state.entries[3]).toEqual({ ...before[3], connectionCount: 1, mcpConnectionCount: 0,
      connections: [{ label: "Example CI", consumerType: "ci_cd" }] });
    const edited = session.state.entries;
    await session.register({ profileId: 0, credentialId: 0, connectionIds: [] });
    expect(session.state.phase).toBe("open");
    expect(session.state.entries.slice(0, 4)).toEqual(edited);
    const saved = (await store.read())!;
    const header = new DataView(saved.buffer, saved.byteOffset);
    expect(header.getUint32(8, true)).toBe(3);
    expect(header.getUint32(12, true)).toBe(5);
    expect(header.getUint32(16, true)).toBe(6);
    const reopened = new SyntheticVaultSession(store, actualWorker());
    await reopened.open();
    expect(reopened.state.entries).toEqual(session.state.entries);
    session.lock(); reopened.lock();
  }, 120_000);

  it("restarts with an authenticated winner and a separately authenticated durable loser", async () => {
    const database = new IDBFactory();
    const firstStore = createSyntheticCiphertextStore(database, (target) => target.fill(0x11));
    const secondStore = createSyntheticCiphertextStore(database, (target) => target.fill(0x22));
    const first = new SyntheticVaultSession(firstStore, actualWorker());
    await first.create();
    const second = new SyntheticVaultSession(secondStore, actualWorker());
    await second.open();
    expect(first.state.phase).toBe("open");
    expect(second.state.phase).toBe("open");

    await Promise.all([
      first.editConnections(first.viewGeneration, { reference: 1, connectionIds: [0] }),
      second.editConnections(second.viewGeneration, { reference: 1, connectionIds: [2] }),
    ]);
    expect([first.state.phase, second.state.phase].sort()).toEqual(["error", "open"]);
    expect([first.state.errorCode, second.state.errorCode])
      .toContain("STORAGE_CONFLICT_PRESERVED");

    const restartedStore = createSyntheticCiphertextStore(database);
    const current = await restartedStore.read();
    const conflicts = await restartedStore.listConflictArchives();
    expect(current).not.toBeNull();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.bytes).not.toEqual(current);

    const verifier = actualWorker();
    const currentRows = await verifier.open(current!);
    const losingRows = await verifier.open(conflicts[0]!.bytes);
    const alternatives = [currentRows[1]!.connections, losingRows[1]!.connections]
      .map((connections) => connections.map((connection) => connection.label).join(","))
      .sort();
    expect(alternatives).toEqual(["Example CI", "Example MCP"]);

    first.lock(); second.lock();
    const reopened = new SyntheticVaultSession(restartedStore, actualWorker());
    await reopened.open();
    expect(reopened.state.entries).toEqual(currentRows);
    expect(await createSyntheticCiphertextStore(database).listConflictArchives())
      .toEqual(conflicts);
    reopened.lock();
  }, 120_000);

  it("durably preserves an authenticated candidate changed by a writer after CAS success", async () => {
    const database = new IDBFactory();
    const durableStore = createSyntheticCiphertextStore(database, (target) => target.fill(0x33));
    const setup = new SyntheticVaultSession(durableStore, actualWorker());
    await setup.create();
    setup.lock();

    const racingStore = {
      ...durableStore,
      async compareAndSwapArchivePreservingConflict(expected: Uint8Array, next: Uint8Array) {
        const outcome = await durableStore.compareAndSwapArchivePreservingConflict(expected, next);
        if (outcome.kind === "updated") {
          const successor = editSyntheticConnections(next, 1, new Float64Array([2]));
          expect(await durableStore.compareAndSwapArchive(next, successor)).toBe("updated");
        }
        return outcome;
      },
    };
    const editor = new SyntheticVaultSession(racingStore, actualWorker());
    await editor.open();
    await editor.editConnections(editor.viewGeneration, { reference: 1, connectionIds: [0] });
    expect(editor.state).toEqual({
      phase: "error", entries: [], errorCode: "STORAGE_CONFLICT_PRESERVED",
    });

    const restartedStore = createSyntheticCiphertextStore(database);
    const current = await restartedStore.read();
    const conflicts = await restartedStore.listConflictArchives();
    expect(current).not.toBeNull();
    expect(conflicts).toHaveLength(1);
    const verifier = actualWorker();
    const currentRows = await verifier.open(current!);
    const preservedRows = await verifier.open(conflicts[0]!.bytes);
    expect(currentRows[1]!.connections.map((connection) => connection.label)).toEqual(["Example CI"]);
    expect(preservedRows[1]!.connections.map((connection) => connection.label)).toEqual(["Example MCP"]);

    const reopened = new SyntheticVaultSession(restartedStore, actualWorker());
    await reopened.open();
    expect(reopened.state.entries).toEqual(currentRows);
    expect(await createSyntheticCiphertextStore(database).listConflictArchives()).toEqual(conflicts);
    editor.lock(); reopened.lock();
  }, 120_000);

  it("reviews an authenticated loser and exact-discards it without changing the current archive", async () => {
    const database = new IDBFactory();
    const firstStore = createSyntheticCiphertextStore(database, (target) => target.fill(0x41));
    const secondStore = createSyntheticCiphertextStore(database, (target) => target.fill(0x42));
    const first = new SyntheticVaultSession(firstStore, actualWorker());
    await first.create();
    const second = new SyntheticVaultSession(secondStore, actualWorker());
    await second.open();
    await Promise.all([
      first.editConnections(first.viewGeneration, { reference: 1, connectionIds: [0] }),
      second.editConnections(second.viewGeneration, { reference: 1, connectionIds: [2] }),
    ]);

    const durableStore = createSyntheticCiphertextStore(database);
    const currentBefore = (await durableStore.read())!;
    const conflictsBefore = await durableStore.listConflictArchives();
    expect(conflictsBefore).toHaveLength(1);
    const expectedLoserRows = await actualWorker().open(conflictsBefore[0]!.bytes);

    const reviewer = new SyntheticVaultSession(durableStore, actualWorker());
    await reviewer.open();
    await reviewer.loadConflictReviews(reviewer.viewGeneration);
    expect(reviewer.conflictReviewState.phase).toBe("ready");
    expect(reviewer.conflictReviewState.items).toEqual([
      { reference: 0, entries: expectedLoserRows },
    ]);
    expect(JSON.stringify(reviewer.conflictReviewState)).not.toContain(conflictsBefore[0]!.conflictId);

    const reviewVersion = reviewer.conflictReviewState.reviewVersion;
    reviewer.requestConflictDiscard(reviewVersion, 0);
    expect(await durableStore.listConflictArchives()).toEqual(conflictsBefore);
    await reviewer.confirmConflictDiscard(reviewVersion, 0);
    expect(reviewer.conflictReviewState).toMatchObject({ phase: "discarded", items: [] });
    expect(await durableStore.read()).toEqual(currentBefore);
    expect(await durableStore.listConflictArchives()).toEqual([]);

    first.lock(); second.lock(); reviewer.lock();
  }, 120_000);
});
