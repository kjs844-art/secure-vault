import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewedBenefitListOwner } from "../src/domain/reviewed-benefit-list-owner.ts";
import { REVIEWED_BENEFIT_PAGE_SCHEMA, decodeReviewedBenefitPage } from "../src/domain/reviewed-benefit-page.ts";
import { REVIEWED_BENEFIT_VIEW_SCHEMA, type ReviewedBenefitView } from "../src/domain/reviewed-benefit-view.ts";
import { projectReviewedBenefit } from "../src/server/review/presentation.ts";
import { REVIEW_SCHEMA } from "../src/server/review/contracts.ts";
import { candidateContent, REVIEW_NOW, SERVICE_ID, reviewValues } from "./support/review-memory-store.ts";

// Pure synthetic traversal ownership. Fixtures use the existing server-to-view
// projection, not real accounts, HTTP, provider data, DB, clocks or DOM events.
// A page end/count is an observation, never proof of current balance/completeness.
type Owner = ReturnType<typeof createReviewedBenefitListOwner>;
function id(index: number): string { return `synthetic-benefit-${String(index).padStart(4, "0")}`; }
function saved(index = 0, revision = 1, generation = 1) {
  const projected = projectReviewedBenefit({ schema: REVIEW_SCHEMA, dataGeneration: generation,
    benefitId: id(index), benefitRevision: revision, outcome: "saved", content: {
      schema: REVIEW_SCHEMA, serviceId: SERVICE_ID, serviceNameAtReview: "Synthetic Studio",
      candidateId: `synthetic-candidate-${index}`, candidateRevision: 1,
      values: reviewValues({ remainingAmount: 0, expiresAt: "2020-02-29",
        observedAt: "2026-09-27T12:34:56.123456789+09:00" }),
      valueOrigins: { name: "email-extracted", kind: "email-extracted", unit: "email-extracted",
        grantedAmount: "email-extracted", remainingAmount: "user-corrected", trialDaysStated: "email-extracted",
        remainingDaysStated: "email-extracted", expiresAt: "user-corrected", observedAt: "user-corrected" },
      source: candidateContent(), reviewedAt: new Date(REVIEW_NOW).toISOString(),
      reviewStatus: "accepted-by-user", accountProof: "not-established", currentBalanceProof: "not-established",
    } });
  assert.equal(projected.outcome, "saved");
  assert.ok(projected.content);
  return projected;
}
function deleted(index = 0, revision = 2, generation = 1): ReviewedBenefitView {
  return { schema: REVIEWED_BENEFIT_VIEW_SCHEMA, dataGeneration: generation,
    benefitId: id(index), benefitRevision: revision, outcome: "deleted", content: null };
}
function page(start = 0, count = 50, more = true, revision = 7, generation = 1) {
  return { schema: REVIEWED_BENEFIT_PAGE_SCHEMA, dataGeneration: generation,
    benefitCollectionRevision: revision,
    benefits: Array.from({ length: count }, (_, offset) => saved(start + offset, 1, generation)),
    nextCursor: more ? { afterId: id(start + count - 1), benefitCollectionRevision: revision, dataGeneration: generation } : null };
}
function state(owner: Owner) { const value = owner.getSnapshot(); assert.ok(value); return value; }
function active(owner: Owner, generation = 1) { const lease = owner.activate(generation); assert.ok(lease); return lease; }
function begin(owner: Owner, lease = state(owner).lease) {
  const previous = state(owner);
  const attempt = owner.begin(lease, previous); assert.ok(attempt);
  return { ...attempt, lease, previous };
}
function fixture(generation = 1) {
  const owner = createReviewedBenefitListOwner();
  const lease = active(owner, generation);
  return { owner, lease };
}
function more() {
  const f = fixture(); const attempt = begin(f.owner, f.lease);
  assert.equal(f.owner.settle(attempt.ticket, page()), true);
  return { ...f, attempt, shown: state(f.owner) };
}
function frozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}
function hostile(counter: { reads: number }): object {
  return new Proxy({}, {
    getPrototypeOf() { counter.reads++; throw Error("SYNTHETIC_PRIVATE_DETAIL"); },
    ownKeys() { counter.reads++; throw Error("SYNTHETIC_PRIVATE_DETAIL"); },
    get() { counter.reads++; throw Error("SYNTHETIC_PRIVATE_DETAIL"); },
  });
}

