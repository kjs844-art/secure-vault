import { CATALOG_ERROR_CODES_V1, CatalogAdapterError, type CatalogErrorCodeV1 } from "./catalogProtocol";
import {
  projectRotationStageV1, type LocalRotationStageV1,
  type WasmRotationStageFactory, type WasmRotationStageV1,
} from "./rotationStageProtocol";

/** Owns each generated handle until cleanup succeeds; publishes no WASM object. */
export class WasmRotationStageAdapter {
  readonly #factory: WasmRotationStageFactory;
  #generation = 0;
  #disposed = false;
  #stage: LocalRotationStageV1 | null | undefined;

  constructor(factory: WasmRotationStageFactory) { this.#factory = factory; }
  get isLocked(): boolean { return this.#stage === undefined; }
  get stage(): LocalRotationStageV1 | null | undefined { return this.#stage; }

  async load(): Promise<LocalRotationStageV1 | null> {
    if (this.#disposed) throw new CatalogAdapterError("DISPOSED");
    const generation = ++this.#generation;
    this.#stage = undefined;
    let candidate: WasmRotationStageV1 | undefined;
    try {
      candidate = await this.#factory();
      this.#assertCurrent(generation);
      if (candidate === undefined) {
        this.#stage = null;
        return null;
      }
      if (readLocked(candidate)) throw new CatalogAdapterError("LOCKED");
      const entryCount = candidate.entryCount();
      if (typeof entryCount !== "number" || !Number.isSafeInteger(entryCount)
          || Object.is(entryCount, -0) || entryCount < 0) throw new CatalogAdapterError("INVALID_CATALOG");
      if (entryCount > 3) throw new CatalogAdapterError("LIMITS_EXCEEDED");
      const entries: Array<{ fixture: string; requiredForCutover: boolean; completion: string }> = [];
      for (let index = 0; index < entryCount; index += 1) {
        entries.push({
          fixture: candidate.entryFixture(index),
          requiredForCutover: candidate.entryRequiredForCutover(index),
          completion: candidate.entryCompletion(index),
        });
      }
      const projected = projectRotationStageV1({
        baseGeneration: candidate.baseGeneration(), targetGeneration: candidate.targetGeneration(),
        entries, revocation: candidate.revocation(), remainingRequired: candidate.remainingRequired(),
        remainingOptional: candidate.remainingOptional(), readyForCutover: candidate.readyForCutover(),
      });
      this.#assertCurrent(generation);
      if (readLocked(candidate)) throw new CatalogAdapterError("LOCKED");
      const completed = candidate;
      candidate = undefined;
      releaseStage(completed);
      this.#assertCurrent(generation);
      this.#stage = projected;
      return projected;
    } catch (error: unknown) {
      let cleanupFailed = false;
      if (candidate !== undefined) {
        try { releaseStage(candidate); } catch { cleanupFailed = true; }
      }
      if (cleanupFailed) throw new CatalogAdapterError("CLEANUP_FAILED");
      this.#assertCurrent(generation);
      throw sanitize(error);
    }
  }

  lock(): void { this.#generation += 1; this.#stage = undefined; }
  dispose(): void { this.#disposed = true; this.lock(); }
  #assertCurrent(generation: number): void {
    if (this.#disposed || generation !== this.#generation) throw new CatalogAdapterError("CANCELLED");
  }
}

function readLocked(stage: WasmRotationStageV1): boolean {
  const locked = stage.isLocked();
  if (typeof locked !== "boolean") throw new CatalogAdapterError("INVALID_CATALOG");
  return locked;
}

function releaseStage(stage: WasmRotationStageV1): void {
  let failed = false;
  try { stage.lock(); } catch { failed = true; }
  try { stage.free(); } catch { failed = true; }
  if (failed) throw new CatalogAdapterError("CLEANUP_FAILED");
}

function sanitize(error: unknown): CatalogAdapterError {
  let code: unknown;
  try { code = error instanceof CatalogAdapterError ? error.code : error; }
  catch { return new CatalogAdapterError("BRIDGE_FAILURE"); }
  return new CatalogAdapterError(typeof code === "string" && CATALOG_ERROR_CODES_V1.some((allowed) => allowed === code)
    ? code as CatalogErrorCodeV1 : "BRIDGE_FAILURE");
}
