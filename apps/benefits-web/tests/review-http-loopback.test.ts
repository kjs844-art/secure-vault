import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeReviewPreviewView } from "../src/domain/review-preview-view.ts";
import { decodeReviewedBenefitView } from "../src/domain/reviewed-benefit-view.ts";
import { decodeReviewedBenefitPage } from "../src/domain/reviewed-benefit-page.ts";
import type { ReviewHttpError } from "../src/server/http/review-http-contracts.ts";
import { CANDIDATE_ID, candidateRow, REVIEW_NOW, reviewValues, SERVICE_ID, SYNTHETIC_PRIVATE }
  from "./support/review-memory-store.ts";
import { reviewLoopbackRequest, reviewPermit, startReviewLoopback,
  type ReviewLoopbackFixture, type ReviewLoopbackOptions } from "./support/review-http-loopback.ts";

// Actual Node Fetch + loopback sockets + unmounted handler, with only synthetic
// memory/session/permit adapters. No production route, real auth, TLS, browser,
// durable DB isolation or current provider/account/balance evidence is claimed.
const PRIVATE_KEYS = new Set(["ownerId", "sessionId", "sessionRevision", "cookie", "authority", "source",
  "candidateId", "candidateRevision", "mailboxBindingId", "analysisOperationId", "policyVersion",
  "operationId", "replayed", "candidateIndex", "recipientId", "grantId"]);
function noPrivateFields(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(PRIVATE_KEYS.has(key), false, `private wire field: ${key}`);
    noPrivateFields(child);
  }
}
async function readJson(response: Response): Promise<Record<string, unknown>> {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal([...response.headers.keys()].some((key) => key.startsWith("access-control-allow")), false);
  const text = await response.text();
  for (const hidden of [SYNTHETIC_PRIVATE, "synthetic-owner", "synthetic-session", "synthetic-mailbox",
    "synthetic-analysis-operation", CANDIDATE_ID]) assert.equal(text.includes(hidden), false, hidden);
  const body = JSON.parse(text) as Record<string, unknown>;
  noPrivateFields(body);
  return body;
}
async function success(response: Response): Promise<unknown> {
  const body = await readJson(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(Object.keys(body).sort(), ["ok", "value"]); assert.equal(body.ok, true);
  return body.value;
}
async function failure(response: Response, code: ReviewHttpError, status: number): Promise<void> {
  assert.equal(response.status, status);
  assert.deepEqual(await readJson(response), { ok: false, code });
}
async function withFixture(run: (fixture: ReviewLoopbackFixture) => Promise<void>, options: ReviewLoopbackOptions = {}) {
  const fixture = await startReviewLoopback(options);
  try { await run(fixture); }
  finally { await fixture.close(); assert.equal(fixture.openSockets, 0); }
}
function post(fixture: ReviewLoopbackFixture, action: string, command: unknown) {
  return reviewLoopbackRequest(fixture, { path: `/api/review/${action}`, body: JSON.stringify(command) });
}
function draft(candidateId = CANDIDATE_ID) {
  return { candidateId, candidateRevision: 1, serviceId: SERVICE_ID, serviceRevision: 1,
    values: reviewValues({ remainingAmount: 0, observedAt: "2026-09-27T12:34:56.123456789+09:00",
      expiresAt: "2020-02-29" }) };
}
async function preview(f: ReviewLoopbackFixture, candidateId = CANDIDATE_ID) {
  const result = decodeReviewPreviewView(await success(await post(f, "preview", draft(candidateId))));
  assert.ok(result); return result;
}
async function confirm(f: ReviewLoopbackFixture, candidateId = CANDIDATE_ID, suffix = "one") {
  const shown = await preview(f, candidateId);
  const command = { previewId: shown.previewId, operationId: `synthetic-confirm-${suffix}`, decision: "confirm" };
  const result = decodeReviewedBenefitView(await success(await post(f, "confirm", command)));
  assert.ok(result && result.outcome === "saved");
  return { shown, command, result };
}
function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`synthetic barrier expired: ${label}`)), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

