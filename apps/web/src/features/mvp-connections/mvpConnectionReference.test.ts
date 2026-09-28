import { afterEach, describe, expect, it, vi } from "vitest";
import { createMvpConnectionSessionV2, MvpConnectionContractError,
  type MvpConnectionErrorCodeV2 } from "./mvpConnectionReference";

// Independent synthetic contract regression. No real identities, credentials,
// network probes, persistence, or authorization evidence are created here.
const SNAPSHOT = "keyatlas.mvp-connection-snapshot.v2";
const INPUT = "keyatlas.mvp-connection-input.v2";
const PROPOSAL = "keyatlas.mvp-connection-proposal.v2";
const CONFIRMATION = "keyatlas.mvp-connection-confirmation.v2";
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const DAY = 86_400_000;
const MAX_TIME = 253402300799999;
const PRIVATE_DETAIL = "SYNTHETIC_PRIVATE_CONNECTION_DETAIL";
const PROVIDERS = ["openai", "anthropic", "claude", "gemini", "grok", "meta", "supabase", "github", "custom"];
const USAGES = ["app", "cli", "mcp_server", "plugin", "ide", "ci_cd", "other"];
const SOURCES = ["manual", "mail", "import"];
const proposalKeys = ["schema", "snapshotRevision", "sourceServiceRef", "keyRef", "targetRef", "sourceKind",
  "observedAt", "providerSlug", "usage", "freshness", "verification", "assessedAt"].sort();

