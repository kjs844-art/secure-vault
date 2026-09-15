/** Synthetic local UI commands only. No provider, network transport, or unlock. */
export const SYNTHETIC_TOOL_QUERY_MAX_BYTES = 128;
export const SYNTHETIC_TOOL_MAX_RESULTS = 500;
export const SYNTHETIC_TOOL_FILTERS_V1 = [
  "all", "has_connection", "no_connection", "mcp_connection",
] as const;
export type SyntheticToolFilterV1 = (typeof SYNTHETIC_TOOL_FILTERS_V1)[number];

export const SYNTHETIC_TOOL_ERROR_CODES_V1 = [
  "NOT_READY", "VAULT_LOCKED", "INVALID_TOOL", "INVALID_PAYLOAD",
  "LIMIT_EXCEEDED", "CANCELLED", "OPERATION_FAILED",
] as const;
export type SyntheticToolErrorCodeV1 = (typeof SYNTHETIC_TOOL_ERROR_CODES_V1)[number];

export type SyntheticToolActionV1 =
  | { readonly op: "search_catalog"; readonly query: string; readonly maxResults?: number }
  | { readonly op: "filter_catalog"; readonly filter: SyntheticToolFilterV1; readonly maxResults?: number }
  | { readonly op: "lock_vault" };

/**
 * The only reply crossing the tool boundary. Do not add rows, names, queries,
 * references, counts, or match/no-match indicators: those stay in local UI.
 * This is not an external-AI consent policy or an authorization capability.
 */
export type SyntheticToolReceiptV1 =
  | { readonly kind: "ok"; readonly action: SyntheticToolActionV1["op"] }
  | { readonly kind: "error"; readonly code: SyntheticToolErrorCodeV1 };

export type ParsedSyntheticToolActionV1 =
  | { readonly ok: true; readonly action: SyntheticToolActionV1 }
  | { readonly ok: false; readonly code: SyntheticToolErrorCodeV1 };

const encoder = new TextEncoder();
const fail = (code: SyntheticToolErrorCodeV1): ParsedSyntheticToolActionV1 => Object.freeze({ ok: false, code });

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Snapshot exact own data fields once; never execute getters or trust a TS cast. */
export function parseSyntheticToolAction(input: unknown): ParsedSyntheticToolActionV1 {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return fail("INVALID_PAYLOAD");
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return fail("INVALID_PAYLOAD");
    const keys = Reflect.ownKeys(input);
    if (keys.length < 1 || keys.length > 3 || keys.some((key) => typeof key !== "string")) return fail("INVALID_PAYLOAD");
    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail("INVALID_PAYLOAD");
      fields[key as string] = descriptor.value;
    }
    const op = fields.op;
    if (op !== "search_catalog" && op !== "filter_catalog" && op !== "lock_vault") return fail("INVALID_TOOL");
    const allowed = op === "search_catalog" ? ["op", "query", "maxResults"]
      : op === "filter_catalog" ? ["op", "filter", "maxResults"] : ["op"];
    if (keys.some((key) => !allowed.includes(key as string))) return fail("INVALID_PAYLOAD");
    if (op === "lock_vault") return Object.freeze({ ok: true, action: Object.freeze({ op }) });

    const maxResults = Object.hasOwn(fields, "maxResults") ? fields.maxResults : SYNTHETIC_TOOL_MAX_RESULTS;
    if (typeof maxResults !== "number" || !Number.isSafeInteger(maxResults)
        || maxResults < 0 || maxResults > SYNTHETIC_TOOL_MAX_RESULTS) return fail("LIMIT_EXCEEDED");
    if (op === "search_catalog") {
      const query = fields.query;
      if (typeof query !== "string" || !wellFormed(query)) return fail("INVALID_PAYLOAD");
      // Cheap bound before encoding; the actual protocol bound is UTF-8 bytes.
      if (query.length > SYNTHETIC_TOOL_QUERY_MAX_BYTES
          || encoder.encode(query).byteLength > SYNTHETIC_TOOL_QUERY_MAX_BYTES) return fail("LIMIT_EXCEEDED");
      return Object.freeze({ ok: true, action: Object.freeze({ op, query, maxResults }) });
    }
    const filter = fields.filter;
    if (typeof filter !== "string" || !SYNTHETIC_TOOL_FILTERS_V1.some((candidate) => candidate === filter)) return fail("INVALID_PAYLOAD");
    return Object.freeze({ ok: true, action: Object.freeze({ op, filter: filter as SyntheticToolFilterV1, maxResults }) });
  } catch {
    // Proxy traps can run same-origin code. Normalize thrown values; callers
    // must also recheck session generation after parsing untrusted objects.
    return fail("INVALID_PAYLOAD");
  }
}
