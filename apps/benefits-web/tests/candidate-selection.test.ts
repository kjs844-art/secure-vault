import assert from "node:assert/strict";
import { test } from "node:test";
import { createCandidateSelection, MAX_CANDIDATE_SELECTION_IDS } from "../src/domain/candidate-selection.ts";
import { CANDIDATE_BATCH_VIEW_SCHEMA, decodeCandidateBatchDisplay, type CandidateDisplay } from "../src/domain/candidate-batch-view.ts";
import { CATALOG_VIEW_SCHEMA, type CatalogServiceView } from "../src/domain/catalog-client/responses.ts";

// Public synthetic DTO literals, not other tests' fixtures or server authority.
const NOW = 1790000000000;
const context = () => ({ bindingId: "synthetic-A", dataGeneration: 1 });
const time = (wall = NOW, monotonic = 10) => ({ wall, monotonic });
const candidate = (id = "synthetic-candidate", revision = 1): CandidateDisplay => ({ candidateId: id, candidateRevision: revision,
  accessExpiresAt: NOW + 1000, state: "pending", content: { serviceName: "Public synthetic provider", extractionConfidence: "low",
    values: { name: null, kind: "credit", unit: "credits", grantedAmount: 10.25, remainingAmount: 0,
      trialDaysStated: null, remainingDaysStated: 0, expiresAt: "2028-02-29", observedAt: "2026-09-27T12:34:56.123456789+09:00" },
    receivedAt: null, extractedAt: new Date(NOW).toISOString(), reviewReasons: ["USER_REVIEW_REQUIRED",
      "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED", "RECEIVED_DATE_UNKNOWN"],
    evidenceAvailability: "not-retained", reviewStatus: "pending-review", accountProof: "not-established", currentBalanceProof: "not-established" } });
const terminal = (state: "accepted" | "deleted" | "expired", revision = 2, id = "synthetic-candidate"): CandidateDisplay =>
  ({ candidateId: id, candidateRevision: revision, accessExpiresAt: NOW + 1000, state, content: null });
const service = (id = "synthetic-service", revision = 1): CatalogServiceView => ({ schema: CATALOG_VIEW_SCHEMA,
  dataGeneration: 1, serviceId: id, serviceRevision: revision, state: "live", profile: { name: "Public synthetic provider",
    provider: null, planName: null, accountLabel: null, timezone: null, subscriptionStatus: "unknown", trialEndsAt: null, notes: null },
  createdAt: NOW, updatedAt: NOW, provenance: "user-reported", accountProof: "not-established" });
const envelope = (candidates: readonly CandidateDisplay[] = [candidate()], services: readonly CatalogServiceView[] = [service()]) =>
  ({ ...context(), batch: { schema: CANDIDATE_BATCH_VIEW_SCHEMA, dataGeneration: 1, candidates }, services });
const owner = () => { const result = createCandidateSelection(context()); assert.ok(result); return result; };
const readyOwner = () => { const result = owner(); assert.equal(result.observe(envelope(), time()).status, "ready"); return result; };
function changedCandidate(revision: number, label: string): CandidateDisplay {
  const row = candidate("synthetic-candidate", revision); assert.equal(row.state, "pending");
  if (row.state !== "pending") throw new Error("TEST_PENDING_EXPECTED");
  return { ...row, content: { ...row.content, serviceName: label } };
}

