import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
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

  it("persists both closed Password forms with API siblings, clears views on lock and reopens exact saved rows", async () => {
    const database = new IDBFactory();
    const store = createSyntheticCiphertextStore(database);
    const session = new SyntheticVaultSession(store, actualWorker());
    await session.create();
    const original = (await store.read())!;
    const originalRows = [...session.state.entries];
    for (const credentialId of [1, 2] as const) {
      const before = (await store.read())!;
      await session.register({ profileId: 2, credentialId, connectionIds: [] });
      expect(session.state.phase).toBe("open");
      expect(session.state.entries.at(-1)).toEqual({
        reference: credentialId + 2,
        itemName: credentialId === 1 ? "Example Password Only" : "Example Password With Identifier",
        providerName: "Example Password Service",
        issuerAccountIdentifier: null,
        issuerOrganizationOrWorkspace: null,
        issuerProject: null,
        issuerEnvironment: null,
        credentialType: "password",
        status: "active",
        connectionCount: 0,
        secretFieldCount: credentialId,
        mcpConnectionCount: 0,
        connections: [],
      });
      const saved = (await store.read())!;
      expect(saved.slice(16, before.length)).toEqual(before.slice(16));
    }
    const saved = (await store.read())!;
    const expected = [...session.state.entries];
    expect(expected.slice(0, 3)).toEqual(originalRows);
    expect(expected).toHaveLength(5);
    expect(saved.slice(16, original.length)).toEqual(original.slice(16));
    expect(new DataView(saved.buffer, saved.byteOffset).getUint32(8, true)).toBe(2);
    expect(new DataView(saved.buffer, saved.byteOffset).getUint32(12, true)).toBe(5);
    for (const plaintext of [
      "DEMO_VALUE_ONLY_PASSWORD_FIXTURE_0001",
      "DEMO_VALUE_ONLY_PASSWORD_IDENTIFIER_0001",
    ]) {
      expect(Buffer.from(saved).includes(Buffer.from(plaintext, "utf8"))).toBe(false);
      expect(JSON.stringify(expected)).not.toContain(plaintext);
    }
    session.lock();
    expect(session.state).toEqual({ phase: "locked", entries: [], errorCode: null });
    const restarted = new SyntheticVaultSession(createSyntheticCiphertextStore(database), actualWorker());
    expect(restarted.state.entries).toEqual([]);
    await restarted.open();
    expect(restarted.state.entries).toEqual(expected);
    expect(await store.read()).toEqual(saved);
    restarted.lock();
    expect(restarted.state.entries).toEqual([]);
  }, 90_000);

  it("keeps one canonical registration and preserves the other authenticated candidate when two sessions race from the same archive", async () => {
    const database = new IDBFactory();
    const firstStore = createSyntheticCiphertextStore(database, (target) => target.fill(0x51));
    const secondStore = createSyntheticCiphertextStore(database, (target) => target.fill(0x52));
    const firstBaseWorker = actualWorker();
    const secondBaseWorker = actualWorker();
    let firstInput: Uint8Array | undefined;
    let secondInput: Uint8Array | undefined;
    let firstCandidate: Uint8Array | undefined;
    let secondCandidate: Uint8Array | undefined;
    const firstWorker: SyntheticRegistrationWorker = {
      ...firstBaseWorker,
      async append(bytes, selection) {
        firstInput = bytes.slice();
        const candidate = await firstBaseWorker.append(bytes, selection);
        firstCandidate = candidate.slice();
        return candidate;
      },
    };
    const secondWorker: SyntheticRegistrationWorker = {
      ...secondBaseWorker,
      async append(bytes, selection) {
        secondInput = bytes.slice();
        const candidate = await secondBaseWorker.append(bytes, selection);
        secondCandidate = candidate.slice();
        return candidate;
      },
    };
    const first = new SyntheticVaultSession(firstStore, firstWorker);
    await first.create();
    const original = (await firstStore.read())!;
    const second = new SyntheticVaultSession(secondStore, secondWorker);
    await second.open();
    expect(first.state.phase).toBe("open");
    expect(second.state).toEqual(first.state);

    await Promise.all([
      first.register({ profileId: 1, credentialId: 0, connectionIds: [0, 2] }),
      second.register({ profileId: 2, credentialId: 1, connectionIds: [] }),
    ]);
    expect(firstInput).toEqual(original);
    expect(secondInput).toEqual(original);
    expect(firstCandidate).toBeDefined();
    expect(secondCandidate).toBeDefined();
    expect(firstCandidate).not.toEqual(secondCandidate!);
    expect([first.state.phase, second.state.phase].sort()).toEqual(["error", "open"]);
    expect([first.state.errorCode, second.state.errorCode])
      .toContain("STORAGE_CONFLICT_PRESERVED");

    const durableStore = createSyntheticCiphertextStore(database);
    const current = await durableStore.read();
    const conflicts = await durableStore.listConflictArchives();
    const firstWon = first.state.phase === "open";
    const winnerCandidate = firstWon ? firstCandidate : secondCandidate;
    const loserCandidate = firstWon ? secondCandidate : firstCandidate;
    expect(current).not.toBeNull();
    expect(current).toEqual(winnerCandidate!);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.bytes).toEqual(loserCandidate!);
    expect(conflicts[0]!.bytes).not.toEqual(current);

    const verifier = actualWorker();
    const currentRows = await verifier.open(current!);
    const loserRows = await verifier.open(conflicts[0]!.bytes);
    expect(firstWon ? first.state.entries : second.state.entries).toEqual(currentRows);
    expect([currentRows.at(-1)!.itemName, loserRows.at(-1)!.itemName].sort()).toEqual([
      "Example Cloud Lab Registered API Key",
      "Example Password Only",
    ]);
    expect(await durableStore.read()).toEqual(current);
    expect(await durableStore.listConflictArchives()).toEqual(conflicts);
    first.lock();
    second.lock();
  }, 120_000);
});
