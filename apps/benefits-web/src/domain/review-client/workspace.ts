/** In-memory review workflow composition, not authentication, persistence or UI wiring.
 * Cached snapshots are observations, never balance/freshness/confirmation authority.
 * No automatic fetch, decision, retry, operation ID, timer or production route. */
import { createReviewCommandOwner, MAX_REVIEW_PREPARED_COMMANDS, type ReviewCommandLease,
  type ReviewCommandOwnerConfig, type ReviewPreparedCommand, type ReviewPrepareResult,
  type ReviewExecuteResult } from "./command-owner.ts";
import { snapshotReviewRequest, createReviewListRequest, type ReviewRequest } from "./requests.ts";
import { createReviewPreviewOwner, type ReviewPreviewLease, type ReviewPreviewSnapshot,
  type ReviewPreviewTicket } from "../review-preview-owner.ts";
import { createReviewedBenefitListOwner, type ReviewedBenefitListLease, type ReviewedBenefitListSnapshot,
  type ReviewedBenefitListTicket } from "../reviewed-benefit-list-owner.ts";

export interface ReviewWorkspaceContext { readonly bindingId: string; readonly dataGeneration: number }
declare const leaseBrand: unique symbol;
export type ReviewWorkspaceLease = { readonly [leaseBrand]: true };
export interface ReviewWorkspaceSnapshot {
  readonly lease: ReviewWorkspaceLease;
  readonly context: ReviewWorkspaceContext;
  readonly preview: ReviewPreviewSnapshot;
  readonly list: ReviewedBenefitListSnapshot;
}
export interface ReviewWorkspaceConfig {
  readonly client: Omit<ReviewCommandOwnerConfig, "now">;
  /** Trusted pure clock port; both coordinates must be nondecreasing. */
  readonly clocks: () => unknown;
}
export type ReviewWorkspaceNextPageResult = ReviewExecuteResult | { readonly kind: "unavailable" };
interface View {
  readonly lease: ReviewWorkspaceLease;
  readonly context: ReviewWorkspaceContext;
  readonly commands: ReviewCommandLease;
  readonly preview: ReviewPreviewLease;
  list: ReviewedBenefitListLease;
}
interface Record {
  readonly view: View;
  readonly request: ReviewRequest;
  running: boolean;
  attempted: boolean;
}
interface PreviewFlight { readonly command: ReviewPreparedCommand; readonly record: Record; readonly ticket: ReviewPreviewTicket }
interface PageFlight { readonly view: View; readonly list: ReviewedBenefitListLease;
  readonly command: ReviewPreparedCommand; readonly ticket: ReviewedBenefitListTicket }
function fields(input: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error();
  const prototype = Object.getPrototypeOf(input), descriptors = Object.getOwnPropertyDescriptors(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
  if (required.some((key) => !Object.hasOwn(descriptors, key))) throw new Error();
  const result: { [key: string]: unknown } = Object.create(null) as { [key: string]: unknown };
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) throw new Error();
    const property = descriptors[key]!;
    if (!property.enumerable || !Object.hasOwn(property, "value")) throw new Error();
    result[key] = property.value as unknown;
  }
  return result;
}
export function normalizeReviewWorkspaceContext(input: unknown): ReviewWorkspaceContext | null {
  try {
    const { bindingId, dataGeneration } = fields(input, ["bindingId", "dataGeneration"]);
    if (typeof bindingId !== "string" || bindingId.trim() !== bindingId
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(bindingId)
      || typeof dataGeneration !== "number" || !Number.isSafeInteger(dataGeneration) || dataGeneration < 1) return null;
    return Object.freeze({ bindingId, dataGeneration });
  } catch { return null; }
}
const stale = (): ReviewExecuteResult => Object.freeze({ kind: "stale" });
const invalid = (): ReviewExecuteResult => Object.freeze({ kind: "invalid", reason: "REQUEST" });
function objectKey(value: unknown): object | null { return value !== null && typeof value === "object" ? value : null; }