test("construction and cached reads are inert; activation provides opaque frozen ready lifetime", () => {
  const owner = createReviewedBenefitListOwner();
  assert.equal(owner.getSnapshot(), null); assert.equal(owner.getSnapshot(), null);
  const lease = active(owner), first = state(owner);
  assert.deepEqual(first, { lease, dataGeneration: 1, entries: [], phase: "ready",
    benefitCollectionRevision: null, pagesAccepted: 0, pageRowsObserved: 0 });
  assert.deepEqual(Object.keys(lease), []);
  assert.equal(owner.getSnapshot(), first); frozen(first); frozen(owner);
});

test("fixture projection preserves past observations, unknown source and corrected zero without invented proof", () => {
  const value = page(0, 1, false);
  assert.ok(decodeReviewedBenefitPage(value));
  const f = fixture(), attempt = begin(f.owner, f.lease);
  assert.equal(f.owner.settle(attempt.ticket, value), true);
  const row = state(f.owner).entries[0]!;
  assert.ok(row.content);
  assert.equal(row.content.values.remainingAmount, 0);
  assert.equal(row.content.values.trialDaysStated, null);
  assert.equal(row.content.values.expiresAt, "2020-02-29");
  assert.equal(row.content.values.observedAt, "2026-09-27T12:34:56.123456789+09:00");
  assert.equal(row.content.sourceObservedAt, null);
  assert.equal(row.content.valueOrigins.remainingAmount, "user-corrected");
  assert.equal(row.content.accountProof, "not-established");
  assert.equal(row.content.currentBalanceProof, "not-established");
});

test("begin requires exact lease/snapshot and produces one frozen limit-50 opaque attempt", () => {
  const f = fixture(), first = state(f.owner);
  assert.equal(f.owner.begin({}, first), null);
  assert.equal(f.owner.begin(f.lease, { ...first }), null);
  const attempt = begin(f.owner, f.lease), loading = state(f.owner);
  assert.deepEqual(attempt.request, { limit: 50, cursor: null });
  assert.deepEqual(Object.keys(attempt.ticket), []); frozen(attempt.ticket); frozen(attempt.request);
  assert.equal(loading.phase, "loading");
  assert.equal(f.owner.begin(f.lease, first), null);
  assert.equal(f.owner.begin(f.lease, loading), null, "only one pending ticket");
  assert.equal(f.owner.getSnapshot(), loading);
});

test("one accepted full page binds the next explicit request; no automatic following or reuse", () => {
  const f = more();
  assert.equal(f.shown.phase, "more");
  assert.equal(f.shown.pagesAccepted, 1); assert.equal(f.shown.pageRowsObserved, 50);
  assert.equal(f.shown.benefitCollectionRevision, 7);
  assert.equal(f.owner.settle(f.attempt.ticket, page(50)), false);
  assert.equal(f.owner.fail(f.attempt.ticket), false);
  assert.equal(f.owner.getSnapshot(), f.shown);
  const second = begin(f.owner, f.lease);
  assert.deepEqual(second.request, { limit: 50,
    cursor: { afterId: id(49), benefitCollectionRevision: 7, dataGeneration: 1 } });
  assert.notEqual(second.ticket, f.attempt.ticket); frozen(second.request);
  assert.equal(f.owner.settle(second.ticket, page(50, 2, false)), true);
  const end = state(f.owner);
  assert.equal(end.phase, "end_observed");
  assert.equal(end.pagesAccepted, 2); assert.equal(end.pageRowsObserved, 52);
  assert.equal(end.entries.length, 52);
  assert.deepEqual(end.entries.map((row) => row.benefitId), Array.from({ length: 52 }, (_, i) => id(i)));
  assert.equal(f.owner.begin(f.lease, end), null);
});

