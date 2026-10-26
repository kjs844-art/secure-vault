import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewWorkspace, normalizeReviewWorkspaceContext, type ReviewWorkspace } from "../src/domain/review-client/workspace.ts";
import { createReviewGetRequest, createReviewPreviewRequest, createReviewRejectRequest,
  createReviewListRequest } from "../src/domain/review-client/requests.ts";
import type { ReviewTransport } from "../src/domain/review-client/client.ts";
import { createReviewPreviewDemoData } from "../src/lib/review-preview-demo-data.ts";

// SYNTHETIC: coordinator state and adversarial callback ordering, not browser,
// live authentication, provider access or durable storage evidence.
const NOW = 1790000000000;
const CONTEXT = Object.freeze({ bindingId: "synthetic-workspace", dataGeneration: 1 });
type Lease = NonNullable<ReturnType<ReviewWorkspace["activate"]>>;
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, value }), {
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const tombstone = (benefitRevision = 2) => ({ schema: "keyatlas.reviewed-benefit-view.v1", dataGeneration: 1,
  benefitId: "synthetic-benefit", benefitRevision, outcome: "deleted", content: null });
const page = () => ({ schema: "keyatlas.reviewed-benefit-page.v1", dataGeneration: 1,
  benefitCollectionRevision: 1, benefits: [], nextCursor: null });
const get = () => createReviewGetRequest("synthetic-benefit");
function fixture(transport: ReviewTransport = async () => response(tombstone())) {
  let samples = 0, calls = 0;
  const time = { wall: NOW, monotonic: 0 };
  const workspace = createReviewWorkspace({ client: { origin: "https://synthetic.invalid", timeoutMs: 1000,
    fetch: (request, signal) => { calls++; return transport(request, signal); } },
  clocks: () => { samples++; return { ...time }; } });
  return { workspace, time, counts: () => ({ samples, calls }) };
}
function open(workspace: ReviewWorkspace): Lease { const lease = workspace.activate(CONTEXT); assert.ok(lease); return lease; }
function prepare(workspace: ReviewWorkspace, lease: Lease, input: unknown = get()) {
  const result = workspace.prepare(lease, input); assert.equal(result.kind, "prepared");
  if (result.kind !== "prepared") throw Error("SYNTHETIC_EXPECTED_PREPARED");
  return result.command;
}
function previewSample(sequence = 1) {
  const value = createReviewPreviewDemoData("corrected-zero", NOW, sequence);
  return { value, request: createReviewPreviewRequest("synthetic-candidate", 1,
    value.content.serviceId, value.content.serviceRevision, value.content.values) };
}
function gate<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test("workspace construction and preparation are inert; activation samples the preview clock without transport", () => {
  const f = fixture(); let publications = 0;
  f.workspace.subscribe(() => { publications++; });
  assert.equal(f.workspace.getSnapshot(), null);
  assert.deepEqual(f.counts(), { samples: 0, calls: 0 });
  const lease = open(f.workspace), snapshot = f.workspace.getSnapshot()!;
  assert.equal(snapshot.lease, lease); assert.equal(snapshot.preview.phase, "idle"); assert.equal(snapshot.list.phase, "ready");
  assert.deepEqual(snapshot.context, CONTEXT); assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.context));
  assert.equal(snapshot, f.workspace.getSnapshot()); assert.deepEqual(Reflect.ownKeys(lease), []);
  const activatedCounts = f.counts(); assert.equal(activatedCounts.calls, 0); assert.ok(activatedCounts.samples > 0);
  prepare(f.workspace, lease); assert.equal(publications, 1); assert.deepEqual(f.counts(), activatedCounts);
  assert.deepEqual(f.workspace.prepare(lease, createReviewListRequest(50, null)), { kind: "invalid" });
  f.workspace.dispose(); assert.equal(publications, 2); assert.equal(f.workspace.getSnapshot(), null);
});

