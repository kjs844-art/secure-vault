import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PREVIEW_TTL_MS, REVIEW_SCHEMA,
  type PreviewView, type ReviewErrorCode, type ReviewReceipt, type ReviewResult, type ReviewTransaction,
} from "../src/server/review/contracts.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import {
  CANDIDATE_ID, REVIEW_NOW, REVIEW_OWNER, SERVICE_ID, SYNTHETIC_PRIVATE,
  candidateContent, candidateRow, createReviewMemoryStore, operationKey,
  reviewAuthority, reviewValues, serviceRow,
} from "./support/review-memory-store.ts";

// Synthetic server-only orchestration tests. No real accounts, network, database
// files, database products, production transactions, RLS, or durable persistence.
const draft = (patch: Record<string, unknown> = {}) => ({
  candidateId: CANDIDATE_ID, candidateRevision: 1, serviceId: SERVICE_ID, serviceRevision: 1,
  values: reviewValues(), ...patch,
});
const confirmInput = (previewId: string, operationId = "synthetic-confirm") => ({ previewId, operationId, decision: "confirm" });
const deleteInput = (receipt: ReviewReceipt, operationId = "synthetic-delete") => ({
  benefitId: receipt.benefitId, expectedRevision: receipt.benefitRevision, operationId, decision: "delete",
});

function fixture() {
  const store = createReviewMemoryStore();
  const service = createReviewService(store.dependencies);
  return { store, service, controls: store.controls };
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
async function preview(f: Fixture, patch: Record<string, unknown> = {}): Promise<PreviewView> {
  return success(await f.service.preview(draft(patch)));
}
async function saved(f: Fixture): Promise<ReviewReceipt> {
  return success(await f.service.confirm(confirmInput((await preview(f)).id)));
}

test("preview binds server-owned source, service, session and generation without saving a benefit", async () => {
  const f = fixture();
  const result = await f.service.preview(draft());
  const view = success(result);
  assert.equal(view.revision, 1);
  assert.equal(view.expiresAt, REVIEW_NOW + PREVIEW_TTL_MS);
  assert.equal(view.accountProof, "not-established");
  assert.equal(view.currentBalanceProof, "not-established");
  assert.equal(view.content.serviceName, "Synthetic Studio");
  assert.deepEqual(view.content.values, reviewValues());
  assert.equal(view.content.source.evidenceAvailability, "not-retained");
  const stored = f.store.rows.previews.get(view.id)!;
  assert.equal(stored.ownerId, REVIEW_OWNER);
  assert.equal(stored.sessionId, "synthetic-session");
  assert.equal(stored.sessionRevision, 1);
  assert.equal(stored.dataGeneration, 1);
  assert.equal(stored.state, "pending");
  assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.state, "pending");
  assert.equal(f.store.rows.benefits.size, 0);
  assert.equal(f.store.rows.operations.size, 0);
  frozenTree(result);
});

test("preview lifetime never exceeds the verified session expiry", async () => {
  const f = fixture();
  f.controls.authority = reviewAuthority({ expiresAt: REVIEW_NOW + 90000 });
  assert.equal((await preview(f)).expiresAt, REVIEW_NOW + 90000);
});

test("confirm atomically consumes candidate and preview and stores reviewed values and operation", async () => {
  const f = fixture();
  const p = await preview(f, { values: reviewValues({ name: "User chosen name", remainingAmount: 0 }) });
  const result = await f.service.confirm(confirmInput(p.id));
  const receipt = success(result);
  assert.equal(receipt.schema, REVIEW_SCHEMA);
  assert.equal(receipt.outcome, "saved");
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.dataGeneration, 1);
  assert.equal(receipt.benefitRevision, 1);
  assert.equal(receipt.content!.reviewStatus, "accepted-by-user");
  assert.equal(receipt.content!.accountProof, "not-established");
  assert.equal(receipt.content!.currentBalanceProof, "not-established");
  assert.equal(receipt.content!.reviewedAt, new Date(REVIEW_NOW).toISOString());
  assert.deepEqual(receipt.content!.values, p.content.values);
  assert.equal(receipt.content!.values.remainingAmount, 0);
  assert.equal(receipt.content!.values.expiresAt, null);
  assert.equal(receipt.content!.values.observedAt, null);
  assert.equal(receipt.content!.source.receivedAt, null);
  assert.equal(receipt.content!.valueOrigins.name, "user-corrected");
  assert.equal(receipt.content!.valueOrigins.remainingAmount, "user-corrected");
  assert.equal(receipt.content!.valueOrigins.grantedAmount, "email-extracted");
  assert.equal(receipt.content!.valueOrigins.expiresAt, "email-extracted");
  assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.state, "accepted");
  assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.revision, 2);
  assert.equal(f.store.rows.previews.get(p.id)!.state, "consumed");
  assert.equal(f.store.rows.benefits.size, 1);
  assert.equal(f.store.rows.operations.size, 1);
  const operation = f.store.rows.operations.get(operationKey(REVIEW_OWNER, "synthetic-confirm"))!;
  assert.equal(operation.benefitId, receipt.benefitId);
  assert.deepEqual(JSON.parse(operation.requestKey), confirmInput(p.id));
  frozenTree(result);
});

