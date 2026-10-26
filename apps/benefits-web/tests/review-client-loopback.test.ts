import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewClient, type ReviewCallResult, type ReviewViewContext } from "../src/domain/review-client/client.ts";
import { createReviewPreviewRequest, createReviewConfirmRequest, createReviewRejectRequest,
  createReviewDeleteRequest, createReviewGetRequest, createReviewListRequest, type ReviewRequest } from "../src/domain/review-client/requests.ts";
import { CANDIDATE_ID, candidateRow, reviewValues, SERVICE_ID, SYNTHETIC_PRIVATE,
  benefitCollectionRevisionKey, REVIEW_OWNER } from "./support/review-memory-store.ts";
import { startReviewLoopback, type ReviewLoopbackFixture, type ReviewLoopbackOptions } from "./support/review-http-loopback.ts";

// SYNTHETIC ONLY: the real client crosses actual ephemeral loopback HTTP into
// the unmounted handler and serialized memory fixture. Node has no browser
// cookie jar/Origin behavior: ONLY this injected test transport supplies them.
// This does not test browser cookies, production routes, TLS, real auth or DB.
const nativeFetch = globalThis.fetch;
function clientFixture(f: ReviewLoopbackFixture) {
  let context: ReviewViewContext | null = Object.freeze({ viewScope: "synthetic-review-A", dataGeneration: 1 });
  const sent: Array<{ url: string; body: string }> = [];
  const call = createReviewClient({ origin: f.origin, now: () => f.store.controls.now,
    readViewContext: () => context,
    fetch: async (request, signal) => {
      assert.equal(new URL(request.url).origin, f.origin);
      assert.equal(request.method, "POST");
      assert.equal(request.credentials, "same-origin");
      assert.equal(request.redirect, "error");
      assert.equal(request.cache, "no-store");
      assert.equal(request.referrerPolicy, "no-referrer");
      assert.equal(request.headers.get("x-keyatlas-request"), "review-v1");
      assert.equal(request.headers.has("cookie"), false);
      assert.equal(request.headers.has("authorization"), false);
      assert.equal(request.headers.has("origin"), false);
      sent.push({ url: request.url, body: await request.clone().text() });
      const headers = new Headers(request.headers);
      headers.set("origin", f.origin);
      headers.set("cookie", "synthetic-session=fixture");
      return nativeFetch(new Request(request, { headers, signal }), { signal });
    },
  });
  return { call, sent, setContext: (next: ReviewViewContext | null) => { context = next; } };
}
async function withFixture(run: (f: ReviewLoopbackFixture) => Promise<void>, options: ReviewLoopbackOptions = {}) {
  const f = await startReviewLoopback(options);
  try { await run(f); }
  finally { await f.close(); assert.equal(f.openSockets, 0); }
}
function success(result: ReviewCallResult) {
  assert.equal(result.kind, "success", JSON.stringify(result));
  if (result.kind !== "success") throw new Error("SYNTHETIC_EXPECTED_SUCCESS");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.capturedScope));
  return result.success;
}
function failure(result: ReviewCallResult, code: string) {
  assert.deepEqual(result, { kind: "error", code, retriableAfterMs: null });
}
function previewRequest(candidateId = CANDIDATE_ID) {
  return createReviewPreviewRequest(candidateId, 1, SERVICE_ID, 1,
    reviewValues({ remainingAmount: 0, expiresAt: "2020-02-29", observedAt: "2026-09-27T12:34:56.123456789+09:00" }));
}
async function preview(c: ReturnType<typeof clientFixture>, candidateId = CANDIDATE_ID) {
  const result = success(await c.call(previewRequest(candidateId)));
  assert.equal(result.kind, "preview");
  if (result.kind !== "preview") throw new Error("SYNTHETIC_EXPECTED_PREVIEW");
  return result.preview;
}
async function confirmed(c: ReturnType<typeof clientFixture>, candidateId = CANDIDATE_ID, suffix = "one") {
  const shown = await preview(c, candidateId);
  const command = createReviewConfirmRequest(shown.previewId, `synthetic-client-confirm-${suffix}`);
  const result = success(await c.call(command));
  assert.ok(result.kind === "view" && result.view.outcome === "saved");
  return { shown, command, view: result.view };
}
function noPrivateFields(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  const forbidden = new Set(["ownerId", "sessionId", "sessionRevision", "cookie", "authority", "source",
    "candidateId", "candidateRevision", "mailboxBindingId", "analysisOperationId", "operationId", "replayed", "candidateIndex"]);
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, key);
    noPrivateFields(child);
  }
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("review client crosses native HTTP for preview/confirm/get/list/delete and same original confirm returns the current tombstone", async () => {
  await withFixture(async (f) => {
    const c = clientFixture(f), saved = await confirmed(c);
    assert.equal(saved.shown.content.sourceObservedAt, null);
    assert.equal(saved.shown.content.values.remainingAmount, 0);
    assert.equal(saved.shown.content.valueOrigins.remainingAmount, "user-corrected");
    assert.equal(saved.view.content.values.observedAt, "2026-09-27T12:34:56.123456789+09:00");
    assert.equal(saved.view.content.values.expiresAt, "2020-02-29");
    assert.equal(saved.view.content.accountProof, "not-established");
    assert.equal(saved.view.content.currentBalanceProof, "not-established");
    const got = success(await c.call(createReviewGetRequest(saved.view.benefitId)));
    assert.deepEqual(got, { kind: "view", view: saved.view });
    const listed = success(await c.call(createReviewListRequest(50, null)));
    assert.ok(listed.kind === "page");
    assert.deepEqual(listed.page.benefits, [saved.view]);
    assert.equal(listed.page.nextCursor, null);
    const deletion = createReviewDeleteRequest(saved.view.benefitId, saved.view.benefitRevision, "synthetic-client-delete");
    const deleted = success(await c.call(deletion));
    assert.ok(deleted.kind === "view" && deleted.view.outcome === "deleted");
    assert.equal(deleted.view.content, null);
    const committed = f.store.snapshot();
    assert.deepEqual(success(await c.call(saved.command)), deleted);
    assert.deepEqual(success(await c.call(deletion)), deleted);
    assert.deepEqual(f.store.snapshot(), committed);
    assert.equal(f.store.rows.benefits.size, 1);
    assert.equal(f.store.rows.operations.size, 2);
    assert.equal(f.store.rows.benefitsRevisions.get(benefitCollectionRevisionKey(REVIEW_OWNER, 1)), 3);
    for (const result of [saved.shown, saved.view, got, listed, deleted]) noPrivateFields(result);
    assert.deepEqual(c.sent[1], c.sent[5], "retry transmits the exact original confirmation body and path");
    assert.deepEqual(c.sent[4], c.sent[6], "retry transmits the exact original deletion body and path");
    assert.equal(c.sent.length, 7);
    assert.equal(f.admissions.length, 7);
    assert.ok(f.admissions.every(({ request }) => request.surface === "review-v1"));
  });
});