test("empty initial/follow-up pages observe an end but never erase already observed records", () => {
  const f = fixture(), a = begin(f.owner, f.lease);
  assert.equal(f.owner.settle(a.ticket, page(0, 0, false)), true);
  assert.equal(state(f.owner).phase, "end_observed");
  assert.equal(state(f.owner).pagesAccepted, 1); assert.equal(state(f.owner).pageRowsObserved, 0);
  const g = more(), b = begin(g.owner, g.lease), prior = state(g.owner).entries;
  assert.equal(g.owner.settle(b.ticket, page(50, 0, false)), true);
  assert.deepEqual(state(g.owner).entries, prior);
  assert.equal(state(g.owner).phase, "end_observed");
  assert.equal(state(g.owner).pageRowsObserved, 50);
});

test("decoded input is detached/frozen and mutation after settlement cannot rewrite observations", () => {
  const f = fixture(), a = begin(f.owner, f.lease);
  const input = structuredClone(page());
  assert.equal(f.owner.settle(a.ticket, input), true);
  const shown = state(f.owner), before = structuredClone(shown.entries);
  (input.benefits[0]!.content!.values as { name: string }).name = "Different fixture label";
  input.benefits.length = 0; input.nextCursor!.afterId = "forged";
  assert.deepEqual(shown.entries, before); frozen(shown);
  assert.equal(begin(f.owner, f.lease).request.cursor?.afterId, id(49));
});

for (const [label, value] of [["zero", 0], ["negative", -1], ["fraction", 1.5], ["NaN", NaN],
  ["infinite", Infinity], ["unsafe", Number.MAX_SAFE_INTEGER + 1], ["string", "1"], ["null", null], ["object", {}]] as const) {
  test(`invalid activation ${label} clears an existing lifetime and pending ticket`, () => {
    const f = more(), a = begin(f.owner, f.lease);
    assert.equal(f.owner.activate(value), null); assert.equal(f.owner.getSnapshot(), null);
    assert.equal(f.owner.settle(a.ticket, page(50)), false);
  });
}

test("fresh same-generation A-B-A activations clear all rows and stale handles are ignored before decode", () => {
  const f = more(), old = begin(f.owner, f.lease), reads = { reads: 0 };
  const b = active(f.owner, 2), bAttempt = begin(f.owner, b);
  const a = active(f.owner, 1), shown = state(f.owner);
  assert.notEqual(a, f.lease); assert.notEqual(a, b);
  assert.deepEqual(shown.entries, []); assert.equal(shown.pagesAccepted, 0);
  assert.equal(shown.benefitCollectionRevision, null);
  for (const attempt of [old, bAttempt]) {
    assert.equal(f.owner.settle(attempt.ticket, hostile(reads)), false);
    assert.equal(f.owner.fail(attempt.ticket, "authority"), false);
    assert.equal(f.owner.cancel(attempt.lease, attempt.ticket), false);
    assert.equal(f.owner.observe(attempt.lease, hostile(reads)), "ignored");
    f.owner.deactivate(attempt.lease);
  }
  assert.equal(reads.reads, 0); assert.equal(f.owner.getSnapshot(), shown);
});

test("forged and other-owner tickets/leases cannot settle or revoke the active owner", () => {
  const f = fixture(), g = fixture(), a = begin(f.owner), b = begin(g.owner), reads = { reads: 0 };
  const shown = state(f.owner);
  for (const ticket of [{}, { ...a.ticket }, b.ticket]) {
    assert.equal(f.owner.settle(ticket, hostile(reads)), false);
    assert.equal(f.owner.fail(ticket, "authority"), false);
  }
  assert.equal(f.owner.observe(g.lease, hostile(reads)), "ignored");
  f.owner.deactivate(g.lease);
  assert.equal(f.owner.getSnapshot(), shown); assert.equal(reads.reads, 0);
});

