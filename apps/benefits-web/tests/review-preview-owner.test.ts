import assert from "node:assert/strict";
import { test } from "node:test";
import { createReviewPreviewOwner } from "../src/domain/review-preview-owner.ts";
import { REVIEW_PREVIEW_VIEW_SCHEMA } from "../src/domain/review-preview-view.ts";

// Pure synthetic ownership/clock tests. No real authority, transport, server
// rollback, DOM lifecycle, timer scheduling, persistence or clock-sync proof.
const WALL = 1792281600000;
const MONO = 100.25;
const VALUE_KEYS = ["name", "kind", "unit", "grantedAmount", "remainingAmount",
  "trialDaysStated", "remainingDaysStated", "expiresAt", "observedAt"] as const;
function payload(previewId = "synthetic-preview", dataGeneration = 1, expiresAt = WALL + 1000) {
  return {
    schema: REVIEW_PREVIEW_VIEW_SCHEMA, dataGeneration, previewId, previewRevision: 1, expiresAt,
    content: {
      serviceId: "synthetic-service", serviceRevision: 1, serviceName: "합성 서비스",
      values: { name: "합성 혜택", kind: "credit", unit: "credits", grantedAmount: 10,
        remainingAmount: null, trialDaysStated: null, remainingDaysStated: null, expiresAt: null, observedAt: null },
      valueOrigins: Object.fromEntries(VALUE_KEYS.map((key) => [key, "email-extracted"])),
      receivedAt: null, extractedAt: "2026-10-18T00:00:00.000Z", sourceObservedAt: null,
      reviewReasons: ["USER_REVIEW_REQUIRED", "NOT_CURRENT_ACCOUNT_OR_BALANCE_PROOF", "EXPIRY_CONFIRMATION_NEEDED",
        "RECEIVED_DATE_UNKNOWN", "OBSERVATION_DATE_UNKNOWN"],
      evidenceAvailability: "not-retained", reviewStatus: "pending-review",
      accountProof: "not-established", currentBalanceProof: "not-established",
    },
  };
}
type Owner = ReturnType<typeof createReviewPreviewOwner>;
function fixture() {
  let wall = WALL, monotonic = MONO, reads = 0;
  let provider: (() => unknown) | null = null;
  const owner = createReviewPreviewOwner({ clocks: () => {
    reads++;
    return provider === null ? { wall, monotonic } : provider();
  } });
  return { owner, reads: () => reads,
    time: (nextWall: number, nextMonotonic: number) => { wall = nextWall; monotonic = nextMonotonic; },
    clock: (next: (() => unknown) | null) => { provider = next; } };
}
function active(owner: Owner, generation = 1) {
  const lease = owner.activate(generation);
  assert.ok(lease);
  return lease;
}
function begin(owner: Owner, lease = active(owner)) {
  const before = owner.getSnapshot(); assert.ok(before);
  const ticket = owner.begin(lease, before); assert.ok(ticket);
  return { lease, ticket, before };
}
function ready(owner: Owner, generation = 1) {
  const lease = active(owner, generation);
  const issued = begin(owner, lease);
  assert.equal(owner.settle(issued.ticket, payload("synthetic-preview", generation)), true);
  const snapshot = owner.getSnapshot(); assert.ok(snapshot);
  assert.equal(snapshot.phase, "ready");
  return { ...issued, snapshot };
}
function deepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) deepFrozen(child);
}
function hostile(counter: { reads: number }): object {
  return new Proxy({}, {
    getPrototypeOf() { counter.reads++; throw Error("SYNTHETIC_PRIVATE_DETAIL"); },
    ownKeys() { counter.reads++; throw Error("SYNTHETIC_PRIVATE_DETAIL"); },
    get() { counter.reads++; throw Error("SYNTHETIC_PRIVATE_DETAIL"); },
  });
}

