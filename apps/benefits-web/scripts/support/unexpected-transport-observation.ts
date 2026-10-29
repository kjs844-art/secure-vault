// Test-runner diagnostics only. This module does not classify an abort as
// expected, change a failure counter, read response bodies or retain Requests.
import type { ReadTransportObservation } from "../fixtures/read-transport-probe.ts";
export interface ReadHelperTrace {
  helper: "reload" | "nextCatalog";
  ordinal: number;
  expectedPhase: "ready" | "more" | "end_observed";
  requestCount: number;
  wireDelta: number;
  loadedPhaseObserved: boolean;
  oneSuccessfulWireObserved: boolean;
  helperCompleted: boolean;
  /** Later browser-realm signal snapshot, not a failure-event timestamp. */
  transportAtHelperCompletion: ReadTransportObservation | null;
}

interface RequestObservation {
  url(): string;
  method(): string;
  failure(): { errorText: string } | null;
}
interface ObservationContext {
  /** Fixed runner label, never provider or response content. */
  readonly stage: string;
  readonly origin: string;
  readonly requestStages: WeakMap<object, string>;
  readonly responseStatuses: WeakMap<object, number>;
  readonly requestReadHelpers: WeakMap<object, ReadHelperTrace>;
}
const ROUTES = ["/__candidate_completion", "/api/inbox/batch", "/api/inbox/discard", "/api/catalog/list", "/api/catalog/create", "/api/catalog/update", "/api/catalog/delete",
  "/api/review/preview", "/api/review/confirm", "/api/review/reject", "/api/review/delete", "/api/review/get", "/api/review/list"] as const;

export function observeUnexpectedTransport(request: RequestObservation, context: ObservationContext) {
  const trace = context.requestReadHelpers.get(request) ?? null;
  const url = request.url(), method = request.method();
  return Object.freeze({
    stage: context.stage,
    startedStage: context.requestStages.get(request) ?? "unknown",
    observedResponseStatus: context.responseStatuses.get(request) ?? null,
    helperCompletedAtFailure: trace?.helperCompleted ?? null,
    loadedPhaseObservedAtFailure: trace?.loadedPhaseObserved ?? null,
    // The event-time fields above never change. This bounded, static helper
    // trace deliberately retains later completion observations; not causality.
    readHelper: trace,
    route: ROUTES.find((route) => url === context.origin + route) ?? "other",
    method: method === "GET" || method === "POST" ? method : "other",
    failure: request.failure()?.errorText === "net::ERR_ABORTED" ? "net::ERR_ABORTED" : "other",
  });
}
