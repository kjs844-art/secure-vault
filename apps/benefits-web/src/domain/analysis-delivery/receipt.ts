import { CANDIDATE_BATCH_SAVED_SCHEMA, type AnalysisDeliveryBinding, type CandidateBatchSavedReceipt } from "./contracts";

function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(input), actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) throw new Error();
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
    output[key] = descriptor.value as unknown;
  }
  return output;
}
const identifier = (value: unknown): value is string => typeof value === "string" && value.trim() === value
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const generation = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** No accessor invocation or private-field filtering: extra fields reject the
 * whole receipt. Proxy reflection can execute; this is not a Proxy sandbox. */
export function decodeCandidateBatchSavedReceipt(input: unknown): CandidateBatchSavedReceipt | null {
  try {
    const raw = fields(input, ["schema", "state", "batchReference", "dataGeneration"]);
    if (raw.schema !== CANDIDATE_BATCH_SAVED_SCHEMA || raw.state !== "saved"
      || !identifier(raw.batchReference) || !generation(raw.dataGeneration)) return null;
    return Object.freeze({ schema: CANDIDATE_BATCH_SAVED_SCHEMA, state: "saved",
      batchReference: raw.batchReference, dataGeneration: raw.dataGeneration });
  } catch { return null; }
}

/** Internal owner input parser; its detached context is not an auth assertion. */
export function normalizeAnalysisDeliveryBinding(input: unknown): AnalysisDeliveryBinding | null {
  try {
    const raw = fields(input, ["lease", "context"]), context = fields(raw.context, ["bindingId", "dataGeneration"]);
    if (typeof raw.lease !== "object" || raw.lease === null || Array.isArray(raw.lease)
      || !identifier(context.bindingId) || !generation(context.dataGeneration)) return null;
    return Object.freeze({ lease: raw.lease, context: Object.freeze({ bindingId: context.bindingId,
      dataGeneration: context.dataGeneration }) });
  } catch { return null; }
}