for (const input of [null, undefined, {}, [], { ...CONTEXT, extra: true }, { ...CONTEXT, bindingId: " padded" },
  { ...CONTEXT, dataGeneration: 0 }, { ...CONTEXT, dataGeneration: NaN }, Object.create(CONTEXT)]) {
  test(`invalid context ${String(input)} revokes before rejecting`, async () => {
    const f = fixture(), lease = open(f.workspace), command = prepare(f.workspace, lease);
    assert.equal(normalizeReviewWorkspaceContext(input), null); assert.equal(f.workspace.activate(input), null);
    assert.equal(f.workspace.getSnapshot(), null); assert.deepEqual(await f.workspace.execute(lease, command), { kind: "stale" });
    assert.equal(f.counts().calls, 0); f.workspace.dispose();
  });
}

test("malformed accessors are not invoked, reflection revocation cannot resurrect old or replacement views", () => {
  const f = fixture(); let getters = 0;
  const getter = Object.defineProperty({ dataGeneration: 1 }, "bindingId", { enumerable: true,
    get() { getters++; return "synthetic"; } });
  assert.equal(normalizeReviewWorkspaceContext(getter), null); assert.equal(getters, 0);
  const lease = open(f.workspace);
  const proxy = new Proxy({ ...CONTEXT }, { getPrototypeOf(target) {
    f.workspace.deactivate(lease); return Reflect.getPrototypeOf(target);
  } });
  assert.equal(f.workspace.activate(proxy), null); assert.equal(f.workspace.getSnapshot(), null); f.workspace.dispose();
});

test("A-B-A bindings get distinct leases; stale and foreign tokens cannot dispatch or clear fresh display", async () => {
  const f = fixture(), other = fixture(), a = open(f.workspace), old = prepare(f.workspace, a);
  const b = open(f.workspace), current = open(f.workspace), foreign = open(other.workspace);
  assert.equal(new Set([a, b, current]).size, 3);
  f.workspace.deactivate(a); f.workspace.deactivate(foreign);
  for (const lease of [a, b, foreign, current]) assert.deepEqual(await f.workspace.execute(lease, old), { kind: "stale" });
  assert.deepEqual(await f.workspace.execute(current, {}), { kind: "invalid", reason: "REQUEST" });
  assert.equal(f.workspace.getSnapshot()?.lease, current); assert.equal(f.counts().calls, 0);
  f.workspace.dispose(); other.workspace.dispose();
});

test("publication cannot reenter dispatch; revocation during publication prevents returning a successful lease", async () => {
  const f = fixture(); let activation: unknown, preparation: unknown, execution: Promise<unknown> | undefined;
  f.workspace.subscribe(() => {
    const snapshot = f.workspace.getSnapshot(); if (!snapshot) return;
    activation = f.workspace.activate(CONTEXT); preparation = f.workspace.prepare(snapshot.lease, get());
    execution = f.workspace.execute(snapshot.lease, {}); f.workspace.deactivate(snapshot.lease);
  });
  assert.equal(f.workspace.activate(CONTEXT), null); assert.equal(activation, null);
  assert.deepEqual(preparation, { kind: "inactive" }); assert.deepEqual(await execution, { kind: "stale" });
  assert.equal(f.workspace.getSnapshot(), null); assert.equal(f.counts().calls, 0); f.workspace.dispose();
});

test("replacement revoked by observer of the old null snapshot cannot open itself afterward", () => {
  const f = fixture(), lease = open(f.workspace);
  f.workspace.subscribe(() => { if (f.workspace.getSnapshot() === null) f.workspace.deactivate(lease); });
  assert.equal(f.workspace.activate(CONTEXT), null); assert.equal(f.workspace.getSnapshot(), null); f.workspace.dispose();
});

