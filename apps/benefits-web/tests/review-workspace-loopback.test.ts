import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewWorkspace, type ReviewWorkspace } from "../src/domain/review-client/workspace.ts";
import { createReviewPreviewRequest, createReviewConfirmRequest, createReviewDeleteRequest,
  createReviewGetRequest, type ReviewRequest } from "../src/domain/review-client/requests.ts";
import { startReviewLoopback, type ReviewLoopbackFixture } from "./support/review-http-loopback.ts";
import { CANDIDATE_ID, SERVICE_ID, REVIEW_OWNER, reviewValues, benefitCollectionRevisionKey } from "./support/review-memory-store.ts";

// Real native Node Fetch over loopback with actual internal review handler and
// synthetic serialized memory/session. No browser-cookie/auth/DB/provider proof.
type Lease = NonNullable<ReturnType<ReviewWorkspace["activate"]>>;
type Result = Awaited<ReturnType<ReviewWorkspace["execute"]>>;
const nativeFetch = globalThis.fetch;
async function fixture(run: (f: ReviewLoopbackFixture, workspace: ReviewWorkspace,
  sent: Array<{ path: string; body: string }>) => Promise<void>) {
  const f = await startReviewLoopback(); let workspace: ReviewWorkspace | undefined;
  const sent: Array<{ path: string; body: string }> = [];
  try {
    workspace = createReviewWorkspace({ clocks: () => ({ wall: f.store.controls.now, monotonic: 0 }),
      client: { origin: f.origin, fetch: async (request, signal) => {
        assert.equal(request.headers.has("cookie"), false); assert.equal(request.headers.has("authorization"), false);
        assert.equal(request.credentials, "same-origin"); assert.equal(request.redirect, "error");
        sent.push({ path: new URL(request.url).pathname, body: await request.clone().text() });
        const headers = new Headers(request.headers);
        headers.set("origin", f.origin); headers.set("cookie", "synthetic-session=fixture");
        return nativeFetch(new Request(request, { headers, signal }), { signal });
      } } });
    await run(f, workspace, sent);
  } finally { workspace?.dispose(); await f.close(); assert.equal(f.openSockets, 0); }
}
function open(workspace: ReviewWorkspace) {
  const lease = workspace.activate({ bindingId: "synthetic-loopback", dataGeneration: 1 }); assert.ok(lease); return lease;
}
function prepare(workspace: ReviewWorkspace, lease: Lease, request: ReviewRequest) {
  const result = workspace.prepare(lease, request); assert.equal(result.kind, "prepared");
  if (result.kind !== "prepared") throw Error("SYNTHETIC_PREPARE_FAILED"); return result.command;
}
function success(result: Result) { assert.equal(result.kind, "success", JSON.stringify(result));
  if (result.kind !== "success") throw Error("SYNTHETIC_SUCCESS_EXPECTED"); return result.success; }
async function preview(workspace: ReviewWorkspace, lease: Lease) {
  const request = createReviewPreviewRequest(CANDIDATE_ID, 1, SERVICE_ID, 1,
    reviewValues({ remainingAmount: 0, expiresAt: "2020-02-29", observedAt: "2026-09-27T12:34:56.123456789+09:00" }));
  const result = success(await workspace.execute(lease, prepare(workspace, lease, request)));
  assert.ok(result.kind === "preview"); return result.preview;
}
async function confirm(workspace: ReviewWorkspace, lease: Lease) {
  const shown = await preview(workspace, lease);
  const command = prepare(workspace, lease, createReviewConfirmRequest(shown.previewId, "synthetic-workspace-confirm"));
  const result = success(await workspace.execute(lease, command)); assert.ok(result.kind === "view" && result.view.outcome === "saved");
  return { command, view: result.view };
}
function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Error("SYNTHETIC_WORKSPACE_TIMEOUT")), 3000);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

