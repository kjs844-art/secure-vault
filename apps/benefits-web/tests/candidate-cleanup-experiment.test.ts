import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CANDIDATE_CLEANUP_EXPERIMENT_COUNTER_LIMIT as LIMIT,
  CANDIDATE_CLEANUP_EXPERIMENT_KEY as KEY,
  transformCandidateCleanupExperiment,
  type CandidateCleanupExperimentMode,
} from "../scripts/support/candidate-cleanup-experiment.ts";

const ORIGINAL = "finally { life.close(completedSuccess); discard(response); }";
const MODES: readonly CandidateCleanupExperimentMode[] = ["observe", "omit_perform_success_discard"];
interface Counters { performSuccess: number; performOther: number; discardInvoked: number; discardOmitted: number; overflow: boolean }
function counters(): Counters { return Object.getOwnPropertyDescriptor(globalThis, KEY)?.value as Counters; }
function isolated(action: () => void) {
  assert.equal(Object.hasOwn(globalThis, KEY), false);
  try { action(); } finally { assert.equal(Reflect.deleteProperty(globalThis, KEY), true); }
}
function compile(mode: CandidateCleanupExperimentMode, suffix = "") {
  return new Function("completedSuccess", "life", "discard", "response", "after",
    transformCandidateCleanupExperiment(`try {} ${ORIGINAL}\n${suffix}`, mode)) as (
      success: unknown, life: { close(value?: unknown): void }, discard: (response: unknown) => void,
      response: unknown, after?: () => void,
    ) => void;
}

test("transform is opt-in and rejects missing or unsupported modes without echoing source", () => {
  const syntheticSource = "synthetic-source-not-an-error-payload";
  for (const mode of [undefined, null, "", "default", "omit", {}, true]) {
    assert.throws(() => transformCandidateCleanupExperiment(syntheticSource, mode as CandidateCleanupExperimentMode),
      (error: unknown) => error instanceof Error && error.message.includes("explicit supported mode")
        && !error.message.includes(syntheticSource));
  }
  assert.throws(() => transformCandidateCleanupExperiment(null as unknown as string, "observe"), TypeError);
  assert.equal(Object.hasOwn(globalThis, KEY), false);
});

test("zero, multiple or formatting-drift cleanup matches fail closed", () => {
  for (const mode of MODES) {
    for (const source of ["", "finally { life.close(); discard(response); }", ORIGINAL.replace("; discard", ";  discard"),
      `${ORIGINAL}\n${ORIGINAL}`, `${ORIGINAL}\r\n${ORIGINAL}`]) {
      assert.throws(() => transformCandidateCleanupExperiment(source, mode), /exactly one original cleanup site/);
    }
    assert.throws(() => transformCandidateCleanupExperiment(transformCandidateCleanupExperiment(ORIGINAL, mode), mode),
      /exactly one original cleanup site/);
  }
});

