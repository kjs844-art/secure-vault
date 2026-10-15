export type BodyReadFailureCode = "BODY_INVALID" | "BODY_TOO_LARGE" | "BODY_MEDIA_TYPE" | "BODY_TIMEOUT" | "BODY_ABORTED";

/** Public failures contain only fixed codes, never body text or abort reasons. */
export class BodyReadFailure extends Error {
  readonly code: BodyReadFailureCode;
  constructor(code: BodyReadFailureCode) {
    super(code);
    this.name = "BodyReadFailure";
    this.code = code;
  }
}

export interface BoundedJsonOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

const MAX_DEPTH = 12;
const MAX_NODES = 256;
function invalid(): never { throw new BodyReadFailure("BODY_INVALID"); }

/**
 * Validate grammar before JSON.parse so duplicate decoded keys cannot disappear.
 * Root container depth is 1; at most 12 nested object/array containers and 256
 * total JSON values (including containers) are allowed. Property names are not
 * values. The later domain decoder remains responsible for scalar semantics.
 */
function validateJsonObject(text: string): void {
  let position = 0;
  let nodes = 0;
  const whitespace = () => {
    while (position < text.length && (text[position] === " " || text[position] === "\t"
      || text[position] === "\r" || text[position] === "\n")) position++;
  };
  const string = (): string => {
    if (text[position] !== '"') return invalid();
    const start = position++;
    while (position < text.length) {
      const character = text[position++]!;
      if (character === '"') return JSON.parse(text.slice(start, position)) as string;
      if (character.charCodeAt(0) < 0x20) return invalid();
      if (character === "\\") {
        const escape = text[position++];
        if (escape === "u") {
          for (let index = 0; index < 4; index++) {
            const hex = text[position++];
            if (hex === undefined || !/^[0-9a-f]$/i.test(hex)) return invalid();
          }
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) return invalid();
      }
    }
    return invalid();
  };
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const value = (depth: number): void => {
    whitespace();
    if (++nodes > MAX_NODES) return invalid();
    const first = text[position];
    if (first === "{" || first === "[") {
      if (depth > MAX_DEPTH) return invalid();
      const object = first === "{";
      const closing = object ? "}" : "]";
      const keys = new Set<string>();
      position++;
      whitespace();
      if (text[position] === closing) { position++; return; }
      while (true) {
        if (object) {
          const key = string();
          if (keys.has(key)) return invalid();
          keys.add(key);
          whitespace();
          if (text[position++] !== ":") return invalid();
        }
        value(depth + 1);
        whitespace();
        if (text[position] === closing) { position++; return; }
        if (text[position++] !== ",") return invalid();
        whitespace();
      }
    }
    if (first === '"') { string(); return; }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, position)) { position += literal.length; return; }
    }
    number.lastIndex = position;
    const match = number.exec(text);
    if (!match) return invalid();
    position = number.lastIndex;
  };
  whitespace();
  if (text[position] !== "{") return invalid();
  value(1);
  whitespace();
  if (position !== text.length) return invalid();
}

/**
 * Internal bounded reader, not authentication or domain input validation.
 * No Request.json()/text(): the byte ceiling applies before UTF-8/JSON decoding.
 * A caller may supply a shared request deadline signal; any signal abort maps to
 * BODY_ABORTED without exposing its reason. This function's timer is BODY_TIMEOUT.
 */
