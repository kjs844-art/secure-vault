/**
 * M03 V2: private, synthetic-only service -> key reference -> usage target.
 * Derived from M03's public enum/reference concept, not its unpublished V1 wire shape.
 * No labels, notes, URLs, account identifiers, credentials, I/O or implicit clock.
 * References and relationship metadata are NOT public, AI-safe or authorization.
 */
export const MVP_CONNECTION_PROVIDER_SLUGS_V2 = Object.freeze([
  "openai", "anthropic", "claude", "gemini", "grok", "meta", "supabase", "github", "custom",
] as const);
export const MVP_CONNECTION_USAGE_KINDS_V2 = Object.freeze([
  "app", "cli", "mcp_server", "plugin", "ide", "ci_cd", "other",
] as const);
export const MVP_CONNECTION_SOURCE_KINDS_V2 = Object.freeze(["manual", "mail", "import"] as const);
export const MVP_CONNECTION_MAX_REFERENCE_V2 = 127;
export const MVP_CONNECTION_MAX_ENTRIES_V2 = 128;
export const MVP_CONNECTION_MAX_EVIDENCE_AGE_MS_V2 = 90 * 24 * 60 * 60 * 1000;
export const MVP_CONNECTION_ERROR_CODES_V2 = Object.freeze([
  "INVALID_SHAPE", "UNSUPPORTED_SCHEMA", "UNKNOWN_PROVIDER", "UNKNOWN_USAGE_KIND",
  "INVALID_REFERENCE", "SNAPSHOT_MISMATCH", "UNKNOWN_SOURCE", "INVALID_TIME",
  "LIMITS_EXCEEDED", "DUPLICATE_REFERENCE", "DUPLICATE_CONNECTION", "SESSION_CLOSED",
  "UNRECOGNIZED_PROPOSAL",
] as const);

export type MvpConnectionErrorCodeV2 = typeof MVP_CONNECTION_ERROR_CODES_V2[number];
export type MvpConnectionProviderSlugV2 = typeof MVP_CONNECTION_PROVIDER_SLUGS_V2[number];
export type MvpConnectionUsageKindV2 = typeof MVP_CONNECTION_USAGE_KINDS_V2[number];
export type MvpConnectionSourceKindV2 = typeof MVP_CONNECTION_SOURCE_KINDS_V2[number];
const issuedErrors = new WeakSet<object>();

/** Never retains unknown exceptions, their messages, cause, or supplied field values. */
export class MvpConnectionContractError extends Error {
  readonly code: MvpConnectionErrorCodeV2;
  constructor(code: MvpConnectionErrorCodeV2) {
    const safeCode = MVP_CONNECTION_ERROR_CODES_V2.includes(code) ? code : "INVALID_SHAPE";
    super(safeCode);
    this.name = "MvpConnectionContractError";
    this.code = safeCode;
    issuedErrors.add(this);
    Object.freeze(this);
  }
}

interface Input {
  readonly snapshotRevision: number;
  readonly sourceServiceRef: number;
  readonly keyRef: number;
  readonly targetRef: number;
  readonly sourceKind: MvpConnectionSourceKindV2;
  readonly observedAt: string | null;
}
interface Timing { readonly nowMs: number; readonly maxEvidenceAgeMs: number }
interface Snapshot {
  readonly revision: number;
  readonly services: ReadonlyMap<number, MvpConnectionProviderSlugV2>;
  readonly keys: ReadonlyMap<number, number>;
  readonly targets: ReadonlyMap<number, MvpConnectionUsageKindV2>;
}
interface Assessment extends Input {
  readonly providerSlug: MvpConnectionProviderSlugV2;
  readonly usage: MvpConnectionUsageKindV2;
  readonly freshness: "recent" | "stale" | "unknown";
  readonly verification: "candidate" | "needs_confirmation";
  readonly assessedAt: string;
}
export interface MvpConnectionProposalV2 extends Assessment {
  readonly schema: "keyatlas.mvp-connection-proposal.v2";
}
export interface MvpConnectionConfirmationV2 extends Assessment {
  readonly schema: "keyatlas.mvp-connection-confirmation.v2";
  readonly userDecision: "confirmed";
  readonly confirmedAt: string;
  readonly proof: "not-established";
}
export interface MvpConnectionSessionV2 {
  readonly propose: (input: unknown, timing: unknown) => MvpConnectionProposalV2;
  readonly proposeBatch: (inputs: unknown, timing: unknown) => readonly MvpConnectionProposalV2[];
  /** Invoke after an explicit local user action, not during parsing or discovery. */
  readonly confirm: (proposal: unknown, timing: unknown) => MvpConnectionConfirmationV2;
  /** Caller must close on lock, identity change, snapshot replacement or teardown. */
  readonly close: () => void;
}

