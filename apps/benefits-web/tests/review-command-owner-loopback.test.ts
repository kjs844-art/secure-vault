import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewCommandOwner } from "../src/domain/review-client/command-owner.ts";
import { createReviewPreviewRequest, createReviewConfirmRequest, createReviewRejectRequest,
  createReviewDeleteRequest, createReviewGetRequest, createReviewListRequest, type ReviewRequest } from "../src/domain/review-client/requests.ts";
import { CANDIDATE_ID, SERVICE_ID, REVIEW_OWNER, reviewValues, SYNTHETIC_PRIVATE,
  benefitCollectionRevisionKey } from "./support/review-memory-store.ts";
import { startReviewLoopback, type ReviewLoopbackFixture } from "./support/review-http-loopback.ts";

// SYNTHETIC ONLY. Real command owner -> client -> native Node Fetch -> ephemeral
// loopback handler, with serialized memory and fake session/admission ports.
// Only the injected test transport supplies Cookie and Origin: no browser-cookie,
// real identity, live route, durable DB or remote rollback claim follows.
type Owner = ReturnType<typeof createReviewCommandOwner>;
type Lease = NonNullable<ReturnType<Owner["activate"]>>;
type Command = Extract<ReturnType<Owner["prepare"]>, { kind: "prepared" }>["command"];
type Result = Awaited<ReturnType<Owner["execute"]>>;
const nativeFetch = globalThis.fetch;

