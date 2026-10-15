import { CatalogAdapterError } from "./catalogProtocol";
import { ROTATION_FIXTURES_V1, type RotationFixtureV1 } from "./rotationProtocol";

export const ROTATION_STAGE_EVIDENCE_V1 = [
  "pending", "user_confirmed", "provider_verified",
] as const;
export type RotationStageEvidenceV1 = (typeof ROTATION_STAGE_EVIDENCE_V1)[number];
export type RotationStageBaseGenerationV1 = "initial_0001" | "rotated_0002";
export type RotationStageTargetGenerationV1 = "rotated_0002" | "terminal_0003";

export interface LocalRotationStageEntryV1 {
  readonly fixture: RotationFixtureV1;
  readonly requiredForCutover: boolean;
  readonly completion: RotationStageEvidenceV1;
}

/** Authenticated saved progress, never authorization to perform final cutover. */
export interface LocalRotationStageV1 {
  readonly baseGeneration: RotationStageBaseGenerationV1;
  readonly targetGeneration: RotationStageTargetGenerationV1;
  readonly entries: readonly LocalRotationStageEntryV1[];
  readonly revocation: RotationStageEvidenceV1;
  readonly remainingRequired: number;
  readonly remainingOptional: number;
  readonly readyForCutover: boolean;
}

export interface WasmRotationStageV1 {
  isLocked(): boolean;
  lock(): void;
  free(): void;
  baseGeneration(): string;
  targetGeneration(): string;
  entryCount(): number;
  entryFixture(index: number): string;
  entryRequiredForCutover(index: number): boolean;
  entryCompletion(index: number): string;
  revocation(): string;
  remainingRequired(): number;
  remainingOptional(): number;
  readyForCutover(): boolean;
}

/** Undefined means authenticated absence; null and every other shape are invalid. */
export type WasmRotationStageFactory = () =>
  WasmRotationStageV1 | undefined | Promise<WasmRotationStageV1 | undefined>;

const STAGE_FIELDS = [
  "baseGeneration", "targetGeneration", "entries", "revocation",
  "remainingRequired", "remainingOptional", "readyForCutover",
] as const;
const ENTRY_FIELDS = ["fixture", "requiredForCutover", "completion"] as const;
class StageProjectionLimitError extends Error {}

/** Rebuild an exact, bounded, deeply frozen structured-data allowlist. */
export function projectRotationStageV1(value: unknown): LocalRotationStageV1 {
  try {
    const fields = exactFields(value, STAGE_FIELDS);
    const baseGeneration = member(fields.baseGeneration, ["initial_0001", "rotated_0002"] as const);
    const targetGeneration = member(fields.targetGeneration, ["rotated_0002", "terminal_0003"] as const);
    if (targetGeneration !== (baseGeneration === "initial_0001" ? "rotated_0002" : "terminal_0003")) {
      throw new Error();
    }
    const revocation = member(fields.revocation, ROTATION_STAGE_EVIDENCE_V1);
    const remainingRequired = count(fields.remainingRequired);
    const remainingOptional = count(fields.remainingOptional);
    if (typeof fields.readyForCutover !== "boolean") throw new Error();
    const rawEntries = fields.entries;
    if (!Array.isArray(rawEntries) || Object.getPrototypeOf(rawEntries) !== Array.prototype) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(rawEntries);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(rawEntries, "length");
    const length = count(lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined);
    if (Reflect.ownKeys(descriptors).length !== length + 1) throw new Error();
    const entries: LocalRotationStageEntryV1[] = [];
    const seen = new Set<RotationFixtureV1>();
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
      const entry = exactFields(descriptor.value, ENTRY_FIELDS);
      const fixture = member(entry.fixture, ROTATION_FIXTURES_V1);
      if (seen.has(fixture) || typeof entry.requiredForCutover !== "boolean") throw new Error();
      seen.add(fixture);
      entries.push(Object.freeze({
        fixture,
        requiredForCutover: entry.requiredForCutover,
        completion: member(entry.completion, ROTATION_STAGE_EVIDENCE_V1),
      }));
    }
    const requiredPending = entries.filter((entry) => entry.requiredForCutover && entry.completion === "pending").length;
    const optionalPending = entries.filter((entry) => !entry.requiredForCutover && entry.completion === "pending").length;
    if (remainingRequired !== requiredPending || remainingOptional !== optionalPending
        || (remainingRequired > 0 && revocation !== "pending")
        || fields.readyForCutover !== (remainingRequired === 0 && revocation !== "pending")) throw new Error();
    return Object.freeze({
      baseGeneration, targetGeneration, entries: Object.freeze(entries), revocation,
      remainingRequired, remainingOptional, readyForCutover: fields.readyForCutover,
    });
  } catch (error: unknown) {
    let limit = false;
    try { limit = error instanceof StageProjectionLimitError; } catch { /* Reject hostile thrown values. */ }
    throw new CatalogAdapterError(limit ? "LIMITS_EXCEEDED" : "INVALID_CATALOG");
  }
}

function exactFields<const T extends readonly string[]>(value: unknown, allowed: T): Record<T[number], unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
  const fields = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(fields);
  if (keys.length !== allowed.length || keys.some((key) => typeof key !== "string" || !allowed.includes(key as never))) {
    throw new Error();
  }
  for (const key of allowed) {
    const descriptor = fields[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
  }
  return Object.fromEntries(allowed.map((key) => [key, fields[key]!.value])) as Record<T[number], unknown>;
}

function member<const T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.some((item) => item === value)) throw new Error();
  return value as T;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) throw new Error();
  if (value > 3) throw new StageProjectionLimitError();
  return value;
}
