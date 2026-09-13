import init, { syntheticCatalog } from "../../src/generated/vault-wasm-demo/vault_client_wasm.js";
import { WasmCatalogAdapter } from "../../src/bridge/WasmCatalogAdapter.ts";

function check(condition) {
  if (!condition) throw new Error("WASM_SMOKE_FAILED");
}

async function run() {
  await init();

  const handle = syntheticCatalog();
  try {
    check(handle.length() === 3);
    check(handle.isLocked() === false);
    handle.lock();
    check(handle.isLocked() === true);
    let lockedError = false;
    try { handle.length(); } catch (error) { lockedError = error === "LOCKED"; }
    check(lockedError);
  } finally {
    handle.lock();
    handle.free();
  }

  const adapter = new WasmCatalogAdapter(() => syntheticCatalog());
  try {
    const rows = await adapter.load();
    check(rows.length === 3 && adapter.isLocked === false);
    const allowed = [
      "reference", "itemName", "providerName", "credentialType", "status",
      "connectionCount", "secretFieldCount", "mcpConnectionCount", "connections",
    ];
    for (const row of rows) {
      const keys = Object.keys(row);
      check(keys.length === allowed.length && keys.every((key, index) => key === allowed[index]));
      check(Object.isFrozen(row));
    }
    adapter.lock();
    check(adapter.entries.length === 0 && adapter.isLocked === true);
  } finally {
    adapter.dispose();
  }

  // A real generated handle arriving after lock must be released, never shown.
  let resolvePending;
  const pending = new Promise((resolve) => { resolvePending = resolve; });
  const staleAdapter = new WasmCatalogAdapter(() => pending);
  try {
    const outcome = staleAdapter.load().then(
      () => false,
      (error) => error?.code === "CANCELLED",
    );
    staleAdapter.lock();
    resolvePending(syntheticCatalog());
    check(await outcome);
    check(staleAdapter.entries.length === 0 && staleAdapter.isLocked === true);
  } finally {
    staleAdapter.dispose();
  }
}

run().then(
  () => self.postMessage({ schemaVersion: 1, status: "pass", code: "WASM_SMOKE_PASSED" }),
  () => self.postMessage({ schemaVersion: 1, status: "fail", code: "WASM_SMOKE_FAILED" }),
).finally(() => self.close());
