// Test-only host for the actual product composition. It does not implement the
// picker, editor, preview, decision or retry. No production inbox route exists.
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { hydrateRoot } from "react-dom/client";
import { DeliveredCandidateReviewWorkspace } from "../../src/components/review-workspace/DeliveredCandidateReviewWorkspace.tsx";
import { createReviewWorkspace, type ReviewWorkspaceContext } from "../../src/domain/review-client/workspace.ts";
import { createCompletionPortProbe } from "./completion-port-probe.ts";
import { createReadTransportProbe } from "./read-transport-probe.ts";

declare global { interface Window {
  candidateCompletionProbe?: ReturnType<typeof createCompletionPortProbe>;
  candidateReadTransportSnapshot?: ReturnType<typeof createReadTransportProbe>["snapshot"];
} }

const clocks = () => ({ wall: Date.now(), monotonic: performance.now() });
export function CandidateReviewFixture({ origin }: { origin: string }) {
  const [readTransportProbe] = useState(() => createReadTransportProbe(origin,
    (request: Request, signal: AbortSignal) => window.fetch(request, { signal })));
  const [client, setClient] = useState(() => Object.freeze({ origin, fetch: readTransportProbe.fetch }));
  useEffect(() => {
    window.candidateReadTransportSnapshot = readTransportProbe.snapshot;
    return () => {
      readTransportProbe.detach();
      if (window.candidateReadTransportSnapshot === readTransportProbe.snapshot) delete window.candidateReadTransportSnapshot;
    };
  }, [readTransportProbe]);
  // Test-only observation endpoint returns an already completed real synthetic
  // run's minimal receipt. It cannot restart analysis or consume quota.
  const [readCompletion] = useState(() => async (signal: AbortSignal): Promise<unknown> => {
    const response = await window.fetch(new Request(origin + "/__candidate_completion", { method: "POST",
      headers: { "content-type": "application/json", "x-keyatlas-request": "synthetic-completion-observation" },
      body: "{}", credentials: "same-origin", cache: "no-store", redirect: "error" }), { signal });
    if (!response.ok || !response.headers.get("cache-control")?.includes("no-store")) throw Error("COMPLETION_UNCONFIRMED");
    return response.json();
  });
  // Explicit test-only ports can ignore AbortSignal and settle late. Normal
  // scenarios keep the real loopback completion transport above. No product
  // owner/receipt/lifecycle logic is implemented or replaced by this probe.
  const [completionProbe] = useState(createCompletionPortProbe);
  const [completionPort, setCompletionPort] = useState<"live" | "A" | "B">("live");
  useEffect(() => {
    window.candidateCompletionProbe = completionProbe;
    return () => {
      if (window.candidateCompletionProbe === completionProbe) delete window.candidateCompletionProbe;
    };
  }, [completionProbe]);
  const selectedCompletionPort = completionPort === "A" ? completionProbe.readA
    : completionPort === "B" ? completionProbe.readB : readCompletion;
  const [workspace] = useState(() => createReviewWorkspace({ client: { origin,
    fetch: (request, signal) => window.fetch(request, { signal }) }, clocks }));
  const [context, setContext] = useState<ReviewWorkspaceContext | null>(null);
  const [reference, setReference] = useState(0), [hydrated, setHydrated] = useState(false), [loads, setLoads] = useState(0);
  const serial = useRef(0);
  const hostNode = useRef<HTMLElement | null>(null), effects = useRef({ setups: 0, cleanups: 0 });
  useEffect(() => {
    const publish = () => {
      if (!hostNode.current) return;
      hostNode.current.dataset.effectSetups = String(effects.current.setups);
      hostNode.current.dataset.effectCleanups = String(effects.current.cleanups);
    };
    effects.current.setups++; publish(); setHydrated(true);
    return () => { effects.current.cleanups++; publish(); };
  }, []);
  const close = () => {
    const active = workspace.getSnapshot(); if (active) workspace.deactivate(active.lease);
    setContext(null);
  };
  function open() {
    close();
    setContext(Object.freeze({ bindingId: `synthetic-candidate-view-${++serial.current}`, dataGeneration: 1 }));
    setReference(Date.now()); setLoads((count) => count + 1);
  }
  return <main ref={hostNode} data-testid="candidate-host" data-hydrated={hydrated ? "yes" : "no"} data-loads={loads}
    data-completion-port={completionPort}>
    <h1>Public synthetic candidate selection integration</h1>
    <p>REAL_SECRET_GATE=CLOSED. No real Gmail, login, database or public inbox route.</p>
    <button onClick={open}>Open</button>
    <button onClick={() => { setClient((previous) => Object.freeze({ ...previous })); }}>Replace test transport</button>
    <button onClick={() => setCompletionPort("A")}>Use controlled completion A</button>
    <button onClick={() => setCompletionPort("B")}>Use controlled completion B</button>
    <button onClick={() => setCompletionPort("live")}>Use live test completion</button>
    <button onClick={close}>Close</button><a href="/__candidate_away.html">Leave document</a>
    <DeliveredCandidateReviewWorkspace workspace={workspace} context={context} referenceTime={reference}
      client={client} readCompletion={selectedCompletionPort}
      clocks={clocks} createOperationId={() => `synthetic-candidate-operation-${++serial.current}`} />
  </main>;
}
// Hydration is not a fresh placement in the installed React runtime. An explicit
// keyed mount exercises real development StrictMode setup/cleanup replay for the
// whole product composition, rather than fabricating lifecycle calls or counters.
export function CandidateReviewHarness({ origin }: { origin: string }) {
  const [epoch, setEpoch] = useState(0);
  return <>
    <button onClick={() => setEpoch((value) => value + 1)}>Remount test host</button>
    <CandidateReviewFixture key={epoch} origin={origin} />
  </>;
}
if (typeof document !== "undefined") {
  const target = document.getElementById("fixture-root"); if (!target) throw new Error("CANDIDATE_FIXTURE_ROOT_MISSING");
  hydrateRoot(target, <React.StrictMode><CandidateReviewHarness origin={location.origin} /></React.StrictMode>);
}
