import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { test } from "node:test";
import { MAIL_LIMITS } from "../src/server/mail/contracts.ts";
import {
  getVerifiedAnalysisHandoff, MAIL_ANALYSIS_POLICY, runMailAnalysis,
  type AnalysisReceipt, type MailAnalysisAdapters, type MailRunOptions,
  type MailRunResult, type RunContext,
} from "../src/server/mail/run-analysis.ts";

// These are in-memory synthetic adapters, not proof of production OAuth, quota
// transactions, provider cancellation, network limits, or durable storage.
const NOW = Date.parse("2026-09-28T00:00:00.000Z");
const PRIVATE_MARKER = "SYNTHETIC_PRIVATE_ADAPTER_ONLY";
const OPTIONS: MailRunOptions = Object.freeze({
  operationId: "synthetic-operation", mailboxBindingId: "synthetic-mailbox",
  recipientId: "synthetic-analyzer", timeoutMs: 2000,
});
type FailureCode = Extract<MailRunResult, { ok: false }>["code"];
type StageName = "authority" | "quota" | "mailbox" | "analysis";
type Ledger = Set<string>;

function validAuthority(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ownerId: "synthetic-owner", sessionId: "synthetic-session", sessionRevision: 1, dataGeneration: 1,
    sessionExpiresAt: NOW + 60000,
    grantOwnerId: "synthetic-owner", grantSessionId: "synthetic-session",
    mailboxBindingId: OPTIONS.mailboxBindingId, grantMailboxBindingId: OPTIONS.mailboxBindingId,
    grantId: "synthetic-grant", grantRevision: 1, grantExpiresAt: NOW + 60000,
    operationId: OPTIONS.operationId, recipientId: OPTIONS.recipientId,
    policyVersion: MAIL_ANALYSIS_POLICY.version, mailRead: true, externalAnalysis: true,
    ...patch,
  };
}

function granted(context: RunContext): Record<string, unknown> {
  const authority = context.authority;
  return {
    status: "granted", ownerId: authority.ownerId, sessionId: authority.sessionId,
    sessionRevision: authority.sessionRevision, dataGeneration: authority.dataGeneration,
    mailboxBindingId: authority.mailboxBindingId, grantId: authority.grantId,
    grantRevision: authority.grantRevision, operationId: authority.operationId,
    recipientId: authority.recipientId, policyVersion: authority.policyVersion, remaining: 0,
  };
}

function mailSource(id = "synthetic-message") {
  return {
    id, internalDate: String(NOW - 86400000), payload: {
      mimeType: "text/plain", headers: [{ name: "Subject", value: "Synthetic Studio notice" }],
      body: { data: Buffer.from("Synthetic Studio grants 100 credits.").toString("base64url") },
    },
  };
}
const MAIL_JSON = JSON.stringify([mailSource()]);
const DISCOVERY = Object.freeze({
  evidence_message_index: 0, confidence: "high", benefit_kind: "credit",
  service_name: { value: "Synthetic Studio", part: "subject", quote: "Synthetic Studio" },
  benefit_name: null, unit: { value: "credits", part: "body", quote: "100 credits" },
  granted_amount: { value: 100, part: "body", quote: "grants 100 credits" },
  remaining_amount: null, trial_days: null, remaining_days: null, expires_at: null, observed_at: null,
});
const ANALYSIS_JSON = JSON.stringify({ schema: "keyatlas.gmail-candidates.v1", discoveries: [DISCOVERY] });

function harness(overrides: Partial<MailAnalysisAdapters> = {}, ledger: Ledger = new Set()) {
  const state = {
    authority: validAuthority() as unknown, now: NOW,
    calls: { authority: 0, quota: 0, mailbox: 0, analysis: 0 },
    order: [] as StageName[], signals: [] as AbortSignal[], contexts: [] as RunContext[],
  };
  const observe = (name: StageName, signal: AbortSignal, context?: RunContext) => {
    state.calls[name]++;
    state.order.push(name);
    state.signals.push(signal);
    if (context) state.contexts.push(context);
  };
  const adapters: MailAnalysisAdapters = {
    readAuthority: async (signal) => {
      observe("authority", signal);
      return overrides.readAuthority ? overrides.readAuthority(signal) : state.authority;
    },
    reserveQuota: async (context, signal) => {
      observe("quota", signal, context);
      if (overrides.reserveQuota) return overrides.reserveQuota(context, signal);
      // Deliberately no await between check and consume in this local fake. The
      // production adapter must implement its own atomic persistent operation.
      const key = JSON.stringify([context.authority.ownerId, context.authority.operationId]);
      if (ledger.has(key)) return { status: "denied" };
      ledger.add(key);
      return granted(context);
    },
    readMailbox: async (context, signal) => {
      observe("mailbox", signal, context);
      return overrides.readMailbox ? overrides.readMailbox(context, signal) : MAIL_JSON;
    },
    analyze: async (messages, context, signal) => {
      observe("analysis", signal, context);
      return overrides.analyze ? overrides.analyze(messages, context, signal) : ANALYSIS_JSON;
    },
    now: () => overrides.now ? overrides.now() : state.now,
  };
  return { adapters, state, overrides, ledger };
}

function expectFailure(result: MailRunResult, code: FailureCode) {
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.code, code);
  assert.deepEqual(Object.keys(result).sort(), ["code", "ok", "receipt"]);
  assert.ok(!JSON.stringify(result).includes(PRIVATE_MARKER));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.receipt));
  assert.equal(getVerifiedAnalysisHandoff(result), null, "failure results never carry successful-run provenance");
}

function expectStages(
  receipt: AnalysisReceipt, quota: AnalysisReceipt["quota"],
  mailbox: AnalysisReceipt["mailbox"], analysis: AnalysisReceipt["analysis"],
) {
  assert.equal(receipt.schema, "keyatlas.mail-analysis-receipt.v1");
  assert.equal(receipt.policyVersion, MAIL_ANALYSIS_POLICY.version);
  assert.equal(receipt.quota, quota);
  assert.equal(receipt.mailbox, mailbox);
  assert.equal(receipt.analysis, analysis);
  assert.equal(receipt.undoAvailable, false);
}