test("actual HTTP confirmation updates list and clears matching preview; original retries track current tombstone", async () => {
  await fixture(async (f, workspace, sent) => {
    const lease = open(workspace), saved = await confirm(workspace, lease);
    assert.equal(workspace.getSnapshot()?.preview.phase, "idle");
    assert.equal(workspace.getSnapshot()?.list.phase, "restart_required");
    assert.deepEqual(workspace.getSnapshot()?.list.entries, [saved.view]);
    assert.equal(saved.view.content.values.remainingAmount, 0);
    assert.equal(saved.view.content.values.expiresAt, "2020-02-29");
    assert.equal(saved.view.content.values.observedAt, "2026-09-27T12:34:56.123456789+09:00");
    assert.equal(saved.view.content.currentBalanceProof, "not-established");
    assert.deepEqual(await workspace.nextPage(lease), { kind: "unavailable" });
    assert.equal(workspace.restartList(lease, workspace.getSnapshot()!.list), true);
    assert.equal((await workspace.nextPage(lease)).kind, "success");
    assert.deepEqual(workspace.getSnapshot()?.list.entries, [saved.view]);
    const removal = prepare(workspace, lease, createReviewDeleteRequest(saved.view.benefitId, saved.view.benefitRevision, "synthetic-workspace-delete"));
    const deleted = success(await workspace.execute(lease, removal)); assert.ok(deleted.kind === "view" && deleted.view.outcome === "deleted");
    const committed = f.store.snapshot();
    assert.deepEqual(success(await workspace.execute(lease, saved.command)), deleted);
    assert.deepEqual(success(await workspace.execute(lease, removal)), deleted);
    assert.deepEqual(workspace.getSnapshot()?.list.entries, [deleted.view]);
    assert.deepEqual(f.store.snapshot(), committed); assert.deepEqual(sent[1], sent[4]); assert.deepEqual(sent[3], sent[5]);
    assert.equal(f.store.rows.operations.size, 2); assert.equal(sent.length, 6);
  });
});

test("pagination is bounded to fifty and owns its cursor; collection change demands explicit refresh", async () => {
  await fixture(async (f, workspace, sent) => {
    const lease = open(workspace); await confirm(workspace, lease);
    const row = [...f.store.rows.benefits.values()][0]!;
    // Synthetic seeding tests pagination without manufacturing 51 confirmations.
    for (let i = 0; i < 51; i++) {
      const id = `synthetic-seeded-${String(i).padStart(3, "0")}`;
      f.store.rows.benefits.set(id, { ...structuredClone(row), id });
    }
    f.store.rows.benefitsRevisions.set(benefitCollectionRevisionKey(REVIEW_OWNER, 1), 53);
    workspace.restartList(lease, workspace.getSnapshot()!.list);
    assert.equal((await workspace.nextPage(lease)).kind, "success");
    assert.equal(workspace.getSnapshot()?.list.entries.length, 50); assert.equal(workspace.getSnapshot()?.list.phase, "more");
    assert.equal((await workspace.nextPage(lease)).kind, "success");
    assert.equal(workspace.getSnapshot()?.list.entries.length, 52); assert.equal(workspace.getSnapshot()?.list.phase, "end_observed");
    const first = JSON.parse(sent[2]!.body), second = JSON.parse(sent[3]!.body);
    assert.deepEqual(first, { limit: 50, cursor: null }); assert.equal(second.limit, 50);
    assert.equal(second.cursor.benefitCollectionRevision, 53); assert.equal(second.cursor.dataGeneration, 1);
    workspace.restartList(lease, workspace.getSnapshot()!.list); await workspace.nextPage(lease);
    f.store.rows.benefitsRevisions.set(benefitCollectionRevisionKey(REVIEW_OWNER, 1), 54);
    assert.deepEqual(await workspace.nextPage(lease), { kind: "error", code: "API_CONFLICT", retriableAfterMs: null });
    assert.equal(workspace.getSnapshot()?.list.phase, "restart_required"); assert.equal(workspace.getSnapshot()?.list.entries.length, 50);
    const requests = sent.length; assert.deepEqual(await workspace.nextPage(lease), { kind: "unavailable" }); assert.equal(sent.length, requests);
  });
});