test("review client handles explicit reject without inventing a benefit or automatically retrying a conflict", async () => {
  await withFixture(async (f) => {
    const c = clientFixture(f), shown = await preview(c);
    const command = createReviewRejectRequest(shown.previewId, shown.previewRevision);
    assert.deepEqual(success(await c.call(command)), { kind: "rejected", previewId: shown.previewId });
    const committed = f.store.snapshot();
    failure(await c.call(command), "API_CONFLICT");
    await nextTurn(); await f.whenIdle();
    assert.deepEqual(f.store.snapshot(), committed);
    assert.equal(c.sent.length, 3); assert.equal(f.admissions.length, 3);
    assert.equal(f.store.rows.benefits.size, 0); assert.equal(f.store.rows.operations.size, 0);
  });
});

test("review client keeps a stale page cursor explicit after a real deletion, without automatic restart", async () => {
  await withFixture(async (f) => {
    const c = clientFixture(f);
    await confirmed(c);
    const secondId = "synthetic-client-candidate-two";
    f.store.rows.candidates.set(secondId, candidateRow({ id: secondId }));
    await confirmed(c, secondId, "two");
    const first = success(await c.call(createReviewListRequest(1, null)));
    assert.ok(first.kind === "page" && first.page.nextCursor);
    const row = first.page.benefits[0]!;
    success(await c.call(createReviewDeleteRequest(row.benefitId, row.benefitRevision, "synthetic-client-cursor-delete")));
    const before = f.store.snapshot(), count = c.sent.length;
    failure(await c.call(createReviewListRequest(1, first.page.nextCursor)), "API_CONFLICT");
    await nextTurn(); await f.whenIdle();
    assert.equal(c.sent.length, count + 1);
    assert.deepEqual(f.store.snapshot(), before);
    const restarted = success(await c.call(createReviewListRequest(50, null)));
    assert.ok(restarted.kind === "page");
    assert.equal(restarted.page.benefits.length, 1);
    assert.notEqual(restarted.page.benefits[0]!.benefitId, row.benefitId);
    assert.equal(restarted.page.benefitCollectionRevision, first.page.benefitCollectionRevision + 1);
  });
});