test("LF and CRLF source before and after the exact cleanup site are preserved byte-for-byte", () => {
  for (const newline of ["\n", "\r\n"]) for (const mode of MODES) {
    const before = `const neighboring = \"synthetic\";${newline}try { neighboring; } `;
    const after = `${newline}life.check();${newline}throw new Error(\"synthetic-final-fence\");${newline}`;
    const source = before + ORIGINAL + after;
    const transformed = transformCandidateCleanupExperiment(source, mode);
    assert.equal(transformed.slice(0, before.length), before);
    assert.equal(transformed.slice(-after.length), after);
    assert.equal(source, before + ORIGINAL + after);
    assert.match(transformed.slice(before.length), /^finally \{\r?\n      life\.close\(completedSuccess\);/);
    if (newline === "\r\n") assert.equal(transformed.replaceAll("\r\n", "").includes("\n"), false);
  }
});

test("current actual module has exactly the pinned site and the entire final fence remains unchanged", () => {
  const source = readFileSync(new URL("../src/domain/candidate-batch-client.ts", import.meta.url), "utf8");
  const index = source.indexOf(ORIGINAL);
  assert.ok(index >= 0);
  const after = source.slice(index + ORIGINAL.length);
  assert.match(after, /life\.check\(\)/);
  assert.match(after, /try \{ life\.close\(\); \} catch/);
  for (const mode of MODES) {
    const transformed = transformCandidateCleanupExperiment(source, mode);
    assert.equal(transformed.slice(0, index), source.slice(0, index));
    assert.equal(transformed.slice(-after.length), after);
  }
  assert.equal(Object.hasOwn(globalThis, KEY), false);
});

test("observe retains discard for both branches and keeps life.close first", () => isolated(() => {
  const events: string[] = [];
  const run = compile("observe");
  const syntheticResponse = Object.freeze({ payload: "synthetic-not-retained" });
  for (const success of [true, false]) run(success, { close(value) {
    events.push(`close:${String(value)}`);
    if (success) assert.equal(Object.hasOwn(globalThis, KEY), false);
  } }, (response) => { assert.equal(response, syntheticResponse); events.push("discard"); }, syntheticResponse);
  assert.deepEqual(events, ["close:true", "discard", "close:false", "discard"]);
  assert.deepEqual(counters(), { performSuccess: 1, performOther: 1, discardInvoked: 2, discardOmitted: 0, overflow: false });
}));

test("omit skips only exact true and keeps every other branch discard", () => isolated(() => {
  const events: string[] = [];
  const run = compile("omit_perform_success_discard");
  for (const success of [true, false, undefined, "true", 1]) run(success,
    { close(value) { events.push(`close:${String(value)}`); } }, () => { events.push("discard"); }, undefined);
  assert.equal(events[0], "close:true");
  assert.deepEqual(events.slice(1), ["close:false", "discard", "close:undefined", "discard", "close:true", "discard", "close:1", "discard"]);
  assert.deepEqual(counters(), { performSuccess: 1, performOther: 4, discardInvoked: 4, discardOmitted: 1, overflow: false });
}));

test("counters initialize once, remain bounded and retain only four counts plus overflow", () => isolated(() => {
  const run = compile("observe");
  const life = { close() {} };
  const discard = () => {};
  run(true, life, discard, "synthetic-response-not-retained");
  const initial = counters();
  assert.equal(Object.isSealed(initial), true);
  assert.equal(Object.getOwnPropertyDescriptor(globalThis, KEY)?.enumerable, false);
  initial.performSuccess = LIMIT; initial.discardInvoked = LIMIT;
  run(true, life, discard, { body: "synthetic-body-not-retained", id: "synthetic-id-not-retained" });
  assert.equal(counters(), initial);
  assert.deepEqual(initial, { performSuccess: LIMIT, performOther: 0, discardInvoked: LIMIT, discardOmitted: 0, overflow: true });
  assert.deepEqual(Object.keys(initial).sort(), ["discardInvoked", "discardOmitted", "overflow", "performOther", "performSuccess"]);
  assert.equal(JSON.stringify(initial).includes("synthetic"), false);
}));

test("omitted and other counters also saturate without suppressing discard", () => isolated(() => {
  let discards = 0;
  const run = compile("omit_perform_success_discard");
  const discard = () => { discards += 1; };
  run(true, { close() {} }, discard, undefined);
  counters().discardOmitted = LIMIT; counters().performOther = LIMIT;
  run(true, { close() {} }, discard, undefined);
  run(false, { close() {} }, discard, undefined);
  assert.equal(counters().discardOmitted, LIMIT); assert.equal(counters().performOther, LIMIT);
  assert.equal(counters().overflow, true); assert.equal(discards, 1);
}));

test("a final-delivery fence failure is still observable after performSuccess and omission", () => {
  for (const mode of MODES) isolated(() => {
    const events: string[] = [];
    const finalFailure = new Error("synthetic-final-delivery-failed");
    const run = compile(mode, "try { after(); } catch (error) { life.close(); throw error; }");
    assert.throws(() => run(true, { close(value) { events.push(`close:${String(value)}`); } },
      () => { events.push("discard"); }, undefined, () => { throw finalFailure; }), (error) => error === finalFailure);
    assert.equal(events[0], "close:true"); assert.equal(events.at(-1), "close:undefined");
    assert.equal(counters().performSuccess, 1);
    assert.equal(counters().discardOmitted, mode === "observe" ? 0 : 1);
  });
});

test("life.close failure still precedes instrumentation and discard", () => isolated(() => {
  const closeFailure = new Error("synthetic-close-failure");
  for (const mode of MODES) {
    let discarded = false;
    assert.throws(() => compile(mode)(true, { close() { throw closeFailure; } }, () => { discarded = true; }, undefined),
      (error) => error === closeFailure);
    assert.equal(discarded, false); assert.equal(Object.hasOwn(globalThis, KEY), false);
  }
}));

test("a colliding global accessor is rejected without invoking it or exposing details", () => isolated(() => {
  let accessed = false;
  Object.defineProperty(globalThis, KEY, { configurable: true, get() { accessed = true; throw new Error("synthetic-private-detail"); } });
  assert.throws(() => compile("observe")(true, { close() {} }, () => {}, undefined), /Invalid test-only candidate cleanup counters\./);
  assert.equal(accessed, false);
}));

test("corrupted or payload-bearing counter shapes fail closed without echoing values", () => {
  for (const value of [null, {}, Object.seal({ performSuccess: NaN, performOther: 0, discardInvoked: 0, discardOmitted: 0, overflow: false }),
    Object.seal({ performSuccess: 0, performOther: 0, discardInvoked: 0, discardOmitted: 0, overflow: false, payload: "synthetic-private-detail" })]) {
    isolated(() => {
      Object.defineProperty(globalThis, KEY, { configurable: true, value });
      assert.throws(() => compile("observe")(true, { close() {} }, () => {}, undefined),
        (error: unknown) => error instanceof Error && error.message === "Invalid test-only candidate cleanup counters.");
    });
  }
});

test("replacement adds no awaits, Promise hooks, response fields, identifiers or network calls", () => {
  for (const mode of MODES) {
    const transformed = transformCandidateCleanupExperiment(ORIGINAL, mode);
    assert.doesNotMatch(transformed, /\b(?:await|Promise|fetch|Request|setTimeout|queueMicrotask)\b|\.then\(|response\./);
    assert.equal(transformed.split("response").length - 1, 1);
    assert.match(transformed, /performSuccess is not final public success/);
  }
});
