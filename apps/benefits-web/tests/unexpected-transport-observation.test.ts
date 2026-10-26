import assert from "node:assert/strict";
import { test } from "node:test";
import { observeUnexpectedTransport, type ReadHelperTrace } from "../scripts/support/unexpected-transport-observation.ts";

const ORIGIN = "http://127.0.0.1:43210";
function fixture() {
  return { stage: "synthetic_read", origin: ORIGIN, requestStages: new WeakMap<object, string>(),
    responseStatuses: new WeakMap<object, number>(), requestReadHelpers: new WeakMap<object, ReadHelperTrace>() };
}
function request(url = ORIGIN + "/api/catalog/list", method = "POST", errorText: string | null = "net::ERR_ABORTED") {
  return { url: () => url, method: () => method, failure: () => errorText === null ? null : { errorText } };
}
function trace(): ReadHelperTrace {
  return { helper: "nextCatalog", ordinal: 1, expectedPhase: "end_observed", requestCount: 1, wireDelta: 0,
    loadedPhaseObserved: false, oneSuccessfulWireObserved: false, helperCompleted: false, transportAtHelperCompletion: null };
}

test("HTTP 200 plus failed transport remains an unexpected-failure observation, not success", () => {
  const context = fixture(), failed = request();
  context.responseStatuses.set(failed, 200);
  const observation = observeUnexpectedTransport(failed, context);
  assert.equal(observation.observedResponseStatus, 200);
  assert.equal(observation.failure, "net::ERR_ABORTED");
  assert.equal(observation.readHelper, null);
  assert.equal(observation.helperCompletedAtFailure, null);
  assert.equal(observation.loadedPhaseObservedAtFailure, null);
  assert.ok(Object.isFrozen(observation));
  assert.equal(Object.hasOwn(observation, "expected"), false);
});

test("failure-time flags stay false when that same helper completes later", () => {
  const context = fixture(), failed = request(), helper = trace();
  context.requestReadHelpers.set(failed, helper);
  context.requestStages.set(failed, "synthetic_started");
  const observation = observeUnexpectedTransport(failed, context);
  helper.loadedPhaseObserved = true; helper.wireDelta = 1;
  helper.oneSuccessfulWireObserved = true; helper.helperCompleted = true;
  context.stage = "synthetic_later"; context.responseStatuses.set(failed, 200);
  assert.equal(observation.stage, "synthetic_read");
  assert.equal(observation.startedStage, "synthetic_started");
  assert.equal(observation.observedResponseStatus, null);
  assert.equal(observation.helperCompletedAtFailure, false);
  assert.equal(observation.loadedPhaseObservedAtFailure, false);
  assert.equal(observation.readHelper, helper);
  assert.equal(observation.readHelper?.helperCompleted, true);
});

test("already completed helper flags remain true independently of later trace changes", () => {
  const context = fixture(), failed = request(), helper = trace();
  helper.helperCompleted = true; helper.loadedPhaseObserved = true;
  context.requestReadHelpers.set(failed, helper);
  const observation = observeUnexpectedTransport(failed, context);
  helper.helperCompleted = false; helper.loadedPhaseObserved = false;
  assert.equal(observation.helperCompletedAtFailure, true);
  assert.equal(observation.loadedPhaseObservedAtFailure, true);
});

test("matching URLs cannot borrow a different native Request's evidence", () => {
  const context = fixture(), first = request(), second = request();
  context.requestStages.set(first, "synthetic_first"); context.responseStatuses.set(first, 200);
  context.requestReadHelpers.set(first, trace());
  const observation = observeUnexpectedTransport(second, context);
  assert.equal(observation.startedStage, "unknown"); assert.equal(observation.observedResponseStatus, null);
  assert.equal(observation.readHelper, null); assert.equal(observation.route, "/api/catalog/list");
});

test("unknown route/query, arbitrary method and adapter error text never enter the report", () => {
  const context = fixture(), marker = "synthetic-private-diagnostic-marker";
  for (const url of [ORIGIN + "/api/catalog/list?" + marker, "https://synthetic.invalid/" + marker,
    ORIGIN + "/api/catalog/list/" + marker]) {
    const observation = observeUnexpectedTransport(request(url, marker, marker), context);
    assert.equal(observation.route, "other"); assert.equal(observation.method, "other");
    assert.equal(observation.failure, "other"); assert.equal(JSON.stringify(observation).includes(marker), false);
  }
});

test("all known routes are exact fixed labels; only GET/POST and the known abort text are retained", () => {
  for (const route of ["/__candidate_completion", "/api/inbox/batch", "/api/catalog/list", "/api/catalog/create",
    "/api/catalog/update", "/api/catalog/delete", "/api/review/preview", "/api/review/confirm", "/api/review/reject", "/api/review/delete",
    "/api/review/get", "/api/review/list"]) {
    for (const method of ["GET", "POST"]) {
      const observation = observeUnexpectedTransport(request(ORIGIN + route, method), fixture());
      assert.equal(observation.route, route); assert.equal(observation.method, method);
      assert.equal(observation.failure, "net::ERR_ABORTED");
    }
  }
  for (const error of [null, "net::ERR_ABORTED synthetic-detail", "synthetic-unknown"])
    assert.equal(observeUnexpectedTransport(request(undefined, undefined, error), fixture()).failure, "other");
});
