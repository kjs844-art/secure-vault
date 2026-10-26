/** Pure form boundary, not a decision, authority, clock or transport.
 * Dates retain their stated precision/offset. Numeric precision here means
 * equality with String(number)'s decimal value, not arbitrary-precision money. */
import { createReviewPreviewRequest, type ReviewRequestValues } from "./review-client/requests.ts";

export type ReviewDraftFields = { readonly [Key in keyof ReviewRequestValues]: string };
export type ReviewDraftParseResult = Readonly<{ kind: "valid"; values: ReviewRequestValues }>
  | Readonly<{ kind: "invalid" }>;
const KEYS = ["name", "kind", "unit", "grantedAmount", "remainingAmount", "trialDaysStated",
  "remainingDaysStated", "expiresAt", "observedAt"] as const;
const LIMITS: { readonly [Key in keyof ReviewDraftFields]: number } = { name: 160, kind: 10, unit: 40, grantedAmount: 64,
  remainingAmount: 64, trialDaysStated: 64, remainingDaysStated: 64, expiresAt: 40, observedAt: 40 };
// No leading sign, leading zero, padding, implicit radix or partial conversion.
// Exponent minus is needed to roundtrip String(number) for small finite values.
const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?(?:e(-?(?:0|[1-9]\d*)))?$/;

function validate(input: unknown): ReviewRequestValues {
  // Only reuse the existing value contract; these public IDs never leave here.
  return createReviewPreviewRequest("synthetic-form-candidate", 1, "synthetic-form-service", 1, input).body.values;
}
function readFields(input: unknown): ReviewDraftFields {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== KEYS.length || keys.some((key) => typeof key !== "string" || !KEYS.includes(key as typeof KEYS[number]))) {
    throw new Error();
  }
  const result = Object.create(null) as { -readonly [Key in keyof ReviewDraftFields]: string };
  for (const key of KEYS) {
    const field = descriptors[key];
    if (!field || !field.enumerable || !Object.hasOwn(field, "value")
      || typeof field.value !== "string" || field.value.length > LIMITS[key]) throw new Error();
    result[key] = field.value as string;
  }
  return result;
}
function normalizedDecimal(value: string): string {
  const match = DECIMAL.exec(value);
  if (!match) throw new Error();
  const fraction = match[2] ?? "";
  const coefficient = (match[1]! + fraction).replace(/^0+/, "");
  if (!coefficient) return "0";
  const reduced = coefficient.replace(/0+$/, "");
  const exponent = BigInt(match[3] ?? "0") - BigInt(fraction.length) + BigInt(coefficient.length - reduced.length);
  return `${reduced}e${exponent}`;
}
function numberField(value: string): number | null {
  if (value === "") return null;
  const source = normalizedDecimal(value), parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER
    || source !== normalizedDecimal(String(parsed))) throw new Error();
  return parsed;
}
function nullableText(value: string): string | null { return value === "" ? null : value; }

/** Blank nullable fields mean unknown, never zero. All errors are deliberately
 * content-free. Reflection may invoke Proxy traps; this is not a JS sandbox. */
export function parseReviewDraftFields(input: unknown): ReviewDraftParseResult {
  try {
    const fields = readFields(input);
    const values = validate({ name: fields.name, kind: fields.kind, unit: nullableText(fields.unit),
      grantedAmount: numberField(fields.grantedAmount), remainingAmount: numberField(fields.remainingAmount),
      trialDaysStated: numberField(fields.trialDaysStated), remainingDaysStated: numberField(fields.remainingDaysStated),
      expiresAt: nullableText(fields.expiresAt), observedAt: nullableText(fields.observedAt) });
    return Object.freeze({ kind: "valid", values });
  } catch { return Object.freeze({ kind: "invalid" }); }
}

/** Accept values, not a request/DTO. Existing numeric -0 is displayed as 0;
 * parsing a textual -0 is invalid. No input object is retained or modified. */
export function toReviewDraftFields(input: unknown): ReviewDraftFields | null {
  try {
    const values = validate(input);
    const numeric = (value: number | null): string => value === null ? "" : String(value);
    return Object.freeze({ name: values.name, kind: values.kind, unit: values.unit ?? "",
      grantedAmount: numeric(values.grantedAmount), remainingAmount: numeric(values.remainingAmount),
      trialDaysStated: numeric(values.trialDaysStated), remainingDaysStated: numeric(values.remainingDaysStated),
      expiresAt: values.expiresAt ?? "", observedAt: values.observedAt ?? "" });
  } catch { return null; }
}