function ownerFixture(f: ReviewLoopbackFixture) {
  const sent: Array<{ url: string; body: string }> = [];
  const owner = createReviewCommandOwner({ origin: f.origin, now: () => f.store.controls.now,
    fetch: async (request, signal) => {
      assert.equal(new URL(request.url).origin, f.origin);
      assert.equal(request.method, "POST");
      assert.equal(request.credentials, "same-origin");
      assert.equal(request.redirect, "error");
      assert.equal(request.headers.get("x-keyatlas-request"), "review-v1");
      assert.equal(request.headers.has("cookie"), false);
      assert.equal(request.headers.has("origin"), false);
      assert.equal(request.headers.has("authorization"), false);
      sent.push({ url: request.url, body: await request.clone().text() });
      const headers = new Headers(request.headers);
      headers.set("cookie", "synthetic-session=fixture");
      headers.set("origin", f.origin);
      return nativeFetch(new Request(request, { headers, signal }), { signal });
    },
  });
  return { owner, sent };
}
async function withFixture(run: (f: ReviewLoopbackFixture, c: ReturnType<typeof ownerFixture>) => Promise<void>) {
  const f = await startReviewLoopback();
  let c: ReturnType<typeof ownerFixture> | undefined;
  try { c = ownerFixture(f); await run(f, c); }
  finally {
    c?.owner.dispose();
    await f.close();
    assert.equal(f.openSockets, 0);
  }
}
function activate(owner: Owner): Lease {
  const lease = owner.activate(1);
  assert.ok(lease);
  assert.equal(owner.getSnapshot()?.lease, lease);
  return lease;
}
function prepare(owner: Owner, lease: Lease, request: ReviewRequest): Command {
  const result = owner.prepare(lease, request);
  assert.equal(result.kind, "prepared");
  if (result.kind !== "prepared") throw new Error("SYNTHETIC_EXPECTED_PREPARED");
  assert.ok(Object.isFrozen(result.command));
  return result.command;
}
function success(result: Result) {
  assert.equal(result.kind, "success", JSON.stringify(result));
  if (result.kind !== "success") throw new Error("SYNTHETIC_EXPECTED_SUCCESS");
  assert.ok(Object.isFrozen(result));
  return result.success;
}
function draft() {
  return createReviewPreviewRequest(CANDIDATE_ID, 1, SERVICE_ID, 1,
    reviewValues({ remainingAmount: 0, expiresAt: "2020-02-29", observedAt: "2026-09-27T12:34:56.123456789+09:00" }));
}
async function preview(owner: Owner, lease: Lease) {
  const command = prepare(owner, lease, draft());
  const result = success(await owner.execute(lease, command));
  assert.ok(result.kind === "preview");
  return { command, preview: result.preview };
}
async function confirmed(owner: Owner, lease: Lease) {
  const shown = await preview(owner, lease);
  const request = createReviewConfirmRequest(shown.preview.previewId, "synthetic-owner-confirm");
  const command = prepare(owner, lease, request);
  const result = success(await owner.execute(lease, command));
  assert.ok(result.kind === "view" && result.view.outcome === "saved");
  return { shown, request, command, view: result.view };
}
function failure(result: Result, code: string): void {
  assert.deepEqual(result, { kind: "error", code, retriableAfterMs: null });
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`SYNTHETIC_OWNER_BARRIER_${label}`)), 3000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("opaque owner commands cross actual HTTP through preview/confirm/get/list/delete and current tombstone replay", async () => {
  await withFixture(async (f, { owner, sent }) => {
    const lease = activate(owner), initial = owner.getSnapshot()!, saved = await confirmed(owner, lease);
    assert.equal(saved.view.content.values.remainingAmount, 0);
    assert.equal(saved.view.content.valueOrigins.remainingAmount, "user-corrected");
    assert.equal(saved.view.content.values.observedAt, "2026-09-27T12:34:56.123456789+09:00");
    assert.equal(saved.view.content.accountProof, "not-established");
    const get = prepare(owner, lease, createReviewGetRequest(saved.view.benefitId));
    assert.deepEqual(success(await owner.execute(lease, get)), { kind: "view", view: saved.view });
    const list = prepare(owner, lease, createReviewListRequest(50, null));
    const page = success(await owner.execute(lease, list));
    assert.ok(page.kind === "page");
    assert.deepEqual(page.page.benefits, [saved.view]);
    const deletion = prepare(owner, lease, createReviewDeleteRequest(saved.view.benefitId,
      saved.view.benefitRevision, "synthetic-owner-delete"));
    const removed = success(await owner.execute(lease, deletion));
    assert.ok(removed.kind === "view" && removed.view.outcome === "deleted");
    assert.equal(removed.view.content, null);
    const committed = f.store.snapshot();
    assert.deepEqual(success(await owner.execute(lease, saved.command)), removed);
    assert.deepEqual(success(await owner.execute(lease, deletion)), removed);
    assert.deepEqual(success(await owner.execute(lease, get)), removed);
    const empty = success(await owner.execute(lease, list));
    assert.ok(empty.kind === "page"); assert.deepEqual(empty.page.benefits, []);
    assert.deepEqual(f.store.snapshot(), committed);
    assert.equal(f.store.rows.benefits.size, 1); assert.equal(f.store.rows.operations.size, 2);
    assert.equal(f.store.rows.benefitsRevisions.get(benefitCollectionRevisionKey(REVIEW_OWNER, 1)), 3);
    assert.deepEqual(sent[1], sent[5]); assert.deepEqual(sent[4], sent[6]);
    assert.equal(sent.length, 9); assert.equal(f.admissions.length, 9);
    assert.equal(owner.getSnapshot(), initial, "command results are not an implicit display reducer");
  });
});

test("same-generation replacement rejects never-executed old tokens before HTTP, including foreign leases and forged commands", async () => {
  await withFixture(async (f, { owner, sent }) => {
    const initial = f.store.snapshot(), leaseA = activate(owner), snapshotA = owner.getSnapshot()!;
    const unsentA = prepare(owner, leaseA, draft());
    const leaseB = activate(owner), snapshotB = owner.getSnapshot()!;
    const unsentB = prepare(owner, leaseB, createReviewListRequest(50, null));
    const freshA = activate(owner), snapshotFreshA = owner.getSnapshot()!;
    assert.notEqual(leaseA, leaseB); assert.notEqual(leaseA, freshA);
    assert.notEqual(snapshotA.viewScope, snapshotB.viewScope);
    assert.notEqual(snapshotA.viewScope, snapshotFreshA.viewScope);
    for (const [lease, command] of [[leaseA, unsentA], [leaseB, unsentB], [freshA, unsentA], [freshA, unsentB]] as const) {
      assert.deepEqual(await owner.execute(lease, command), { kind: "stale" });
    }
    assert.deepEqual(await owner.execute(freshA, Object.freeze({})), { kind: "invalid", reason: "REQUEST" });
    const other = ownerFixture(f);
    try {
      const foreignLease = activate(other.owner);
      assert.deepEqual(await owner.execute(foreignLease, unsentA), { kind: "stale" });
      assert.equal(other.sent.length, 0);
    } finally { other.owner.dispose(); }
    assert.equal(sent.length, 0); assert.equal(f.admissions.length, 0);
    assert.equal(f.store.controls.transactions, 0); assert.deepEqual(f.store.snapshot(), initial);
    const fresh = prepare(owner, freshA, createReviewListRequest(50, null));
    const result = await owner.execute(freshA, fresh);
    assert.ok(result.kind === "success");
    assert.deepEqual(result.capturedScope, { viewScope: snapshotFreshA.viewScope, dataGeneration: 1 });
    assert.equal(sent.length, 1);
  });
});