test("preview publication, consumed retry and stale cancel preserve exactly the displayed ticket", async () => {
  const sample = previewSample(), f = fixture(async () => response(sample.value)), lease = open(f.workspace);
  const initial = f.workspace.getSnapshot()!, command = prepare(f.workspace, lease, sample.request);
  const phases: string[] = []; f.workspace.subscribe(() => { phases.push(f.workspace.getSnapshot()?.preview.phase ?? "closed"); });
  assert.equal((await f.workspace.execute(lease, command)).kind, "success");
  const ready = f.workspace.getSnapshot()!; assert.deepEqual(phases, ["loading", "ready"]);
  assert.equal(ready.preview.preview?.content.values.remainingAmount, 0);
  assert.deepEqual(await f.workspace.execute(lease, command), { kind: "consumed" }); assert.equal(f.workspace.getSnapshot(), ready);
  assert.equal(f.workspace.cancelPreview(lease, initial.preview), false);
  assert.equal(f.workspace.cancelPreview(lease, ready.preview), true); assert.equal(f.workspace.getSnapshot()?.preview.phase, "idle");
  assert.equal(f.counts().calls, 1); f.workspace.dispose();
});

test("a newer preview aborts the old flight and its late result never overwrites the replacement", async () => {
  const first = previewSample(), second = previewSample(2), hold = gate<Response>(); let count = 0, aborted = false;
  const f = fixture(async (_request, signal) => {
    count++; if (count === 1) { signal.addEventListener("abort", () => { aborted = true; }); return hold.promise; }
    return response(second.value);
  }), lease = open(f.workspace);
  const a = prepare(f.workspace, lease, first.request), b = prepare(f.workspace, lease, second.request);
  const pending = f.workspace.execute(lease, a);
  assert.equal(f.workspace.getSnapshot()?.preview.phase, "loading");
  assert.equal((await f.workspace.execute(lease, b)).kind, "success");
  assert.ok(aborted); assert.deepEqual(await pending, { kind: "stale" });
  hold.resolve(response(first.value)); await new Promise<void>((done) => setImmediate(done));
  assert.equal(f.workspace.getSnapshot()?.preview.preview?.previewId, second.value.previewId); f.workspace.dispose();
});

test("release removes pending display before transport abort callback, and abort reentry cannot acquire fresh scope", async () => {
  const hold = gate<Response>(), sample = previewSample(); let observed: unknown, activated: unknown;
  const f = fixture(async (_request, signal) => {
    signal.addEventListener("abort", () => {
      observed = f.workspace.getSnapshot()?.preview.phase; activated = f.workspace.activate(CONTEXT);
    }); return hold.promise;
  }), lease = open(f.workspace), command = prepare(f.workspace, lease, sample.request);
  const pending = f.workspace.execute(lease, command); f.workspace.release(lease, command);
  assert.equal(observed, "idle"); assert.equal(activated, null); assert.deepEqual(await pending, { kind: "stale" });
  hold.resolve(response(sample.value)); f.workspace.dispose();
});

test("whole-view revocation hides all composite state before abort callbacks", async () => {
  const hold = gate<Response>(); let observed: unknown;
  const f = fixture(async (_request, signal) => { signal.addEventListener("abort", () => { observed = f.workspace.getSnapshot(); }); return hold.promise; });
  const lease = open(f.workspace), pending = f.workspace.execute(lease, prepare(f.workspace, lease));
  f.workspace.deactivate(lease); assert.equal(observed, null); assert.deepEqual(await pending, { kind: "stale" });
  hold.resolve(response(tombstone())); f.workspace.dispose();
});

for (const [status, code] of [[401, "API_AUTH_REQUIRED"], [403, "API_SESSION_CHANGED"], [403, "API_REQUEST_REJECTED"]] as const) {
  for (const action of ["get", "list"] as const) test(`${code} on ${action} closes the whole workspace`, async () => {
    const f = fixture(async () => new Response(JSON.stringify({ ok: false, code }), { status,
      headers: { "content-type": "application/json", "cache-control": "no-store" } }));
    const lease = open(f.workspace);
    const result = action === "list" ? await f.workspace.nextPage(lease) : await f.workspace.execute(lease, prepare(f.workspace, lease));
    assert.deepEqual(result, { kind: "stale" }); assert.equal(f.workspace.getSnapshot(), null); f.workspace.dispose();
  });
}

