import { CatalogAdapterError } from "../../bridge/catalogProtocol";
import { ROTATION_STAGE_EVIDENCE_V1, type RotationStageEvidenceV1 } from "../../bridge/rotationStageProtocol";

/** Separate from one-shot rotation: saving progress deliberately permits pending revocation. */
export interface SyntheticRotationStageSelection {
  readonly reference: number;
  readonly mcp: RotationStageEvidenceV1;
  readonly cli: RotationStageEvidenceV1;
  readonly ci: RotationStageEvidenceV1;
  readonly supersededRevocation: RotationStageEvidenceV1;
}

const FIELDS = ["reference", "mcp", "cli", "ci", "supersededRevocation"] as const;

export function parseSyntheticRotationStageReference(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)
      || Object.is(value, -0) || value < 0 || value > 127) throw new CatalogAdapterError("INVALID_ARCHIVE");
  return value;
}

export function parseSyntheticRotationStageSelection(value: unknown): SyntheticRotationStageSelection {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(fields);
    if (keys.length !== FIELDS.length || keys.some((key) => typeof key !== "string" || !FIELDS.includes(key as never))) {
      throw new Error();
    }
    const read = (key: (typeof FIELDS)[number]): unknown => {
      const descriptor = fields[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
      return descriptor.value;
    };
    const reference = parseSyntheticRotationStageReference(read("reference"));
    const evidence = (key: "mcp" | "cli" | "ci" | "supersededRevocation"): RotationStageEvidenceV1 => {
      const item = read(key);
      if (typeof item !== "string" || !ROTATION_STAGE_EVIDENCE_V1.some((allowed) => allowed === item)) throw new Error();
      return item as RotationStageEvidenceV1;
    };
    return Object.freeze({
      reference, mcp: evidence("mcp"), cli: evidence("cli"), ci: evidence("ci"),
      supersededRevocation: evidence("supersededRevocation"),
    });
  } catch { throw new CatalogAdapterError("INVALID_ARCHIVE"); }
}
