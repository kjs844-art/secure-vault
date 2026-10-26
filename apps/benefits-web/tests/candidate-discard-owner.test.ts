import assert from "node:assert/strict";
import { test } from "node:test";
import { createCandidateDiscardOwner, type CandidateDiscardOwner, type CandidateDiscardSnapshot,
  type CandidateDiscardObservation } from "../src/domain/candidate-discard-owner.ts";
import type { CandidateBatchContext } from "../src/domain/candidate-batch-client.ts";
import { createCandidateDiscardClient, type CandidateDiscardCallResult,
  type CandidateDiscardFailure, type CandidateDiscardRequest } from "../src/domain/candidate-discard-client.ts";
import { createInboxDiscardHttpHandler } from "../src/server/http/inbox-discard-http.ts";
import { createCandidateSelectionFixture } from "./support/candidate-selection-fixture.ts";
import { REVIEW_NOW } from "./support/review-memory-store.ts";

const CONTEXT = Object.freeze({ bindingId: "synthetic-view", dataGeneration: 1, batchReference: "synthetic-batch" });
const OBSERVATION = Object.freeze({ candidateId: "synthetic-candidate", expectedRevision: 1 });
const REQUEST = Object.freeze({ batchReference: CONTEXT.batchReference, ...OBSERVATION, decision: "discard" as const });
function success(request: CandidateDiscardRequest = REQUEST): CandidateDiscardCallResult {
  return { kind: "success", context: { ...CONTEXT, batchReference: request.batchReference },
    receipt: { batchReference: request.batchReference, candidateId: request.candidateId,
      candidateRevision: request.expectedRevision + 1, state: "deleted", content: null } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function snap(owner: CandidateDiscardOwner): CandidateDiscardSnapshot {
  const value = owner.getSnapshot(); assert.ok(value); return value;
}
function activate(owner: CandidateDiscardOwner, lease: object = {}, context: CandidateBatchContext = CONTEXT): CandidateDiscardSnapshot {
  const value = owner.activate({ lease, context }); assert.ok(value); return value;
}
function prepare(owner: CandidateDiscardOwner, initial = snap(owner), observation: CandidateDiscardObservation = OBSERVATION): CandidateDiscardSnapshot {
  const value = owner.prepare(initial, observation); assert.ok(value); return value;
}
const result = (input: unknown) => input as CandidateDiscardCallResult;

test("construction and explicit prepare are inert and snapshot only ID/revision with external lease untouched", () => {
  let calls = 0; const owner = createCandidateDiscardOwner(async () => { calls++; return success(); });
  assert.equal(owner.getSnapshot(), null); assert.equal(owner.getContext(), null);
  const lease = { originalUncertainReview: "synthetic-original-command" }, initial = activate(owner, lease);
  assert.equal(initial.phase, "idle"); assert.equal(initial.request, null); assert.equal(initial.receipt, null);
  const mutable: { candidateId: string; expectedRevision: number } = { ...OBSERVATION }, prepared = prepare(owner, initial, mutable);
  mutable.candidateId = "changed"; mutable.expectedRevision = 55;
  assert.deepEqual(prepared.request, REQUEST); assert.ok(Object.isFrozen(prepared)); assert.ok(Object.isFrozen(prepared.context));
  assert.ok(Object.isFrozen(prepared.request)); assert.equal(Object.isFrozen(lease), false); assert.equal(calls, 0);
  owner.dispose(); assert.deepEqual(lease, { originalUncertainReview: "synthetic-original-command" });
});
test("constructor validates injected ports with fixed errors", () => {
  for (const value of [null, {}, 1]) assert.throws(() => createCandidateDiscardOwner(value as never),
    { message: "CANDIDATE_DISCARD_OWNER_CONFIG_INVALID" });
  assert.throws(() => createCandidateDiscardOwner(async () => success(), 1 as never),
    { message: "CANDIDATE_DISCARD_OWNER_CONFIG_INVALID" });
});
const invalidBindings: readonly [string, () => unknown][] = [
  ["null", () => null], ["extra", () => ({ lease: {}, context: CONTEXT, extra: true })],
  ["missing", () => ({ context: CONTEXT })], ["array lease", () => ({ lease: [], context: CONTEXT })],
  ["primitive lease", () => ({ lease: "x", context: CONTEXT })],
  ["foreign proto", () => Object.assign(new (class Binding {})(), { lease: {}, context: CONTEXT })],
  ["extra context", () => ({ lease: {}, context: { ...CONTEXT, extra: true } })],
  ["invalid reference", () => ({ lease: {}, context: { ...CONTEXT, batchReference: " padded" } })],
  ["invalid generation", () => ({ lease: {}, context: { ...CONTEXT, dataGeneration: 0 } })],
  ["symbol", () => ({ lease: {}, context: { ...CONTEXT, [Symbol()]: true } })],
  ["hidden", () => ({ lease: {}, context: Object.defineProperty({ ...CONTEXT }, "bindingId", { enumerable: false }) })],
];
for (const [name, input] of invalidBindings) test("activation rejects " + name + " and retires previous state", () => {
  const owner = createCandidateDiscardOwner(async () => success()); prepare(owner, activate(owner));
  assert.equal(owner.activate(input()), null); assert.equal(owner.getSnapshot(), null); assert.equal(owner.getContext(), null);
});
test("ordinary binding/observation getters do not execute; Proxy reflection failures are contained", () => {
  let calls = 0; const owner = createCandidateDiscardOwner(async () => success());
  assert.equal(owner.activate({ lease: {}, get context() { calls++; return CONTEXT; } }), null);
  for (const input of [null, {}, { ...OBSERVATION, extra: "private" }, { ...OBSERVATION, expectedRevision: 0 },
    { ...OBSERVATION, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...OBSERVATION, candidateId: "x\n" },
    { ...OBSERVATION, get expectedRevision() { calls++; return 1; } }, { ...OBSERVATION, toJSON() { calls++; return OBSERVATION; } },
    new Proxy(OBSERVATION, { ownKeys() { throw new Error("synthetic-private"); } })]) {
    const initial = activate(owner); assert.equal(owner.prepare(initial, input), null); assert.equal(owner.getSnapshot(), initial);
  }
  assert.equal(calls, 0);
  const revoked = Proxy.revocable({}, {}); revoked.revoke(); assert.equal(owner.activate(revoked.proxy), null);
});
test("success binds and detaches the minimal receipt; only explicit next prepare creates a new command", async () => {
  const original = success(); let calls = 0;
  const owner = createCandidateDiscardOwner(async () => { calls++; return original; });
  const prepared = prepare(owner, activate(owner));
  assert.equal(await owner.execute(prepared), true); const done = snap(owner);
  assert.equal(done.phase, "succeeded"); assert.deepEqual(done.request, REQUEST); assert.equal(done.receipt?.candidateRevision, 2);
  assert.ok(Object.isFrozen(done.receipt)); assert.notEqual(done.receipt, original.kind === "success" ? original.receipt : null);
  assert.equal(await owner.execute(done), false); assert.equal(await owner.reconcile(done), false); assert.equal(owner.cancelPrepared(done), false);
  assert.equal(calls, 1); assert.ok(owner.prepare(done, { candidateId: "synthetic-other", expectedRevision: 7 }));
});
test("snapshot identity and one flight prevent copied, stale, foreign and simultaneous execution", async () => {
  const gate = deferred<CandidateDiscardCallResult>(); let calls = 0;
  const owner = createCandidateDiscardOwner(() => { calls++; return gate.promise; }), initial = activate(owner), prepared = prepare(owner, initial);
  assert.equal(await owner.execute({ ...prepared }), false); assert.equal(await owner.execute(initial), false);
  assert.equal(await owner.reconcile(prepared), false);
  const other = createCandidateDiscardOwner(async () => success()); activate(other); assert.equal(await other.execute(prepared), false);
  const pending = owner.execute(prepared), sending = snap(owner);
  assert.equal(await owner.execute(sending), false); assert.equal(await owner.reconcile(sending), false);
  assert.equal(owner.prepare(sending, OBSERVATION), null); assert.equal(owner.cancelPrepared(sending), false);
  gate.resolve(success()); assert.equal(await pending, true); assert.equal(calls, 1);
});
test("cancel is limited to unattempted prepared command and never claims rollback of a sent request", async () => {
  let calls = 0; const owner = createCandidateDiscardOwner(async () => { calls++; return { kind: "network", dispatched: true }; });
  const initial = activate(owner), prepared = prepare(owner, initial);
  assert.equal(owner.cancelPrepared(prepared), true); assert.equal(snap(owner).phase, "idle"); assert.equal(snap(owner).request, null);
  assert.equal(await owner.execute(prepared), false); assert.equal(calls, 0);
  const next = prepare(owner); assert.equal(await owner.execute(next), false);
  const uncertain = snap(owner); assert.equal(uncertain.phase, "uncertain"); assert.equal(owner.cancelPrepared(uncertain), false);
  assert.equal(owner.prepare(uncertain, { ...OBSERVATION, expectedRevision: 2 }), null); assert.equal(calls, 1);
});
test("uncertain command retains the identical request across explicit reconcile and never auto-retries", async () => {
  const seen: unknown[] = [];
  const owner = createCandidateDiscardOwner(async (request) => {
    seen.push(request); return seen.length === 1 ? { kind: "network", dispatched: true } : success();
  });
  assert.equal(await owner.execute(prepare(owner, activate(owner))), false); const unknown = snap(owner);
  assert.equal(unknown.phase, "uncertain"); assert.equal(await owner.execute(unknown), false); await Promise.resolve(); assert.equal(seen.length, 1);
  assert.equal(await owner.reconcile(unknown), true); assert.equal(seen.length, 2); assert.equal(seen[0], seen[1]);
  assert.equal(snap(owner).phase, "succeeded"); assert.equal(snap(owner).request, unknown.request);
});
for (const code of ["API_CONFLICT", "API_NOT_FOUND", "API_UNAVAILABLE", "API_TIMEOUT", "API_ABORTED",
  "API_INPUT_INVALID", "API_RATE_LIMITED"] as const) test("first dispatched " + code + " is not proof of rollback", async () => {
  const failure: CandidateDiscardFailure = { kind: "error", code, retriableAfterMs: code === "API_RATE_LIMITED" ? 1000 : null, dispatched: true };
  const owner = createCandidateDiscardOwner(async () => failure); assert.equal(await owner.execute(prepare(owner, activate(owner))), false);
  assert.equal(snap(owner).phase, "uncertain"); assert.deepEqual(snap(owner).failure, failure); assert.deepEqual(snap(owner).request, REQUEST);
});
test("local no-dispatch failure is rejected but cannot erase uncertainty from an earlier attempt", async () => {
  const local: CandidateDiscardFailure = { kind: "invalid", reason: "REQUEST", dispatched: false };
  const neverSent = createCandidateDiscardOwner(async () => local); assert.equal(await neverSent.execute(prepare(neverSent, activate(neverSent))), false);
  assert.equal(snap(neverSent).phase, "rejected"); assert.ok(neverSent.prepare(snap(neverSent), OBSERVATION));
  let calls = 0;
  const owner = createCandidateDiscardOwner(async () => ++calls === 1 ? { kind: "network", dispatched: true } : local);
  assert.equal(await owner.execute(prepare(owner, activate(owner))), false); const original = snap(owner).request;
  assert.equal(await owner.reconcile(snap(owner)), false); assert.equal(snap(owner).phase, "uncertain"); assert.equal(snap(owner).request, original);
});
test("external revocation clears state and aborts before notification; uncooperative client settles logically", async () => {
  const gate = deferred<CandidateDiscardCallResult>(), order: string[] = [];
  const owner = createCandidateDiscardOwner((_request, signal) => {
    signal!.addEventListener("abort", () => { assert.equal(owner.getSnapshot(), null); assert.equal(owner.getContext(), null); order.push("abort"); });
    return gate.promise;
  });
  const initial = activate(owner), prepared = prepare(owner, initial), pending = owner.execute(prepared);
  owner.subscribe(() => { if (owner.getSnapshot() === null) order.push("notify"); });
  owner.deactivate(initial.lease); assert.equal(await pending, false); assert.deepEqual(order, ["abort", "notify"]);
  gate.reject(new Error("synthetic-private-late")); await Promise.resolve(); assert.equal(owner.getSnapshot(), null);
});
test("sending observer revoke prevents adapter dispatch; reentrant preparation/activation are inert", async () => {
  let calls = 0, nested: unknown = "unset";
  const owner = createCandidateDiscardOwner(async () => { calls++; return success(); }), initial = activate(owner);
  const prepared = prepare(owner, initial);
  owner.subscribe(() => { const value = owner.getSnapshot(); if (value?.phase === "sending") {
    nested = owner.activate({ lease: {}, context: CONTEXT }); assert.equal(owner.prepare(value, OBSERVATION), null);
    owner.deactivate(initial.lease);
  } });
  assert.equal(await owner.execute(prepared), false); assert.equal(nested, null); assert.equal(calls, 0);
});
test("A→B→A fresh frame ignores late payload before reflection, including equal context and external lease", async () => {
  const first = deferred<CandidateDiscardCallResult>(), last = deferred<CandidateDiscardCallResult>(); let calls = 0, reflected = 0;
  const owner = createCandidateDiscardOwner(() => ++calls === 1 ? first.promise : last.promise), lease = {};
  const old = owner.execute(prepare(owner, activate(owner, lease)));
  activate(owner, lease, { ...CONTEXT, bindingId: "B" }); const latest = owner.execute(prepare(owner, activate(owner, lease)));
  assert.equal(await old, false);
  first.resolve(result(new Proxy({}, { getOwnPropertyDescriptor() { reflected++; throw new Error("synthetic-private"); } })));
  await Promise.resolve(); assert.equal(reflected, 0); assert.equal(snap(owner).phase, "sending");
  last.resolve(success()); assert.equal(await latest, true); assert.equal(calls, 2);
});
test("old lease cannot deactivate a new frame and abort-time retirement prevents replacement reopening", async () => {
  const gate = deferred<CandidateDiscardCallResult>(); let oldLease: object = {};
  const owner = createCandidateDiscardOwner((_request, signal) => {
    signal!.addEventListener("abort", () => owner.deactivate(oldLease)); return gate.promise;
  });
  const initial = activate(owner); oldLease = initial.lease;
  const pending = owner.execute(prepare(owner, initial));
  assert.equal(owner.activate({ lease: {}, context: { ...CONTEXT, bindingId: "new" } }), null); assert.equal(await pending, false);
  const fresh = activate(owner); owner.deactivate(initial.lease); assert.equal(owner.getSnapshot(), fresh);
  gate.resolve(success()); owner.dispose();
});
test("authority rejection clears own state before trusted host callback and before observers", async () => {
  for (const failure of [
    { kind: "stale", dispatched: true },
    { kind: "invalid", reason: "CLOCK", dispatched: false },
    ...["API_AUTH_REQUIRED", "API_SESSION_CHANGED", "API_REQUEST_REJECTED"].map((code) =>
      ({ kind: "error", code, retriableAfterMs: null, dispatched: true })),
  ]) {
    const order: string[] = []; let owner!: CandidateDiscardOwner, ownedSignal: AbortSignal | undefined;
    owner = createCandidateDiscardOwner(async (_request, signal) => { ownedSignal = signal; return result(failure); }, () => {
      assert.equal(ownedSignal?.aborted, true);
      assert.equal(owner.getSnapshot(), null); assert.equal(owner.getContext(), null); order.push("host"); throw new Error("synthetic");
    });
    const initial = activate(owner), prepared = prepare(owner, initial);
    owner.subscribe(() => { if (!owner.getSnapshot()) order.push("notify"); });
    assert.equal(await owner.execute(prepared), false); assert.deepEqual(order, ["host", "notify"]);
    assert.equal(owner.getSnapshot(), null);
  }
});
const malformedResults: readonly [string, () => unknown][] = [
  ["null", () => null], ["extra", () => ({ ...success(), private: "synthetic-private" })],
  ["bad tag", () => ({ kind: "private-failure", message: "synthetic-private" })],
  ["extra context", () => ({ ...success(), context: { ...CONTEXT, private: true } })],
  ["foreign receipt", () => ({ ...success(), receipt: { ...(success() as Extract<CandidateDiscardCallResult, {kind: "success"}>).receipt, candidateId: "foreign" } })],
  ["retained content", () => ({ ...success(), receipt: { batchReference: CONTEXT.batchReference, candidateId: OBSERVATION.candidateId,
    candidateRevision: 2, state: "deleted", content: { private: "synthetic-private" } } })],
  ["missing dispatch flag", () => ({ kind: "network" })],
  ["unknown code", () => ({ kind: "error", code: "PRIVATE", retriableAfterMs: null, dispatched: true })],
  ["extra failure", () => ({ kind: "network", dispatched: true, detail: "synthetic-private" })],
  ["bad rate", () => ({ kind: "error", code: "API_RATE_LIMITED", retriableAfterMs: 1001, dispatched: true })],
  ["bad retry", () => ({ kind: "error", code: "API_CONFLICT", retriableAfterMs: 1000, dispatched: true })],
  ["bad reason", () => ({ kind: "invalid", reason: "PRIVATE", dispatched: true })],
];
for (const [name, raw] of malformedResults) test("malformed result " + name + " is uncertain fixed failure without raw detail", async () => {
  const owner = createCandidateDiscardOwner(async () => result(raw()));
  assert.equal(await owner.execute(prepare(owner, activate(owner))), false);
  assert.equal(snap(owner).phase, "uncertain"); assert.equal(snap(owner).receipt, null);
  assert.deepEqual(snap(owner).failure, { kind: "invalid", reason: "ENVELOPE", dispatched: true });
  assert.equal(JSON.stringify(snap(owner)).includes("synthetic-private"), false);
});
test("result accessors do not execute and decoder reflection revocation wins", async () => {
  let getters = 0;
  for (const input of [{ get kind() { getters++; return "success"; } }, { ...success(), get receipt() { getters++; return {}; } }]) {
    const owner = createCandidateDiscardOwner(async () => result(input));
    assert.equal(await owner.execute(prepare(owner, activate(owner))), false); assert.equal(snap(owner).phase, "uncertain");
  }
  assert.equal(getters, 0); let owner!: CandidateDiscardOwner, lease: object = {};
  const raw = new Proxy(success(), { getOwnPropertyDescriptor(target, key) { owner.deactivate(lease); return Reflect.getOwnPropertyDescriptor(target, key); } });
  owner = createCandidateDiscardOwner(async () => raw); const initial = activate(owner); lease = initial.lease;
  assert.equal(await owner.execute(prepare(owner, initial)), false); assert.equal(owner.getSnapshot(), null);
});
test("foreign response context is authority-stale before receipt reflection", async () => {
  let reflected = 0, retired = 0;
  const owner = createCandidateDiscardOwner(async () => result({ kind: "success", context: { ...CONTEXT, bindingId: "foreign" },
    receipt: new Proxy({}, { getPrototypeOf() { reflected++; throw new Error("synthetic-private"); } }) }), () => { retired++; });
  assert.equal(await owner.execute(prepare(owner, activate(owner))), false); assert.equal(reflected, 0); assert.equal(retired, 1);
});
test("sync throws, late rejection, removal and listener errors remain bounded and disposed owner is inert", async () => {
  for (const client of [() => { throw new Error("synthetic-private"); }, () => Promise.reject(new Error("synthetic-private"))]) {
    const owner = createCandidateDiscardOwner(client); let removed = 0;
    const unsubscribe = owner.subscribe(() => { removed++; }); unsubscribe();
    owner.subscribe(() => { throw new Error("synthetic-observer"); });
    const initial = activate(owner); assert.equal(await owner.execute(prepare(owner, initial)), false);
    assert.equal(snap(owner).phase, "uncertain"); assert.equal(removed, 0);
    owner.dispose(); assert.equal(owner.getSnapshot(), null); assert.equal(owner.activate({ lease: {}, context: CONTEXT }), null);
    assert.equal(await owner.execute(initial), false); owner.dispose(); owner.subscribe(() => {})();
  }
});

async function realFlow(mode: "normal" | "ack-loss" | "alias-after-commit") {
  const source = await createCandidateSelectionFixture(REVIEW_NOW, 86400000, () => CONTEXT.batchReference);
  const { store } = source, observed = source.batch.candidates[0]!, wires: string[] = [];
  const handler = createInboxDiscardHttpHandler({
    trustedOrigin: "https://synthetic.invalid", now: () => store.controls.now, newId: () => store.dependencies.newId(),
    readSession: async () => structuredClone(store.controls.authority),
    admit: async (request) => ({ allowed: true, surface: request.surface, requestId: request.requestId,
      action: request.action, authority: request.authority, expiresAt: request.notAfter }),
    resolveBatch: source.references.resolve, transaction: store.referenceDependencies.transaction,
  });
  if (mode === "alias-after-commit") store.controls.afterCommit = () => {
    const reference = store.rows.batchReferences.get(CONTEXT.batchReference)!;
    store.rows.batchReferences.set(CONTEXT.batchReference, { ...reference, state: "retired", revision: 2 });
  };
  let owner!: CandidateDiscardOwner;
  const client = createCandidateDiscardClient({ origin: "https://synthetic.invalid",
    now: () => store.controls.now, readContext: () => owner.getContext(),
    fetch: async (request, signal) => {
      const wire = await request.text(); wires.push(wire); const headers = new Headers(request.headers);
      headers.set("origin", "https://synthetic.invalid"); headers.set("cookie", "synthetic-session=fixture"); headers.set("sec-fetch-site", "same-origin");
      const response = await handler(new Request(request.url, { method: request.method, headers, body: wire, signal }));
      if (mode === "ack-loss" && wires.length === 1) { await response.body?.cancel(); throw new Error("synthetic-ack-loss"); }
      return response;
    },
  });
  owner = createCandidateDiscardOwner(client); const initial = activate(owner);
  const prepared = prepare(owner, initial, { candidateId: observed.candidateId, expectedRevision: observed.candidateRevision });
  return { ...source, owner, prepared, wires, observed };
}
test("actual analysis→handler→client→owner ACK loss retains exact request and explicit replay returns receipt without another erase", async () => {
  const f = await realFlow("ack-loss"), otherBefore = structuredClone(f.store.rows.candidates.get(f.batch.candidates[1]!.candidateId));
  assert.equal(await f.owner.execute(f.prepared), false); assert.equal(snap(f.owner).phase, "uncertain");
  const afterCommit = f.store.snapshot(), original = snap(f.owner).request;
  assert.equal(f.store.rows.candidates.get(f.observed.candidateId)!.state, "deleted");
  assert.equal(await f.owner.reconcile(snap(f.owner)), true); assert.equal(snap(f.owner).phase, "succeeded");
  assert.equal(snap(f.owner).request, original); assert.equal(f.wires.length, 2); assert.equal(f.wires[0], f.wires[1]);
  assert.deepEqual(f.store.snapshot(), afterCommit);
  assert.deepEqual(f.store.rows.candidates.get(f.batch.candidates[1]!.candidateId), otherBefore);
  assert.deepEqual(f.readAnalysisCounts(), { quota: 1, mailbox: 1, analysis: 1 });
});
test("actual first409 AFTER commit remains uncertain; retired-alias404 reconcile cannot replace original or claim rollback", async () => {
  const f = await realFlow("alias-after-commit"), before = f.store.controls.commits;
  assert.equal(await f.owner.execute(f.prepared), false); const unknown = snap(f.owner);
  assert.equal(f.store.controls.commits, before + 1); assert.equal(f.store.controls.rollbacks, 0);
  assert.equal(f.store.rows.candidates.get(f.observed.candidateId)!.state, "deleted");
  assert.equal(f.store.rows.candidates.get(f.observed.candidateId)!.content, null);
  assert.equal(unknown.phase, "uncertain"); assert.deepEqual(unknown.failure,
    { kind: "error", code: "API_CONFLICT", retriableAfterMs: null, dispatched: true });
  assert.equal(f.owner.prepare(unknown, { ...OBSERVATION, expectedRevision: 2 }), null);
  delete f.store.controls.afterCommit; const afterCommit = f.store.snapshot();
  assert.equal(await f.owner.reconcile(unknown), false);
  assert.equal(snap(f.owner).phase, "uncertain"); assert.equal(snap(f.owner).request, unknown.request);
  assert.deepEqual(snap(f.owner).failure, { kind: "error", code: "API_NOT_FOUND", retriableAfterMs: null, dispatched: true });
  assert.deepEqual(f.store.snapshot(), afterCommit); assert.equal(f.wires[0], f.wires[1]);
});
