/** Test-only passive read-signal observation. This never reads bodies, replaces
 * a Request/signal, observes Promise settlement, or aborts a transport. A record
 * describes the supplied signal only, not network success or cancellation cause. */
export type ReadTransportRoute = "/api/catalog/list" | "/api/inbox/batch";
export interface ReadTransportObservation {
  readonly ordinal: number;
  readonly route: ReadTransportRoute;
  readonly initiallyAborted: boolean;
  readonly abortObserved: boolean;
  readonly abortEvents: number;
  readonly observationActive: boolean;
}
export interface ReadTransportSnapshot {
  readonly total: number;
  readonly dropped: number;
  readonly records: readonly ReadTransportObservation[];
}
type Observation = { -readonly [K in keyof ReadTransportObservation]: ReadTransportObservation[K] };
interface Entry {
  readonly record: Observation;
  detach?: () => void;
}
type Transport = (request: Request, signal: AbortSignal) => Promise<Response>;
const MAX_RECORDS = 256;

export function createReadTransportProbe(origin: string, transport: Transport) {
  const trustedOrigin = new URL(origin).origin;
  const records: Entry[] = [];
  let total = 0, dropped = 0;

  function fetch(request: Request, signal: AbortSignal): Promise<Response> {
    const route: ReadTransportRoute | null = request.method !== "POST" ? null
      : request.url === `${trustedOrigin}/api/catalog/list` ? "/api/catalog/list"
      : request.url === `${trustedOrigin}/api/inbox/batch` ? "/api/inbox/batch" : null;
    if (route !== null) {
      if (records.length === MAX_RECORDS) {
        records.shift()!.detach?.();
        dropped++;
      }
      const record: Observation = { ordinal: ++total, route,
        initiallyAborted: signal.aborted, abortObserved: false, abortEvents: 0,
        observationActive: !signal.aborted };
      const entry: Entry = { record };
      records.push(entry);
      if (record.observationActive) {
        const observeAbort = () => {
          record.abortObserved = true;
          record.abortEvents++;
          entry.detach?.();
        };
        entry.detach = () => {
          signal.removeEventListener("abort", observeAbort);
          record.observationActive = false;
          delete entry.detach;
        };
        signal.addEventListener("abort", observeAbort, { once: true });
      }
    }
    // Deliberately not async and no .then/.catch/.finally: exact Promise,
    // synchronous throw, Request, AbortSignal and native streams are preserved.
    return transport(request, signal);
  }
  function snapshot(): ReadTransportSnapshot {
    return Object.freeze({ total, dropped,
      records: Object.freeze(records.map(({ record }) => Object.freeze({ ...record }))) });
  }
  function detach(): void {
    for (const entry of records) entry.detach?.();
    // Not a sticky disposal: subsequent StrictMode setup may reuse this probe.
    // Old detached entries cannot claim to observe a later abort.
  }
  return Object.freeze({ fetch, snapshot, detach });
}
