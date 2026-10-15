import assert from "node:assert/strict";
import { test } from "node:test";
import { createServiceCatalog } from "../src/server/catalog/service-catalog.ts";
import { CATALOG_SCHEMA, DELETED_SERVICE_NAME, type CatalogServiceRow, type CatalogView,
  type ServiceProfile, type CatalogTransaction } from "../src/server/catalog/contracts.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import { projectReviewReceipt } from "../src/server/review/presentation.ts";
import { createReviewedBenefitViewState, reduceReviewedBenefitView } from "../src/domain/reviewed-benefit-view.ts";
import type { ReviewErrorCode, ReviewResult } from "../src/server/review/contracts.ts";
import { CANDIDATE_ID, REVIEW_NOW, REVIEW_OWNER, SYNTHETIC_PRIVATE, candidateRow,
  catalogRevisionKey, createReviewMemoryStore, operationKey, reviewAuthority, reviewValues } from "./support/review-memory-store.ts";

// Server orchestration and browser-state composition with synthetic memory only.
// This does not verify a real DB, RLS, external accounts, or durable transactions.
const profile = (patch: Partial<ServiceProfile> = {}): ServiceProfile => ({
  name: "Synthetic Studio", provider: null, planName: null, accountLabel: null, timezone: null,
  subscriptionStatus: "unknown", trialEndsAt: null, notes: null, ...patch,
});
const createInput = (operationId = "synthetic-create", value = profile()) => ({ operationId, decision: "create", profile: value });
const updateInput = (view: CatalogView, operationId = "synthetic-update", value = profile({ name: "Synthetic renamed" })) => ({
  serviceId: view.serviceId, expectedRevision: view.serviceRevision, operationId, decision: "update", profile: value,
});
const removeInput = (view: CatalogView, operationId = "synthetic-delete") => ({
  serviceId: view.serviceId, expectedRevision: view.serviceRevision, operationId, decision: "delete",
});
function fixture() {
  const store = createReviewMemoryStore();
  store.rows.services.clear();
  return { store, controls: store.controls, catalog: createServiceCatalog(store.catalogDependencies),
    review: createReviewService(store.dependencies) };
}
type Fixture = ReturnType<typeof fixture>;
function success<T>(result: ReviewResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}
function failure(result: ReviewResult<unknown>, code: ReviewErrorCode | readonly ReviewErrorCode[]) {
  assert.ok(!result.ok, "unexpected success");
  assert.ok((Array.isArray(code) ? code : [code]).includes(result.code), `expected ${String(code)}, got ${result.code}`);
  assert.deepEqual(Object.keys(result).sort(), ["code", "ok"]);
  assert.ok(!JSON.stringify(result).includes(SYNTHETIC_PRIVATE));
  assert.ok(Object.isFrozen(result));
}
function frozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozenTree(child);
}
async function created(f: Fixture, op = "synthetic-create", value = profile()) {
  return success(await f.catalog.create(createInput(op, value))).service;
}
async function preview(f: Fixture, service: CatalogView, candidateId = CANDIDATE_ID) {
  return success(await f.review.preview({ candidateId, candidateRevision: 1,
    serviceId: service.serviceId, serviceRevision: service.serviceRevision, values: reviewValues() }));
}
function seed(f: Fixture, id: string, patch: Partial<CatalogServiceRow> = {}) {
  const row: CatalogServiceRow = { id, ownerId: REVIEW_OWNER, dataGeneration: 1, revision: 1,
    state: "live", name: profile().name, profile: profile(), createdAt: REVIEW_NOW, updatedAt: REVIEW_NOW, ...patch };
  f.store.rows.services.set(id, row);
  return row;
}

test("create stores nullable unknown metadata, user-reported provenance and no account-proof claim", async () => {
  const f = fixture();
  const result = await f.catalog.create(createInput());
  const receipt = success(result);
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.service.schema, CATALOG_SCHEMA);
  assert.equal(receipt.service.state, "live");
  assert.equal(receipt.service.serviceRevision, 1);
  assert.equal(receipt.service.dataGeneration, 1);
  assert.equal(receipt.service.createdAt, REVIEW_NOW);
  assert.deepEqual(receipt.service.profile, profile());
  assert.equal(receipt.service.provenance, "user-reported");
  assert.equal(receipt.service.accountProof, "not-established");
  assert.equal(f.store.rows.catalogOperations.size, 1);
  assert.equal(f.store.rows.catalogRevisions.get(catalogRevisionKey(REVIEW_OWNER, 1)), 2);
  frozenTree(result);
});