test("a user-supplied name for a source with unknown name is marked corrected without inventing dates", async () => {
  const f = fixture();
  f.store.rows.candidates.set(CANDIDATE_ID, candidateRow({ content: candidateContent({
    values: { ...reviewValues(), name: null },
  }) }));
  const receipt = await saved(f);
  assert.equal(receipt.content!.valueOrigins.name, "user-corrected");
  assert.equal(receipt.content!.source.values.name, null);
  assert.equal(receipt.content!.values.observedAt, null);
  assert.equal(receipt.content!.source.receivedAt, null);
});

test("partial-mail and uncertainty review warnings survive candidate to preview to saved source", async () => {
  const f = fixture();
  const original = candidateContent();
  f.store.rows.candidates.set(CANDIDATE_ID, candidateRow({ content: {
    ...original, reviewReasons: [...original.reviewReasons, "PARTIAL_MAIL_TEXT"],
  } }));
  const p = await preview(f);
  assert.ok(p.content.source.reviewReasons.includes("PARTIAL_MAIL_TEXT"));
  const receipt = success(await f.service.confirm(confirmInput(p.id)));
  assert.deepEqual(receipt.content!.source.reviewReasons, [...original.reviewReasons, "PARTIAL_MAIL_TEXT"]);
  assert.equal(receipt.content!.accountProof, "not-established");
  assert.equal(receipt.content!.currentBalanceProof, "not-established");
  frozenTree(receipt.content!.source.reviewReasons);
});

test("changes to an input object after preview cannot alter stored values at confirmation", async () => {
  const f = fixture();
  const mutable = draft();
  const p = success(await f.service.preview(mutable));
  mutable.values = reviewValues({ name: "Different later input", grantedAmount: 500 });
  const receipt = success(await f.service.confirm(confirmInput(p.id)));
  assert.deepEqual(receipt.content!.values, reviewValues());
});

for (const field of ["ownerId", "source", "serviceName", "confirmedAt", "accountProof"]) {
  test(`client cannot inject server-owned preview field ${field}`, async () => {
    const f = fixture();
    const before = f.store.snapshot();
    failure(await f.service.preview(draft({ [field]: SYNTHETIC_PRIVATE })), "REVIEW_INPUT_INVALID");
    assert.deepEqual(f.store.snapshot(), before);
  });
}

for (const extra of ["values", "candidateId", "ownerId", "benefitId", "serviceId"]) {
  test(`confirm accepts no replacement payload field ${extra}`, async () => {
    const f = fixture();
    const p = await preview(f);
    const before = f.store.snapshot();
    failure(await f.service.confirm({ ...confirmInput(p.id), [extra]: SYNTHETIC_PRIVATE }), "REVIEW_INPUT_INVALID");
    assert.deepEqual(f.store.snapshot(), before);
  });
}

test("confirm requires the explicit confirm decision", async () => {
  const f = fixture();
  const p = await preview(f);
  for (const decision of [undefined, true, "save", "auto", "delete"]) {
    failure(await f.service.confirm({ ...confirmInput(p.id), decision }), "REVIEW_INPUT_INVALID");
  }
  assert.equal(f.store.rows.benefits.size, 0);
});

for (const target of ["candidate", "service"] as const) {
  for (const mismatch of ["unknown", "other-owner"]) {
    test(`${target} ${mismatch} is the same generic not-found outcome`, async () => {
      const f = fixture();
      if (mismatch === "other-owner") {
        if (target === "candidate") f.store.rows.candidates.set(CANDIDATE_ID, candidateRow({ ownerId: "synthetic-other" }));
        else f.store.rows.services.set(SERVICE_ID, serviceRow({ ownerId: "synthetic-other" }));
      }
      const patch = mismatch === "unknown" ? { [target === "candidate" ? "candidateId" : "serviceId"]: "synthetic-unknown" } : {};
      const before = f.store.snapshot();
      failure(await f.service.preview(draft(patch)), "REVIEW_NOT_FOUND");
      assert.deepEqual(f.store.snapshot(), before);
    });
  }
  test(`stale ${target} revision prevents preview`, async () => {
    const f = fixture();
    failure(await f.service.preview(draft({ [target === "candidate" ? "candidateRevision" : "serviceRevision"]: 2 })), "REVIEW_CONFLICT");
    assert.equal(f.store.rows.previews.size, 0);
  });
}

