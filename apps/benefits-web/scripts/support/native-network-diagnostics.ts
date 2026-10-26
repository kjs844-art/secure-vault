/** Opt-in test diagnostics, not a transport success classifier. Raw CDP IDs
 * stay private keys. Server spans and Playwright Requests are NOT joined by URL. */
const ROUTES = ["/__candidate_completion", "/api/inbox/batch", "/api/inbox/discard", "/api/catalog/list", "/api/catalog/create",
  "/api/catalog/update", "/api/catalog/delete", "/api/review/preview", "/api/review/confirm",
  "/api/review/reject", "/api/review/delete", "/api/review/get", "/api/review/list"] as const;
type Route = typeof ROUTES[number];
export type NativeDiagnosticPhase = "RUNNING" | "CONTEXT_CLOSE" | "BROWSER_CLOSE" | "SERVER_CLOSE";
export type NativeDiagnosticEvent = "requestWillBeSent" | "responseReceived" | "loadingFinished" | "loadingFailed";
export type NativeDiagnosticIssue = "ATTACH_FAILED" | "ENABLE_FAILED" | "OBSERVER_ERROR" | "MALFORMED_EVENT"
  | "CAPACITY_EXCEEDED" | "REQUEST_ID_REUSED" | "UNKNOWN_SESSION"
  | "START_COVERAGE_MISMATCH" | "KNOWN_RESPONSE_WITHOUT_START";
export type ServerDiagnosticEvent = "end_attempt" | "finish" | "close" | "error" | "timeout" | "bridge_released";
export interface ServerDiagnosticState {
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  readonly writableFinished: boolean;
  readonly destroyed: boolean;
  readonly status: number | null;
}
interface Limits { requests: number; events: number; servers: number; sessions: number }
type Sample = Readonly<Record<string, string | number | boolean | null>>;
interface RequestRecord { ordinal: number; session: number; route: Route; terminal: boolean; events: Sample[] }
interface SessionRecord { closed: boolean; requests: Map<string, RequestRecord> }
interface ServerRecord { ordinal: number; route: Route; method: string; closed: boolean; events: Sample[] }
const DEFAULTS: Limits = { requests: 1024, events: 8192, servers: 1024, sessions: 128 };
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error("INVALID_EVENT");
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw Error("INVALID_EVENT");
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) throw Error("INVALID_EVENT");
  return value;
}
function label(value: unknown, allowed: readonly string[]): string { return typeof value === "string" && allowed.includes(value) ? value : "other"; }
function status(value: unknown): number {
  const result = number(value);
  if (!Number.isInteger(result) || result > 599) throw Error("INVALID_EVENT");
  return result;
}

