/** Local selection of explicit observed candidate/service IDs. No authentication,
 * automatic matching, I/O, persistence, ambient clock reads or operation ID generation. */
import { decodeCandidateBatchDisplay, type CandidateDisplay } from "./candidate-batch-view.ts";
import { decodeCatalogSuccess, type CatalogServiceView } from "./catalog-client/responses.ts";
import { normalizeReviewWorkspaceContext } from "./review-client/workspace.ts";
import { createReviewPreviewRequest, type ReviewPreviewRequest } from "./review-client/requests.ts";

export const MAX_CANDIDATE_SELECTION_IDS = 1000;
export interface CandidateSelectionSnapshot {
  readonly status: "empty" | "ready" | "invalid" | "conflict" | "capacity";
  readonly candidates: readonly CandidateDisplay[];
  readonly services: readonly CatalogServiceView[];
}
export type CandidateSelectionBuildResult = Readonly<{ kind: "ready"; draft: Readonly<{
  bindingId: string; dataGeneration: number; request: ReviewPreviewRequest;
}> }> | Readonly<{ kind: "needs-name" | "unavailable" | "invalid" }>;
export interface CandidateSelection {
  observe(input: unknown, time: unknown): CandidateSelectionSnapshot;
  getSnapshot(): CandidateSelectionSnapshot;
  check(time: unknown): CandidateSelectionSnapshot;
  build(candidateId: unknown, serviceId: unknown, name: unknown, time: unknown): CandidateSelectionBuildResult;
}
interface Time { readonly wall: number; readonly monotonic: number }
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(input), names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some((key) => typeof key !== "string" || !keys.includes(key))) throw new Error();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const field = descriptors[key];
    if (!field || !field.enumerable || !Object.hasOwn(field, "value")) throw new Error();
    result[key] = field.value as unknown;
  }
  return result;
}
function array(input: unknown): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) throw new Error();
  const size = Object.getOwnPropertyDescriptor(input, "length"), length: unknown = size?.value;
  if (!size || !Object.hasOwn(size, "value") || typeof length !== "number" || !Number.isSafeInteger(length)
    || length < 0 || length > MAX_CANDIDATE_SELECTION_IDS) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(input as object);
  if (Reflect.ownKeys(descriptors).length !== length + 1) throw new Error();
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const field = descriptors[String(index)];
    if (!field || !field.enumerable || !Object.hasOwn(field, "value")) throw new Error();
    result.push(field.value as unknown);
  }
  return result;
}
function identifier(input: unknown): input is string {
  return typeof input === "string" && input.trim() === input && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input);
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const sameRows = (left: readonly unknown[], right: readonly unknown[]) => left.length === right.length && left.every((row, index) => row === right[index]);