for (const mode of ["default retry", "explicit retry", "cancel ticket", "cancel snapshot"] as const) {
  test(`${mode} keeps the exact pending cursor for a fresh explicit retry and consumes old ticket`, () => {
    const f = more(), a = begin(f.owner), pending = state(f.owner);
    const accepted = mode === "default retry" ? f.owner.fail(a.ticket)
      : mode === "explicit retry" ? f.owner.fail(a.ticket, "retry")
      : f.owner.cancel(f.lease, mode === "cancel ticket" ? a.ticket : pending);
    assert.equal(accepted, true);
    assert.equal(state(f.owner).phase, "retry_required");
    assert.equal(state(f.owner).entries, f.shown.entries);
    assert.equal(state(f.owner).pagesAccepted, 1);
    const retry = begin(f.owner);
    assert.notEqual(retry.ticket, a.ticket); assert.deepEqual(retry.request, a.request);
    assert.equal(f.owner.settle(a.ticket, page(50)), false);
    assert.equal(f.owner.fail(a.ticket, "authority"), false);
    assert.equal(f.owner.settle(retry.ticket, page(50, 1, false)), true);
  });
}

test("cancel only accepts current pending snapshot/ticket and cannot undo accepted observations", () => {
  const f = more(), a = begin(f.owner), loading = state(f.owner);
  assert.equal(f.owner.cancel(f.lease, a.previous), false);
  assert.equal(f.owner.cancel({}, loading), false);
  assert.equal(f.owner.cancel(f.lease, { ...loading }), false);
  assert.equal(f.owner.getSnapshot(), loading);
  assert.equal(f.owner.settle(a.ticket, page(50, 1, false)), true);
  const end = state(f.owner);
  assert.equal(f.owner.cancel(f.lease, a.ticket), false);
  assert.equal(f.owner.cancel(f.lease, end), false);
  assert.equal(f.owner.getSnapshot(), end);
});

test("conflict is sticky until fresh activation; authority failure revokes; invalid fail reason leaves pending", () => {
  const f = more(), a = begin(f.owner);
  const loading = state(f.owner);
  assert.equal(f.owner.fail(a.ticket, "unexpected"), false); assert.equal(f.owner.getSnapshot(), loading);
  assert.equal(f.owner.fail(a.ticket, "conflict"), true);
  assert.equal(state(f.owner).phase, "restart_required");
  assert.equal(f.owner.begin(f.lease, state(f.owner)), null);
  assert.equal(f.owner.fail(a.ticket, "retry"), false);
  const lease = active(f.owner), next = begin(f.owner, lease);
  assert.equal(f.owner.fail(next.ticket, "authority"), true);
  assert.equal(f.owner.getSnapshot(), null);
  assert.equal(f.owner.settle(next.ticket, page()), false);
});

for (const [label, make] of [
  ["invalid shape", () => ({})], ["foreign generation", () => page(50, 1, false, 7, 2)],
  ["higher collection revision", () => page(50, 1, false, 8)],
  ["lower collection revision", () => page(50, 1, false, 6)],
  ["overlap with earlier page", () => page(49, 2, false)],
  ["rows before request cursor", () => page(0, 2, false)],
  ["short page with more", () => page(50, 49, true)],
  ["empty page with more", () => page(50, 0, true)],
  ["overfull page", () => page(50, 51, false)],
  ["deleted row", () => ({ ...page(50, 1, false), benefits: [deleted(50)] })],
] as const) test(`follow-up ${label} rejects the entire page, consumes ticket and requires restart`, () => {
  const f = more(), a = begin(f.owner), before = state(f.owner);
  assert.equal(f.owner.settle(a.ticket, make()), false);
  const rejected = state(f.owner);
  assert.equal(rejected.phase, "restart_required");
  assert.equal(rejected.entries, before.entries);
  assert.equal(rejected.pagesAccepted, before.pagesAccepted);
  assert.equal(rejected.pageRowsObserved, before.pageRowsObserved);
  assert.equal(rejected.benefitCollectionRevision, 7);
  assert.equal(f.owner.settle(a.ticket, page(50)), false);
  assert.equal(f.owner.begin(f.lease, rejected), null);
});

