import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewService } from "../src/server/review/review-service.ts";
import { projectReviewedBenefit, projectReviewReceipt } from "../src/server/review/presentation.ts";
import { createReviewedBenefitViewState, reduceReviewedBenefitView } from "../src/domain/reviewed-benefit-view.ts";
import { REVIEW_SCHEMA, type ReviewErrorCode, type ReviewedBenefitRow,
  type ReviewResult, type ReviewTransaction, type ReviewValues } from "../src/server/review/contracts.ts";
import { REVIEW_NOW, REVIEW_OWNER, SERVICE_ID, SYNTHETIC_PRIVATE,
  benefitCollectionRevisionKey, candidateRow, createReviewMemoryStore,
  reviewAuthority, reviewValues } from "./support/review-memory-store.ts";

// Synthetic in-memory server contract only. No real auth, HTTP, provider, DB,
// browser pagination, durable transaction isolation or perpetual freshness claim.
function success<T>(result: ReviewResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}
function failure(result: ReviewResult<unknown>, code: ReviewErrorCode): void {
  assert.deepEqual(result, { ok: false, code });
  assert.ok(Object.isFrozen(result));
  assert.equal(JSON.stringify(result).includes(SYNTHETIC_PRIVATE), false);
}
function frozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozenTree(child);
}
function fixture() {
  const store = createReviewMemoryStore();
  const ids: string[] = [];
  let allocated = 0;
  const service = createReviewService({ ...store.dependencies, newId: () => {
    allocated++;
    assert.ok(ids.length, "only explicit fixture writes may allocate IDs");
    return ids.shift()!;
  } });
  return { store, service, ids, get allocated() { return allocated; } };
}
type Fixture = ReturnType<typeof fixture>;
async function add(f: Fixture, id: string, values: ReviewValues = reviewValues()) {
  const candidateId = `candidate-${id}`;
  f.store.rows.candidates.set(candidateId, candidateRow({ id: candidateId }));
  f.ids.push(`preview-${id}`, id);
  const preview = success(await f.service.preview({ candidateId, candidateRevision: 1,
    serviceId: SERVICE_ID, serviceRevision: 1, values }));
  const confirm = { previewId: preview.id, operationId: `confirm-${id}`, decision: "confirm" };
  const saved = success(await f.service.confirm(confirm));
  const remove = { benefitId: id, expectedRevision: saved.benefitRevision,
    operationId: `remove-${id}`, decision: "delete" };
  return { preview, confirm, saved, remove };
}
async function seeded(ids: readonly string[] = ["A", "B", "C"]) {
  const f = fixture();
  for (const id of ids) await add(f, id);
  return f;
}
function withPorts(f: Fixture, ports: Partial<ReviewTransaction>) {
  return createReviewService({ ...f.store.dependencies,
    newId: () => { throw new Error("list must not allocate IDs"); },
    transaction: (authority, action) => f.store.dependencies.transaction(authority,
      (tx) => action({ ...tx, ...ports })) });
}
const request = (limit = 2) => ({ limit, cursor: null });
const cursor = (afterId = "A", benefitCollectionRevision = 4, dataGeneration = 1) =>
  ({ afterId, benefitCollectionRevision, dataGeneration });
const revisionKey = benefitCollectionRevisionKey(REVIEW_OWNER, 1);

test("empty list has initial collection revision, exact shape, and a frozen empty final page", async () => {
  const f = fixture();
  const before = f.store.snapshot();
  const result = await f.service.list(request());
  assert.deepEqual(success(result), { schema: REVIEW_SCHEMA, dataGeneration: 1,
    benefitCollectionRevision: 1, benefits: [], nextCursor: null });
  frozenTree(result);
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(f.allocated, 0);
});

test("ASCII ordering, limit+1 lookahead and cursor after last returned row yield every record once", async () => {
  const f = await seeded(["z", "a0", "A", "a-", "Z", "a"]);
  const calls: Array<[string | null, number]> = [];
  const service = createReviewService({ ...f.store.dependencies,
    transaction: (authority, action) => f.store.dependencies.transaction(authority, (tx) => action({ ...tx,
      listReviewedBenefits: (after, take) => { calls.push([after, take]); return tx.listReviewedBenefits(after, take); },
    })) });
  const first = success(await service.list(request()));
  assert.deepEqual(first.benefits.map((row) => row.benefitId), ["A", "Z"]);
  assert.deepEqual(first.nextCursor, cursor("Z", 7));
  const second = success(await service.list({ limit: 2, cursor: first.nextCursor }));
  assert.deepEqual(second.benefits.map((row) => row.benefitId), ["a", "a-"]);
  assert.deepEqual(second.nextCursor, cursor("a-", 7));
  const last = success(await service.list({ limit: 2, cursor: second.nextCursor }));
  assert.deepEqual(last.benefits.map((row) => row.benefitId), ["a0", "z"]);
  assert.equal(last.nextCursor, null, "a full page without lookahead is final");
  assert.deepEqual(calls, [[null, 3], ["Z", 3], ["a-", 3]]);
  frozenTree(first); frozenTree(second); frozenTree(last);
});

