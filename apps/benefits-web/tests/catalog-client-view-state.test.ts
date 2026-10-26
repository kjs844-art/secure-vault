import assert from "node:assert/strict";
import { test } from "node:test";
import { createCatalogClient, type CatalogViewContext } from "../src/domain/catalog-client/client.ts";
import { createCatalogCreateRequest, createCatalogGetRequest } from "../src/domain/catalog-client/requests.ts";
import { CATALOG_VIEW_SCHEMA } from "../src/domain/catalog-client/responses.ts";
import { createCatalogViewState, MAX_CATALOG_VIEW_ENTRIES, reduceCatalogViewState,
  type CatalogViewState, type CatalogViewEvent } from "../src/domain/catalog-client/view-state.ts";

// Synthetic values and injected transport only. No account, provider, persistent
// storage, auth adapter or operational HTTP route is enabled by this suite.
const SCOPE = "synthetic-view-a-first";
const CONTEXT = Object.freeze({ viewScope: SCOPE, dataGeneration: 1 });
function row(serviceId = "svc-1", serviceRevision = 1, state: "live" | "deleted" = "live", dataGeneration = 1) {
  return { schema: CATALOG_VIEW_SCHEMA, dataGeneration, serviceId, serviceRevision, state,
    profile: state === "deleted" ? null : { name: "Synthetic service", provider: null, planName: null,
      accountLabel: null, timezone: "Asia/Seoul", subscriptionStatus: "unknown", trialEndsAt: null, notes: null },
    // Revision-one create fixtures must retain the strict transport invariant.
    createdAt: 1, updatedAt: serviceRevision, provenance: "user-reported", accountProof: "not-established" };
}
function result(success: unknown, capturedScope: unknown = CONTEXT) { return { kind: "success", capturedScope, success }; }
function apply(state: CatalogViewState, success: unknown,
  capturedScope: unknown = { viewScope: state.viewScope, dataGeneration: state.dataGeneration }) {
  return reduceCatalogViewState(state, { type: "response", result: result(success, capturedScope) });
}
function view(service = row()) { return { kind: "view", view: service }; }
function receipt(service = row(), replayed = false) {
  return { kind: "receipt", receipt: { operationId: "synthetic-operation", replayed, service } };
}
function page(services = [row()], catalogRevision = 1, dataGeneration = 1) {
  return { kind: "page", page: { schema: CATALOG_VIEW_SCHEMA, dataGeneration, catalogRevision, services, nextCursor: null } };
}
function response(value: unknown) {
  return new Response(JSON.stringify({ ok: true, value }), {
    status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

test("view state validates scope and generation and starts empty and frozen", () => {
  const state = createCatalogViewState(SCOPE, 1);
  assert.deepEqual(state, { ...CONTEXT, entries: [], catalogRevision: null, refreshRequired: false });
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.entries));
  for (const bad of ["", "bad scope", " scope", "x".repeat(129), null, "x\n"]) {
    assert.throws(() => createCatalogViewState(bad as string, 1), /CATALOG_VIEW_STATE_INVALID/);
  }
  for (const bad of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createCatalogViewState(SCOPE, bad), /CATALOG_VIEW_STATE_INVALID/);
  }
});

test("completed actual client result cannot be applied after account switch", async () => {
  let context: CatalogViewContext | null = CONTEXT;
  const client = createCatalogClient({ origin: "https://synthetic.local", readViewContext: () => context,
    fetch: async () => response(row()) });
  const completed = await client(createCatalogGetRequest("svc-1"));
  assert.equal(completed.kind, "success");
  const event: CatalogViewEvent = { type: "response", result: completed };
  let state = createCatalogViewState(SCOPE, 1);
  assert.equal(reduceCatalogViewState(state, event).entries.length, 1);
  context = { viewScope: "synthetic-view-b-first", dataGeneration: 1 };
  state = reduceCatalogViewState(state, { type: "reset", ...context });
  assert.equal(reduceCatalogViewState(state, event), state);
});

test("A to B to new A rejects a completed old A result even with identical generation", async () => {
  let context: CatalogViewContext = CONTEXT;
  const client = createCatalogClient({ origin: "https://synthetic.local", readViewContext: () => context,
    fetch: async () => response(row()) });
  const oldA = await client(createCatalogGetRequest("svc-1"));
  assert.equal(oldA.kind, "success");
  let state = createCatalogViewState(SCOPE, 1);
  context = { viewScope: "synthetic-view-b-first", dataGeneration: 1 };
  state = reduceCatalogViewState(state, { type: "reset", ...context });
  context = { viewScope: "synthetic-view-a-second", dataGeneration: 1 };
  state = reduceCatalogViewState(state, { type: "reset", ...context });
  assert.equal(reduceCatalogViewState(state, { type: "response", result: oldA }), state);
  const freshA = await client(createCatalogGetRequest("svc-1"));
  assert.equal(freshA.kind, "success");
  assert.equal(reduceCatalogViewState(state, { type: "response", result: freshA }).entries.length, 1);
});