function expectNoProviders(fixture: ReturnType<typeof harness>, quota = 0) {
  assert.equal(fixture.state.calls.quota, quota);
  assert.equal(fixture.state.calls.mailbox, 0);
  assert.equal(fixture.state.calls.analysis, 0);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function pendingStage(stage: StageName) {
  const entered = deferred<void>();
  const pending = deferred<unknown>();
  let signal: AbortSignal | undefined;
  let lateValue: unknown;
  const capture = (received: AbortSignal, value: unknown) => {
    signal = received;
    lateValue = value;
    entered.resolve();
    return pending.promise;
  };
  const overrides: Partial<MailAnalysisAdapters> = {};
  if (stage === "authority") overrides.readAuthority = (received) => capture(received, validAuthority());
  if (stage === "quota") overrides.reserveQuota = (context, received) => capture(received, granted(context));
  if (stage === "mailbox") overrides.readMailbox = (_context, received) => capture(received, MAIL_JSON);
  if (stage === "analysis") overrides.analyze = (_messages, _context, received) => capture(received, ANALYSIS_JSON);
  return { entered, pending, overrides, signal: () => signal, lateValue: () => lateValue };
}

async function settleLate(pending: ReturnType<typeof pendingStage>, action: "resolve" | "reject") {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    if (action === "resolve") pending.pending.resolve(pending.lateValue());
    else pending.pending.reject(new Error(PRIVATE_MARKER));
    await immediate();
    await immediate();
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
}

function assertFrozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertFrozenTree(child);
}

function busyWait(milliseconds: number) {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) { /* Bounded timer-starvation regression, no network. */ }
}

test("success returns only ephemeral pending-review candidates with observed stage receipt", async () => {
  const fixture = harness();
  const result = await runMailAnalysis(fixture.adapters, OPTIONS);
  assert.ok(result.ok);
  assert.equal(result.extractedAt, new Date(NOW).toISOString());
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.reviewStatus, "pending-review");
  assert.equal(result.candidates[0]!.serviceName.verification, "unverified");
  assert.equal(result.candidates[0]!.receivedAt, new Date(NOW - 86400000).toISOString());
  assert.equal(result.candidates[0]!.observedAt, null);
  assert.ok(result.candidates[0]!.reviewReasons.includes("NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF"));
  assert.deepEqual(Object.keys(result).sort(), ["candidates", "extractedAt", "ok", "receipt"]);
  for (const field of ["confirmedAt", "persistedAt", "recordId", "ownerId", "sessionId", "sessionRevision", "dataGeneration"]) {
    assert.ok(!(field in result.candidates[0]!));
  }
  expectStages(result.receipt, "consumed", "returned", "returned");
  assert.deepEqual(result.receipt.authorityAtStart, {
    operationId: OPTIONS.operationId, mailboxBindingId: OPTIONS.mailboxBindingId,
    recipientId: OPTIONS.recipientId, grantId: "synthetic-grant", grantRevision: 1,
    authorizedAt: new Date(NOW).toISOString(),
  });
  assert.deepEqual(fixture.state.order, ["authority", "quota", "authority", "mailbox", "authority",
    "authority", "analysis", "authority", "authority"]);
  assertFrozenTree(result);
});

test("empty mailbox succeeds with an immutable empty candidate list and never starts analysis", async () => {
  const fixture = harness({ readMailbox: async () => "[]" });
  const result = await runMailAnalysis(fixture.adapters, OPTIONS);
  assert.ok(result.ok);
  assert.deepEqual(result.candidates, []);
  assert.equal(fixture.state.calls.analysis, 0);
  assert.equal(fixture.state.calls.authority, 4);
  expectStages(result.receipt, "consumed", "returned", "not-started");
  assertFrozenTree(result);
  assert.equal(getVerifiedAnalysisHandoff(result)?.result, result);
});

test("successful objects retain a private frozen authority binding without changing public output", async () => {
  const fixture = harness();
  const rawAuthority = validAuthority({ sessionRevision: 7, dataGeneration: 9,
    token: PRIVATE_MARKER, nestedPrivate: { value: PRIVATE_MARKER } });
  fixture.state.authority = rawAuthority;
  const result = await runMailAnalysis(fixture.adapters, OPTIONS);
  assert.ok(result.ok);
  const handoff = getVerifiedAnalysisHandoff(result);
  assert.ok(handoff);
  assert.equal(handoff.result, result);
  assert.equal(handoff.authority, fixture.state.contexts[0]!.authority);
  assert.equal(handoff.authority.ownerId, "synthetic-owner");
  assert.equal(handoff.authority.sessionId, "synthetic-session");
  assert.equal(handoff.authority.sessionRevision, 7);
  assert.equal(handoff.authority.dataGeneration, 9);
  assert.deepEqual(Object.keys(handoff).sort(), ["authority", "result"]);
  assertFrozenTree(handoff);
  assert.throws(() => { (handoff.authority as unknown as Record<string, unknown>).dataGeneration = 10; }, TypeError);
  assert.throws(() => { (handoff as unknown as Record<string, unknown>).result = {}; }, TypeError);
  assert.throws(() => { (result as unknown as Record<string, unknown>).extractedAt = "synthetic-changed"; }, TypeError);
  rawAuthority.sessionRevision = 100;
  rawAuthority.dataGeneration = 100;
  assert.equal(handoff.authority.sessionRevision, 7, "the binding is a frozen snapshot, not a live adapter object");
  assert.equal(handoff.authority.dataGeneration, 9);
  assert.equal(getVerifiedAnalysisHandoff(result), handoff);
  await immediate();
  assert.equal(getVerifiedAnalysisHandoff(result), handoff, "handoff lookup does not consume same-object provenance");
  assert.deepEqual(Reflect.ownKeys(result).sort(), ["candidates", "extractedAt", "ok", "receipt"]);
  const publicText = JSON.stringify(result);
  for (const field of ["ownerId", "sessionId", "sessionRevision", "dataGeneration", "authority", "token", "nestedPrivate"]) {
    assert.ok(!publicText.includes(`"${field}"`));
  }
  assert.ok(!publicText.includes(PRIVATE_MARKER));
  assert.ok(!JSON.stringify(handoff).includes(PRIVATE_MARKER));
});