test("review fixture owns an ephemeral loopback server and cleanup acknowledges its actual sockets", async () => {
  const f = await startReviewLoopback();
  try {
    const url = new URL(f.origin);
    assert.equal(url.hostname, "127.0.0.1"); assert.ok(Number(url.port) > 0);
    const page = decodeReviewedBenefitPage(await success(await post(f, "list", { cursor: null, limit: 50 })));
    assert.ok(page); assert.deepEqual(page.benefits, []); assert.equal(page.nextCursor, null);
    await f.whenIdle();
    assert.deepEqual(f.completedStatuses, [200]);
    assert.ok(f.openSockets > 0);
  } finally { await f.close(); }
  assert.equal(f.openSockets, 0); await f.close();
});

test("actual HTTP preview/confirm/get/list/delete and same-confirm replay expose only minimized browser DTOs", async () => {
  await withFixture(async (f) => {
    const saved = await confirm(f);
    assert.equal(saved.shown.content.sourceObservedAt, null);
    assert.equal(saved.shown.content.values.observedAt, draft().values.observedAt);
    assert.equal(saved.shown.content.valueOrigins.remainingAmount, "user-corrected");
    assert.equal(saved.result.content.values.remainingAmount, 0);
    assert.equal(saved.result.content.values.expiresAt, "2020-02-29");
    assert.equal(saved.result.content.currentBalanceProof, "not-established");
    const got = decodeReviewedBenefitView(await success(await post(f, "get", { benefitId: saved.result.benefitId })));
    assert.deepEqual(got, saved.result);
    const listed = decodeReviewedBenefitPage(await success(await post(f, "list", { cursor: null, limit: 50 })));
    assert.ok(listed); assert.deepEqual(listed.benefits, [saved.result]); assert.equal(listed.nextCursor, null);
    const removed = decodeReviewedBenefitView(await success(await post(f, "delete", {
      benefitId: saved.result.benefitId, expectedRevision: saved.result.benefitRevision,
      operationId: "synthetic-remove-one", decision: "delete",
    })));
    assert.ok(removed && removed.outcome === "deleted");
    assert.equal(removed.content, null); assert.equal(removed.benefitRevision, saved.result.benefitRevision + 1);
    const beforeReplay = f.store.snapshot(), admissions = f.admissions.length;
    const replay = decodeReviewedBenefitView(await success(await post(f, "confirm", saved.command)));
    assert.deepEqual(replay, removed, "same original command returns the current deleted state");
    assert.deepEqual(f.store.snapshot(), beforeReplay, "replay does not create a second row or operation");
    assert.equal(f.admissions.length, admissions + 1, "explicit retry still requires independent admission");
    const afterDelete = decodeReviewedBenefitView(await success(await post(f, "get", { benefitId: removed.benefitId })));
    assert.deepEqual(afterDelete, removed);
    const empty = decodeReviewedBenefitPage(await success(await post(f, "list", { cursor: null, limit: 50 })));
    assert.ok(empty); assert.deepEqual(empty.benefits, []);
    assert.equal(f.store.rows.benefits.size, 1); assert.equal(f.store.rows.operations.size, 2);
    assert.ok(f.admissions.every(({ request }) => request.surface === "review-v1"));
  });
});

test("actual HTTP reject revokes its preview without a benefit write and later confirm conflicts", async () => {
  await withFixture(async (f) => {
    const shown = await preview(f);
    const rejected = await success(await post(f, "reject", {
      previewId: shown.previewId, expectedRevision: shown.previewRevision, decision: "reject",
    }));
    assert.deepEqual(rejected, { previewId: shown.previewId, state: "revoked" });
    const before = f.store.snapshot();
    await failure(await post(f, "confirm", { previewId: shown.previewId,
      operationId: "synthetic-rejected-confirm", decision: "confirm" }), "API_CONFLICT", 409);
    assert.deepEqual(f.store.snapshot(), before);
    assert.equal(f.store.rows.benefits.size, 0); assert.equal(f.store.rows.operations.size, 0);
  });
});