test("construction and cached snapshot reads are inert; activation creates an opaque frozen lifetime", () => {
  const f = fixture();
  assert.equal(f.owner.getSnapshot(), null); assert.equal(f.owner.getSnapshot(), null);
  assert.equal(f.reads(), 0);
  const lease = active(f.owner), snapshot = f.owner.getSnapshot(); assert.ok(snapshot);
  assert.deepEqual(Object.keys(lease), []);
  assert.equal(snapshot.lease, lease); assert.equal(snapshot.dataGeneration, 1);
  assert.equal(snapshot.phase, "idle"); assert.equal(snapshot.preview, null);
  const reads = f.reads();
  assert.equal(f.owner.getSnapshot(), snapshot); assert.equal(f.owner.getSnapshot(), snapshot);
  assert.equal(f.reads(), reads); deepFrozen(snapshot);
});

test("one current request publishes only a detached frozen browser DTO and is consumed once", () => {
  const f = fixture(), issued = begin(f.owner);
  const loading = f.owner.getSnapshot(); assert.ok(loading);
  assert.equal(loading.phase, "loading"); assert.equal(loading.preview, null);
  assert.deepEqual(Object.keys(issued.ticket), []); assert.ok(Object.isFrozen(issued.ticket));
  const value = payload();
  assert.equal(f.owner.settle(issued.ticket, value), true);
  const shown = f.owner.getSnapshot(); assert.ok(shown?.preview);
  assert.deepEqual(shown.preview, value); deepFrozen(shown);
  assert.notEqual(shown.preview, value);
  value.content.serviceName = "Changed synthetic label";
  value.content.reviewReasons.length = 0;
  assert.equal(shown.preview.content.serviceName, "합성 서비스");
  assert.equal(shown.preview.content.reviewReasons.length, 5);
  assert.equal(f.owner.settle(issued.ticket, payload("synthetic-duplicate")), false);
  assert.equal(f.owner.fail(issued.ticket), false);
  assert.equal(f.owner.getSnapshot(), shown);
});

test("new requests hide the previous ready payload immediately and stale render callbacks cannot restart it", () => {
  const f = fixture(), first = ready(f.owner);
  const next = f.owner.begin(first.lease, first.snapshot); assert.ok(next);
  const loading = f.owner.getSnapshot(); assert.ok(loading);
  assert.equal(loading.preview, null); assert.equal(loading.phase, "loading");
  assert.equal(f.owner.begin(first.lease, first.snapshot), null);
  assert.equal(f.owner.cancel(first.lease, first.snapshot), false);
  assert.equal(f.owner.checkExpiry(first.lease, first.snapshot), false);
  assert.equal(f.owner.getSnapshot(), loading);
});

test("P2 replaces pending P1 and late P1 success or failure does not inspect payload or clocks", () => {
  const f = fixture(), first = begin(f.owner);
  const second = f.owner.begin(first.lease, f.owner.getSnapshot()!); assert.ok(second);
  assert.equal(f.owner.settle(second, payload("synthetic-second")), true);
  const current = f.owner.getSnapshot(), calls = f.reads(), counter = { reads: 0 };
  f.clock(() => { throw Error("stale callback must not read clock"); });
  assert.equal(f.owner.settle(first.ticket, hostile(counter)), false);
  assert.equal(f.owner.fail(first.ticket), false);
  assert.equal(f.owner.cancel(first.lease, first.ticket), false);
  assert.equal(counter.reads, 0); assert.equal(f.reads(), calls);
  assert.equal(f.owner.getSnapshot(), current);
});

test("A to B to fresh A always changes leases and old commands cannot be rebound by equal generations", () => {
  const f = fixture(), a = begin(f.owner);
  const b = active(f.owner), bRequest = begin(f.owner, b);
  const freshA = active(f.owner);
  assert.notEqual(a.lease, b); assert.notEqual(freshA, a.lease); assert.notEqual(freshA, b);
  const current = f.owner.getSnapshot(), calls = f.reads(), counter = { reads: 0 };
  assert.equal(f.owner.begin(a.lease, current!), null);
  assert.equal(f.owner.settle(a.ticket, hostile(counter)), false);
  assert.equal(f.owner.fail(bRequest.ticket), false);
  assert.equal(f.owner.cancel(a.lease, a.ticket), false);
  f.owner.deactivate(a.lease); f.owner.deactivate(b);
  assert.equal(f.owner.getSnapshot(), current); assert.equal(f.reads(), calls); assert.equal(counter.reads, 0);
});

