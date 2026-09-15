import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { WasmCatalogAdapter } from "../../bridge/WasmCatalogAdapter";
import type { LocalCatalogEntryV1 } from "../../bridge/catalogProtocol";
import init, {
  createSyntheticArchive,
  openSyntheticArchive,
} from "../../generated/vault-wasm-demo/vault_client_wasm.js";
import { createSyntheticCiphertextStore } from "../../storage/SyntheticCiphertextStore";
import { SyntheticVaultBackup } from "./SyntheticVaultBackup";
import type { SyntheticVaultWorker } from "./SyntheticVaultSession";

const WASM_TIMEOUT = 30_000;
const EXPECTED_ROWS: readonly LocalCatalogEntryV1[] = [
  {
    reference: 0,
    itemName: "Example Workshop API Credential",
    providerName: "Example AI Workshop",
    credentialType: "api_key",
    status: "active",
    connectionCount: 0,
    secretFieldCount: 1,
    mcpConnectionCount: 0,
    connections: [],
  },
  {
    reference: 1,
    itemName: "Example Workshop API Credential",
    providerName: "Example AI Workshop",
    credentialType: "api_key",
    status: "active",
    connectionCount: 1,
    secretFieldCount: 1,
    mcpConnectionCount: 1,
    connections: [{ label: "Example MCP", consumerType: "mcp_server" }],
  },
  {
    reference: 2,
    itemName: "Example Workshop API Credential",
    providerName: "Example AI Workshop",
    credentialType: "api_key",
    status: "active",
    connectionCount: 3,
    secretFieldCount: 2,
    mcpConnectionCount: 1,
    connections: [
      { label: "Example MCP", consumerType: "mcp_server" },
      { label: "Example CLI", consumerType: "cli" },
      { label: "Example CI", consumerType: "ci_cd" },
    ],
  },
];

/**
 * Node integration harness: real Rust/WASM crypto and the existing adapter,
 * but no browser Worker, Worker cancellation, or browser IndexedDB is exercised.
 * Each open releases its Rust handle, including authentication failures.
 */
function actualWasmWorker(): Pick<SyntheticVaultWorker, "open" | "cancel"> {
  return {
    async open(bytes) {
      const adapter = new WasmCatalogAdapter(() => openSyntheticArchive(bytes));
      try {
        return await adapter.load();
      } finally {
        adapter.dispose();
      }
    },
    cancel() { /* This inline harness has no Worker to terminate. */ },
  };
}