test("a deletion invalidates the earlier HTTP page cursor instead of silently skipping or rewriting observations", async () => {
  await withFixture(async (f) => {
    await confirm(f);
    const secondId = "synthetic-second-candidate";
    f.store.rows.candidates.set(secondId, candidateRow({ id: secondId }));
    await confirm(f, secondId, "two");
    const firstPage = decodeReviewedBenefitPage(await success(await post(f, "list", { cursor: null, limit: 1 })));
    assert.ok(firstPage && firstPage.nextCursor); assert.equal(firstPage.benefits.length, 1);
    const first = firstPage.benefits[0]!;
    const removed = decodeReviewedBenefitView(await success(await post(f, "delete", {
      benefitId: first.benefitId, expectedRevision: first.benefitRevision,
      operationId: "synthetic-cursor-delete", decision: "delete",
    })));
    assert.ok(removed && removed.outcome === "deleted");
    const afterDelete = f.store.snapshot();
    const rowReads = f.store.controls.trace.filter((name) => name === "listReviewedBenefits").length;
    await failure(await post(f, "list", { cursor: firstPage.nextCursor, limit: 1 }), "API_CONFLICT", 409);
    assert.equal(f.store.controls.trace.filter((name) => name === "listReviewedBenefits").length, rowReads);
    assert.deepEqual(f.store.snapshot(), afterDelete);
    const fresh = decodeReviewedBenefitPage(await success(await post(f, "list", { cursor: null, limit: 50 })));
    assert.ok(fresh); assert.equal(fresh.benefits.length, 1);
    assert.notEqual(fresh.benefits[0]!.benefitId, removed.benefitId);
    assert.equal(fresh.benefitCollectionRevision, firstPage.benefitCollectionRevision + 1);
    assert.equal(firstPage.benefits[0]!.outcome, "saved", "already returned observations are not retroactively erased");
  });
});

test("cross-origin, wrong marker and unsupported request forms reject before session/admission/storage", async () => {
  await withFixture(async (f) => {
    const before = f.store.snapshot();
    for (const headers of [
      { origin: "https://synthetic-other.invalid" }, { origin: f.origin + "/" },
      { "x-keyatlas-request": "catalog-v1" }, { "x-keyatlas-request": "" },
      { "sec-fetch-site": "cross-site" }, { authorization: "synthetic-unsupported" },
    ]) await failure(await reviewLoopbackRequest(f, { headers, body: JSON.stringify(draft()),
      path: "/api/review/preview" }), "API_REQUEST_REJECTED", 403);
    await failure(await reviewLoopbackRequest(f, { path: "/api/review/list?limit=1" }), "API_REQUEST_REJECTED", 403);
    await failure(await reviewLoopbackRequest(f, { method: "GET" }), "API_METHOD_NOT_ALLOWED", 405);
    await failure(await reviewLoopbackRequest(f, { path: "/api/review/unknown" }), "API_NOT_FOUND", 404);
    await failure(await reviewLoopbackRequest(f, { headers: { cookie: "" } }), "API_AUTH_REQUIRED", 401);
    assert.equal(f.sessions.length, 0); assert.equal(f.admissions.length, 0);
    assert.equal(f.store.controls.transactions, 0); assert.deepEqual(f.store.snapshot(), before);
  });
});

test("a catalog-surface permit cannot admit a review request even with matching action/request/authority", async () => {
  await withFixture(async (f) => {
    const before = f.store.snapshot();
    await failure(await post(f, "preview", draft()), "API_UNAVAILABLE", 503);
    assert.equal(f.admissions.length, 1); assert.equal(f.admissions[0]!.request.surface, "review-v1");
    assert.equal(f.store.controls.transactions, 0); assert.deepEqual(f.store.snapshot(), before);
  }, { admit: async (request) => ({ ...reviewPermit(request), surface: "catalog-v1" }) });
});