test("actual non-replayed create result preserves revision-one timestamp invariant", async () => {
  const service = row();
  const request = createCatalogCreateRequest("synthetic-operation", service.profile!);
  const client = createCatalogClient({ origin: "https://synthetic.local", readViewContext: () => CONTEXT,
    fetch: async () => response(receipt(service).receipt) });
  const completed = await client(request);
  assert.equal(completed.kind, "success");
  const state = reduceCatalogViewState(createCatalogViewState(SCOPE, 1), { type: "response", result: completed });
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0]!.createdAt, state.entries[0]!.updatedAt);
  assert.equal(state.refreshRequired, true);
});

test("captured scope AND generation are checked before touching success payload", () => {
  const state = createCatalogViewState(SCOPE, 1);
  let reads = 0;
  const payload = new Proxy({}, { getPrototypeOf() { reads++; throw new Error("must-not-inspect"); } });
  for (const capturedScope of [null, SCOPE, { ...CONTEXT, viewScope: "other-view" },
    { ...CONTEXT, dataGeneration: 2 }, { ...CONTEXT, dataGeneration: 0 }]) {
    assert.equal(apply(state, payload, capturedScope), state);
    const withGetter = { kind: "success", capturedScope,
      get success() { reads++; throw new Error("must-not-read"); } };
    assert.equal(reduceCatalogViewState(state, { type: "response", result: withGetter }), state);
  }
  assert.equal(reads, 0);
});

test("captured context must be exact plain data, not inherited, extra, hidden or accessor properties", () => {
  const state = createCatalogViewState(SCOPE, 1);
  let calls = 0;
  const contexts: unknown[] = [{ ...CONTEXT, extra: true }, Object.create(CONTEXT), [],
    { ...CONTEXT, [Symbol("extra")]: true }];
  for (const key of ["viewScope", "dataGeneration"]) {
    const accessor = { ...CONTEXT };
    Object.defineProperty(accessor, key, { enumerable: true, get: () => { calls++; return CONTEXT; } });
    contexts.push(accessor);
    const hidden = { ...CONTEXT };
    Object.defineProperty(hidden, key, { enumerable: false });
    contexts.push(hidden);
  }
  for (const context of contexts) assert.equal(apply(state, view(), context), state);
  assert.equal(calls, 0);
});

test("payload generation mismatch rejects get, receipts and empty or nonempty lists", () => {
  const state = apply(createCatalogViewState(SCOPE, 1), view());
  for (const success of [view(row("svc-2", 1, "live", 2)), receipt(row("svc-2", 1, "live", 2)),
    page([], 9, 2), page([row("svc-2", 1, "live", 2)], 9, 2)]) {
    assert.equal(apply(state, success), state);
  }
});

test("malformed event/result/success data preserves exact state without executing getters", () => {
  const state = createCatalogViewState(SCOPE, 1);
  let calls = 0;
  const getter = () => { calls++; return "success"; };
  const valid = { type: "response", result: result(view()) };
  const malformed: unknown[] = [null, undefined, [], {}, { type: "other" },
    { ...valid, extra: true }, { ...valid, [Symbol("unexpected")]: true }, Object.create(valid),
    { type: "response", result: { ...result(view()), extra: true } },
    { type: "response", result: { ...result(view()), [Symbol("unexpected")]: true } },
    { type: "response", result: Object.create(result(view())) },
    { type: "response", result: result({ ...view(), extra: true }) },
    { type: "response", result: result({ kind: "unrecognized", view: row() }) },
    { type: "response", result: result(view({ ...row(), profile: null })) }];
  for (const [object, property] of [[{ ...valid }, "type"], [{ ...valid }, "result"],
    [{ ...result(view()) }, "kind"], [{ ...result(view()) }, "capturedScope"],
    [{ ...result(view()) }, "success"]] as const) {
    Object.defineProperty(object, property, { enumerable: true, get: getter });
    malformed.push(property === "type" || property === "result" ? object : { type: "response", result: object });
  }
  for (const input of malformed) assert.equal(reduceCatalogViewState(state, input), state);
  const service = row();
  Object.defineProperty(service, "serviceRevision", { enumerable: true, get: getter });
  assert.equal(apply(state, view(service)), state);
  assert.equal(calls, 0);
});

