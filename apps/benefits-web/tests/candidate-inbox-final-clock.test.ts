import assert from "node:assert/strict";
import { test } from "node:test";
import { createCandidateInbox } from "../src/server/inbox/candidate-inbox.ts";
import { runMailAnalysis, type MailAnalysisAdapters } from "../src/server/mail/run-analysis.ts";
import {
  REVIEW_NOW, analysisAuthority, createReviewMemoryStore, reviewAuthority,
} from "./support/review-memory-store.ts";

// Real runner + inbox orchestration over synthetic in-memory adapters only.
// A final response refusal does not undo an already committed transaction.
async function successfulAnalysis() {
  const authority = analysisAuthority();
  const adapters: MailAnalysisAdapters = {
    readAuthority: async () => ({ ...authority, grantOwnerId: authority.ownerId,
      grantSessionId: authority.sessionId, grantMailboxBindingId: authority.mailboxBindingId }),
    reserveQuota: async ({ authority: current }) => ({ status: "granted", ownerId: current.ownerId,
      sessionId: current.sessionId, sessionRevision: current.sessionRevision, dataGeneration: current.dataGeneration,
      mailboxBindingId: current.mailboxBindingId, recipientId: current.recipientId, policyVersion: current.policyVersion,
      grantId: current.grantId, grantRevision: current.grantRevision, operationId: current.operationId, remaining: 0 }),
    readMailbox: async () => JSON.stringify([{ id: "synthetic-mail-id-not-retained",
      snippet: "Synthetic Studio grants 100 credits.", payload: { mimeType: "text/plain",
        headers: [{ name: "Subject", value: "Synthetic Studio notice" }],
        body: { data: Buffer.from("Synthetic Studio grants 100 credits.").toString("base64url") },
      } }]),
    analyze: async () => JSON.stringify({ schema: "keyatlas.gmail-candidates.v1", discoveries: [{
      evidence_message_index: 0, confidence: "high", benefit_kind: "credit",
      service_name: { value: "Synthetic Studio", part: "subject", quote: "Synthetic Studio" },
      benefit_name: { value: "Synthetic credits", part: "body", quote: "grants 100 credits" },
      unit: { value: "credits", part: "body", quote: "100 credits" },
      granted_amount: { value: 100, part: "body", quote: "grants 100 credits" },
      remaining_amount: null, trial_days: null, remaining_days: null, expires_at: null, observed_at: null,
    }] }),
    now: () => REVIEW_NOW,
  };
  const result = await runMailAnalysis(adapters, { operationId: authority.operationId,
    mailboxBindingId: authority.mailboxBindingId, recipientId: authority.recipientId });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.candidates.length, 1);
  return result;
}

type Action = "list" | "discard" | "stage";
async function finalClockFixture(action: Action, finalTime: number) {
  const store = createReviewMemoryStore();
  store.rows.candidates.clear();
  const original = await successfulAnalysis();
  const base = store.inboxDependencies;
  let candidateId: string | null = null;
  if (action !== "stage") {
    const staged = await createCandidateInbox(base).stage(original);
    assert.ok(staged.ok, JSON.stringify(staged));
    candidateId = staged.value.candidates[0]!.id;
  }
  const before = store.snapshot();
  const commitsBefore = store.controls.commits;
  const rollbacksBefore = store.controls.rollbacks;
  let committed = false;
  let postCommitGrantRead = false;
  let armed = false;
  let guardClockRead = false;
  let finalClockReads = 0;
  const events: string[] = [];
  store.controls.afterCommit = () => { committed = true; events.push("committed"); };
  const inbox = createCandidateInbox({
    ...base,
    readAuthority: async () => {
      const authority = await base.readAuthority();
      // Locate the final guard by transaction/grant events, not a global clock
      // or authority-read count. Stage additionally rechecks grants after commit.
      if (committed && (action !== "stage" || postCommitGrantRead)) {
        assert.equal(armed, false, "expected exactly one final authority guard");
        armed = true;
        events.push("final-authority");
      }
      return authority;
    },
    readStagingGrant: async (expected) => {
      const grant = await base.readStagingGrant(expected);
      if (committed) {
        postCommitGrantRead = true;
        events.push("post-commit-stage-grant");
      }
      return grant;
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
  const run = () => action === "stage" ? inbox.stage(original)
    : action === "list" ? inbox.listBatch({ analysisOperationId: analysisAuthority().operationId })
      : inbox.discard({ candidateId, expectedRevision: 1, decision: "discard" });
  const assertFinalBoundary = () => {
    assert.equal(finalClockReads, 1, "the final clock sample must actually be exercised");
    assert.deepEqual(events, action === "stage"
      ? ["committed", "post-commit-stage-grant", "final-authority", "guard-clock", "final-clock"]
      : ["committed", "final-authority", "guard-clock", "final-clock"]);
    assert.equal(store.controls.commits, commitsBefore + 1);
    assert.equal(store.controls.rollbacks, rollbacksBefore, "response refusal is not a rollback");
    assert.equal(store.rows.batches.size, 1);
    assert.equal(store.rows.candidates.size, 1);
    if (action === "list") assert.deepEqual(store.snapshot(), before, "list remains read-only");
    else if (action === "discard") {
      const row = store.rows.candidates.get(candidateId!)!;
      assert.equal(row.state, "deleted");
      assert.equal(row.revision, 2);
      assert.equal(row.content, null);
    } else {
      const [row] = store.rows.candidates.values();
      assert.equal(row!.state, "pending");
      assert.equal(row!.content!.values.name, "Synthetic credits");
    }
  };
  return { run, assertFinalBoundary };
}

for (const action of ["list", "discard", "stage"] as const) {
  for (const boundary of ["exact-expiry", "clock-regression"] as const) {
    test(`${action} suppresses its final payload at ${boundary} after a still-valid final guard`, async () => {
      const finalTime = boundary === "exact-expiry" ? reviewAuthority().expiresAt : REVIEW_NOW - 1;
      const fixture = await finalClockFixture(action, finalTime);
      const result = await fixture.run();
      fixture.assertFinalBoundary();
      assert.deepEqual(result, { ok: false, code: "REVIEW_AUTHORITY_CHANGED" });
      assert.ok(Object.isFrozen(result));
      assert.equal(Object.hasOwn(result, "value"), false);
      assert.equal(JSON.stringify(result).includes("Synthetic credits"), false);
    });
  }
  test(`${action} still returns its final payload one millisecond before authority expiry`, async () => {
    const fixture = await finalClockFixture(action, reviewAuthority().expiresAt - 1);
    const result = await fixture.run();
    fixture.assertFinalBoundary();
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(Object.isFrozen(result));
    if ("candidates" in result.value) {
      assert.equal(result.value.candidates.length, 1);
      assert.equal(result.value.candidates[0]!.state, "pending");
      assert.equal(result.value.candidates[0]!.content!.values.name, "Synthetic credits");
    } else {
      assert.equal(result.value.state, "deleted");
      assert.equal(result.value.content, null);
      assert.equal(result.value.revision, 2);
    }
  });
}