function snapshot() {
  return { schema: SNAPSHOT, snapshotRevision: 7,
    services: [{ reference: 0, providerSlug: "openai" }, { reference: 3, providerSlug: "anthropic" }],
    keys: [{ reference: 1, sourceServiceRef: 0 }, { reference: 4, sourceServiceRef: 3 }],
    targets: [{ reference: 2, usage: "app" }, { reference: 5, usage: "cli" }] };
}
function input(patch: Record<string, unknown> = {}) {
  return { schema: INPUT, snapshotRevision: 7, sourceServiceRef: 0, keyRef: 1, targetRef: 2,
    sourceKind: "manual", observedAt: new Date(NOW - 1000).toISOString(), ...patch };
}
const timing = (patch: Record<string, unknown> = {}) => ({ nowMs: NOW, maxEvidenceAgeMs: DAY, ...patch });
const session = () => createMvpConnectionSessionV2(snapshot());
function fails(action: () => unknown, code: MvpConnectionErrorCodeV2) {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(MvpConnectionContractError);
  const error = caught as MvpConnectionContractError;
  expect(error.code).toBe(code);
  expect(error.message).toBe(code);
  expect(error.name).toBe("MvpConnectionContractError");
  expect(Object.isFrozen(error)).toBe(true);
  expect(Reflect.set(error, "code", "replacement")).toBe(false);
  expect(Reflect.set(error, "message", PRIVATE_DETAIL)).toBe(false);
  expect(JSON.stringify(error)).not.toContain(PRIVATE_DETAIL);
  expect(error.stack).not.toContain(PRIVATE_DETAIL);
  expect(Object.hasOwn(error, "cause")).toBe(false);
}
function exactProposal(value: ReturnType<ReturnType<typeof session>["propose"]>) {
  expect(Object.keys(value).sort()).toEqual(proposalKeys);
  expect(Object.isFrozen(value)).toBe(true);
  expect(value.schema).toBe(PROPOSAL);
  expect(JSON.stringify(value)).not.toContain(PRIVATE_DETAIL);
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("synthetic V2 context and proposal", () => {
  it("derives provider and target usage only from a matching snapshot", () => {
    const current = session();
    const proposal = current.propose(input(), timing());
    expect(proposal).toEqual({ schema: PROPOSAL, snapshotRevision: 7, sourceServiceRef: 0, keyRef: 1, targetRef: 2,
      sourceKind: "manual", observedAt: "2026-09-28T11:59:59.000Z", providerSlug: "openai", usage: "app",
      freshness: "recent", verification: "candidate", assessedAt: "2026-09-28T12:00:00.000Z" });
    exactProposal(proposal);
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.keys(current).sort()).toEqual(["close", "confirm", "propose", "proposeBatch"]);
  });

  it.each(PROVIDERS)("preserves the closed provider enum %s", (providerSlug) => {
    const context = snapshot();
    context.services[0]!.providerSlug = providerSlug;
    expect(createMvpConnectionSessionV2(context).propose(input(), timing()).providerSlug).toBe(providerSlug);
  });
  it.each(USAGES)("preserves the closed usage enum %s", (usage) => {
    const context = snapshot();
    context.targets[0]!.usage = usage;
    expect(createMvpConnectionSessionV2(context).propose(input(), timing()).usage).toBe(usage);
  });
  it.each(SOURCES)("keeps %s as observation provenance rather than verification", (sourceKind) => {
    const current = session();
    const proposal = current.propose(input({ sourceKind }), timing());
    expect(proposal.sourceKind).toBe(sourceKind);
    expect(proposal.verification).toBe("candidate");
    const confirmed = current.confirm(proposal, timing());
    expect(confirmed.sourceKind).toBe(sourceKind);
    expect(confirmed.proof).toBe("not-established");
    expect(confirmed.verification).not.toBe("verified");
  });

  it("detaches all context, input and timing data before callers mutate their originals", () => {
    const context = snapshot();
    const original = structuredClone(context);
    const current = createMvpConnectionSessionV2(context);
    context.services[0]!.providerSlug = "custom";
    context.keys[0]!.sourceServiceRef = 3;
    context.targets[0]!.usage = "other";
    context.snapshotRevision = 99;
    context.services.length = 0;
    const command = input();
    const clock = timing();
    const proposal = current.propose(command, clock);
    command.sourceKind = "mail";
    command.observedAt = new Date(NOW).toISOString();
    command.targetRef = 5;
    clock.maxEvidenceAgeMs = 90 * DAY;
    clock.nowMs = NOW + DAY;
    expect(proposal.providerSlug).toBe(original.services[0]!.providerSlug);
    expect(proposal.usage).toBe("app");
    expect(Reflect.set(proposal, "providerSlug", "custom")).toBe(false);
    expect(Reflect.set(proposal, "observedAt", null)).toBe(false);
    const confirmation = current.confirm(proposal, timing({ nowMs: NOW + DAY }));
    expect(confirmation.sourceKind).toBe("manual");
    expect(confirmation.targetRef).toBe(2);
    expect(confirmation.observedAt).toBe("2026-09-28T11:59:59.000Z");
    expect(confirmation.freshness).toBe("stale");
  });

  it("uses explicit time and has no network or implicit-clock side effects", () => {
    const fetch = vi.fn(() => { throw new Error(PRIVATE_DETAIL); });
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(Date, "now").mockImplementation(() => { throw new Error(PRIVATE_DETAIL); });
    const current = session();
    const proposal = current.propose(input(), timing());
    const confirmation = current.confirm(proposal, timing());
    expect(confirmation.confirmedAt).toBe("2026-09-28T12:00:00.000Z");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts an empty context and batch without fabricating records", () => {
    const current = createMvpConnectionSessionV2({ schema: SNAPSHOT, snapshotRevision: 1, services: [], keys: [], targets: [] });
    const values = current.proposeBatch([], timing());
    expect(values).toEqual([]);
    expect(Object.isFrozen(values)).toBe(true);
    fails(() => current.propose(input({ snapshotRevision: 1 }), timing()), "INVALID_REFERENCE");
  });
});

