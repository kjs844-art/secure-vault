import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeNetworkDiagnostics, type ServerDiagnosticState } from "../scripts/support/native-network-diagnostics.ts";

const ORIGIN = "http://127.0.0.1:43210", PRIVATE = "synthetic-private-diagnostic-marker";
function request(requestId = PRIVATE, url = ORIGIN + "/api/catalog/list") {
  return { requestId, timestamp: 1, type: "Fetch", request: { url, method: "POST",
    headers: { cookie: PRIVATE }, postData: PRIVATE }, loaderId: PRIVATE, frameId: PRIVATE };
}
function response(requestId = PRIVATE) {
  return { requestId, timestamp: 2, type: "Fetch", response: { status: 200, protocol: "http/1.1",
    encodedDataLength: 100, url: ORIGIN + "/api/catalog/list?private=" + PRIVATE,
    headers: { "set-cookie": PRIVATE }, body: PRIVATE } };
}
function finished(requestId = PRIVATE) { return { requestId, timestamp: 3, encodedDataLength: 120 }; }
const state: ServerDiagnosticState = { headersSent: true, writableEnded: true, writableFinished: true, destroyed: false, status: 503 };

test("HTTP 200 followed by native failure stays a failed terminal observation, never a success classification", () => {
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN), session = diagnostics.sessionOpened()!;
  diagnostics.observePlaywrightRequestStart(ORIGIN + "/api/catalog/list");
  diagnostics.observe(session, "requestWillBeSent", request());
  diagnostics.observe(session, "responseReceived", response());
  diagnostics.observe(session, "loadingFailed", { requestId: PRIVATE, timestamp: 3, type: "Fetch",
    errorText: "net::ERR_ABORTED", canceled: true, headers: { cookie: PRIVATE } });
  const snapshot = diagnostics.snapshot(), events = snapshot.requests[0]!.events;
  assert.equal(snapshot.status, "COMPLETE"); // Coverage, not transport success.
  assert.equal(events[1]!.status, 200);
  assert.equal(events[2]!.failure, "net::ERR_ABORTED");
  assert.equal(events[2]!.canceled, true);
  assert.equal(events[2]!.event, "loadingFailed");
  assert.equal(JSON.stringify(snapshot).includes(PRIVATE), false);
  assert.equal(Object.hasOwn(snapshot, "success"), false);
  assert.equal(Object.hasOwn(events[2]!, "expected"), false);
});

test("same raw ID in different CDP sessions and different IDs at the same URL never share a record", () => {
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN), a = diagnostics.sessionOpened()!, b = diagnostics.sessionOpened()!;
  for (let index = 0; index < 3; index++) diagnostics.observePlaywrightRequestStart(ORIGIN + "/api/catalog/list");
  diagnostics.observe(a, "requestWillBeSent", request());
  diagnostics.observe(b, "requestWillBeSent", request());
  diagnostics.observe(a, "requestWillBeSent", request("second"));
  diagnostics.observe(b, "loadingFinished", finished());
  let snapshot = diagnostics.snapshot();
  assert.deepEqual(snapshot.requests.map(({ ordinal, session, terminal }) => ({ ordinal, session, terminal })),
    [{ ordinal: 1, session: a, terminal: false }, { ordinal: 2, session: b, terminal: true }, { ordinal: 3, session: a, terminal: false }]);
  diagnostics.observe(a, "loadingFinished", finished());
  diagnostics.observe(a, "loadingFinished", finished("second"));
  snapshot = diagnostics.snapshot();
  assert.equal(snapshot.status, "COMPLETE");
  assert.deepEqual(snapshot.servers, []);
  assert.match(snapshot.association, /no Playwright Request or server join by URL/);
});

test("external, unknown, query-bearing and suffixed routes never become retained known-route requests", () => {
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN), session = diagnostics.sessionOpened()!;
  for (const url of ["https://external.invalid/api/catalog/list", ORIGIN + "/unknown", ORIGIN + "/api/catalog/list?" + PRIVATE,
    ORIGIN + "/api/catalog/list/", ORIGIN + "/api/catalog/list#" + PRIVATE]) {
    diagnostics.observe(session, "requestWillBeSent", request(PRIVATE, url));
    diagnostics.observe(session, "responseReceived", response());
    diagnostics.observe(session, "loadingFinished", finished());
    assert.equal(diagnostics.serverStarted("POST", url), null);
  }
  assert.equal(diagnostics.serverStarted("POST", "/api/catalog/list?" + PRIVATE), null);
  assert.equal(diagnostics.snapshot().requests.length, 0);
  assert.equal(diagnostics.snapshot().servers.length, 0);
  assert.equal(JSON.stringify(diagnostics.snapshot()).includes(PRIVATE), false);
});

