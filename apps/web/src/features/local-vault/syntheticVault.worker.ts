import init, {
  appendSyntheticRegistration, createSyntheticArchive, createSyntheticRotationCutover,
  editSyntheticConnections, inspectSyntheticRotationChecklist, openSyntheticArchive,
} from "../../generated/vault-wasm-demo/vault_client_wasm.js";
import { WasmCatalogAdapter } from "../../bridge/WasmCatalogAdapter";
import { WasmRotationChecklistAdapter } from "../../bridge/WasmRotationChecklistAdapter";
import { CATALOG_ERROR_CODES_V1, CatalogAdapterError } from "../../bridge/catalogProtocol";
import { parseSyntheticRegistration } from "./syntheticRegistration";
import { parseSyntheticConnectionEdit } from "./syntheticConnectionEdit";
import {
  parseSyntheticRotationSelection, type SyntheticRotationSelection,
} from "./syntheticRotation";

// Avoid adding DOM/WebWorker conflicting globals to the application tsconfig.
interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
}
const port = self as unknown as WorkerScope;
const MAX_ARCHIVE_BYTES = 524_288;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), "byteLength",
)!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), "buffer",
)!.get!;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype, "byteLength",
)!.get!;
let started = false;

port.onmessage = (event) => {
  if (started) return;
  started = true;
  port.onmessage = null;
  void execute(event.data);
};

async function execute(value: unknown): Promise<void> {
  let adapter: WasmCatalogAdapter | undefined;
  let rotationAdapter: WasmRotationChecklistAdapter | undefined;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new CatalogAdapterError("BRIDGE_FAILURE");
    }
    const request = value as Record<string, unknown>;
    if (request.op !== "create" && request.op !== "open" && request.op !== "append"
        && request.op !== "editConnections" && request.op !== "inspectRotation"
        && request.op !== "createRotationCutover") {
      throw new CatalogAdapterError("BRIDGE_FAILURE");
    }
    // Validate and snapshot bounded input before initialization or WASM bindings.
    const input = request.op !== "create" ? archiveBytes(request.bytes) : undefined;
    const selection = request.op === "append" ? parseSyntheticRegistration(request.selection) : undefined;
    const edit = request.op === "editConnections" ? parseSyntheticConnectionEdit(request.selection) : undefined;
    const rotation = request.op === "inspectRotation" || request.op === "createRotationCutover"
      ? parseSyntheticRotationSelection(request.selection) : undefined;
    await init();
    if (request.op === "create") {
      const bytes = archiveBytes(createSyntheticArchive());
      port.postMessage({ ok: true, kind: "archive", bytes }, [bytes.buffer as ArrayBuffer]);
    } else if (request.op === "append") {
      const bytes = archiveBytes(appendSyntheticRegistration(
        input!, selection!.profileId, selection!.credentialId, new Float64Array(selection!.connectionIds),
      ));
      port.postMessage({ ok: true, kind: "archive", bytes }, [bytes.buffer as ArrayBuffer]);
    } else if (request.op === "editConnections") {
      const bytes = archiveBytes(editSyntheticConnections(input!, edit!.reference, new Float64Array(edit!.connectionIds)));
      port.postMessage({ ok: true, kind: "archive", bytes }, [bytes.buffer as ArrayBuffer]);
    } else if (request.op === "createRotationCutover") {
      const bytes = archiveBytes(createSyntheticRotationCutover(input!, ...rotationArguments(rotation!)));
      port.postMessage({ ok: true, kind: "archive", bytes }, [bytes.buffer as ArrayBuffer]);
    } else if (request.op === "inspectRotation") {
      rotationAdapter = new WasmRotationChecklistAdapter(
        () => inspectSyntheticRotationChecklist(input!, ...rotationArguments(rotation!)),
      );
      const checklist = await rotationAdapter.load();
      rotationAdapter.dispose();
      rotationAdapter = undefined;
      port.postMessage({ ok: true, kind: "rotationChecklist", checklist });
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
    try { rotationAdapter?.dispose(); } catch { /* Main thread also terminates this worker. */ }
    port.close();
  }
}

function rotationArguments(selection: SyntheticRotationSelection): [
  number, boolean, boolean, boolean, boolean, boolean, boolean, number,
] {
  const user = (value: SyntheticRotationSelection["mcp"]): boolean => value === "user_confirmed";
  const provider = (value: SyntheticRotationSelection["mcp"]): boolean => value === "provider_verified";
  return [
    selection.reference,
    user(selection.mcp), user(selection.cli), user(selection.ci),
    provider(selection.mcp), provider(selection.cli), provider(selection.ci),
    selection.supersededRevocation === "user_confirmed" ? 0 : 1,
  ];
}

function archiveBytes(value: unknown): Uint8Array {
  let length: number;
  try {
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new Error();
    const buffer = typedArrayBuffer.call(value);
    // Only ordinary ArrayBuffer-backed views can be snapshotted and later
    // transferred. Shared memory would make the copy raceable.
    arrayBufferByteLength.call(buffer);
    length = typedArrayByteLength.call(value) as number;
  } catch {
    throw new CatalogAdapterError("INVALID_ARCHIVE");
  }
  if (length < 1) throw new CatalogAdapterError("INVALID_ARCHIVE");
  if (length > MAX_ARCHIVE_BYTES) throw new CatalogAdapterError("LIMITS_EXCEEDED");
  try { return new Uint8Array(value); }
  catch { throw new CatalogAdapterError("INVALID_ARCHIVE"); }
}
