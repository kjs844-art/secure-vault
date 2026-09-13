import {
  CATALOG_CONNECTION_TYPES_V1, CATALOG_CREDENTIAL_TYPES_V1, CATALOG_ERROR_CODES_V1, CATALOG_STATUSES_V1,
  CatalogAdapterError, type CatalogCredentialTypeV1, type CatalogErrorCodeV1,
  type CatalogStatusV1, type LocalCatalogEntryV1, type WasmCatalogFactory,
  type WasmCatalogV1, type LocalCatalogConnectionV1, type CatalogConnectionTypeV1,
} from "./catalogProtocol";

const EMPTY_ENTRIES: readonly LocalCatalogEntryV1[] = Object.freeze([]);
const utf8 = new TextEncoder();

/**
 * Owns one Rust handle and an allowlisted local UI copy. lock() clears owned
 * references and invalidates pending loads. It cannot erase JS strings or
 * caller-held rows; the UI must clear its own state and DOM too.
 * The current factory is the synthetic-demo WASM export.
 */
export class WasmCatalogAdapter {
  readonly #factory: WasmCatalogFactory;
  #generation = 0;
  #disposed = false;
  #catalog: WasmCatalogV1 | undefined;
  #entries: readonly LocalCatalogEntryV1[] = EMPTY_ENTRIES;

  constructor(factory: WasmCatalogFactory) {
    this.#factory = factory;
  }

  get isLocked(): boolean { return this.#catalog === undefined; }
  get entries(): readonly LocalCatalogEntryV1[] { return this.#entries; }

  /** Newer loads, lock, and dispose prevent stale async results reappearing. */
  async load(): Promise<readonly LocalCatalogEntryV1[]> {
    if (this.#disposed) throw new CatalogAdapterError("DISPOSED");
    const generation = ++this.#generation;
    this.#clearActive();
    let candidate: WasmCatalogV1 | undefined;
    try {
      candidate = await this.#factory();
      this.#assertCurrent(generation);
      if (candidate.isLocked()) throw new CatalogAdapterError("LOCKED");
      const length = count(candidate.length(), 5_000);
      const entries: LocalCatalogEntryV1[] = [];
      for (let reference = 0; reference < length; reference += 1) {
        entries.push(readEntry(candidate, reference));
      }
      this.#assertCurrent(generation);
      if (candidate.isLocked()) throw new CatalogAdapterError("LOCKED");
      this.#catalog = candidate;
      candidate = undefined;
      this.#entries = Object.freeze(entries);
      return this.#entries;
    } catch (error: unknown) {
      if (candidate !== undefined) releaseCatalog(candidate);
      this.#assertCurrent(generation);
      throw sanitizeError(error);
    }
  }

  lock(): void {
    this.#generation += 1;
    this.#clearActive();
  }

  /** Permanent teardown; create a new adapter for a later mounted session. */
  dispose(): void {
    this.#disposed = true;
    this.lock();
  }

  #assertCurrent(generation: number): void {
    if (this.#disposed || generation !== this.#generation) {
      throw new CatalogAdapterError("CANCELLED");
    }
  }

  #clearActive(): void {
    const previous = this.#catalog;
    this.#catalog = undefined;
    this.#entries = EMPTY_ENTRIES;
    if (previous !== undefined) releaseCatalog(previous);
  }
}

function readEntry(catalog: WasmCatalogV1, reference: number): LocalCatalogEntryV1 {
  const itemName = text(catalog.itemName(reference), 128, true);
  const providerName = text(catalog.providerName(reference), 256, false);
  const credentialType = catalog.credentialType(reference);
  const status = catalog.status(reference);
  if (!CATALOG_CREDENTIAL_TYPES_V1.some((value) => value === credentialType)) {
    throw new CatalogAdapterError("INVALID_CATALOG");
  }
  if (!CATALOG_STATUSES_V1.some((value) => value === status)) {
    throw new CatalogAdapterError("INVALID_CATALOG");
  }
  const connectionCount = count(catalog.connectionCount(reference), 128);
  const secretFieldCount = count(catalog.secretFieldCount(reference), 16);
  const mcpConnectionCount = count(catalog.mcpConnectionCount(reference), connectionCount);
  if (secretFieldCount === 0) throw new CatalogAdapterError("INVALID_CATALOG");
  const connections: LocalCatalogConnectionV1[] = [];
  for (let index = 0; index < connectionCount; index += 1) {
    const label = text(catalog.connectionLabel(reference, index), 256, false);
    const consumerType = catalog.connectionType(reference, index);
    if (!CATALOG_CONNECTION_TYPES_V1.some((value) => value === consumerType)) {
      throw new CatalogAdapterError("INVALID_CATALOG");
    }
    connections.push(Object.freeze({label, consumerType: consumerType as CatalogConnectionTypeV1}));
  }
  if (connections.filter((connection) => connection.consumerType === "mcp_server").length !== mcpConnectionCount) {
    throw new CatalogAdapterError("INVALID_CATALOG");
  }
  // Construct the allowlist explicitly. Never spread a generated object here.
  return Object.freeze({
    reference, itemName, providerName,
    credentialType: credentialType as CatalogCredentialTypeV1,
    status: status as CatalogStatusV1,
    connectionCount, secretFieldCount, mcpConnectionCount, connections: Object.freeze(connections),
  });
}

function count(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CatalogAdapterError("INVALID_CATALOG");
  }
  if (value > maximum) throw new CatalogAdapterError("LIMITS_EXCEEDED");
  return value;
}

function text(value: string, maximumBytes: number, required: boolean): string {
  if (typeof value !== "string" || (required && value.length === 0)) {
    throw new CatalogAdapterError("INVALID_CATALOG");
  }
  if (utf8.encode(value).byteLength > maximumBytes) {
    throw new CatalogAdapterError("LIMITS_EXCEEDED");
  }
  return value;
}

function releaseCatalog(catalog: WasmCatalogV1): void {
  let failed = false;
  try { catalog.lock(); } catch { failed = true; }
  try { catalog.free(); } catch { failed = true; }
  if (failed) throw new CatalogAdapterError("CLEANUP_FAILED");
}

function sanitizeError(error: unknown): CatalogAdapterError {
  let code: unknown;
  try {
    code = error instanceof CatalogAdapterError ? error.code : error;
  } catch {
    return new CatalogAdapterError("BRIDGE_FAILURE");
  }
  if (typeof code === "string" && CATALOG_ERROR_CODES_V1.some((value) => value === code)) {
    return new CatalogAdapterError(code as CatalogErrorCodeV1);
  }
  return new CatalogAdapterError("BRIDGE_FAILURE");
}
