import {
  MAIL_LIMITS,
  type MailNormalizationResult,
  type MailWarning,
  type PreparedMail,
} from "./contracts.ts";

type JsonObject = Record<string, unknown>;
type ErrorCode = "MAIL_INPUT_INVALID" | "MAIL_LIMIT_EXCEEDED";
interface MimeState { parts: number; decodedBytes: number }
interface PartResult { text: string; subject: string }

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_DATE_MS = 253402300799999;
const INVALID = Object.freeze({ ok: false, code: "MAIL_INPUT_INVALID" } as const);
const LIMIT = Object.freeze({ ok: false, code: "MAIL_LIMIT_EXCEEDED" } as const);

function fail(code: ErrorCode): never {
  // Only fixed codes cross the boundary; never include a message ID or raw mail.
  throw code;
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("MAIL_INPUT_INVALID");
  }
  return value as JsonObject;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return fail("MAIL_INPUT_INVALID");
  return value;
}

function headers(value: unknown): Map<string, string> {
  const selected = new Map<string, string>();
  if (value === undefined) return selected;
  if (!Array.isArray(value)) return fail("MAIL_INPUT_INVALID");
  if (value.length > MAIL_LIMITS.headersPerPart) return fail("MAIL_LIMIT_EXCEEDED");
  for (const entry of value) {
    const header = object(entry);
    if (typeof header.name !== "string" || typeof header.value !== "string") {
      return fail("MAIL_INPUT_INVALID");
    }
    if (header.name.length > MAIL_LIMITS.headerChars || header.value.length > MAIL_LIMITS.headerChars) {
      return fail("MAIL_LIMIT_EXCEEDED");
    }
    const name = header.name.toLowerCase();
    if (!["subject", "content-type", "content-disposition"].includes(name)) {
      continue;
    }
    const previous = selected.get(name);
    if (previous !== undefined && previous !== header.value) return fail("MAIL_INPUT_INVALID");
    selected.set(name, header.value);
  }
  return selected;
}

function decodePlain(data: string, state: MimeState): string {
  // Allow omitted or exact RFC 4648 padding, never misplaced/excess padding.
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const encoded = padding === 0 ? data : data.slice(0, -padding);
  const remainder = encoded.length % 4;
  if (!/^[A-Za-z0-9_-]*$/.test(encoded) || remainder === 1 ||
    (padding > 0 && (data.length % 4 !== 0 || padding !== 4 - remainder))) {
    return fail("MAIL_INPUT_INVALID");
  }
  const last = encoded.length === 0 ? 0 : BASE64URL.indexOf(encoded[encoded.length - 1]!);
  if ((remainder === 2 && (last & 15) !== 0) || (remainder === 3 && (last & 3) !== 0)) {
    return fail("MAIL_INPUT_INVALID");
  }
  const byteLength = Math.floor(encoded.length * 3 / 4);
  if (state.decodedBytes + byteLength > MAIL_LIMITS.decodedBytesPerMessage) {
    return fail("MAIL_LIMIT_EXCEEDED");
  }
  state.decodedBytes += byteLength;
  const bytes = new Uint8Array(byteLength);
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const character of encoded) {
    buffer = (buffer << 6) | BASE64URL.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >> bits) & 255;
      buffer &= (1 << bits) - 1;
    }
  }
  try {
    // Preserve an explicit BOM; offsets must describe the actual returned text.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail("MAIL_INPUT_INVALID");
  }
}

function plainRequiresAscii(partHeaders: Map<string, string>): boolean {
  // This adapter consumes Gmail FULL parsed payloads, not RAW RFC 2822 messages.
  // MessagePartBody.data is the body in base64url; decode it exactly once.
  // Original Content-Transfer-Encoding headers never trigger another decode.
  // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments
  const contentType = partHeaders.get("content-type");
  let charset: string | undefined;
  if (contentType !== undefined) {
    const fields = contentType.split(";");
    if (fields[0]!.trim().toLowerCase() !== "text/plain") return fail("MAIL_INPUT_INVALID");
    for (const parameter of fields.slice(1)) {
      const trimmed = parameter.trim();
      if (!/^charset(?:\*|\s|=|$)/i.test(trimmed)) continue;
      const match = /^charset\s*=\s*(?:"([^"]*)"|([^\s";]+))\s*$/i.exec(trimmed);
      if (match === null) return fail("MAIL_INPUT_INVALID");
      const candidate = (match[1] ?? match[2] ?? "").toLowerCase();
      if (!["utf-8", "us-ascii"].includes(candidate) || (charset !== undefined && charset !== candidate)) {
        return fail("MAIL_INPUT_INVALID");
      }
      charset = candidate;
    }
  }
  return charset === "us-ascii";
}