test("postcommit acknowledgement loss can explicitly retry original confirmation after list refresh and preview clear", async () => {
  await fixture(async (f, workspace, sent) => {
    const lease = open(workspace), shown = await preview(workspace, lease);
    const command = prepare(workspace, lease, createReviewConfirmRequest(shown.previewId, "synthetic-workspace-uncertain"));
    f.store.controls.afterCommit = () => { delete f.store.controls.afterCommit; throw Error("SYNTHETIC_PRIVATE_ACK"); };
    assert.deepEqual(await workspace.execute(lease, command), { kind: "error", code: "API_UNAVAILABLE", retriableAfterMs: null });
    assert.equal(workspace.getSnapshot()?.preview.phase, "ready"); assert.equal(workspace.getSnapshot()?.list.entries.length, 0);
    assert.equal(workspace.cancelPreview(lease, workspace.getSnapshot()!.preview), true);
    assert.equal(workspace.restartList(lease, workspace.getSnapshot()!.list), true);
    assert.equal((await workspace.nextPage(lease)).kind, "success"); assert.equal(workspace.getSnapshot()?.list.entries.length, 1);
    const committed = f.store.snapshot();
    const result = success(await workspace.execute(lease, command)); assert.ok(result.kind === "view" && result.view.outcome === "saved");
    assert.equal(workspace.getSnapshot()?.preview.phase, "idle"); assert.equal(workspace.getSnapshot()?.list.phase, "restart_required");
    assert.deepEqual(sent[1], sent[3]); assert.deepEqual(f.store.snapshot(), committed); assert.equal(f.store.rows.operations.size, 1);
  });
});

test("revocation during real postcommit acknowledgement cannot revive old UI or undo committed server state", async () => {
  await fixture(async (f, workspace, sent) => {
    const lease = open(workspace), shown = await preview(workspace, lease);
    const command = prepare(workspace, lease, createReviewConfirmRequest(shown.previewId, "synthetic-workspace-late"));
    const committed = gate(), ack = gate(), finished = gate();
    f.store.controls.afterCommit = async () => { delete f.store.controls.afterCommit; committed.resolve(); await ack.promise; finished.resolve(); };
    const pending = workspace.execute(lease, command); void pending.catch(() => undefined);
    try {
      await bounded(committed.promise); const rows = f.store.snapshot(), rollbacks = f.store.controls.rollbacks;
      workspace.deactivate(lease); assert.equal(workspace.getSnapshot(), null);
      assert.deepEqual(await bounded(pending), { kind: "stale" }); await f.whenIdle();
      assert.ok(f.disconnects > 0); assert.equal(f.completedStatuses.at(-1), 408);
      const fresh = open(workspace); assert.deepEqual(await workspace.execute(fresh, command), { kind: "stale" });
      const pageResult = workspace.nextPage(fresh); void pageResult.catch(() => undefined);
      ack.resolve(); await bounded(finished.promise);
      assert.equal((await bounded(pageResult)).kind, "success"); assert.equal(workspace.getSnapshot()?.list.entries.length, 1);
      assert.equal(workspace.getSnapshot()?.preview.phase, "idle"); assert.deepEqual(f.store.snapshot(), rows);
      assert.equal(f.store.controls.rollbacks, rollbacks); assert.equal(sent.length, 3);
    } finally { ack.resolve(); delete f.store.controls.afterCommit; await bounded(pending.then(() => undefined, () => undefined)); }
  });
});

test("a stale get cannot replace a fresh workspace display over actual HTTP", async () => {
  await fixture(async (_f, workspace, sent) => {
    const lease = open(workspace), saved = await confirm(workspace, lease);
    const get = prepare(workspace, lease, createReviewGetRequest(saved.view.benefitId));
    const fresh = open(workspace), before = workspace.getSnapshot();
    assert.deepEqual(await workspace.execute(fresh, get), { kind: "stale" }); assert.equal(workspace.getSnapshot(), before);
    assert.equal(sent.length, 2); assert.equal((await workspace.nextPage(fresh)).kind, "success");
    assert.equal(workspace.getSnapshot()?.list.entries[0]?.benefitId, saved.view.benefitId);
  });
});