function fail(code: MvpConnectionErrorCodeV2): never { throw new MvpConnectionContractError(code); }
function guarded<T>(operation: () => T): T {
  try { return operation(); } catch (error: unknown) {
    // WeakSet identity does not read properties or invoke an unknown exception's traps.
    if (typeof error === "object" && error !== null && issuedErrors.has(error)) throw error;
    return fail("INVALID_SHAPE");
  }
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("INVALID_SHAPE");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail("INVALID_SHAPE");
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    return fail("INVALID_SHAPE");
  }
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return fail("INVALID_SHAPE");
    copy[key] = descriptor.value as unknown;
  }
  return copy;
}
function denseArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail("INVALID_SHAPE");
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value")) return fail("INVALID_SHAPE");
  const length: unknown = lengthDescriptor.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return fail("INVALID_SHAPE");
  if (length > MVP_CONNECTION_MAX_ENTRIES_V2) return fail("LIMITS_EXCEEDED");
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  if (Reflect.ownKeys(descriptors).length !== length + 1) return fail("INVALID_SHAPE");
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return fail("INVALID_SHAPE");
    copy.push(descriptor.value as unknown);
  }
  return copy;
}
function member<T extends string>(value: unknown, allowed: readonly T[], code: MvpConnectionErrorCodeV2): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) return fail(code);
  return value as T;
}
function reference(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)
    || value < 0 || value > MVP_CONNECTION_MAX_REFERENCE_V2) return fail("INVALID_REFERENCE");
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return fail("INVALID_REFERENCE");
  return value;
}
function readTiming(value: unknown): Timing {
  const raw = fields(value, ["nowMs", "maxEvidenceAgeMs"]);
  if (typeof raw.nowMs !== "number" || !Number.isSafeInteger(raw.nowMs)
    || raw.nowMs < 0 || raw.nowMs > 253402300799999
    || typeof raw.maxEvidenceAgeMs !== "number" || !Number.isSafeInteger(raw.maxEvidenceAgeMs)
    || raw.maxEvidenceAgeMs < 1 || raw.maxEvidenceAgeMs > MVP_CONNECTION_MAX_EVIDENCE_AGE_MS_V2) return fail("INVALID_TIME");
  return { nowMs: raw.nowMs, maxEvidenceAgeMs: raw.maxEvidenceAgeMs };
}
function observation(value: unknown, nowMs: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return fail("INVALID_TIME");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() < 0 || date.getTime() > nowMs
    || date.toISOString() !== value) return fail("INVALID_TIME");
  return value;
}
function readSnapshot(value: unknown): Snapshot {
  const raw = fields(value, ["schema", "snapshotRevision", "services", "keys", "targets"]);
  if (raw.schema !== "keyatlas.mvp-connection-snapshot.v2") return fail("UNSUPPORTED_SCHEMA");
  const snapshotRevision = revision(raw.snapshotRevision);
  const services = new Map<number, MvpConnectionProviderSlugV2>();
  for (const entry of denseArray(raw.services)) {
    const row = fields(entry, ["reference", "providerSlug"]);
    const ref = reference(row.reference);
    if (services.has(ref)) return fail("DUPLICATE_REFERENCE");
    services.set(ref, member(row.providerSlug, MVP_CONNECTION_PROVIDER_SLUGS_V2, "UNKNOWN_PROVIDER"));
  }
  const keys = new Map<number, number>();
  for (const entry of denseArray(raw.keys)) {
    const row = fields(entry, ["reference", "sourceServiceRef"]);
    const ref = reference(row.reference);
    const service = reference(row.sourceServiceRef);
    if (keys.has(ref)) return fail("DUPLICATE_REFERENCE");
    if (!services.has(service)) return fail("INVALID_REFERENCE");
    keys.set(ref, service);
  }
  const targets = new Map<number, MvpConnectionUsageKindV2>();
  for (const entry of denseArray(raw.targets)) {
    const row = fields(entry, ["reference", "usage"]);
    const ref = reference(row.reference);
    if (targets.has(ref)) return fail("DUPLICATE_REFERENCE");
    targets.set(ref, member(row.usage, MVP_CONNECTION_USAGE_KINDS_V2, "UNKNOWN_USAGE_KIND"));
  }
  // The maps are detached and kept inside the session closure, never returned.
  return { revision: snapshotRevision, services, keys, targets };
}
function readInput(value: unknown, snapshot: Snapshot, timing: Timing): Input {
  const raw = fields(value, ["schema", "snapshotRevision", "sourceServiceRef", "keyRef", "targetRef", "sourceKind", "observedAt"]);
  if (raw.schema !== "keyatlas.mvp-connection-input.v2") return fail("UNSUPPORTED_SCHEMA");
  const snapshotRevision = revision(raw.snapshotRevision);
  if (snapshotRevision !== snapshot.revision) return fail("SNAPSHOT_MISMATCH");
  const sourceServiceRef = reference(raw.sourceServiceRef);
  const keyRef = reference(raw.keyRef);
  const targetRef = reference(raw.targetRef);
  if (!snapshot.services.has(sourceServiceRef) || !snapshot.keys.has(keyRef) || !snapshot.targets.has(targetRef)
    || snapshot.keys.get(keyRef) !== sourceServiceRef) return fail("INVALID_REFERENCE");
  return Object.freeze({ snapshotRevision, sourceServiceRef, keyRef, targetRef,
    sourceKind: member(raw.sourceKind, MVP_CONNECTION_SOURCE_KINDS_V2, "UNKNOWN_SOURCE"),
    observedAt: observation(raw.observedAt, timing.nowMs) });
}
function assess(input: Input, snapshot: Snapshot, timing: Timing): Assessment {
  const freshness = input.observedAt === null ? "unknown"
    : timing.nowMs - Date.parse(input.observedAt) > timing.maxEvidenceAgeMs ? "stale" : "recent";
  const providerSlug = snapshot.services.get(input.sourceServiceRef);
  const usage = snapshot.targets.get(input.targetRef);
  if (providerSlug === undefined || usage === undefined) return fail("INVALID_REFERENCE");
  return { ...input, providerSlug, usage, freshness,
    verification: freshness === "recent" ? "candidate" : "needs_confirmation",
    assessedAt: new Date(timing.nowMs).toISOString() };
}

