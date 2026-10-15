import { readFile } from "node:fs/promises";
import { IDBFactory } from "fake-indexeddb";
import { beforeAll, describe, expect, it } from "vitest";
import init, { createSyntheticArchive, createSyntheticRotationStage, inspectSyntheticRotationStage,
  createSyntheticRotationCutoverFromStage, openSyntheticArchive, inspectSyntheticRotationChecklist,
  WasmRotationStageV1 } from "../../generated/vault-wasm-demo/vault_client_wasm.js";
import { WasmCatalogAdapter } from "../../bridge/WasmCatalogAdapter";
import { WasmRotationStageAdapter } from "../../bridge/WasmRotationStageAdapter";
import { createSyntheticCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import { SyntheticVaultSession, type SyntheticRotationStageWorker } from "./SyntheticVaultSession";
import { SyntheticVaultBackup } from "./SyntheticVaultBackup";

/** Real generated WASM; fake IndexedDB and inline Worker substitute, not browser evidence. */
function worker(): SyntheticRotationStageWorker {
  return {
    async create() { return createSyntheticArchive(); },
    async open(bytes) {
      const adapter = new WasmCatalogAdapter(() => openSyntheticArchive(bytes));
      try { return await adapter.load(); } finally { adapter.dispose(); }
    },
    async inspectRotationStage(bytes, reference) {
      const adapter = new WasmRotationStageAdapter(() => inspectSyntheticRotationStage(bytes, reference));
      try { return await adapter.load(); } finally { adapter.dispose(); }
    },
    async saveRotationStage(bytes, selection) {
      return createSyntheticRotationStage(bytes, selection.reference,
        selection.mcp === "user_confirmed", selection.cli === "user_confirmed", selection.ci === "user_confirmed",
        selection.mcp === "provider_verified", selection.cli === "provider_verified", selection.ci === "provider_verified",
        selection.supersededRevocation === "pending" ? 0 : selection.supersededRevocation === "user_confirmed" ? 1 : 2);
    },
    async createRotationCutoverFromStage(bytes, reference) { return createSyntheticRotationCutoverFromStage(bytes, reference); },
    cancel() { /* Inline harness only. Actual browser cancellation is separately exercised. */ },
  };
}

describe("durable staging actual-WASM + fake-IDB integration", { concurrent: false }, () => {
  let original: Uint8Array;
  let partial: Uint8Array;
  beforeAll(async () => {
    const wasm = await readFile(new URL("../../generated/vault-wasm-demo/vault_client_wasm_bg.wasm", import.meta.url));
    await init({ module_or_path: new Uint8Array(wasm) });
    original = createSyntheticArchive();
    partial = createSyntheticRotationStage(original, 2, true, false, false, false, false, false, 0);
  }, 60_000);

  it("reopens saved progress in a fresh session, saves remaining work and finalizes only the saved ready stage", async () => {
    const database = new IDBFactory();
    const firstStore = createSyntheticCiphertextStore(database);
    await firstStore.createIfAbsent(partial);
    const first = new SyntheticVaultSession(firstStore, worker());
    await first.open();
    const restored = await first.inspectRotationStage(first.viewGeneration, 2);
    expect(restored?.stage).toMatchObject({ baseGeneration: "initial_0001", targetGeneration: "rotated_0002",
      revocation: "pending", remainingOptional: 2, readyForCutover: false });
    expect(restored?.stage?.entries[0]).toMatchObject({ fixture: "mcp", completion: "user_confirmed" });
    const unchangedRows = first.state.entries;
    await first.saveRotationStage(first.viewGeneration, { reference: 2, mcp: "user_confirmed", cli: "provider_verified", ci: "pending", supersededRevocation: "user_confirmed" });
    expect(first.state.phase).toBe("open");
    expect(first.state.entries).toEqual(unchangedRows);
    const saved = (await firstStore.read())!;
    expect(new DataView(saved.buffer).getUint32(8, true)).toBe(4);
    expect(new DataView(saved.buffer).getUint32(16, true)).toBe(3);
    expect(new DataView(saved.buffer).getUint32(20, true)).toBe(2);
    first.lock();
    const nextStore = createSyntheticCiphertextStore(database);
    const next = new SyntheticVaultSession(nextStore, worker());
    await next.open();
    expect(next.rotationStageReviewState.phase).toBe("idle");
    const ready = await next.inspectRotationStage(next.viewGeneration, 2);
    expect(ready?.stage?.readyForCutover).toBe(true);
    expect(ready?.stage?.remainingOptional).toBe(1);
    await next.commitRotationCutoverFromStage(next.viewGeneration, ready!.reviewVersion);
    expect(next.state.phase).toBe("open");
    const finalBytes = (await nextStore.read())!;
    expect(new DataView(finalBytes.buffer).getUint32(16, true)).toBe(4);
    expect(new DataView(finalBytes.buffer).getUint32(20, true)).toBe(2);
    const inactive = await next.inspectRotationStage(next.viewGeneration, 2);
    expect(inactive?.stage).toBeNull();
    const checklist = inspectSyntheticRotationChecklist(finalBytes, 2, false, false, false, false, false, false, 0);
    try { expect(checklist.generation()).toBe("rotated_0002"); } finally { checklist.lock(); checklist.free(); }
    expect(await nextStore.listConflictArchives()).toEqual([]);
    for (const text of ["DEMO_VALUE_ONLY_API_KEY_0001", "DEMO_VALUE_ONLY_API_KEY_0002", "Example MCP"]) {
      expect(Buffer.from(finalBytes).includes(Buffer.from(text))).toBe(false);
    }
  }, 120_000);

  it("backs up and restores exact v4 bytes and pending progress in a different database", async () => {
    const sender = createSyntheticCiphertextStore(new IDBFactory());
    await sender.createIfAbsent(partial);
    const backup = await new SyntheticVaultBackup(sender, worker()).exportArchive();
    expect(backup).toEqual(partial);
    const destination = createSyntheticCiphertextStore(new IDBFactory());
    await new SyntheticVaultBackup(destination, worker()).restoreArchive(backup);
    const bytes = (await destination.read())!;
    expect(bytes).toEqual(partial);
    const progress = await worker().inspectRotationStage(bytes, 2);
    expect(progress?.revocation).toBe("pending");
    expect(progress?.entries[0]?.completion).toBe("user_confirmed");
    expect(() => createSyntheticRotationCutoverFromStage(bytes, 2)).toThrow("INVALID_ARCHIVE");
    expect(await destination.read()).toEqual(partial);
  }, 60_000);

  it("rejects primitive aliases and direct construction; all getters close on lock", () => {
    expect(() => new WasmRotationStageV1()).toThrow("CONSTRUCTOR_DISABLED");
    for (const invalid of [-0, -1, 0.2, 2 ** 32, NaN, Infinity, "2", true, null, undefined, {}]) {
      expect(() => inspectSyntheticRotationStage(partial, invalid)).toThrow("INVALID_ARCHIVE");
      expect(() => createSyntheticRotationStage(original, 2, true, false, false, false, false, false, invalid)).toThrow("INVALID_ARCHIVE");
    }
    for (const invalid of [0, "false", null, undefined, {}, new Boolean(false)]) {
      expect(() => createSyntheticRotationStage(original, 2, invalid, false, false, false, false, false, 0)).toThrow("INVALID_ARCHIVE");
    }
    const handle = inspectSyntheticRotationStage(partial, 2)!;
    expect(handle.isLocked()).toBe(false);
    expect(() => handle.entryFixture("0")).toThrow("INVALID_REFERENCE");
    handle.lock(); handle.lock();
    expect(handle.isLocked()).toBe(true);
    for (const read of [() => handle.baseGeneration(), () => handle.targetGeneration(), () => handle.entryCount(),
      () => handle.entryFixture(0), () => handle.entryRequiredForCutover(0), () => handle.entryCompletion(0),
      () => handle.revocation(), () => handle.remainingRequired(), () => handle.remainingOptional(), () => handle.readyForCutover()]) {
      expect(read).toThrow("LOCKED");
    }
    handle.free();
  }, 30_000);
});
