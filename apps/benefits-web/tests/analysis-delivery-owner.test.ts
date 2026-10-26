import assert from "node:assert/strict";
import { test } from "node:test";
import { CANDIDATE_BATCH_SAVED_SCHEMA, createAnalysisDeliveryOwner, decodeCandidateBatchSavedReceipt,
  type AnalysisDeliverySnapshot } from "../src/domain/analysis-delivery/index.ts";

const receipt = (patch: Record<string, unknown> = {}) => ({ schema: CANDIDATE_BATCH_SAVED_SCHEMA, state: "saved",
  batchReference: "synthetic-public-reference", dataGeneration: 1, ...patch });
const binding = (lease: object = {}, patch: Record<string, unknown> = {}) => ({ lease,
  context: { bindingId: "synthetic-view-A", dataGeneration: 1, ...patch } });
function setup() {
  const owner = createAnalysisDeliveryOwner(), external = binding();
  const initial = owner.activate(external); assert.ok(initial);
  return { owner, external, initial };
}
function snapshot(owner: ReturnType<typeof createAnalysisDeliveryOwner>): AnalysisDeliverySnapshot {
  const current = owner.getSnapshot(); assert.ok(current); return current;
}
function saved(f = setup()) {
  const ticket = f.owner.begin(f.initial); assert.ok(ticket); assert.equal(f.owner.deliver(ticket, receipt()), true);
  return { ...f, ticket, shown: snapshot(f.owner) };
}

test("construction/activation/delivery/selection do no ambient IO, clocks, UUID or scheduling", () => {
  const oldFetch = globalThis.fetch, oldNow = Date.now, oldTimeout = globalThis.setTimeout;
  const oldCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto"); let calls = 0;
  const forbidden = () => { calls++; throw new Error("SYNTHETIC_PORT_MUST_NOT_RUN"); };
  try {
    globalThis.fetch = forbidden; Date.now = forbidden; globalThis.setTimeout = forbidden as unknown as typeof setTimeout;
    Object.defineProperty(globalThis, "crypto", { configurable: true, get: forbidden });
    const f = saved(); assert.equal(f.owner.select(f.shown), true); assert.ok(Object.isFrozen(f.owner));
    assert.equal(snapshot(f.owner).selectedReference, receipt().batchReference); assert.equal(calls, 0);
  } finally {
    globalThis.fetch = oldFetch; Date.now = oldNow; globalThis.setTimeout = oldTimeout;
    if (oldCrypto) Object.defineProperty(globalThis, "crypto", oldCrypto); else Reflect.deleteProperty(globalThis, "crypto");
  }
});
test("receipt decoding accepts detached plain/null-prototype/frozen data", () => {
  for (const input of [receipt(), Object.assign(Object.create(null), receipt()), Object.freeze(receipt())]) {
    const parsed = decodeCandidateBatchSavedReceipt(input); assert.deepEqual(parsed, receipt());
    assert.notEqual(parsed, input); assert.ok(Object.isFrozen(parsed));
  }
  const input = receipt(), parsed = decodeCandidateBatchSavedReceipt(input)!;
  input.batchReference = "synthetic-later-reference"; assert.equal(parsed.batchReference, "synthetic-public-reference");
});
for (const [name, value] of Object.entries({ null: null, array: [], missing: {}, rawAnalysisReceipt: {
  schema: "keyatlas.mail-analysis-receipt.v1", authorityAtStart: { operationId: "synthetic-private-operation" },
  quota: "consumed", mailbox: "returned", analysis: "returned", undoAvailable: false },
  safeServerWrapper: { ok: true, value: receipt(), receipt: { storage: "acknowledged" } },
  extraPrivate: receipt({ analysisOperationId: "synthetic-private-operation" }),
  wrongSchema: receipt({ schema: "other" }), failed: receipt({ state: "unknown" }),
  zero: receipt({ dataGeneration: 0 }), negativeZero: receipt({ dataGeneration: -0 }),
  fractional: receipt({ dataGeneration: 1.5 }), overflow: receipt({ dataGeneration: Number.MAX_SAFE_INTEGER + 1 }),
  stringGeneration: receipt({ dataGeneration: "1" }), empty: receipt({ batchReference: "" }),
  whitespace: receipt({ batchReference: " synthetic-ref" }), newline: receipt({ batchReference: "synthetic-ref\n" }),
  unicode: receipt({ batchReference: "한글" }), tooLong: receipt({ batchReference: "x".repeat(129) }),
  class: new (class { schema = CANDIDATE_BATCH_SAVED_SCHEMA; state = "saved"; batchReference = "ref"; dataGeneration = 1; })(),
  inherited: Object.create(receipt()), symbol: { ...receipt(), [Symbol("private")]: "synthetic-value" },
  hidden: Object.defineProperty(receipt(), "private", { value: true }),
})) test(`receipt decoder rejects ${name}`, () => assert.equal(decodeCandidateBatchSavedReceipt(value), null));

