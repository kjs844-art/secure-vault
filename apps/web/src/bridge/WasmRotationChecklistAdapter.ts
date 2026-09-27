import {
  CATALOG_ERROR_CODES_V1,
  CatalogAdapterError,
  type CatalogErrorCodeV1,
} from "./catalogProtocol";
import {
  projectRotationChecklistV1,
  type LocalRotationChecklistV1,
  type WasmRotationChecklistFactory,
  type WasmRotationChecklistV1,
} from "./rotationProtocol";

/**
 * Owns generated checklist handles only while projecting them. Every resolved
 * handle is locked and freed before a plain checklist can be published.
 */
export class WasmRotationChecklistAdapter {
  readonly #factory: WasmRotationChecklistFactory;
  #generation = 0;
  #disposed = false;
  #checklist: LocalRotationChecklistV1 | undefined;

  constructor(factory: WasmRotationChecklistFactory) {
    this.#factory = factory;
  }

  get isLocked(): boolean { return this.#checklist === undefined; }
  get checklist(): LocalRotationChecklistV1 | undefined { return this.#checklist; }

  async load(): Promise<LocalRotationChecklistV1> {
    if (this.#disposed) throw new CatalogAdapterError("DISPOSED");
    const generation = ++this.#generation;
    this.#checklist = undefined;
    let candidate: WasmRotationChecklistV1 | undefined;
    try {
      candidate = await this.#factory();
      this.#assertCurrent(generation);
      if (readLockedState(candidate)) throw new CatalogAdapterError("LOCKED");
      const entryCount = boundedEntryCount(candidate.entryCount());
      const entries: Array<{ fixture: string; requiredForCutover: boolean }> = [];
      for (let index = 0; index < entryCount; index += 1) {
        entries.push({
          fixture: candidate.entryFixture(index),
          requiredForCutover: candidate.entryRequiredForCutover(index),
        });
      }
      const projected = projectRotationChecklistV1({
        generation: candidate.generation(),
        readinessState: candidate.readinessState(),
        entries,
        remainingRequired: candidate.remainingRequired(),
        remainingOptional: candidate.remainingOptional(),
      });
      this.#assertCurrent(generation);
      if (readLockedState(candidate)) throw new CatalogAdapterError("LOCKED");
      const completed = candidate;
      candidate = undefined;
      releaseChecklist(completed);
      this.#assertCurrent(generation);
      this.#checklist = projected;
      return projected;
    } catch (error: unknown) {
      let cleanupFailure: CatalogAdapterError | undefined;
      if (candidate !== undefined) {
        try { releaseChecklist(candidate); }
        catch { cleanupFailure = new CatalogAdapterError("CLEANUP_FAILED"); }
      }
      if (cleanupFailure) throw cleanupFailure;
      this.#assertCurrent(generation);
      throw sanitizeError(error);
    }
  }

  lock(): void {
    this.#generation += 1;
    this.#checklist = undefined;
  }

  dispose(): void {
    this.#disposed = true;
    this.lock();
  }

  #assertCurrent(generation: number): void {
    if (this.#disposed || generation !== this.#generation) {
      throw new CatalogAdapterError("CANCELLED");
    }
  }
}

function readLockedState(checklist: WasmRotationChecklistV1): boolean {
  const locked = checklist.isLocked();
  if (typeof locked !== "boolean") {
    throw new CatalogAdapterError("INVALID_CATALOG");
  }
  return locked;
}

function boundedEntryCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) {
    throw new CatalogAdapterError("INVALID_CATALOG");
  }
  if (value > 3) throw new CatalogAdapterError("LIMITS_EXCEEDED");
  return value;
}

/** Always attempt both operations, in order, without exposing cleanup details. */
function releaseChecklist(checklist: WasmRotationChecklistV1): void {
  let failed = false;
  try { checklist.lock(); } catch { failed = true; }
  try { checklist.free(); } catch { failed = true; }
  if (failed) throw new CatalogAdapterError("CLEANUP_FAILED");
}

function sanitizeError(error: unknown): CatalogAdapterError {
  let code: unknown;
  try { code = error instanceof CatalogAdapterError ? error.code : error; }
  catch { return new CatalogAdapterError("BRIDGE_FAILURE"); }
  if (typeof code === "string" && CATALOG_ERROR_CODES_V1.some((allowed) => allowed === code)) {
    return new CatalogAdapterError(code as CatalogErrorCodeV1);
  }
  return new CatalogAdapterError("BRIDGE_FAILURE");
}