test("handoff lookup rejects structural copies, serialized clones and fabricated success objects", async () => {
  const fixture = harness();
  const result = await runMailAnalysis(fixture.adapters, OPTIONS);
  assert.ok(result.ok);
  const handoff = getVerifiedAnalysisHandoff(result);
  assert.ok(handoff);
  let getterCalls = 0;
  const proxy = new Proxy(result, { get() { getterCalls++; throw new Error(PRIVATE_MARKER); } });
  const revoked = Proxy.revocable(result, {});
  revoked.revoke();
  for (const input of [undefined, null, false, 0, "synthetic", Symbol("synthetic"), () => result, [], {},
    { ...result }, Object.freeze({ ...result }), JSON.parse(JSON.stringify(result)) as unknown,
    structuredClone(result), Object.create(result), handoff, proxy, revoked.proxy,
    { ok: true, candidates: result.candidates, extractedAt: result.extractedAt, receipt: result.receipt },
    { ok: false, code: "QUOTA_DENIED", receipt: result.receipt }]) {
    assert.equal(getVerifiedAnalysisHandoff(input), null);
  }
  assert.equal(getterCalls, 0, "identity lookup must not read untrusted object properties");
  assert.equal(getVerifiedAnalysisHandoff(result), handoff, "rejected copies never invalidate the genuine object");
  const rejected = harness({ readAuthority: async () => null });
  const failure = await runMailAnalysis(rejected.adapters, OPTIONS);
  expectFailure(failure, "AUTH_REQUIRED");
  assert.equal(getVerifiedAnalysisHandoff({ ...failure, ok: true }), null);
});

test("identical public results retain distinct owner, session revision and generation bindings", async () => {
  const first = harness();
  const second = harness();
  second.state.authority = validAuthority({
    ownerId: "synthetic-second-owner", grantOwnerId: "synthetic-second-owner",
    sessionId: "synthetic-second-session", grantSessionId: "synthetic-second-session",
    sessionRevision: 2, dataGeneration: 3,
  });
  const one = await runMailAnalysis(first.adapters, OPTIONS);
  const two = await runMailAnalysis(second.adapters, OPTIONS);
  assert.ok(one.ok && two.ok);
  assert.notEqual(one, two);
  assert.deepEqual(one, two);
  const firstHandoff = getVerifiedAnalysisHandoff(one)!;
  const secondHandoff = getVerifiedAnalysisHandoff(two)!;
  assert.notEqual(firstHandoff, secondHandoff);
  assert.equal(firstHandoff.result, one);
  assert.equal(secondHandoff.result, two);
  assert.equal(firstHandoff.authority.ownerId, "synthetic-owner");
  assert.equal(firstHandoff.authority.sessionRevision, 1);
  assert.equal(firstHandoff.authority.dataGeneration, 1);
  assert.equal(secondHandoff.authority.ownerId, "synthetic-second-owner");
  assert.equal(secondHandoff.authority.sessionRevision, 2);
  assert.equal(secondHandoff.authority.dataGeneration, 3);
});

test("positive safe-integer maxima are retained exactly in authority and quota bindings", async () => {
  const fixture = harness();
  fixture.state.authority = validAuthority({ sessionRevision: Number.MAX_SAFE_INTEGER, dataGeneration: Number.MAX_SAFE_INTEGER });
  const result = await runMailAnalysis(fixture.adapters, OPTIONS);
  assert.ok(result.ok);
  const handoff = getVerifiedAnalysisHandoff(result)!;
  assert.equal(handoff.authority.sessionRevision, Number.MAX_SAFE_INTEGER);
  assert.equal(handoff.authority.dataGeneration, Number.MAX_SAFE_INTEGER);
  assert.ok(fixture.state.contexts.every((context) => context.authority.sessionRevision === Number.MAX_SAFE_INTEGER
    && context.authority.dataGeneration === Number.MAX_SAFE_INTEGER));
});