test("limits 1 and 50 are supported without returning lookahead or scanning a second page", async () => {
  const f = await seeded(Array.from({ length: 51 }, (_, i) => `id-${String(i).padStart(2, "0")}`));
  const one = success(await f.service.list(request(1)));
  assert.equal(one.benefits.length, 1);
  assert.equal(one.nextCursor?.afterId, "id-00");
  const fifty = success(await f.service.list(request(50)));
  assert.equal(fifty.benefits.length, 50);
  assert.equal(fifty.nextCursor?.afterId, "id-49");
  const last = success(await f.service.list({ limit: 50, cursor: fifty.nextCursor }));
  assert.deepEqual(last.benefits.map((row) => row.benefitId), ["id-50"]);
  assert.equal(last.nextCursor, null);
  assert.deepEqual(success(await f.service.list({ limit: 1, cursor: cursor("zzzz", 52) })).benefits, []);
});

test("past observations, unknown values and corrected zero retain provenance after candidate expiry", async () => {
  const f = fixture();
  await add(f, "A", reviewValues({ remainingAmount: 0, expiresAt: "2020-02-29",
    observedAt: "2026-09-27T12:34:56.123456789+09:00" }));
  f.store.controls.now = REVIEW_NOW + 86400000;
  f.store.controls.authority = reviewAuthority({ sessionId: "next-day", sessionRevision: 2,
    expiresAt: f.store.controls.now + 60000 });
  const before = f.store.snapshot();
  const page = success(await f.service.list(request()));
  const item = page.benefits[0]!;
  assert.equal(item.outcome, "saved");
  assert.equal(item.content!.values.remainingAmount, 0);
  assert.equal(item.content!.source.values.remainingAmount, null);
  assert.equal(item.content!.values.expiresAt, "2020-02-29");
  assert.equal(item.content!.values.observedAt, "2026-09-27T12:34:56.123456789+09:00");
  assert.equal(item.content!.valueOrigins.remainingAmount, "user-corrected");
  assert.equal(item.content!.accountProof, "not-established");
  assert.equal(item.content!.currentBalanceProof, "not-established");
  assert.deepEqual(f.store.snapshot(), before);
});

for (const [label, input] of [
  ["null", null], ["array", []], ["missing", {}], ["no cursor", { limit: 2 }],
  ["undefined cursor", { limit: 2, cursor: undefined }], ["zero", request(0)],
  ["negative", request(-1)], ["fraction", request(1.5)], ["large", request(51)],
  ["NaN", request(NaN)], ["infinity", request(Infinity)], ["string", { limit: "2", cursor: null }],
  ["extra owner", { ...request(), ownerId: REVIEW_OWNER }],
  ["extra decision", { ...request(), decision: "confirm" }],
  ["cursor array", { limit: 2, cursor: [] }], ["cursor missing", { limit: 2, cursor: {} }],
  ["bad ID", { limit: 2, cursor: cursor(" bad") }], ["Unicode ID", { limit: 2, cursor: cursor("한글") }],
  ["empty ID", { limit: 2, cursor: cursor("") }], ["long ID", { limit: 2, cursor: cursor("a".repeat(129)) }],
  ["bad revision", { limit: 2, cursor: cursor("A", 0) }],
  ["unsafe revision", { limit: 2, cursor: cursor("A", Number.MAX_SAFE_INTEGER + 1) }],
  ["fraction generation", { limit: 2, cursor: cursor("A", 1, 1.5) }],
  ["extra cursor key", { limit: 2, cursor: { ...cursor(), ownerId: REVIEW_OWNER } }],
] as const) test(`list rejects ${label} input before authority or transaction`, async () => {
  const f = fixture();
  failure(await f.service.list(input), "REVIEW_INPUT_INVALID");
  assert.equal(f.store.controls.authorityReads, 0);
  assert.equal(f.store.controls.transactions, 0);
});

