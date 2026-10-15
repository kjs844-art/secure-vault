import init, {
  appendSyntheticRegistration, createSyntheticArchive, createSyntheticRotationCutover,
  editSyntheticConnections, inspectSyntheticRotationChecklist, openSyntheticArchive,
  inspectSyntheticRotationStage, createSyntheticRotationStage, createSyntheticRotationCutoverFromStage,
} from "../../generated/vault-wasm-demo/vault_client_wasm.js";
import { WasmCatalogAdapter } from "../../bridge/WasmCatalogAdapter";
import { WasmRotationChecklistAdapter } from "../../bridge/WasmRotationChecklistAdapter";
import { WasmRotationStageAdapter } from "../../bridge/WasmRotationStageAdapter";
import { CATALOG_ERROR_CODES_V1, CatalogAdapterError } from "../../bridge/catalogProtocol";
import { parseSyntheticRegistration } from "./syntheticRegistration";
import { parseSyntheticConnectionEdit } from "./syntheticConnectionEdit";
import {
  parseSyntheticRotationSelection, type SyntheticRotationSelection,
} from "./syntheticRotation";
import {
  parseSyntheticRotationStageReference, parseSyntheticRotationStageSelection,
  type SyntheticRotationStageSelection,
} from "./syntheticRotationStage";

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
  let stageAdapter: WasmRotationStageAdapter | undefined;
  try {
    const request = snapshotRequest(value);
    if (request.op !== "create" && request.op !== "open" && request.op !== "append"
        && request.op !== "editConnections" && request.op !== "inspectRotation"
        && request.op !== "createRotationCutover" && request.op !== "inspectRotationStage"
        && request.op !== "saveRotationStage" && request.op !== "createRotationCutoverFromStage") {
      throw new CatalogAdapterError("BRIDGE_FAILURE");
    }
    // Validate and snapshot bounded input before initialization or WASM bindings.
    const input = request.op !== "create" ? archiveBytes(request.bytes) : undefined;
    const selection = request.op === "append" ? parseSyntheticRegistration(request.selection) : undefined;
    const edit = request.op === "editConnections" ? parseSyntheticConnectionEdit(request.selection) : undefined;
    const rotation = request.op === "inspectRotation" || request.op === "createRotationCutover"
      ? parseSyntheticRotationSelection(request.selection) : undefined;
    const stageSelection = request.op === "saveRotationStage"
      ? parseSyntheticRotationStageSelection(request.selection) : undefined;
    const stageReference = request.op === "inspectRotationStage" || request.op === "createRotationCutoverFromStage"
      ? parseSyntheticRotationStageReference(request.reference) : undefined;
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
    } else if (request.op === "saveRotationStage") {
      const bytes = archiveBytes(createSyntheticRotationStage(input!, ...stageArguments(stageSelection!)));
      port.postMessage({ ok: true, kind: "archive", bytes }, [bytes.buffer as ArrayBuffer]);
    } else if (request.op === "createRotationCutoverFromStage") {
      const bytes = archiveBytes(createSyntheticRotationCutoverFromStage(input!, stageReference!));
      port.postMessage({ ok: true, kind: "archive", bytes }, [bytes.buffer as ArrayBuffer]);
    } else if (request.op === "inspectRotationStage") {
      stageAdapter = new WasmRotationStageAdapter(() => inspectSyntheticRotationStage(input!, stageReference!));
      const stage = await stageAdapter.load();
      stageAdapter.dispose();
      stageAdapter = undefined;
      port.postMessage({ ok: true, kind: "rotationStage", stage });
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
    try { stageAdapter?.dispose(); } catch { /* Main thread also terminates this worker. */ }
    port.close();
  }
}

/** Snapshot dispatch as well as payload before the asynchronous WASM initialization. */
function snapshotRequest(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CatalogAdapterError("BRIDGE_FAILURE");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new CatalogAdapterError("BRIDGE_FAILURE");
  const fields = Object.getOwnPropertyDescriptors(value);
  const op = fields.op;
  if (!op || !("value" in op) || !op.enumerable) throw new CatalogAdapterError("BRIDGE_FAILURE");
  const allowed = op.value === "create" ? ["op"]
    : op.value === "open" ? ["op", "bytes"]
    : op.value === "inspectRotationStage" || op.value === "createRotationCutoverFromStage"
      ? ["op", "bytes", "reference"] : ["op", "bytes", "selection"];
  const keys = Reflect.ownKeys(fields);
  if (keys.length !== allowed.length || keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new CatalogAdapterError("BRIDGE_FAILURE");
  }
  for (const key of allowed) {
    const descriptor = fields[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new CatalogAdapterError("BRIDGE_FAILURE");
  }
  return Object.fromEntries(allowed.map((key) => [key, fields[key]!.value]));
}

function stageArguments(selection: SyntheticRotationStageSelection): [
  number, boolean, boolean, boolean, boolean, boolean, boolean, number,
] {
  const user = (value: SyntheticRotationStageSelection["mcp"]): boolean => value === "user_confirmed";
  const provider = (value: SyntheticRotationStageSelection["mcp"]): boolean => value === "provider_verified";
  return [
    selection.reference,
    user(selection.mcp), user(selection.cli), user(selection.ci),
    provider(selection.mcp), provider(selection.cli), provider(selection.ci),
    selection.supersededRevocation === "pending" ? 0 : selection.supersededRevocation === "user_confirmed" ? 1 : 2,
  ];
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