test("higher per-ID revision wins; lower and equal revisions cannot change rows", () => {
  let state = apply(createCatalogViewState(SCOPE, 1), view(row("svc-1", 3)));
  for (const revision of [1, 2, 3]) {
    const incoming = row("svc-1", revision);
    incoming.profile!.name = "Delayed conflicting name";
    assert.equal(apply(state, view(incoming)), state);
  }
  state = apply(state, view(row("svc-1", 4)));
  assert.equal(state.entries[0]!.serviceRevision, 4);
  assert.equal(state.entries.length, 1);
});

test("deleted tombstone cannot be resurrected by get, receipt replay or page at any revision", () => {
  let state = apply(createCatalogViewState(SCOPE, 1), receipt(row("svc-1", 3, "deleted")));
  const tombstone = state.entries[0];
  for (const success of [view(row("svc-1", 1)), view(row("svc-1", 99)),
    receipt(row("svc-1", 99), true), page([row("svc-1", 99)], 9)]) {
    state = apply(state, success);
    assert.equal(state.entries[0], tombstone);
    assert.equal(state.entries[0]!.profile, null);
  }
  state = apply(state, view(row("svc-1", 4, "deleted")));
  assert.equal(state.entries[0]!.serviceRevision, 4);
  assert.equal(state.entries[0]!.state, "deleted");
});

test("receipts retain current rows but not operation metadata, replay history or pagination cursor", () => {
  let state = apply(createCatalogViewState(SCOPE, 1), receipt());
  assert.equal(state.entries.length, 1);
  assert.equal(state.refreshRequired, true);
  state = apply(state, receipt(row("svc-1", 4, "deleted"), true));
  assert.equal(state.entries[0]!.state, "deleted");
  assert.ok(!JSON.stringify(state).includes("synthetic-operation"));
  assert.ok(!Object.hasOwn(state, "nextCursor"));
  assert.ok(!Object.hasOwn(state, "replayed"));
});

test("partial and empty pages never convert missing entries into deletions", () => {
  let state = apply(createCatalogViewState(SCOPE, 1), page([row("svc-1"), row("svc-2")], 7));
  state = apply(state, page([row("svc-3")], 7));
  assert.equal(state.entries.length, 3);
  const priorEntries = state.entries;
  state = apply(state, page([], 8));
  assert.equal(state.entries, priorEntries);
  assert.equal(state.catalogRevision, 8);
  assert.equal(state.refreshRequired, false);
  assert.ok(state.entries.every((entry) => entry.state === "live"));
});

test("older pages are rejected atomically and request sticky explicit refresh", () => {
  const state = apply(createCatalogViewState(SCOPE, 1), page([row("svc-1", 2)], 9));
  const rejected = apply(state, page([row("svc-1", 99), row("svc-2")], 8));
  assert.equal(rejected.entries, state.entries);
  assert.equal(rejected.catalogRevision, 9);
  assert.equal(rejected.refreshRequired, true);
  const next = apply(rejected, page([row("svc-2")], 10));
  assert.equal(next.entries.length, 2);
  assert.equal(next.refreshRequired, true);
  assert.equal(apply(rejected, page([], 7)), rejected);
});

test("fresh or replayed receipt invalidates list freshness without inventing collection revision", () => {
  for (const replayed of [false, true]) {
    let state = apply(createCatalogViewState(SCOPE, 1), page([row()], 7));
    state = apply(state, receipt(row("svc-1", 2), replayed));
    assert.equal(state.catalogRevision, 7);
    assert.equal(state.refreshRequired, true);
    state = apply(state, page([row("svc-2")], 8));
    assert.equal(state.refreshRequired, true);
  }
});

function fill(count: number) {
  let state = createCatalogViewState(SCOPE, 1);
  for (let offset = 0; offset < count; offset += 50) {
    const rows = Array.from({ length: Math.min(50, count - offset) },
      (_, index) => row(`svc-${String(offset + index).padStart(4, "0")}`));
    state = apply(state, page(rows, 1));
  }
  return state;
}

