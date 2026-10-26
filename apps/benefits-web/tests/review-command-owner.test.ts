import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewCommandOwner, MAX_REVIEW_PREPARED_COMMANDS } from "../src/domain/review-client/command-owner.ts";
import { createReviewPreviewRequest, createReviewConfirmRequest, createReviewRejectRequest, createReviewDeleteRequest,
  createReviewGetRequest, createReviewListRequest } from "../src/domain/review-client/requests.ts";
import type { ReviewClientConfig, ReviewTransport } from "../src/domain/review-client/client.ts";
import { createReviewPreviewDemoData } from "../src/lib/review-preview-demo-data.ts";

// Local opaque-token ownership over synthetic Fetch objects. Not actual auth,
// UI lifecycle, server operation uniqueness, durable storage or rollback proof.
// Awaited-flight limits do not bound arbitrary noncooperative transport lifetime.
type Owner = ReturnType<typeof createReviewCommandOwner>;
type Lease = NonNullable<ReturnType<Owner["activate"]>>;
type Config = Omit<ReviewClientConfig, "readViewContext">;
const ORIGIN = "https://synthetic.invalid", NOW = 1790000000000;
const CONFIG_ERROR = { name: "Error", message: "REVIEW_COMMAND_OWNER_CONFIG_INVALID" };
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, value }), {
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const deleted = (benefitId = "synthetic-benefit", dataGeneration = 1, benefitRevision = 2) => ({
  schema: "keyatlas.reviewed-benefit-view.v1", dataGeneration, benefitId, benefitRevision, outcome: "deleted", content: null,
});
const get = () => createReviewGetRequest("synthetic-benefit");
function fixture(fetch: ReviewTransport = async () => response(deleted()), patch: Partial<Config> = {}) {
  return createReviewCommandOwner({ origin: ORIGIN, fetch, now: () => NOW, timeoutMs: 1000, ...patch });
}
function activate(owner: Owner, generation: unknown = 1): Lease {
  const lease = owner.activate(generation); assert.ok(lease); return lease;
}
function prepare(owner: Owner, lease: Lease, request: unknown = get()) {
  const result = owner.prepare(lease, request); assert.equal(result.kind, "prepared");
  if (result.kind !== "prepared") throw new Error("synthetic-prepare-failed");
  return result.command;
}
function gate<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function previewSample() {
  const preview = createReviewPreviewDemoData("corrected-zero", NOW, 1);
  return { preview, request: createReviewPreviewRequest("synthetic-candidate", 1, preview.content.serviceId,
    preview.content.serviceRevision, preview.content.values) };
}

test("construction, activation and preparation are lazy and snapshots are cached frozen opaque leases", () => {
  let fetches = 0, clockReads = 0;
  const owner = fixture(async () => { fetches++; return response(deleted()); }, { now: () => { clockReads++; return NOW; } });
  assert.equal(owner.getSnapshot(), null);
  assert.deepEqual(owner.prepare({} as Lease, get()), { kind: "inactive" });
  const lease = activate(owner), a = owner.getSnapshot()!;
  assert.equal(a.lease, lease); assert.equal(a.dataGeneration, 1); assert.equal(owner.getSnapshot(), a);
  assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(lease)); assert.deepEqual(Reflect.ownKeys(lease), []);
  assert.equal(typeof a.viewScope, "string"); assert.ok(a.viewScope.length > 0);
  const command = prepare(owner, lease);
  assert.ok(Object.isFrozen(command)); assert.deepEqual(Reflect.ownKeys(command), []);
  assert.equal(owner.getSnapshot(), a); assert.equal(fetches, 0); assert.equal(clockReads, 0);
  owner.dispose();
});

