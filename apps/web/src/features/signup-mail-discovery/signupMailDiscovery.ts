import {
  MailDiscoveryError,
  mailMetadataAccessPolicy,
  type MailDiscoveryErrorCode,
  type MailMetadataAccessPolicy,
} from "./signupMailAccessPolicy";

export { MailDiscoveryError } from "./signupMailAccessPolicy";

export const MAIL_DISCOVERY_LIMITS = Object.freeze({
  maxHeaders: 100,
  maxRangeMs: 90 * 24 * 60 * 60 * 1_000,
  maxSubjectBytes: 512,
  sessionLifetimeMs: 5 * 60 * 1_000,
});

export const SYNTHETIC_MAIL_SERVICES = Object.freeze([
  Object.freeze({ id: "aurora-demo", name: "Aurora 예제", senderDomain: "accounts.aurora.invalid" }),
  Object.freeze({ id: "cedar-demo", name: "Cedar 예제", senderDomain: "accounts.cedar.invalid" }),
  Object.freeze({ id: "harbor-demo", name: "Harbor 예제", senderDomain: "accounts.harbor.invalid" }),
]);

export type SignupMailSignal = "welcome" | "registration" | "email_verification";
export type SignupMailConfidence = "needs_review" | "confirmed" | "dismissed";
export type SignupMailPhase = "awaiting_consent" | "ready" | "review" | "failed" | "cancelled" | "expired" | "disposed";

export interface SignupMailScanPreview {
  readonly version: 1;
  readonly boundary: "synthetic_only";
  readonly access: MailMetadataAccessPolicy;
  readonly serviceIds: readonly string[];
  readonly from: number;
  readonly to: number;
  readonly maxHeaders: number;
  readonly expiresAt: number;
}

/** Contains only an allowlisted service and coarse evidence, never a mail excerpt. */
export interface SignupMailHint {
  readonly serviceId: string;
  readonly serviceName: string;
  readonly sourceKind: "mail_hint";
  readonly confidence: SignupMailConfidence;
  readonly signals: readonly SignupMailSignal[];
  readonly observedOn: string;
}

export interface SignupMailView {
  readonly phase: SignupMailPhase;
  readonly preview: SignupMailScanPreview;
  readonly hints: readonly SignupMailHint[];
  readonly inspectedHeaders: number;
}

const EMPTY_HINTS: readonly SignupMailHint[] = Object.freeze([]);
const SIGNALS: readonly SignupMailSignal[] = Object.freeze(["welcome", "registration", "email_verification"]);
const SIGNAL_PATTERNS: Readonly<Record<SignupMailSignal, RegExp>> = Object.freeze({
  welcome: /\bwelcome to\b|가입을 환영/iu,
  registration: /\b(?:registration complete|account created|thanks for signing up)\b|회원가입(?:이)? 완료/iu,
  email_verification: /\b(?:verify|confirm) (?:your )?email(?: address)?\b|이메일(?: 주소)?(?:을|를)? ?인증/iu,
});

function fail(code: MailDiscoveryErrorCode): never {
  throw new MailDiscoveryError(code);
}

/** Reject getters, extra fields, symbols and prototypes before reading field values. */
function dataRecord(input: unknown, keys: readonly string[], code: MailDiscoveryErrorCode): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) fail(code);
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) fail(code);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
    result[key] = descriptor.value;
  }
  return result;
}

function arrayLength(input: unknown, limit: number, code: MailDiscoveryErrorCode): number {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail(code);
  if (input.length > limit || Reflect.ownKeys(input).length !== input.length + 1) fail(code);
  return input.length;
}

function arrayItem(input: unknown, index: number, code: MailDiscoveryErrorCode): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
  return descriptor.value;
}

function timestamp(input: unknown, code: MailDiscoveryErrorCode): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0 || input > 8_640_000_000_000_000) fail(code);
  return input;
}