test("ordinary input/cursor accessors, hidden/symbol fields, prototypes and toJSON are not invoked", async () => {
  let callbacks = 0;
  const get = () => { callbacks++; return 2; };
  const badLimit = { cursor: null, get limit() { return get(); } };
  const badCursor = { limit: 2, cursor: { ...cursor(), get afterId() { get(); return "A"; } } };
  const hidden = Object.defineProperty(request(), "hidden", { value: true });
  const symbol = { ...request(), [Symbol("extra")]: true };
  const inherited = Object.assign(Object.create({ extra: true }), request());
  const json = { ...request(), toJSON() { callbacks++; return request(); } };
  for (const input of [badLimit, badCursor, hidden, symbol, inherited, json]) {
    const f = fixture();
    failure(await f.service.list(input), "REVIEW_INPUT_INVALID");
    assert.equal(f.store.controls.authorityReads, 0);
  }
  assert.equal(callbacks, 0);
});

test("plain, null-prototype and frozen input snapshots are accepted and detached before authority awaits", async () => {
  const f = await seeded();
  const first = success(await f.service.list(Object.freeze(request(1))));
  const mutableCursor = { ...first.nextCursor! };
  const mutable = Object.assign(Object.create(null), { limit: 1, cursor: mutableCursor });
  f.store.controls.readAuthority = () => {
    mutable.limit = 50; mutable.cursor = null;
    mutableCursor.afterId = "C"; mutableCursor.dataGeneration = 99;
    return reviewAuthority();
  };
  const next = success(await f.service.list(mutable));
  assert.deepEqual(next.benefits.map((row) => row.benefitId), ["B"]);
  assert.deepEqual(next.nextCursor, cursor("B"));
  delete f.store.controls.readAuthority;
  const nullCursor = Object.assign(Object.create(null), cursor("B"));
  assert.deepEqual(success(await f.service.list({ limit: 2, cursor: Object.freeze(nullCursor) }))
    .benefits.map((row) => row.benefitId), ["C"]);
});

for (const [label, authority] of [
  ["owner", reviewAuthority({ ownerId: "other-owner" })],
  ["generation", reviewAuthority({ dataGeneration: 2 })],
] as const) test(`valid ${label} scope sees no previous-scope rows or collection revision`, async () => {
  const f = await seeded();
  const before = f.store.snapshot();
  f.store.controls.authority = authority;
  const page = success(await f.service.list(request()));
  assert.deepEqual(page.benefits, []);
  assert.equal(page.benefitCollectionRevision, 1);
  assert.equal(page.dataGeneration, authority.dataGeneration);
  assert.deepEqual(f.store.snapshot(), before);
});

for (const changed of [cursor("A", 3), cursor("A", 5), cursor("A", 4, 2)]) {
  test(`stale cursor ${JSON.stringify(changed)} conflicts before the list port`, async () => {
    const f = await seeded();
    f.store.controls.trace.length = 0;
    const before = f.store.snapshot();
    failure(await f.service.list({ limit: 2, cursor: changed }), "REVIEW_CONFLICT");
    assert.equal(f.store.controls.trace.includes("listReviewedBenefits"), false);
    assert.deepEqual(f.store.snapshot(), before);
  });
}

test("confirm/delete advance collection exactly once; replay and preview/reject do not; old cursors conflict", async () => {
  const f = fixture();
  const a = await add(f, "A");
  const b = await add(f, "B");
  const before = success(await f.service.list(request(1)));
  assert.equal(before.benefitCollectionRevision, 3);
  const savedReplay = success(await f.service.confirm(a.confirm));
  assert.equal(savedReplay.replayed, true);
  assert.equal(success(await f.service.list(request())).benefitCollectionRevision, 3);
  f.ids.push("unused-preview");
  f.store.rows.candidates.set("unused-candidate", candidateRow({ id: "unused-candidate" }));
  const preview = success(await f.service.preview({ candidateId: "unused-candidate", candidateRevision: 1,
    serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues() }));
  success(await f.service.reject({ previewId: preview.id, expectedRevision: 1, decision: "reject" }));
  assert.equal(success(await f.service.list(request())).benefitCollectionRevision, 3);
  await add(f, "C");
  failure(await f.service.list({ limit: 1, cursor: before.nextCursor }), "REVIEW_CONFLICT");
  const afterInsert = success(await f.service.list(request(1)));
  assert.equal(afterInsert.benefitCollectionRevision, 4);
  const deleted = success(await f.service.remove(b.remove));
  assert.equal(deleted.outcome, "deleted");
  failure(await f.service.list({ limit: 1, cursor: afterInsert.nextCursor }), "REVIEW_CONFLICT");
  const afterDelete = success(await f.service.list(request(50)));
  assert.equal(afterDelete.benefitCollectionRevision, 5);
  assert.deepEqual(afterDelete.benefits.map((row) => row.benefitId), ["A", "C"]);
  assert.equal(success(await f.service.remove(b.remove)).replayed, true);
  assert.equal(success(await f.service.confirm(b.confirm)).outcome, "deleted");
  assert.equal(success(await f.service.list(request())).benefitCollectionRevision, 5);
});

