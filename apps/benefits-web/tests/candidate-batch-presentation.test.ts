import assert from "node:assert/strict";
import { test } from "node:test";
import { CANDIDATE_BATCH_VIEW_SCHEMA, MAX_CANDIDATE_BATCH_DISPLAY, decodeCandidateBatchDisplay,
  type CandidateBatchDisplay } from "../src/domain/candidate-batch-view.ts";
import { projectCandidateBatch } from "../src/server/inbox/presentation.ts";
import { INBOX_SCHEMA, type CandidateBatchView, type CandidateView } from "../src/server/inbox/contracts.ts";
import { createCandidateInbox } from "../src/server/inbox/candidate-inbox.ts";
import { runMailAnalysis, type MailAnalysisAdapters } from "../src/server/mail/run-analysis.ts";
import { createReviewService } from "../src/server/review/review-service.ts";
import { parseCandidateContent } from "../src/server/review/validation.ts";
import type { CandidateContent, ExtractedValues } from "../src/server/review/contracts.ts";
import { REVIEW_NOW, SERVICE_ID, SYNTHETIC_PRIVATE, analysisAuthority, candidateContent,
  createReviewMemoryStore, reviewAuthority, reviewValues, stagingGrant } from "./support/review-memory-store.ts";

// Synthetic values and actual pure services only; no real inbox, auth, provider,
// database durability, browser transport or current account/balance proof.
const VALUE_KEYS = ["name", "kind", "unit", "grantedAmount", "remainingAmount", "trialDaysStated",
  "remainingDaysStated", "expiresAt", "observedAt"] as const;
function internal(content: CandidateContent = candidateContent()): CandidateBatchView {
  return { schema: INBOX_SCHEMA, dataGeneration: 7, analysisOperationId: "synthetic-private-analysis",
    replayed: true, candidates: [{ id: "synthetic-candidate", revision: 1,
      state: "pending", expiresAt: REVIEW_NOW + 1000, content }] };
}
function display(): CandidateBatchDisplay { return projectCandidateBatch(internal(), REVIEW_NOW); }
function jsonInput(): Record<string, unknown> { return structuredClone(display()) as unknown as Record<string, unknown>; }
function contentInput(): Record<string, unknown> {
  const candidate = display().candidates[0]!; assert.equal(candidate.state, "pending");
  return structuredClone(candidate.content) as unknown as Record<string, unknown>;
}
function withContent(content: unknown): unknown {
  return { ...display(), candidates: [{ ...display().candidates[0], content }] };
}
function frozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const item of Object.values(value)) frozen(item);
}

test("candidate projection is an exact frozen public allowlist, without private analysis/mailbox/source identifiers", () => {
  const input = internal(candidateContent({ serviceName: "합성 서비스 😀", values: { ...reviewValues(), name: null, remainingAmount: 0 } }));
  const before = structuredClone(input), output = projectCandidateBatch(input, REVIEW_NOW);
  assert.equal(output.schema, CANDIDATE_BATCH_VIEW_SCHEMA); assert.equal(output.dataGeneration, 7);
  assert.deepEqual(Object.keys(output).sort(), ["schema", "dataGeneration", "candidates"].sort());
  const candidate = output.candidates[0]!; assert.equal(candidate.state, "pending");
  assert.deepEqual(Object.keys(candidate).sort(), ["candidateId", "candidateRevision", "state", "accessExpiresAt", "content"].sort());
  assert.equal(candidate.candidateId, input.candidates[0]!.id); assert.equal(candidate.candidateRevision, 1);
  assert.equal(candidate.accessExpiresAt, REVIEW_NOW + 1000);
  assert.deepEqual(Object.keys(candidate.content).sort(), ["serviceName", "extractionConfidence", "values", "receivedAt",
    "extractedAt", "reviewReasons", "evidenceAvailability", "reviewStatus", "accountProof", "currentBalanceProof"].sort());
  assert.equal(candidate.content.values.name, null); assert.equal(candidate.content.values.remainingAmount, 0);
  assert.equal(candidate.content.values.observedAt, null); assert.equal(candidate.content.receivedAt, null);
  assert.equal(candidate.content.serviceName, "합성 서비스 😀"); assert.equal(candidate.content.extractionConfidence, "high");
  assert.equal(candidate.content.reviewStatus, "pending-review"); assert.equal(candidate.content.accountProof, "not-established");
  assert.equal(candidate.content.currentBalanceProof, "not-established"); assert.equal(candidate.content.evidenceAvailability, "not-retained");
  const text = JSON.stringify(output);
  for (const key of ["analysisOperationId", "mailboxBindingId", "ownerId", "sessionId", "sessionRevision", "grantId",
    "candidateIndex", "replayed", "source", "fingerprint", "policyVersion", "quote", "body", "gmailId"]) assert.ok(!text.includes(`"${key}"`), key);
  for (const secret of [input.analysisOperationId, input.candidates[0]!.content!.analysisOperationId,
    input.candidates[0]!.content!.mailboxBindingId]) assert.ok(!text.includes(secret));
  assert.deepEqual(input, before); frozen(output);
  assert.notEqual(candidate.content.values, input.candidates[0]!.content!.values);
  assert.notEqual(candidate.content.reviewReasons, input.candidates[0]!.content!.reviewReasons);
  assert.deepEqual(decodeCandidateBatchDisplay(JSON.parse(text)), output);
});