export async function readBoundedJson(request: Request, options: BoundedJsonOptions = {}): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let yieldTimer: ReturnType<typeof setTimeout> | undefined;
  let successful = false;
  let interruption: BodyReadFailure | undefined;
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  try {
    const maxBytes = options.maxBytes === undefined ? 16384 : options.maxBytes;
    const timeoutMs = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) return invalid();
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) return invalid();
    const deadline = performance.now() + timeoutMs;
    const signals = [...new Set([request.signal, ...(options.signal === undefined ? [] : [options.signal])])];
    if (signals.some((signal) => signal.aborted)) throw new BodyReadFailure("BODY_ABORTED");

    const mediaType = request.headers.get("content-type");
    const encoding = request.headers.get("content-encoding");
    if (mediaType === null || mediaType.trim() !== mediaType
      || !/^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/i.test(mediaType)
      || (encoding !== null && (encoding.trim() !== encoding || !/^identity$/i.test(encoding)))) {
      throw new BodyReadFailure("BODY_MEDIA_TYPE");
    }
    const rawLength = request.headers.get("content-length");
    let expectedLength: number | undefined;
    if (rawLength !== null) {
      if (rawLength.trim() !== rawLength || !/^(?:0|[1-9][0-9]*)$/.test(rawLength)) return invalid();
      expectedLength = Number(rawLength);
      if (expectedLength > maxBytes) throw new BodyReadFailure("BODY_TOO_LARGE");
    }
    if (request.bodyUsed || request.body === null || request.body.locked) return invalid();
    reader = request.body.getReader();

    let rejectPending: ((error: BodyReadFailure) => void) | undefined;
    const interrupt = (code: "BODY_TIMEOUT" | "BODY_ABORTED") => {
      if (interruption !== undefined) return;
      interruption = new BodyReadFailure(code);
      rejectPending?.(interruption);
    };
    // A shared never-settling promise in repeated Promise.race calls would retain
    // a reaction for EVERY empty chunk. Keep only the current wait's callback.
    const waitFor = <T>(promise: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        if (rejectPending === onInterruption) rejectPending = undefined;
        complete();
      };
      const onInterruption = (error: BodyReadFailure) => finish(() => reject(error));
      rejectPending = onInterruption;
      // Both handlers stay attached even if interruption wins, so later read or
      // releaseLock rejection cannot become unhandled.
      void promise.then((result) => finish(() => resolve(result)), (error: unknown) => finish(() => reject(error)));
      if (interruption !== undefined) onInterruption(interruption);
    });
    for (const signal of signals) {
      const listener = () => interrupt("BODY_ABORTED");
      signal.addEventListener("abort", listener, { once: true });
      listeners.push([signal, listener]);
    }
    timer = setTimeout(() => interrupt("BODY_TIMEOUT"), Math.max(0, deadline - performance.now()));
    const checkpoint = () => {
      // Recheck after listener registration and every read, including immediately
      // resolving empty chunks that could otherwise starve the timeout callback.
      if (signals.some((signal) => signal.aborted)) interrupt("BODY_ABORTED");
      if (performance.now() >= deadline) interrupt("BODY_TIMEOUT");
      if (interruption !== undefined) throw interruption;
    };
    const bytes = new Uint8Array(maxBytes);
    let length = 0;
    let reads = 0;
    while (true) {
      checkpoint();
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await waitFor(reader.read());
      } catch {
        throw interruption ?? new BodyReadFailure("BODY_INVALID");
      }
      checkpoint();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) return invalid();
      if (part.value.byteLength > maxBytes - length) throw new BodyReadFailure("BODY_TOO_LARGE");
      bytes.set(part.value, length);
      length += part.value.byteLength;
      if (++reads % 64 === 0) {
        // Give timers and externally dispatched aborts a turn even for a stream
        // of immediately available chunks. This yield is also interruptible.
        await waitFor(new Promise<void>((resolve) => { yieldTimer = setTimeout(resolve, 0); }));
        clearTimeout(yieldTimer);
        yieldTimer = undefined;
      }
    }
    if (expectedLength !== undefined && length !== expectedLength) return invalid();
    // Preserve the BOM rather than letting TextDecoder silently strip it.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    if (text.charCodeAt(0) === 0xfeff) return invalid();
    validateJsonObject(text);
    const parsed: unknown = JSON.parse(text);
    checkpoint();
    successful = true;
    return parsed;
  } catch (error) {
    throw interruption ?? (error instanceof BodyReadFailure ? error : new BodyReadFailure("BODY_INVALID"));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (yieldTimer !== undefined) clearTimeout(yieldTimer);
    for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    if (reader !== undefined) {
      if (!successful) {
        // A source's cancel promise may reject or never settle. Neither can hold
        // the HTTP boundary open or leak its rejection/body-derived message.
        try { void reader.cancel().catch(() => {}); } catch { /* Best-effort cleanup. */ }
      }
      try { reader.releaseLock(); } catch { /* Some runtimes retain pending reads. */ }
    }
  }
}