test("every activation, including A to B to A, gets distinct identity and rejects old unsent commands", async () => {
  let calls = 0;
  const owner = fixture(async () => { calls++; return response(deleted()); });
  const a = activate(owner), old = prepare(owner, a), scopeA = owner.getSnapshot()!.viewScope;
  const b = activate(owner, 2), scopeB = owner.getSnapshot()!.viewScope;
  const fresh = activate(owner), scopeFresh = owner.getSnapshot()!.viewScope;
  assert.notEqual(a, b); assert.notEqual(a, fresh); assert.notEqual(b, fresh);
  assert.equal(new Set([scopeA, scopeB, scopeFresh]).size, 3);
  assert.deepEqual(await owner.execute(a, old), { kind: "stale" });
  assert.deepEqual(await owner.execute(fresh, old), { kind: "stale" });
  owner.deactivate(a); assert.equal(owner.getSnapshot()!.lease, fresh);
  assert.equal(calls, 0); assert.equal((await owner.execute(fresh, prepare(owner, fresh))).kind, "success");
  owner.dispose();
});

for (const generation of [0, -0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined]) {
  test(`invalid activation ${String(generation)} first revokes the previous scope`, async () => {
    const owner = fixture(), lease = activate(owner), command = prepare(owner, lease);
    assert.equal(owner.activate(generation), null); assert.equal(owner.getSnapshot(), null);
    assert.deepEqual(await owner.execute(lease, command), { kind: "stale" });
    assert.deepEqual(owner.prepare(lease, get()), { kind: "inactive" }); owner.dispose();
  });
}

test("foreign/copied/forged capabilities cannot execute; wrong-owner cleanup cannot remove valid commands", async () => {
  let calls = 0;
  const owner = fixture(async () => { calls++; return response(deleted()); }), other = fixture();
  const lease = activate(owner), foreignLease = activate(other), command = prepare(owner, lease), foreign = prepare(other, foreignLease);
  assert.notEqual(owner.getSnapshot()!.viewScope, other.getSnapshot()!.viewScope);
  assert.deepEqual(await owner.execute(foreignLease, command), { kind: "stale" });
  assert.deepEqual(await owner.execute({ ...lease } as Lease, command), { kind: "stale" });
  for (const forged of [{}, { ...command }, JSON.parse(JSON.stringify(command)), foreign]) {
    assert.deepEqual(await owner.execute(lease, forged), { kind: "invalid", reason: "REQUEST" });
  }
  owner.release(foreignLease, command); owner.release(lease, foreign); other.release(foreignLease, command);
  assert.equal(calls, 0); assert.equal((await owner.execute(lease, command)).kind, "success");
  owner.release(lease, command); owner.release(lease, command);
  assert.deepEqual(await owner.execute(lease, command), { kind: "stale" });
  owner.dispose(); other.dispose();
});

test("prepare captures mutable input once and exact retries keep the original wire command", async () => {
  const sent: string[] = [];
  const owner = fixture(async (request) => { sent.push(await request.text()); return response(deleted()); });
  const lease = activate(owner), input = { action: "get", body: { benefitId: "synthetic-benefit" } }, command = prepare(owner, lease, input);
  input.action = "delete"; input.body.benefitId = "synthetic-replaced";
  assert.equal((await owner.execute(lease, command)).kind, "success");
  assert.equal((await owner.execute(lease, command)).kind, "success");
  assert.deepEqual(sent, [JSON.stringify({ benefitId: "synthetic-benefit" }), JSON.stringify({ benefitId: "synthetic-benefit" })]);
  owner.dispose();
});

for (const action of ["preview", "reject"] as const) for (const outcome of ["success", "network"] as const) {
  test(`${action} has only one attempted execution even after ${outcome}`, async () => {
    let calls = 0; const sample = previewSample();
    const owner = fixture(async () => {
      calls++; if (outcome === "network") throw new Error("synthetic-private-transport");
      return response(action === "preview" ? sample.preview : { previewId: "synthetic-preview", state: "revoked" });
    });
    const lease = activate(owner), command = prepare(owner, lease,
      action === "preview" ? sample.request : createReviewRejectRequest("synthetic-preview", 1));
    assert.equal((await owner.execute(lease, command)).kind, outcome);
    assert.deepEqual(await owner.execute(lease, command), { kind: "consumed" }); assert.equal(calls, 1);
    owner.release(lease, command); assert.deepEqual(await owner.execute(lease, command), { kind: "stale" }); owner.dispose();
  });
}

