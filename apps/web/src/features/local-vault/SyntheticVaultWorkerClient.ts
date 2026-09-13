import {
  CATALOG_CONNECTION_TYPES_V1, CATALOG_CREDENTIAL_TYPES_V1, CATALOG_ERROR_CODES_V1,
  CATALOG_STATUSES_V1, CatalogAdapterError, type CatalogErrorCodeV1,
  type LocalCatalogConnectionV1, type LocalCatalogEntryV1,
} from "../../bridge/catalogProtocol";

export const SYNTHETIC_ARCHIVE_MAX_BYTES = 524_288;
export const SYNTHETIC_WORKER_TIMEOUT_MS = 90_000;

/** Injectable worker surface; importing this module does not start a worker. */
export interface SyntheticVaultWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

type WorkerFactory = () => SyntheticVaultWorkerPort;
type Request = { op: "create" } | { op: "open"; bytes: Uint8Array };
const utf8 = new TextEncoder();

/** One fresh worker per operation; cancel/replace terminates expensive KDF work. */
export class BrowserSyntheticVaultWorker {
  readonly #factory: WorkerFactory;
  #cancelPending: (() => void) | undefined;

  constructor(factory: WorkerFactory = () => new Worker(
    new URL("./syntheticVault.worker.ts", import.meta.url), { type: "module" },
  )) {
    this.#factory = factory;
  }

  create(): Promise<Uint8Array> {
    return this.#run({ op: "create" }, (data) => {
      if (data.kind !== "archive") throw new CatalogAdapterError("BRIDGE_FAILURE");
      return copyArchive(data.bytes);
    });
  }

  async open(bytes: Uint8Array): Promise<readonly LocalCatalogEntryV1[]> {
    this.cancel();
    // Copy before dispatch without detaching/mutating the caller's stored bytes.
    const input = copyArchive(bytes);
    return this.#run({ op: "open", bytes: input }, (data) => {
      if (data.kind !== "catalog") throw new CatalogAdapterError("BRIDGE_FAILURE");
      return projectRows(data.entries);
    });
  }

  cancel(): void { this.#cancelPending?.(); }

  #run<T>(request: Request, project: (data: Record<string, unknown>) => T): Promise<T> {
    this.cancel();
    return new Promise<T>((resolve, reject) => {
      let worker: SyntheticVaultWorkerPort;
      try { worker = this.#factory(); }
      catch { reject(new CatalogAdapterError("BRIDGE_FAILURE")); return; }

      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        try { worker.terminate(); } catch { /* Do not expose worker error details. */ }
        if (this.#cancelPending === cancel) this.#cancelPending = undefined;
        return true;
      };
      const fail = (code: CatalogErrorCodeV1): void => {
        if (finish()) reject(new CatalogAdapterError(code));
      };
      const cancel = (): void => fail("CANCELLED");
      this.#cancelPending = cancel;
      worker.onmessage = (event) => {
        if (settled) return;
        try {
          const data = object(event.data, "BRIDGE_FAILURE");
          if (data.ok === false) throw new CatalogAdapterError(safeCode(data.code));
          if (data.ok !== true) throw new CatalogAdapterError("BRIDGE_FAILURE");
          const result = project(data);
          if (finish()) resolve(result);
        } catch (error: unknown) {
          fail(error instanceof CatalogAdapterError ? safeCode(error.code) : "BRIDGE_FAILURE");
        }
      };
      worker.onerror = () => fail("BRIDGE_FAILURE");
      worker.onmessageerror = () => fail("BRIDGE_FAILURE");
      timeout = setTimeout(() => fail("BRIDGE_FAILURE"), SYNTHETIC_WORKER_TIMEOUT_MS);
      try { worker.postMessage(request); }
      catch { fail("BRIDGE_FAILURE"); }
    });
  }
}

function safeCode(value: unknown): CatalogErrorCodeV1 {
  return typeof value === "string" && CATALOG_ERROR_CODES_V1.some((code) => code === value)
    ? value as CatalogErrorCodeV1 : "BRIDGE_FAILURE";
}

function copyArchive(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new CatalogAdapterError("INVALID_ARCHIVE");
  }
  if (value.byteLength > SYNTHETIC_ARCHIVE_MAX_BYTES) {
    throw new CatalogAdapterError("LIMITS_EXCEEDED");
  }
  return new Uint8Array(value);
}

function object(value: unknown, code: CatalogErrorCodeV1 = "INVALID_CATALOG"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogAdapterError(code);
  }
  return value as Record<string, unknown>;
}

function count(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CatalogAdapterError("INVALID_CATALOG");
  }
  if (value > maximum) throw new CatalogAdapterError("LIMITS_EXCEEDED");
  return value;
}

function text(value: unknown, maximumBytes: number, required = false): string {
  if (typeof value !== "string" || (required && value.length === 0)) {
    throw new CatalogAdapterError("INVALID_CATALOG");
  }
  if (value.length > maximumBytes || utf8.encode(value).byteLength > maximumBytes) {
    throw new CatalogAdapterError("LIMITS_EXCEEDED");
  }
  return value;
}

function member<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.some((candidate) => candidate === value)) {
    throw new CatalogAdapterError("INVALID_CATALOG");
  }
  return value as T;
}

/** Structured cloning removes freezing, so validate and reconstruct at the UI boundary. */
function projectRows(value: unknown): readonly LocalCatalogEntryV1[] {
  if (!Array.isArray(value)) throw new CatalogAdapterError("INVALID_CATALOG");
  count(value.length, 5_000);
  const rows: LocalCatalogEntryV1[] = [];
  for (let reference = 0; reference < value.length; reference += 1) {
    const row = object(value[reference]);
    if (row.reference !== reference) throw new CatalogAdapterError("INVALID_CATALOG");
    const itemName = text(row.itemName, 128, true);
    const providerName = text(row.providerName, 256);
    const credentialType = member(row.credentialType, CATALOG_CREDENTIAL_TYPES_V1);
    const status = member(row.status, CATALOG_STATUSES_V1);
    const connectionCount = count(row.connectionCount, 128);
    const secretFieldCount = count(row.secretFieldCount, 16);
    const mcpConnectionCount = count(row.mcpConnectionCount, connectionCount);
    if (secretFieldCount === 0 || !Array.isArray(row.connections)
        || row.connections.length !== connectionCount) {
      throw new CatalogAdapterError("INVALID_CATALOG");
    }
    const connections: LocalCatalogConnectionV1[] = [];
    for (let index = 0; index < connectionCount; index += 1) {
      // Indexed reads also reject holes; Array.map would silently preserve them.
      const connection = object(row.connections[index]);
      connections.push(Object.freeze({
        label: text(connection.label, 256),
        consumerType: member(connection.consumerType, CATALOG_CONNECTION_TYPES_V1),
      }));
    }
    if (connections.filter((connection) => connection.consumerType === "mcp_server").length !== mcpConnectionCount) {
      throw new CatalogAdapterError("INVALID_CATALOG");
    }
    // Never spread or publish an untrusted message object, even after validation.
    rows.push(Object.freeze({
      reference, itemName, providerName, credentialType, status,
      connectionCount, secretFieldCount, mcpConnectionCount,
      connections: Object.freeze(connections),
    }));
  }
  return Object.freeze(rows);
}