test("monotonic expiry clears only pending preview; invalid/backward clocks revoke the whole workspace", async () => {
  const sample = previewSample(), f = fixture(async () => response(sample.value)), lease = open(f.workspace);
  await f.workspace.execute(lease, prepare(f.workspace, lease, sample.request));
  const ready = f.workspace.getSnapshot()!; f.time.monotonic += 10_000;
  assert.equal(f.workspace.checkExpiry(lease, ready.preview), false); assert.equal(f.workspace.getSnapshot()?.preview.phase, "expired");
  assert.equal(f.workspace.getSnapshot()?.list, ready.list);
  f.time.wall--; assert.equal((await f.workspace.execute(lease, prepare(f.workspace, lease))).kind, "stale");
  assert.equal(f.workspace.getSnapshot(), null); f.workspace.dispose();
});

test("clock failure during preview expiry cannot leave an otherwise valid list visible", async () => {
  const sample = previewSample(), f = fixture(async () => response(sample.value)), lease = open(f.workspace);
  await f.workspace.execute(lease, prepare(f.workspace, lease, sample.request));
  f.time.monotonic = NaN;
  assert.equal(f.workspace.checkExpiry(lease, f.workspace.getSnapshot()!.preview), false);
  assert.equal(f.workspace.getSnapshot(), null); f.workspace.dispose();
});

test("only owned nextPage emits bounded list requests; explicit refresh never reuses the old page ticket", async () => {
  const bodies: unknown[] = [], f = fixture(async (request) => { bodies.push(await request.json()); return response(page()); });
  const lease = open(f.workspace), initial = f.workspace.getSnapshot()!;
  assert.equal((await f.workspace.nextPage(lease)).kind, "success"); assert.equal(f.workspace.getSnapshot()?.list.phase, "end_observed");
  assert.deepEqual(await f.workspace.nextPage(lease), { kind: "unavailable" });
  assert.equal(f.workspace.restartList(lease, initial.list), false);
  assert.equal(f.workspace.restartList(lease, f.workspace.getSnapshot()!.list), true);
  assert.equal((await f.workspace.nextPage(lease)).kind, "success");
  assert.deepEqual(bodies, [{ limit: 50, cursor: null }, { limit: 50, cursor: null }]); f.workspace.dispose();
});

for (const action of ["cancel", "restart", "receipt"] as const) test(`${action} fences a pending page and preserves unrelated command ownership`, async () => {
  const hold = gate<Response>(); let calls = 0;
  const f = fixture(async (request) => { calls++; return request.url.endsWith("/list") ? hold.promise : response(tombstone()); });
  const lease = open(f.workspace), command = prepare(f.workspace, lease), initial = f.workspace.getSnapshot()!;
  const pending = f.workspace.nextPage(lease), loading = f.workspace.getSnapshot()!;
  assert.equal(loading.list.phase, "loading"); assert.deepEqual(await f.workspace.nextPage(lease), { kind: "unavailable" });
  assert.equal(f.workspace.cancelPage(lease, initial.list), false);
  if (action === "cancel") assert.equal(f.workspace.cancelPage(lease, loading.list), true);
  if (action === "restart") assert.equal(f.workspace.restartList(lease, loading.list), true);
  if (action === "receipt") assert.equal((await f.workspace.execute(lease, command)).kind, "success");
  assert.deepEqual(await pending, { kind: "stale" }); hold.resolve(response(page()));
  assert.equal(f.workspace.getSnapshot()?.list.phase, action === "cancel" ? "retry_required" : action === "restart" ? "ready" : "restart_required");
  assert.equal((await f.workspace.execute(lease, command)).kind, "success"); assert.equal(calls, action === "receipt" ? 3 : 2);
  f.workspace.dispose();
});

