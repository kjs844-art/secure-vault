import { decodeReviewPreviewView, type ReviewPreviewView } from "../review-preview-view";
import { decodeReviewedBenefitView, type ReviewedBenefitView } from "../reviewed-benefit-view";
import { decodeReviewedBenefitPage, type ReviewedBenefitPageView } from "../reviewed-benefit-page";
import { snapshotReviewRequest, type ReviewRequest } from "./requests";

export type ReviewSuccess =
  | { readonly kind: "preview"; readonly preview: ReviewPreviewView }
  | { readonly kind: "view"; readonly view: ReviewedBenefitView }
  | { readonly kind: "page"; readonly page: ReviewedBenefitPageView }
  | { readonly kind: "rejected"; readonly previewId: string };

// Mirror the fixed HTTP vocabulary, without importing a server runtime.
const ERROR_STATUS = Object.freeze({
  API_NOT_FOUND: 404, API_METHOD_NOT_ALLOWED: 405, API_REQUEST_REJECTED: 403,
  API_MEDIA_TYPE: 415, API_BODY_TOO_LARGE: 413, API_INPUT_INVALID: 400,
  API_AUTH_REQUIRED: 401, API_SESSION_CHANGED: 403, API_RATE_LIMITED: 429,
  API_CONFLICT: 409, API_UNAVAILABLE: 503, API_TIMEOUT: 408, API_ABORTED: 408,
});
export type ReviewHttpErrorCode = keyof typeof ERROR_STATUS;
const VALUE_KEYS = ["name", "kind", "unit", "grantedAmount", "remainingAmount", "trialDaysStated",
  "remainingDaysStated", "expiresAt", "observedAt"] as const;

function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(input), actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) throw new Error();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const property = descriptors[key];
    if (!property || !Object.hasOwn(property, "value") || !property.enumerable) throw new Error();
    result[key] = property.value as unknown;
  }
  return result;
}
function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function validNow(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)
    && value >= 0 && value <= 253402300799999;
}

/**
 * Decode an entire success envelope and bind what its minimal DTO can express.
 * Input is already JSON: caller still bounds transport bytes and fences the
 * original immutable command/account/view scope before AND after decoding.
 * Reflection may run Proxy traps; this is not a sandbox or authentication check.
 * `now` is an explicit fresh consumer clock, not a server-expiry authorization.
 */
export function decodeReviewSuccess(
  input: unknown, request: ReviewRequest, dataGeneration: number, now: number,
): ReviewSuccess | null {
  if (!validGeneration(dataGeneration) || !validNow(now)) return null;
  try {
    const command = snapshotReviewRequest(request);
    const envelope = fields(input, ["ok", "value"]);
    if (envelope.ok !== true) return null;
    switch (command.action) {
      case "preview": {
        const preview = decodeReviewPreviewView(envelope.value);
        if (!preview || preview.dataGeneration !== dataGeneration || preview.expiresAt <= now
          || preview.content.serviceId !== command.body.serviceId
          || preview.content.serviceRevision !== command.body.serviceRevision
          || VALUE_KEYS.some((key) => preview.content.values[key] !== command.body.values[key])) return null;
        // Candidate identity is intentionally absent from this minimal DTO.
        return Object.freeze({ kind: "preview", preview });
      }
      case "confirm": case "get": case "delete": {
        const view = decodeReviewedBenefitView(envelope.value);
        if (!view || view.dataGeneration !== dataGeneration) return null;
        if (command.action !== "confirm" && view.benefitId !== command.body.benefitId) return null;
        if (command.action === "delete"
          && (view.outcome !== "deleted" || view.benefitRevision <= command.body.expectedRevision)) return null;
        // Confirm has neither a known new benefitId nor echoed previewId /
        // operationId / replay flag. A legitimate retry returns CURRENT state,
        // including a tombstone. Shape/generation checks cannot prove which
        // confirmation produced it; original command/transport/scope ownership
        // remains mandatory. Saved records do not inherit pending preview TTL.
        return Object.freeze({ kind: "view", view });
      }
      case "list": {
        const page = decodeReviewedBenefitPage(envelope.value);
        if (!page || page.dataGeneration !== dataGeneration || page.benefits.length > command.body.limit
          || (page.nextCursor !== null && page.benefits.length !== command.body.limit)) return null;
        const cursor = command.body.cursor;
        if (cursor !== null && (cursor.dataGeneration !== dataGeneration
          || page.benefitCollectionRevision !== cursor.benefitCollectionRevision
          || page.benefits.some((row) => row.benefitId <= cursor.afterId))) return null;
        // A null cursor is only an observed end, never full freshness/deletion evidence.
        return Object.freeze({ kind: "page", page });
      }
      case "reject": {
        const result = fields(envelope.value, ["previewId", "state"]);
        if (result.previewId !== command.body.previewId || result.state !== "revoked") return null;
        // No generation exists on the reject acknowledgement. The caller must
        // retain the captured view scope; the supplied generation cannot add it.
        return Object.freeze({ kind: "rejected", previewId: command.body.previewId });
      }
    }
  } catch { return null; }
}

/** Fixed exact error envelope; when supplied, status must match its code exactly. */
export function decodeReviewError(input: unknown, status?: number): ReviewHttpErrorCode | null {
  try {
    const envelope = fields(input, ["ok", "code"]);
    if (envelope.ok !== false || typeof envelope.code !== "string" || !Object.hasOwn(ERROR_STATUS, envelope.code)) return null;
    const code = envelope.code as ReviewHttpErrorCode;
    return status === undefined || status === ERROR_STATUS[code] ? code : null;
  } catch { return null; }
}