test("invalid final row cannot publish a partial page and ordinary getters are not invoked", () => {
  const f = more(), a = begin(f.owner), input = page(50, 2, false), before = state(f.owner).entries;
  let getters = 0;
  const malformed = { ...input, benefits: [input.benefits[0], { ...input.benefits[1],
    get content() { getters++; return input.benefits[1]!.content; } }] };
  assert.equal(f.owner.settle(a.ticket, malformed), false);
  assert.equal(getters, 0); assert.equal(state(f.owner).entries, before);
  assert.equal(state(f.owner).pageRowsObserved, 50);
});

for (const mode of ["new saved", "equal saved", "older saved", "new deletion"] as const) {
  test(`current receipt ${mode} invalidates a pending traversal, including unchanged observations`, () => {
    const f = fixture(), initial = page(), first = begin(f.owner);
    if (mode === "older saved") initial.benefits[0] = saved(0, 3);
    assert.equal(f.owner.settle(first.ticket, initial), true);
    const a = begin(f.owner);
    assert.equal(state(f.owner).phase, "loading", "the receipt, not an earlier receipt, must invalidate this ticket");
    const expected = mode === "equal saved" || mode === "older saved" ? "unchanged" : "updated";
    const row = mode === "new saved" ? saved(100)
      : mode === "new deletion" ? deleted() : saved();
    assert.equal(f.owner.observe(f.lease, row), expected);
    const shown = state(f.owner);
    assert.equal(shown.phase, "restart_required");
    assert.equal(shown.pagesAccepted, 1); assert.equal(shown.pageRowsObserved, 50);
    assert.equal(f.owner.settle(a.ticket, page(50)), false);
    assert.equal(f.owner.begin(f.lease, shown), null);
    assert.equal(shown.entries.length, mode === "new saved" ? 51 : 50);
    if (mode === "older saved") assert.equal(shown.entries[0]!.benefitRevision, 3);
  });
}

test("tombstones never resurrect at higher saved revision; equal/older receipts cannot replace data", () => {
  const f = more();
  assert.equal(f.owner.observe(f.lease, deleted(0, 2)), "updated");
  const tombstone = state(f.owner).entries[0];
  assert.equal(f.owner.observe(f.lease, saved(0, 999)), "unchanged");
  assert.equal(state(f.owner).entries[0], tombstone);
  assert.equal(f.owner.observe(f.lease, deleted(0, 1)), "unchanged");
  assert.equal(state(f.owner).entries[0], tombstone);
  assert.equal(f.owner.observe(f.lease, deleted(0, 3)), "updated");
  assert.equal(state(f.owner).entries[0]!.benefitRevision, 3);
  const equal = structuredClone(saved(1));
  (equal.content!.values as { name: string }).name = "Different same-revision fixture";
  assert.equal(f.owner.observe(f.lease, equal), "unchanged");
  assert.equal(state(f.owner).entries[1]!.content!.values.name, "Synthetic credits");
});

for (const input of [null, {}, saved(0, 2, 2)]) test("malformed/foreign current observation restarts and preserves rows", () => {
  const f = more(), a = begin(f.owner), before = state(f.owner).entries;
  assert.equal(f.owner.observe(f.lease, input), "invalid");
  assert.equal(state(f.owner).phase, "restart_required");
  assert.equal(state(f.owner).entries, before);
  assert.equal(f.owner.settle(a.ticket, page(50)), false);
});

test("observing before first page and after end requires fresh activation, without silently auto-fetching", () => {
  const f = fixture();
  assert.equal(f.owner.observe(f.lease, saved()), "updated");
  assert.equal(state(f.owner).benefitCollectionRevision, null);
  assert.equal(state(f.owner).pageRowsObserved, 0);
  assert.equal(f.owner.begin(f.lease, state(f.owner)), null);
  const lease = active(f.owner), a = begin(f.owner, lease);
  assert.equal(f.owner.settle(a.ticket, page(0, 1, false)), true);
  assert.equal(f.owner.observe(lease, saved()), "unchanged");
  assert.equal(state(f.owner).phase, "restart_required");
  assert.equal(f.owner.begin(lease, state(f.owner)), null);
});