for (const action of ["confirm", "delete", "get", "list"] as const) test(`${action} sequential explicit retry reuses the immutable operation and request`, async () => {
  const bodies: string[] = [];
  const owner = fixture(async (request) => {
    bodies.push(await request.text());
    if (bodies.length === 1) throw new Error("synthetic-uncertain-delivery");
    return response(action === "list" ? { schema: "keyatlas.reviewed-benefit-page.v1", dataGeneration: 1,
      benefitCollectionRevision: 1, benefits: [], nextCursor: null } : deleted());
  });
  const lease = activate(owner), request = action === "confirm" ? createReviewConfirmRequest("synthetic-preview", "synthetic-confirm")
    : action === "delete" ? createReviewDeleteRequest("synthetic-benefit", 1, "synthetic-delete")
    : action === "list" ? createReviewListRequest(50, null) : get();
  const command = prepare(owner, lease, request);
  assert.equal((await owner.execute(lease, command)).kind, "network");
  assert.equal((await owner.execute(lease, command)).kind, "success");
  assert.equal((await owner.execute(lease, command)).kind, "success");
  assert.equal(bodies.length, 3); assert.ok(bodies.every((body) => body === JSON.stringify(request.body)));
  owner.dispose();
});

for (const action of ["get", "preview"] as const) test(`${action} concurrent same-token attempt is busy without a second HTTP request`, async () => {
  const entered = gate<void>(), reply = gate<Response>(); let calls = 0; const sample = previewSample();
  const owner = fixture(async () => { calls++; entered.resolve(); return reply.promise; });
  const lease = activate(owner), command = prepare(owner, lease, action === "get" ? get() : sample.request);
  const first = owner.execute(lease, command); await entered.promise;
  assert.deepEqual(await owner.execute(lease, command), { kind: "busy" }); assert.equal(calls, 1);
  reply.resolve(response(action === "get" ? deleted() : sample.preview)); assert.equal((await first).kind, "success");
  if (action === "preview") assert.deepEqual(await owner.execute(lease, command), { kind: "consumed" });
  owner.dispose();
});

test("invalid requests consume no prepared slots; release frees exactly its own one slot", async () => {
  assert.equal(MAX_REVIEW_PREPARED_COMMANDS, 64);
  const owner = fixture(), other = fixture(), lease = activate(owner), otherLease = activate(other);
  for (let index = 0; index < 70; index++) assert.deepEqual(owner.prepare(lease, {}), { kind: "invalid" });
  const commands = Array.from({ length: 64 }, () => prepare(owner, lease));
  assert.deepEqual(owner.prepare(lease, get()), { kind: "capacity" });
  owner.release(otherLease, commands[0]!); owner.release(lease, prepare(other, otherLease));
  assert.deepEqual(owner.prepare(lease, get()), { kind: "capacity" });
  owner.release(lease, commands[0]!); const replacement = prepare(owner, lease);
  assert.deepEqual(owner.prepare(lease, get()), { kind: "capacity" });
  assert.deepEqual(await owner.execute(lease, commands[0]!), { kind: "stale" });
  assert.equal((await owner.execute(lease, replacement)).kind, "success"); owner.dispose(); other.dispose();
});

test("released in-flight command aborts only itself and late completion cannot reenter the owner", async () => {
  const pending = [gate<Response>(), gate<Response>()], entered = [gate<void>(), gate<void>()];
  const signals: AbortSignal[] = []; let index = 0, lateCancelled = 0;
  const owner = fixture(async (_request, signal) => { const own = index++; signals.push(signal); entered[own]!.resolve(); return pending[own]!.promise; });
  const lease = activate(owner), first = prepare(owner, lease), second = prepare(owner, lease);
  const runFirst = owner.execute(lease, first), runSecond = owner.execute(lease, second);
  await Promise.all(entered.map((gate) => gate.promise)); owner.release(lease, first);
  assert.equal(signals[0]!.aborted, true); assert.equal(signals[1]!.aborted, false);
  assert.deepEqual(await runFirst, { kind: "stale" });
  pending[0]!.resolve(new Response(new ReadableStream({ cancel() { lateCancelled++; } }), { headers: { "content-type": "application/json", "cache-control": "no-store" } }));
  pending[1]!.resolve(response(deleted())); assert.equal((await runSecond).kind, "success");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lateCancelled, 1); assert.equal(owner.getSnapshot()!.lease, lease); owner.dispose();
});