/**
 * Local synthetic context only. Valid structure does not make the caller trusted.
 * A future adapter must bind real identities/revisions and enforce authorization;
 * never cast real DB ids or vault snapshot indexes into this synthetic contract.
 * No on-disk format, network endpoint, remote key probe or automatic discovery.
 */
export function createMvpConnectionSessionV2(value: unknown): MvpConnectionSessionV2 {
  return guarded(() => {
    let snapshot: Snapshot | null = readSnapshot(value);
    let proposals = new WeakMap<object, { input: Input; timing: Timing }>();
    function current(): Snapshot {
      if (snapshot === null) return fail("SESSION_CLOSED");
      return snapshot;
    }
    function issue(input: Input, context: Snapshot, timing: Timing): MvpConnectionProposalV2 {
      // Reflection on an unknown object may synchronously re-enter close().
      // Do not publish a result from a context captured before that invalidation.
      if (current() !== context) return fail("SESSION_CLOSED");
      const proposal = Object.freeze({ schema: "keyatlas.mvp-connection-proposal.v2" as const, ...assess(input, context, timing) });
      proposals.set(proposal, { input, timing });
      return proposal;
    }
    return Object.freeze({
      propose(input: unknown, clock: unknown): MvpConnectionProposalV2 {
        return guarded(() => {
          const context = current();
          const timing = readTiming(clock);
          return issue(readInput(input, context, timing), context, timing);
        });
      },
      proposeBatch(inputs: unknown, clock: unknown): readonly MvpConnectionProposalV2[] {
        return guarded(() => {
          const context = current();
          const timing = readTiming(clock);
          const parsed = denseArray(inputs).map((input) => readInput(input, context, timing));
          if (current() !== context) return fail("SESSION_CLOSED");
          const seen = new Set<string>();
          for (const input of parsed) {
            const identity = `${input.sourceServiceRef}:${input.keyRef}:${input.targetRef}`;
            if (seen.has(identity)) return fail("DUPLICATE_CONNECTION");
            seen.add(identity);
          }
          // No partial result/capability is published until the whole batch passes.
          return Object.freeze(parsed.map((input) => issue(input, context, timing)));
        });
      },
      confirm(proposal: unknown, clock: unknown): MvpConnectionConfirmationV2 {
        return guarded(() => {
          const context = current();
          const timing = readTiming(clock);
          if (current() !== context) return fail("SESSION_CLOSED");
          const issued = typeof proposal === "object" && proposal !== null ? proposals.get(proposal) : undefined;
          if (!issued) return fail("UNRECOGNIZED_PROPOSAL");
          if (timing.nowMs < issued.timing.nowMs) return fail("INVALID_TIME");
          // Confirmation cannot make old evidence look fresh by relaxing the policy.
          const confirmationTiming = { nowMs: timing.nowMs,
            maxEvidenceAgeMs: Math.min(timing.maxEvidenceAgeMs, issued.timing.maxEvidenceAgeMs) };
          const assessed = assess(issued.input, context, confirmationTiming);
          // Repeated explicit reviews cannot roll the clock or policy backwards.
          issued.timing = confirmationTiming;
          return Object.freeze({ ...assessed, schema: "keyatlas.mvp-connection-confirmation.v2" as const,
            userDecision: "confirmed" as const, confirmedAt: assessed.assessedAt, proof: "not-established" as const });
        });
      },
      close(): void {
        snapshot = null;
        proposals = new WeakMap();
      },
    });
  });
}