export function createCandidateSelection(input: unknown): CandidateSelection | null {
  const parsedContext = normalizeReviewWorkspaceContext(input);
  if (!parsedContext) return null;
  const context = parsedContext;
  let candidates = new Map<string, CandidateDisplay>(), services = new Map<string, CatalogServiceView>();
  let snapshot: CandidateSelectionSnapshot = Object.freeze({ status: "empty", candidates: Object.freeze([]), services: Object.freeze([]) });
  let closed = false, busy = false, last: Time | null = null, anchor: Time | null = null;
  function publish(status: CandidateSelectionSnapshot["status"], selected: readonly CandidateDisplay[] = [], catalog: readonly CatalogServiceView[] = []) {
    if (snapshot.status !== status || !sameRows(snapshot.candidates, selected) || !sameRows(snapshot.services, catalog)) {
      snapshot = Object.freeze({ status, candidates: Object.freeze([...selected]), services: Object.freeze([...catalog]) });
    }
    return snapshot;
  }
  function close(status: "invalid" | "conflict" | "capacity") {
    closed = true; candidates.clear(); services.clear(); last = null; anchor = null;
    return publish(status);
  }
  function clock(inputTime: unknown): Time | null {
    try {
      const { wall, monotonic } = fields(inputTime, ["wall", "monotonic"]);
      if (typeof wall !== "number" || !Number.isSafeInteger(wall) || Object.is(wall, -0) || wall < 0 || wall > 253402300799999
        || typeof monotonic !== "number" || !Number.isFinite(monotonic) || Object.is(monotonic, -0)
        || monotonic < 0 || monotonic > Number.MAX_SAFE_INTEGER
        || (last && (wall < last.wall || monotonic < last.monotonic))) throw new Error();
      const time = Object.freeze({ wall, monotonic });
      // Keep the strongest wall+elapsed trajectory. A stalled wall clock cannot
      // restart the lifetime; a forward wall jump cannot later be forgotten.
      if (!anchor || wall - anchor.wall > monotonic - anchor.monotonic) anchor = time;
      last = time; return time;
    } catch { close("invalid"); return null; }
  }
  function expired(row: CandidateDisplay, time: Time) {
    return time.wall >= row.accessExpiresAt || (anchor !== null
      && time.monotonic - anchor.monotonic >= row.accessExpiresAt - anchor.wall);
  }
  function expire(time: Time) {
    for (const [id, row] of candidates) if (row.state === "pending" && expired(row, time)) {
      candidates.set(id, Object.freeze({ candidateId: row.candidateId, candidateRevision: row.candidateRevision,
        accessExpiresAt: row.accessExpiresAt, state: "expired", content: null }));
    }
    if (snapshot.status === "ready") publish("ready", snapshot.candidates.map((row) => candidates.get(row.candidateId)!), snapshot.services);
  }
  function mergeCandidate(previous: CandidateDisplay | undefined, incoming: CandidateDisplay): CandidateDisplay {
    if (!previous) return incoming;
    if (previous.accessExpiresAt !== incoming.accessExpiresAt) throw new Error();
    if (incoming.candidateRevision < previous.candidateRevision) return previous;
    if (incoming.candidateRevision === previous.candidateRevision) {
      if (previous.state === "expired" && incoming.state === "pending") return previous;
      if (previous.state === "pending" && incoming.state === "expired") return incoming;
      if (!same(previous, incoming)) throw new Error();
      return previous;
    }
    if (previous.state === "deleted" || (previous.state === "accepted" && incoming.state !== "deleted")
      || (previous.state === "expired" && incoming.state === "pending")) return previous;
    return incoming;
  }
  function mergeService(previous: CatalogServiceView | undefined, incoming: CatalogServiceView): CatalogServiceView {
    if (!previous) return incoming;
    if (incoming.serviceRevision < previous.serviceRevision) return previous;
    if (incoming.serviceRevision === previous.serviceRevision) {
      if (!same(previous, incoming)) throw new Error();
      return previous;
    }
    return previous.state === "deleted" && incoming.state === "live" ? previous : incoming;
  }
  function observe(envelope: unknown, inputTime: unknown): CandidateSelectionSnapshot {
    if (closed || busy) return snapshot;
    busy = true;
    try {
      const raw = fields(envelope, ["bindingId", "dataGeneration", "batch", "services"]);
      // No batch/service/time inspection until both primitive scope fields match.
      if (raw.bindingId !== context.bindingId || raw.dataGeneration !== context.dataGeneration) return publish("invalid");
      const time = clock(inputTime); if (!time) return snapshot;
      expire(time);
      const batch = decodeCandidateBatchDisplay(raw.batch);
      if (!batch || batch.dataGeneration !== context.dataGeneration) return publish("invalid");
      const incomingServices: CatalogServiceView[] = [], seen = new Set<string>();
      for (const inputService of array(raw.services)) {
        const decoded = decodeCatalogSuccess("get", inputService);
        if (!decoded || decoded.kind !== "view" || decoded.view.dataGeneration !== context.dataGeneration
          || seen.has(decoded.view.serviceId)) return publish("invalid");
        seen.add(decoded.view.serviceId); incomingServices.push(decoded.view);
      }
      const additions = batch.candidates.filter((row) => !candidates.has(row.candidateId)).length
        + incomingServices.filter((row) => !services.has(row.serviceId)).length;
      if (candidates.size + services.size + additions > MAX_CANDIDATE_SELECTION_IDS) return close("capacity");
      const nextCandidates = new Map(candidates), nextServices = new Map(services);
      try {
        for (const row of batch.candidates) nextCandidates.set(row.candidateId, mergeCandidate(candidates.get(row.candidateId), row));
        for (const row of incomingServices) nextServices.set(row.serviceId, mergeService(services.get(row.serviceId), row));
      } catch { return close("conflict"); }
      candidates = nextCandidates; services = nextServices; expire(time);
      return publish("ready", batch.candidates.map((row) => candidates.get(row.candidateId)!),
        incomingServices.map((row) => services.get(row.serviceId)!));
    } catch { return publish("invalid"); }
    finally { busy = false; }
  }
  function check(inputTime: unknown): CandidateSelectionSnapshot {
    if (closed || busy) return snapshot;
    busy = true;
    try { const time = clock(inputTime); if (time) expire(time); return snapshot; }
    finally { busy = false; }
  }
  function build(candidateId: unknown, serviceId: unknown, name: unknown, inputTime: unknown): CandidateSelectionBuildResult {
    if (closed || busy) return Object.freeze({ kind: "unavailable" });
    busy = true;
    try {
      const time = clock(inputTime); if (!time) return Object.freeze({ kind: "unavailable" });
      expire(time);
      if (snapshot.status !== "ready") return Object.freeze({ kind: "unavailable" });
      if (!identifier(candidateId) || !identifier(serviceId)) return Object.freeze({ kind: "invalid" });
      const candidate = snapshot.candidates.find((row) => row.candidateId === candidateId);
      const service = snapshot.services.find((row) => row.serviceId === serviceId);
      if (!candidate || candidate.state !== "pending" || !service || service.state !== "live") return Object.freeze({ kind: "unavailable" });
      const chosenName = name === null ? candidate.content.values.name : name;
      if (chosenName === null) return Object.freeze({ kind: "needs-name" });
      const request = createReviewPreviewRequest(candidate.candidateId, candidate.candidateRevision, service.serviceId,
        service.serviceRevision, { ...candidate.content.values, name: chosenName });
      return Object.freeze({ kind: "ready", draft: Object.freeze({ ...context, request }) });
    } catch { return Object.freeze({ kind: "invalid" }); }
    finally { busy = false; }
  }
  return Object.freeze({ observe, getSnapshot: () => snapshot, check, build });
}
// Fences are bounded across observations, but display contains only the current
// envelope's IDs. Absence is not deletion. Returned copies cannot be erased;
// hosts must discard this entire owner on every fresh workspace lease.