for (const invalidation of ["deactivate", "activate", "dispose"] as const) for (const ending of ["resolve", "reject"] as const) {
  test(`${invalidation} before late ${ending} never delivers the previous scope`, async () => {
    const entered = gate<void>(), reply = gate<Response>(); let signal!: AbortSignal;
    const owner = fixture(async (_request, current) => { signal = current; entered.resolve(); return reply.promise; });
    const lease = activate(owner), command = prepare(owner, lease), pending = owner.execute(lease, command);
    await entered.promise;
    if (invalidation === "deactivate") owner.deactivate(lease);
    else if (invalidation === "dispose") owner.dispose(); else activate(owner, 2);
    const snapshot = owner.getSnapshot(); assert.equal(signal.aborted, true);
    assert.deepEqual(await pending, { kind: "stale" });
    if (ending === "reject") reply.reject(new Error("synthetic-late-private-detail")); else reply.resolve(response(deleted()));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(owner.getSnapshot(), snapshot); owner.dispose();
  });
}

for (const cancelOuter of ["none", "deactivate", "dispose"] as const) test(`scope replacement clears before abort and resists reentrant work: ${cancelOuter}`, async () => {
  const entered = gate<void>(), never = gate<Response>();
  const observations: unknown[] = []; let nestedExecution: ReturnType<Owner["execute"]> | undefined;
  let lease!: Lease, command!: ReturnType<typeof prepare>;
  const owner = fixture(async (_request, signal) => {
    signal.addEventListener("abort", () => {
      observations.push(owner.getSnapshot(), owner.activate(3), owner.prepare(lease, get()));
      nestedExecution = owner.execute(lease, command);
      if (cancelOuter === "deactivate") owner.deactivate(lease);
      if (cancelOuter === "dispose") owner.dispose();
    }, { once: true }); entered.resolve(); return never.promise;
  });
  lease = activate(owner); command = prepare(owner, lease);
  const pending = owner.execute(lease, command); await entered.promise;
  const replacement = owner.activate(2);
  assert.deepEqual(observations, [null, null, { kind: "inactive" }]);
  assert.deepEqual(await nestedExecution, { kind: "stale" }); assert.deepEqual(await pending, { kind: "stale" });
  if (cancelOuter === "none") { assert.ok(replacement); assert.equal(owner.getSnapshot()!.lease, replacement); }
  else { assert.equal(replacement, null); assert.equal(owner.getSnapshot(), null); }
  never.reject(new Error("synthetic-late-stop")); await new Promise<void>((resolve) => setImmediate(resolve)); owner.dispose();
});

test("prepare reflection invalidation cannot install an old-scope command or call transport", async () => {
  let calls = 0;
  const owner = fixture(async () => { calls++; return response(deleted()); }), lease = activate(owner);
  const hostile = new Proxy(get(), { ownKeys(target) { owner.deactivate(lease); return Reflect.ownKeys(target); } });
  assert.deepEqual(owner.prepare(lease, hostile), { kind: "inactive" });
  assert.equal(owner.getSnapshot(), null); assert.equal(calls, 0); owner.dispose();
});

for (const cleanup of ["release", "activate"] as const) test(`64 awaited flights remain bounded across synchronous ${cleanup}`, async () => {
  const pending: ReturnType<Owner["execute"]>[] = []; let calls = 0;
  const owner = fixture(async () => { calls++; return new Promise<Response>(() => {}); });
  const oldLease = activate(owner), commands = Array.from({ length: 64 }, () => prepare(owner, oldLease));
  for (const command of commands) pending.push(owner.execute(oldLease, command));
  const current = cleanup === "activate" ? activate(owner) : oldLease;
  if (cleanup === "release") for (const command of commands) owner.release(oldLease, command);
  const next = prepare(owner, current);
  // Capture synchronously, before awaiting allows abort cleanup to settle.
  const overCapacity = owner.execute(current, next);
  assert.deepEqual(await overCapacity, { kind: "busy" }); assert.equal(calls, 64);
  assert.ok((await Promise.all(pending)).every((result) => result.kind === "stale"));
  owner.release(current, next); owner.dispose();
});