for (const action of ["preview", "reject"] as const) test(`successful ${action} token is one attempt, even after an explicit second execute`, async () => {
  await withFixture(async (f, { owner, sent }) => {
    const lease = activate(owner);
    const request = action === "preview" ? draft()
      : createReviewRejectRequest((await preview(owner, lease)).preview.previewId, 1);
    const command = prepare(owner, lease, request), count = sent.length;
    const result = success(await owner.execute(lease, command));
    assert.equal(result.kind, action === "preview" ? "preview" : "rejected");
    const committed = f.store.snapshot();
    assert.deepEqual(await owner.execute(lease, command), { kind: "consumed" });
    await nextTurn(); await f.whenIdle();
    assert.equal(sent.length, count + 1); assert.equal(f.admissions.length, count + 1);
    assert.deepEqual(f.store.snapshot(), committed);
    assert.equal(f.store.rows.benefits.size, 0); assert.equal(f.store.rows.operations.size, 0);
  });
});

for (const action of ["confirm", "delete"] as const) test(`postcommit ${action} loss retains exactly the prepared command for explicit retry`, async () => {
  await withFixture(async (f, { owner, sent }) => {
    const lease = activate(owner);
    let request: ReviewRequest;
    if (action === "confirm") {
      request = createReviewConfirmRequest((await preview(owner, lease)).preview.previewId, "synthetic-owner-uncertain-confirm");
    } else {
      const saved = await confirmed(owner, lease);
      request = createReviewDeleteRequest(saved.view.benefitId, saved.view.benefitRevision, "synthetic-owner-uncertain-delete");
    }
    const callerCopy = structuredClone(request);
    const command = prepare(owner, lease, callerCopy), expectedBody = JSON.stringify(request.body);
    // Preparing detaches caller data. Neither initial dispatch nor a retry may
    // pick up an edited operation/target from the caller's later mutable object.
    if (callerCopy.action === "confirm" || callerCopy.action === "delete") {
      Object.assign(callerCopy.body, { operationId: "synthetic-changed-after-prepare" });
    }
    const count = sent.length, commits = f.store.controls.commits, rollbacks = f.store.controls.rollbacks;
    let failures = 0;
    f.store.controls.afterCommit = () => {
      failures++; delete f.store.controls.afterCommit; throw new Error(SYNTHETIC_PRIVATE);
    };
    failure(await owner.execute(lease, command), "API_UNAVAILABLE");
    await nextTurn(); await f.whenIdle();
    assert.equal(failures, 1); assert.equal(sent.length, count + 1);
    assert.equal(f.store.controls.commits, commits + 1);
    assert.equal(f.store.controls.rollbacks, rollbacks, "a failed acknowledgement did not undo the commit");
    assert.equal(sent[count]!.body, expectedBody);
    const committed = f.store.snapshot();
    const result = success(await owner.execute(lease, command));
    assert.ok(result.kind === "view"); assert.equal(result.view.outcome, action === "confirm" ? "saved" : "deleted");
    assert.deepEqual(f.store.snapshot(), committed);
    assert.deepEqual(sent[count], sent[count + 1]);
    assert.equal(sent.length, count + 2);
    assert.equal(f.store.rows.operations.size, action === "confirm" ? 1 : 2);
    assert.equal(f.store.rows.benefits.size, 1);
  });
});