test("a rejected earlier preview acknowledgement does not close a newer displayed preview", async () => {
  const first = previewSample(), second = previewSample(2), hold = gate<Response>(); let count = 0;
  const f = fixture(async (request) => {
    if (request.url.endsWith("/reject")) return hold.promise;
    return response(++count === 1 ? first.value : second.value);
  }), lease = open(f.workspace);
  await f.workspace.execute(lease, prepare(f.workspace, lease, first.request));
  const reject = prepare(f.workspace, lease, createReviewRejectRequest(first.value.previewId, 1));
  const pending = f.workspace.execute(lease, reject);
  await f.workspace.execute(lease, prepare(f.workspace, lease, second.request));
  hold.resolve(response({ previewId: first.value.previewId, state: "revoked" }));
  assert.equal((await pending).kind, "success"); assert.equal(f.workspace.getSnapshot()?.preview.preview?.previewId, second.value.previewId);
  f.workspace.dispose();
});

test("result publication revoked by observer returns stale instead of a detached successful receipt", async () => {
  const f = fixture(), lease = open(f.workspace), command = prepare(f.workspace, lease);
  f.workspace.subscribe(() => { if (f.workspace.getSnapshot()?.list.phase === "restart_required") f.workspace.deactivate(lease); });
  assert.deepEqual(await f.workspace.execute(lease, command), { kind: "stale" }); assert.equal(f.workspace.getSnapshot(), null); f.workspace.dispose();
});

for (const clock of ["wall", "monotonic"] as const) test(`preview expires during subscriber publication via ${clock} before successful return`, async () => {
  const sample = previewSample(), f = fixture(async () => response(sample.value)), lease = open(f.workspace);
  f.workspace.subscribe(() => { if (f.workspace.getSnapshot()?.preview.phase === "ready") f.time[clock] += 10_000; });
  assert.deepEqual(await f.workspace.execute(lease, prepare(f.workspace, lease, sample.request)), { kind: "invalid", reason: "ENVELOPE" });
  assert.equal(f.workspace.getSnapshot()?.preview.phase, "expired"); f.workspace.dispose();
});

test("prepared capacity is bounded; explicitly released ownership admits a fresh command", async () => {
  const f = fixture(), lease = open(f.workspace);
  const commands = Array.from({ length: 64 }, () => prepare(f.workspace, lease));
  assert.deepEqual(f.workspace.prepare(lease, get()), { kind: "capacity" });
  assert.deepEqual(await f.workspace.nextPage(lease), { kind: "unavailable" });
  assert.equal(f.counts().calls, 0); assert.equal(f.workspace.getSnapshot()?.list.phase, "retry_required");
  f.workspace.release(lease, commands[0]); const fresh = prepare(f.workspace, lease);
  assert.deepEqual(await f.workspace.execute(lease, commands[0]), { kind: "stale" });
  assert.equal((await f.workspace.execute(lease, fresh)).kind, "success"); f.workspace.dispose();
});

test("completed internally prepared pages release their command quota instead of leaking across refreshes", async () => {
  const f = fixture(async () => response(page())), lease = open(f.workspace);
  for (let i = 0; i < 70; i++) {
    assert.equal((await f.workspace.nextPage(lease)).kind, "success");
    assert.equal(f.workspace.restartList(lease, f.workspace.getSnapshot()!.list), true);
  }
  assert.equal(f.counts().calls, 70);
  for (let i = 0; i < 64; i++) prepare(f.workspace, lease);
  assert.deepEqual(f.workspace.prepare(lease, get()), { kind: "capacity" }); f.workspace.dispose();
});

test("preview busy repeat neither dispatches nor cancels its original loading snapshot", async () => {
  const hold = gate<Response>(), sample = previewSample(), f = fixture(async () => hold.promise), lease = open(f.workspace);
  const command = prepare(f.workspace, lease, sample.request), pending = f.workspace.execute(lease, command);
  const loading = f.workspace.getSnapshot(); assert.deepEqual(await f.workspace.execute(lease, command), { kind: "busy" });
  assert.equal(f.workspace.getSnapshot(), loading); assert.equal(f.counts().calls, 1);
  hold.resolve(response(sample.value)); assert.equal((await pending).kind, "success"); f.workspace.dispose();
});
