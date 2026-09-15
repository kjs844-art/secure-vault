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
});