test("delayed old page remains an observation, never reviving a later observed deletion tombstone", async () => {
  const f = fixture();
  const a = await add(f, "A");
  const oldPage = success(await f.service.list(request()));
  const deleted = projectReviewReceipt(success(await f.service.remove(a.remove)));
  let state = createReviewedBenefitViewState("list-consumer-scope", 1);
  const capturedScope = state.viewScope;
  state = reduceReviewedBenefitView(state, { type: "response", capturedScope, payload: deleted });
  const delayed = projectReviewedBenefit(oldPage.benefits[0]!);
  assert.equal(delayed.outcome, "saved", "an old transaction snapshot is not retroactively modified");
  assert.equal(reduceReviewedBenefitView(state, { type: "response", capturedScope, payload: delayed }), state);
  assert.equal(state.entries[0]!.outcome, "deleted");
  assert.deepEqual(success(await f.service.list(request())).benefits, []);
});

test("serialized overlapping identical confirmations and deletions advance the collection only once each", async () => {
  const f = fixture();
  f.store.rows.candidates.set("candidate-A", candidateRow({ id: "candidate-A" }));
  f.ids.push("preview-A", "A");
  const p = success(await f.service.preview({ candidateId: "candidate-A", candidateRevision: 1,
    serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues() }));
  const confirm = { previewId: p.id, operationId: "confirm-A", decision: "confirm" };
  const receipts = (await Promise.all([f.service.confirm(confirm), f.service.confirm(confirm)])).map(success);
  assert.deepEqual(receipts.map((receipt) => receipt.replayed).sort(), [false, true]);
  assert.equal(f.store.rows.benefits.size, 1);
  assert.equal(f.store.rows.operations.size, 1);
  assert.equal(success(await f.service.list(request())).benefitCollectionRevision, 2);
  const remove = { benefitId: "A", expectedRevision: 1, operationId: "remove-A", decision: "delete" };
  const removed = (await Promise.all([f.service.remove(remove), f.service.remove(remove)])).map(success);
  assert.deepEqual(removed.map((receipt) => receipt.replayed).sort(), [false, true]);
  const empty = success(await f.service.list(request()));
  assert.equal(empty.benefitCollectionRevision, 3);
  assert.deepEqual(empty.benefits, []);
  assert.equal(f.store.rows.operations.size, 2);
});