test("construction validates context and is inert; stable empty/ready/check snapshots are deeply frozen", () => {
  for (const value of [null, {}, { ...context(), extra: 1 }, { ...context(), dataGeneration: 0 }, { ...context(), bindingId: " padded" }]) {
    assert.equal(createCandidateSelection(value), null);
  }
  const selection = owner(), empty = selection.getSnapshot();
  assert.equal(empty.status, "empty"); assert.equal(selection.getSnapshot(), empty); assert.ok(Object.isFrozen(empty));
  const ready = selection.observe(envelope(), time());
  assert.ok(Object.isFrozen(ready)); assert.ok(Object.isFrozen(ready.candidates)); assert.ok(Object.isFrozen(ready.services));
  assert.ok(Object.isFrozen(ready.candidates[0]?.content)); assert.ok(Object.isFrozen(ready.services[0]?.profile));
  assert.equal(selection.observe(envelope(), time()), ready); assert.equal(selection.check(time()), ready);
});
test("real DTO fixture is valid and output build uses explicit candidate/service IDs and revisions", () => {
  assert.ok(decodeCandidateBatchDisplay(envelope().batch));
  const selection = readyOwner();
  assert.deepEqual(selection.build("synthetic-candidate", "synthetic-service", null, time()), { kind: "needs-name" });
  const output = selection.build("synthetic-candidate", "synthetic-service", "Public chosen name", time());
  assert.equal(output.kind, "ready"); if (output.kind !== "ready") return;
  assert.deepEqual(output.draft.bindingId, context().bindingId); assert.equal(output.draft.dataGeneration, 1);
  assert.equal(output.draft.request.body.candidateId, "synthetic-candidate"); assert.equal(output.draft.request.body.candidateRevision, 1);
  assert.equal(output.draft.request.body.serviceId, "synthetic-service"); assert.equal(output.draft.request.body.serviceRevision, 1);
  assert.equal(output.draft.request.body.values.name, "Public chosen name");
  assert.equal(output.draft.request.body.values.remainingAmount, 0); assert.equal(output.draft.request.body.values.trialDaysStated, null);
  assert.equal(output.draft.request.body.values.observedAt, "2026-09-27T12:34:56.123456789+09:00");
  assert.equal(output.draft.request.body.values.expiresAt, "2028-02-29");
  assert.ok(Object.isFrozen(output.draft)); assert.ok(Object.isFrozen(output.draft.request.body.values));
  assert.equal(selection.getSnapshot().candidates[0]?.content?.values.name, null);
});
test("existing non-null name may be selected by null; explicit invalid names never fall back", () => {
  const selection = owner(), row = candidate(); assert.equal(row.state, "pending"); if (row.state !== "pending") return;
  selection.observe(envelope([{ ...row, content: { ...row.content, values: { ...row.content.values, name: "Public original" } } }]), time());
  const original = selection.build(row.candidateId, "synthetic-service", null, time());
  assert.equal(original.kind, "ready"); if (original.kind === "ready") assert.equal(original.draft.request.body.values.name, "Public original");
  for (const name of ["", " ", " padded", "padded ", "x".repeat(161), "\u0000", undefined, 12, {}]) {
    assert.deepEqual(selection.build(row.candidateId, "synthetic-service", name, time()), { kind: "invalid" });
  }
});
test("matching extracted service text is not an automatic match and only current explicit live service is usable", () => {
  const selection = readyOwner();
  assert.deepEqual(selection.build("synthetic-candidate", null, "Public", time()), { kind: "invalid" });
  assert.deepEqual(selection.build("synthetic-candidate", "Public synthetic provider", "Public", time()), { kind: "invalid" });
  assert.deepEqual(selection.build("synthetic-candidate", "synthetic-other", "Public", time()), { kind: "unavailable" });
  selection.observe(envelope([candidate()], [service("synthetic-other", 5)]), time());
  assert.deepEqual(selection.build("synthetic-candidate", "synthetic-service", "Public", time()), { kind: "unavailable" });
  const result = selection.build("synthetic-candidate", "synthetic-other", "Public", time());
  assert.equal(result.kind, "ready"); if (result.kind === "ready") assert.equal(result.draft.request.body.serviceRevision, 5);
});
test("foreign scope hides old rows without inspecting payload or clock and may recover with matching envelope", () => {
  const selection = readyOwner(); let reads = 0;
  const poison = new Proxy({}, { getPrototypeOf() { reads++; throw new Error("synthetic detail"); } });
  for (const scope of [{ bindingId: "synthetic-B", dataGeneration: 1 }, { bindingId: "synthetic-A", dataGeneration: 2 }]) {
    const result = selection.observe({ ...scope, batch: poison, services: poison }, poison);
    assert.deepEqual(result, { status: "invalid", candidates: [], services: [] }); assert.equal(reads, 0);
    assert.equal(selection.observe(envelope(), time()).status, "ready");
  }
});
test("malformed scoped observations discard displayed data but preserve prior revision fences", () => {
  const selection = readyOwner(); selection.observe(envelope([candidate("synthetic-candidate", 3)], [service("synthetic-service", 4)]), time());
  assert.equal(selection.observe({ ...envelope(), batch: null }, time()).status, "invalid");
  const restored = selection.observe(envelope(), time());
  assert.equal(restored.candidates[0]?.candidateRevision, 3); assert.equal(restored.services[0]?.serviceRevision, 4);
});
test("only current IDs are displayed, but omitted IDs cannot bypass retained newer revision fences", () => {
  const selection = readyOwner();
  selection.observe(envelope([changedCandidate(3, "Public latest")], [service("synthetic-service", 3)]), time());
  selection.observe(envelope([], []), time()); assert.deepEqual(selection.getSnapshot(), { status: "ready", candidates: [], services: [] });
  assert.deepEqual(selection.build("synthetic-candidate", "synthetic-service", "Public", time()), { kind: "unavailable" });
  const snapshot = selection.observe(envelope(), time());
  assert.equal(snapshot.candidates[0]?.content?.serviceName, "Public latest"); assert.equal(snapshot.services[0]?.serviceRevision, 3);
});
test("equal candidate revision with different content permanently closes the owner atomically", () => {
  const selection = readyOwner();
  const result = selection.observe(envelope([changedCandidate(1, "Public mismatch"), candidate("new-public")], [service("new-service")]), time());
  assert.deepEqual(result, { status: "conflict", candidates: [], services: [] });
  assert.equal(selection.observe(envelope(), time()), result); assert.equal(selection.check(time()), result);
  assert.deepEqual(selection.build("synthetic-candidate", "synthetic-service", "Public", time()), { kind: "unavailable" });
});
test("candidate access deadline is immutable even at a newer or older revision", () => {
  for (const revision of [1, 2, 4]) {
    const selection = owner(); selection.observe(envelope([candidate("synthetic-candidate", 2)]), time());
    assert.equal(selection.observe(envelope([{ ...candidate("synthetic-candidate", revision), accessExpiresAt: NOW + 2000 }]), time()).status, "conflict");
  }
});
test("same-version pending to expired is allowed and expired dominates stale pending", () => {
  const selection = readyOwner();
  assert.equal(selection.observe(envelope([terminal("expired", 1)]), time()).candidates[0]?.state, "expired");
  for (const revision of [1, 2]) {
    const snapshot = selection.observe(envelope([candidate("synthetic-candidate", revision)]), time());
    assert.equal(snapshot.status, "ready"); assert.equal(snapshot.candidates[0]?.state, "expired"); assert.equal(snapshot.candidates[0]?.content, null);
  }
});
test("accepted and deleted candidates never revive; accepted can advance to deleted", () => {
  for (const state of ["accepted", "deleted"] as const) {
    const selection = readyOwner(); selection.observe(envelope([terminal(state)]), time());
    for (const revision of [1, 3]) {
      const snapshot = selection.observe(envelope([candidate("synthetic-candidate", revision)]), time());
      assert.equal(snapshot.candidates[0]?.state, state); assert.equal(snapshot.candidates[0]?.content, null);
    }
  }
  const selection = readyOwner(); selection.observe(envelope([terminal("accepted")]), time());
  assert.equal(selection.observe(envelope([terminal("deleted", 3)]), time()).candidates[0]?.state, "deleted");
});
test("equal revision terminal contradiction other than pending/expired is conflict", () => {
  const selection = readyOwner();
  assert.equal(selection.observe(envelope([terminal("accepted", 1)]), time()).status, "conflict");
});
test("service equal revision content conflict is permanent; stale revisions cannot replace latest profile", () => {
  const selection = readyOwner();
  selection.observe(envelope([candidate()], [{ ...service("synthetic-service", 3), profile: { ...service().profile!, name: "Public latest" } }]), time());
  assert.equal(selection.observe(envelope(), time()).services[0]?.profile?.name, "Public latest");
  assert.equal(selection.observe(envelope([candidate()], [service("synthetic-service", 3)]), time()).status, "conflict");
});
test("service tombstone never revives and cannot be explicitly selected", () => {
  const selection = readyOwner();
  selection.observe(envelope([candidate()], [{ ...service("synthetic-service", 2), state: "deleted", profile: null }]), time());
  for (const revision of [1, 3]) {
    const result = selection.observe(envelope([candidate()], [service("synthetic-service", revision)]), time());
    assert.equal(result.services[0]?.state, "deleted"); assert.equal(result.services[0]?.profile, null);
    assert.deepEqual(selection.build("synthetic-candidate", "synthetic-service", "Public", time()), { kind: "unavailable" });
  }
});
test("exact wall deadline redacts only pending candidate content and prevents build", () => {
  const selection = readyOwner(), initial = selection.getSnapshot();
  assert.equal(selection.check(time(NOW + 999, 11)), initial);
  const expired = selection.check(time(NOW + 1000, 12));
  assert.equal(expired.candidates[0]?.state, "expired"); assert.equal(expired.candidates[0]?.content, null);
  assert.equal(expired.services.length, 1);
  assert.deepEqual(selection.build("synthetic-candidate", "synthetic-service", "Public", time(NOW + 1000, 12)), { kind: "unavailable" });
});
test("monotonic elapsed expires access under a frozen wall clock without extending on observations", () => {
  const selection = readyOwner();
  selection.observe(envelope(), time(NOW, 1009.5)); assert.equal(selection.getSnapshot().candidates[0]?.state, "pending");
  const expired = selection.check(time(NOW, 1010)); assert.equal(expired.candidates[0]?.state, "expired");
  assert.equal(selection.observe(envelope(), time(NOW, 1010)).candidates[0]?.content, null);
});
test("wall forward jump resets the stronger trajectory, but a nearly frozen wall never extends it", () => {
  const selection = readyOwner(); selection.check(time(NOW + 800, 20));
  selection.check(time(NOW + 801, 219.5)); assert.equal(selection.getSnapshot().candidates[0]?.state, "pending");
  selection.check(time(NOW + 801, 220)); assert.equal(selection.getSnapshot().candidates[0]?.state, "expired");
});
test("expired-before-observe and hidden retained candidate content are redacted before redisplay", () => {
  const selection = owner();
  selection.observe(envelope(), time(NOW + 1000)); assert.equal(selection.getSnapshot().candidates[0]?.content, null);
  const hidden = readyOwner(); hidden.observe(envelope([], []), time()); hidden.check(time(NOW, 1010));
  assert.equal(hidden.observe(envelope(), time(NOW, 1010)).candidates[0]?.state, "expired");
});
test("recorded benefit expiry is not the candidate access deadline; terminal state is not changed by check", () => {
  const row = candidate(); assert.equal(row.state, "pending"); if (row.state !== "pending") return;
  const selection = owner(); selection.observe(envelope([{ ...row, content: { ...row.content,
    values: { ...row.content.values, expiresAt: "2000-01-01" } } }]), time());
  assert.equal(selection.build(row.candidateId, "synthetic-service", "Public", time()).kind, "ready");
  selection.observe(envelope([terminal("accepted")]), time()); selection.check(time(NOW + 2000));
  assert.equal(selection.getSnapshot().candidates[0]?.state, "accepted");
});
for (const badTime of [null, {}, { wall: NOW, monotonic: NaN }, { wall: NOW, monotonic: Infinity }, { wall: NOW, monotonic: -0 },
  { wall: -0, monotonic: 10 }, { wall: NOW + 0.5, monotonic: 10 }, { wall: 253402300800000, monotonic: 10 },
  { wall: NOW, monotonic: Number.MAX_SAFE_INTEGER + 1 }, { wall: NOW, monotonic: 10, extra: true },
  { wall: NOW - 1, monotonic: 10 }, { wall: NOW, monotonic: 9 }]) test(`invalid/rollback clock permanently closes: ${JSON.stringify(badTime)}`, () => {
  const selection = readyOwner(), closed = selection.check(badTime);
  assert.deepEqual(closed, { status: "invalid", candidates: [], services: [] });
  assert.equal(selection.observe(envelope(), time()), closed);
  assert.equal(selection.build("synthetic-candidate", "synthetic-service", "Public", time()).kind, "unavailable");
});
test("clock accessors are not called and cause permanent closure", () => {
  const selection = readyOwner(); let calls = 0;
  const input = Object.defineProperty({ monotonic: 10 }, "wall", { enumerable: true, get() { calls++; return NOW; } });
  assert.equal(selection.check(input).status, "invalid"); assert.equal(calls, 0);
  assert.equal(selection.observe(envelope(), time()).status, "invalid");
});
test("malformed arrays, duplicate IDs, foreign generation and accessors do not partially publish", () => {
  let calls = 0;
  const sparse: unknown[] = new Array(1);
  const accessor = Object.defineProperty([service()], "0", { enumerable: true, get() { calls++; return service(); } });
  const extra = Object.assign([service()], { extra: 1 });
  const huge = new Proxy(new Array(1001), { ownKeys() { calls++; throw new Error("must not enumerate"); } });
  for (const input of [{ ...envelope(), services: sparse }, { ...envelope(), services: accessor }, { ...envelope(), services: extra },
    { ...envelope(), services: huge }, envelope([candidate()], [service(), service()]),
    envelope([candidate(), candidate()]), envelope([candidate()], [{ ...service(), dataGeneration: 2 }]),
    { ...envelope(), batch: { ...envelope().batch, dataGeneration: 2 } }]) {
    const selection = readyOwner(); assert.deepEqual(selection.observe(input, time()), { status: "invalid", candidates: [], services: [] });
    assert.equal(selection.observe(envelope(), time()).status, "ready");
  }
  assert.equal(calls, 0);
});
test("exact envelopes reject extra/hidden/symbol/accessor fields and contain reflection exceptions", () => {
  let calls = 0;
  const accessor = Object.defineProperty(envelope(), "batch", { enumerable: true, get() { calls++; return envelope().batch; } });
  const hidden = Object.defineProperty(envelope(), "batch", { enumerable: false, value: envelope().batch });
  const throwing = new Proxy(envelope(), { ownKeys() { throw new Error("public trap detail"); } });
  for (const input of [accessor, hidden, throwing, { ...envelope(), extra: 1 }, { ...envelope(), [Symbol("extra")]: 1 }, Object.create(envelope())]) {
    assert.equal(readyOwner().observe(input, time()).status, "invalid");
  }
  assert.equal(calls, 0);
});
test("reentrant Proxy observations/check/build cannot replace an in-progress observation", () => {
  const selection = readyOwner(); let inner: unknown;
  const proxy = new Proxy(envelope([candidate("new-public")]), { getPrototypeOf(target) {
    inner = selection.build("synthetic-candidate", "synthetic-service", "Public", time());
    selection.observe(envelope([terminal("deleted")]), time()); selection.check({ wall: -1, monotonic: -1 });
    return Reflect.getPrototypeOf(target);
  } });
  const result = selection.observe(proxy, time());
  assert.deepEqual(inner, { kind: "unavailable" }); assert.equal(result.status, "ready");
  assert.deepEqual(result.candidates.map((row) => row.candidateId), ["new-public"]);
});
test("combined candidate and service fence capacity is 1000 across observations and is permanent", () => {
  const selection = owner();
  const catalog = Array.from({ length: MAX_CANDIDATE_SELECTION_IDS - 1 }, (_, index) => service(`public-service-${index}`));
  assert.equal(selection.observe(envelope([candidate()], catalog), time()).status, "ready");
  selection.observe(envelope([], []), time());
  const full = selection.observe(envelope([candidate("new-public")], []), time());
  assert.deepEqual(full, { status: "capacity", candidates: [], services: [] });
  assert.equal(selection.observe(envelope(), time()), full);
});
test("separate candidate and service namespaces both consume capacity even if their textual IDs match", () => {
  const selection = owner();
  const catalog = Array.from({ length: 1000 }, (_, index) => service(`public-${index}`));
  assert.equal(selection.observe(envelope([candidate("public-0")], catalog), time()).status, "capacity");
});
test("reusing known IDs is not capacity growth and current source order is preserved", () => {
  const selection = owner(), rows = [candidate("second"), candidate("first")], catalog = [service("second"), service("first")];
  const initial = selection.observe(envelope(rows, catalog), time());
  assert.equal(selection.observe(envelope(rows, catalog), time()), initial);
  assert.deepEqual(initial.candidates.map((row) => row.candidateId), ["second", "first"]);
  assert.deepEqual(initial.services.map((row) => row.serviceId), ["second", "first"]);
});