test("review client rejects a genuine server page in the wrong local generation and a cursor without HTTP", async () => {
  await withFixture(async (f) => {
    const c = clientFixture(f), before = f.store.snapshot();
    c.setContext({ viewScope: "synthetic-review-generation-two", dataGeneration: 2 });
    assert.deepEqual(await c.call(createReviewListRequest(50, null)), { kind: "invalid", reason: "ENVELOPE" });
    assert.deepEqual(f.completedStatuses, [200], "the server actually answered generation one");
    assert.equal(c.sent.length, 1);
    assert.deepEqual(await c.call(createReviewListRequest(1, {
      afterId: "synthetic-after", benefitCollectionRevision: 1, dataGeneration: 1,
    })), { kind: "invalid", reason: "REQUEST" });
    assert.equal(c.sent.length, 1);
    assert.deepEqual(f.store.snapshot(), before);
  });
});

test("same-command scope fence prevents reuse after A to B to fresh A while old observations retain their captured scope", async () => {
  await withFixture(async (f) => {
    const c = clientFixture(f), command = createReviewListRequest(50, null);
    const first = await c.call(command);
    assert.ok(first.kind === "success");
    c.setContext({ viewScope: "synthetic-review-B", dataGeneration: 1 });
    assert.deepEqual(await c.call(command), { kind: "stale" });
    c.setContext({ viewScope: "synthetic-review-A-fresh", dataGeneration: 1 });
    assert.deepEqual(await c.call(command), { kind: "stale" });
    assert.equal(c.sent.length, 1);
    const fresh = await c.call(createReviewListRequest(50, null));
    assert.ok(fresh.kind === "success");
    assert.equal(fresh.capturedScope.viewScope, "synthetic-review-A-fresh");
    assert.equal(first.capturedScope.viewScope, "synthetic-review-A");
  });
});

test("scope revoked after a real preview commit suppresses the response without claiming rollback", async () => {
  await withFixture(async (f) => {
    const c = clientFixture(f);
    f.store.controls.afterCommit = () => { c.setContext(null); };
    assert.deepEqual(await c.call(previewRequest()), { kind: "stale" });
    await f.whenIdle();
    assert.deepEqual(f.completedStatuses, [200]);
    assert.equal(f.store.controls.commits, 1); assert.equal(f.store.controls.rollbacks, 0);
    assert.equal(f.store.rows.previews.size, 1); assert.equal(f.store.rows.benefits.size, 0);
    assert.equal(c.sent.length, 1);
  });
});