// These fixed fixtures are deliberately public and synthetic. No real secrets
// or arbitrary user inputs are imported by this test or the demo WASM exports.
describe("synthetic backup actual-WASM integration (Node)", { concurrent: false }, () => {
  let archive: Uint8Array;
  let exported: Uint8Array;
  let senderStore: ReturnType<typeof createSyntheticCiphertextStore>;

  beforeAll(async () => {
    const wasmBytes = await readFile(new URL(
      "../../generated/vault-wasm-demo/vault_client_wasm_bg.wasm",
      import.meta.url,
    ));
    await init({ module_or_path: new Uint8Array(wasmBytes) });
    archive = createSyntheticArchive();
    senderStore = createSyntheticCiphertextStore(new IDBFactory());
    expect(await senderStore.createIfAbsent(archive)).toBe("created");
    // Prepare one real export for the receiving tests. Keep expensive KDF
    // phases bounded separately instead of four opens in one 30-second test.
    // Any failed setup fails this suite; no test depends on another test running.
    exported = await new SyntheticVaultBackup(senderStore, actualWasmWorker()).exportArchive();
  }, WASM_TIMEOUT);

  afterEach(() => { vi.restoreAllMocks(); });

  it("exports identical stored ciphertext that authenticates all three records and relations", async () => {
    expect(exported).toEqual(archive);
    expect(exported).not.toBe(archive);
    expect(exported.buffer).not.toBe(archive.buffer);
    expect(await actualWasmWorker().open(exported)).toEqual(EXPECTED_ROWS);
    expect(await senderStore.read()).toEqual(archive);
  }, WASM_TIMEOUT);

  it("restores the exported bytes and all three records and relations in another database", async () => {
    const recipientFactory = new IDBFactory();
    const recipientStore = createSyntheticCiphertextStore(recipientFactory);
    const worker = actualWasmWorker();
    expect(await recipientStore.read()).toBeNull();
    await new SyntheticVaultBackup(recipientStore, worker).restoreArchive(exported);

    // Reconstruct the store to read committed bytes, not an in-memory fallback.
    const restored = await createSyntheticCiphertextStore(recipientFactory).read();
    expect(restored).toBeInstanceOf(Uint8Array);
    expect(restored).toEqual(exported);
    expect(await worker.open(restored!)).toEqual(EXPECTED_ROWS);
    expect(exported).toEqual(archive);
    expect(await senderStore.read()).toEqual(archive);
  }, WASM_TIMEOUT);

  it("does not expose known fixture labels or synthetic values as plaintext in archive bytes", () => {
    const ciphertext = Buffer.from(archive);
    for (const plaintext of [
      "Example Workshop API Credential", "Example AI Workshop",
      "Example MCP", "Example CLI", "Example CI",
      "DEMO_VALUE_ONLY_API_KEY_0001", "DEMO_VALUE_ONLY_TOKEN_0002",
      "DEMO_VALUE_ONLY_wasm_catalog",
    ]) {
      expect(ciphertext.includes(Buffer.from(plaintext, "utf8"))).toBe(false);
    }
  });

  it.each([
    ["unrecognized bytes", "INVALID_BACKUP", () => new Uint8Array(32)],
    ["truncated archive body", "VALIDATION_FAILED", () => archive.slice(0, 16)],
  ] as const)("refuses %s without writing a recipient archive", async (_label, code, input) => {
    const store = createSyntheticCiphertextStore(new IDBFactory());
    const create = vi.spyOn(store, "createIfAbsent");
    await expect(new SyntheticVaultBackup(store, actualWasmWorker()).restoreArchive(input()))
      .rejects.toMatchObject({ code });
    expect(create).not.toHaveBeenCalled();
    expect(await store.read()).toBeNull();
  }, WASM_TIMEOUT);

  it("rejects actual authentication corruption without writing or changing the supplied bytes", async () => {
    const corrupted = archive.slice();
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
    const snapshot = corrupted.slice();
    const worker = actualWasmWorker();
    // Establish that this is an authentication failure in real WASM, not just
    // a malformed magic/header that the TypeScript service can reject itself.
    await expect(worker.open(corrupted)).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    const store = createSyntheticCiphertextStore(new IDBFactory());
    const create = vi.spyOn(store, "createIfAbsent");

    await expect(new SyntheticVaultBackup(store, worker).restoreArchive(corrupted))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(create).not.toHaveBeenCalled();
    expect(await store.read()).toBeNull();
    expect(corrupted).toEqual(snapshot);
  }, WASM_TIMEOUT);

  it("refuses a future archive version without writing a recipient archive", async () => {
    const future = archive.slice();
    new DataView(future.buffer).setUint32(8, 2, true);
    const snapshot = future.slice();
    const store = createSyntheticCiphertextStore(new IDBFactory());
    const create = vi.spyOn(store, "createIfAbsent");

    await expect(new SyntheticVaultBackup(store, actualWasmWorker()).restoreArchive(future))
      .rejects.toMatchObject({ code: "UNSUPPORTED_VERSION" });
    expect(create).not.toHaveBeenCalled();
    expect(await store.read()).toBeNull();
    expect(future).toEqual(snapshot);
  });

  it("preserves an existing destination archive byte-for-byte instead of replacing it", async () => {
    const store = createSyntheticCiphertextStore(new IDBFactory());
    const existing = createSyntheticArchive();
    expect(await store.createIfAbsent(existing)).toBe("created");
    const create = vi.spyOn(store, "createIfAbsent");

    await expect(new SyntheticVaultBackup(store, actualWasmWorker()).restoreArchive(archive))
      .rejects.toMatchObject({ code: "EXISTS" });
    expect(create).not.toHaveBeenCalled();
    const saved = await store.read();
    expect(saved).toEqual(existing);
    expect(await actualWasmWorker().open(saved!)).toEqual(EXPECTED_ROWS);
  }, WASM_TIMEOUT);
});