for (const action of ["preview", "reject"] as const) test(`uncertain ${action} is consumed locally instead of silently repeating a non-ledger operation`, async () => {
  await withFixture(async (f, { owner, sent }) => {
    const lease = activate(owner);
    const request = action === "preview" ? draft()
      : createReviewRejectRequest((await preview(owner, lease)).preview.previewId, 1);
    const command = prepare(owner, lease, request), count = sent.length;
    f.store.controls.afterCommit = () => { delete f.store.controls.afterCommit; throw new Error(SYNTHETIC_PRIVATE); };
    failure(await owner.execute(lease, command), "API_UNAVAILABLE");
    const committed = f.store.snapshot();
    assert.deepEqual(await owner.execute(lease, command), { kind: "consumed" });
    await nextTurn(); await f.whenIdle();
    assert.equal(sent.length, count + 1);
    assert.deepEqual(f.store.snapshot(), committed);
    assert.equal(f.store.rows.previews.size, 1);
    assert.equal(f.store.rows.benefits.size, 0); assert.equal(f.store.rows.operations.size, 0);
    if (action === "reject") assert.equal([...f.store.rows.previews.values()][0]!.state, "revoked");
  });
});

for (const revoke of ["release", "deactivate"] as const) test(`${revoke} during postcommit acknowledgement hides the old result and late settlement cannot damage the fresh command`, async () => {
  await withFixture(async (f, { owner, sent }) => {
    const lease = activate(owner), shown = await preview(owner, lease);
    const command = prepare(owner, lease, createReviewConfirmRequest(shown.preview.previewId, `synthetic-owner-late-${revoke}`));
    const committed = barrier(), acknowledgement = barrier(), ackReturned = barrier();
    f.store.controls.afterCommit = async () => {
      delete f.store.controls.afterCommit;
      committed.resolve();
      await acknowledgement.promise;
      ackReturned.resolve();
    };
    const pending = owner.execute(lease, command);
    // Attach failure handling before any assertion can abort the test.
    void pending.catch(() => undefined);
    try {
      await bounded(committed.promise, "COMMITTED");
      const rowsAtCommit = f.store.snapshot(), commits = f.store.controls.commits, rollbacks = f.store.controls.rollbacks;
      assert.equal(rowsAtCommit.benefits.size, 1); assert.equal(rowsAtCommit.operations.size, 1);
      assert.deepEqual(await owner.execute(lease, command), { kind: "busy" });
      assert.equal(sent.length, 2);
      if (revoke === "release") owner.release(lease, command);
      else owner.deactivate(lease);
      assert.deepEqual(await bounded(pending, "REVOKED_RESULT"), { kind: "stale" });
      await f.whenIdle(); // The handler can return 408 while its adapter still waits.
      assert.equal(f.store.controls.commits, commits);
      assert.equal(f.store.controls.rollbacks, rollbacks);
      assert.deepEqual(f.store.snapshot(), rowsAtCommit);
      assert.equal(f.completedStatuses.at(-1), 408);
      assert.ok(f.disconnects > 0, "revocation requested cancellation across the actual HTTP connection");
      const currentLease = revoke === "release" ? lease : activate(owner);
      assert.deepEqual(await owner.execute(currentLease, command), { kind: "stale" });
      const fresh = prepare(owner, currentLease, createReviewListRequest(50, null));
      const freshPending = owner.execute(currentLease, fresh);
      void freshPending.catch(() => undefined);
      acknowledgement.resolve();
      await bounded(ackReturned.promise, "ACK_RETURNED");
      const currentResult = success(await bounded(freshPending, "FRESH_LIST"));
      assert.ok(currentResult.kind === "page");
      assert.equal(currentResult.page.benefits.length, 1);
      assert.equal(currentResult.page.benefits[0]!.outcome, "saved");
      assert.deepEqual(f.store.snapshot(), rowsAtCommit,
        "the fresh read also crosses the serialized transaction queue after the old acknowledgement finishes");
      assert.equal(sent.length, 3);
      assert.equal(owner.getSnapshot()?.lease, currentLease);
    } finally {
      acknowledgement.resolve();
      delete f.store.controls.afterCommit;
      await bounded(pending.then(() => undefined, () => undefined), "FINAL_PENDING");
    }
  });
});