test("late terminal after session close is explicit and does not mutate an earlier failure-time snapshot", () => {
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN), session = diagnostics.sessionOpened()!;
  diagnostics.observePlaywrightRequestStart(ORIGIN + "/api/catalog/list");
  diagnostics.observe(session, "requestWillBeSent", request());
  const before = diagnostics.snapshot();
  assert.equal(before.status, "INCOMPLETE");
  diagnostics.setPhase("CONTEXT_CLOSE"); diagnostics.sessionClosed(session);
  diagnostics.observe(session, "loadingFinished", finished());
  const after = diagnostics.snapshot();
  assert.equal(after.status, "COMPLETE");
  assert.equal(after.requests[0]!.events[1]!.afterSessionClose, true);
  assert.equal(after.requests[0]!.events[1]!.phase, "CONTEXT_CLOSE");
  assert.equal(before.pendingRequests, 1);
  assert.equal(before.requests[0]!.terminal, false);
  assert.equal(before.requests[0]!.events.length, 1);
  assert.ok(Object.isFrozen(before.requests[0]!.events[0]));
});

test("same-session request ID reuse is incomplete rather than overwriting request identity", () => {
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN), session = diagnostics.sessionOpened()!;
  diagnostics.observePlaywrightRequestStart(ORIGIN + "/api/catalog/list");
  diagnostics.observe(session, "requestWillBeSent", request());
  diagnostics.observe(session, "requestWillBeSent", request(PRIVATE, ORIGIN + "/api/inbox/batch"));
  diagnostics.observe(session, "loadingFinished", finished());
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.status, "INCOMPLETE"); assert.deepEqual(snapshot.issues, ["REQUEST_ID_REUSED"]);
  assert.equal(snapshot.requests.length, 1); assert.equal(snapshot.requests[0]!.route, "/api/catalog/list");
});

test("malformed events and arbitrary protocol/error values cannot leak raw diagnostic text", () => {
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN), session = diagnostics.sessionOpened()!;
  diagnostics.observe(session, "requestWillBeSent", { ...request(), timestamp: Number.NaN });
  diagnostics.observe(session, "responseReceived", { ...response(), response: { status: 200, protocol: PRIVATE } });
  diagnostics.observe(session, "loadingFailed", { requestId: PRIVATE, timestamp: 3, type: PRIVATE,
    errorText: PRIVATE, canceled: false, blockedReason: PRIVATE, corsErrorStatus: { failedParameter: PRIVATE } });
  diagnostics.observe(session, "loadingFinished", { get requestId() { throw Error(PRIVATE); } });
  const snapshot = diagnostics.snapshot(), events = snapshot.requests[0]!.events;
  assert.equal(snapshot.status, "INCOMPLETE"); assert.ok(snapshot.issues.includes("MALFORMED_EVENT"));
  assert.equal(events[0]!.protocol, "other"); assert.equal(events[1]!.failure, "other");
  assert.equal(events[1]!.resourceType, "other"); assert.equal(events[1]!.canceled, false);
  assert.equal(events[1]!.blockedReason, "other"); assert.equal(events[1]!.corsErrorObserved, true);
  assert.equal(JSON.stringify(snapshot).includes(PRIVATE), false);
});

test("every retention capacity is bounded and overflow is explicitly incomplete", () => {
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN, { requests: 1, sessions: 1, servers: 1, events: 3 });
  const session = diagnostics.sessionOpened()!;
  diagnostics.observePlaywrightRequestStart(ORIGIN + "/api/catalog/list");
  assert.equal(diagnostics.sessionOpened(), null);
  diagnostics.observe(session, "requestWillBeSent", request());
  diagnostics.observe(session, "requestWillBeSent", request("overflow"));
  const server = diagnostics.serverStarted("POST", "/api/catalog/list");
  assert.equal(diagnostics.serverStarted("POST", "/api/catalog/list"), null);
  diagnostics.observe(session, "loadingFinished", finished()); diagnostics.serverEvent(server, "close", state);
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.status, "INCOMPLETE"); assert.deepEqual(snapshot.issues, ["CAPACITY_EXCEEDED"]);
  assert.equal(snapshot.requests.length, 1); assert.equal(snapshot.servers.length, 1); assert.equal(snapshot.sessions, 1);
  assert.equal(snapshot.eventCount, 3);
  assert.equal(snapshot.lifecycle.length + snapshot.requests[0]!.events.length + snapshot.servers[0]!.events.length, 3);
});