for (const target of ["preview", "benefit"] as const) {
  for (const mismatch of ["unknown", "other-owner"]) {
    test(`${target} ${mismatch} never exposes whether another owner has the ID`, async () => {
      const f = fixture();
      if (target === "preview") {
        const p = await preview(f);
        if (mismatch === "other-owner") {
          const row = f.store.rows.previews.get(p.id)!;
          f.store.rows.previews.set(p.id, { ...row, ownerId: "synthetic-other" });
        }
        failure(await f.service.confirm(confirmInput(mismatch === "unknown" ? "synthetic-unknown" : p.id)), "REVIEW_NOT_FOUND");
      } else {
        const receipt = await saved(f);
        if (mismatch === "other-owner") {
          const row = f.store.rows.benefits.get(receipt.benefitId)!;
          f.store.rows.benefits.set(row.id, { ...row, ownerId: "synthetic-other" });
        }
        failure(await f.service.remove({ ...deleteInput(receipt), benefitId: mismatch === "unknown" ? "synthetic-unknown" : receipt.benefitId }), "REVIEW_NOT_FOUND");
      }
    });
  }
}

for (const target of ["candidate", "service"] as const) {
  test(`revision changed after preview invalidates ${target} at confirm`, async () => {
    const f = fixture();
    const p = await preview(f);
    if (target === "candidate") f.store.rows.candidates.set(CANDIDATE_ID, candidateRow({ revision: 2 }));
    else f.store.rows.services.set(SERVICE_ID, serviceRow({ revision: 2 }));
    const before = f.store.snapshot();
    failure(await f.service.confirm(confirmInput(p.id)), "REVIEW_CONFLICT");
    assert.deepEqual(f.store.snapshot(), before);
  });
}

test("preview expiry is distinct and cannot consume the candidate", async () => {
  const f = fixture();
  const p = await preview(f);
  f.controls.now = p.expiresAt;
  const before = f.store.snapshot();
  failure(await f.service.confirm(confirmInput(p.id)), "REVIEW_PREVIEW_EXPIRED");
  assert.deepEqual(f.store.snapshot(), before);
});