test("capacity preflight preserves whole prior entries and revision instead of partial page application", () => {
  const state = fill(MAX_CATALOG_VIEW_ENTRIES - 1);
  assert.equal(state.entries.length, MAX_CATALOG_VIEW_ENTRIES - 1);
  const next = apply(state, page([row("svc-0000", 9), row("svc-9998"), row("svc-9999")], 2));
  assert.equal(next.entries, state.entries);
  assert.equal(next.catalogRevision, 1);
  assert.equal(next.entries[0]!.serviceRevision, 1);
  assert.equal(next.refreshRequired, true);
  const exact = apply(state, page([row("svc-0000", 9), row("svc-9999")], 2));
  assert.equal(exact.entries.length, MAX_CATALOG_VIEW_ENTRIES);
  assert.equal(exact.entries[0]!.serviceRevision, 9);
  assert.equal(exact.refreshRequired, false);
});

test("tombstones count toward cap, never evict; existing IDs can still advance when full", () => {
  let state = fill(MAX_CATALOG_VIEW_ENTRIES);
  state = apply(state, view(row("svc-0000", 2, "deleted")));
  const full = state;
  for (const incoming of [view(row("svc-new")), receipt(row("svc-new")), receipt(row("svc-new", 2, "deleted"))]) {
    const rejected = apply(full, incoming);
    assert.equal(rejected.entries, full.entries);
    assert.equal(rejected.catalogRevision, full.catalogRevision);
    assert.equal(rejected.refreshRequired, true);
  }
  state = apply(state, view(row("svc-0001", 2)));
  assert.equal(state.entries.length, MAX_CATALOG_VIEW_ENTRIES);
  assert.equal(state.entries[0]!.state, "deleted");
  assert.equal(state.entries[1]!.serviceRevision, 2);
});

test("one malformed page row prevents all replacements and revision advancement", () => {
  const state = apply(createCatalogViewState(SCOPE, 1), page([row()], 1));
  const invalid = row("svc-2");
  invalid.profile = null;
  assert.equal(apply(state, page([row("svc-1", 9), invalid], 2)), state);
});

test("duplicate, unordered, deleted and mixed-generation page rows are not partially merged", () => {
  const state = apply(createCatalogViewState(SCOPE, 1), page([row()], 1));
  for (const services of [[row("svc-1", 9), row("svc-1", 10)], [row("svc-2"), row("svc-1", 9)],
    [row("svc-1", 9), row("svc-2", 2, "deleted")], [row("svc-1", 9), row("svc-2", 1, "live", 2)]]) {
    assert.equal(apply(state, page(services, 2)), state);
  }
});

test("oversized/sparse page arrays reject before entry access and preserve state", () => {
  const state = createCatalogViewState(SCOPE, 1);
  let reads = 0;
  const oversized = Array.from({ length: 51 }, (_, index) => row(`svc-${index}`));
  Object.defineProperty(oversized, "0", { enumerable: true, get: () => { reads++; return row(); } });
  assert.equal(apply(state, page(oversized)), state);
  const sparse = new Array<ReturnType<typeof row>>(1);
  assert.equal(apply(state, page(sparse)), state);
  assert.equal(reads, 0);
});

test("page cursor invariants remain strict and cursor is not mistaken for full-list completion", () => {
  const state = createCatalogViewState(SCOPE, 1);
  const source = page([row()], 2);
  const cursor = { afterId: "svc-1", catalogRevision: 2, dataGeneration: 1 };
  for (const bad of [{ ...cursor, afterId: "svc-2" }, { ...cursor, catalogRevision: 3 },
    { ...cursor, dataGeneration: 2 }]) {
    assert.equal(apply(state, { kind: "page", page: { ...source.page, nextCursor: bad } }), state);
  }
  const valid = apply(state, { kind: "page", page: { ...source.page, nextCursor: cursor } });
  assert.equal(valid.entries.length, 1);
  assert.ok(!Object.hasOwn(valid, "nextCursor"));
});

test("stored rows and profiles are detached/frozen with null and user-reported provenance preserved", () => {
  const source = row();
  const state = apply(createCatalogViewState(SCOPE, 1), view(source));
  source.profile!.name = "Changed outside";
  source.serviceRevision = 99;
  const stored = state.entries[0]!;
  assert.equal(stored.profile!.name, "Synthetic service");
  assert.equal(stored.serviceRevision, 1);
  assert.equal(stored.profile!.notes, null);
  assert.equal(stored.provenance, "user-reported");
  assert.equal(stored.accountProof, "not-established");
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.entries) && Object.isFrozen(stored) && Object.isFrozen(stored.profile));
});