test("dispose is permanent, clears prepared tokens and cannot be reversed by stale cleanup", async () => {
  const owner = fixture(), lease = activate(owner), command = prepare(owner, lease);
  owner.dispose(); owner.dispose(); owner.deactivate(lease); owner.release(lease, command);
  assert.equal(owner.activate(1), null); assert.equal(owner.getSnapshot(), null);
  assert.deepEqual(owner.prepare(lease, get()), { kind: "disposed" });
  assert.deepEqual(await owner.execute(lease, command), { kind: "stale" });
});

test("a clock rollback remains invalid across command and activation boundaries", async () => {
  let time = NOW, calls = 0;
  const owner = fixture(async () => { calls++; return response(deleted()); }, { now: () => time });
  const a = activate(owner); assert.equal((await owner.execute(a, prepare(owner, a))).kind, "success");
  time = NOW - 1; const b = activate(owner);
  assert.deepEqual(await owner.execute(b, prepare(owner, b)), { kind: "invalid", reason: "CLOCK" });
  assert.equal(calls, 1); owner.dispose();
});

for (const offset of [-1, 0]) test(`owner final preview delivery applies expiry at offset ${offset}`, async () => {
  const { preview, request } = previewSample(); let baselineReads = 0;
  const baseline = fixture(async () => response(preview), { now: () => { baselineReads++; return NOW; } });
  const a = activate(baseline); assert.equal((await baseline.execute(a, prepare(baseline, a, request))).kind, "success"); baseline.dispose();
  let reads = 0;
  const owner = fixture(async () => response(preview), { now: () => ++reads >= baselineReads ? preview.expiresAt + offset : NOW });
  const lease = activate(owner), result = await owner.execute(lease, prepare(owner, lease, request));
  assert.equal(reads, baselineReads); assert.ok(reads > 2);
  if (offset < 0) assert.equal(result.kind, "success"); else assert.deepEqual(result, { kind: "invalid", reason: "ENVELOPE" });
  owner.dispose();
});

test("strict configuration rejects malformed values, accessors and extra authority readers without invoking hooks", () => {
  const valid: Config = { origin: ORIGIN, fetch: async () => response(deleted()), now: () => NOW, timeoutMs: 1000 };
  let getters = 0;
  for (const invalid of [null, [], { ...valid, extra: true }, { ...valid, readViewContext: () => null },
    { ...valid, origin: ORIGIN + "/" }, { ...valid, origin: "http://synthetic.invalid" }, { ...valid, fetch: null },
    { ...valid, now: null }, { ...valid, timeoutMs: 0 }, { ...valid, timeoutMs: 10001 },
    Object.defineProperty({ ...valid }, "origin", { enumerable: true, get() { getters++; return ORIGIN; } }),
    Object.defineProperty({ ...valid }, "hidden", { value: true }), { ...valid, [Symbol("extra")]: true }]) {
    assert.throws(() => createReviewCommandOwner(invalid as Config), CONFIG_ERROR);
  }
  assert.equal(getters, 0);
  const nullPrototype = Object.assign(Object.create(null) as Config, valid);
  const owner = createReviewCommandOwner(nullPrototype); assert.equal(owner.getSnapshot(), null); owner.dispose();
});

test("configuration snapshots trusted ports and normalizes reflection exceptions", async () => {
  let replacementCalls = 0;
  const config: { -readonly [Key in keyof Config]: Config[Key] } = {
    origin: ORIGIN, fetch: async () => response(deleted()), now: () => NOW,
  };
  const owner = createReviewCommandOwner(config);
  config.origin = "https://changed.invalid";
  config.fetch = async () => { replacementCalls++; throw Error("synthetic-replaced-fetch"); };
  config.now = () => { replacementCalls++; return NaN; };
  const lease = activate(owner);
  assert.equal((await owner.execute(lease, prepare(owner, lease))).kind, "success");
  assert.equal(replacementCalls, 0); owner.dispose();
  const valid = { origin: ORIGIN, fetch: async () => response(deleted()) };
  for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const) {
    assert.throws(() => createReviewCommandOwner(new Proxy(valid, { [trap]() { throw Error("synthetic-private-proxy"); } })), CONFIG_ERROR);
  }
  const revoked = Proxy.revocable(valid, {}); revoked.revoke();
  assert.throws(() => createReviewCommandOwner(revoked.proxy), CONFIG_ERROR);
});