export function createNativeNetworkDiagnostics(origin: string, input: Partial<Limits> = {}) {
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash) throw Error("DIAGNOSTIC_CONFIG_INVALID");
  const limits = { ...DEFAULTS, ...input };
  for (const key of Object.keys(DEFAULTS) as (keyof Limits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULTS[key]) throw Error("DIAGNOSTIC_CONFIG_INVALID");
  }
  const sessions = new Map<number, SessionRecord>(), requests: RequestRecord[] = [], servers: ServerRecord[] = [];
  const issues = new Set<NativeDiagnosticIssue>(), lifecycle: Sample[] = [];
  const playwrightStarts = new Map<Route, number>(ROUTES.map((route) => [route, 0]));
  const unmatchedEvents = { responseReceived: 0, loadingFinished: 0, loadingFailed: 0 };
  let phase: NativeDiagnosticPhase = "RUNNING", eventCount = 0, playwrightStartsTotal = 0;
  const issue = (code: NativeDiagnosticIssue) => { issues.add(code); };
  function observePlaywrightRequestStart(requestUrl: unknown) {
    const route = ROUTES.find((known) => requestUrl === origin + known);
    if (!route) return;
    if (playwrightStartsTotal >= limits.requests) { issue("CAPACITY_EXCEEDED"); return; }
    playwrightStartsTotal++;
    playwrightStarts.set(route, playwrightStarts.get(route)! + 1);
  }
  function append(target: Sample[], value: Sample) {
    if (eventCount >= limits.events) { issue("CAPACITY_EXCEEDED"); return; }
    eventCount++; target.push(Object.freeze(value));
  }
  function sessionOpened(): number | null {
    if (sessions.size >= limits.sessions) { issue("CAPACITY_EXCEEDED"); return null; }
    const ordinal = sessions.size + 1;
    sessions.set(ordinal, { closed: false, requests: new Map() });
    append(lifecycle, { event: "session_opened", session: ordinal, hostObservedAtMs: performance.now(), phase });
    return ordinal;
  }
  function sessionClosed(session: number) {
    const current = sessions.get(session);
    if (!current) { issue("UNKNOWN_SESSION"); return; }
    if (current.closed) return;
    current.closed = true;
    append(lifecycle, { event: "session_closed", session, hostObservedAtMs: performance.now(), phase });
  }
  function observe(session: number, name: NativeDiagnosticEvent, payload: unknown) {
    try {
      const current = sessions.get(session);
      if (!current) { issue("UNKNOWN_SESSION"); return; }
      const event = object(payload);
      if (name === "requestWillBeSent") {
        const request = object(event.request);
        const route = ROUTES.find((known) => request.url === origin + known);
        if (!route) return;
        const id = identifier(event.requestId);
        if (current.requests.has(id)) { issue("REQUEST_ID_REUSED"); return; }
        if (requests.length >= limits.requests) { issue("CAPACITY_EXCEEDED"); return; }
        const record: RequestRecord = { ordinal: requests.length + 1, session, route, terminal: false, events: [] };
        current.requests.set(id, record); requests.push(record);
        append(record.events, { event: name, timestamp: number(event.timestamp), hostObservedAtMs: performance.now(), phase,
          afterSessionClose: current.closed, method: label(request.method, ["GET", "POST"]),
          resourceType: label(event.type, ["Fetch", "XHR", "Document", "Other"]), redirectObserved: event.redirectResponse !== undefined });
        return;
      }
      // Unknown-route IDs were never retained. Terminal events cannot acquire a
      // known route or borrow another session's record by matching a URL.
      const record = current.requests.get(identifier(event.requestId));
      if (!record) {
        if (unmatchedEvents[name] >= limits.events) issue("CAPACITY_EXCEEDED");
        else unmatchedEvents[name]++;
        // A response URL can prove a known-route coverage gap, but cannot
        // reconstruct the missing request identity. Terminal events lack URLs:
        // they may belong to ignored assets and must not invent an API match.
        if (name === "responseReceived") {
          const response = object(event.response);
          if (ROUTES.some((known) => response.url === origin + known)) issue("KNOWN_RESPONSE_WITHOUT_START");
        }
        return;
      }
      const common = { event: name, timestamp: number(event.timestamp), hostObservedAtMs: performance.now(), phase,
        afterSessionClose: current.closed };
      if (name === "responseReceived") {
        const response = object(event.response);
        append(record.events, { ...common, status: status(response.status),
          resourceType: label(event.type, ["Fetch", "XHR", "Document", "Other"]),
          protocol: label(response.protocol, ["http/1.0", "http/1.1", "h2", "h3"]),
          encodedDataLength: response.encodedDataLength === undefined ? null : number(response.encodedDataLength),
          fromDiskCache: response.fromDiskCache === true, fromServiceWorker: response.fromServiceWorker === true });
      } else if (name === "loadingFinished") {
        append(record.events, { ...common, encodedDataLength: number(event.encodedDataLength) }); record.terminal = true;
      } else if (name === "loadingFailed") {
        append(record.events, { ...common, resourceType: label(event.type, ["Fetch", "XHR", "Document", "Other"]),
          canceled: typeof event.canceled === "boolean" ? event.canceled : null,
          failure: label(event.errorText, ["net::ERR_ABORTED", "net::ERR_FAILED", "net::ERR_CONNECTION_RESET",
            "net::ERR_CONNECTION_CLOSED", "net::ERR_TIMED_OUT"]),
          blockedReason: event.blockedReason === undefined ? null : label(event.blockedReason,
            ["other", "csp", "mixed-content", "origin", "inspector", "subresource-filter", "content-type", "coep-frame-resource-needs-coep-header", "coop-sandboxed-iframe-cannot-navigate-to-coop-page", "corp-not-same-origin", "corp-not-same-origin-after-defaulted-to-same-origin-by-coep", "corp-not-same-site"]),
          corsErrorObserved: event.corsErrorStatus !== undefined }); record.terminal = true;
      }
    } catch { issue("MALFORMED_EVENT"); }
  }
  function serverStarted(method: unknown, path: unknown): number | null {
    const route = ROUTES.find((known) => path === known);
    if (!route) return null;
    if (servers.length >= limits.servers) { issue("CAPACITY_EXCEEDED"); return null; }
    const record: ServerRecord = { ordinal: servers.length + 1, route, method: label(method, ["GET", "POST"]), closed: false, events: [] };
    servers.push(record);
    append(record.events, { event: "accepted", hostObservedAtMs: performance.now(), phase });
    return record.ordinal;
  }
  function serverEvent(ordinal: number | null | undefined, name: ServerDiagnosticEvent, state: ServerDiagnosticState) {
    if (ordinal === null || ordinal === undefined) return;
    try {
      const record = servers[ordinal - 1];
      if (!record || record.ordinal !== ordinal) throw Error("INVALID_EVENT");
      const sample = { event: name, hostObservedAtMs: performance.now(), phase,
        headersSent: state.headersSent === true, writableEnded: state.writableEnded === true,
        writableFinished: state.writableFinished === true, destroyed: state.destroyed === true,
        status: state.status === null ? null : status(state.status) };
      append(record.events, sample);
      if (name === "close") record.closed = true;
    } catch { issue("OBSERVER_ERROR"); }
  }
  function setPhase(value: NativeDiagnosticPhase) {
    phase = value;
    append(lifecycle, { event: "phase", phase, hostObservedAtMs: performance.now() });
  }
  function snapshot() {
    const pendingRequests = requests.filter((record) => !record.terminal).length;
    const pendingServers = servers.filter((record) => !record.closed).length;
    const routeCoverage = ROUTES.map((route) => Object.freeze({ route, playwrightStarts: playwrightStarts.get(route)!,
      cdpStarts: requests.filter((record) => record.route === route).length }));
    const coverageMismatch = routeCoverage.some((counts) => counts.playwrightStarts !== counts.cdpStarts);
    // Start events from independent channels may arrive in either order. A
    // transient snapshot mismatch is not latched after both counts reconcile.
    const snapshotIssues: NativeDiagnosticIssue[] = [...issues];
    if (coverageMismatch) snapshotIssues.push("START_COVERAGE_MISMATCH");
    return Object.freeze({ status: snapshotIssues.length || pendingRequests || pendingServers ? "INCOMPLETE" : "COMPLETE",
      issues: Object.freeze(snapshotIssues), pendingRequests, pendingServers, eventCount,
      routeCoverage: Object.freeze(routeCoverage), unmatchedEvents: Object.freeze({ ...unmatchedEvents }),
      limits: Object.freeze({ ...limits }),
      association: "CDP session/request identity only; server spans are separate; no Playwright Request or server join by URL",
      coverageLimitations: "Per-route independent start-count parity is necessary, not identity or complete-loss proof; unmatched terminal events have no route and may be ignored assets; known response URLs only flag missing starts",
      clocks: "CDP timestamp seconds and host monotonic milliseconds are distinct clock domains",
      sessions: sessions.size, lifecycle: Object.freeze([...lifecycle]),
      requests: Object.freeze(requests.map(({ ordinal, session, route, terminal, events }) =>
        Object.freeze({ ordinal, session, route, terminal, events: Object.freeze([...events]) }))),
      servers: Object.freeze(servers.map(({ ordinal, route, method, closed, events }) =>
        Object.freeze({ ordinal, route, method, closed, events: Object.freeze([...events]) }))) });
  }
  return Object.freeze({ sessionOpened, sessionClosed, observe, observePlaywrightRequestStart, serverStarted, serverEvent, setPhase, issue, snapshot });
}