test("all nine extraction keys remain aligned, including missing name without invented fallback", () => {
  const source = candidateContent({ values: { ...reviewValues(), name: null } });
  const candidate = projectCandidateBatch(internal(source), REVIEW_NOW).candidates[0]!; assert.equal(candidate.state, "pending");
  assert.deepEqual(Object.keys(source.values).sort(), [...VALUE_KEYS].sort());
  assert.deepEqual(Object.keys(candidate.content.values).sort(), [...VALUE_KEYS].sort());
  assert.equal(candidate.content.values.name, null);
});

test("projection and decoder snapshots detach mutable input and never mutate the trusted source", () => {
  const source = candidateContent(), input = internal(source), output = projectCandidateBatch(input, REVIEW_NOW);
  const decoded = decodeCandidateBatchDisplay(output)!; assert.notEqual(decoded, output);
  Object.assign(source.values, { name: "Later synthetic change" });
  Object.assign(source, { serviceName: "Changed", reviewReasons: [] });
  const candidate = output.candidates[0]!; assert.equal(candidate.state, "pending");
  assert.equal(candidate.content.values.name, "Synthetic credits"); assert.equal(candidate.content.serviceName, "Synthetic Studio");
  assert.equal(candidate.content.reviewReasons.length, 5); assert.deepEqual(decoded, output); frozen(decoded);
});

for (const terminal of ["accepted", "deleted", "expired"] as const) {
  test(`${terminal} candidate projection returns identity and null, never old content`, () => {
    const input = internal();
    const row: CandidateView = { ...input.candidates[0]!, state: terminal, revision: 2 };
    Object.defineProperty(row, "content", { enumerable: true, get() { throw new Error(SYNTHETIC_PRIVATE); } });
    const result = projectCandidateBatch({ ...input, candidates: [row] }, REVIEW_NOW);
    assert.deepEqual(result.candidates, [{ candidateId: row.id, candidateRevision: 2, state: terminal,
      accessExpiresAt: row.expiresAt, content: null }]);
    assert.equal(decodeCandidateBatchDisplay({ ...result, candidates: [{ ...result.candidates[0], content: contentInput() }] }), null);
  });
}

test("pending access is hidden at the exact supplied deadline, distinct from benefit expiry and physical deletion", () => {
  const source = candidateContent({ values: reviewValues({ expiresAt: "2000-01-01" }) }), input = internal(source);
  assert.equal(projectCandidateBatch(input, REVIEW_NOW + 999).candidates[0]!.state, "pending");
  for (const time of [REVIEW_NOW + 1000, REVIEW_NOW + 1001]) {
    const projected = projectCandidateBatch(input, time).candidates[0]!;
    assert.equal(projected.state, "expired"); assert.equal(projected.content, null); assert.equal(projected.candidateRevision, 1);
  }
  assert.equal(input.candidates[0]!.content, source); assert.equal(input.candidates[0]!.state, "pending");
  // Decoder is deliberately clock-free: a retained pending snapshot is not a live access grant.
  assert.equal(decodeCandidateBatchDisplay(projectCandidateBatch(input, REVIEW_NOW))!.candidates[0]!.state, "pending");
});