for (const subscriptionStatus of ["active", "trial", "trial_ended", "paused", "cancelled", "unknown"] as const) {
  test(`reported status ${subscriptionStatus} is preserved without filling missing dates or timezone`, async () => {
    const f = fixture();
    const view = await created(f, "synthetic-create", profile({ subscriptionStatus }));
    assert.equal(view.profile!.subscriptionStatus, subscriptionStatus);
    assert.equal(view.profile!.trialEndsAt, null);
    assert.equal(view.profile!.timezone, null);
    assert.equal(view.provenance, "user-reported");
  });
}

test("bounded optional labels, valid timezone, explicit date and multiline notes round-trip", async () => {
  const f = fixture();
  const value = profile({ name: "n".repeat(160), provider: "p".repeat(160), planName: "l".repeat(160),
    accountLabel: "a".repeat(160), timezone: "Asia/Seoul", trialEndsAt: "2028-02-29", notes: "합성 메모\n두 번째 줄" });
  const view = await created(f, "synthetic-create", value);
  assert.deepEqual(view.profile, value);
  assert.deepEqual(success(await f.catalog.get({ serviceId: view.serviceId })), view);
  const updated = success(await f.catalog.update(updateInput(view, "synthetic-long-notes", profile({ notes: "x".repeat(2048) }))));
  assert.equal(updated.service.profile!.notes!.length, 2048);
});

const invalidProfiles: Array<[string, unknown]> = [];
for (const key of Object.keys(profile())) {
  const missing: Record<string, unknown> = { ...profile() };
  delete missing[key];
  invalidProfiles.push([`missing ${key}`, missing]);
}
for (const key of ["name", "provider", "planName", "accountLabel"]) {
  for (const value of ["", " leading", "trailing ", "a".repeat(161), "line\nbreak"]) {
    invalidProfiles.push([`${key} invalid ${JSON.stringify(value).slice(0, 30)}`, { ...profile(), [key]: value }]);
  }
}
for (const [key, value] of [
  ["name", null], ["name", "synthetic\u202e"], ["provider", false], ["timezone", "Synthetic/NotAZone"],
  ["timezone", "x".repeat(65)], ["timezone", ""], ["subscriptionStatus", "verified"],
  ["subscriptionStatus", null], ["trialEndsAt", "2025-02-29"], ["trialEndsAt", "2026-09-28T12:00:00"],
  ["trialEndsAt", "2026-09-28T12:00:00-00:00"], ["notes", ""], ["notes", " padded "],
  ["notes", "x".repeat(2049)], ["notes", "line\r\nline"], ["notes", "tab\there"], ["notes", "synthetic\u0000"],
] as const) invalidProfiles.push([`${key} invalid ${JSON.stringify(value).slice(0, 35)}`, { ...profile(), [key]: value }]);
invalidProfiles.push(["extra field", { ...profile(), ownerId: "synthetic-other" }], ["array", []], ["null", null]);
for (const [name, value] of invalidProfiles) {
  test(`invalid exact profile is rejected without storage: ${name}`, async () => {
    const f = fixture();
    failure(await f.catalog.create({ ...createInput(), profile: value }), "REVIEW_INPUT_INVALID");
    assert.equal(f.store.rows.services.size, 0);
    assert.equal(f.store.rows.catalogOperations.size, 0);
  });
}

for (const level of ["request", "profile"]) {
  test(`${level} getter is rejected without evaluating caller code`, async () => {
    const f = fixture();
    let calls = 0;
    const input = createInput();
    Object.defineProperty(level === "request" ? input : input.profile, level === "request" ? "profile" : "notes",
      { enumerable: true, get() { calls++; return null; } });
    failure(await f.catalog.create(input), "REVIEW_INPUT_INVALID");
    assert.equal(calls, 0);
    assert.equal(f.controls.transactions, 0);
  });
}

test("caller object mutation after dispatch cannot rewrite the canonical profile", async () => {
  const f = fixture();
  const input = createInput();
  f.controls.readAuthority = () => { input.profile = profile({ name: "Changed too late" }); return reviewAuthority(); };
  assert.equal(success(await f.catalog.create(input)).service.profile!.name, "Synthetic Studio");
});