test("a pending preview with a changed revision is not the immutable review originally created", async () => {
  const f = fixture();
  const p = await preview(f);
  const row = f.store.rows.previews.get(p.id)!;
  f.store.rows.previews.set(p.id, { ...row, revision: 2 });
  const before = f.store.snapshot();
  failure(await f.service.confirm(confirmInput(p.id)), "REVIEW_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
});

for (const action of ["preview", "confirm"] as const) {
  test(`${action} cannot commit at a preview deadline reached after the callback's final guard`, async () => {
    const f = fixture();
    const p = action === "confirm" ? await preview(f) : null;
    const before = f.store.snapshot();
    f.controls.beforeCommit = () => { f.controls.now = p?.expiresAt ?? REVIEW_NOW + PREVIEW_TTL_MS; };
    const result = p ? await f.service.confirm(confirmInput(p.id)) : await f.service.preview(draft());
    failure(result, "REVIEW_STORE_UNAVAILABLE");
    assert.deepEqual(f.store.snapshot(), before);
  });
}

for (const target of ["candidate", "service", "preview", "benefit"] as const) {
  for (const mismatch of ["id", "dataGeneration"] as const) {
    test(`stored ${target} ${mismatch} mismatch is generic not-found even if returned by an adapter`, async () => {
      const f = fixture();
      const patch = mismatch === "id" ? { id: "synthetic-wrong-row" } : { dataGeneration: 2 };
      let result: ReviewResult<unknown>;
      if (target === "candidate") {
        f.store.rows.candidates.set(CANDIDATE_ID, candidateRow(patch));
        result = await f.service.preview(draft());
      } else if (target === "service") {
        f.store.rows.services.set(SERVICE_ID, serviceRow(patch));
        result = await f.service.preview(draft());
      } else if (target === "preview") {
        const p = await preview(f);
        f.store.rows.previews.set(p.id, { ...f.store.rows.previews.get(p.id)!, ...patch });
        result = await f.service.confirm(confirmInput(p.id));
      } else {
        const receipt = await saved(f);
        f.store.rows.benefits.set(receipt.benefitId, { ...f.store.rows.benefits.get(receipt.benefitId)!, ...patch });
        result = await f.service.remove(deleteInput(receipt));
      }
      failure(result, "REVIEW_NOT_FOUND");
    });
  }
}

for (const patch of [{ sessionId: "synthetic-replacement" }, { sessionRevision: 2 }]) {
  test(`preview is bound to its creating session: ${Object.keys(patch)[0]}`, async () => {
    const f = fixture();
    const p = await preview(f);
    f.controls.authority = reviewAuthority(patch);
    const before = f.store.snapshot();
    failure(await f.service.confirm(confirmInput(p.id)), "REVIEW_AUTHORITY_CHANGED");
    assert.deepEqual(f.store.snapshot(), before);
  });
}

test("the same operation and canonical body returns the current saved record as a replay", async () => {
  const f = fixture();
  const p = await preview(f);
  const first = success(await f.service.confirm(confirmInput(p.id)));
  const stored = f.store.rows.benefits.get(first.benefitId)!;
  f.store.rows.benefits.set(stored.id, { ...stored, revision: 2,
    content: { ...stored.content!, values: reviewValues({ name: "Current stored name" }),
      valueOrigins: { ...stored.content!.valueOrigins, name: "user-corrected" } } });
  const replay = success(await f.service.confirm(confirmInput(p.id)));
  assert.equal(replay.replayed, true);
  assert.equal(replay.benefitId, first.benefitId);
  assert.equal(replay.benefitRevision, 2);
  assert.equal(replay.content!.values.name, "Current stored name");
  assert.equal(f.store.rows.benefits.size, 1);
  assert.equal(f.store.rows.operations.size, 1);
});

test("value origin object key order is not significant when replaying a valid stored benefit", async () => {
  const f = fixture();
  const p = await preview(f);
  const original = success(await f.service.confirm(confirmInput(p.id)));
  const row = f.store.rows.benefits.get(original.benefitId)!;
  f.store.rows.benefits.set(row.id, { ...row, content: { ...row.content!,
    valueOrigins: Object.fromEntries(Object.entries(row.content!.valueOrigins).reverse()) as NonNullable<typeof row.content>["valueOrigins"],
  } });
  const replay = success(await f.service.confirm(confirmInput(p.id)));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.content!.valueOrigins, original.content!.valueOrigins);
});