for (const action of ["confirm", "delete"] as const) test(`postcommit ${action} acknowledgement loss requires the exact original explicit command retry`, async () => {
  await withFixture(async (f) => {
    const c = clientFixture(f);
    let command: ReviewRequest;
    if (action === "confirm") {
      command = createReviewConfirmRequest((await preview(c)).previewId, "synthetic-client-uncertain-confirm");
    } else {
      const saved = await confirmed(c);
      command = createReviewDeleteRequest(saved.view.benefitId, saved.view.benefitRevision, "synthetic-client-uncertain-delete");
    }
    const count = c.sent.length, commits = f.store.controls.commits, rollbacks = f.store.controls.rollbacks;
    let lost = 0;
    f.store.controls.afterCommit = () => {
      lost++;
      delete f.store.controls.afterCommit;
      throw new Error(SYNTHETIC_PRIVATE);
    };
    failure(await c.call(command), "API_UNAVAILABLE");
    await nextTurn(); await f.whenIdle();
    assert.equal(lost, 1); assert.equal(c.sent.length, count + 1);
    assert.equal(f.store.controls.commits, commits + 1);
    assert.equal(f.store.controls.rollbacks, rollbacks, "acknowledgement failure is not rollback");
    const committed = f.store.snapshot();
    assert.equal(committed.benefits.size, 1);
    assert.equal(committed.operations.size, action === "confirm" ? 1 : 2);
    const result = success(await c.call(command));
    assert.ok(result.kind === "view");
    assert.equal(result.view.outcome, action === "confirm" ? "saved" : "deleted");
    assert.deepEqual(f.store.snapshot(), committed, "same ledger retry does not repeat business writes");
    assert.deepEqual(c.sent[count], c.sent[count + 1]);
    assert.equal(c.sent.length, count + 2);
  });
});

for (const action of ["preview", "reject"] as const) test(`uncertain ${action} is not automatically repeated or treated as an idempotent operation`, async () => {
  await withFixture(async (f) => {
    const c = clientFixture(f);
    const command = action === "preview" ? previewRequest()
      : createReviewRejectRequest((await preview(c)).previewId, 1);
    const count = c.sent.length;
    f.store.controls.afterCommit = () => { delete f.store.controls.afterCommit; throw new Error(SYNTHETIC_PRIVATE); };
    failure(await c.call(command), "API_UNAVAILABLE");
    await nextTurn(); await f.whenIdle();
    assert.equal(c.sent.length, count + 1);
    assert.equal(f.store.rows.previews.size, 1);
    assert.equal(f.store.rows.benefits.size, 0); assert.equal(f.store.rows.operations.size, 0);
    const before = f.store.snapshot();
    if (action === "preview") {
      success(await c.call(command)); // Explicit new attempt: no exactly-once promise.
      assert.equal(f.store.rows.previews.size, 2);
    } else {
      failure(await c.call(command), "API_CONFLICT");
      assert.deepEqual(f.store.snapshot(), before);
    }
    assert.equal(c.sent.length, count + 2);
  });
});

test("real 429 retry-after is reported but causes no automatic request when the advertised interval elapses", async () => {
  await withFixture(async (f) => {
    const c = clientFixture(f), before = f.store.snapshot(), command = createReviewListRequest(50, null);
    assert.deepEqual(await c.call(command), { kind: "error", code: "API_RATE_LIMITED", retriableAfterMs: 1000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 1100));
    await f.whenIdle();
    assert.equal(c.sent.length, 1); assert.equal(f.admissions.length, 1);
    assert.equal(f.store.controls.transactions, 0); assert.deepEqual(f.store.snapshot(), before);
    assert.deepEqual(await c.call(command), { kind: "error", code: "API_RATE_LIMITED", retriableAfterMs: 1000 });
    assert.equal(c.sent.length, 2); assert.equal(f.admissions.length, 2);
  }, { admit: async () => ({ allowed: false, retryAfterSeconds: 1 }) });
});
