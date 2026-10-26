import assert from "node:assert/strict";
import { test } from "node:test";
import { PREVIEW_TTL_MS, type ReviewResult } from "../src/server/review/contracts.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import {
  CANDIDATE_ID, REVIEW_NOW, SERVICE_ID, createReviewMemoryStore, reviewAuthority, reviewValues,
} from "./support/review-memory-store.ts";

// Synthetic in-memory composition only. Response refusal never proves that an
// already committed preview, confirmation, rejection or deletion was rolled back.
const draft = () => ({ candidateId: CANDIDATE_ID, candidateRevision: 1,
  serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues() });
const SESSION_END = REVIEW_NOW + 90000;
type Action = "preview" | "confirm" | "reject" | "remove" | "confirm-replay" | "remove-replay";
function success<T>(result: ReviewResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

async function finalClockFixture(action: Action, finalTime: number, sessionEnd = SESSION_END) {
  const store = createReviewMemoryStore();
  store.controls.authority = reviewAuthority({ expiresAt: sessionEnd });
  const base = store.dependencies;
  const setup = createReviewService(base);
  let request: unknown = draft();
  if (action !== "preview") {
    const preview = success(await setup.preview(draft()));
    const confirmation = { previewId: preview.id, operationId: "synthetic-final-confirm", decision: "confirm" };
    request = action === "reject"
      ? { previewId: preview.id, expectedRevision: preview.revision, decision: "reject" }
      : confirmation;
    if (action === "remove" || action === "confirm-replay" || action === "remove-replay") {
      const saved = success(await setup.confirm(confirmation));
      if (action !== "confirm-replay") {
        request = { benefitId: saved.benefitId, expectedRevision: saved.benefitRevision,
          operationId: "synthetic-final-delete", decision: "delete" };
        if (action === "remove-replay") success(await setup.remove(request));
      }
    }
  }
  const before = store.snapshot();
  const commitsBefore = store.controls.commits;
  const rollbacksBefore = store.controls.rollbacks;
  let committed = false;
  let committedSnapshot: ReturnType<typeof store.snapshot> | undefined;
  let armed = false;
  let guardClockRead = false;
  let finalClockReads = 0;
  const events: string[] = [];
  store.controls.afterCommit = () => {
    committed = true;
    committedSnapshot = store.snapshot();
    events.push("committed");
  };
  const service = createReviewService({
    ...base,
    readAuthority: async () => {
      const authority = await base.readAuthority();
      if (committed) {
        assert.equal(armed, false, "expected exactly one final authority guard");
        armed = true;
        events.push("final-authority");
      }
      return authority;
    },
    now: () => {
      if (!armed) return base.now();
      if (!guardClockRead) {
        guardClockRead = true;
        events.push("guard-clock");
        return base.now();
      }
      finalClockReads++;
      events.push("final-clock");
      return finalTime;
    },
  });
  const run = (): Promise<ReviewResult<unknown>> => {
    if (action === "preview") return service.preview(request);
    if (action === "reject") return service.reject(request);
    if (action === "confirm" || action === "confirm-replay") return service.confirm(request);
    return service.remove(request);
  };
  const assertFinalBoundary = () => {
    assert.deepEqual(events, ["committed", "final-authority", "guard-clock", "final-clock"]);
    assert.equal(finalClockReads, 1, "the final clock sample must actually be exercised once");
    assert.equal(store.controls.commits, commitsBefore + 1);
    assert.equal(store.controls.rollbacks, rollbacksBefore, "response refusal is not rollback");
    assert.ok(committedSnapshot);
    assert.deepEqual(store.snapshot(), committedSnapshot, "response refusal must preserve the committed snapshot");
    if (action.endsWith("-replay")) assert.deepEqual(store.snapshot(), before, "replay must not rewrite rows");
    const candidate = store.rows.candidates.get(CANDIDATE_ID)!;
    const preview = [...store.rows.previews.values()][0]!;
    assert.equal(store.rows.previews.size, 1);
    if (action === "preview" || action === "reject") {
      assert.equal(candidate.state, "pending");
      assert.equal(store.rows.benefits.size, 0);
      assert.equal(store.rows.operations.size, 0);
      assert.equal(preview.state, action === "preview" ? "pending" : "revoked");
      if (action === "reject") assert.equal(preview.content, null);
    } else {
      const deleted = action === "remove" || action === "remove-replay";
      const benefit = [...store.rows.benefits.values()][0]!;
      assert.equal(store.rows.benefits.size, 1);
      assert.equal(store.rows.operations.size, deleted ? 2 : 1);
      assert.equal(candidate.state, deleted ? "deleted" : "accepted");
      assert.equal(preview.state, deleted ? "deleted" : "consumed");
      assert.equal(benefit.state, deleted ? "deleted" : "live");
      if (deleted) {
        assert.equal(candidate.content, null);
        assert.equal(preview.content, null);
        assert.equal(benefit.content, null);
      } else assert.equal(benefit.content!.values.name, "Synthetic credits");
    }
  };
  return { run, assertFinalBoundary };
}

for (const action of ["preview", "confirm", "reject", "remove", "confirm-replay", "remove-replay"] as const) {
  for (const boundary of ["exact-session-expiry", "clock-regression"] as const) {
    test(`${action} refuses output at ${boundary} after a valid final guard without undoing commit`, async () => {
      const fixture = await finalClockFixture(action, boundary === "exact-session-expiry" ? SESSION_END : REVIEW_NOW - 1);
      const result = await fixture.run();
      fixture.assertFinalBoundary();
      assert.deepEqual(result, { ok: false, code: "REVIEW_AUTHORITY_CHANGED" });
      assert.ok(Object.isFrozen(result));
      assert.equal(Object.hasOwn(result, "value"), false);
      assert.equal(JSON.stringify(result).includes("Synthetic credits"), false);
    });
  }
  test(`${action} still acknowledges one millisecond before session expiry`, async () => {
    const fixture = await finalClockFixture(action, SESSION_END - 1);
    const result = await fixture.run();
    fixture.assertFinalBoundary();
    const value = success(result) as Record<string, unknown>;
    assert.ok(Object.isFrozen(result));
    if (action.endsWith("-replay")) assert.equal(value.replayed, true);
    if (action === "remove" || action === "remove-replay") assert.equal(value.content, null);
  });
}

test("an earlier preview deadline still refuses output while the app session remains valid", async () => {
  const fixture = await finalClockFixture("preview", REVIEW_NOW + PREVIEW_TTL_MS, REVIEW_NOW + PREVIEW_TTL_MS + 90000);
  const result = await fixture.run();
  fixture.assertFinalBoundary();
  assert.deepEqual(result, { ok: false, code: "REVIEW_PREVIEW_EXPIRED" });
});