const badAuthority: Array<[string, unknown, FailureCode]> = [
  ["absent principal", null, "AUTH_REQUIRED"],
  ["undefined snapshot", undefined, "AUTH_REQUIRED"],
  ["array snapshot", [], "AUTH_REQUIRED"],
  ["string snapshot", "connected", "AUTH_REQUIRED"],
  ["empty owner", validAuthority({ ownerId: "" }), "AUTH_REQUIRED"],
  ["malformed session", validAuthority({ sessionId: "bad session" }), "AUTH_REQUIRED"],
  ["expired session", validAuthority({ sessionExpiresAt: NOW }), "AUTH_REQUIRED"],
  ["non-numeric session expiry", validAuthority({ sessionExpiresAt: String(NOW + 60000) }), "AUTH_REQUIRED"],
  ["NaN session expiry", validAuthority({ sessionExpiresAt: NaN }), "AUTH_REQUIRED"],
  ["fractional session expiry", validAuthority({ sessionExpiresAt: NOW + 0.5 }), "AUTH_REQUIRED"],
  ["invalid grant id", validAuthority({ grantId: "bad grant" }), "CONSENT_REQUIRED"],
  ["zero grant revision", validAuthority({ grantRevision: 0 }), "CONSENT_REQUIRED"],
  ["fractional grant revision", validAuthority({ grantRevision: 1.5 }), "CONSENT_REQUIRED"],
  ["NaN grant revision", validAuthority({ grantRevision: NaN }), "CONSENT_REQUIRED"],
  ["wrong grant owner", validAuthority({ grantOwnerId: "synthetic-other" }), "CONSENT_REQUIRED"],
  ["wrong grant session", validAuthority({ grantSessionId: "synthetic-other" }), "CONSENT_REQUIRED"],
  ["wrong mailbox", validAuthority({ mailboxBindingId: "synthetic-other" }), "CONSENT_REQUIRED"],
  ["wrong grant mailbox", validAuthority({ grantMailboxBindingId: "synthetic-other" }), "CONSENT_REQUIRED"],
  ["expired grant", validAuthority({ grantExpiresAt: NOW }), "CONSENT_REQUIRED"],
  ["invalid grant expiry", validAuthority({ grantExpiresAt: Infinity }), "CONSENT_REQUIRED"],
  ["wrong operation", validAuthority({ operationId: "synthetic-other" }), "CONSENT_REQUIRED"],
  ["wrong recipient", validAuthority({ recipientId: "synthetic-other" }), "CONSENT_REQUIRED"],
  ["wrong policy", validAuthority({ policyVersion: "synthetic-other" }), "CONSENT_REQUIRED"],
];
for (const field of ["sessionRevision", "dataGeneration"]) {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined]) {
    badAuthority.push([`invalid ${field} (${String(value)})`, validAuthority({ [field]: value }), "AUTH_REQUIRED"]);
  }
}
for (const capability of ["mailRead", "externalAnalysis"]) {
  for (const value of [false, undefined, null, "true", 1, {}]) {
    badAuthority.push([`${capability} must be explicit true (${String(value)})`,
      validAuthority({ [capability]: value }), "CONSENT_REQUIRED"]);
  }
}
for (const field of Object.keys(validAuthority())) {
  const raw = validAuthority();
  delete raw[field];
  badAuthority.push([`missing ${field}`, raw,
    ["ownerId", "sessionId", "sessionRevision", "dataGeneration", "sessionExpiresAt"].includes(field) ? "AUTH_REQUIRED" : "CONSENT_REQUIRED"]);
}
for (const [name, raw, code] of badAuthority) {
  test(`initial authority fails closed before quota or providers: ${name}`, async () => {
    const fixture = harness();
    fixture.state.authority = raw;
    const result = await runMailAnalysis(fixture.adapters, OPTIONS);
    expectFailure(result, code);
    expectNoProviders(fixture);
    expectStages(result.receipt, "not-consumed", "not-started", "not-started");
    assert.equal(result.receipt.authorityAtStart, null);
  });
}

const badOptions: Array<[string, unknown]> = [
  ["null", null], ["undefined", undefined], ["string", "synthetic"],
  ["missing operation", { ...OPTIONS, operationId: undefined }],
  ["malformed operation", { ...OPTIONS, operationId: "unsafe operation" }],
  ["missing mailbox", { ...OPTIONS, mailboxBindingId: undefined }],
  ["missing recipient", { ...OPTIONS, recipientId: undefined }],
  ["malformed recipient", { ...OPTIONS, recipientId: "<synthetic>" }],
  ["fake abort signal", { ...OPTIONS, signal: { aborted: false } }],
  ["null abort signal", { ...OPTIONS, signal: null }],
];
for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 120001, "1000"]) {
  badOptions.push([`invalid timeout ${String(timeoutMs)}`, { ...OPTIONS, timeoutMs }]);
}
for (const [name, options] of badOptions) {
  test(`invalid trusted configuration starts no adapters: ${name}`, async () => {
    const fixture = harness();
    const result = await runMailAnalysis(fixture.adapters, options as MailRunOptions);
    expectFailure(result, "RUN_CONFIG_INVALID");
    assert.equal(fixture.state.calls.authority, 0);
    expectNoProviders(fixture);
  });
}

test("configuration and authority IDs reject trailing LF, CRLF and spaces before any provider call", async () => {
  for (const suffix of ["\n", "\r\n", " "]) {
    for (const field of ["operationId", "mailboxBindingId", "recipientId"] as const) {
      const options = { ...OPTIONS, [field]: OPTIONS[field] + suffix };
      const fixture = harness();
      // Keep the synthetic authority bindings aligned so rejection specifically
      // comes from the ID boundary, not an unrelated downstream mismatch.
      fixture.state.authority = validAuthority({ [field]: options[field],
        ...(field === "mailboxBindingId" ? { grantMailboxBindingId: options[field] } : {}) });
      const result = await runMailAnalysis(fixture.adapters, options);
      expectFailure(result, "RUN_CONFIG_INVALID");
      assert.equal(fixture.state.calls.authority, 0);
      expectNoProviders(fixture);
      expectStages(result.receipt, "not-consumed", "not-started", "not-started");
    }
    for (const field of ["ownerId", "sessionId", "grantId"] as const) {
      const fixture = harness();
      const value = String(validAuthority()[field]) + suffix;
      fixture.state.authority = validAuthority({ [field]: value,
        ...(field === "ownerId" ? { grantOwnerId: value } : {}),
        ...(field === "sessionId" ? { grantSessionId: value } : {}) });
      const result = await runMailAnalysis(fixture.adapters, OPTIONS);
      expectFailure(result, field === "grantId" ? "CONSENT_REQUIRED" : "AUTH_REQUIRED");
      assert.equal(fixture.state.calls.authority, 1);
      expectNoProviders(fixture);
      expectStages(result.receipt, "not-consumed", "not-started", "not-started");
    }
  }
});

test("exact denied quota is a known non-consumption and performs no mailbox call", async () => {
  const fixture = harness({ reserveQuota: async () => ({ status: "denied" }) });
  const result = await runMailAnalysis(fixture.adapters, OPTIONS);
  expectFailure(result, "QUOTA_DENIED");
  expectNoProviders(fixture, 1);
  expectStages(result.receipt, "not-consumed", "not-started", "not-started");
});