test("already expired pending content is never read while producing the redacted observation", () => {
  const input = internal(), row = { ...input.candidates[0]! }; let contentReads = 0;
  Object.defineProperty(row, "content", { enumerable: true, get() { contentReads++; throw new Error(SYNTHETIC_PRIVATE); } });
  assert.equal(projectCandidateBatch({ ...input, candidates: [row] }, REVIEW_NOW + 1000).candidates[0]!.content, null);
  assert.equal(contentReads, 0);
});

for (const now of [-1, -0, NaN, Infinity, 0.5, 253402300800000, "0", null]) {
  test(`projector refuses noncanonical supplied time: ${String(now)} ${Object.is(now, -0) ? "negative-zero" : ""}`, () => {
    assert.throws(() => projectCandidateBatch(internal(), now as number), { message: "CANDIDATE_BATCH_PRESENTATION_INVALID" });
  });
}

test("projection validates public data and uses only a fixed content-free error", () => {
  const input = internal();
  for (const bad of [null, {}, { ...input, schema: "wrong" }, { ...input, dataGeneration: 0 },
    { ...input, candidates: [{ ...input.candidates[0], revision: 0 }] },
    { ...input, candidates: [{ ...input.candidates[0], state: "unknown" }] },
    { ...input, candidates: [{ ...input.candidates[0], content: candidateContent({ serviceName: "" }) }] }]) {
    assert.throws(() => projectCandidateBatch(bad as CandidateBatchView, REVIEW_NOW), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message, "CANDIDATE_BATCH_PRESENTATION_INVALID");
      assert.equal(error.cause, undefined); return true;
    });
  }
});

const nested: readonly [string, () => Record<string, unknown>, (changed: unknown) => unknown][] = [
  ["batch", jsonInput, (value) => value],
  ["candidate", () => ({ ...display().candidates[0] }), (value) => ({ ...display(), candidates: [value] })],
  ["content", contentInput, withContent],
  ["values", () => ({ ...reviewValues() }), (value) => withContent({ ...contentInput(), values: value })],
];
for (const [name, factory, wrap] of nested) {
  test(`decoder ${name} requires exact own enumerable data properties without invoking ordinary getters`, () => {
    assert.ok(decodeCandidateBatchDisplay(wrap(factory())));
    assert.ok(decodeCandidateBatchDisplay(wrap(Object.assign(Object.create(null) as object, factory()))));
    for (const bad of [null, [], Object.create(factory()), { ...factory(), extra: true }, { ...factory(), [Symbol("private")]: true }])
      assert.equal(decodeCandidateBatchDisplay(wrap(bad)), null);
    for (const key of Object.keys(factory())) {
      const missing = factory(); delete missing[key]; assert.equal(decodeCandidateBatchDisplay(wrap(missing)), null);
      const hidden = factory(); Object.defineProperty(hidden, key, { value: hidden[key], enumerable: false });
      assert.equal(decodeCandidateBatchDisplay(wrap(hidden)), null);
      let calls = 0; const getter = factory(); Object.defineProperty(getter, key, { enumerable: true, get() { calls++; throw Error(SYNTHETIC_PRIVATE); } });
      assert.equal(decodeCandidateBatchDisplay(wrap(getter)), null); assert.equal(calls, 0);
    }
    const proxy = new Proxy(factory(), { ownKeys() { throw Error(SYNTHETIC_PRIVATE); } });
    assert.equal(decodeCandidateBatchDisplay(wrap(proxy)), null);
  });
}

test("decoder candidates preserve bounded batch order, empty and 100 rows; duplicate terminal IDs also fail", () => {
  const row = display().candidates[0]!;
  for (const ids of [[], ["z", "a"], Array.from({ length: MAX_CANDIDATE_BATCH_DISPLAY }, (_, index) => `candidate-${index}`)]) {
    const result = decodeCandidateBatchDisplay({ ...display(), candidates: ids.map((candidateId) => ({ ...row, candidateId })) });
    assert.ok(result); assert.deepEqual(result.candidates.map((candidate) => candidate.candidateId), ids); frozen(result);
  }
  assert.equal(decodeCandidateBatchDisplay({ ...display(), candidates: Array.from({ length: 101 }, (_, index) => ({ ...row, candidateId: `candidate-${index}` })) }), null);
  assert.equal(decodeCandidateBatchDisplay({ ...display(), candidates: [row, { ...row, state: "deleted", content: null }] }), null);
  assert.throws(() => projectCandidateBatch({ ...internal(), candidates: Array.from({ length: 101 }, () => internal().candidates[0]!) }, REVIEW_NOW),
    { message: "CANDIDATE_BATCH_PRESENTATION_INVALID" });
});