test("server end attempt, released bridge, finish and close are separate ordered observations, not browser joins", () => {
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN);
  const server = diagnostics.serverStarted("POST", "/api/catalog/update");
  diagnostics.serverEvent(server, "end_attempt", { ...state, writableEnded: false, writableFinished: false });
  diagnostics.serverEvent(server, "bridge_released", { ...state, writableFinished: false });
  diagnostics.serverEvent(server, "finish", state);
  assert.equal(diagnostics.snapshot().pendingServers, 1);
  diagnostics.serverEvent(server, "close", { ...state, destroyed: true });
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.status, "COMPLETE"); assert.equal(snapshot.requests.length, 0);
  assert.deepEqual(snapshot.servers[0]!.events.map(({ event }) => event), ["accepted", "end_attempt", "bridge_released", "finish", "close"]);
  assert.equal(snapshot.servers[0]!.events[1]!.status, 503);
  assert.equal(snapshot.servers[0]!.events[1]!.writableEnded, false);
  assert.equal(snapshot.servers[0]!.events[2]!.writableFinished, false);
  assert.equal(snapshot.servers[0]!.events[4]!.destroyed, true);
});

test("observer setup errors and missing terminal evidence cannot produce complete coverage", () => {
  for (const issue of ["ATTACH_FAILED", "ENABLE_FAILED", "OBSERVER_ERROR"] as const) {
    const diagnostics = createNativeNetworkDiagnostics(ORIGIN); diagnostics.issue(issue);
    assert.equal(diagnostics.snapshot().status, "INCOMPLETE"); assert.deepEqual(diagnostics.snapshot().issues, [issue]);
  }
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN), session = diagnostics.sessionOpened()!;
  diagnostics.observe(session, "requestWillBeSent", request()); diagnostics.serverStarted("POST", "/api/catalog/list");
  assert.equal(diagnostics.snapshot().pendingRequests, 1); assert.equal(diagnostics.snapshot().pendingServers, 1);
  diagnostics.observe(99, "loadingFinished", finished());
  assert.ok(diagnostics.snapshot().issues.includes("UNKNOWN_SESSION"));
});

test("normal zero API requests is allowed but one independent start without CDP is incomplete", () => {
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN); diagnostics.sessionOpened();
  assert.equal(diagnostics.snapshot().status, "COMPLETE");
  diagnostics.observePlaywrightRequestStart(ORIGIN + "/api/catalog/list");
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.status, "INCOMPLETE");
  assert.deepEqual(snapshot.issues, ["START_COVERAGE_MISMATCH"]);
  assert.deepEqual(snapshot.routeCoverage.find(({ route }) => route === "/api/catalog/list"),
    { route: "/api/catalog/list", playwrightStarts: 1, cdpStarts: 0 });
  assert.equal(snapshot.requests.length, 0); // Independent starts never invent CDP identities.
});

test("equal global totals do not hide mismatched route coverage", () => {
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN), session = diagnostics.sessionOpened()!;
  diagnostics.observePlaywrightRequestStart(ORIGIN + "/api/inbox/batch");
  diagnostics.observe(session, "requestWillBeSent", request());
  diagnostics.observe(session, "loadingFinished", finished());
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.status, "INCOMPLETE"); assert.deepEqual(snapshot.issues, ["START_COVERAGE_MISMATCH"]);
  assert.equal(snapshot.routeCoverage.reduce((sum, item) => sum + item.playwrightStarts, 0), 1);
  assert.equal(snapshot.routeCoverage.reduce((sum, item) => sum + item.cdpStarts, 0), 1);
});