export function createReviewWorkspace(config: ReviewWorkspaceConfig) {
  let settings: ReviewWorkspaceConfig;
  try {
    const raw = fields(config, ["client", "clocks"]);
    const client = fields(raw.client, ["origin", "fetch"], ["timeoutMs"]);
    if (typeof raw.clocks !== "function") throw new Error();
    settings = Object.freeze({ client: Object.freeze(client) as unknown as ReviewWorkspaceConfig["client"],
      clocks: raw.clocks as () => unknown });
  } catch { throw new Error("REVIEW_WORKSPACE_CONFIG_INVALID"); }
  let lastClock: { wall: number; monotonic: number } | null = null;
  function clocks() {
    const { wall, monotonic } = fields(settings.clocks(), ["wall", "monotonic"]);
    if (typeof wall !== "number" || !Number.isSafeInteger(wall) || Object.is(wall, -0)
      || wall < 0 || wall > 253402300799999 || typeof monotonic !== "number" || !Number.isFinite(monotonic)
      || Object.is(monotonic, -0) || monotonic < 0 || monotonic > Number.MAX_SAFE_INTEGER
      || (lastClock && (wall < lastClock.wall || monotonic < lastClock.monotonic))) throw new Error("REVIEW_WORKSPACE_CLOCK_INVALID");
    lastClock = Object.freeze({ wall, monotonic });
    return lastClock;
  }
  let commands: ReturnType<typeof createReviewCommandOwner>;
  try { commands = createReviewCommandOwner({ ...settings.client, now: () => clocks().wall }); }
  catch { throw new Error("REVIEW_WORKSPACE_CONFIG_INVALID"); }
  const preview = createReviewPreviewOwner({ clocks }), list = createReviewedBenefitListOwner();
  let active: View | null = null, snapshot: ReviewWorkspaceSnapshot | null = null;
  let disposed = false, depth = 0, notification = false, flightCount = 0;
  let attempt: { readonly previous: ReviewWorkspaceLease | null } | null = null;
  let records = new WeakMap<object, Record>();
  const issued = new WeakSet<object>(), listeners = new Set<() => void>();
  let pendingPreview: PreviewFlight | null = null, pendingPage: PageFlight | null = null;

  function current(lease: unknown): View | null {
    return !disposed && active?.lease === lease ? active : null;
  }
  function retained(token: object, record: Record) {
    return !disposed && active === record.view && records.get(token) === record;
  }
  function clearView(cancelActivation = true) {
    const old = active;
    active = null; records = new WeakMap(); pendingPreview = null; pendingPage = null;
    if (cancelActivation) attempt = null;
    if (snapshot !== null) { snapshot = null; notification = true; }
    // Composite ownership and visible data disappear BEFORE synchronous aborts.
    if (old) {
      preview.deactivate(old.preview); list.deactivate(old.list); commands.deactivate(old.commands);
    }
  }
  function synchronize() {
    const view = active;
    if (!view) return;
    const p = preview.getSnapshot(), l = list.getSnapshot();
    if (!p || !l || p.lease !== view.preview || l.lease !== view.list) { clearView(); return; }
    if (snapshot?.lease === view.lease && snapshot.preview === p && snapshot.list === l) return;
    snapshot = Object.freeze({ lease: view.lease, context: view.context, preview: p, list: l });
    notification = true;
  }
  function notify() {
    depth++;
    try { for (const listener of [...listeners]) if (listeners.has(listener)) {
      try { listener(); } catch { /* Observers cannot prevent revocation. */ }
    } } finally { depth--; }
  }
  function flush() {
    synchronize();
    while (notification && depth === 0) { notification = false; notify(); synchronize(); }
  }
  function batch<T>(action: () => T): T {
    depth++;
    try { return action(); } finally { depth--; if (depth === 0) flush(); }
  }
  const childChanged = () => { if (depth === 0) batch(() => synchronize()); };
  const detachPreview = preview.subscribe(childChanged), detachList = list.subscribe(childChanged);

  function activate(input: unknown): ReviewWorkspaceLease | null {
    if (disposed || depth > 0) return null;
    const replacing = { previous: active?.lease ?? null };
    attempt = replacing;
    let result: ReviewWorkspaceLease | null = null;
    batch(() => {
      clearView(false);
      if (notification) { notification = false; notify(); }
      if (disposed || attempt !== replacing) return;
      const context = normalizeReviewWorkspaceContext(input);
      if (!context || disposed || attempt !== replacing) return;
      let c: ReviewCommandLease | null = null, p: ReviewPreviewLease | null = null, l: ReviewedBenefitListLease | null = null;
      try {
        c = commands.activate(context.dataGeneration);
        if (!c || disposed || attempt !== replacing) return;
        p = preview.activate(context.dataGeneration);
        if (!p || disposed || attempt !== replacing) return;
        l = list.activate(context.dataGeneration);
        if (!l || disposed || attempt !== replacing) return;
        result = Object.freeze({}) as ReviewWorkspaceLease;
        active = { lease: result, context, commands: c, preview: p, list: l };
        synchronize();
      } finally {
        if (result === null) { if (p) preview.deactivate(p); if (l) list.deactivate(l); if (c) commands.deactivate(c); }
      }
    });
    if (attempt === replacing) attempt = null;
    return result !== null && current(result) !== null ? result : null;
  }
  function deactivate(lease: unknown): void {
    if (disposed || lease === null || lease === undefined
      || (active?.lease !== lease && attempt?.previous !== lease)) return;
    batch(() => clearView());
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    batch(() => { clearView(); commands.dispose(); preview.dispose(); list.dispose(); });
    detachPreview(); detachList(); listeners.clear();
  }
  function prepare(lease: unknown, input: unknown): ReviewPrepareResult {
    if (disposed) return Object.freeze({ kind: "disposed" });
    const view = current(lease);
    if (!view || depth > 0) return Object.freeze({ kind: "inactive" });
    return batch(() => {
      let request: ReviewRequest;
      try { request = snapshotReviewRequest(input); } catch { return Object.freeze({ kind: "invalid" }); }
      if (disposed) return Object.freeze({ kind: "disposed" });
      if (active !== view) return Object.freeze({ kind: "inactive" });
      if (request.action === "list") return Object.freeze({ kind: "invalid" });
      const prepared = commands.prepare(view.commands, request);
      if (prepared.kind === "prepared") {
        records.set(prepared.command, { view, request, running: false, attempted: false });
        issued.add(prepared.command);
      }
      return prepared;
    });
  }
  function stopPreview(view: View) {
    const pending = pendingPreview;
    pendingPreview = null;
    const shown = preview.getSnapshot();
    if (shown) preview.cancel(view.preview, shown);
    synchronize();
    if (pending) { records.delete(pending.command); commands.release(view.commands, pending.command); }
  }
  function stopPage(view: View) {
    const pending = pendingPage;
    pendingPage = null;
    if (pending) {
      list.cancel(view.list, pending.ticket); synchronize();
      commands.release(view.commands, pending.command);
    }
  }
  function authorityFailure(result: ReviewExecuteResult) {
    return result.kind === "error" && ["API_AUTH_REQUIRED", "API_SESSION_CHANGED", "API_REQUEST_REJECTED"].includes(result.code)
      || result.kind === "invalid" && result.reason === "CLOCK";
  }
  async function execute(lease: unknown, input: unknown): Promise<ReviewExecuteResult> {
    const view = current(lease), token = objectKey(input);
    if (!view || depth > 0) return stale();
    if (!token || !issued.has(token)) return invalid();
    const record = records.get(token);
    if (!record || record.view !== view) return stale();
    if (record.running || flightCount >= MAX_REVIEW_PREPARED_COMMANDS) return Object.freeze({ kind: "busy" });
    if (record.attempted && ["preview", "reject"].includes(record.request.action)) return Object.freeze({ kind: "consumed" });
    let ready = true;
    batch(() => {
      if (record.request.action === "preview") {
        stopPreview(view);
        if (!retained(token, record)) { ready = false; return; }
        const shown = preview.getSnapshot(), ticket = shown && preview.begin(view.preview, shown);
        if (!ticket) { synchronize(); ready = false; return; }
        pendingPreview = { command: token as ReviewPreparedCommand, record, ticket };
      }
      record.running = true; record.attempted = true; flightCount++;
    });
    if (!ready) return stale();
    try {
      if (!retained(token, record)) return stale();
      let result = await commands.execute(view.commands, token);
      if (!retained(token, record)) return stale();
      batch(() => {
        if (authorityFailure(result)) { clearView(); return; }
        if (record.request.action === "preview" && pendingPreview?.record === record) {
          const pending = pendingPreview; pendingPreview = null;
          if (result.kind === "success" && result.success.kind === "preview") {
            if (!preview.settle(pending.ticket, result.success.preview)) result = Object.freeze({ kind: "invalid", reason: "ENVELOPE" });
          } else preview.fail(pending.ticket);
        }
        if (result.kind === "success" && result.success.kind === "view") {
          stopPage(view);
          if (retained(token, record)) list.observe(view.list, result.success.view);
        }
        if (result.kind === "success" && (record.request.action === "confirm" || record.request.action === "reject")) {
          const shown = preview.getSnapshot();
          if (shown?.preview?.previewId === record.request.body.previewId) preview.cancel(view.preview, shown);
        }
      });
      // Publication can run slow subscribers. A previously unexpired preview
      // must not be delivered as success after that synchronous boundary.
      if (retained(token, record) && result.kind === "success" && result.success.kind === "preview") {
        const shown = preview.getSnapshot();
        const samePreview = shown?.phase === "ready" && shown.preview?.previewId === result.success.preview.previewId;
        const valid = samePreview && batch(() => preview.checkExpiry(view.preview, shown));
        if (!retained(token, record)) return stale();
        if (!valid) return Object.freeze({ kind: "invalid", reason: "ENVELOPE" });
      }
      return retained(token, record) ? result : stale();
    } finally { record.running = false; flightCount--; }
  }
  function release(lease: unknown, input: unknown): void {
    const view = current(lease), token = objectKey(input), record = token && records.get(token);
    if (!view || !token || !record || record.view !== view) return;
    batch(() => {
      records.delete(token);
      if (pendingPreview?.command === token) {
        pendingPreview = null;
        const shown = preview.getSnapshot(); if (shown) preview.cancel(view.preview, shown);
      }
      synchronize(); commands.release(view.commands, token);
    });
  }
  async function nextPage(lease: unknown): Promise<ReviewWorkspaceNextPageResult> {
    const view = current(lease);
    if (!view || depth > 0) return stale();
    if (pendingPage || flightCount >= MAX_REVIEW_PREPARED_COMMANDS) return Object.freeze({ kind: "unavailable" });
    let pending: PageFlight | null = null;
    batch(() => {
      const shown = list.getSnapshot(), next = shown && list.begin(view.list, shown);
      if (!next || active !== view) return;
      const prepared = commands.prepare(view.commands, createReviewListRequest(next.request.limit, next.request.cursor));
      if (prepared.kind !== "prepared") { list.fail(next.ticket); return; }
      pending = { view, list: view.list, command: prepared.command, ticket: next.ticket };
      pendingPage = pending; flightCount++;
    });
    if (pending === null) return active === view ? Object.freeze({ kind: "unavailable" }) : stale();
    const flight: PageFlight = pending;
    const live = () => !disposed && active === view && view.list === flight.list && pendingPage === flight;
    try {
      if (!live()) return stale();
      let result = await commands.execute(view.commands, flight.command);
      if (!live()) return stale();
      batch(() => {
        pendingPage = null;
        if (authorityFailure(result)) { clearView(); return; }
        if (result.kind === "success" && result.success.kind === "page") {
          if (!list.settle(flight.ticket, result.success.page)) result = Object.freeze({ kind: "invalid", reason: "ENVELOPE" });
        }
        else list.fail(flight.ticket, result.kind === "error" && result.code === "API_CONFLICT" ? "conflict" : "retry");
      });
      return !disposed && active === view && view.list === flight.list ? result : stale();
    } finally { commands.release(view.commands, flight.command); flightCount--; }
  }
  function cancelPreview(lease: unknown, expected: unknown): boolean {
    const view = current(lease);
    if (!view || depth > 0 || preview.getSnapshot() !== expected) return false;
    let changed = false;
    batch(() => {
      const shown = preview.getSnapshot(); changed = shown !== null && shown.phase !== "idle";
      if (changed) stopPreview(view);
    });
    return changed && current(lease) === view;
  }
  function cancelPage(lease: unknown, expected: unknown): boolean {
    const view = current(lease);
    if (!view || depth > 0 || list.getSnapshot() !== expected || !pendingPage) return false;
    batch(() => stopPage(view));
    return current(lease) === view;
  }
  function restartList(lease: unknown, expected: unknown): boolean {
    const view = current(lease);
    if (!view || depth > 0 || list.getSnapshot() !== expected) return false;
    batch(() => {
      const pending = pendingPage; pendingPage = null;
      const replacement = list.activate(view.context.dataGeneration);
      if (!replacement || active !== view) { clearView(); return; }
      view.list = replacement; synchronize();
      if (pending) commands.release(view.commands, pending.command);
    });
    return current(lease) === view;
  }
  function checkExpiry(lease: unknown, expected: unknown): boolean {
    const view = current(lease);
    if (!view || depth > 0 || preview.getSnapshot() !== expected) return false;
    const valid = batch(() => preview.checkExpiry(view.preview, expected));
    return valid && current(lease) === view;
  }
  function subscribe(listener: () => void): () => void {
    if (disposed || typeof listener !== "function") return () => {};
    listeners.add(listener); return () => { listeners.delete(listener); };
  }
  return Object.freeze({ getSnapshot: (): ReviewWorkspaceSnapshot | null => snapshot, subscribe,
    activate, deactivate, dispose, prepare, execute, release, nextPage, cancelPreview, cancelPage, restartList, checkExpiry });
}
export type ReviewWorkspace = ReturnType<typeof createReviewWorkspace>;
// Returned copies cannot be erased. Re-preparing old raw data is a new explicit
// action, not something local tokens can identify as old user intent. Callers
// must still fence DOM/result application and own pagehide/logout/expiry ticks.