test("reuse of an operation with a different preview body is a conflict", async () => {
  const f = fixture();
  const first = await preview(f);
  const second = await preview(f);
  success(await f.service.confirm(confirmInput(first.id)));
  const before = f.store.snapshot();
  failure(await f.service.confirm(confirmInput(second.id)), "REVIEW_OPERATION_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
});

test("confirm and delete cannot share the same operation ID", async () => {
  const f = fixture();
  const receipt = await saved(f);
  const before = f.store.snapshot();
  failure(await f.service.remove(deleteInput(receipt, "synthetic-confirm")), "REVIEW_OPERATION_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
});

test("parallel identical confirms commit once and the second request is a replay", async () => {
  const f = fixture();
  const p = await preview(f);
  const results = await Promise.all([f.service.confirm(confirmInput(p.id)), f.service.confirm(confirmInput(p.id))]);
  const receipts = results.map(success);
  assert.deepEqual(receipts.map((receipt) => receipt.replayed).sort(), [false, true]);
  assert.equal(new Set(receipts.map((receipt) => receipt.benefitId)).size, 1);
  assert.equal(f.store.rows.benefits.size, 1);
  assert.equal(f.store.rows.operations.size, 1);
});

test("parallel distinct previews for one candidate cannot save duplicate benefits", async () => {
  const f = fixture();
  const first = await preview(f);
  const second = await preview(f);
  const results = await Promise.all([
    f.service.confirm(confirmInput(first.id, "synthetic-first")),
    f.service.confirm(confirmInput(second.id, "synthetic-second")),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  failure(results.find((result) => !result.ok)!, ["REVIEW_CONFLICT", "REVIEW_PREVIEW_UNAVAILABLE"]);
  assert.equal(f.store.rows.benefits.size, 1);
  assert.equal(f.store.rows.operations.size, 1);
});

test("reject revokes only a pending preview and does not consume its candidate", async () => {
  const f = fixture();
  const p = await preview(f);
  const result = await f.service.reject({ previewId: p.id, expectedRevision: p.revision, decision: "reject" });
  assert.deepEqual(success(result), { previewId: p.id, state: "revoked" });
  const revoked = f.store.rows.previews.get(p.id)!;
  assert.equal(revoked.state, "revoked");
  assert.equal(revoked.content, null);
  assert.equal(revoked.revision, 2);
  assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.state, "pending");
  assert.equal(f.store.rows.benefits.size, 0);
  assert.equal(f.store.rows.operations.size, 0);
  failure(await f.service.confirm(confirmInput(p.id)), "REVIEW_PREVIEW_UNAVAILABLE");
});

test("reject cannot erase a consumed preview or undo a saved benefit", async () => {
  const f = fixture();
  const p = await preview(f);
  success(await f.service.confirm(confirmInput(p.id)));
  const row = f.store.rows.previews.get(p.id)!;
  const before = f.store.snapshot();
  failure(await f.service.reject({ previewId: p.id, expectedRevision: row.revision, decision: "reject" }), "REVIEW_PREVIEW_UNAVAILABLE");
  assert.deepEqual(f.store.snapshot(), before);
});

test("reject requires the current preview revision", async () => {
  const f = fixture();
  const p = await preview(f);
  failure(await f.service.reject({ previewId: p.id, expectedRevision: 2, decision: "reject" }), "REVIEW_CONFLICT");
  assert.equal(f.store.rows.previews.get(p.id)!.state, "pending");
});

test("delete atomically tombstones benefit, candidate and every linked preview payload", async () => {
  const f = fixture();
  const first = await preview(f);
  const second = await preview(f);
  const receipt = success(await f.service.confirm(confirmInput(first.id)));
  const result = await f.service.remove(deleteInput(receipt));
  const removed = success(result);
  assert.equal(removed.outcome, "deleted");
  assert.equal(removed.replayed, false);
  assert.equal(removed.content, null);
  assert.equal(removed.benefitRevision, receipt.benefitRevision + 1);
  assert.equal(removed.dataGeneration, 1);
  const benefit = f.store.rows.benefits.get(receipt.benefitId)!;
  assert.equal(benefit.state, "deleted");
  assert.equal(benefit.content, null);
  assert.equal(benefit.deletedAt, new Date(REVIEW_NOW).toISOString());
  const candidate = f.store.rows.candidates.get(CANDIDATE_ID)!;
  assert.equal(candidate.state, "deleted");
  assert.equal(candidate.content, null);
  assert.equal(candidate.revision, 3);
  for (const id of [first.id, second.id]) {
    assert.equal(f.store.rows.previews.get(id)!.content, null);
    assert.equal(f.store.rows.previews.get(id)!.state, "deleted");
  }
  assert.equal(f.store.rows.operations.size, 2);
  frozenTree(result);
});

test("old confirm replay after deletion returns the current tombstone and cannot resurrect content", async () => {
  const f = fixture();
  const p = await preview(f);
  const original = success(await f.service.confirm(confirmInput(p.id)));
  const removed = success(await f.service.remove(deleteInput(original)));
  const before = f.store.snapshot();
  const replay = success(await f.service.confirm(confirmInput(p.id)));
  assert.equal(replay.outcome, "deleted");
  assert.equal(replay.content, null);
  assert.equal(replay.replayed, true);
  assert.equal(replay.benefitRevision, removed.benefitRevision);
  assert.deepEqual(f.store.snapshot(), before);
});

test("same delete operation is replayable with the original body without applying deletion twice", async () => {
  const f = fixture();
  const original = await saved(f);
  const removed = success(await f.service.remove(deleteInput(original)));
  const before = f.store.snapshot();
  const replay = success(await f.service.remove(deleteInput(original)));
  assert.equal(replay.replayed, true);
  assert.equal(replay.content, null);
  assert.equal(replay.benefitRevision, removed.benefitRevision);
  assert.deepEqual(f.store.snapshot(), before);
});

test("changed expected revision is a different delete body for a used operation ID", async () => {
  const f = fixture();
  const original = await saved(f);
  success(await f.service.remove(deleteInput(original)));
  failure(await f.service.remove({ ...deleteInput(original), expectedRevision: original.benefitRevision + 1 }), "REVIEW_OPERATION_CONFLICT");
});

test("stale benefit revision never deletes content", async () => {
  const f = fixture();
  const original = await saved(f);
  const before = f.store.snapshot();
  failure(await f.service.remove({ ...deleteInput(original), expectedRevision: original.benefitRevision + 1 }), "REVIEW_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
});

type Action = "preview" | "confirm" | "reject" | "remove";
async function actionFixture(action: Action) {
  const f = fixture();
  let run: () => Promise<ReviewResult<unknown>>;
  if (action === "preview") run = () => f.service.preview(draft());
  else if (action === "remove") {
    const receipt = await saved(f);
    run = () => f.service.remove(deleteInput(receipt));
  } else {
    const p = await preview(f);
    run = action === "confirm" ? () => f.service.confirm(confirmInput(p.id))
      : () => f.service.reject({ previewId: p.id, expectedRevision: p.revision, decision: "reject" });
  }
  f.controls.authorityReads = 0;
  f.controls.trace.length = 0;
  return { f, run };
}

for (const action of ["preview", "confirm", "reject", "remove"] as const) {
  test(`${action} rejects absent authority without mutating owned rows`, async () => {
    const { f, run } = await actionFixture(action);
    f.controls.authority = null;
    const before = f.store.snapshot();
    failure(await run(), "REVIEW_AUTH_REQUIRED");
    assert.deepEqual(f.store.snapshot(), before);
  });

  test(`${action} redacts auth-adapter errors`, async () => {
    const { f, run } = await actionFixture(action);
    f.controls.readAuthority = () => { throw new Error(SYNTHETIC_PRIVATE); };
    const before = f.store.snapshot();
    failure(await run(), "REVIEW_STORE_UNAVAILABLE");
    assert.deepEqual(f.store.snapshot(), before);
  });

  test(`${action} rechecks changed authority at every service reauthorization boundary`, async (t) => {
    const baseline = await actionFixture(action);
    success(await baseline.run());
    const reads = baseline.f.controls.authorityReads;
    assert.ok(reads >= 2, "each operation must reauthorize before completing");
    for (let call = 2; call <= reads; call++) {
      for (const patch of [
        { ownerId: "synthetic-other" }, { sessionId: "synthetic-other" }, { sessionRevision: 2 },
        { dataGeneration: 2 }, { expiresAt: REVIEW_NOW },
      ]) {
        await t.test(`${Object.keys(patch)[0]} at read ${call}`, async () => {
          const { f, run } = await actionFixture(action);
          f.controls.readAuthority = (index) => index === call ? reviewAuthority(patch) : reviewAuthority();
          const before = f.store.snapshot();
          const commitsBefore = f.controls.commits;
          failure(await run(), "REVIEW_AUTHORITY_CHANGED");
          if (f.controls.commits === commitsBefore) assert.deepEqual(f.store.snapshot(), before);
          else {
            assert.equal(f.controls.commits, commitsBefore + 1);
            assert.notDeepEqual(f.store.snapshot(), before, "post-commit auth refusal drops output, not committed writes");
          }
        });
      }
    }
  });

  for (const boundary of ["entry", "commit"]) {
    test(`${action} rolls back if the memory adapter rejects authority at ${boundary}`, async () => {
      const { f, run } = await actionFixture(action);
      const change = () => { f.controls.authority = reviewAuthority({ dataGeneration: 2 }); };
      if (boundary === "entry") f.controls.beforeEntry = change;
      else f.controls.beforeCommit = change;
      const before = f.store.snapshot();
      failure(await run(), "REVIEW_STORE_UNAVAILABLE");
      assert.deepEqual(f.store.snapshot(), before);
    });
  }
}

type WriteMethod = Exclude<keyof ReviewTransaction, "limitCommitTime" | "requireServiceVersion" | "getCandidate" | "getService"
  | "getPreview" | "getBenefit" | "getOperation">;
const writeCases: Array<[Action, WriteMethod]> = [
  ["preview", "insertPreview"], ["confirm", "updateCandidate"], ["confirm", "updatePreview"],
  ["confirm", "insertBenefit"], ["confirm", "insertOperation"], ["reject", "updatePreview"],
  ["remove", "updateBenefit"], ["remove", "updateCandidate"],
  ["remove", "eraseCandidatePreviews"], ["remove", "insertOperation"],
];
for (const [action, method] of writeCases) {
  test(`${action} rolls back all writes when ${method} throws after its mutation`, async () => {
    const { f, run } = await actionFixture(action);
    f.controls.afterMethod = (current) => { if (current === method) throw new Error(SYNTHETIC_PRIVATE); };
    const before = f.store.snapshot();
    failure(await run(), "REVIEW_STORE_UNAVAILABLE");
    assert.ok(f.controls.trace.includes(method));
    assert.deepEqual(f.store.snapshot(), before);
  });
  if (method !== "eraseCandidatePreviews") {
    test(`${action} rolls back on ${method} conditional-write refusal`, async () => {
      const { f, run } = await actionFixture(action);
      f.controls.falseMethod = method;
      const before = f.store.snapshot();
      failure(await run(), ["REVIEW_CONFLICT", "REVIEW_OPERATION_CONFLICT"]);
      assert.deepEqual(f.store.snapshot(), before);
    });
  }
}

test("rollback does not poison the serialized queue; a later valid request can save", async () => {
  const f = fixture();
  const p = await preview(f);
  f.controls.afterMethod = (method) => { if (method === "insertBenefit") throw new Error(SYNTHETIC_PRIVATE); };
  failure(await f.service.confirm(confirmInput(p.id)), "REVIEW_STORE_UNAVAILABLE");
  delete f.controls.afterMethod;
  const receipt = success(await f.service.confirm(confirmInput(p.id)));
  assert.equal(receipt.outcome, "saved");
  assert.equal(receipt.replayed, false);
  assert.equal(f.store.rows.benefits.size, 1);
  assert.equal(f.store.rows.operations.size, 1);
});

test("an uncertain post-commit adapter failure is redacted and same-operation retry cannot duplicate the save", async () => {
  const f = fixture();
  const p = await preview(f);
  f.controls.afterCommit = () => { throw new Error(SYNTHETIC_PRIVATE); };
  failure(await f.service.confirm(confirmInput(p.id)), "REVIEW_STORE_UNAVAILABLE");
  assert.equal(f.store.rows.benefits.size, 1, "a generic failure is not evidence that no commit happened");
  assert.equal(f.store.rows.operations.size, 1);
  delete f.controls.afterCommit;
  const replay = success(await f.service.confirm(confirmInput(p.id)));
  assert.equal(replay.replayed, true);
  assert.equal(f.store.rows.benefits.size, 1);
  assert.equal(f.store.rows.operations.size, 1);
});

for (const [name, patch] of [
  ["session", { sessionRevision: 2 }], ["generation", { dataGeneration: 2 }], ["expiry", { expiresAt: REVIEW_NOW }],
] as const) {
  test(`post-commit ${name} change suppresses saved output without claiming rollback or allowing duplicate save`, async () => {
    const f = fixture();
    const p = await preview(f);
    const commitsBefore = f.controls.commits;
    f.controls.afterCommit = () => { f.controls.authority = reviewAuthority(patch); };
    failure(await f.service.confirm(confirmInput(p.id)), "REVIEW_AUTHORITY_CHANGED");
    assert.equal(f.controls.commits, commitsBefore + 1);
    assert.equal(f.store.rows.benefits.size, 1);
    assert.equal(f.store.rows.operations.size, 1);
    assert.equal(f.store.rows.candidates.get(CANDIDATE_ID)!.state, "accepted");
    delete f.controls.afterCommit;
    if (name === "expiry") {
      failure(await f.service.confirm(confirmInput(p.id)), "REVIEW_AUTH_REQUIRED");
      f.controls.authority = reviewAuthority({ sessionRevision: 2 });
    }
    if (name === "generation") {
      failure(await f.service.confirm(confirmInput(p.id)), "REVIEW_OPERATION_CONFLICT");
    } else {
      const replay = success(await f.service.confirm(confirmInput(p.id)));
      assert.equal(replay.replayed, true);
      assert.equal(replay.outcome, "saved");
    }
    assert.equal(f.store.rows.benefits.size, 1);
    assert.equal(f.store.rows.operations.size, 1);
  });
}

test("the memory fixture scopes every read to owner and returns detached snapshots", async () => {
  const store = createReviewMemoryStore();
  store.rows.services.set(SERVICE_ID, serviceRow({ ownerId: "synthetic-other" }));
  await store.dependencies.transaction(reviewAuthority(), async (tx) => {
    assert.equal(await tx.getService(SERVICE_ID), null);
    assert.equal(await tx.getService("synthetic-missing"), null);
    const candidate = (await tx.getCandidate(CANDIDATE_ID))!;
    (candidate as unknown as { revision: number }).revision = 99;
    assert.equal((await tx.getCandidate(CANDIDATE_ID))!.revision, 1);
  });
  assert.equal(store.rows.candidates.get(CANDIDATE_ID)!.revision, 1);
});

test("the memory fixture refuses owner mismatch and stale CAS, and rolls back thrown callback writes", async () => {
  const store = createReviewMemoryStore();
  const before = store.snapshot();
  await assert.rejects(store.dependencies.transaction(reviewAuthority(), async (tx) => {
    assert.equal(await tx.updateCandidate(candidateRow({ revision: 2, ownerId: "synthetic-other" }), 1), false);
    assert.equal(await tx.updateCandidate(candidateRow({ revision: 2 }), 2), false);
    assert.equal(await tx.updateCandidate(candidateRow({ revision: 2, state: "accepted" }), 1), true);
    throw new Error(SYNTHETIC_PRIVATE);
  }));
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.controls.rollbacks, 1);
});

test("the memory fixture commit deadline only tightens and refuses the exact deadline", async () => {
  const store = createReviewMemoryStore();
  const before = store.snapshot();
  store.controls.beforeCommit = () => { store.controls.now = REVIEW_NOW + 10; };
  await assert.rejects(store.dependencies.transaction(reviewAuthority(), async (tx) => {
    tx.limitCommitTime(REVIEW_NOW + 10);
    tx.limitCommitTime(REVIEW_NOW + 100);
    assert.equal(await tx.updateCandidate(candidateRow({ revision: 2, state: "accepted" }), 1), true);
  }));
  assert.deepEqual(store.snapshot(), before);
});

test("the memory fixture refuses edits to a pending preview's immutable content", async () => {
  const f = fixture();
  const p = await preview(f);
  const row = f.store.rows.previews.get(p.id)!;
  await f.store.dependencies.transaction(reviewAuthority(), async (tx) => {
    assert.equal(await tx.updatePreview({ ...row, revision: 2,
      content: { ...row.content!, values: reviewValues({ name: "Changed after review" }) },
    }, 1), false);
  });
  assert.equal(f.store.rows.previews.get(p.id)!.revision, 1);
});

for (const state of ["consumed", "revoked", "deleted"] as const) {
  test(`the memory fixture never revives ${state} previews to pending`, async () => {
    const f = fixture();
    const p = await preview(f);
    const original = f.store.rows.previews.get(p.id)!;
    f.store.rows.previews.set(p.id, { ...original, state,
      content: state === "consumed" ? original.content : null });
    await f.store.dependencies.transaction(reviewAuthority(), async (tx) => {
      assert.equal(await tx.updatePreview({ ...original, revision: 2, state: "pending" }, 1), false);
    });
    assert.equal(f.store.rows.previews.get(p.id)!.state, state);
  });
}

for (const state of ["accepted", "deleted"] as const) {
  test(`the memory fixture never revives ${state} candidates to pending`, async () => {
    const store = createReviewMemoryStore();
    store.rows.candidates.set(CANDIDATE_ID, candidateRow({ state,
      content: state === "deleted" ? null : candidateContent() }));
    await store.dependencies.transaction(reviewAuthority(), async (tx) => {
      assert.equal(await tx.updateCandidate(candidateRow({ revision: 2 }), 1), false);
    });
    assert.equal(store.rows.candidates.get(CANDIDATE_ID)!.state, state);
  });
}

test("the memory fixture never revives a deleted benefit to live", async () => {
  const f = fixture();
  const original = await saved(f);
  const removed = success(await f.service.remove(deleteInput(original)));
  const row = f.store.rows.benefits.get(removed.benefitId)!;
  await f.store.dependencies.transaction(reviewAuthority(), async (tx) => {
    assert.equal(await tx.updateBenefit({ ...row, revision: row.revision + 1, state: "live",
      content: original.content, deletedAt: null }, row.revision), false);
  });
  assert.equal(f.store.rows.benefits.get(row.id)!.state, "deleted");
});

test("erasing a maximum-revision preview fails generically and rolls back the entire deletion", async () => {
  const f = fixture();
  const p = await preview(f);
  const receipt = success(await f.service.confirm(confirmInput(p.id)));
  const row = f.store.rows.previews.get(p.id)!;
  f.store.rows.previews.set(p.id, { ...row, revision: Number.MAX_SAFE_INTEGER });
  const before = f.store.snapshot();
  failure(await f.service.remove(deleteInput(receipt)), "REVIEW_STORE_UNAVAILABLE");
  assert.deepEqual(f.store.snapshot(), before);
});

test("candidate revision overflow is a conflict before any confirmation writes", async () => {
  const f = fixture();
  f.store.rows.candidates.set(CANDIDATE_ID, candidateRow({ revision: Number.MAX_SAFE_INTEGER }));
  const p = await preview(f, { candidateRevision: Number.MAX_SAFE_INTEGER });
  const before = f.store.snapshot();
  failure(await f.service.confirm(confirmInput(p.id)), "REVIEW_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
});

test("benefit revision overflow is a conflict before any deletion writes", async () => {
  const f = fixture();
  const receipt = await saved(f);
  const row = f.store.rows.benefits.get(receipt.benefitId)!;
  f.store.rows.benefits.set(row.id, { ...row, revision: Number.MAX_SAFE_INTEGER });
  const before = f.store.snapshot();
  failure(await f.service.remove({ ...deleteInput(receipt), expectedRevision: Number.MAX_SAFE_INTEGER }), "REVIEW_CONFLICT");
  assert.deepEqual(f.store.snapshot(), before);
});