for (const target of ["candidates", "reviewReasons"] as const) {
  test(`decoder ${target} bounds before enumeration and refuses sparse/accessor/iterator/extra metadata`, () => {
    const source: unknown[] = target === "candidates" ? [{ ...display().candidates[0] }] : [...candidateContent().reviewReasons];
    const wrap = (value: unknown) => target === "candidates" ? { ...display(), candidates: value }
      : withContent({ ...contentInput(), reviewReasons: value });
    let getters = 0, iterators = 0, ownKeys = 0;
    const huge: unknown[] = []; huge.length = 1_000_000;
    const oversized = new Proxy(huge, { ownKeys(target) { ownKeys++; return Reflect.ownKeys(target); } });
    assert.equal(decodeCandidateBatchDisplay(wrap(oversized)), null); assert.equal(ownKeys, 0);
    const getter = [...source]; Object.defineProperty(getter, "0", { enumerable: true, get() { getters++; return source[0]; } });
    const sparse = [...source]; delete sparse[0];
    const iterator = [...source]; Object.defineProperty(iterator, Symbol.iterator, { value() { iterators++; return [][Symbol.iterator](); } });
    const hidden = [...source]; Object.defineProperty(hidden, "0", { value: source[0], enumerable: false });
    const extra = Object.assign([...source], { privateField: true });
    for (const input of [getter, sparse, iterator, hidden, extra, Object.setPrototypeOf([...source], {})]) assert.equal(decodeCandidateBatchDisplay(wrap(input)), null);
    assert.equal(getters, 0); assert.equal(iterators, 0);
  });
}

test("decoder rejects forged proof/status/evidence/confidence and missing or duplicated required warnings", () => {
  for (const patch of [{ accountProof: "verified" }, { currentBalanceProof: "verified" }, { reviewStatus: "accepted-by-user" },
    { evidenceAvailability: "retained" }, { extractionConfidence: "certain" }, { reviewReasons: [] },
    { reviewReasons: [...candidateContent().reviewReasons, "USER_REVIEW_REQUIRED"] },
    ...candidateContent().reviewReasons.map((reason) => ({ reviewReasons: candidateContent().reviewReasons.filter((item) => item !== reason) }))]) {
    assert.equal(decodeCandidateBatchDisplay(withContent({ ...contentInput(), ...patch })), null);
  }
});