test("same display name with distinct operations creates distinct account records", async () => {
  const f = fixture();
  const first = await created(f);
  const second = await created(f, "synthetic-second");
  assert.notEqual(first.serviceId, second.serviceId);
  assert.equal(f.store.rows.services.size, 2);
});

test("canonical fingerprint ignores input key order and operation ledger has no names or notes", async () => {
  const f = fixture();
  const value = profile({ name: "SYNTHETIC_NAME_ONLY_IN_PROFILE", notes: "SYNTHETIC_NOTES_ONLY_IN_PROFILE" });
  const first = success(await f.catalog.create(createInput("synthetic-create", value)));
  const reversed = Object.fromEntries(Object.entries(value).reverse());
  const replay = success(await f.catalog.create({ profile: reversed, decision: "create", operationId: "synthetic-create" }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.service.serviceId, first.service.serviceId);
  const operation = f.store.rows.catalogOperations.get(operationKey(REVIEW_OWNER, "synthetic-create"))!;
  assert.match(operation.requestFingerprint, /^[a-f0-9]{64}$/);
  const encoded = JSON.stringify(operation);
  assert.ok(!encoded.includes(value.name));
  assert.ok(!encoded.includes(value.notes!));
  assert.deepEqual(Object.keys(operation).sort(), ["ownerId", "dataGeneration", "operationId", "kind", "requestFingerprint", "serviceId"].sort());
});

test("same create operation replays the current renamed record, then its null tombstone", async () => {
  const f = fixture();
  const first = await created(f);
  const updated = success(await f.catalog.update(updateInput(first))).service;
  const replay = success(await f.catalog.create(createInput()));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.service, updated);
  const deleted = success(await f.catalog.remove(removeInput(updated))).service;
  const before = f.store.snapshot();
  assert.deepEqual(success(await f.catalog.create(createInput())).service, deleted);
  assert.equal(deleted.profile, null);
  assert.equal(success(await f.catalog.get({ serviceId: first.serviceId })).state, "deleted");
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(f.store.rows.services.get(first.serviceId)!.name, DELETED_SERVICE_NAME);
});

