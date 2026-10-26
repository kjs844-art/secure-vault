import assert from "node:assert/strict";
import { test } from "node:test";
import { createCandidateBatchReader, type CandidateBatchReader, type CandidateBatchReaderSnapshot } from "../src/domain/candidate-batch-reader.ts";
import type { CandidateBatchCallResult, CandidateBatchContext } from "../src/domain/candidate-batch-client.ts";
import { CANDIDATE_BATCH_VIEW_SCHEMA, type CandidateBatchDisplay } from "../src/domain/candidate-batch-view.ts";

// Pure owner tests: no real auth, HTTP, browser lifecycle, provider or DB. The
// fake client deliberately may ignore abort; logical cancellation is not proof
// that arbitrary underlying transports/resources have been destroyed.
const context = (bindingId = "synthetic-view-A", batchReference = "synthetic-batch-A"): CandidateBatchContext =>
  ({ bindingId, dataGeneration: 1, batchReference });
function batch(): CandidateBatchDisplay {
  return { schema: CANDIDATE_BATCH_VIEW_SCHEMA, dataGeneration: 1, candidates: [{ candidateId: "synthetic-candidate",
    candidateRevision: 1, state: "pending", accessExpiresAt: 1790000001000,
    content: { serviceName: "Synthetic provider", extractionConfidence: "low", values: { name: null, kind: "credit",
      unit: "credits", grantedAmount: 10.25, remainingAmount: 0, trialDaysStated: null, remainingDaysStated: null,
      expiresAt: "2028-02-29", observedAt: "2026-09-27T12:34:56.123456789+09:00" }, receivedAt: null,
      extractedAt: "2026-09-21T14:13:20.000Z", reviewReasons: ["USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF",
        "EXPIRY_CONFIRMATION_NEEDED", "RECEIVED_DATE_UNKNOWN"],
      evidenceAvailability: "not-retained", reviewStatus: "pending-review", accountProof: "not-established", currentBalanceProof: "not-established" } }] };
}
const success = (bound = context()): CandidateBatchCallResult => ({ kind: "success", context: bound, batch: batch() });
function snapshot(reader: CandidateBatchReader): CandidateBatchReaderSnapshot {
  const value = reader.getSnapshot(); assert.ok(value); return value;
}
function activate(reader: CandidateBatchReader, bound = context(), lease: object = Object.freeze({})): CandidateBatchReaderSnapshot {
  const value = reader.activate({ context: bound, lease }); assert.ok(value); return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const asResult = (value: unknown): CandidateBatchCallResult => value as CandidateBatchCallResult;
const invalidFailure = { kind: "invalid", reason: "ENVELOPE" };

test("construction and activation are inert; cached snapshot/context detached frozen; external lease unchanged", () => {
  let calls = 0;
  const reader = createCandidateBatchReader(async () => { calls++; return success(); });
  assert.equal(reader.getSnapshot(), null); assert.equal(reader.getContext(), null);
  const bound = { ...context() }, lease = { reviewMutation: "synthetic-original-operation" };
  const value = activate(reader, bound, lease);
  assert.equal(value, reader.getSnapshot()); assert.equal(value.context, reader.getContext());
  assert.equal(value.phase, "idle"); assert.equal(value.batch, null); assert.equal(value.failure, null);
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.context)); assert.equal(Object.isFrozen(lease), false);
  bound.bindingId = "synthetic-mutated"; assert.equal(value.context.bindingId, context().bindingId);
  assert.equal(value.lease, lease); assert.equal(calls, 0); assert.equal(reader.cancel(value), false);
  reader.dispose(); assert.deepEqual(lease, { reviewMutation: "synthetic-original-operation" });
});
test("constructor rejects non-functions with a fixed error", () => {
  for (const value of [null, {}, 1, "client"]) assert.throws(() => createCandidateBatchReader(value as never),
    { message: "CANDIDATE_BATCH_READER_CONFIG_INVALID" });
});
test("plain, null-prototype and frozen input bindings/context work without reading clocks or IDs", () => {
  const reader = createCandidateBatchReader(async () => success());
  for (const raw of [{ context: context(), lease: {} }, Object.assign(Object.create(null), { context: Object.assign(Object.create(null), context()), lease: {} }),
    Object.freeze({ context: Object.freeze(context()), lease: Object.freeze({}) })]) assert.ok(reader.activate(raw));
  reader.dispose();
});
const invalidBindings: readonly [string, () => unknown][] = [
  ["null", () => null], ["extra envelope", () => ({ context: context(), lease: {}, extra: 1 })],
  ["absent lease", () => ({ context: context() })], ["primitive lease", () => ({ context: context(), lease: "x" })],
  ["array lease", () => ({ context: context(), lease: [] })], ["extra context", () => ({ context: { ...context(), extra: 1 }, lease: {} })],
  ["invalid binding", () => ({ context: { ...context(), bindingId: " padded" }, lease: {} })],
  ["invalid reference", () => ({ context: { ...context(), batchReference: "x/foreign" }, lease: {} })],
  ["overlong reference", () => ({ context: { ...context(), batchReference: "x".repeat(129) }, lease: {} })],
  ["zero generation", () => ({ context: { ...context(), dataGeneration: 0 }, lease: {} })],
  ["unsafe generation", () => ({ context: { ...context(), dataGeneration: Number.MAX_SAFE_INTEGER + 1 }, lease: {} })],
  ["symbol context", () => ({ context: { ...context(), [Symbol("extra")]: true }, lease: {} })],
  ["hidden context", () => ({ context: Object.defineProperty(context(), "batchReference", { enumerable: false }), lease: {} })],
  ["class envelope", () => Object.assign(new (class Binding {})(), { context: context(), lease: {} })],
];
for (const [name, input] of invalidBindings) test(`invalid ${name} deactivates the prior scope without HTTP`, () => {
  let calls = 0; const reader = createCandidateBatchReader(async () => { calls++; return success(); }); activate(reader);
  assert.equal(reader.activate(input()), null); assert.equal(reader.getSnapshot(), null); assert.equal(reader.getContext(), null); assert.equal(calls, 0);
});
test("ordinary binding/context getters and serialization hooks are never executed", () => {
  let called = 0; const reader = createCandidateBatchReader(async () => success());
  const value = { lease: {}, get context() { called++; return context(); } };
  assert.equal(reader.activate(value), null);
  assert.equal(reader.activate({ lease: {}, context: { ...context(), get batchReference() { called++; return "synthetic"; } } }), null);
  assert.equal(reader.activate({ lease: {}, context: { ...context(), toJSON() { called++; return {}; } } }), null); assert.equal(called, 0);
});
test("reflection errors are contained; reflection itself is not a Proxy sandbox", () => {
  const reader = createCandidateBatchReader(async () => success());
  const revoked = Proxy.revocable({}, {}); revoked.revoke(); assert.equal(reader.activate(revoked.proxy), null);
  for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const) {
    let called = 0; const value = new Proxy({ lease: {}, context: context() }, { [trap]() { called++; throw new Error("synthetic"); } });
    assert.equal(reader.activate(value), null); assert.equal(called, 1);
  }
});
test("explicit success detaches deep-frozen values without changing null/zero/date precision", async () => {
  const result = success(), reader = createCandidateBatchReader(async () => result), initial = activate(reader);
  assert.equal(await reader.read(initial), true); const value = snapshot(reader);
  assert.equal(value.phase, "ready"); assert.deepEqual(value.batch, batch()); assert.equal(value.failure, null);
  assert.notEqual(value.batch, result.kind === "success" ? result.batch : null);
  assert.ok(Object.isFrozen(value.batch)); assert.ok(Object.isFrozen(value.batch?.candidates));
  assert.ok(Object.isFrozen(value.batch?.candidates[0]?.content?.values));
  assert.equal(value.batch?.candidates[0]?.content?.values.name, null); assert.equal(value.batch?.candidates[0]?.content?.values.remainingAmount, 0);
  assert.equal(value.batch?.candidates[0]?.content?.values.observedAt, "2026-09-27T12:34:56.123456789+09:00");
});
test("one pending request, stale or copied snapshots and foreign owners cannot start another read", async () => {
  const gate = deferred<CandidateBatchCallResult>(); let calls = 0;
  const reader = createCandidateBatchReader(() => { calls++; return gate.promise; }), old = activate(reader);
  const operation = reader.read(old), loading = snapshot(reader);
  assert.equal(await reader.read(old), false); assert.equal(await reader.read(loading), false);
  assert.equal(await reader.read({ ...loading }), false);
  const other = createCandidateBatchReader(async () => success()); activate(other); assert.equal(await other.read(loading), false);
  gate.resolve(success()); assert.equal(await operation, true); assert.equal(calls, 1);
  assert.equal(await reader.read(loading), false); other.dispose(); reader.dispose();
});
test("refresh hides old data synchronously and failure never restores it or automatically retries", async () => {
  const gate = deferred<CandidateBatchCallResult>(); let calls = 0;
  const reader = createCandidateBatchReader(() => ++calls === 1 ? Promise.resolve(success()) : gate.promise);
  assert.equal(await reader.read(activate(reader)), true); const ready = snapshot(reader), refresh = reader.read(ready);
  assert.equal(snapshot(reader).phase, "loading"); assert.equal(snapshot(reader).batch, null);
  gate.resolve({ kind: "network" }); assert.equal(await refresh, false);
  assert.equal(snapshot(reader).phase, "failed"); assert.equal(snapshot(reader).batch, null);
  assert.deepEqual(snapshot(reader).failure, { kind: "network" }); await Promise.resolve(); assert.equal(calls, 2);
});
test("cancel publishes idle/null before abort and immediately settles an uncooperative pending port", async () => {
  const gate = deferred<CandidateBatchCallResult>(); let abortSnapshot: CandidateBatchReaderSnapshot | null = null;
  const reader = createCandidateBatchReader((signal) => { signal?.addEventListener("abort", () => { abortSnapshot = reader.getSnapshot(); }); return gate.promise; });
  const initial = activate(reader), pending = reader.read(initial), loading = snapshot(reader);
  assert.equal(reader.cancel(loading), true); assert.equal(await pending, false);
  assert.equal(abortSnapshot, reader.getSnapshot()); assert.equal(snapshot(reader).phase, "idle"); assert.equal(snapshot(reader).batch, null);
  gate.resolve(success()); await Promise.resolve(); assert.equal(snapshot(reader).phase, "idle"); assert.equal(reader.cancel(loading), false);
});
test("cancel ready display leaves external review lease and uncertain-operation holder untouched", async () => {
  const lease = { originalMutation: { operationId: "synthetic-original", uncertain: true } }, reader = createCandidateBatchReader(async () => success());
  assert.equal(await reader.read(activate(reader, context(), lease)), true); assert.equal(reader.cancel(snapshot(reader)), true);
  assert.equal(snapshot(reader).lease, lease); assert.deepEqual(lease, { originalMutation: { operationId: "synthetic-original", uncertain: true } });
});
test("loading observer cancellation happens before client dispatch; observers cannot recursively read or activate", async () => {
  let calls = 0, readAttempt: Promise<boolean> | null = null, activation: CandidateBatchReaderSnapshot | null = null;
  const reader = createCandidateBatchReader(async () => { calls++; return success(); }), initial = activate(reader);
  reader.subscribe(() => { const value = reader.getSnapshot(); if (value?.phase === "loading") {
    readAttempt = reader.read(value); activation = reader.activate({ lease: {}, context: context("nested") }); reader.cancel(value);
  } });
  assert.equal(await reader.read(initial), false); assert.equal(await readAttempt, false); assert.equal(activation, null);
  assert.equal(calls, 0); assert.equal(snapshot(reader).phase, "idle");
});
test("cancel during ready publication suppresses success delivery; idle cancellation does not recurse", async () => {
  const reader = createCandidateBatchReader(async () => success()), initial = activate(reader); let ready = 0, idle = 0;
  reader.subscribe(() => { const value = reader.getSnapshot(); if (value?.phase === "ready") { ready++; reader.cancel(value); }
    else if (value?.phase === "idle") { idle++; assert.equal(reader.cancel(value), false); } });
  assert.equal(await reader.read(initial), false); assert.equal(ready, 1); assert.equal(idle, 1); assert.equal(snapshot(reader).phase, "idle");
});
test("A -> B -> A with equal context and external lease ignores old payload before decoding", async () => {
  const first = deferred<CandidateBatchCallResult>(), third = deferred<CandidateBatchCallResult>(); let calls = 0, reflected = 0;
  const reader = createCandidateBatchReader(() => ++calls === 1 ? first.promise : third.promise), lease = Object.freeze({});
  const a1 = activate(reader, context(), lease), old = reader.read(a1);
  activate(reader, context("synthetic-B", "synthetic-batch-B"), lease); const a3 = activate(reader, context(), lease);
  const current = reader.read(a3); assert.equal(await old, false);
  first.resolve(asResult(new Proxy({}, { getOwnPropertyDescriptor() { reflected++; throw new Error(); } })));
  await Promise.resolve(); assert.equal(reflected, 0); assert.equal(snapshot(reader).phase, "loading");
  assert.equal(reader.cancel(a1), false); third.resolve(success()); assert.equal(await current, true); assert.equal(calls, 2);
});
test("old cleanup lease cannot deactivate a newer lease; active lease revoke clears before abort", async () => {
  const first = deferred<CandidateBatchCallResult>(), second = deferred<CandidateBatchCallResult>(); let calls = 0, during: unknown = "not-called";
  const reader = createCandidateBatchReader((signal) => { signal?.addEventListener("abort", () => { during = reader.getSnapshot(); }); return ++calls === 1 ? first.promise : second.promise; });
  const a = activate(reader), old = reader.read(a), b = activate(reader, context("synthetic-B")), next = reader.read(b);
  assert.equal(await old, false); reader.deactivate(a.lease); assert.equal(snapshot(reader).phase, "loading");
  reader.deactivate(b.lease); assert.equal(await next, false); assert.equal(during, null); assert.equal(reader.getContext(), null);
  first.reject(new Error("late synthetic")); second.resolve(success(context("synthetic-B"))); await Promise.resolve();
});
test("same-value reactivation has fresh snapshot identity and aborts unsent/captured old callbacks", async () => {
  let calls = 0; const reader = createCandidateBatchReader(async () => { calls++; return success(); }), lease = {};
  const old = activate(reader, context(), lease), fresh = activate(reader, context(), lease);
  assert.notEqual(old, fresh); assert.equal(await reader.read(old), false); assert.equal(await reader.read(fresh), true); assert.equal(calls, 1);
});
test("reentrant old lease deactivation during replacement abort cancels outer activation", async () => {
  const gate = deferred<CandidateBatchCallResult>(); let lease: object = {};
  const reader = createCandidateBatchReader((signal) => { signal?.addEventListener("abort", () => reader.deactivate(lease)); return gate.promise; });
  const old = activate(reader); lease = old.lease; const pending = reader.read(old);
  assert.equal(reader.activate({ context: context("new"), lease: {} }), null); assert.equal(await pending, false);
  assert.equal(reader.getSnapshot(), null); gate.resolve(success());
});
test("reentrant dispose during replacement abort cannot reopen the reader", async () => {
  const gate = deferred<CandidateBatchCallResult>(); const reader = createCandidateBatchReader((signal) => {
    signal?.addEventListener("abort", () => reader.dispose()); return gate.promise;
  });
  const old = reader.read(activate(reader)); assert.equal(reader.activate({ context: context("new"), lease: {} }), null);
  assert.equal(await old, false); assert.equal(reader.activate({ context: context(), lease: {} }), null); gate.resolve(success());
});
test("foreign context suppresses batch reflection and generation mismatch is invalid", async () => {
  let reflected = 0;
  const result = { kind: "success", context: context("foreign"), batch: new Proxy({}, { getPrototypeOf() { reflected++; throw new Error(); } }) };
  const reader = createCandidateBatchReader(async () => asResult(result)); assert.equal(await reader.read(activate(reader)), false);
  assert.equal(reflected, 0); assert.deepEqual(snapshot(reader).failure, { kind: "stale" });
  const wrong = createCandidateBatchReader(async () => asResult({ kind: "success", context: context(), batch: { ...batch(), dataGeneration: 2 } }));
  assert.equal(await wrong.read(activate(wrong)), false); assert.deepEqual(snapshot(wrong).failure, invalidFailure);
});
test("batch reference and binding are both bound independently of generation", async () => {
  for (const bound of [context("other-binding"), context(undefined, "other-reference"), { ...context(), dataGeneration: 2 }]) {
    const reader = createCandidateBatchReader(async () => success(bound)); assert.equal(await reader.read(activate(reader)), false);
    assert.deepEqual(snapshot(reader).failure, { kind: "stale" });
  }
});
const malformedResults: readonly [string, () => unknown][] = [
  ["null", () => null], ["unknown tag", () => ({ kind: "private-status", private: "synthetic" })],
  ["extra success", () => ({ ...success(), private: "synthetic" })], ["array", () => []],
  ["malformed batch", () => ({ kind: "success", context: context(), batch: { ...batch(), candidates: new Array(1) } })],
  ["extra context", () => ({ kind: "success", context: { ...context(), private: "synthetic" }, batch: batch() })],
  ["unknown error", () => ({ kind: "error", code: "PRIVATE_ERROR", retriableAfterMs: null })],
  ["extra error", () => ({ kind: "error", code: "API_UNAVAILABLE", retriableAfterMs: null, body: "synthetic" })],
  ["negative retry", () => ({ kind: "error", code: "API_RATE_LIMITED", retriableAfterMs: -1 })],
  ["infinite retry", () => ({ kind: "error", code: "API_RATE_LIMITED", retriableAfterMs: Infinity })],
  ["missing rate retry", () => ({ kind: "error", code: "API_RATE_LIMITED", retriableAfterMs: null })],
  ["fractional-second rate retry", () => ({ kind: "error", code: "API_RATE_LIMITED", retriableAfterMs: 1001 })],
  ["excessive rate retry", () => ({ kind: "error", code: "API_RATE_LIMITED", retriableAfterMs: 61000 })],
  ["retry unrelated code", () => ({ kind: "error", code: "API_UNAVAILABLE", retriableAfterMs: 1000 })],
  ["invalid reason", () => ({ kind: "invalid", reason: "PRIVATE_REASON" })], ["extra short failure", () => ({ kind: "network", body: "synthetic" })],
];
for (const [name, result] of malformedResults) test(`malformed result ${name} becomes fixed failure with no private payload`, async () => {
  const reader = createCandidateBatchReader(async () => asResult(result())); assert.equal(await reader.read(activate(reader)), false);
  assert.deepEqual(snapshot(reader).failure, invalidFailure); assert.equal(snapshot(reader).batch, null);
});
test("ordinary result getters/serialization hooks never execute", async () => {
  let called = 0;
  const inputs = [{ get kind() { called++; return "success"; } }, { kind: "success", context: context(), get batch() { called++; return batch(); } },
    { ...success(), toJSON() { called++; return {}; } }];
  for (const input of inputs) { const reader = createCandidateBatchReader(async () => asResult(input));
    assert.equal(await reader.read(activate(reader)), false); assert.deepEqual(snapshot(reader).failure, invalidFailure); }
  assert.equal(called, 0);
});
test("decoder reflection revocation wins and never publishes payload from a revoked frame", async () => {
  let lease: object = {}, reads = 0;
  const raw = new Proxy(batch(), { getPrototypeOf(target) { reads++; reader.deactivate(lease); return Reflect.getPrototypeOf(target); } });
  const reader = createCandidateBatchReader(async () => ({ kind: "success", context: context(), batch: raw })), initial = activate(reader); lease = initial.lease;
  assert.equal(await reader.read(initial), false); assert.equal(reader.getSnapshot(), null); assert.ok(reads > 0);
});
test("fixed failure vocabulary is preserved and frozen, including authority codes for host revocation", async () => {
  const results: CandidateBatchCallResult[] = [{ kind: "network" }, { kind: "timeout" }, { kind: "aborted" }, { kind: "stale" },
    { kind: "invalid", reason: "CLOCK" }, { kind: "error", code: "API_AUTH_REQUIRED", retriableAfterMs: null },
    { kind: "error", code: "API_SESSION_CHANGED", retriableAfterMs: null }, { kind: "error", code: "API_RATE_LIMITED", retriableAfterMs: 1000 }];
  for (const result of results) { const reader = createCandidateBatchReader(async () => result);
    assert.equal(await reader.read(activate(reader)), false); assert.deepEqual(snapshot(reader).failure, result);
    assert.ok(Object.isFrozen(snapshot(reader).failure)); assert.notEqual(snapshot(reader).failure, result); }
});
test("sync client throw and rejection are fixed network failures without raw error exposure", async () => {
  for (const client of [() => { throw new Error("synthetic private adapter failure"); }, () => Promise.reject(new Error("synthetic"))]) {
    const reader = createCandidateBatchReader(client); assert.equal(await reader.read(activate(reader)), false);
    assert.deepEqual(snapshot(reader).failure, { kind: "network" });
  }
});
test("listener errors and removal cannot prevent owned revocation; disposed reader stays inert", async () => {
  const gate = deferred<CandidateBatchCallResult>(); let calls = 0, removed = 0, retained = 0;
  const reader = createCandidateBatchReader(() => { calls++; return gate.promise; }), initial = activate(reader);
  const remove = reader.subscribe(() => { removed++; }); remove();
  reader.subscribe(() => { throw new Error("synthetic observer"); }); reader.subscribe(() => { retained++; });
  const pending = reader.read(initial); reader.dispose(); assert.equal(await pending, false); assert.equal(reader.getSnapshot(), null);
  assert.equal(removed, 0); assert.equal(retained, 2); assert.equal(reader.activate({ lease: {}, context: context() }), null);
  assert.equal(await reader.read(initial), false); assert.equal(reader.cancel(initial), false); reader.dispose();
  reader.subscribe(() => { retained++; })(); gate.reject(new Error("late synthetic")); await Promise.resolve(); assert.equal(calls, 1);
});