test("failure variants preserve rows, tombstones, page revision and refresh flag exactly", () => {
  const state = apply(apply(createCatalogViewState(SCOPE, 1), page([row()], 3)), receipt(row("svc-2", 2, "deleted")));
  const failures = [{ kind: "timeout" }, { kind: "aborted" }, { kind: "stale" },
    ...["REQUEST", "STATUS", "BODY", "ENVELOPE", "HEADERS"].map((reason) => ({ kind: "invalid", reason })),
    ...["API_NOT_FOUND", "API_METHOD_NOT_ALLOWED", "API_REQUEST_REJECTED", "API_MEDIA_TYPE", "API_BODY_TOO_LARGE",
      "API_INPUT_INVALID", "API_AUTH_REQUIRED", "API_SESSION_CHANGED", "API_CONFLICT", "API_UNAVAILABLE",
      "API_TIMEOUT", "API_ABORTED"].map((code) => ({ kind: "error", code, retriableAfterMs: null })),
    { kind: "error", code: "API_RATE_LIMITED", retriableAfterMs: 1000 }];
  for (const failure of failures) assert.equal(reduceCatalogViewState(state, { type: "response", result: failure }), state);
});

test("failure payloads and unknown result details are never inspected or displayed", () => {
  const state = apply(createCatalogViewState(SCOPE, 1), view());
  let reads = 0;
  for (const kind of ["error", "timeout", "invalid", "unexpected"]) {
    const failure = { kind, get code() { reads++; throw new Error("must-not-read"); },
      get success() { reads++; throw new Error("must-not-read"); } };
    assert.equal(reduceCatalogViewState(state, { type: "response", result: failure }), state);
  }
  assert.equal(reads, 0);
});

test("only fresh-scope reset clears observations, tombstones, revision and sticky refresh", () => {
  const state = apply(apply(createCatalogViewState(SCOPE, 1), page([row()], 3)), receipt(row("svc-2", 2, "deleted")));
  for (const dataGeneration of [1, 2]) {
    assert.equal(reduceCatalogViewState(state, { type: "reset", viewScope: SCOPE, dataGeneration }), state);
  }
  const next = reduceCatalogViewState(state, { type: "reset", viewScope: "synthetic-new-view", dataGeneration: 2 });
  assert.deepEqual(next, createCatalogViewState("synthetic-new-view", 2));
  assert.equal(apply(next, view(row("svc-3", 1, "live", 2)), CONTEXT), next);
  assert.equal(apply(next, view(row("svc-3", 1, "live", 2))).entries.length, 1);
  for (const bad of [{ type: "reset", viewScope: "synthetic-new-view", dataGeneration: 0 },
    { type: "reset", viewScope: "synthetic-new-view", dataGeneration: 1, entries: [] }]) {
    assert.equal(reduceCatalogViewState(state, bad), state);
  }
});

test("malformed reset never clears existing rows or evaluates field accessors", () => {
  const state = apply(createCatalogViewState(SCOPE, 1), receipt(row("svc-1", 2, "deleted")));
  let reads = 0;
  const validReset = { type: "reset", viewScope: "synthetic-reset-next", dataGeneration: 2 };
  const invalidResets: unknown[] = [Object.create(validReset),
    { ...validReset, viewScope: "next\n" }, { ...validReset, dataGeneration: NaN },
    { ...validReset, dataGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...validReset, [Symbol("extra")]: true }];
  for (const field of ["type", "viewScope", "dataGeneration"]) {
    const getter = { ...validReset };
    Object.defineProperty(getter, field, { enumerable: true, get: () => { reads++; return 2; } });
    invalidResets.push(getter);
    const hidden = { ...validReset };
    Object.defineProperty(hidden, field, { enumerable: false });
    invalidResets.push(hidden);
  }
  for (const reset of invalidResets) assert.equal(reduceCatalogViewState(state, reset), state);
  assert.equal(reads, 0);
  assert.equal(state.entries[0]!.state, "deleted");
  assert.equal(state.refreshRequired, true);
});

test("null-prototype plain input records are accepted without retaining mutable source context", () => {
  const context: Record<string, unknown> = Object.assign(Object.create(null) as Record<string, unknown>, CONTEXT);
  const event = Object.assign(Object.create(null) as Record<string, unknown>, {
    type: "response", result: result(view(), context),
  });
  const state = reduceCatalogViewState(createCatalogViewState(SCOPE, 1), event);
  context.viewScope = "mutated-external-context";
  context.dataGeneration = 99;
  assert.equal(state.entries.length, 1);
  assert.equal(state.viewScope, SCOPE);
  assert.equal(state.dataGeneration, 1);
});