const badPermits: Array<[string, (permit: Record<string, unknown>) => unknown]> = [
  ["null", () => null], ["undefined", () => undefined], ["array", () => []],
  ["boolean", () => true], ["unknown status", (permit) => ({ ...permit, status: "maybe" })],
  ["legacy allowed shape", () => ({ allowed: true, remaining: 1 })],
  ["extra field", (permit) => ({ ...permit, syntheticExtra: true })],
  ["denied with extra field", () => ({ status: "denied", remaining: 0 })],
];
for (const remaining of [-1, NaN, Infinity, 0.5, "0", null, Number.MAX_SAFE_INTEGER + 1]) {
  badPermits.push([`invalid remaining ${String(remaining)}`, (permit) => ({ ...permit, remaining })]);
}
for (const field of ["ownerId", "sessionId", "sessionRevision", "dataGeneration", "mailboxBindingId", "grantId", "grantRevision",
  "operationId", "recipientId", "policyVersion"]) {
  badPermits.push([`wrong ${field}`, (permit) => ({ ...permit,
    [field]: ["grantRevision", "sessionRevision", "dataGeneration"].includes(field) ? 2 : "synthetic-other" })]);
}
for (const field of ["status", "ownerId", "sessionId", "sessionRevision", "dataGeneration", "mailboxBindingId", "grantId", "grantRevision",
  "operationId", "recipientId", "policyVersion", "remaining"]) {
  badPermits.push([`missing ${field}`, (permit) => { delete permit[field]; return permit; }]);
}
for (const field of ["sessionRevision", "dataGeneration"]) {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined]) {
    badPermits.push([`invalid ${field} (${String(value)})`, (permit) => ({ ...permit, [field]: value })]);
  }
}
for (const [name, transform] of badPermits) {
  test(`uncertain quota response remains unknown and never reads mailbox: ${name}`, async () => {
    const fixture = harness({ reserveQuota: async (context) => transform(granted(context)) });
    const result = await runMailAnalysis(fixture.adapters, OPTIONS);
    expectFailure(result, "QUOTA_UNAVAILABLE");
    expectNoProviders(fixture, 1);
    expectStages(result.receipt, "unknown", "not-started", "not-started");
  });
}