for (const revision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid adapter collection revision ${String(revision)} is store-unavailable without row reads`, async () => {
    const f = await seeded(["A"]);
    let calls = 0;
    const service = withPorts(f, { getBenefitCollectionRevision: async () => revision,
      listReviewedBenefits: async () => { calls++; return []; } });
    failure(await service.list(request()), "REVIEW_STORE_UNAVAILABLE");
    assert.equal(calls, 0);
  });
}

for (const operation of ["confirm", "remove"] as const) {
  test(`${operation} refuses collection revision overflow atomically; MAX is still readable`, async () => {
    const f = fixture();
    const a = await add(f, "A");
    f.ids.push("preview-B", "B");
    f.store.rows.candidates.set("candidate-B", candidateRow({ id: "candidate-B" }));
    const p = success(await f.service.preview({ candidateId: "candidate-B", candidateRevision: 1,
      serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues() }));
    f.store.rows.benefitsRevisions.set(revisionKey, Number.MAX_SAFE_INTEGER);
    assert.equal(success(await f.service.list(request())).benefitCollectionRevision, Number.MAX_SAFE_INTEGER);
    const before = f.store.snapshot();
    const allocated = f.allocated;
    const result = operation === "confirm"
      ? await f.service.confirm({ previewId: p.id, operationId: "confirm-B", decision: "confirm" })
      : await f.service.remove(a.remove);
    failure(result, "REVIEW_CONFLICT");
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(f.allocated, allocated);
    assert.equal(success(await f.service.confirm(a.confirm)).replayed, true, "replay need not advance MAX");
  });
}

for (const [label, patch] of [
  ["foreign owner", { ownerId: "foreign-owner" }], ["foreign generation", { dataGeneration: 2 }],
  ["bad ID", { id: "한글" }], ["bad revision", { revision: 0 }], ["bad state", { state: "pending" }],
  ["missing content", { content: null }], ["bad deletion date", { deletedAt: "2026-01-01" }],
  ["deleted row", { state: "deleted", content: null, deletedAt: new Date(REVIEW_NOW).toISOString() }],
] as const) test(`malformed adapter ${label} fails the entire page including lookahead`, async () => {
  const f = await seeded(["A", "B"]);
  const a = f.store.rows.benefits.get("A")!;
  const b = { ...f.store.rows.benefits.get("B")!, ...patch } as ReviewedBenefitRow;
  const service = withPorts(f, { listReviewedBenefits: async () => [a, b] });
  failure(await service.list(request(1)), "REVIEW_STORE_UNAVAILABLE");
});

test("invalid lookahead content/proof/origins is validated before any otherwise valid first page is returned", async () => {
  const f = await seeded(["A", "B"]);
  const a = f.store.rows.benefits.get("A")!;
  const b = f.store.rows.benefits.get("B")!;
  for (const content of [{ ...b.content!, accountProof: "established" },
    { ...b.content!, candidateId: "different-candidate" },
    { ...b.content!, values: { ...b.content!.values, remainingAmount: -1 } },
    { ...b.content!, valueOrigins: { ...b.content!.valueOrigins, remainingAmount: "user-corrected" } }]) {
    const service = withPorts(f, { listReviewedBenefits: async () => [a, { ...b, content } as ReviewedBenefitRow] });
    failure(await service.list(request(1)), "REVIEW_STORE_UNAVAILABLE");
  }
});

test("nonascending/duplicate/overlong results or rows not strictly after cursor are store-unavailable", async () => {
  const f = await seeded();
  const a = f.store.rows.benefits.get("A")!;
  const b = f.store.rows.benefits.get("B")!;
  const c = f.store.rows.benefits.get("C")!;
  for (const rows of [[b, a], [a, a], [a, b, c]]) {
    failure(await withPorts(f, { listReviewedBenefits: async () => rows }).list(request(1)), "REVIEW_STORE_UNAVAILABLE");
  }
  failure(await withPorts(f, { listReviewedBenefits: async () => [a] })
    .list({ limit: 1, cursor: cursor("A") }), "REVIEW_STORE_UNAVAILABLE");
});

test("adapter arrays reject sparse/getter/extra/iterator/prototype traps without invoking their callbacks", async () => {
  const f = await seeded(["A"]);
  const a = f.store.rows.benefits.get("A")!;
  let callbacks = 0;
  const sparse = new Array(1);
  const getter = Object.defineProperty([], "0", { enumerable: true, get() { callbacks++; return a; } });
  const hidden = Object.defineProperty([a], "0", { enumerable: false });
  const extra = Object.assign([a], { extra: true });
  const iterator = Object.assign([a], { [Symbol.iterator]() { callbacks++; return [a][Symbol.iterator](); } });
  const map = Object.assign([a], { map() { callbacks++; return [a]; } });
  const inherited = Object.setPrototypeOf([a], { [Symbol.iterator]() { callbacks++; return [a][Symbol.iterator](); } });
  const nullPrototype = Object.setPrototypeOf([a], null);
  const oversized = new Array(1000000);
  Object.defineProperty(oversized, "0", { get() { callbacks++; return a; } });
  for (const raw of [null, {}, sparse, getter, hidden, extra, iterator, map, inherited, nullPrototype, oversized]) {
    const service = withPorts(f, { listReviewedBenefits: async () => raw as readonly ReviewedBenefitRow[] });
    failure(await service.list(request(1)), "REVIEW_STORE_UNAVAILABLE");
  }
  assert.equal(callbacks, 0);
});

test("adapter exceptions are redacted; reflection traps are not claimed to be sandboxed", async () => {
  const f = await seeded(["A"]);
  for (const ports of [
    { getBenefitCollectionRevision: async () => { throw new Error(SYNTHETIC_PRIVATE); } },
    { listReviewedBenefits: async () => { throw new Error(SYNTHETIC_PRIVATE); } },
    { listReviewedBenefits: async () => new Proxy([], { getPrototypeOf() { throw new Error(SYNTHETIC_PRIVATE); } }) },
  ]) failure(await withPorts(f, ports).list(request()), "REVIEW_STORE_UNAVAILABLE");
});

test("authority read and transaction adapter exceptions are fixed errors with unchanged stored rows", async () => {
  const f = await seeded(["A"]);
  const before = f.store.snapshot();
  const denied = () => { throw new Error(SYNTHETIC_PRIVATE); };
  for (const patch of [{ readAuthority: denied }, { transaction: denied }]) {
    failure(await createReviewService({ ...f.store.dependencies, ...patch }).list(request()), "REVIEW_STORE_UNAVAILABLE");
    assert.deepEqual(f.store.snapshot(), before);
  }
});

test("list reads only its revision and bounded rows; immutable detached results never call write ports/newId", async () => {
  const f = await seeded(["A", "B"]);
  const before = f.store.snapshot();
  const raw = structuredClone(f.store.rows.benefits.get("A")!);
  const mutation = () => { throw new Error("list attempted another port"); };
  const service = withPorts(f, { insertPreview: mutation, insertBenefit: mutation,
    insertOperation: mutation, updateCandidate: mutation, updatePreview: mutation,
    updateBenefit: mutation, eraseCandidatePreviews: mutation, requireServiceVersion: mutation,
    advanceBenefitCollectionRevision: mutation, getCandidate: mutation, getService: mutation,
    getPreview: mutation, getBenefit: mutation, getOperation: mutation,
    listReviewedBenefits: async () => Object.freeze([raw]) });
  const result = await service.list(request());
  const page = success(result);
  const prior = structuredClone(page);
  (raw.content!.values as { name: string }).name = "Changed only in adapter fixture";
  assert.deepEqual(page, prior);
  frozenTree(result);
  assert.deepEqual(f.store.snapshot(), before);
  assert.deepEqual(Object.keys(page).sort(), ["schema", "dataGeneration", "benefitCollectionRevision", "benefits", "nextCursor"].sort());
});

for (const [label, authority] of [["missing", null], ["expired", reviewAuthority({ expiresAt: REVIEW_NOW })]] as const) {
  test(`list ${label} authority is denied before entering the transaction`, async () => {
    const f = fixture();
    f.store.controls.authority = authority;
    failure(await f.service.list(request()), "REVIEW_AUTH_REQUIRED");
    assert.equal(f.store.controls.transactions, 0);
  });
}

for (const boundary of ["after revision", "after rows", "after commit"] as const) {
  test(`list authority revocation ${boundary} suppresses output without mutating rows`, async () => {
    const f = await seeded(["A"]);
    const before = f.store.snapshot();
    const revoke = () => { f.store.controls.authority = reviewAuthority({ sessionRevision: 2 }); };
    if (boundary === "after commit") f.store.controls.afterCommit = revoke;
    else f.store.controls.afterMethod = (method) => {
      if (method === (boundary === "after rows" ? "listReviewedBenefits" : "getBenefitCollectionRevision")) revoke();
    };
    failure(await f.service.list(request()), "REVIEW_AUTHORITY_CHANGED");
    assert.deepEqual(f.store.snapshot(), before);
  });
}

for (const [label, finalTime, expected] of [
  ["exact expiry", REVIEW_NOW + 600000, "REVIEW_AUTHORITY_CHANGED"],
  ["one before expiry", REVIEW_NOW + 599999, null],
  ["backward clock", REVIEW_NOW - 1, "REVIEW_AUTHORITY_CHANGED"],
] as const) test(`list final clock ${label} is checked after the last authority guard`, async () => {
  const f = await seeded(["A"]);
  const before = f.store.snapshot();
  let afterCommit = false;
  let finalSamples = 0;
  f.store.controls.afterCommit = () => { afterCommit = true; };
  const service = createReviewService({ ...f.store.dependencies, now: () =>
    !afterCommit || ++finalSamples === 1 ? REVIEW_NOW : finalTime });
  const result = await service.list(request());
  if (expected) failure(result, expected);
  else assert.equal(success(result).benefits.length, 1);
  assert.equal(finalSamples, 2);
  assert.deepEqual(f.store.snapshot(), before, "response suppression is not a rollback claim");
});
