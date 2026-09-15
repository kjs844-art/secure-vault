import { readFile } from "node:fs/promises";
import { IDBFactory } from "fake-indexeddb";
import { beforeAll, describe, expect, it } from "vitest";
import init, { appendSyntheticRegistration, createSyntheticArchive, openSyntheticArchive } from "../../generated/vault-wasm-demo/vault_client_wasm.js";
import { WasmCatalogAdapter } from "../../bridge/WasmCatalogAdapter";
import { createSyntheticCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import { SyntheticVaultSession, type SyntheticRegistrationWorker } from "./SyntheticVaultSession";

/** Real Rust/WASM + session + fake IndexedDB. Not actual browser Worker/IDB/cancellation evidence. */
function actualWorker(): SyntheticRegistrationWorker {
  return {
    async create() { return createSyntheticArchive(); },
    async append(bytes, selection) {
      return appendSyntheticRegistration(bytes, selection.profileId, selection.credentialId, new Float64Array(selection.connectionIds));
    },
    async open(bytes) {
      const adapter = new WasmCatalogAdapter(() => openSyntheticArchive(bytes));
      try { return await adapter.load(); } finally { adapter.dispose(); }
    },
    cancel() { /* Inline Node harness cannot terminate WASM operations. */ },
  };
}

describe("registration real-WASM/session/IndexedDB adapter integration", { concurrent: false }, () => {
  beforeAll(async () => {
    const bytes = await readFile(new URL("../../generated/vault-wasm-demo/vault_client_wasm_bg.wasm", import.meta.url));
    await init({ module_or_path: new Uint8Array(bytes) });
  });

  it("registers 0/1/3 connections, retains old envelopes and reopens the saved selections in a new session", async () => {
    const store = createSyntheticCiphertextStore(new IDBFactory());
    const session = new SyntheticVaultSession(store, actualWorker());
    await session.create();
    expect(session.state.phase).toBe("open");
    const original = (await store.read())!;
    const expected = [...session.state.entries];
    for (const connectionIds of [[], [0], [2, 0, 1]]) {
      await session.register({ profileId: 1, credentialId: 0, connectionIds });
      expect(session.state.phase).toBe("open");
      const row = session.state.entries.at(-1)!;
      expect(row.providerName).toBe("Example Cloud Lab");
      expect(row.itemName).toBe("Example Cloud Lab Registered API Key");
      expect(row.connectionCount).toBe(connectionIds.length);
      expect(row.connections.map((connection) => connection.consumerType)).toEqual(
        connectionIds.map((id) => ["mcp_server", "cli", "ci_cd"][id]),
      );
      expected.push(row);
    }
    const saved = (await store.read())!;
    expect(new DataView(saved.buffer, saved.byteOffset).getUint32(8, true)).toBe(2);
    expect(new DataView(saved.buffer, saved.byteOffset).getUint32(12, true)).toBe(6);
    // Header version/count intentionally differ. All prior envelope framing/bytes remain exact.
    expect(saved.slice(16, original.length)).toEqual(original.slice(16));
    session.lock();
    const reopened = new SyntheticVaultSession(store, actualWorker());
    expect(reopened.state.entries).toEqual([]);
    await reopened.open();
    expect(reopened.state.entries).toEqual(expected);
    expect(await store.read()).toEqual(saved);
    reopened.lock();
  // This workflow creates a vault and repeatedly appends/reopens it, unlike a
  // single worker operation. Allow debug WASM without weakening assertions.
  }, 90_000);

  it("rejects corrupt stored ciphertext during append and never changes it", async () => {
    const store = createSyntheticCiphertextStore(new IDBFactory());
    const session = new SyntheticVaultSession(store, actualWorker());
    await session.create();
    const original = (await store.read())!;
    const corrupt = original.slice();
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    expect(await store.compareAndSwapArchive(original, corrupt)).toBe("updated");
    await session.register({ profileId: 0, credentialId: 0, connectionIds: [] });
    expect(session.state.phase).toBe("error");
    expect(session.state.entries).toEqual([]);
    expect(await store.read()).toEqual(corrupt);
  }, 30_000);
});
