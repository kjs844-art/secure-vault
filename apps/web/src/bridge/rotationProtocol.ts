import { CatalogAdapterError } from "./catalogProtocol";

export const ROTATION_GENERATIONS_V1 = [
  "initial_0001", "rotated_0002", "terminal_0003",
] as const;
export type RotationGenerationV1 = (typeof ROTATION_GENERATIONS_V1)[number];

export const ROTATION_READINESS_STATES_V1 = [
  "required_pending", "ready", "terminal",
] as const;
export type RotationReadinessStateV1 = (typeof ROTATION_READINESS_STATES_V1)[number];

export const ROTATION_FIXTURES_V1 = ["mcp", "cli", "ci"] as const;
export type RotationFixtureV1 = (typeof ROTATION_FIXTURES_V1)[number];

export interface LocalRotationChecklistEntryV1 {
  readonly fixture: RotationFixtureV1;
  readonly requiredForCutover: boolean;
}

/** Fixed, local-only projection. It deliberately contains no text or identifiers. */
export interface LocalRotationChecklistV1 {
  readonly generation: RotationGenerationV1;
  readonly readinessState: RotationReadinessStateV1;
  readonly entries: readonly LocalRotationChecklistEntryV1[];
  readonly remainingRequired: number;
  readonly remainingOptional: number;
}

/** Structural contract of the generated Rust WasmRotationChecklistV1 class. */
export interface WasmRotationChecklistV1 {
  isLocked(): boolean;
  lock(): void;
  free(): void;
  generation(): string;
  readinessState(): string;
  entryCount(): number;
  entryFixture(index: number): string;
  entryRequiredForCutover(index: number): boolean;
  remainingRequired(): number;
  remainingOptional(): number;
}

/** Each invocation transfers exclusive ownership of a fresh handle. */
export type WasmRotationChecklistFactory = () =>
  WasmRotationChecklistV1 | Promise<WasmRotationChecklistV1>;

const CHECKLIST_FIELDS = Object.freeze([
  "generation", "readinessState", "entries", "remainingRequired", "remainingOptional",
] as const);
const ENTRY_FIELDS = Object.freeze(["fixture", "requiredForCutover"] as const);
class RotationProjectionLimitError extends Error {}

/**
 * Revalidate a structured-cloned Worker result and rebuild an exact frozen
 * allowlist. This function never retains the supplied object or nested array.
 */
export function projectRotationChecklistV1(value: unknown): LocalRotationChecklistV1 {
  try {
    const fields = exactDataFields(value, CHECKLIST_FIELDS);
    const generation = member(fields.generation, ROTATION_GENERATIONS_V1);
    const readinessState = member(fields.readinessState, ROTATION_READINESS_STATES_V1);
    const remainingRequired = count(fields.remainingRequired);
    const remainingOptional = count(fields.remainingOptional);
    const rawEntries = fields.entries;
    if (!Array.isArray(rawEntries) || Object.getPrototypeOf(rawEntries) !== Array.prototype) {
      throw new Error();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(rawEntries, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 3) {
      throw new RotationProjectionLimitError();
    }
    const arrayFields = Object.getOwnPropertyDescriptors(rawEntries);
    if (Reflect.ownKeys(arrayFields).length !== length + 1) throw new Error();

    const entries: LocalRotationChecklistEntryV1[] = [];
    const seen = new Set<RotationFixtureV1>();
    for (let index = 0; index < length; index += 1) {
      const descriptor = arrayFields[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
      const entryFields = exactDataFields(descriptor.value, ENTRY_FIELDS);
      const fixture = member(entryFields.fixture, ROTATION_FIXTURES_V1);
      if (seen.has(fixture)) throw new Error();
      seen.add(fixture);
      if (typeof entryFields.requiredForCutover !== "boolean") throw new Error();
      entries.push(Object.freeze({
        fixture,
        requiredForCutover: entryFields.requiredForCutover,
      }));
    }
    validateState(generation, readinessState, entries, remainingRequired, remainingOptional);
    return Object.freeze({
      generation,
      readinessState,
      entries: Object.freeze(entries),
      remainingRequired,
      remainingOptional,
    });
  } catch (error: unknown) {
    let limitsExceeded = false;
    try { limitsExceeded = error instanceof RotationProjectionLimitError; }
    catch { /* A hostile thrown Proxy is still invalid, never a limit proof. */ }
    throw new CatalogAdapterError(limitsExceeded ? "LIMITS_EXCEEDED" : "INVALID_CATALOG");
  }
}

function exactDataFields<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): Record<T[number], unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
  const fields = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(fields);
  if (keys.length !== allowed.length
      || keys.some((key) => typeof key !== "string" || !allowed.includes(key as never))) throw new Error();
  for (const key of allowed) {
    const descriptor = fields[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
  }
  return Object.fromEntries(allowed.map((key) => [key, fields[key]!.value])) as Record<T[number], unknown>;
}

function member<const T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.some((candidate) => candidate === value)) throw new Error();
  return value as T;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) {
    throw new Error();
  }
  if (value > 3) throw new RotationProjectionLimitError();
  return value;
}

function validateState(
  generation: RotationGenerationV1,
  readiness: RotationReadinessStateV1,
  entries: readonly LocalRotationChecklistEntryV1[],
  remainingRequired: number,
  remainingOptional: number,
): void {
  const terminalGeneration = generation === "terminal_0003";
  if ((readiness === "terminal") !== terminalGeneration) throw new Error();
  if (terminalGeneration) {
    if (remainingRequired !== 0 || remainingOptional !== 0) throw new Error();
    return;
  }
  const requiredCount = entries.filter((entry) => entry.requiredForCutover).length;
  const optionalCount = entries.length - requiredCount;
  if (readiness === "required_pending") {
    if (remainingRequired < 1 || remainingRequired > requiredCount || remainingOptional !== 0) {
      throw new Error();
    }
    return;
  }
  if (readiness !== "ready" || remainingRequired !== 0 || remainingOptional > optionalCount) {
    throw new Error();
  }
}