test("real body framing preserves bounded JSON/media rejections without writes", async () => {
  await withFixture(async (f) => {
    const before = f.store.snapshot();
    await failure(await reviewLoopbackRequest(f, { path: "/api/review/preview",
      headers: { "content-type": "text/plain" }, body: JSON.stringify(draft()) }), "API_MEDIA_TYPE", 415);
    await failure(await reviewLoopbackRequest(f, { path: "/api/review/preview", body: "{" }), "API_INPUT_INVALID", 400);
    await failure(await reviewLoopbackRequest(f, { path: "/api/review/preview",
      body: JSON.stringify({ ...draft(), extra: "x".repeat(17000) }) }), "API_BODY_TOO_LARGE", 413);
    assert.equal(f.store.controls.transactions, 0); assert.deepEqual(f.store.snapshot(), before);
  });
});

test("genuine HTTP disconnect before admission aborts the server signal and a late permit cannot write",
  { timeout: 15000 }, async () => {
    const entered = barrier<AbortSignal>(), aborted = barrier<void>(), gate = barrier<void>(), returned = barrier<void>();
    let first = true, removeListener = () => {};
    const f = await startReviewLoopback({ requestTimeoutMs: 10000,
      admit: async (request, signal) => {
        if (first) {
          first = false;
          const observe = () => aborted.resolve();
          signal.addEventListener("abort", observe, { once: true });
          removeListener = () => signal.removeEventListener("abort", observe);
          entered.resolve(signal);
          if (signal.aborted) observe();
          await gate.promise;
          returned.resolve(); // The adapter return, not a commit or rollback claim.
        }
        return reviewPermit(request);
      },
    });
    const controller = new AbortController(), before = f.store.snapshot();
    let pending: Promise<Response> | undefined;
    let outcome: Promise<"response" | "rejected"> | undefined;
    try {
      const start = performance.now();
      pending = reviewLoopbackRequest(f, { path: "/api/review/preview", body: JSON.stringify(draft()),
        signal: controller.signal });
      outcome = pending.then(() => "response" as const, () => "rejected" as const);
      const signal = await bounded(entered.promise, 2000, "admission entry");
      assert.equal(signal.aborted, false); assert.equal(f.store.controls.transactions, 0);
      controller.abort();
      assert.equal(await bounded(outcome, 2000, "native fetch cancellation"), "rejected");
      await bounded(aborted.promise, 2000, "server signal observes socket disconnect");
      assert.ok(performance.now() - start < 8000, "server 10-second deadline cannot explain the signal");
      assert.equal(signal.aborted, true); assert.equal(f.disconnects, 1);
      assert.equal(f.admissions.length, 1); assert.equal(f.store.controls.transactions, 0);
      assert.deepEqual(f.store.snapshot(), before);
      await f.whenIdle();
      assert.deepEqual(f.completedStatuses, [408], "handler completion is observed before releasing the held permit");

      gate.resolve();
      await bounded(returned.promise, 1000, "late admission returned");
      await f.whenIdle();
      // A fresh, non-mutating server roundtrip observes a later event boundary.
      // The unfinished adapter above was observed returning independently; a
      // whenIdle result alone is not a claim about arbitrary detached promises.
      await failure(await reviewLoopbackRequest(f, { headers: { cookie: "" } }), "API_AUTH_REQUIRED", 401);
      assert.equal(f.admissions.length, 1); assert.equal(f.sessions.length, 1);
      assert.equal(f.store.controls.transactions, 0); assert.equal(f.store.controls.commits, 0);
      assert.equal(f.store.controls.rollbacks, 0); assert.deepEqual(f.store.controls.trace, []);
      assert.deepEqual(f.store.snapshot(), before);

      const retry = await preview(f); // Explicit retry only, not automatic retry.
      assert.equal(retry.content.currentBalanceProof, "not-established");
      assert.equal(f.admissions.length, 2); assert.equal(f.store.controls.transactions, 1);
      assert.equal(f.store.rows.previews.size, 1); assert.equal(f.store.rows.benefits.size, 0);
      assert.equal(f.store.rows.operations.size, 0); assert.ok(retry.expiresAt > REVIEW_NOW);
    } finally {
      controller.abort(); gate.resolve(); removeListener();
      try { if (outcome) await bounded(outcome, 2000, "owned fetch cleanup"); }
      finally { await f.close(); assert.equal(f.openSockets, 0); }
    }
  });