test("independent starts reconcile regardless of arrival order without mutating earlier snapshots", () => {
  for (const playwrightFirst of [false, true]) {
    const diagnostics = createNativeNetworkDiagnostics(ORIGIN), session = diagnostics.sessionOpened()!;
    if (playwrightFirst) diagnostics.observePlaywrightRequestStart(ORIGIN + "/api/catalog/list");
    else { diagnostics.observe(session, "requestWillBeSent", request()); diagnostics.observe(session, "loadingFinished", finished()); }
    const before = diagnostics.snapshot();
    assert.equal(before.status, "INCOMPLETE");
    if (playwrightFirst) { diagnostics.observe(session, "requestWillBeSent", request()); diagnostics.observe(session, "loadingFinished", finished()); }
    else diagnostics.observePlaywrightRequestStart(ORIGIN + "/api/catalog/list");
    assert.equal(diagnostics.snapshot().status, "COMPLETE");
    assert.equal(before.status, "INCOMPLETE"); assert.deepEqual(before.issues, ["START_COVERAGE_MISMATCH"]);
  }
});

test("independent observer only counts fixed exact origin routes and bounds retained counters", () => {
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN, { requests: 1 });
  for (const url of [null, {}, "https://external.invalid/api/catalog/list", ORIGIN + "/api/catalog/list?" + PRIVATE,
    ORIGIN + "/api/catalog/list/", ORIGIN + "/api/catalog/list#" + PRIVATE]) diagnostics.observePlaywrightRequestStart(url);
  assert.equal(diagnostics.snapshot().status, "COMPLETE");
  for (let index = 0; index < 5; index++) diagnostics.observePlaywrightRequestStart(ORIGIN + "/api/catalog/list");
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.status, "INCOMPLETE"); assert.ok(snapshot.issues.includes("CAPACITY_EXCEEDED"));
  assert.equal(snapshot.routeCoverage.reduce((sum, item) => sum + item.playwrightStarts, 0), 1);
  assert.equal(JSON.stringify(snapshot).includes(PRIVATE), false);
});

test("known response URL without a same-session start flags a gap without reconstructing request identity", () => {
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN), session = diagnostics.sessionOpened()!;
  diagnostics.observe(session, "responseReceived", { ...response(), response: { ...response().response, url: ORIGIN + "/api/catalog/list" } });
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.status, "INCOMPLETE"); assert.deepEqual(snapshot.issues, ["KNOWN_RESPONSE_WITHOUT_START"]);
  assert.equal(snapshot.unmatchedEvents.responseReceived, 1);
  assert.equal(snapshot.requests.length, 0); assert.equal(JSON.stringify(snapshot).includes(PRIVATE), false);
});

test("unmatched URL-less terminal events remain unclassified and cannot fill a missing CDP API start", () => {
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN), session = diagnostics.sessionOpened()!;
  diagnostics.observe(session, "loadingFinished", finished());
  diagnostics.observe(session, "loadingFailed", { requestId: PRIVATE, timestamp: 4, errorText: PRIVATE });
  diagnostics.observe(session, "responseReceived", response()); // Query-bearing URL is not an exact known route.
  const noApi = diagnostics.snapshot();
  assert.equal(noApi.status, "COMPLETE");
  assert.deepEqual(noApi.unmatchedEvents, { responseReceived: 1, loadingFinished: 1, loadingFailed: 1 });
  assert.match(noApi.coverageLimitations, /unmatched terminal events have no route/);
  diagnostics.observePlaywrightRequestStart(ORIGIN + "/api/catalog/list");
  const missing = diagnostics.snapshot();
  assert.equal(missing.status, "INCOMPLETE"); assert.deepEqual(missing.issues, ["START_COVERAGE_MISMATCH"]);
  assert.equal(missing.requests.length, 0); assert.equal(JSON.stringify(missing).includes(PRIVATE), false);
});

test("unmatched event counters have a bound and report loss explicitly", () => {
  const diagnostics = createNativeNetworkDiagnostics(ORIGIN, { events: 2 }), session = diagnostics.sessionOpened()!;
  for (let index = 0; index < 5; index++) diagnostics.observe(session, "loadingFinished", finished());
  assert.equal(diagnostics.snapshot().unmatchedEvents.loadingFinished, 2);
  assert.equal(diagnostics.snapshot().status, "INCOMPLETE");
  assert.deepEqual(diagnostics.snapshot().issues, ["CAPACITY_EXCEEDED"]);
});