describe("strict shape and privacy boundaries", () => {
  it.each([null, undefined, true, 1, "synthetic", [], new Date(NOW)])("rejects non-record snapshot %s", (value) => {
    fails(() => createMvpConnectionSessionV2(value), "INVALID_SHAPE");
  });
  it.each([null, undefined, true, 1, "synthetic", [], new Date(NOW)])("rejects non-record proposal input %s", (value) => {
    fails(() => session().propose(value, timing()), "INVALID_SHAPE");
  });
  it.each([null, undefined, true, 1, "synthetic", [], new Date(NOW)])("rejects non-record timing %s", (value) => {
    fails(() => session().propose(input(), value), "INVALID_SHAPE");
  });

  it.each(["schema", "snapshotRevision", "services", "keys", "targets"])("rejects missing snapshot field %s", (key) => {
    const value: Record<string, unknown> = snapshot();
    delete value[key];
    fails(() => createMvpConnectionSessionV2(value), "INVALID_SHAPE");
  });
  it.each(["schema", "snapshotRevision", "sourceServiceRef", "keyRef", "targetRef", "sourceKind", "observedAt"])("rejects missing input field %s", (key) => {
    const value: Record<string, unknown> = input();
    delete value[key];
    fails(() => session().propose(value, timing()), "INVALID_SHAPE");
  });
  it.each(["label", "note", "url", "accountIdentifier", "credential", "verification", "ack", "providerSlug", "usage"])("refuses unapproved field %s instead of forwarding it", (key) => {
    fails(() => session().propose(input({ [key]: PRIVATE_DETAIL }), timing()), "INVALID_SHAPE");
  });
  it.each(["services", "keys", "targets"] as const)("rejects extra metadata within %s", (key) => {
    const value = snapshot();
    Object.assign(value[key][0]!, { note: PRIVATE_DETAIL });
    fails(() => createMvpConnectionSessionV2(value), "INVALID_SHAPE");
  });
  it("rejects extra snapshot/timing keys, including nonenumerable and symbol properties", () => {
    fails(() => createMvpConnectionSessionV2({ ...snapshot(), note: PRIVATE_DETAIL }), "INVALID_SHAPE");
    fails(() => session().propose(input(), { ...timing(), note: PRIVATE_DETAIL }), "INVALID_SHAPE");
    for (const key of ["hidden", Symbol(PRIVATE_DETAIL)]) {
      const value = input();
      Object.defineProperty(value, key, { value: PRIVATE_DETAIL, enumerable: false });
      fails(() => session().propose(value, timing()), "INVALID_SHAPE");
    }
  });
  it("rejects missing or nonenumerable known timing/input fields", () => {
    fails(() => session().propose(input(), { nowMs: NOW }), "INVALID_SHAPE");
    const command = input();
    Object.defineProperty(command, "observedAt", { value: null, enumerable: false });
    fails(() => session().propose(command, timing()), "INVALID_SHAPE");
  });
  it("does not execute accessors at any input boundary", () => {
    const getter = vi.fn(() => { throw new Error(PRIVATE_DETAIL); });
    const context = snapshot();
    Object.defineProperty(context.services[0], "providerSlug", { get: getter, enumerable: true });
    fails(() => createMvpConnectionSessionV2(context), "INVALID_SHAPE");
    const command = input();
    Object.defineProperty(command, "observedAt", { get: getter, enumerable: true });
    fails(() => session().propose(command, timing()), "INVALID_SHAPE");
    const clock = timing();
    Object.defineProperty(clock, "nowMs", { get: getter, enumerable: true });
    fails(() => session().propose(input(), clock), "INVALID_SHAPE");
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects inherited fields instead of using them as trusted context", () => {
    fails(() => createMvpConnectionSessionV2(Object.create(snapshot())), "INVALID_SHAPE");
    fails(() => session().propose(Object.create(input()), timing()), "INVALID_SHAPE");
  });
  it.each(["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const)("redacts a throwing proxy %s trap", (trap) => {
    const hostile = new Proxy(snapshot(), { [trap]: () => { throw new Error(PRIVATE_DETAIL); } });
    fails(() => createMvpConnectionSessionV2(hostile), "INVALID_SHAPE");
    const command = new Proxy(input(), { [trap]: () => { throw new Error(PRIVATE_DETAIL); } });
    fails(() => session().propose(command, timing()), "INVALID_SHAPE");
  });
  it("does not inspect a hostile thrown exception to decide its error code", () => {
    const getter = vi.fn(() => { throw new Error(PRIVATE_DETAIL); });
    const thrown = new Proxy({}, { get: getter, getPrototypeOf: getter });
    const command = new Proxy(input(), { ownKeys() { throw thrown; } });
    fails(() => session().propose(command, timing()), "INVALID_SHAPE");
    expect(getter).not.toHaveBeenCalled();
  });
  it("never permits a caller-created error to carry an unbounded message/code", () => {
    const error = new MvpConnectionContractError(PRIVATE_DETAIL as MvpConnectionErrorCodeV2);
    expect(error.code).toBe("INVALID_SHAPE");
    expect(error.message).toBe("INVALID_SHAPE");
    expect(Object.isFrozen(error)).toBe(true);
  });
});