function scanPreview(input: unknown, now: number): SignupMailScanPreview {
  const request = dataRecord(input, ["version", "provider", "scopes", "serviceIds", "from", "to", "maxHeaders"], "INVALID_REQUEST");
  if (request.version !== 1) fail("UNSUPPORTED_VERSION");
  const access = mailMetadataAccessPolicy(request.provider, request.scopes);
  if (!access.adapterAvailable) fail("LIVE_PROVIDER_UNAVAILABLE");
  const count = arrayLength(request.serviceIds, SYNTHETIC_MAIL_SERVICES.length, "INVALID_REQUEST");
  if (count === 0) fail("INVALID_REQUEST");
  const serviceIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = arrayItem(request.serviceIds, i, "INVALID_REQUEST");
    if (typeof id !== "string" || !SYNTHETIC_MAIL_SERVICES.some((service) => service.id === id) || serviceIds.includes(id)) fail("INVALID_REQUEST");
    serviceIds.push(id);
  }
  const from = timestamp(request.from, "INVALID_REQUEST");
  const to = timestamp(request.to, "INVALID_REQUEST");
  if (from >= to || to > now || to - from > MAIL_DISCOVERY_LIMITS.maxRangeMs) fail("INVALID_REQUEST");
  const maxHeaders = request.maxHeaders;
  if (typeof maxHeaders !== "number" || !Number.isInteger(maxHeaders) || maxHeaders < 1 || maxHeaders > MAIL_DISCOVERY_LIMITS.maxHeaders) fail("INVALID_REQUEST");
  if (now > 8_640_000_000_000_000 - MAIL_DISCOVERY_LIMITS.sessionLifetimeMs) fail("INVALID_REQUEST");
  return Object.freeze({
    version: 1,
    boundary: "synthetic_only",
    access,
    serviceIds: Object.freeze(serviceIds),
    from,
    to,
    maxHeaders,
    expiresAt: now + MAIL_DISCOVERY_LIMITS.sessionLifetimeMs,
  });
}

function discover(input: unknown, preview: SignupMailScanPreview): { hints: readonly SignupMailHint[]; count: number } {
  const batch = dataRecord(input, ["version", "syntheticOnly", "headers"], "INVALID_METADATA");
  if (batch.version !== 1) fail("UNSUPPORTED_VERSION");
  if (batch.syntheticOnly !== true) fail("INVALID_METADATA");
  const count = arrayLength(batch.headers, preview.maxHeaders, "SCAN_LIMIT_EXCEEDED");
  const matches = new Map<string, { serviceName: string; signals: Set<SignupMailSignal>; latest: number }>();
  for (let i = 0; i < count; i += 1) {
    const header = dataRecord(arrayItem(batch.headers, i, "INVALID_METADATA"), ["senderDomain", "subject", "receivedAt"], "INVALID_METADATA");
    const { senderDomain, subject } = header;
    if (typeof senderDomain !== "string" || senderDomain.length > 253 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.invalid$/u.test(senderDomain)) fail("INVALID_METADATA");
    if (typeof subject !== "string" || subject.length > MAIL_DISCOVERY_LIMITS.maxSubjectBytes || /[\u0000-\u001f\u007f]/u.test(subject)) fail("INVALID_METADATA");
    if (new TextEncoder().encode(subject).byteLength > MAIL_DISCOVERY_LIMITS.maxSubjectBytes) fail("INVALID_METADATA");
    const receivedAt = timestamp(header.receivedAt, "INVALID_METADATA");
    if (receivedAt < preview.from || receivedAt >= preview.to) continue;
    const service = SYNTHETIC_MAIL_SERVICES.find((candidate) => candidate.senderDomain === senderDomain && preview.serviceIds.includes(candidate.id));
    if (!service) continue;
    const signals = SIGNALS.filter((signal) => SIGNAL_PATTERNS[signal].test(subject));
    if (signals.length === 0) continue;
    const match = matches.get(service.id) ?? { serviceName: service.name, signals: new Set<SignupMailSignal>(), latest: receivedAt };
    for (const signal of signals) match.signals.add(signal);
    match.latest = Math.max(match.latest, receivedAt);
    matches.set(service.id, match);
  }
  const hints: SignupMailHint[] = [];
  for (const serviceId of preview.serviceIds) {
    const match = matches.get(serviceId);
    if (!match) continue;
    hints.push(Object.freeze({
      serviceId,
      serviceName: match.serviceName,
      sourceKind: "mail_hint",
      confidence: "needs_review",
      signals: Object.freeze(SIGNALS.filter((signal) => match.signals.has(signal))),
      observedOn: new Date(match.latest).toISOString().slice(0, 10),
    }));
  }
  return { hints: Object.freeze(hints), count };
}