test("construction never touches crypto and activation fails closed without a secure UUID facility", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let cryptoReads = 0;
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, get() { cryptoReads++; throw Error("synthetic-crypto-unavailable"); } });
    const owner = fixture(); assert.equal(cryptoReads, 0); assert.equal(owner.getSnapshot(), null);
    assert.equal(owner.activate(1), null); assert.equal(cryptoReads, 1); assert.equal(owner.getSnapshot(), null); owner.dispose();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor); else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("UUID failure during replacement revokes the previous unsent lease without weak fallback", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    for (const broken of [undefined, { randomUUID: () => { throw Error("synthetic-private-uuid"); } },
      { randomUUID: () => "not-a-valid-uuid" }, { randomUUID: () => 1 }]) {
      if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor); else Reflect.deleteProperty(globalThis, "crypto");
      const owner = fixture(), lease = activate(owner), command = prepare(owner, lease);
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: broken });
      assert.equal(owner.activate(1), null); assert.equal(owner.getSnapshot(), null);
      assert.deepEqual(await owner.execute(lease, command), { kind: "stale" }); owner.dispose();
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor); else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("repeated valid UUID fixture cannot reuse the same owner's scope on A to B to A", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true,
      value: { randomUUID: () => "12345678-1234-4234-8234-123456789abc" } });
    const owner = fixture(), first = activate(owner), token = prepare(owner, first), scopes = [owner.getSnapshot()!.viewScope];
    activate(owner, 2); scopes.push(owner.getSnapshot()!.viewScope);
    const latest = activate(owner); scopes.push(owner.getSnapshot()!.viewScope);
    assert.equal(new Set(scopes).size, 3); assert.notEqual(first, latest);
    assert.deepEqual(await owner.execute(latest, token), { kind: "stale" }); owner.dispose();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor); else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("foreign cursor generation and malformed getters are rejected before transport without allocating a slot", () => {
  let calls = 0, getters = 0;
  const owner = fixture(async () => { calls++; return response(deleted()); }), lease = activate(owner);
  assert.deepEqual(owner.prepare(lease, createReviewListRequest(50,
    { afterId: "synthetic-benefit", benefitCollectionRevision: 1, dataGeneration: 2 })), { kind: "invalid" });
  const request = { action: "get", get body() { getters++; return { benefitId: "synthetic-benefit" }; } };
  assert.deepEqual(owner.prepare(lease, request), { kind: "invalid" });
  assert.equal(getters, 0); assert.equal(calls, 0);
  for (let index = 0; index < 64; index++) prepare(owner, lease);
  assert.deepEqual(owner.prepare(lease, get()), { kind: "capacity" }); owner.dispose();
});

test("request reflection cannot recursively mint commands or execute while preparation is in progress", async () => {
  let calls = 0;
  const owner = fixture(async () => { calls++; return response(deleted()); }), lease = activate(owner), existing = prepare(owner, lease);
  const nested: unknown[] = []; let execution: ReturnType<Owner["execute"]> | undefined;
  const input = new Proxy(get(), { ownKeys(target) {
    nested.push(owner.activate(2), owner.prepare(lease, get())); execution = owner.execute(lease, existing);
    return Reflect.ownKeys(target);
  } });
  const outer = owner.prepare(lease, input); assert.equal(outer.kind, "prepared");
  assert.deepEqual(nested, [null, { kind: "inactive" }]); assert.deepEqual(await execution, { kind: "stale" });
  assert.equal(owner.getSnapshot()!.lease, lease); assert.equal(calls, 0);
  assert.equal((await owner.execute(lease, existing)).kind, "success"); owner.dispose();
});