test("shared synthetic atomic ledger allows at most one provider run for concurrent same-operation calls", async () => {
  const ledger: Ledger = new Set();
  const first = harness({}, ledger);
  const second = harness({}, ledger);
  const results = await Promise.all([
    runMailAnalysis(first.adapters, OPTIONS), runMailAnalysis(second.adapters, OPTIONS),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  const denied = results.find((result) => !result.ok)!;
  expectFailure(denied, "QUOTA_DENIED");
  assert.equal(first.state.calls.mailbox + second.state.calls.mailbox, 1);
  assert.equal(first.state.calls.analysis + second.state.calls.analysis, 1);
  assert.equal(ledger.size, 1);
});

test("grant, session revision, and data generation changes do not reset a used owner-operation ledger key", async () => {
  const fixture = harness();
  assert.ok((await runMailAnalysis(fixture.adapters, OPTIONS)).ok);
  fixture.state.authority = validAuthority({
    grantId: "synthetic-new-grant", grantRevision: 2,
    sessionId: "synthetic-new-session", grantSessionId: "synthetic-new-session",
    sessionRevision: 2, dataGeneration: 2,
  });
  const replay = await runMailAnalysis(fixture.adapters, OPTIONS);
  expectFailure(replay, "QUOTA_DENIED");
  assert.equal(fixture.state.calls.mailbox, 1);
  assert.equal(fixture.state.calls.analysis, 1);
  assert.equal(fixture.ledger.size, 1);
  assert.equal(replay.receipt.authorityAtStart!.grantRevision, 2);
});

test("different explicit operation grants are independent in the synthetic ledger", async () => {
  const ledger: Ledger = new Set();
  const first = harness({}, ledger);
  const second = harness({}, ledger);
  const secondOptions = { ...OPTIONS, operationId: "synthetic-operation-two" };
  second.state.authority = validAuthority({ operationId: secondOptions.operationId });
  const results = await Promise.all([
    runMailAnalysis(first.adapters, OPTIONS), runMailAnalysis(second.adapters, secondOptions),
  ]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(ledger.size, 2);
});

const boundaries = [
  { call: 2, name: "after quota", mailbox: 0, analysis: 0 },
  { call: 3, name: "after mailbox", mailbox: 1, analysis: 0 },
  { call: 4, name: "immediately before analysis", mailbox: 1, analysis: 0 },
  { call: 5, name: "after analysis", mailbox: 1, analysis: 1 },
  { call: 6, name: "before successful output", mailbox: 1, analysis: 1 },
];
for (const boundary of boundaries) {
  for (const change of ["revision", "session-revision", "data-generation", "revoked-mail", "revoked-analysis", "session-expired", "grant-expired"]) {
    test(`${change} ${boundary.name} prevents every subsequent stage and discards candidates`, async () => {
      const fixture = harness();
      fixture.overrides.readAuthority = async () => {
        if (fixture.state.calls.authority !== boundary.call) return validAuthority();
        if (change === "revision") return validAuthority({ grantRevision: 2 });
        if (change === "session-revision") return validAuthority({ sessionRevision: 2 });
        if (change === "data-generation") return validAuthority({ dataGeneration: 2 });
        if (change === "revoked-mail") return validAuthority({ mailRead: false });
        if (change === "revoked-analysis") return validAuthority({ externalAnalysis: false });
        fixture.state.now = NOW + 60000;
        return validAuthority(change === "session-expired"
          ? { grantExpiresAt: NOW + 120000 } : { sessionExpiresAt: NOW + 120000 });
      };
      const result = await runMailAnalysis(fixture.adapters, OPTIONS);
      expectFailure(result, "AUTHORITY_CHANGED");
      assert.equal(fixture.state.calls.authority, boundary.call);
      assert.equal(fixture.state.calls.quota, 1);
      assert.equal(fixture.state.calls.mailbox, boundary.mailbox);
      assert.equal(fixture.state.calls.analysis, boundary.analysis);
      expectStages(result.receipt, "consumed", boundary.mailbox ? "returned" : "not-started",
        boundary.analysis ? "returned" : "not-started");
    });
  }
  test(`authority reader failure ${boundary.name} is redacted and not retried`, async () => {
    const fixture = harness();
    fixture.overrides.readAuthority = async () => {
      if (fixture.state.calls.authority === boundary.call) throw new Error(PRIVATE_MARKER);
      return validAuthority();
    };
    const result = await runMailAnalysis(fixture.adapters, OPTIONS);
    expectFailure(result, "AUTHORITY_UNAVAILABLE");
    assert.equal(fixture.state.calls.authority, boundary.call);
    assert.equal(fixture.state.calls.mailbox, boundary.mailbox);
    assert.equal(fixture.state.calls.analysis, boundary.analysis);
  });
}

for (const field of ["sessionRevision", "dataGeneration"] as const) {
  for (const stage of ["quota", "mailbox", "analysis"] as const) {
    test(`${field} changed inside the ${stage} adapter prevents successful handoff and subsequent dispatch`, async () => {
      const fixture = harness();
      const changeAuthority = () => { fixture.state.authority = validAuthority({ [field]: 2 }); };
      if (stage === "quota") fixture.overrides.reserveQuota = async (context) => { changeAuthority(); return granted(context); };
      if (stage === "mailbox") fixture.overrides.readMailbox = async () => { changeAuthority(); return MAIL_JSON; };
      if (stage === "analysis") fixture.overrides.analyze = async () => { changeAuthority(); return ANALYSIS_JSON; };
      const result = await runMailAnalysis(fixture.adapters, OPTIONS);
      expectFailure(result, "AUTHORITY_CHANGED");
      assert.equal(fixture.state.calls.quota, 1);
      assert.equal(fixture.state.calls.mailbox, stage === "quota" ? 0 : 1);
      assert.equal(fixture.state.calls.analysis, stage === "analysis" ? 1 : 0);
      expectStages(result.receipt, "consumed", stage === "quota" ? "not-started" : "returned",
        stage === "analysis" ? "returned" : "not-started");
    });
  }
}

test("replaced authenticated owner and matching grant still change authority after quota", async () => {
  const fixture = harness();
  fixture.overrides.readAuthority = async () => fixture.state.calls.authority === 1 ? validAuthority()
    : validAuthority({ ownerId: "synthetic-other", grantOwnerId: "synthetic-other" });
  const result = await runMailAnalysis(fixture.adapters, OPTIONS);
  expectFailure(result, "AUTHORITY_CHANGED");
  expectNoProviders(fixture, 1);
});

test("a pre-aborted caller starts no adapter and does not expose its abort reason", async () => {
  const controller = new AbortController();
  controller.abort(PRIVATE_MARKER);
  const fixture = harness();
  const result = await runMailAnalysis(fixture.adapters, { ...OPTIONS, signal: controller.signal });
  expectFailure(result, "RUN_CANCELLED");
  assert.equal(fixture.state.calls.authority, 0);
  expectNoProviders(fixture);
  expectStages(result.receipt, "not-consumed", "not-started", "not-started");
});

for (const stage of ["authority", "quota", "mailbox", "analysis"] as const) {
  for (const action of ["resolve", "reject"] as const) {
    test(`cancellation during ${stage} drops late ${action}, preserves receipt, and handles rejection`, async () => {
      const waiting = pendingStage(stage);
      const fixture = harness(waiting.overrides);
      const controller = new AbortController();
      const run = runMailAnalysis(fixture.adapters, { ...OPTIONS, signal: controller.signal });
      await waiting.entered.promise;
      controller.abort(PRIVATE_MARKER);
      const result = await run;
      expectFailure(result, "RUN_CANCELLED");
      assert.ok(waiting.signal()!.aborted);
      assert.notEqual(waiting.signal()!.reason, PRIVATE_MARKER);
      expectStages(result.receipt, stage === "authority" ? "not-consumed" : stage === "quota" ? "unknown" : "consumed",
        stage === "mailbox" ? "started" : stage === "analysis" ? "returned" : "not-started",
        stage === "analysis" ? "started" : "not-started");
      const before = JSON.stringify({ result, calls: fixture.state.calls });
      await settleLate(waiting, action);
      assert.equal(JSON.stringify({ result, calls: fixture.state.calls }), before);
    });
  }
}

for (const expiry of ["sessionExpiresAt", "grantExpiresAt"]) {
  for (const stage of ["quota", "mailbox", "analysis"] as const) {
    for (const action of ["resolve", "reject"] as const) {
      test(`known ${expiry} expires pending ${stage}; late ${action} stays discarded`, async () => {
        const waiting = pendingStage(stage);
        const fixture = harness(waiting.overrides);
        fixture.state.authority = validAuthority({ [expiry]: NOW + 25 });
        const run = runMailAnalysis(fixture.adapters, OPTIONS);
        await waiting.entered.promise;
        const result = await run;
        expectFailure(result, "AUTHORITY_CHANGED");
        assert.ok(waiting.signal()!.aborted);
        expectStages(result.receipt, stage === "quota" ? "unknown" : "consumed",
          stage === "mailbox" ? "started" : stage === "analysis" ? "returned" : "not-started",
          stage === "analysis" ? "started" : "not-started");
        const before = JSON.stringify({ result, calls: fixture.state.calls });
        await settleLate(waiting, action);
        assert.equal(JSON.stringify({ result, calls: fixture.state.calls }), before);
      });
    }
  }
}

for (const stage of ["authority", "quota", "mailbox", "analysis"] as const) {
  test(`deadline aborts a pending ${stage} and ignores its eventual response`, async () => {
    const waiting = pendingStage(stage);
    const fixture = harness(waiting.overrides);
    const run = runMailAnalysis(fixture.adapters, { ...OPTIONS, timeoutMs: 25 });
    await waiting.entered.promise;
    const result = await run;
    expectFailure(result, "RUN_TIMED_OUT");
    assert.ok(waiting.signal()!.aborted);
    const before = JSON.stringify({ result, calls: fixture.state.calls });
    await settleLate(waiting, "resolve");
    assert.equal(JSON.stringify({ result, calls: fixture.state.calls }), before);
  });
}

test("monotonic deadline stops dispatch even while a fixed wall clock and microtasks starve timers", async () => {
  let nowCalls = 0;
  const fixture = harness({ now: () => { if (++nowCalls === 1) busyWait(35); return NOW; } });
  const result = await runMailAnalysis(fixture.adapters, { ...OPTIONS, timeoutMs: 10 });
  expectFailure(result, "RUN_TIMED_OUT");
  expectNoProviders(fixture);
});

for (const boundary of [
  { nowCall: 3, name: "mailbox", mailbox: 0 },
  { nowCall: 5, name: "analyzer", mailbox: 1 },
]) {
  test(`monotonic known-expiry check stops ${boundary.name} dispatch while its timer is starved`, async () => {
    let nowCalls = 0;
    const fixture = harness({ now: () => {
      if (++nowCalls === boundary.nowCall) queueMicrotask(() => busyWait(45));
      return NOW;
    } });
    fixture.state.authority = validAuthority({ grantExpiresAt: NOW + 30 });
    const result = await runMailAnalysis(fixture.adapters, OPTIONS);
    expectFailure(result, "AUTHORITY_CHANGED");
    assert.equal(fixture.state.calls.mailbox, boundary.mailbox);
    assert.equal(fixture.state.calls.analysis, 0);
    expectStages(result.receipt, "consumed", boundary.mailbox ? "returned" : "not-started", "not-started");
  });
}

for (const [name, value] of [
  ["NaN", NaN], ["Infinity", Infinity], ["negative", -1], ["fractional", NOW + 0.5],
  ["out of date range", 253402300800000],
] as const) {
  test(`invalid injected time fails closed: ${name}`, async () => {
    const fixture = harness({ now: () => value });
    const result = await runMailAnalysis(fixture.adapters, OPTIONS);
    expectFailure(result, "AUTHORITY_UNAVAILABLE");
    expectNoProviders(fixture);
  });
}

test("backwards injected wall clock is rejected before quota dispatch", async () => {
  let calls = 0;
  const fixture = harness({ now: () => ++calls === 1 ? NOW : NOW - 1 });
  const result = await runMailAnalysis(fixture.adapters, OPTIONS);
  expectFailure(result, "AUTHORITY_UNAVAILABLE");
  expectNoProviders(fixture);
});

test("expiry during final extraction cannot become successful output", async () => {
  let calls = 0;
  const fixture = harness({ now: () => ++calls === 8 ? NOW + 60000 : NOW });
  const result = await runMailAnalysis(fixture.adapters, OPTIONS);
  expectFailure(result, "AUTHORITY_CHANGED");
  expectStages(result.receipt, "consumed", "returned", "returned");
});

for (const deadline of ["run", "authority"] as const) {
  test(`timer starvation during final timestamp cannot return success past the ${deadline} deadline`, async () => {
    let calls = 0;
    const fixture = harness({ now: () => {
      if (++calls === 8) busyWait(45);
      return NOW;
    } });
    if (deadline === "authority") fixture.state.authority = validAuthority({ grantExpiresAt: NOW + 30 });
    const result = await runMailAnalysis(fixture.adapters, {
      ...OPTIONS, timeoutMs: deadline === "run" ? 30 : OPTIONS.timeoutMs!,
    });
    expectFailure(result, deadline === "run" ? "RUN_TIMED_OUT" : "AUTHORITY_CHANGED");
    expectStages(result.receipt, "consumed", "returned", "returned");
  });
}

for (const stage of ["authority", "quota", "mailbox", "analysis"] as const) {
  for (const failure of ["throw", "reject"] as const) {
    test(`${stage} ${failure} produces only a generic code, accurate observations, and no automatic retry`, async () => {
      const fail = (): Promise<unknown> => {
        if (failure === "throw") throw new Error(PRIVATE_MARKER);
        return Promise.reject({ message: PRIVATE_MARKER, rawBody: PRIVATE_MARKER });
      };
      const overrides: Partial<MailAnalysisAdapters> = {};
      if (stage === "authority") overrides.readAuthority = fail;
      if (stage === "quota") overrides.reserveQuota = fail;
      if (stage === "mailbox") overrides.readMailbox = fail;
      if (stage === "analysis") overrides.analyze = fail;
      const fixture = harness(overrides);
      const result = await runMailAnalysis(fixture.adapters, OPTIONS);
      const codes = { authority: "AUTHORITY_UNAVAILABLE", quota: "QUOTA_UNAVAILABLE",
        mailbox: "MAIL_UNAVAILABLE", analysis: "ANALYSIS_UNAVAILABLE" } as const;
      expectFailure(result, codes[stage]);
      assert.equal(fixture.state.calls[stage], 1);
      expectStages(result.receipt, stage === "authority" ? "not-consumed" : stage === "quota" ? "unknown" : "consumed",
        stage === "mailbox" ? "started" : stage === "analysis" ? "returned" : "not-started",
        stage === "analysis" ? "started" : "not-started");
    });
  }
}

test("private stage context is frozen, projected, shared, and excludes unrelated authority adapter secrets", async () => {
  const fixture = harness();
  fixture.state.authority = validAuthority({ token: PRIVATE_MARKER, nestedPrivate: { key: PRIVATE_MARKER } });
  fixture.overrides.analyze = async (messages, context) => {
    assertFrozenTree(context);
    assertFrozenTree(messages);
    assert.deepEqual(Object.keys(context).sort(), ["authority", "scope"]);
    assert.deepEqual(Object.keys(context.authority).sort(), ["ownerId", "sessionId", "sessionRevision", "dataGeneration", "sessionExpiresAt",
      "mailboxBindingId", "grantId", "grantRevision", "grantExpiresAt", "operationId", "recipientId",
      "policyVersion", "mailRead", "externalAnalysis"].sort());
    assert.equal(context.scope, MAIL_ANALYSIS_POLICY);
    assert.equal(context.scope.maxMessages, 30);
    assert.equal(context.scope.format, "full");
    assert.deepEqual(Object.keys(messages[0]!).sort(), ["index", "receivedAt", "subject", "body", "bodySource", "warnings"].sort());
    assert.ok(!JSON.stringify({ context, messages }).includes(PRIVATE_MARKER));
    assert.ok(!JSON.stringify(messages).includes("synthetic-message"));
    assert.throws(() => { (context.authority as unknown as Record<string, unknown>).ownerId = "synthetic-other"; }, TypeError);
    return ANALYSIS_JSON;
  };
  const result = await runMailAnalysis(fixture.adapters, OPTIONS);
  assert.ok(result.ok);
  assert.equal(fixture.state.contexts.length, 3);
  assert.ok(fixture.state.contexts.every((context) => context === fixture.state.contexts[0]));
  const receiptText = JSON.stringify(result.receipt);
  assert.ok(!receiptText.includes("ownerId"));
  assert.ok(!receiptText.includes("sessionId"));
  assert.ok(!receiptText.includes("sessionRevision"));
  assert.ok(!receiptText.includes("dataGeneration"));
  assert.ok(!receiptText.includes(PRIVATE_MARKER));
  assertFrozenTree(result.receipt);
});

test("mutable caller options are snapshotted before any asynchronous adapter call", async () => {
  const mutable = { ...OPTIONS };
  const fixture = harness({ readAuthority: async () => {
    mutable.operationId = "synthetic-mutated-operation";
    mutable.mailboxBindingId = "synthetic-mutated-mailbox";
    mutable.recipientId = "synthetic-mutated-recipient";
    mutable.timeoutMs = 0;
    return validAuthority();
  } });
  const result = await runMailAnalysis(fixture.adapters, mutable);
  assert.ok(result.ok);
  assert.equal(result.receipt.authorityAtStart!.operationId, OPTIONS.operationId);
  assert.equal(result.receipt.authorityAtStart!.mailboxBindingId, OPTIONS.mailboxBindingId);
  assert.equal(result.receipt.authorityAtStart!.recipientId, OPTIONS.recipientId);
});

test("one internal abort signal is forwarded to every adapter and is distinct from the caller signal", async () => {
  const controller = new AbortController();
  const fixture = harness();
  const result = await runMailAnalysis(fixture.adapters, { ...OPTIONS, signal: controller.signal });
  assert.ok(result.ok);
  const internal = fixture.state.signals[0]!;
  assert.notEqual(internal, controller.signal);
  assert.ok(fixture.state.signals.every((signal) => signal === internal));
  assert.equal(internal.aborted, false);
  controller.abort(PRIVATE_MARKER);
  assert.equal(internal.aborted, false, "completed run detaches its parent abort listener");
});

const badMail: Array<[string, unknown, FailureCode]> = [
  ["non-string", [mailSource()], "MAIL_INPUT_INVALID"],
  ["malformed JSON", PRIVATE_MARKER, "MAIL_INPUT_INVALID"],
  ["over-limit batch", JSON.stringify(Array.from({ length: MAIL_LIMITS.messages + 1 }, (_, index) => mailSource(`synthetic-${index}`))), "MAIL_LIMIT_EXCEEDED"],
];
for (const [name, mail, code] of badMail) {
  test(`invalid mailbox response has returned receipt but no analysis: ${name}`, async () => {
    const fixture = harness({ readMailbox: async () => mail });
    const result = await runMailAnalysis(fixture.adapters, OPTIONS);
    expectFailure(result, code);
    assert.equal(fixture.state.calls.mailbox, 1);
    assert.equal(fixture.state.calls.analysis, 0);
    expectStages(result.receipt, "consumed", "returned", "not-started");
  });
}

const badAnalysis: Array<[string, unknown, FailureCode]> = [
  ["non-string", { discoveries: [] }, "CANDIDATE_INPUT_INVALID"],
  ["malformed JSON", PRIVATE_MARKER, "CANDIDATE_INPUT_INVALID"],
  ["unsupported evidence", JSON.stringify({ schema: "keyatlas.gmail-candidates.v1", discoveries: [
    { ...DISCOVERY, service_name: { value: "Synthetic missing", part: "subject", quote: "not in this message" } },
  ] }), "CANDIDATE_EVIDENCE_INVALID"],
  ["over-limit candidates", JSON.stringify({ schema: "keyatlas.gmail-candidates.v1",
    discoveries: Array.from({ length: MAIL_LIMITS.candidates + 1 }, () => DISCOVERY) }), "CANDIDATE_LIMIT_EXCEEDED"],
];
for (const [name, analysis, code] of badAnalysis) {
  test(`invalid analysis never emits partial candidates and records returned observation: ${name}`, async () => {
    const fixture = harness({ analyze: async () => analysis });
    const result = await runMailAnalysis(fixture.adapters, OPTIONS);
    expectFailure(result, code);
    assert.equal(fixture.state.calls.analysis, 1);
    expectStages(result.receipt, "consumed", "returned", "returned");
  });
}
