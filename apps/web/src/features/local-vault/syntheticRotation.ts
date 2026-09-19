import { CatalogAdapterError } from "../../bridge/catalogProtocol";

export const SYNTHETIC_ROTATION_COMPLETION_EVIDENCE_V1 = [
  "pending", "user_confirmed", "provider_verified",
] as const;
export type SyntheticRotationCompletionEvidenceV1 =
  (typeof SYNTHETIC_ROTATION_COMPLETION_EVIDENCE_V1)[number];

export const SYNTHETIC_ROTATION_REVOCATION_EVIDENCE_V1 = [
  "user_confirmed", "provider_verified",
] as const;
export type SyntheticRotationRevocationEvidenceV1 =
  (typeof SYNTHETIC_ROTATION_REVOCATION_EVIDENCE_V1)[number];

/** Closed synthetic fixture selection. It contains no user text or persistent ID. */
export interface SyntheticRotationSelection {
  readonly reference: number;
  readonly mcp: SyntheticRotationCompletionEvidenceV1;
  readonly cli: SyntheticRotationCompletionEvidenceV1;
  readonly ci: SyntheticRotationCompletionEvidenceV1;
  readonly supersededRevocation: SyntheticRotationRevocationEvidenceV1;
}

const SELECTION_FIELDS = Object.freeze([
  "reference", "mcp", "cli", "ci", "supersededRevocation",
] as const);

/**
 * Snapshot an exact closed selection without invoking accessors or coercion.
 * A null-prototype object is accepted as a plain structured-data container;
 * arrays, class instances and every other prototype fail closed.
 */
export function parseSyntheticRotationSelection(value: unknown): SyntheticRotationSelection {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(fields);
    if (keys.length !== SELECTION_FIELDS.length
        || keys.some((key) => typeof key !== "string" || !SELECTION_FIELDS.includes(key as never))) {
      throw new Error();
    }
    const read = (key: (typeof SELECTION_FIELDS)[number]): unknown => {
      const descriptor = fields[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
      return descriptor.value;
    };
    const reference = read("reference");
    const mcp = read("mcp");
    const cli = read("cli");
    const ci = read("ci");
    const supersededRevocation = read("supersededRevocation");
    if (typeof reference !== "number" || !Number.isSafeInteger(reference)
        || Object.is(reference, -0) || reference < 0 || reference > 127) throw new Error();
    if (!isCompletionEvidence(mcp) || !isCompletionEvidence(cli) || !isCompletionEvidence(ci)
        || !isRevocationEvidence(supersededRevocation)) throw new Error();
    return Object.freeze({ reference, mcp, cli, ci, supersededRevocation });
  } catch {
    throw new CatalogAdapterError("INVALID_ARCHIVE");
  }
}

function isCompletionEvidence(value: unknown): value is SyntheticRotationCompletionEvidenceV1 {
  return typeof value === "string"
    && SYNTHETIC_ROTATION_COMPLETION_EVIDENCE_V1.some((allowed) => allowed === value);
}

function isRevocationEvidence(value: unknown): value is SyntheticRotationRevocationEvidenceV1 {
  return typeof value === "string"
    && SYNTHETIC_ROTATION_REVOCATION_EVIDENCE_V1.some((allowed) => allowed === value);
}