for (const finalMore of [false, true]) test(`twenty accepted pages are bounded with final more=${finalMore}`, () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) {
    const a = begin(f.owner);
    assert.equal(a.request.cursor?.afterId ?? null, index === 0 ? null : id(index * 50 - 1));
    assert.equal(f.owner.settle(a.ticket, page(index * 50, 50, index < 19 || finalMore)), true);
  }
  const last = state(f.owner);
  assert.equal(last.phase, finalMore ? "restart_required" : "end_observed");
  assert.equal(last.pagesAccepted, 20); assert.equal(last.pageRowsObserved, 1000);
  assert.equal(last.entries.length, 1000);
  assert.equal(f.owner.begin(f.lease, last), null);
  assert.equal(f.owner.getSnapshot(), last);
});

test("capacity includes tombstones: existing IDs may advance but no 1001st record or eviction is allowed", () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) {
    const a = begin(f.owner);
    assert.equal(f.owner.settle(a.ticket, page(index * 50, 50, index < 19)), true);
  }
  assert.equal(f.owner.observe(f.lease, deleted(0)), "updated");
  const before = state(f.owner).entries;
  assert.equal(f.owner.observe(f.lease, saved(1000)), "capacity");
  assert.equal(state(f.owner).entries, before); assert.equal(state(f.owner).entries.length, 1000);
  assert.equal(state(f.owner).entries[0]!.outcome, "deleted");
  assert.equal(f.owner.observe(f.lease, saved(1, 2)), "updated");
  assert.equal(state(f.owner).entries[1]!.benefitRevision, 2);
  assert.equal(state(f.owner).pageRowsObserved, 1000);
  assert.equal(state(f.owner).phase, "restart_required");
});

test("deactivation/disposal release current references and tickets; disposal is permanent/idempotent", () => {
  const f = more(), a = begin(f.owner);
  const historical = state(f.owner);
  f.owner.deactivate(f.lease); assert.equal(f.owner.getSnapshot(), null);
  assert.equal(historical.entries.length, 50, "already returned snapshots cannot be recalled or erased");
  assert.equal(f.owner.settle(a.ticket, page(50)), false);
  const lease = active(f.owner), b = begin(f.owner, lease);
  f.owner.dispose(); f.owner.dispose();
  assert.equal(f.owner.activate(1), null); assert.equal(f.owner.getSnapshot(), null);
  assert.equal(f.owner.settle(b.ticket, page()), false);
  assert.equal(f.owner.fail(b.ticket), false); assert.equal(f.owner.observe(lease, saved()), "ignored");
});

test("subscriber exceptions do not block peers, unsubscribe is idempotent and cleared state is visible", () => {
  const owner = createReviewedBenefitListOwner(); let first = 0, second = 0;
  const seen: unknown[] = [];
  owner.subscribe(() => { first++; throw Error("SYNTHETIC_OBSERVER_DETAIL"); });
  const stop = owner.subscribe(() => { second++; seen.push(owner.getSnapshot()); });
  assert.equal(first, 0); assert.equal(second, 0);
  const lease = active(owner); owner.deactivate(lease);
  assert.equal(first, 2); assert.equal(second, 2); assert.equal(seen[1], null);
  stop(); stop(); active(owner); assert.equal(first, 3); assert.equal(second, 2);
  owner.dispose(); const count = first;
  owner.subscribe(() => { first++; }); owner.activate(1); assert.equal(first, count);
});

test("subscriber removal before its turn skips it; newly added listeners wait for another notification", () => {
  const owner = createReviewedBenefitListOwner(); let later = 0, added = 0;
  let removeLater = () => {};
  owner.subscribe(() => { removeLater(); owner.subscribe(() => { added++; }); });
  removeLater = owner.subscribe(() => { later++; });
  const lease = active(owner);
  assert.equal(later, 0); assert.equal(added, 0);
  owner.deactivate(lease); assert.equal(later, 0); assert.equal(added, 1);
});