function visitPart(value: unknown, depth: number, state: MimeState, eligible: boolean): PartResult {
  // Check both budgets before descending or touching the next node's fields.
  if (depth > MAIL_LIMITS.mimeDepth || state.parts >= MAIL_LIMITS.mimeParts) {
    return fail("MAIL_LIMIT_EXCEEDED");
  }
  state.parts += 1;
  const part = object(value);
  const partHeaders = headers(part.headers);
  const subject = partHeaders.get("subject") ?? "";
  const mimeType = optionalString(part.mimeType)?.trim().toLowerCase() ?? "";
  const filename = optionalString(part.filename) ?? "";
  const body = part.body === undefined ? {} : object(part.body);
  const attachmentId = optionalString(body.attachmentId);
  const data = optionalString(body.data);
  if (data !== undefined && data.length > MAIL_LIMITS.encodedPartChars) return fail("MAIL_LIMIT_EXCEEDED");
  const disposition = partHeaders.get("content-disposition")?.trim().toLowerCase();
  // A filename parameter also excludes inline attachments, even if filename is omitted.
  const attachment = filename.length > 0 || attachmentId !== undefined ||
    (disposition !== undefined && (/^attachment(?:\s|;|$)/.test(disposition) || /(?:^|;)\s*filename(?:\*[^=\s;]*)?\s*=/.test(disposition)));
  const canExtract = eligible && !attachment;

  const children = part.parts === undefined ? [] : part.parts;
  if (!Array.isArray(children)) return fail("MAIL_INPUT_INVALID");
  if (children.length > MAIL_LIMITS.mimeParts - state.parts ||
    (children.length > 0 && depth >= MAIL_LIMITS.mimeDepth)) return fail("MAIL_LIMIT_EXCEEDED");

  // Always inspect structure/budgets, including ignored attachment and HTML subtrees.
  const childTexts: string[] = [];
  const multipart = mimeType.startsWith("multipart/");
  for (const child of children) {
    const result = visitPart(child, depth + 1, state, canExtract && multipart);
    if (result.text.length > 0) childTexts.push(result.text);
  }
  if (!canExtract) return { text: "", subject };
  if (multipart) {
    return {
      text: mimeType === "multipart/alternative" ? (childTexts[0] ?? "") : childTexts.join("\n"),
      subject,
    };
  }
  if (mimeType !== "text/plain" || data === undefined) return { text: "", subject };
  const asciiOnly = plainRequiresAscii(partHeaders);
  const text = decodePlain(data, state);
  if (asciiOnly && /[^\x00-\x7F]/.test(text)) return fail("MAIL_INPUT_INVALID");
  return { text, subject };
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const last = value.charCodeAt(maximum - 1);
  const next = value.charCodeAt(maximum);
  const endsInsidePair = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return value.slice(0, endsInsidePair ? maximum - 1 : maximum);
}

function wellFormed(value: string): string {
  // JSON permits escaped lone surrogates, but returned evidence must not contain them.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return fail("MAIL_INPUT_INVALID");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return fail("MAIL_INPUT_INVALID");
    }
  }
  return value;
}

function receivedAt(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > MAX_DATE_MS) return null;
  return new Date(milliseconds).toISOString();
}

/**
 * Pure, synthetic-only boundary: no I/O, persistence, IDs, auth, or external services.
 * Only UTF-8/us-ascii plain text is supported; RFC 2047 subjects are kept verbatim.
 * FULL body.data is decoded once; original transfer headers are not RAW instructions.
 * Truncation limits and evidence offsets are UTF-16 units, without splitting pairs.
 * Depth counts the payload root as 1; decoded budget covers every eligible plain
 * alternative, even the alternatives not selected. Skipped media is not decoded.
 */
export function normalizeGmailMessagesJson(input: string): MailNormalizationResult {
  if (typeof input !== "string") return INVALID;
  if (input.length > MAIL_LIMITS.jsonBytes || new TextEncoder().encode(input).byteLength > MAIL_LIMITS.jsonBytes) {
    return LIMIT;
  }
  try {
    const parsed: unknown = JSON.parse(input);
    if (!Array.isArray(parsed)) return INVALID;
    if (parsed.length > MAIL_LIMITS.messages) return LIMIT;
    const ids = new Set<string>();
    const messages: PreparedMail[] = [];
    let analysisChars = 0;
    for (const [index, value] of parsed.entries()) {
      const message = object(value);
      if (typeof message.id !== "string" || message.id.trim().length === 0) return INVALID;
      if (message.id.length > 256) return LIMIT;
      if (ids.has(message.id)) return INVALID;
      ids.add(message.id);
      const warnings: MailWarning[] = [];
      const date = receivedAt(message.internalDate);
      if (date === null) warnings.push("DATE_UNKNOWN");
      const part = message.payload === undefined ? { text: "", subject: "" } :
        visitPart(message.payload, 1, { parts: 0, decodedBytes: 0 }, true);
      const subject = truncate(wellFormed(part.subject), MAIL_LIMITS.subjectChars);
      if (part.subject.length > MAIL_LIMITS.subjectChars) warnings.push("SUBJECT_TRUNCATED");
      let body = part.text;
      let bodySource: PreparedMail["bodySource"] = "plain";
      if (body.length === 0) {
        body = wellFormed(optionalString(message.snippet) ?? "");
        bodySource = body.length > 0 ? "snippet" : "none";
        warnings.push(bodySource === "snippet" ? "SNIPPET_ONLY" : "NO_TEXT");
      }
      if (body.length > MAIL_LIMITS.bodyChars) warnings.push("BODY_TRUNCATED");
      body = truncate(body, MAIL_LIMITS.bodyChars);
      analysisChars += subject.length + body.length;
      if (analysisChars > MAIL_LIMITS.analysisChars) return LIMIT;
      messages.push(Object.freeze({
        index,
        receivedAt: date,
        subject,
        body,
        bodySource,
        warnings: Object.freeze(warnings),
      }));
    }
    return Object.freeze({ ok: true, messages: Object.freeze(messages) });
  } catch (error: unknown) {
    return error === "MAIL_LIMIT_EXCEEDED" ? LIMIT : INVALID;
  }
}