test("own accessor/setter and serialization hook are rejected without running callbacks", () => {
  let calls = 0;
  for (const value of [{ ...receipt(), get batchReference() { calls++; return "ref"; } },
    Object.defineProperty(receipt(), "state", { enumerable: true, set() { calls++; } }),
    { ...receipt(), toJSON() { calls++; return receipt(); } }]) assert.equal(decodeCandidateBatchSavedReceipt(value), null);
  assert.equal(calls, 0);
});
test("Proxy reflection exceptions/revocation are contained, not claimed to be sandboxed", () => {
  const revoked = Proxy.revocable(receipt(), {}); revoked.revoke();
  for (const value of [revoked.proxy, new Proxy(receipt(), { getPrototypeOf() { throw new Error(); } }),
    new Proxy(receipt(), { ownKeys() { throw new Error(); } }), new Proxy(receipt(), { getOwnPropertyDescriptor() { throw new Error(); } })])
    assert.equal(decodeCandidateBatchSavedReceipt(value), null);
});
test("maximum valid reference/generation preserve exact values", () => {
  const input = receipt({ batchReference: "x".repeat(128), dataGeneration: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(decodeCandidateBatchSavedReceipt(input), input);
});
test("saved receipt alone never selects, and each cached frozen snapshot is exact", () => {
  const f = setup(); assert.equal(f.owner.getSnapshot(), f.initial);
  assert.equal(f.initial.phase, "idle"); assert.equal(f.initial.receipt, null); assert.equal(f.initial.selectedReference, null);
  const ticket = f.owner.begin(f.initial)!; assert.ok(Object.isFrozen(ticket));
  const loading = snapshot(f.owner); assert.equal(loading.phase, "receiving"); assert.equal(loading.selectedReference, null);
  assert.equal(f.owner.deliver(ticket, receipt()), true);
  const delivered = snapshot(f.owner); assert.equal(delivered.phase, "saved"); assert.equal(delivered.selectedReference, null);
  assert.equal(f.owner.select({ ...delivered }), false); assert.equal(f.owner.select(delivered), true);
  const selected = snapshot(f.owner); assert.equal(selected.phase, "selected");
  assert.ok(Object.isFrozen(selected) && Object.isFrozen(selected.context) && Object.isFrozen(selected.receipt));
  assert.equal(f.owner.select(selected), false); assert.equal(f.owner.getSnapshot(), selected);
});
test("binding context detaches without freezing or modifying the external workspace identity", () => {
  const f = setup(); f.external.context.bindingId = "synthetic-mutated"; f.external.context.dataGeneration = 2;
  assert.deepEqual(f.initial.context, { bindingId: "synthetic-view-A", dataGeneration: 1 });
  assert.equal(f.initial.lease, f.external.lease); assert.equal(Object.isFrozen(f.external.lease), false);
  Object.assign(f.external.lease, { syntheticOwnerMarker: true });
  const ticket = f.owner.begin(f.initial)!; assert.equal(f.owner.deliver(ticket, receipt()), true);
});
test("invalid activation clears old selected data and pending ownership without reading ordinary accessors", () => {
  let calls = 0;
  for (const input of [null, {}, binding([], {}), binding({}, { dataGeneration: 0 }), binding({}, { bindingId: "ref\n" }),
    { ...binding(), extra: true }, { ...binding(), get context() { calls++; return binding().context; } },
    { ...binding(), context: { ...binding().context, get bindingId() { calls++; return "ref"; } } }]) {
    const f = saved(); assert.equal(f.owner.select(f.shown), true); assert.equal(f.owner.activate(input), null);
    assert.equal(f.owner.getSnapshot(), null); assert.equal(f.owner.deliver(f.ticket, receipt()), false);
  }
  assert.equal(calls, 0);
});
test("wrong generation/malformed completion consumes the ticket and leaves unconfirmed, not saved", () => {
  for (const value of [null, receipt({ dataGeneration: 2 }), { ...receipt(), privateField: true }]) {
    const f = setup(), ticket = f.owner.begin(f.initial)!;
    assert.equal(f.owner.deliver(ticket, value), false); const current = snapshot(f.owner);
    assert.equal(current.phase, "unconfirmed"); assert.equal(current.receipt, null); assert.equal(current.selectedReference, null);
    assert.equal(f.owner.deliver(ticket, receipt()), false); assert.equal(f.owner.select(current), false);
  }
});
test("reticket replaces the pending slot and rejects stale data before touching its Proxy", () => {
  const f = setup(), old = f.owner.begin(f.initial)!, latest = f.owner.begin(snapshot(f.owner))!; let reads = 0;
  const payload = new Proxy(receipt(), { getPrototypeOf(target) { reads++; return Reflect.getPrototypeOf(target); } });
  assert.notEqual(old, latest); assert.equal(f.owner.deliver(old, payload), false); assert.equal(reads, 0);
  assert.equal(f.owner.deliver(latest, receipt()), true); assert.equal(f.owner.deliver(latest, payload), false); assert.equal(reads, 0);
});
test("copied, forged and foreign tickets never complete a pending read", () => {
  const first = setup(), second = setup(), ticket = first.owner.begin(first.initial)!, other = second.owner.begin(second.initial)!;
  for (const value of [{}, { ...ticket }, structuredClone(ticket), other, null]) assert.equal(first.owner.deliver(value, receipt()), false);
  assert.equal(snapshot(first.owner).phase, "receiving"); assert.equal(first.owner.deliver(ticket, receipt()), true);
});
test("equal context and even equal external lease activation creates a fresh ABA frame", () => {
  const f = setup(), ticket = f.owner.begin(f.initial)!;
  f.owner.activate(binding({}, { bindingId: "synthetic-view-B" }));
  const fresh = f.owner.activate(f.external)!; assert.notEqual(fresh, f.initial);
  assert.equal(f.owner.deliver(ticket, receipt()), false); assert.equal(f.owner.begin(f.initial), null);
  assert.equal(f.owner.select(f.initial), false); assert.equal(f.owner.cancel(f.initial), false);
  const next = f.owner.begin(fresh)!; assert.equal(f.owner.deliver(next, receipt()), true);
});
test("cancel by current snapshot or ticket clears data; old cancel cannot affect a replacement", () => {
  for (const byTicket of [true, false]) {
    const f = setup(), ticket = f.owner.begin(f.initial)!, pending = snapshot(f.owner);
    assert.equal(f.owner.cancel(byTicket ? ticket : pending), true); const idle = snapshot(f.owner);
    assert.equal(idle.phase, "idle"); assert.equal(idle.receipt, null); assert.equal(idle.selectedReference, null);
    assert.equal(f.owner.deliver(ticket, receipt()), false); assert.equal(f.owner.cancel(idle), false);
    const next = f.owner.begin(idle)!; assert.equal(f.owner.cancel(ticket), false); assert.equal(f.owner.deliver(next, receipt()), true);
  }
  const f = saved(); assert.equal(f.owner.select(f.shown), true); assert.equal(f.owner.cancel(snapshot(f.owner)), true);
  assert.equal(snapshot(f.owner).selectedReference, null);
});
test("explicit local expiration clears pending or selected data but has no server TTL claim", () => {
  for (const selection of [true, false]) {
    const f = setup(), ticket = f.owner.begin(f.initial)!;
    if (selection) { f.owner.deliver(ticket, receipt()); f.owner.select(snapshot(f.owner)); }
    const before = snapshot(f.owner); assert.equal(f.owner.expire(before), true);
    const expired = snapshot(f.owner); assert.equal(expired.phase, "expired"); assert.equal(expired.receipt, null);
    assert.equal(expired.selectedReference, null); assert.equal(f.owner.expire(expired), false);
    assert.equal(f.owner.deliver(ticket, receipt()), false); assert.equal(f.owner.begin(before), null);
    assert.ok(f.owner.begin(expired)); // Only a new explicit action can request another observation.
  }
});
test("restarting delivery from selected clears only local selection, without mutating external lease", () => {
  let commandsReleased = 0; const lease = { release() { commandsReleased++; } }, f = setup();
  const active = f.owner.activate(binding(lease))!; const ticket = f.owner.begin(active)!;
  f.owner.deliver(ticket, receipt()); f.owner.select(snapshot(f.owner));
  f.owner.begin(snapshot(f.owner)); assert.equal(snapshot(f.owner).selectedReference, null); assert.equal(commandsReleased, 0);
  f.owner.cancel(snapshot(f.owner)); f.owner.deactivate(lease); assert.equal(commandsReleased, 0);
});
test("deactivate ignores foreign/old leases and permanently disposal blocks further operations", () => {
  const f = saved(); f.owner.deactivate({}); assert.equal(f.owner.getSnapshot(), f.shown);
  const newer = binding(), current = f.owner.activate(newer)!;
  f.owner.deactivate(f.external.lease); assert.equal(f.owner.getSnapshot(), current);
  f.owner.dispose(); f.owner.dispose(); assert.equal(f.owner.getSnapshot(), null);
  assert.equal(f.owner.activate(newer), null); assert.equal(f.owner.begin(current), null);
  assert.equal(f.owner.deliver(f.ticket, receipt()), false); assert.equal(f.owner.cancel(current), false);
  assert.equal(f.owner.expire(current), false); assert.equal(f.owner.select(current), false);
  let notifications = 0; f.owner.subscribe(() => notifications++); assert.equal(notifications, 0);
});
test("undefined/null/primitive deactivation is harmless before activation and during an active selection", () => {
  const owner = createAnalysisDeliveryOwner();
  for (const lease of [undefined, null, 1, "synthetic-forged", false]) owner.deactivate(lease);
  assert.equal(owner.getSnapshot(), null);
  const f = saved(); f.owner.select(f.shown); const selected = snapshot(f.owner);
  for (const lease of [undefined, null, 1, "synthetic-forged", false]) f.owner.deactivate(lease);
  assert.equal(f.owner.getSnapshot(), selected);
});
test("notification reentry cannot begin/deliver/select/activate; explicit revocation still wins", () => {
  const f = setup(), results: unknown[] = [];
  const detach = f.owner.subscribe(() => {
    const current = f.owner.getSnapshot(); if (!current) return;
    results.push(f.owner.begin(current), f.owner.deliver({}, receipt()), f.owner.select(current),
      f.owner.activate(binding()), f.owner.cancel(current), f.owner.expire(current));
  });
  const ticket = f.owner.begin(f.initial)!; assert.equal(f.owner.deliver(ticket, receipt()), true); detach();
  assert.deepEqual(results, [null, false, false, null, false, false, null, false, false, null, false, false]);
  f.owner.subscribe(() => { if (f.owner.getSnapshot()?.phase === "receiving") f.owner.deactivate(f.external.lease); });
  assert.equal(f.owner.begin(snapshot(f.owner)), null); assert.equal(f.owner.getSnapshot(), null);
});
test("old lifecycle revocation during replacement's null notification cancels the outer activation", () => {
  for (const dispose of [true, false]) {
    const f = saved(); f.owner.subscribe(() => {
      if (f.owner.getSnapshot() === null) {
        if (dispose) f.owner.dispose(); else f.owner.deactivate(f.external.lease);
      }
    });
    assert.equal(f.owner.activate(binding()), null); assert.equal(f.owner.getSnapshot(), null);
  }
});
test("Proxy-triggered revocation during receipt decode cannot publish into the revoked owner", () => {
  const f = setup(), ticket = f.owner.begin(f.initial)!;
  const payload = new Proxy(receipt(), { ownKeys(target) { f.owner.deactivate(f.external.lease); return Reflect.ownKeys(target); } });
  assert.equal(f.owner.deliver(ticket, payload), false); assert.equal(f.owner.getSnapshot(), null);
});
test("observer errors and removing other observers do not interrupt state cleanup", () => {
  const f = setup(); let observed = 0, removed = 0;
  f.owner.subscribe(() => { throw new Error("SYNTHETIC_OBSERVER_ERROR"); });
  let detach = () => {}; f.owner.subscribe(() => { observed++; detach(); });
  detach = f.owner.subscribe(() => { removed++; });
  assert.ok(f.owner.begin(f.initial)); f.owner.deactivate(f.external.lease);
  assert.equal(f.owner.getSnapshot(), null); assert.equal(observed, 2); assert.equal(removed, 0);
});