describe("snapshot, references and closed enums", () => {
  it.each(["keyatlas.mvp-connection-snapshot.v1", INPUT, PRIVATE_DETAIL, null])("rejects unsupported snapshot schema %s", (schema) => {
    fails(() => createMvpConnectionSessionV2({ ...snapshot(), schema }), "UNSUPPORTED_SCHEMA");
  });
  it.each(["keyatlas.mvp-connection-input.v1", PROPOSAL, PRIVATE_DETAIL, null])("rejects unsupported input schema %s", (schema) => {
    fails(() => session().propose(input({ schema }), timing()), "UNSUPPORTED_SCHEMA");
  });
  it.each([0, -0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "7", null])("rejects malformed revision %s", (snapshotRevision) => {
    fails(() => createMvpConnectionSessionV2({ ...snapshot(), snapshotRevision }), "INVALID_REFERENCE");
    fails(() => session().propose(input({ snapshotRevision }), timing()), "INVALID_REFERENCE");
  });
  it("accepts the largest safe revision but never accepts another snapshot revision", () => {
    const current = createMvpConnectionSessionV2({ ...snapshot(), snapshotRevision: Number.MAX_SAFE_INTEGER });
    expect(current.propose(input({ snapshotRevision: Number.MAX_SAFE_INTEGER }), timing()).snapshotRevision).toBe(Number.MAX_SAFE_INTEGER);
    fails(() => current.propose(input(), timing()), "SNAPSHOT_MISMATCH");
    fails(() => session().propose(input({ snapshotRevision: 8 }), timing()), "SNAPSHOT_MISMATCH");
  });
  it.each([-0, -1, 128, 0.5, NaN, Infinity, "0", null])("rejects noncanonical reference %s in context and input", (reference) => {
    fails(() => createMvpConnectionSessionV2({ ...snapshot(), services: [{ reference, providerSlug: "openai" }] }), "INVALID_REFERENCE");
    for (const key of ["sourceServiceRef", "keyRef", "targetRef"]) {
      fails(() => session().propose(input({ [key]: reference }), timing()), "INVALID_REFERENCE");
    }
  });
  it.each(["services", "keys", "targets"] as const)("rejects duplicate reference in %s", (key) => {
    const context = snapshot();
    context[key][1]!.reference = context[key][0]!.reference;
    fails(() => createMvpConnectionSessionV2(context), "DUPLICATE_REFERENCE");
  });
  it("requires key ownership to resolve to an existing source service", () => {
    const context = snapshot();
    context.keys[0]!.sourceServiceRef = 127;
    fails(() => createMvpConnectionSessionV2(context), "INVALID_REFERENCE");
    fails(() => session().propose(input({ sourceServiceRef: 3 }), timing()), "INVALID_REFERENCE");
    fails(() => session().propose(input({ keyRef: 4 }), timing()), "INVALID_REFERENCE");
    expect(session().propose(input({ sourceServiceRef: 3, keyRef: 4 }), timing()).providerSlug).toBe("anthropic");
  });
  it.each(["sourceServiceRef", "keyRef", "targetRef"])("rejects an unresolved but in-range %s", (key) => {
    fails(() => session().propose(input({ [key]: 127 }), timing()), "INVALID_REFERENCE");
  });
  it.each(["OPENAI", "unknown", "", PRIVATE_DETAIL, null, 1])("rejects unknown provider %s", (providerSlug) => {
    fails(() => createMvpConnectionSessionV2({ ...snapshot(), services: [{ reference: 0, providerSlug }] }), "UNKNOWN_PROVIDER");
  });
  it.each(["mcp", "APP", "", PRIVATE_DETAIL, null, 1])("rejects unknown usage %s", (usage) => {
    fails(() => createMvpConnectionSessionV2({ ...snapshot(), targets: [{ reference: 2, usage }] }), "UNKNOWN_USAGE_KIND");
  });
  it.each(["email", "ai", "verified", PRIVATE_DETAIL, null, 1])("rejects unknown source %s", (sourceKind) => {
    fails(() => session().propose(input({ sourceKind }), timing()), "UNKNOWN_SOURCE");
  });
});

