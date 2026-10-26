/** Test-only non-cooperative completion ports. No HTTP, clocks, timers or real
 * data. Abort is observed but deliberately does not settle the pending Promise.
 * Keep one probe across StrictMode effect replay; it has no disposal side effect. */
export type CompletionProbePort = "A" | "B";
export interface CompletionProbeRequest {
  readonly id: number;
  readonly port: CompletionProbePort;
  readonly aborted: boolean;
  readonly settled: boolean;
}
export interface CompletionProbeSnapshot {
  readonly callsA: number;
  readonly callsB: number;
  readonly requests: readonly CompletionProbeRequest[];
  readonly payloadInspections: number;
}
interface RequestState {
  id: number;
  port: CompletionProbePort;
  aborted: boolean;
  settled: boolean;
}
interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly detach: () => void;
}

export function createCompletionPortProbe() {
  let sequence = 0, callsA = 0, callsB = 0, payloadInspections = 0;
  const requests = new Map<number, RequestState>();
  const pending = new Map<number, Pending>();

  function read(port: CompletionProbePort, signal: AbortSignal): Promise<unknown> {
    if (sequence === Number.MAX_SAFE_INTEGER) return Promise.reject(Error("SYNTHETIC_PROBE_CAPACITY"));
    const id = ++sequence;
    if (port === "A") callsA++; else callsB++;
    const row: RequestState = { id, port, aborted: signal.aborted, settled: false };
    requests.set(id, row);
    return new Promise<unknown>((resolve, reject) => {
      const observeAbort = () => { row.aborted = true; };
      signal.addEventListener("abort", observeAbort, { once: true });
      if (signal.aborted) observeAbort();
      pending.set(id, { resolve, reject,
        detach: () => signal.removeEventListener("abort", observeAbort) });
    });
  }
  // These function identities are stable for this probe's entire lifetime.
  const readA = (signal: AbortSignal): Promise<unknown> => read("A", signal);
  const readB = (signal: AbortSignal): Promise<unknown> => read("B", signal);

  function receipt(row: RequestState) {
    return Object.freeze({ schema: "keyatlas.candidate-batch-saved.v1", state: "saved",
      batchReference: `synthetic-port-${row.port}-${row.id}`, dataGeneration: 1 });
  }
  function finish(id: number, outcome: "resolve" | "reject" | "poison"): boolean {
    if (!Number.isSafeInteger(id) || id < 1) return false;
    const row = requests.get(id), task = pending.get(id);
    if (!row || !task || row.settled) return false;
    row.settled = true;
    pending.delete(id);
    task.detach();
    if (outcome === "reject") task.reject(Error("SYNTHETIC_PROBE_REJECTED"));
    else if (outcome === "poison") {
      // The current strict decoder first reflects on the object's prototype.
      // Count that boundary directly, not a getter it intentionally never calls.
      // This observable Proxy is a test instrument, not a sandbox claim.
      task.resolve(new Proxy(receipt(row), { getPrototypeOf() {
        payloadInspections++;
        throw Error("SYNTHETIC_PROBE_INSPECTED");
      } }));
    } else task.resolve(receipt(row));
    return true;
  }
  function snapshot(): CompletionProbeSnapshot {
    return Object.freeze({ callsA, callsB, payloadInspections,
      requests: Object.freeze([...requests.values()].map((row) => Object.freeze({ ...row }))) });
  }
  return Object.freeze({ readA, readB, snapshot,
    settle(id: number, outcome: "resolve" | "reject"): boolean {
      return (outcome === "resolve" || outcome === "reject") && finish(id, outcome);
    },
    settlePoison: (id: number): boolean => finish(id, "poison"),
  });
}
