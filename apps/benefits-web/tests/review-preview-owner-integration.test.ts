import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewPreviewOwner } from "../src/domain/review-preview-owner.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import { projectReviewPreview } from "../src/server/review/preview-presentation.ts";
import { PREVIEW_TTL_MS } from "../src/server/review/contracts.ts";
import { CANDIDATE_ID, SERVICE_ID, REVIEW_NOW, createReviewMemoryStore, reviewAuthority,
  reviewValues } from "./support/review-memory-store.ts";

// Real internal service/projector/owner composition, SYNTHETIC in-memory adapter.
// No HTTP, verified login, physical DB, UI lifecycle or timer evidence.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const store = createReviewMemoryStore();
  const service = createReviewService(store.dependencies);
  const clock = { wall: REVIEW_NOW, monotonic: 100.25 };
  const owner = createReviewPreviewOwner({ clocks: () => clock });
  const lease = owner.activate(1); assert.ok(lease);
  const draft = (name = "Synthetic credits") => ({ candidateId: CANDIDATE_ID, candidateRevision: 1,
    serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues({ name, remainingAmount: 0 }) });
  const begin = () => { const ticket = owner.begin(lease, owner.getSnapshot()); assert.ok(ticket); return ticket; };
  return { store, service, clock, owner, lease, draft, begin };
}

test("service -> minimal projection -> local owner preserves reviewed uncertainty without accepting a benefit", async () => {
  const f = setup(); const ticket = f.begin();
  const result = await f.service.preview(f.draft()); assert.ok(result.ok);
  assert.equal(f.owner.settle(ticket, projectReviewPreview(result.value)), true);
  const shown = f.owner.getSnapshot(); assert.equal(shown?.phase, "ready"); assert.ok(shown?.preview);
  assert.equal(shown.preview.content.values.remainingAmount, 0);
  assert.equal(shown.preview.content.values.observedAt, null);
  assert.equal(shown.preview.content.valueOrigins.remainingAmount, "user-corrected");
  assert.equal(shown.preview.content.accountProof, "not-established");
  assert.equal(shown.preview.content.currentBalanceProof, "not-established");
  assert.equal(shown.preview.content.reviewStatus, "pending-review");
  const text = JSON.stringify(shown);
  for (const key of ["ownerId", "sessionId", "candidateId", "analysisOperationId", "mailboxBindingId", "source", "body"])
    assert.equal(text.includes(`"${key}"`), false, key);
  assert.equal(f.store.rows.benefits.size, 0); assert.equal(f.store.rows.operations.size, 0);
});

test("two actual preview operations delivered out of order keep the newer request, even though both revisions are one", async () => {
  const f = setup(); const firstTicket = f.begin();
  const firstCreated = deferred(), firstDelivery = deferred();
  const delayedFirst = (async () => {
    const result = await f.service.preview(f.draft("Synthetic first")); assert.ok(result.ok);
    const dto = projectReviewPreview(result.value);
    firstCreated.resolve(); await firstDelivery.promise;
    return f.owner.settle(firstTicket, dto);
  })();
  await firstCreated.promise;
  try {
    const secondTicket = f.begin();
    const second = await f.service.preview(f.draft("Synthetic second")); assert.ok(second.ok);
    assert.equal(f.owner.settle(secondTicket, projectReviewPreview(second.value)), true);
    const newer = f.owner.getSnapshot();
    firstDelivery.resolve();
    assert.equal(await delayedFirst, false);
    assert.equal(f.owner.getSnapshot(), newer);
    assert.equal(newer?.preview?.previewId, second.value.id);
    assert.equal(newer?.preview?.content.values.name, "Synthetic second");
    assert.equal(newer?.preview?.previewRevision, 1);
    assert.equal(f.store.rows.previews.size, 2);
    assert.ok([...f.store.rows.previews.values()].every((row) => row.state === "pending"));
    assert.equal(f.store.rows.benefits.size, 0);
  } finally { firstDelivery.resolve(); await delayedFirst; }
});

test("cancelling the local request before insert completes does not roll back or revoke the server preview", async () => {
  const f = setup(); const ticket = f.begin(); const entered = deferred(), release = deferred();
  f.store.controls.beforeMethod = async (method) => {
    if (method === "insertPreview") { entered.resolve(); await release.promise; }
  };
  const pending = f.service.preview(f.draft());
  await entered.promise;
  try {
    assert.equal(f.owner.cancel(f.lease, ticket), true);
    assert.equal(f.owner.getSnapshot()?.phase, "idle");
    release.resolve(); const result = await pending; assert.ok(result.ok);
    assert.equal(f.owner.settle(ticket, projectReviewPreview(result.value)), false);
    assert.equal(f.owner.getSnapshot()?.preview, null);
    assert.equal(f.store.controls.commits, 1); assert.equal(f.store.controls.rollbacks, 0);
    assert.equal(f.store.rows.previews.get(result.value.id)?.state, "pending");
  } finally { release.resolve(); await pending; }
});