test("ordinary mutations cannot reenter publication, while cached reads stay coherent", () => {
  const f = fixture(); const observed: unknown[][] = [];
  f.owner.subscribe(() => {
    const current = f.owner.getSnapshot();
    if (current?.phase !== "loading") return;
    // Do not assert inside callbacks: the owner intentionally isolates throws.
    observed.push([f.owner.activate(2), f.owner.begin(f.lease, current),
      f.owner.cancel(f.lease, current), f.owner.fail({}, "authority"),
      f.owner.settle({}, page()), f.owner.observe(f.lease, saved()), f.owner.getSnapshot() === current]);
  });
  const a = begin(f.owner);
  assert.deepEqual(observed, [[null, null, false, false, false, "ignored", true]]);
  assert.equal(f.owner.settle(a.ticket, page()), true);
});

test("revocation during activation/loading/settle publication defeats the outer success", () => {
  const owner = createReviewedBenefitListOwner();
  owner.subscribe(() => { const current = owner.getSnapshot(); if (current) owner.deactivate(current.lease); });
  assert.equal(owner.activate(1), null); assert.equal(owner.getSnapshot(), null);
  const f = fixture();
  f.owner.subscribe(() => { if (f.owner.getSnapshot()?.phase === "loading") f.owner.dispose(); });
  assert.equal(f.owner.begin(f.lease, state(f.owner)), null); assert.equal(f.owner.getSnapshot(), null);
  assert.equal(f.owner.activate(1), null);
  const g = fixture(), a = begin(g.owner);
  g.owner.subscribe(() => { if (g.owner.getSnapshot()?.phase === "more") g.owner.deactivate(g.lease); });
  assert.equal(g.owner.settle(a.ticket, page()), false); assert.equal(g.owner.getSnapshot(), null);
});

test("previous owner's deactivation during replacement null-notification aborts activation", () => {
  const f = more(); const seen: Array<ReturnType<Owner["getSnapshot"]>> = [];
  f.owner.subscribe(() => {
    const current = f.owner.getSnapshot(); seen.push(current);
    if (current === null) f.owner.deactivate(f.lease);
  });
  assert.equal(f.owner.activate(1), null);
  assert.equal(f.owner.getSnapshot(), null); assert.deepEqual(seen, [null]);
});

test("old cleanup after completed replacement is harmless even with the same generation", () => {
  const f = more(), replacement = active(f.owner), current = state(f.owner);
  f.owner.deactivate(f.lease);
  assert.equal(f.owner.getSnapshot(), current); assert.equal(current.lease, replacement);
  assert.deepEqual(current.entries, []);
});

for (const operation of ["settle", "observe"] as const) {
  test(`${operation} decoder reflection revocation cannot republish an otherwise valid decoded object`, () => {
    const f = fixture(), a = begin(f.owner);
    const value = operation === "settle" ? page() : saved();
    let invoked = 0;
    const input = new Proxy(value, { getPrototypeOf(target) {
      invoked++; f.owner.deactivate(f.lease); return Reflect.getPrototypeOf(target);
    } });
    const result = operation === "settle" ? f.owner.settle(a.ticket, input) : f.owner.observe(f.lease, input);
    assert.equal(result, operation === "settle" ? false : "ignored");
    assert.ok(invoked > 0); assert.equal(f.owner.getSnapshot(), null);
  });
}

test("decoder disposal permanently wins and nested decoder mutation cannot hijack a pending request", () => {
  const f = fixture(), a = begin(f.owner); let activation: unknown = "not-called";
  const input = new Proxy(page(), { ownKeys(target) {
    activation = f.owner.activate(2); f.owner.dispose(); return Reflect.ownKeys(target);
  } });
  assert.equal(f.owner.settle(a.ticket, input), false);
  assert.equal(activation, null); assert.equal(f.owner.getSnapshot(), null);
  assert.equal(f.owner.activate(1), null);
});

test("observation publication revoked by listener reports ignored and cannot reopen a traversal", () => {
  const f = more();
  f.owner.subscribe(() => { if (f.owner.getSnapshot()?.phase === "restart_required") f.owner.deactivate(f.lease); });
  assert.equal(f.owner.observe(f.lease, deleted()), "ignored");
  assert.equal(f.owner.getSnapshot(), null);
});
