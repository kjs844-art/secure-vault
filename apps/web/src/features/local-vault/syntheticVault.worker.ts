import init, { createSyntheticArchive, openSyntheticArchive } from "../../generated/vault-wasm-demo/vault_client_wasm.js";
import { WasmCatalogAdapter } from "../../bridge/WasmCatalogAdapter";
import { CATALOG_ERROR_CODES_V1, CatalogAdapterError } from "../../bridge/catalogProtocol";

// Avoid adding DOM/WebWorker conflicting globals to the application tsconfig.
interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
}
const port = self as unknown as WorkerScope;
const MAX_ARCHIVE_BYTES = 524_288;
let started = false;

port.onmessage = (event) => {
  if (started) return;
  started = true;
  port.onmessage = null;
  void execute(event.data);
};

async function execute(value: unknown): Promise<void> {
  let adapter: WasmCatalogAdapter | undefined;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new CatalogAdapterError("BRIDGE_FAILURE");
    }
    const request = value as Record<string, unknown>;
    if (request.op !== "create" && request.op !== "open") {
      throw new CatalogAdapterError("BRIDGE_FAILURE");
    }
    // Validate and snapshot bounded input before initialization or WASM bindings.
    const input = request.op === "open" ? archiveBytes(request.bytes) : undefined;
    await init();
    if (request.op === "create") {
      const bytes = archiveBytes(createSyntheticArchive());
      port.postMessage({ ok: true, kind: "archive", bytes }, [bytes.buffer as ArrayBuffer]);
    } else {
      adapter = new WasmCatalogAdapter(() => openSyntheticArchive(input!));
      const entries = await adapter.load();
      adapter.dispose();
      adapter = undefined;
      port.postMessage({ ok: true, kind: "catalog", entries });
    }
  } catch (error: unknown) {
    let code: unknown;
    try { code = error instanceof CatalogAdapterError ? error.code : error; }
    catch { code = undefined; }
    port.postMessage({
      ok: false,
      code: typeof code === "string" && CATALOG_ERROR_CODES_V1.some((allowed) => allowed === code)
        ? code : "BRIDGE_FAILURE",
    });
  } finally {
    try { adapter?.dispose(); } catch { /* Main thread also terminates this worker. */ }
    port.close();
  }
}

function archiveBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new CatalogAdapterError("INVALID_ARCHIVE");
  }
  if (value.byteLength > MAX_ARCHIVE_BYTES) throw new CatalogAdapterError("LIMITS_EXCEEDED");
  return new Uint8Array(value);
}