test("forged and foreign leases, tickets and snapshots do not touch current state or clocks", () => {
  const f = fixture(), issued = begin(f.owner), other = fixture(), foreign = begin(other.owner);
  const current = f.owner.getSnapshot(); assert.ok(current);
  const calls = f.reads(), counter = { reads: 0 };
  assert.equal(f.owner.begin(foreign.lease, current), null);
  assert.equal(f.owner.begin(issued.lease, { ...current }), null);
  assert.equal(f.owner.settle(foreign.ticket, hostile(counter)), false);
  assert.equal(f.owner.settle(Object.freeze({}), hostile(counter)), false);
  assert.equal(f.owner.fail(null), false);
  assert.equal(f.owner.cancel(foreign.lease, issued.ticket), false);
  assert.equal(f.owner.checkExpiry(issued.lease, { ...current }), false);
  f.owner.deactivate(foreign.lease);
  assert.equal(f.owner.getSnapshot(), current); assert.equal(f.reads(), calls); assert.equal(counter.reads, 0);
});

for (const invalid of [null, undefined, 0, -1, 1.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid activation clears previous values and revokes a pending request: ${String(invalid)}`, () => {
    const f = fixture(), previous = ready(f.owner);
    const ticket = f.owner.begin(previous.lease, previous.snapshot); assert.ok(ticket);
    assert.equal(f.owner.activate(invalid), null);
    assert.equal(f.owner.getSnapshot(), null);
    assert.equal(f.owner.settle(ticket, payload()), false);
    assert.equal(f.owner.begin(previous.lease, previous.snapshot), null);
  });
}

test("explicit cancellation accepts current ticket or ready snapshot and never revives old callbacks", () => {
  const f = fixture(), pending = begin(f.owner);
  assert.equal(f.owner.cancel(pending.lease, pending.ticket), true);
  assert.equal(f.owner.getSnapshot()?.preview, null);
  assert.notEqual(f.owner.getSnapshot()?.phase, "loading");
  assert.equal(f.owner.settle(pending.ticket, payload()), false);
  assert.equal(f.owner.fail(pending.ticket), false);
  const second = f.owner.begin(pending.lease, f.owner.getSnapshot()!); assert.ok(second);
  assert.equal(f.owner.settle(second, payload()), true);
  const shown = f.owner.getSnapshot(); assert.ok(shown);
  assert.equal(f.owner.cancel(pending.lease, shown), true);
  assert.equal(f.owner.getSnapshot()?.preview, null);
  assert.equal(f.owner.cancel(pending.lease, shown), false);
});

test("current failure clears pending content and is once-only without exposing exception details", () => {
  const f = fixture(), issued = begin(f.owner);
  assert.equal(f.owner.fail(issued.ticket), true);
  const failed = f.owner.getSnapshot(); assert.ok(failed);
  assert.equal(failed.preview, null); assert.notEqual(failed.phase, "loading");
  assert.equal(f.owner.fail(issued.ticket), false);
  assert.equal(f.owner.settle(issued.ticket, payload()), false);
  assert.equal(f.owner.getSnapshot(), failed);
});

for (const alteration of ["generation", "schema", "revision", "private-field", "accessor"] as const) {
  test(`malformed current response clears into invalid without accepting private data: ${alteration}`, () => {
    const f = fixture(), issued = begin(f.owner), input = payload();
    let calls = 0;
    if (alteration === "generation") input.dataGeneration = 2;
    if (alteration === "schema") Object.assign(input, { schema: "unknown" });
    if (alteration === "revision") input.previewRevision = 2;
    if (alteration === "private-field") Object.assign(input.content, { ownerId: "synthetic-private-owner" });
    if (alteration === "accessor") Object.defineProperty(input, "content", { enumerable: true, get() { calls++; return {}; } });
    assert.equal(f.owner.settle(issued.ticket, input), false);
    assert.equal(f.owner.getSnapshot()?.phase, "invalid");
    assert.equal(f.owner.getSnapshot()?.preview, null); assert.equal(calls, 0);
    assert.equal(f.owner.settle(issued.ticket, payload()), false);
  });
}

test("response already at its wall-clock deadline is expired and never publishes its values", () => {
  const f = fixture(), issued = begin(f.owner);
  assert.equal(f.owner.settle(issued.ticket, payload("synthetic-at-deadline", 1, WALL)), false);
  assert.equal(f.owner.getSnapshot()?.phase, "expired"); assert.equal(f.owner.getSnapshot()?.preview, null);
});

test("fractional monotonic time is valid and exact wall-clock expiry clears a ready preview", () => {
  const f = fixture(), shown = ready(f.owner);
  f.time(WALL + 999, MONO + 999.75);
  assert.equal(f.owner.checkExpiry(shown.lease, shown.snapshot), true);
  const current = f.owner.getSnapshot(); assert.ok(current?.preview);
  f.time(WALL + 1000, MONO + 999.875);
  assert.equal(f.owner.checkExpiry(shown.lease, current), false);
  assert.equal(f.owner.getSnapshot()?.phase, "expired"); assert.equal(f.owner.getSnapshot()?.preview, null);
});

test("monotonic deadline independently expires a preview even when wall time stalls", () => {
  const f = fixture(), shown = ready(f.owner);
  f.time(WALL, MONO + 999.875);
  assert.equal(f.owner.checkExpiry(shown.lease, shown.snapshot), true);
  const current = f.owner.getSnapshot(); assert.ok(current);
  f.time(WALL, MONO + 1000);
  assert.equal(f.owner.checkExpiry(shown.lease, current), false);
  assert.equal(f.owner.getSnapshot()?.phase, "expired"); assert.equal(f.owner.getSnapshot()?.preview, null);
});

test("repeated unexpired checks never extend the monotonic deadline", () => {
  const f = fixture(), shown = ready(f.owner);
  f.time(WALL + 100, MONO + 700);
  assert.equal(f.owner.checkExpiry(shown.lease, shown.snapshot), true);
  const current = f.owner.getSnapshot(); assert.ok(current);
  f.time(WALL + 101, MONO + 1000);
  assert.equal(f.owner.checkExpiry(shown.lease, current), false);
  assert.equal(f.owner.getSnapshot()?.phase, "expired");
});

test("old expiry snapshots cannot expire a replacement preview or read poisoned clocks", () => {
  const f = fixture(), previous = ready(f.owner);
  const next = f.owner.begin(previous.lease, previous.snapshot); assert.ok(next);
  assert.equal(f.owner.settle(next, payload("synthetic-replacement", 1, WALL + 2000)), true);
  const shown = f.owner.getSnapshot(), calls = f.reads();
  f.clock(() => { throw Error("old expiry cannot read clocks"); });
  assert.equal(f.owner.checkExpiry(previous.lease, previous.snapshot), false);
  assert.equal(f.owner.getSnapshot(), shown); assert.equal(f.reads(), calls);
});

for (const [label, wall, monotonic] of [["wall", WALL - 1, MONO + 1], ["monotonic", WALL + 1, MONO - 0.25]] as const) {
  test(`backward ${label} clock deactivates rather than retaining values`, () => {
    const f = fixture(), shown = ready(f.owner);
    f.time(wall, monotonic);
    assert.equal(f.owner.checkExpiry(shown.lease, shown.snapshot), false);
    assert.equal(f.owner.getSnapshot(), null);
    assert.equal(f.owner.begin(shown.lease, shown.snapshot), null);
  });
}

for (const [label, clock] of [
  ["null", null], ["array", []], ["missing", { wall: WALL }],
  ["wall NaN", { wall: NaN, monotonic: MONO }], ["wall fractional", { wall: WALL + 0.5, monotonic: MONO }],
  ["wall string", { wall: String(WALL), monotonic: MONO }], ["monotonic NaN", { wall: WALL, monotonic: NaN }],
  ["monotonic infinity", { wall: WALL, monotonic: Infinity }], ["monotonic negative", { wall: WALL, monotonic: -1 }],
  ["wall negative zero", { wall: -0, monotonic: MONO }], ["wall beyond range", { wall: 253402300800000, monotonic: MONO }],
  ["monotonic negative zero", { wall: WALL, monotonic: -0 }],
  ["monotonic beyond range", { wall: WALL, monotonic: Number.MAX_SAFE_INTEGER + 1 }],
  ["extra field", { wall: WALL, monotonic: MONO, private: "synthetic" }],
] as const) {
  test(`invalid clock ${label} deactivates a ready lifetime`, () => {
    const f = fixture(), shown = ready(f.owner);
    f.clock(() => clock);
    assert.equal(f.owner.checkExpiry(shown.lease, shown.snapshot), false);
    assert.equal(f.owner.getSnapshot(), null);
  });
}

test("ordinary clock accessors are not invoked and a thrown clock error is not exposed", () => {
  for (const mode of ["getter", "throw"] as const) {
    const f = fixture(), shown = ready(f.owner); let calls = 0;
    f.clock(() => {
      if (mode === "throw") throw Error("SYNTHETIC_PRIVATE_DETAIL");
      return { get wall() { calls++; return WALL; }, monotonic: MONO };
    });
    assert.equal(f.owner.checkExpiry(shown.lease, shown.snapshot), false);
    assert.equal(f.owner.getSnapshot(), null); assert.equal(calls, 0);
  }
});

test("deactivation and permanent disposal clear state and revoke pending work", () => {
  const f = fixture(), pending = begin(f.owner);
  f.owner.deactivate(pending.lease);
  assert.equal(f.owner.getSnapshot(), null);
  assert.equal(f.owner.settle(pending.ticket, payload()), false);
  const next = begin(f.owner);
  f.owner.dispose(); f.owner.dispose();
  assert.equal(f.owner.getSnapshot(), null); assert.equal(f.owner.activate(1), null);
  assert.equal(f.owner.begin(next.lease, next.before), null);
  assert.equal(f.owner.fail(next.ticket), false);
  assert.equal(f.owner.settle(next.ticket, payload()), false);
});

test("subscribers see cached cleared state, exceptions do not block peers, and unsubscribe is idempotent", () => {
  const f = fixture(); let first = 0, second = 0;
  f.owner.subscribe(() => { first++; throw Error("SYNTHETIC_OBSERVER_DETAIL"); });
  const stop = f.owner.subscribe(() => { second++; });
  assert.equal(first, 0); assert.equal(second, 0);
  const lease = active(f.owner);
  assert.equal(first, 1); assert.equal(second, 1);
  stop(); stop(); f.owner.deactivate(lease);
  assert.equal(first, 2); assert.equal(second, 1); assert.equal(f.owner.getSnapshot(), null);
});

test("observer deactivation during ready publication defeats both publication and the true return", () => {
  const f = fixture(), pending = begin(f.owner);
  f.owner.subscribe(() => {
    const current = f.owner.getSnapshot();
    if (current?.phase === "ready") f.owner.deactivate(current.lease);
  });
  assert.equal(f.owner.settle(pending.ticket, payload()), false);
  assert.equal(f.owner.getSnapshot(), null);
});

test("observer deactivation during activation wins and cannot be undone by outer activation", () => {
  const f = fixture();
  f.owner.subscribe(() => {
    const snapshot = f.owner.getSnapshot(); if (snapshot !== null) f.owner.deactivate(snapshot.lease);
  });
  assert.equal(f.owner.activate(1), null); assert.equal(f.owner.getSnapshot(), null);
});

test("observer disposal during loading invalidates begin and all future activation", () => {
  const f = fixture(), lease = active(f.owner), before = f.owner.getSnapshot(); assert.ok(before);
  f.owner.subscribe(() => { if (f.owner.getSnapshot()?.phase === "loading") f.owner.dispose(); });
  assert.equal(f.owner.begin(lease, before), null);
  assert.equal(f.owner.getSnapshot(), null); assert.equal(f.owner.activate(1), null);
});

test("observers cannot reenter ordinary mutations during a publication", () => {
  const f = fixture(), lease = active(f.owner); let invocations = 0;
  const observed: unknown[][] = [];
  f.owner.subscribe(() => {
    const snapshot = f.owner.getSnapshot();
    if (snapshot?.phase !== "loading") return;
    invocations++;
    // Assertions belong outside callbacks: observer exceptions are intentionally
    // swallowed by the owner and would otherwise produce a vacuous PASS.
    observed.push([f.owner.activate(2), f.owner.begin(lease, snapshot),
      f.owner.cancel(lease, snapshot), f.owner.checkExpiry(lease, snapshot)]);
  });
  const pending = f.owner.begin(lease, f.owner.getSnapshot()!); assert.ok(pending);
  assert.equal(invocations, 1); assert.equal(f.owner.getSnapshot()?.phase, "loading");
  assert.deepEqual(observed, [[null, null, false, false]]);
});

test("clock callback deactivation wins over an outer begin", () => {
  const f = fixture(), lease = active(f.owner), before = f.owner.getSnapshot(); assert.ok(before);
  f.clock(() => { f.owner.deactivate(lease); return { wall: WALL, monotonic: MONO }; });
  assert.equal(f.owner.begin(lease, before), null); assert.equal(f.owner.getSnapshot(), null);
});

test("clock reflection may revoke the lease but cannot republish a decoded response", () => {
  const f = fixture(), pending = begin(f.owner);
  f.clock(() => new Proxy({ wall: WALL, monotonic: MONO }, {
    getPrototypeOf(target) { f.owner.deactivate(pending.lease); return Reflect.getPrototypeOf(target); },
  }));
  assert.equal(f.owner.settle(pending.ticket, payload()), false); assert.equal(f.owner.getSnapshot(), null);
});

test("DTO reflection deactivation cannot be reversed by a valid outer decode", () => {
  const f = fixture(), pending = begin(f.owner);
  const input = new Proxy(payload(), {
    getPrototypeOf(target) { f.owner.deactivate(pending.lease); return Reflect.getPrototypeOf(target); },
  });
  assert.equal(f.owner.settle(pending.ticket, input), false); assert.equal(f.owner.getSnapshot(), null);
});

test("DTO reflection disposal permanently wins and later completions stay ignored", () => {
  const f = fixture(), pending = begin(f.owner);
  const input = new Proxy(payload(), {
    ownKeys(target) { f.owner.dispose(); return Reflect.ownKeys(target); },
  });
  assert.equal(f.owner.settle(pending.ticket, input), false);
  assert.equal(f.owner.getSnapshot(), null); assert.equal(f.owner.activate(1), null);
  assert.equal(f.owner.fail(pending.ticket), false);
});

test("clock records may be frozen null-prototype data but may not inherit missing fields", () => {
  const f = fixture();
  f.clock(() => Object.freeze(Object.assign(Object.create(null) as object, { wall: WALL, monotonic: MONO })));
  const shown = ready(f.owner);
  assert.equal(f.owner.checkExpiry(shown.lease, shown.snapshot), true);
  f.clock(() => Object.create({ wall: WALL, monotonic: MONO }) as unknown);
  assert.equal(f.owner.checkExpiry(shown.lease, shown.snapshot), false);
  assert.equal(f.owner.getSnapshot(), null);
});

test("monotonic deadline overflow fails closed without exposing a decoded preview", () => {
  const f = fixture(); f.time(WALL, Number.MAX_SAFE_INTEGER - 1);
  const pending = begin(f.owner);
  assert.equal(f.owner.settle(pending.ticket, payload()), false);
  assert.equal(f.owner.getSnapshot()?.phase, "invalid");
  assert.equal(f.owner.getSnapshot()?.preview, null);
});

test("cached snapshot does not sample clocks or silently schedule expiry", () => {
  const f = fixture(), shown = ready(f.owner), calls = f.reads();
  f.time(WALL + 2000, MONO + 2000);
  assert.equal(f.owner.getSnapshot(), shown.snapshot);
  assert.equal(f.owner.getSnapshot()?.phase, "ready"); assert.equal(f.reads(), calls);
  assert.equal(f.owner.checkExpiry(shown.lease, shown.snapshot), false);
  assert.equal(f.owner.getSnapshot()?.preview, null);
});

test("clock-triggered disposal during initial activation never returns a usable lease", () => {
  const f = fixture();
  f.clock(() => { f.owner.dispose(); return { wall: WALL, monotonic: MONO }; });
  assert.equal(f.owner.activate(1), null); assert.equal(f.owner.getSnapshot(), null);
  assert.equal(f.owner.activate(1), null);
});