describe("bounded dense arrays and batch relationships", () => {
  it.each(["services", "keys", "targets"] as const)("caps %s at 128 before reading rows", (key) => {
    fails(() => createMvpConnectionSessionV2({ ...snapshot(), [key]: Array(129).fill(null) }), "LIMITS_EXCEEDED");
  });
  it("accepts all boundary references and 128 distinct target relations", () => {
    const refs = Array.from({ length: 128 }, (_, reference) => reference);
    const current = createMvpConnectionSessionV2({ schema: SNAPSHOT, snapshotRevision: 1,
      services: refs.map((reference) => ({ reference, providerSlug: "custom" })),
      keys: refs.map((reference) => ({ reference, sourceServiceRef: reference })),
      targets: refs.map((reference) => ({ reference, usage: "other" })) });
    const batch = current.proposeBatch(refs.map((targetRef) => input({ snapshotRevision: 1, sourceServiceRef: 0, keyRef: 0, targetRef })), timing());
    expect(batch).toHaveLength(128);
    expect(batch[0]!.sourceServiceRef).toBe(0);
    expect(batch[127]!.targetRef).toBe(127);
    expect(Object.isFrozen(batch)).toBe(true);
    for (const proposal of batch) exactProposal(proposal);
    expect(current.propose(input({ snapshotRevision: 1, sourceServiceRef: 127, keyRef: 127, targetRef: 127 }), timing()).keyRef).toBe(127);
  });
  it("allows one key connected to two distinct MCP targets of the same usage but rejects duplicate relation identity", () => {
    const context = snapshot();
    for (const target of context.targets) target.usage = "mcp_server";
    const current = createMvpConnectionSessionV2(context);
    const batch = current.proposeBatch([input(), input({ targetRef: 5, sourceKind: "import" })], timing());
    expect(batch.map(({ usage }) => usage)).toEqual(["mcp_server", "mcp_server"]);
    expect(batch.map(({ targetRef }) => targetRef)).toEqual([2, 5]);
    expect(batch.map(({ keyRef }) => keyRef)).toEqual([1, 1]);
    expect(current.confirm(batch[1], timing()).targetRef).toBe(5);
    fails(() => current.proposeBatch([input(), input({ sourceKind: "mail", observedAt: null })], timing()), "DUPLICATE_CONNECTION");
    // Invalid batches neither close the context nor turn a valid relation into a duplicate.
    expect(current.proposeBatch([input()], timing())).toHaveLength(1);
  });
  it("rejects an invalid later batch item without publishing a partial batch", () => {
    const current = session();
    fails(() => current.proposeBatch([input(), input({ targetRef: 127 })], timing()), "INVALID_REFERENCE");
    expect(current.proposeBatch([input(), input({ targetRef: 5 })], timing())).toHaveLength(2);
  });
  it("rejects an over-limit batch before inspecting untrusted items", () => {
    const trap = vi.fn(() => { throw new Error(PRIVATE_DETAIL); });
    const values = Array(129).fill(new Proxy({}, { ownKeys: trap }));
    fails(() => session().proposeBatch(values, timing()), "LIMITS_EXCEEDED");
    expect(trap).not.toHaveBeenCalled();
  });
  const malformedArrays: Array<[string, () => unknown]> = [
    ["object", () => ({ length: 1, 0: input() })], ["null", () => null], ["sparse", () => Array(1)],
    ["extra property", () => Object.assign([input()], { note: PRIVATE_DETAIL })],
    ["symbol", () => Object.assign([input()], { [Symbol(PRIVATE_DETAIL)]: 1 })],
    ["non-array prototype", () => Object.setPrototypeOf([input()], null)],
    ["nonenumerable index", () => Object.defineProperty([input()], "0", { enumerable: false })],
  ];
  it.each(malformedArrays)("rejects %s batch shape", (_name, make) => {
    fails(() => session().proposeBatch(make(), timing()), "INVALID_SHAPE");
  });
  it.each(["services", "keys", "targets"] as const)("rejects holes and extra array properties in %s", (key) => {
    fails(() => createMvpConnectionSessionV2({ ...snapshot(), [key]: Array(1) }), "INVALID_SHAPE");
    const context = snapshot();
    Object.assign(context[key], { note: PRIVATE_DETAIL });
    fails(() => createMvpConnectionSessionV2(context), "INVALID_SHAPE");
  });
  it("rejects array index accessors without invoking them", () => {
    const getter = vi.fn(() => { throw new Error(PRIVATE_DETAIL); });
    const batch = [input()];
    Object.defineProperty(batch, "0", { get: getter, enumerable: true });
    fails(() => session().proposeBatch(batch, timing()), "INVALID_SHAPE");
    const context = snapshot();
    Object.defineProperty(context.services, "0", { get: getter, enumerable: true });
    fails(() => createMvpConnectionSessionV2(context), "INVALID_SHAPE");
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("explicit canonical time and freshness", () => {
  it.each([[-1, "INVALID_TIME"], [0, "recent"], [DAY, "recent"], [DAY + 1, "stale"]] as const)("evaluates exact evidence age %s", (age, expected) => {
    const command = input({ observedAt: new Date(NOW - age).toISOString() });
    if (expected === "INVALID_TIME") fails(() => session().propose(command, timing()), "INVALID_TIME");
    else {
      const proposal = session().propose(command, timing());
      expect(proposal.freshness).toBe(expected);
      expect(proposal.verification).toBe(expected === "recent" ? "candidate" : "needs_confirmation");
    }
  });
  it("keeps unknown dates null rather than synthesizing discovery time", () => {
    const current = session();
    const proposal = current.propose(input({ observedAt: null }), timing());
    expect(proposal).toMatchObject({ observedAt: null, freshness: "unknown", verification: "needs_confirmation" });
    expect(current.confirm(proposal, timing({ nowMs: NOW + DAY }))).toMatchObject({
      observedAt: null, freshness: "unknown", verification: "needs_confirmation", proof: "not-established" });
  });
  it.each(["2026-02-30T12:00:00.000Z", "2025-02-29T12:00:00.000Z", "2026-09-28T24:00:00.000Z",
    "2026-09-28T12:00:00Z", "2026-09-28T12:00:00.00Z", "2026-09-28T12:00:00.0000Z",
    "2026-09-28T12:00:00.000+00:00", "2026-09-28T12:00:00.000z", "2026-09-28", "",
    "2026-09-28T12:00:60.000Z", "1969-12-31T23:59:59.999Z", "0000-01-01T00:00:00.000Z",
    "2026-09-28T12:00:00.000Z ", 1, undefined])("rejects invalid/noncanonical observation %s", (observedAt) => {
    fails(() => session().propose(input({ observedAt }), timing()), "INVALID_TIME");
  });
  it("supports epoch, leap-day and year-9999 timing boundaries without an ambient clock", () => {
    for (const nowMs of [0, Date.parse("2028-02-29T00:00:00.000Z"), MAX_TIME]) {
      const iso = new Date(nowMs).toISOString();
      const current = session();
      const proposal = current.propose(input({ observedAt: iso }), timing({ nowMs, maxEvidenceAgeMs: 1 }));
      expect(proposal.assessedAt).toBe(iso);
      expect(proposal.freshness).toBe("recent");
      expect(current.confirm(proposal, timing({ nowMs, maxEvidenceAgeMs: 1 })).confirmedAt).toBe(iso);
    }
  });
  it.each([-1, 0.5, NaN, Infinity, MAX_TIME + 1, "1", null])("rejects invalid nowMs %s", (nowMs) => {
    fails(() => session().propose(input(), timing({ nowMs })), "INVALID_TIME");
  });
  it.each([0, -1, 0.5, NaN, Infinity, 90 * DAY + 1, "1", null])("rejects invalid max evidence age %s", (maxEvidenceAgeMs) => {
    fails(() => session().propose(input(), timing({ maxEvidenceAgeMs })), "INVALID_TIME");
  });
  it("accepts the full 90-day evidence bound including its exact boundary", () => {
    const proposal = session().propose(input({ observedAt: new Date(NOW - 90 * DAY).toISOString() }), timing({ maxEvidenceAgeMs: 90 * DAY }));
    expect(proposal.freshness).toBe("recent");
  });
});

describe("confirmation identity, provenance and session closure", () => {
  it("confirms only a local user decision and preserves original evidence without claiming proof", () => {
    const current = session();
    const proposal = current.propose(input({ sourceKind: "mail" }), timing());
    const confirmation = current.confirm(proposal, timing({ nowMs: NOW + 5000 }));
    expect(Object.keys(confirmation).sort()).toEqual([...proposalKeys, "userDecision", "confirmedAt", "proof"].sort());
    expect(confirmation).toEqual({ ...proposal, schema: CONFIRMATION, assessedAt: "2026-09-28T12:00:05.000Z",
      confirmedAt: "2026-09-28T12:00:05.000Z", userDecision: "confirmed", proof: "not-established" });
    expect(Object.isFrozen(confirmation)).toBe(true);
    expect(Reflect.set(confirmation, "verification", "verified")).toBe(false);
    expect(proposal.schema).toBe(PROPOSAL);
    expect(proposal.assessedAt).toBe("2026-09-28T12:00:00.000Z");
    expect(current.confirm(proposal, timing({ nowMs: NOW + 5000 }))).toEqual(confirmation);
  });
  it("fresh evidence becomes stale at confirmation without rewriting the observation", () => {
    const current = session();
    const proposal = current.propose(input({ observedAt: new Date(NOW).toISOString() }), timing());
    expect(current.confirm(proposal, timing({ nowMs: NOW + DAY })).freshness).toBe("recent");
    const late = current.confirm(proposal, timing({ nowMs: NOW + DAY + 1 }));
    expect(late.freshness).toBe("stale");
    expect(late.verification).toBe("needs_confirmation");
    expect(late.observedAt).toBe(proposal.observedAt);
    expect(late.proof).toBe("not-established");
  });
  it("confirmation cannot relax original freshness policy, but can use a stricter window", () => {
    const current = session();
    const stale = current.propose(input({ observedAt: new Date(NOW - 2 * DAY).toISOString() }), timing());
    expect(current.confirm(stale, timing({ maxEvidenceAgeMs: 90 * DAY })).freshness).toBe("stale");
    const recent = current.propose(input({ observedAt: new Date(NOW - 1000).toISOString() }), timing());
    expect(current.confirm(recent, timing({ maxEvidenceAgeMs: 999 })).freshness).toBe("stale");
  });
  it("repeated confirmation retains the strictest previously applied freshness window", () => {
    const current = session();
    const proposal = current.propose(input({ observedAt: new Date(NOW - 1000).toISOString() }), timing());
    expect(current.confirm(proposal, timing({ maxEvidenceAgeMs: 999 })).freshness).toBe("stale");
    const relaxed = current.confirm(proposal, timing({ nowMs: NOW + 1, maxEvidenceAgeMs: 90 * DAY }));
    expect(relaxed.freshness).toBe("stale");
    expect(relaxed.verification).toBe("needs_confirmation");
    expect(relaxed.observedAt).toBe(proposal.observedAt);
    expect(relaxed.proof).toBe("not-established");
  });
  it("repeated confirmation cannot move backwards from the last successful confirmation", () => {
    const current = session();
    const proposal = current.propose(input(), timing());
    const last = current.confirm(proposal, timing({ nowMs: NOW + 5000 }));
    fails(() => current.confirm(proposal, timing({ nowMs: NOW + 4999 })), "INVALID_TIME");
    expect(current.confirm(proposal, timing({ nowMs: NOW + 5000 }))).toEqual(last);
  });
  it("rejects confirmation before original assessment even when the observation itself is older", () => {
    const current = session();
    const proposal = current.propose(input(), timing());
    fails(() => current.confirm(proposal, timing({ nowMs: NOW - 1 })), "INVALID_TIME");
  });
  it.each(["spread", "json", "structured", "prototype", "proxy"])("rejects a %s copy of a valid proposal", (kind) => {
    const current = session();
    const original = current.propose(input(), timing());
    const copy = kind === "spread" ? { ...original } : kind === "json" ? JSON.parse(JSON.stringify(original))
      : kind === "structured" ? structuredClone(original) : kind === "prototype" ? Object.create(original) : new Proxy(original, {});
    fails(() => current.confirm(copy, timing()), "UNRECOGNIZED_PROPOSAL");
    expect(current.confirm(original, timing()).proof).toBe("not-established");
  });
  it("rejects another session's proposal even when both snapshots and output fields match", () => {
    const first = session();
    const second = session();
    const proposal = first.propose(input(), timing());
    expect(second.propose(input(), timing())).toEqual(proposal);
    fails(() => second.confirm(proposal, timing()), "UNRECOGNIZED_PROPOSAL");
  });
  it("does not accept a confirmation as a fresh proposal capability", () => {
    const current = session();
    const proposal = current.propose(input(), timing());
    fails(() => current.confirm(current.confirm(proposal, timing()), timing()), "UNRECOGNIZED_PROPOSAL");
  });
  it.each([null, undefined, false, 1, "synthetic", {}, []])("rejects an unissued confirmation input %s", (proposal) => {
    fails(() => session().confirm(proposal, timing()), "UNRECOGNIZED_PROPOSAL");
  });
  it("does not inspect getters or proxy traps on an unrecognized proposal", () => {
    const trap = vi.fn(() => { throw new Error(PRIVATE_DETAIL); });
    const proposal = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
    fails(() => session().confirm(proposal, timing()), "UNRECOGNIZED_PROPOSAL");
    expect(trap).not.toHaveBeenCalled();
  });
  it("close is idempotent and invalidates every proposal method without affecting other sessions", () => {
    const current = session();
    const other = session();
    const proposal = current.propose(input(), timing());
    current.close(); current.close();
    fails(() => current.propose(input(), timing()), "SESSION_CLOSED");
    fails(() => current.proposeBatch([], timing()), "SESSION_CLOSED");
    fails(() => current.confirm(proposal, timing()), "SESSION_CLOSED");
    fails(() => current.propose(null, null), "SESSION_CLOSED");
    expect(other.propose(input(), timing()).verification).toBe("candidate");
  });
  it.each(["propose", "proposeBatch", "confirm"] as const)("close during untrusted parsing cannot publish a %s result", (method) => {
    const current = session();
    const proposal = current.propose(input(), timing());
    const closingTiming = new Proxy(timing(), { getPrototypeOf(target) { current.close(); return Object.getPrototypeOf(target); } });
    if (method === "propose") fails(() => current.propose(input(), closingTiming), "SESSION_CLOSED");
    if (method === "proposeBatch") fails(() => current.proposeBatch([input()], closingTiming), "SESSION_CLOSED");
    if (method === "confirm") fails(() => current.confirm(proposal, closingTiming), "SESSION_CLOSED");
  });
  it("close during input descriptor collection invalidates a context captured earlier in the same call", () => {
    const current = session();
    const command = new Proxy(input(), { ownKeys(target) { current.close(); return Reflect.ownKeys(target); } });
    fails(() => current.propose(command, timing()), "SESSION_CLOSED");
  });
  it("an empty batch cannot bypass a close triggered while parsing timing", () => {
    const current = session();
    const clock = new Proxy(timing(), { getPrototypeOf(target) { current.close(); return Object.getPrototypeOf(target); } });
    fails(() => current.proposeBatch([], clock), "SESSION_CLOSED");
  });
});