/** No network or persistence adapter; stores only the frozen plan and minimal hints. */
export class SyntheticSignupMailDiscoverySession {
  readonly #clock: () => number;
  readonly #preview: SignupMailScanPreview;
  #lastNow: number;
  #phase: SignupMailPhase = "awaiting_consent";
  #hints: readonly SignupMailHint[] = EMPTY_HINTS;
  #inspectedHeaders = 0;

  constructor(request: unknown, clock: () => number = Date.now) {
    this.#clock = clock;
    try {
      this.#lastNow = timestamp(clock(), "INVALID_REQUEST");
      this.#preview = scanPreview(request, this.#lastNow);
    } catch (error) {
      throw error instanceof MailDiscoveryError ? error : new MailDiscoveryError("INVALID_REQUEST");
    }
  }

  view(): SignupMailView {
    this.#refresh();
    return Object.freeze({ phase: this.#phase, preview: this.#preview, hints: this.#hints, inspectedHeaders: this.#inspectedHeaders });
  }

  approve(preview: SignupMailScanPreview, confirmed: boolean): void {
    this.#requireActive();
    if (this.#phase !== "awaiting_consent") fail("INVALID_STATE");
    if (confirmed !== true) fail("CONSENT_REQUIRED");
    if (preview !== this.#preview) fail("STALE_PREVIEW");
    this.#phase = "ready";
  }

  scan(metadata: unknown): SignupMailView {
    this.#requireActive();
    if (this.#phase === "awaiting_consent") fail("CONSENT_REQUIRED");
    if (this.#phase !== "ready") fail("INVALID_STATE");
    try {
      const result = discover(metadata, this.#preview);
      this.#requireActive();
      this.#hints = result.hints;
      this.#inspectedHeaders = result.count;
      this.#phase = "review";
      return this.view();
    } catch (error) {
      this.#clear();
      if (!(error instanceof MailDiscoveryError && error.code === "SESSION_EXPIRED")) this.#phase = "failed";
      throw error instanceof MailDiscoveryError ? error : new MailDiscoveryError("INVALID_METADATA");
    }
  }

  setConfidence(serviceId: string, confidence: SignupMailConfidence): SignupMailView {
    this.#requireActive();
    if (this.#phase !== "review") fail("INVALID_STATE");
    if (!["needs_review", "confirmed", "dismissed"].includes(confidence) || !this.#hints.some((hint) => hint.serviceId === serviceId)) fail("INVALID_REQUEST");
    this.#hints = Object.freeze(this.#hints.map((hint) => hint.serviceId === serviceId ? Object.freeze({ ...hint, confidence }) : hint));
    return this.view();
  }

  cancel(): void {
    this.#clear();
    if (this.#phase !== "disposed") this.#phase = "cancelled";
  }

  dispose(): void {
    this.#clear();
    this.#phase = "disposed";
  }

  #clear(): void {
    this.#hints = EMPTY_HINTS;
    this.#inspectedHeaders = 0;
  }

  #refresh(): void {
    if (["cancelled", "disposed", "expired", "failed"].includes(this.#phase)) return;
    let now: number;
    try { now = this.#clock(); } catch { now = Number.NaN; }
    if (!Number.isSafeInteger(now) || now < this.#lastNow || now >= this.#preview.expiresAt) {
      this.#clear();
      this.#phase = "expired";
      return;
    }
    this.#lastNow = now;
  }

  #requireActive(): void {
    this.#refresh();
    if (this.#phase === "expired") fail("SESSION_EXPIRED");
    if (["cancelled", "disposed", "failed"].includes(this.#phase)) fail("SESSION_CLOSED");
  }
}