test("operation body or kind changes conflict without overwriting current data", async () => {
  const f = fixture();
  const first = await created(f);
  const before = f.store.snapshot();
  failure(await f.catalog.create(createInput("synthetic-create", profile({ name: "Another name" }))), "REVIEW_OPERATION_CONFLICT");
  failure(await f.catalog.update(updateInput(first, "synthetic-create")), "REVIEW_OPERATION_CONFLICT");
  failure(await f.catalog.remove(removeInput(first, "synthetic-create")), "REVIEW_OPERATION_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
});

test("identical concurrent create commits one row, one ledger entry and one collection increment", async () => {
  const f = fixture();
  const receipts = (await Promise.all([f.catalog.create(createInput()), f.catalog.create(createInput())])).map(success);
  assert.deepEqual(receipts.map((row) => row.replayed).sort(), [false, true]);
  assert.equal(f.store.rows.services.size, 1);
  assert.equal(f.store.rows.catalogOperations.size, 1);
  assert.equal(f.store.rows.catalogRevisions.get(catalogRevisionKey(REVIEW_OWNER, 1)), 2);
});

test("different operations racing the same revision permit exactly one update", async () => {
  const f = fixture();
  const first = await created(f);
  const results = await Promise.all([
    f.catalog.update(updateInput(first, "synthetic-update-a", profile({ name: "A" }))),
    f.catalog.update(updateInput(first, "synthetic-update-b", profile({ name: "B" }))),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  failure(results.find((result) => !result.ok)!, "REVIEW_CONFLICT");
  assert.equal(f.store.rows.catalogOperations.size, 2);
  assert.equal(success(await f.catalog.get({ serviceId: first.serviceId })).serviceRevision, 2);
});

test("update and delete exact retries replay current state without advancing collection revision twice", async () => {
  const f = fixture();
  const first = await created(f);
  const update = updateInput(first);
  const second = success(await f.catalog.update(update)).service;
  assert.equal(success(await f.catalog.update(update)).replayed, true);
  const deletion = removeInput(second);
  success(await f.catalog.remove(deletion));
  const before = f.store.snapshot();
  assert.equal(success(await f.catalog.remove(deletion)).replayed, true);
  assert.equal(success(await f.catalog.update(update)).service.profile, null);
  assert.deepEqual(f.store.snapshot(), before);
  failure(await f.catalog.update(updateInput(second, "synthetic-new-update")), "REVIEW_CONFLICT");
});

for (const action of ["get", "update", "remove"] as const) {
  for (const mismatch of ["missing", "owner", "generation", "id"]) {
    test(`${action} ${mismatch} mismatch returns generic not-found`, async () => {
      const f = fixture();
      const view = await created(f);
      const row = f.store.rows.services.get(view.serviceId)!;
      if (mismatch === "missing") f.store.rows.services.delete(view.serviceId);
      if (mismatch === "owner") f.store.rows.services.set(view.serviceId, { ...row, ownerId: "synthetic-other" });
      if (mismatch === "generation") f.store.rows.services.set(view.serviceId, { ...row, dataGeneration: 2 });
      if (mismatch === "id") f.store.rows.services.set(view.serviceId, { ...row, id: "synthetic-other" });
      const result = action === "get" ? await f.catalog.get({ serviceId: view.serviceId })
        : action === "update" ? await f.catalog.update(updateInput(view)) : await f.catalog.remove(removeInput(view));
      failure(result, "REVIEW_NOT_FOUND");
    });
  }
}

test("renaming erases pending previews, preserves consumed history and requires a new preview", async () => {
  const f = fixture();
  const view = await created(f);
  const pending = await preview(f, view);
  f.store.rows.candidates.set("synthetic-candidate-two", candidateRow({ id: "synthetic-candidate-two" }));
  const consumed = await preview(f, view, "synthetic-candidate-two");
  const saved = success(await f.review.confirm({ previewId: consumed.id, operationId: "synthetic-confirm", decision: "confirm" }));
  const renamed = success(await f.catalog.update(updateInput(view))).service;
  assert.equal(f.store.rows.previews.get(pending.id)!.content, null);
  assert.notEqual(f.store.rows.previews.get(consumed.id)!.content, null);
  assert.equal(saved.content!.serviceNameAtReview, "Synthetic Studio");
  failure(await f.review.confirm({ previewId: pending.id, operationId: "synthetic-stale-confirm", decision: "confirm" }), "REVIEW_PREVIEW_UNAVAILABLE");
  assert.equal((await preview(f, renamed)).content.serviceName, "Synthetic renamed");
});

test("live reviewed benefits block service deletion until their own atomic removal", async () => {
  const f = fixture();
  const view = await created(f);
  const p = await preview(f, view);
  const saved = success(await f.review.confirm({ previewId: p.id, operationId: "synthetic-confirm", decision: "confirm" }));
  const before = f.store.snapshot();
  failure(await f.catalog.remove(removeInput(view)), "REVIEW_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
  success(await f.review.remove({ benefitId: saved.benefitId, expectedRevision: saved.benefitRevision,
    operationId: "synthetic-benefit-delete", decision: "delete" }));
  assert.equal(success(await f.catalog.remove(removeInput(view))).service.state, "deleted");
});

for (const first of ["delete", "confirm"] as const) {
  test(`serialized ${first}-first delete/confirm race cannot leave a live benefit on a deleted service`, async () => {
    const f = fixture();
    const view = await created(f);
    const p = await preview(f, view);
    const confirm = () => f.review.confirm({ previewId: p.id, operationId: "synthetic-confirm", decision: "confirm" });
    const remove = () => f.catalog.remove(removeInput(view));
    const results = first === "delete" ? await Promise.all([remove(), confirm()]) : await Promise.all([confirm(), remove()]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    const service = f.store.rows.services.get(view.serviceId)!;
    assert.ok(!(service.state === "deleted" && [...f.store.rows.benefits.values()].some((row) => row.state === "live")));
    failure(results.find((result) => !result.ok)!, ["REVIEW_CONFLICT", "REVIEW_PREVIEW_UNAVAILABLE"]);
  });
}

for (const first of ["update", "confirm"] as const) {
  test(`serialized ${first}-first update/confirm race preserves the reviewed version or rejects stale preview`, async () => {
    const f = fixture();
    const view = await created(f);
    const p = await preview(f, view);
    const confirm = () => f.review.confirm({ previewId: p.id, operationId: "synthetic-confirm", decision: "confirm" });
    const update = () => f.catalog.update(updateInput(view));
    if (first === "update") {
      const [updated, confirmation] = await Promise.all([update(), confirm()]);
      assert.equal(success(updated).service.profile!.name, "Synthetic renamed");
      failure(confirmation, "REVIEW_PREVIEW_UNAVAILABLE");
      assert.equal(f.store.rows.benefits.size, 0);
    } else {
      const [confirmation, updated] = await Promise.all([confirm(), update()]);
      assert.equal(success(confirmation).content!.serviceNameAtReview, "Synthetic Studio");
      assert.equal(success(updated).service.profile!.name, "Synthetic renamed");
      assert.equal(f.store.rows.benefits.size, 1);
      assert.notEqual(f.store.rows.previews.get(p.id)!.content, null);
    }
  });
}

test("memory reference predicate rejects deletion if a live benefit appears after the reference check", async () => {
  const f = fixture();
  const view = await created(f);
  const external = fixture();
  const externalService = await created(external);
  assert.equal(externalService.serviceId, view.serviceId);
  const p = await preview(external, externalService);
  const saved = success(await external.review.confirm({ previewId: p.id, operationId: "synthetic-confirm", decision: "confirm" }));
  const externalRow = external.store.rows.benefits.get(saved.benefitId)!;
  f.controls.beforeCommit = () => {
    // Synthetic out-of-band mutation models a missed reference phantom. The
    // adapter predicate must reject our deletion, not erase the new live row.
    f.store.rows.benefits.set(externalRow.id, structuredClone(externalRow));
  };
  failure(await f.catalog.remove(removeInput(view)), "REVIEW_STORE_UNAVAILABLE");
  assert.equal(f.store.rows.services.get(view.serviceId)!.state, "live");
  assert.equal(f.store.rows.benefits.get(externalRow.id)!.state, "live");
  assert.equal(f.store.rows.catalogOperations.size, 1);
});

test("catalog to review to safe browser projection rejects late saved output after deletion", async () => {
  const f = fixture();
  const service = await created(f);
  const p = await preview(f, service);
  const saved = success(await f.review.confirm({ previewId: p.id, operationId: "synthetic-confirm", decision: "confirm" }));
  const savedProjection = projectReviewReceipt(saved);
  let state = createReviewedBenefitViewState("scope-test-A", 1);
  state = reduceReviewedBenefitView(state, { type: "response", capturedScope: "scope-test-A", payload: savedProjection });
  assert.equal(state.entries.length, 1);
  const deleted = success(await f.review.remove({ benefitId: saved.benefitId, expectedRevision: saved.benefitRevision,
    operationId: "synthetic-benefit-delete", decision: "delete" }));
  state = reduceReviewedBenefitView(state, { type: "response", capturedScope: "scope-test-A", payload: projectReviewReceipt(deleted) });
  const afterDelete = state;
  state = reduceReviewedBenefitView(state, { type: "response", capturedScope: "scope-test-A", payload: savedProjection });
  assert.deepEqual(state, afterDelete);
  assert.ok(!JSON.stringify(state).includes("Synthetic credits"));
  assert.equal(success(await f.catalog.remove(removeInput(service))).service.profile, null);
});

test("pagination is owner/generation scoped, live-only and uses strict ASCII ID order", async () => {
  const f = fixture();
  for (const id of ["svc-z", "svc-A", "svc-a", "svc-2", "svc-10"]) seed(f, id);
  seed(f, "svc-0-other", { ownerId: "synthetic-other" });
  seed(f, "svc-0-gen", { dataGeneration: 2 });
  seed(f, "svc-0-deleted", { state: "deleted", name: DELETED_SERVICE_NAME, profile: null });
  const first = success(await f.catalog.list({ limit: 2, cursor: null }));
  assert.deepEqual(first.services.map((row) => row.serviceId), ["svc-10", "svc-2"]);
  assert.deepEqual(first.nextCursor, { afterId: "svc-2", catalogRevision: 1, dataGeneration: 1 });
  const second = success(await f.catalog.list({ limit: 2, cursor: first.nextCursor }));
  assert.deepEqual(second.services.map((row) => row.serviceId), ["svc-A", "svc-a"]);
  const last = success(await f.catalog.list({ limit: 2, cursor: second.nextCursor }));
  assert.deepEqual(last.services.map((row) => row.serviceId), ["svc-z"]);
  assert.equal(last.nextCursor, null);
  frozenTree(first);
});

for (const limit of [0, 51, -1, 1.5, NaN, "2", null]) {
  test(`invalid page limit ${String(limit)} is rejected before transaction`, async () => {
    const f = fixture();
    failure(await f.catalog.list({ limit, cursor: null }), "REVIEW_INPUT_INVALID");
    assert.equal(f.controls.transactions, 0);
  });
}

test("page maximum is 50 and empty collection has no cursor", async () => {
  const f = fixture();
  assert.deepEqual(success(await f.catalog.list({ limit: 50, cursor: null })).services, []);
  for (let index = 0; index < 51; index++) seed(f, `svc-${String(index).padStart(3, "0")}`);
  const page = success(await f.catalog.list({ limit: 50, cursor: null }));
  assert.equal(page.services.length, 50);
  assert.ok(page.nextCursor);
  assert.equal(success(await f.catalog.list({ limit: 50, cursor: page.nextCursor })).services.length, 1);
});

for (const mutation of ["create", "update", "remove"] as const) {
  test(`${mutation} advances collection revision and rejects stale page cursors`, async () => {
    const f = fixture();
    const first = await created(f);
    await created(f, "synthetic-second");
    const page = success(await f.catalog.list({ limit: 1, cursor: null }));
    assert.ok(page.nextCursor);
    if (mutation === "create") await created(f, "synthetic-third");
    if (mutation === "update") success(await f.catalog.update(updateInput(first)));
    if (mutation === "remove") success(await f.catalog.remove(removeInput(first)));
    failure(await f.catalog.list({ limit: 1, cursor: page.nextCursor }), "REVIEW_CONFLICT");
  });
}

test("cursor generation mismatch fails even when collection revision matches", async () => {
  const f = fixture();
  failure(await f.catalog.list({ limit: 1, cursor: { afterId: "svc-A", catalogRevision: 1, dataGeneration: 2 } }), "REVIEW_CONFLICT");
});

type Action = "create" | "update" | "remove" | "get" | "list";
async function actionFixture(action: Action) {
  const f = fixture();
  const service = action === "create" || action === "list" ? null : await created(f);
  const run = (): Promise<ReviewResult<unknown>> => action === "create" ? f.catalog.create(createInput())
    : action === "update" ? f.catalog.update(updateInput(service!))
      : action === "remove" ? f.catalog.remove(removeInput(service!))
        : action === "get" ? f.catalog.get({ serviceId: service!.serviceId }) : f.catalog.list({ limit: 10, cursor: null });
  f.controls.authorityReads = 0;
  return { f, run, service };
}

for (const action of ["create", "update", "remove", "get", "list"] as const) {
  test(`${action} absent or expired auth performs no writes`, async () => {
    for (const authority of [null, reviewAuthority({ expiresAt: REVIEW_NOW })]) {
      const { f, run } = await actionFixture(action);
      f.controls.authority = authority;
      const before = f.store.snapshot();
      failure(await run(), "REVIEW_AUTH_REQUIRED");
      assert.deepEqual(f.store.snapshot(), before);
    }
  });
  test(`${action} checks every async authorization boundary`, async (t) => {
    const baseline = await actionFixture(action);
    success(await baseline.run());
    for (let call = 2; call <= baseline.f.controls.authorityReads; call++) {
      for (const patch of [{ sessionRevision: 2 }, { dataGeneration: 2 }, { expiresAt: REVIEW_NOW }]) {
        await t.test(`${Object.keys(patch)[0]} at ${call}`, async () => {
          const { f, run } = await actionFixture(action);
          f.controls.readAuthority = (index) => index === call ? reviewAuthority(patch) : reviewAuthority();
          const before = f.store.snapshot();
          const commitsBefore = f.controls.commits;
          failure(await run(), "REVIEW_AUTHORITY_CHANGED");
          if (f.controls.commits === commitsBefore) assert.deepEqual(f.store.snapshot(), before);
          else assert.equal(f.controls.commits, commitsBefore + 1);
        });
      }
    }
  });
  for (const boundary of ["entry", "commit"] as const) {
    test(`${action} adapter rejects changed generation at ${boundary} and rolls back`, async () => {
      const { f, run } = await actionFixture(action);
      const change = () => { f.controls.authority = reviewAuthority({ dataGeneration: 2 }); };
      if (boundary === "entry") f.controls.beforeEntry = change;
      else f.controls.beforeCommit = change;
      const before = f.store.snapshot();
      failure(await run(), "REVIEW_STORE_UNAVAILABLE");
      assert.deepEqual(f.store.snapshot(), before);
    });
  }
  test(`${action} redacts adapter errors`, async () => {
    const { f, run } = await actionFixture(action);
    f.controls.readAuthority = () => { throw new Error(SYNTHETIC_PRIVATE); };
    failure(await run(), "REVIEW_STORE_UNAVAILABLE");
  });
}

const writes: Array<["create" | "update" | "remove", keyof CatalogTransaction]> = [
  ["create", "insertCatalogService"], ["create", "advanceCatalogRevision"], ["create", "insertCatalogOperation"],
  ["update", "updateCatalogService"], ["update", "eraseServicePreviews"], ["update", "advanceCatalogRevision"], ["update", "insertCatalogOperation"],
  ["remove", "updateCatalogService"], ["remove", "eraseServicePreviews"], ["remove", "advanceCatalogRevision"], ["remove", "insertCatalogOperation"],
];
for (const [action, method] of writes) {
  test(`${action} ${method} post-write exception rolls back row, previews, ledger and collection revision`, async () => {
    const { f, run, service } = await actionFixture(action);
    if (service) await preview(f, service);
    f.controls.afterMethod = (current) => { if (current === method) throw new Error(SYNTHETIC_PRIVATE); };
    const before = f.store.snapshot();
    failure(await run(), "REVIEW_STORE_UNAVAILABLE");
    assert.deepEqual(f.store.snapshot(), before);
  });
}

for (const method of ["insertCatalogService", "advanceCatalogRevision", "insertCatalogOperation"] as const) {
  test(`${method} conditional refusal rolls back create`, async () => {
    const f = fixture();
    f.controls.falseMethod = method;
    const before = f.store.snapshot();
    failure(await f.catalog.create(createInput()), "REVIEW_CONFLICT");
    assert.deepEqual(f.store.snapshot(), before);
  });
}

test("unknown post-commit failure returns no payload and exact retry reads one committed record", async () => {
  const f = fixture();
  f.controls.afterCommit = () => { throw new Error(SYNTHETIC_PRIVATE); };
  failure(await f.catalog.create(createInput()), "REVIEW_STORE_UNAVAILABLE");
  assert.equal(f.store.rows.services.size, 1);
  delete f.controls.afterCommit;
  assert.equal(success(await f.catalog.create(createInput())).replayed, true);
  assert.equal(f.store.rows.catalogOperations.size, 1);
});

for (const action of ["update", "remove", "confirm"] as const) {
  test(`${action} rechecks the registered original service version at commit`, async () => {
    const f = fixture();
    const view = await created(f);
    const p = action === "confirm" ? await preview(f, view) : null;
    const previous = f.store.rows.services.get(view.serviceId)!;
    f.controls.beforeCommit = () => {
      // Simulate an out-of-band revision change; preserve it when our transaction rolls back.
      f.store.rows.services.set(view.serviceId, { ...previous, revision: previous.revision + 1 });
    };
    const result = action === "update" ? await f.catalog.update(updateInput(view))
      : action === "remove" ? await f.catalog.remove(removeInput(view))
        : await f.review.confirm({ previewId: p!.id, operationId: "synthetic-confirm", decision: "confirm" });
    failure(result, "REVIEW_STORE_UNAVAILABLE");
    assert.equal(f.store.rows.benefits.size, 0);
    assert.equal(f.store.rows.catalogOperations.size, 1);
    assert.equal(f.store.rows.services.get(view.serviceId)!.revision, 2);
    assert.equal(f.store.rows.services.get(view.serviceId)!.state, "live");
  });
}

test("service and collection revision overflow fail without partial mutation", async () => {
  const f = fixture();
  const view = await created(f);
  const stored = f.store.rows.services.get(view.serviceId)!;
  f.store.rows.services.set(view.serviceId, { ...stored, revision: Number.MAX_SAFE_INTEGER });
  const before = f.store.snapshot();
  failure(await f.catalog.update({ ...updateInput(view), expectedRevision: Number.MAX_SAFE_INTEGER }), "REVIEW_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
  f.store.rows.catalogRevisions.set(catalogRevisionKey(REVIEW_OWNER, 1), Number.MAX_SAFE_INTEGER);
  const maxed = f.store.snapshot();
  failure(await f.catalog.create(createInput("synthetic-another")), "REVIEW_CONFLICT");
  assert.deepEqual(f.store.snapshot(), maxed);
});
