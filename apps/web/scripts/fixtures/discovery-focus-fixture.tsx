// Test-only synthetic wrapper around the current product. No test API is
// exported from product code; no account, mailbox, vault or persistence opens.
import { StrictMode, Suspense, useEffect, useLayoutEffect, useState, useTransition } from "react";
import { createRoot } from "react-dom/client";
import { DiscoveryInboxPanel } from "../../src/features/discovery-inbox/DiscoveryInboxPanel";
import type { DiscoveryInboxItem } from "../../src/features/discovery-inbox/discoveryInboxModel";
import { SYNTHETIC_DISCOVERY_INBOX_ITEMS as sourceA } from "../../src/features/discovery-inbox/syntheticDiscoveryInboxFixture";

const sourceB = Object.freeze(sourceA.map((item) => Object.freeze({ ...item,
  serviceName: `Replacement ${item.serviceName}`,
})));
const empty: readonly DiscoveryInboxItem[] = Object.freeze([]);
type SourceRequest = { readonly items: readonly DiscoveryInboxItem[]; readonly number: number };
const sourceName = (items: SourceRequest["items"]) => items === sourceA ? "A" : items === sourceB ? "B" : "EMPTY";
let ready = false, sequence = 0, attempts = 0, releases = 0, witnessOverflow = false;
let gate: { number: number; pending: Promise<void>; release: () => void } | null = null;
const commits: Array<{ request: number; source: "A" | "B" | "EMPTY" }> = [];
function nextRequest(items: SourceRequest["items"]): SourceRequest {
  if (sequence >= 256) throw new Error("SYNTHETIC_REQUEST_LIMIT");
  return { items, number: ++sequence };
}
const harness = { ready: () => ready, stats: () => ({ attempts, releases, witnessOverflow,
  commits: commits.map((commit) => ({ ...commit })) }) };
declare global { interface Window { discoveryFocusFixture: typeof harness } }
window.discoveryFocusFixture = harness;

function AfterPanel({ request }: { request: SourceRequest }) {
  // The current product's subtree has already rendered when this sibling is
  // visited. Attempt counts are test witnesses, not product lifecycle state.
  if (gate?.number === request.number) {
    if (attempts < 256) attempts++; else witnessOverflow = true;
    throw gate.pending;
  }
  return null;
}
function CommitMarker({ request }: { request: SourceRequest }) {
  useLayoutEffect(() => {
    if (commits.length < 64) commits.push({ request: request.number, source: sourceName(request.items) });
    else witnessOverflow = true;
  }, [request]);
  return <output id="committed-source">{sourceName(request.items)}</output>;
}
function UrgentProbe() {
  const [count, setCount] = useState(0);
  return <button id="urgent-probe" type="button" onClick={() => setCount((previous) => previous + 1)}>{count}</button>;
}
function Fixture() {
  const [request, setRequest] = useState<SourceRequest>({ items: sourceA, number: 0 });
  const [pending, transition] = useTransition();
  const [label, setLabel] = useState("Synthetic A");
  const [mounted, setMounted] = useState(true);
  const select = (items: SourceRequest["items"]) => setRequest(nextRequest(items));
  const suspendB = () => {
    if (gate) throw new Error("SYNTHETIC_GATE_ALREADY_ACTIVE");
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    const next = nextRequest(sourceB);
    gate = { number: next.number, pending: promise, release };
    transition(() => setRequest(next));
  };
  const release = () => {
    const previous = gate;
    gate = null;
    if (previous) {
      if (releases < 256) releases++; else witnessOverflow = true;
      previous.release();
    }
  };
  useEffect(() => { ready = true; return () => { ready = false; }; }, []);
  return <>
    <section aria-label="Synthetic fixture controls">
      <button id="outside" type="button">Outside control</button>
      <button id="source-a" type="button" onClick={() => select(sourceA)}>Source A</button>
      <button id="source-b" type="button" onClick={() => select(sourceB)}>Source B</button>
      <button id="source-empty" type="button" onClick={() => select(empty)}>Empty</button>
      <button id="source-label" type="button" onClick={() => setLabel("Synthetic label changed")}>Label only</button>
      <button id="unmount" type="button" onClick={() => setMounted(false)}>Unmount panel</button>
      <button id="mount" type="button" onClick={() => setMounted(true)}>Mount panel</button>
      <button id="suspend-b" type="button" onClick={suspendB}>Prepare suspended B</button>
      <button id="cancel-b" type="button" onClick={() => select(sourceA)}>Discard B and keep A</button>
      <button id="release-b" type="button" onClick={release}>Release suspended render</button>
      <output id="transition-pending">{pending ? "pending" : "idle"}</output>
    </section>
    <Suspense fallback={<p id="transition-fallback">Waiting for synthetic B</p>}>
      <UrgentProbe />
      <div id="panel">{mounted && <DiscoveryInboxPanel items={request.items} sourceLabel={label} />}</div>
      <AfterPanel request={request} />
      <CommitMarker request={request} />
    </Suspense>
  </>;
}
const container = document.getElementById("fixture-root");
if (!container) throw new Error("SYNTHETIC_ROOT_MISSING");
createRoot(container).render(<StrictMode><Fixture /></StrictMode>);
