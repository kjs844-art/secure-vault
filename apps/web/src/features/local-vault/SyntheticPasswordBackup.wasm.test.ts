import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { IDBFactory } from "fake-indexeddb";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { WasmCatalogAdapter } from "../../bridge/WasmCatalogAdapter";
import { WasmRotationStageAdapter } from "../../bridge/WasmRotationStageAdapter";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import init, {
  appendSyntheticRegistration,
  createSyntheticArchive,
  createSyntheticRotationCutover,
  createSyntheticRotationStage,
  inspectSyntheticRotationStage,
  openSyntheticArchive,
} from "../../generated/vault-wasm-demo/vault_client_wasm.js";
import { createSyntheticCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import { SyntheticVaultBackup } from "./SyntheticVaultBackup";
import { SyntheticVaultSession, type SyntheticVaultWorker } from "./SyntheticVaultSession";

/** Real Rust/WASM; fake IDB and inline calls, not browser Worker/cancellation evidence. */
function worker(): SyntheticVaultWorker {
  return {
    async create() { return createSyntheticArchive(); },
    async open(bytes) {
      const adapter = new WasmCatalogAdapter(() => openSyntheticArchive(bytes));
      try { return await adapter.load(); } finally { adapter.dispose(); }
    },
    cancel() { /* No real browser Worker exists in this Node harness. */ },
  };
}

/** Read framing of generated fixtures only, so exact canonical ciphertext can be compared. */
function canonicalFrames(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(8, true);
  expect([2, 3, 4]).toContain(version);
  const count = view.getUint32(version === 2 ? 12 : 16, true);
  expect(count).toBeLessThanOrEqual(512);
  let cursor = version === 2 ? 16 : version === 3 ? 20 : 24;
  const next = () => {
    const length = view.getUint32(cursor, true);
    cursor += 4;
    const start = cursor;
    cursor += length;
    expect(length).toBeGreaterThan(0);
    expect(cursor).toBeLessThanOrEqual(bytes.length);
    return { start, end: cursor, bytes: bytes.slice(start, cursor) };
  };
  next(); // Wrapped vault-key envelope; not a credential record.
  return Array.from({ length: count }, next);
}

describe("mixed Password backup actual-WASM integration", { concurrent: false }, () => {
  let mixed: Uint8Array;
  let staged: Uint8Array;
  let expected: readonly LocalCatalogEntryV1[];

  beforeAll(async () => {
    const wasm = await readFile(new URL("../../generated/vault-wasm-demo/vault_client_wasm_bg.wasm", import.meta.url));
    await init({ module_or_path: new Uint8Array(wasm) });
    const first = appendSyntheticRegistration(createSyntheticArchive(), 2, 1, new Float64Array());
    mixed = appendSyntheticRegistration(first, 2, 2, new Float64Array());
    expected = await worker().open(mixed);
    expect(expected).toHaveLength(5);
    expect(expected.slice(3).map((row) => row.credentialType)).toEqual(["password", "password"]);
    // Rotate the API/MCP sibling, then save partial API progress on another
    // record. Both operations must preserve Password canonical envelopes.
    const rotated = createSyntheticRotationCutover(mixed, 1, true, false, false, false, false, false, 0);
    staged = createSyntheticRotationStage(rotated, 2, true, false, false, false, false, false, 0);
    const originalFrames = canonicalFrames(mixed);
    for (const candidate of [rotated, staged]) {
      const frames = canonicalFrames(candidate);
      expect(frames[3]!.bytes).toEqual(originalFrames[3]!.bytes);
      expect(frames[4]!.bytes).toEqual(originalFrames[4]!.bytes);
      expect((await worker().open(candidate)).slice(3)).toEqual(expected.slice(3));
    }
  }, 120_000);

  it.each([2, 4])("exports/restores exact v%i mixed bytes and reopens only on explicit unlock", async (version) => {
    const archive = version === 2 ? mixed : staged;
    const sender = createSyntheticCiphertextStore(new IDBFactory());
    expect(await sender.createIfAbsent(archive)).toBe("created");
    const exported = await new SyntheticVaultBackup(sender, worker()).exportArchive();
    expect(exported).toEqual(archive);
    expect(exported.buffer).not.toBe(archive.buffer);
    const database = new IDBFactory();
    const recipient = createSyntheticCiphertextStore(database);
    const locked = new SyntheticVaultSession(recipient, worker());
    await new SyntheticVaultBackup(recipient, worker()).restoreArchive(exported);
    expect(locked.state).toEqual({ phase: "locked", entries: [], errorCode: null });
    const durable = createSyntheticCiphertextStore(database);
    expect(await durable.read()).toEqual(archive);
    const restarted = new SyntheticVaultSession(durable, worker());
    await restarted.open();
    expect(restarted.state.phase).toBe("open");
    expect(restarted.state.entries.slice(3)).toEqual(expected.slice(3));
    expect(restarted.state.entries).toHaveLength(5);
    if (version === 4) {
      const adapter = new WasmRotationStageAdapter(() => inspectSyntheticRotationStage(exported, 2));
      try {
        const progress = await adapter.load();
        expect(progress).toMatchObject({ readyForCutover: false, revocation: "pending" });
        expect(progress?.entries[0]).toMatchObject({ fixture: "mcp", completion: "user_confirmed" });
      } finally { adapter.dispose(); }
    }
    for (const value of ["DEMO_VALUE_ONLY_PASSWORD_FIXTURE_0001", "DEMO_VALUE_ONLY_PASSWORD_IDENTIFIER_0001"]) {
      expect(Buffer.from(exported).includes(Buffer.from(value, "utf8"))).toBe(false);
      expect(JSON.stringify(restarted.state.entries)).not.toContain(value);
    }
    // Display metadata is intentionally present in the catalog projection but
    // must remain encrypted in the durable archive and backup bytes.
    for (const value of ["Example Password Service", "Example Password Only", "Example Password With Identifier",
      "synthetic-password-v1", "https://password.example.invalid/account", "synthetic-password",
      "Build-included synthetic Password fixture only.", "2026-09-18T00:00:00Z"]) {
      expect(Buffer.from(exported).includes(Buffer.from(value, "utf8"))).toBe(false);
    }
    restarted.lock();
    expect(restarted.state.entries).toEqual([]);
    expect(await durable.read()).toEqual(archive);
    expect(await sender.read()).toEqual(archive);
  }, 90_000);

  it("rejects a damaged Password envelope before restoring and preserves the submitted backup", async () => {
    const corrupted = staged.slice();
    const password = canonicalFrames(corrupted)[4]!;
    corrupted[password.end - 1] = corrupted[password.end - 1]! ^ 1;
    const snapshot = corrupted.slice();
    await expect(worker().open(corrupted)).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    const recipient = createSyntheticCiphertextStore(new IDBFactory());
    const create = vi.spyOn(recipient, "createIfAbsent");
    await expect(new SyntheticVaultBackup(recipient, worker()).restoreArchive(corrupted))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(create).not.toHaveBeenCalled();
    expect(await recipient.read()).toBeNull();
    expect(corrupted).toEqual(snapshot);
  }, 30_000);

  it("does not grant Password siblings API rotation or staging capabilities", () => {
    const snapshot = staged.slice();
    for (const reference of [3, 4]) {
      expect(() => createSyntheticRotationCutover(staged, reference, false, false, false, false, false, false, 0))
        .toThrow("INVALID_ARCHIVE");
      expect(() => createSyntheticRotationStage(staged, reference, false, false, false, false, false, false, 0))
        .toThrow("INVALID_ARCHIVE");
    }
    expect(staged).toEqual(snapshot);
  }, 30_000);
});