test("the actual server preview expires at the same wall boundary but its stored row is not physically erased", async () => {
  const f = setup(); const ticket = f.begin();
  const result = await f.service.preview(f.draft()); assert.ok(result.ok);
  assert.equal(f.owner.settle(ticket, projectReviewPreview(result.value)), true);
  const shown = f.owner.getSnapshot();
  f.clock.wall = result.value.expiresAt; f.clock.monotonic += PREVIEW_TTL_MS;
  f.store.controls.now = result.value.expiresAt;
  assert.equal(f.owner.checkExpiry(f.lease, shown), false);
  assert.equal(f.owner.getSnapshot()?.phase, "expired"); assert.equal(f.owner.getSnapshot()?.preview, null);
  const confirm = await f.service.confirm({ previewId: result.value.id,
    operationId: "synthetic-expired-preview", decision: "confirm" });
  assert.equal(confirm.ok, false);
  if (!confirm.ok) assert.equal(confirm.code, "REVIEW_PREVIEW_EXPIRED");
  assert.equal(f.store.rows.previews.get(result.value.id)?.state, "pending");
  assert.equal(f.store.rows.benefits.size, 0);
});

test("a server failure after preview commit clears the local pending request without inventing rollback", async () => {
  const f = setup(); const ticket = f.begin();
  f.store.controls.afterCommit = () => { f.store.controls.now = REVIEW_NOW + PREVIEW_TTL_MS; };
  const result = await f.service.preview(f.draft()); assert.ok(!result.ok);
  assert.equal(result.code, "REVIEW_PREVIEW_EXPIRED");
  assert.equal(f.owner.fail(ticket), true);
  assert.equal(f.owner.getSnapshot()?.phase, "invalid"); assert.equal(f.owner.getSnapshot()?.preview, null);
  assert.equal(f.store.rows.previews.size, 1); assert.equal(f.store.controls.commits, 1);
  assert.equal(f.store.controls.rollbacks, 0);
});

test("internal PreviewView is not accepted as browser state without the privacy projection", async () => {
  const f = setup(); const ticket = f.begin();
  const result = await f.service.preview(f.draft()); assert.ok(result.ok);
  assert.equal(f.owner.settle(ticket, result.value), false);
  assert.equal(f.owner.getSnapshot()?.phase, "invalid"); assert.equal(f.owner.getSnapshot()?.preview, null);
});

test("local freshness is not authority: server rejects an old-session preview even if the UI owner was not yet told", async () => {
  const f = setup(); const ticket = f.begin();
  const result = await f.service.preview(f.draft()); assert.ok(result.ok);
  assert.equal(f.owner.settle(ticket, projectReviewPreview(result.value)), true);
  const shown = f.owner.getSnapshot();
  f.store.controls.authority = reviewAuthority({ sessionId: "synthetic-session-replaced", sessionRevision: 2 });
  assert.equal(f.owner.checkExpiry(f.lease, shown), true); // Only local time, NOT authorization.
  const confirm = await f.service.confirm({ previewId: result.value.id,
    operationId: "synthetic-session-preview", decision: "confirm" });
  assert.equal(confirm.ok, false); assert.equal(f.store.rows.benefits.size, 0);
  f.owner.deactivate(f.lease); // Actual auth owner must do this synchronously on session changes.
  assert.equal(f.owner.getSnapshot(), null);
  assert.equal(f.owner.checkExpiry(f.lease, shown), false);
});

test("logout of the previous lease during replacement's null notification cancels the activation itself", () => {
  const f = setup();
  let notifications = 0;
  f.owner.subscribe(() => {
    if (f.owner.getSnapshot() === null) {
      notifications++;
      f.owner.deactivate(f.lease);
    }
  });
  assert.equal(f.owner.activate(2), null);
  assert.equal(notifications, 1);
  assert.equal(f.owner.getSnapshot(), null);
  const newLease = f.owner.activate(2); assert.ok(newLease);
  const newSnapshot = f.owner.getSnapshot();
  f.owner.deactivate(f.lease); // Once replacement ends, old cleanup cannot clear the new owner.
  assert.equal(f.owner.getSnapshot(), newSnapshot);
});