test("decoder rejects malformed identity, generation, access timestamps, state and terminal payload", () => {
  for (const candidateId of ["", "has space", "x\n", "x".repeat(129), 1, null])
    assert.equal(decodeCandidateBatchDisplay({ ...display(), candidates: [{ ...display().candidates[0], candidateId }] }), null);
  for (const value of [0, -0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
    assert.equal(decodeCandidateBatchDisplay({ ...display(), dataGeneration: value }), null);
    assert.equal(decodeCandidateBatchDisplay({ ...display(), candidates: [{ ...display().candidates[0], candidateRevision: value }] }), null);
  }
  for (const accessExpiresAt of [-0, -1, 0.1, NaN, Infinity, 253402300800000, "1", null])
    assert.equal(decodeCandidateBatchDisplay({ ...display(), candidates: [{ ...display().candidates[0], accessExpiresAt }] }), null);
  assert.equal(decodeCandidateBatchDisplay({ ...display(), candidates: [{ ...display().candidates[0], state: "live" }] }), null);
  assert.equal(decodeCandidateBatchDisplay({ ...display(), candidates: [{ ...display().candidates[0], content: null }] }), null);
});

const valuePatches: readonly Partial<ExtractedValues>[] = [
  { name: null }, { name: "한글 😀" }, { name: "" }, { name: " padded " }, { name: "bad\nline" }, { name: "x".repeat(161) },
  { name: "\ud800" }, { kind: "trial", unit: "days", grantedAmount: 0, remainingAmount: 0, trialDaysStated: 14, remainingDaysStated: 0 },
  { unit: null }, { grantedAmount: -1 }, { remainingAmount: NaN }, { grantedAmount: Infinity },
  { grantedAmount: Number.MAX_SAFE_INTEGER + 1 }, { grantedAmount: 0.5 }, { remainingAmount: -0 },
  { trialDaysStated: 0.5 }, { remainingDaysStated: -1 }, { kind: "membership" },
  { kind: "membership", grantedAmount: null }, { expiresAt: "2028-02-29" }, { expiresAt: "2026-02-29" },
  { expiresAt: "2000-02-29T12:34:56.123456789+09:00", observedAt: "2026-09-27" },
  { expiresAt: "2026-10-18T00:00:00-00:00" }, { expiresAt: "2026-10-18T24:00:00Z" },
  { expiresAt: "2026-10-18T00:00:00+14:01" }, { expiresAt: "0000-01-01" },
  { expiresAt: "2026-10-18T00:00:00.1234567890Z" }, { observedAt: "2026-10-18T00:00:00" },
];
for (const [index, patch] of valuePatches.entries()) {
  test(`candidate decoder preserves server extraction value semantics and exact precision case ${index + 1}`, () => {
    const source = candidateContent({ values: { ...reviewValues(), ...patch } });
    let valid = true; try { parseCandidateContent(source); } catch { valid = false; }
    const result = decodeCandidateBatchDisplay(withContent({ ...contentInput(), values: source.values }));
    assert.equal(result !== null, valid);
    if (result) { const row = result.candidates[0]!; assert.equal(row.state, "pending"); assert.deepEqual(row.content.values, source.values); }
  });
}

test("canonical source instant and exact enum semantics remain aligned with internal candidate validation", () => {
  const patches: readonly Partial<CandidateContent>[] = [
    { extractionConfidence: "low" }, { extractionConfidence: "medium" }, { receivedAt: "2026-09-27T01:02:03.000Z" },
    { receivedAt: "2026-09-27" }, { extractedAt: "2026-09-27T01:02:03+09:00" },
    { extractedAt: "2026-02-29T00:00:00.000Z" }, { serviceName: "한글 서비스 😀" }, { serviceName: "" },
  ];
  for (const patch of patches) {
    const source = candidateContent(patch); let valid = true; try { parseCandidateContent(source); } catch { valid = false; }
    const result = decodeCandidateBatchDisplay(withContent({ ...contentInput(), ...Object.fromEntries(Object.keys(patch).map((key) => [key, patch[key as keyof CandidateContent]])) }));
    assert.equal(result !== null, valid);
  }
});

async function verifiedAnalysis(count: number, generation = 1) {
  const authority = analysisAuthority({ dataGeneration: generation });
  const adapters: MailAnalysisAdapters = {
    readAuthority: async () => ({ ...authority, grantOwnerId: authority.ownerId,
      grantSessionId: authority.sessionId, grantMailboxBindingId: authority.mailboxBindingId }),
    reserveQuota: async ({ authority: current }) => ({ status: "granted", ownerId: current.ownerId,
      sessionId: current.sessionId, sessionRevision: current.sessionRevision, dataGeneration: current.dataGeneration,
      mailboxBindingId: current.mailboxBindingId, recipientId: current.recipientId, policyVersion: current.policyVersion,
      grantId: current.grantId, grantRevision: current.grantRevision, operationId: current.operationId, remaining: 0 }),
    readMailbox: async () => JSON.stringify(count === 0 ? [] : [{ id: "synthetic-mail-never-exposed",
      snippet: "Synthetic Studio grants 100 credits.", payload: { mimeType: "text/plain",
        headers: [{ name: "Subject", value: "Synthetic Studio notice" }],
        body: { data: Buffer.from("Synthetic Studio grants 100 credits.").toString("base64url") } } }]),
    analyze: async () => JSON.stringify({ schema: "keyatlas.gmail-candidates.v1", discoveries: Array.from({ length: count }, () => ({
      evidence_message_index: 0, confidence: "high", benefit_kind: "credit",
      service_name: { value: "Synthetic Studio", part: "subject", quote: "Synthetic Studio" },
      benefit_name: null, unit: { value: "credits", part: "body", quote: "100 credits" },
      granted_amount: { value: 100, part: "body", quote: "grants 100 credits" },
      remaining_amount: null, trial_days: null, remaining_days: null, expires_at: null, observed_at: null,
    })) }), now: () => REVIEW_NOW,
  };
  const result = await runMailAnalysis(adapters, { operationId: authority.operationId,
    mailboxBindingId: authority.mailboxBindingId, recipientId: authority.recipientId });
  assert.ok(result.ok); assert.equal(result.candidates.length, count); return result;
}

test("actual analysis -> inbox stage/list -> projection/decoder -> review confirm keeps current terminal observations", async () => {
  const store = createReviewMemoryStore(); store.rows.candidates.clear();
  store.controls.authority = reviewAuthority({ dataGeneration: 7 });
  store.controls.analysisAuthority = analysisAuthority({ dataGeneration: 7 });
  store.controls.stagingGrant = stagingGrant({ dataGeneration: 7, pendingAccessUntil: REVIEW_NOW + 1000 });
  for (const service of store.rows.services.values()) Object.assign(service, { dataGeneration: 7 });
  const inbox = createCandidateInbox(store.inboxDependencies), review = createReviewService(store.dependencies);
  const original = await verifiedAnalysis(3, 7), staged = await inbox.stage(original); assert.ok(staged.ok);
  const shown = projectCandidateBatch(staged.value, store.controls.now);
  assert.equal(shown.dataGeneration, 7); assert.equal(shown.candidates.length, 3);
  assert.ok(shown.candidates.every((row) => row.state === "pending" && row.content.values.name === null));
  assert.deepEqual(decodeCandidateBatchDisplay(JSON.parse(JSON.stringify(shown))), shown);
  assert.equal(store.rows.benefits.size, 0);
  const first = shown.candidates[0]!, second = shown.candidates[1]!;
  const preview = await review.preview({ candidateId: first.candidateId, candidateRevision: first.candidateRevision,
    serviceId: SERVICE_ID, serviceRevision: 1, values: reviewValues({ name: "사용자가 입력한 합성 이름" }) }); assert.ok(preview.ok);
  const confirmed = await review.confirm({ previewId: preview.value.id, operationId: "synthetic-project-confirm", decision: "confirm" }); assert.ok(confirmed.ok);
  const discarded = await inbox.discard({ candidateId: second.candidateId, expectedRevision: second.candidateRevision, decision: "discard" }); assert.ok(discarded.ok);
  store.controls.now = REVIEW_NOW + 1000;
  const listed = await inbox.listBatch({ analysisOperationId: analysisAuthority().operationId }); assert.ok(listed.ok);
  const current = projectCandidateBatch(listed.value, store.controls.now);
  assert.deepEqual(current.candidates.map(({ state, content }) => ({ state, content })), [
    { state: "accepted", content: null }, { state: "deleted", content: null }, { state: "expired", content: null }]);
  assert.equal(store.rows.benefits.size, 1); assert.equal(store.rows.candidates.get(shown.candidates[2]!.candidateId)!.state, "pending");
  assert.notEqual(store.rows.candidates.get(shown.candidates[2]!.candidateId)!.content, null, "access expiry is not physical deletion");
  assert.equal(shown.candidates[0]!.state, "pending", "returned references cannot be recalled; the future owner must prevent reuse");
  const text = JSON.stringify(current); assert.ok(!text.includes("synthetic-mail-never-exposed"));
  assert.ok(!text.includes("Synthetic Studio grants 100 credits."));
});

test("genuine empty completed analysis/staging batch projects an empty observation, not an invented inbox total", async () => {
  const store = createReviewMemoryStore(); store.rows.candidates.clear();
  const result = await createCandidateInbox(store.inboxDependencies).stage(await verifiedAnalysis(0)); assert.ok(result.ok);
  const shown = projectCandidateBatch(result.value, store.controls.now);
  assert.deepEqual(shown, { schema: CANDIDATE_BATCH_VIEW_SCHEMA, dataGeneration: 1, candidates: [] });
  assert.equal(store.rows.batches.size, 1); assert.equal(store.rows.benefits.size, 0);
});

test("failed authority result cannot be projected as success and does not imply a committed stage rollback", async () => {
  const store = createReviewMemoryStore(); store.rows.candidates.clear();
  const original = await verifiedAnalysis(1);
  store.controls.afterCommit = () => { store.controls.authority = reviewAuthority({ sessionRevision: 2 }); };
  const result = await createCandidateInbox(store.inboxDependencies).stage(original);
  assert.deepEqual(result, { ok: false, code: "REVIEW_AUTHORITY_CHANGED" }); assert.equal(Object.hasOwn(result, "value"), false);
  assert.equal(store.rows.batches.size, 1); assert.equal(store.controls.commits, 1); assert.equal(store.controls.rollbacks, 0);
});
