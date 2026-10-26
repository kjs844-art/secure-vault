import assert from "node:assert/strict";
import { test } from "node:test";
import { createExpectedAbortArm } from "../scripts/support/expected-abort-arm.ts";

test("same page object and exact captured stage claim once", () => {
  const page = {};
  const arm = createExpectedAbortArm(page, "synthetic-pending-completion");
  assert.equal(arm.pending, true);
  assert.equal(arm.claim(page, "synthetic-pending-completion"), true);
  assert.equal(arm.pending, false);
  assert.equal(arm.claim(page, "synthetic-pending-completion"), false);
  assert.equal(arm.pending, false);
});

test("a different page with identical fields consumes the arm without matching", () => {
  const page = { synthetic: true };
  const arm = createExpectedAbortArm(page, "synthetic-stage");
  assert.equal(arm.claim({ synthetic: true }, "synthetic-stage"), false);
  assert.equal(arm.pending, false);
  assert.equal(arm.claim(page, "synthetic-stage"), false);
});

test("a null observed page consumes the arm and cannot later match", () => {
  const page = {};
  const arm = createExpectedAbortArm(page, "synthetic-stage");
  assert.equal(arm.claim(null, "synthetic-stage"), false);
  assert.equal(arm.pending, false);
  assert.equal(arm.claim(page, "synthetic-stage"), false);
});

test("wrong, differently cased or padded stages fail closed without normalization", () => {
  const page = {};
  for (const observedStage of ["", "different-stage", "Synthetic-stage", " synthetic-stage", "synthetic-stage "]) {
    const arm = createExpectedAbortArm(page, "synthetic-stage");
    assert.equal(arm.claim(page, observedStage), false);
    assert.equal(arm.pending, false);
    assert.equal(arm.claim(page, "synthetic-stage"), false);
  }
});

test("pending reads do not consume and stage capture is fixed at arming", () => {
  const page = {};
  let currentStage = "synthetic-armed-stage";
  const arm = createExpectedAbortArm(page, currentStage);
  currentStage = "synthetic-later-stage";
  assert.equal(arm.pending, true); assert.equal(arm.pending, true);
  assert.equal(arm.claim(page, "synthetic-armed-stage"), true);
  assert.equal(currentStage, "synthetic-later-stage");
});

test("arms are independent and detached claim needs no mutable receiver", () => {
  const page = {};
  const first = createExpectedAbortArm(page, "synthetic-stage");
  const second = createExpectedAbortArm(page, "synthetic-stage");
  assert.equal(first.claim(null, "synthetic-stage"), false);
  assert.equal(second.pending, true);
  const claim = second.claim;
  assert.equal(claim(page, "synthetic-stage"), true);
  assert.equal(claim(page, "synthetic-stage"), false);
});

test("returned arm is immutable and exposes no captured page or stage", () => {
  const page = { payload: "synthetic-private-marker" };
  const arm = createExpectedAbortArm(page, "synthetic-hidden-stage");
  assert.equal(Object.isFrozen(arm), true);
  assert.deepEqual(Reflect.ownKeys(arm).sort(), ["claim", "pending"]);
  assert.equal(Reflect.set(arm, "pending", false), false);
  assert.equal(arm.pending, true);
  assert.equal(JSON.stringify(arm), '{"pending":true}');
  assert.equal(arm.claim(page, "synthetic-hidden-stage"), true);
  assert.equal(JSON.stringify(arm), '{"pending":false}');
});

test("page identity comparison never reads or enumerates page properties", () => {
  const page = new Proxy({}, {
    get() { throw new Error("Page property access is forbidden in this test."); },
    ownKeys() { throw new Error("Page enumeration is forbidden in this test."); },
    getPrototypeOf() { throw new Error("Page prototype access is forbidden in this test."); },
  });
  assert.equal(createExpectedAbortArm(page, "synthetic-stage").claim(page, "synthetic-stage"), true);
});

test("invalid captured page or missing stage is rejected before an arm exists", () => {
  for (const page of [null, undefined, false, 1, "synthetic-not-page", () => {}]) {
    assert.throws(() => createExpectedAbortArm(page as object, "synthetic-stage"), TypeError);
  }
  for (const stage of [undefined, null, "", false, 1, {}]) {
    assert.throws(() => createExpectedAbortArm({}, stage as string), TypeError);
  }
});
