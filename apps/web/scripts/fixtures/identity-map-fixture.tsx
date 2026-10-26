// Synthetic browser fixture: current product component, no vault or provider API.
import { StrictMode, Suspense, useEffect, useLayoutEffect, useState, useTransition } from "react";
import { createRoot } from "react-dom/client";
import type { LocalCatalogEntryV1 } from "../../src/bridge/catalogProtocol";
import { IdentityMapPanel } from "../../src/features/identity-map/IdentityMapPanel";
import { SYNTHETIC_IDENTITY_MAP_ENTRIES as sourceA } from "../../src/features/identity-map/syntheticIdentityMapFixture";

type Entries = readonly LocalCatalogEntryV1[];
type Request = { readonly entries: Entries; readonly number: number };
const sourceB: Entries = Object.freeze(sourceA.map((entry) => Object.freeze({ ...entry,
  providerName: `Replacement ${entry.providerName}`, itemName: `Replacement ${entry.itemName}`,
})));
const empty: Entries = Object.freeze([]);
function row(reference: number, providerName: string, account: string | null, itemName: string): LocalCatalogEntryV1 {
  return Object.freeze({ reference, providerName, issuerAccountIdentifier: account, itemName,
    issuerOrganizationOrWorkspace: null, issuerProject: null, issuerEnvironment: null,
    credentialType: "api_key", status: "active", secretFieldCount: 1, connectionCount: 1, mcpConnectionCount: 1,
    connections: Object.freeze([Object.freeze({ label: `${itemName} MCP`, consumerType: "mcp_server" as const })]),
  });
}
const missingEmpty: Entries = Object.freeze([
  row(0, "Example Pair", null, "Synthetic missing issuer"),
  row(1, "Example Pair", "", "Synthetic empty issuer"),
]);
const delimiter: Entries = Object.freeze([
  row(0, "Example\0Provider", "demo", "Synthetic first issuer"),
  row(1, "Example", "Provider\0demo", "Synthetic second issuer"),
]);
let ready = false, sequence = 0, suspendedAttempts = 0, releasedGates = 0;
let gate: { number: number; pending: Promise<void>; release: () => void } | null = null;
const commits: Array<{ request: number; source: "A" | "B" | "other" }> = [];
const sourceName = (entries: Entries) => entries === sourceA ? "A" : entries === sourceB ? "B" : "other";
const harness = { ready: () => ready, stats: () => ({ suspendedAttempts, releasedGates,
  commits: commits.map((commit) => ({ ...commit })) }) };
declare global { interface Window { identityMapFixture: typeof harness } }
window.identityMapFixture = harness;

function AfterPanel({ request }: { request: Request }) {
  // This sibling is reached AFTER the actual panel renders. Its test-only
  // counter proves an attempted B render; a commit marker proves publication.
  if (gate?.number === request.number) { suspendedAttempts++; throw gate.pending; }
  return null;
}
function CommitMarker({ request }: { request: Request }) {
  useLayoutEffect(() => {
    commits.push({ request: request.number, source: sourceName(request.entries) });
  }, [request]);
  return <output id="committed-source">{sourceName(request.entries)}</output>;
}
function UrgentProbe() {
  const [count, setCount] = useState(0);
  return <button id="urgent-probe" type="button" onClick={() => setCount((previous) => previous + 1)}>{count}</button>;
}
function Fixture() {
  const [request, setRequest] = useState<Request>({ entries: sourceA, number: 0 });
  const [pending, transition] = useTransition();
  const [label, setLabel] = useState("Synthetic A"), [mounted, setMounted] = useState(true);
  const select = (entries: Entries) => setRequest({ entries, number: ++sequence });
  const suspendB = () => {
    if (gate) throw new Error("SYNTHETIC_GATE_ALREADY_ACTIVE");
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    const number = ++sequence;
    gate = { number, pending: promise, release };
    transition(() => setRequest({ entries: sourceB, number }));
  };
  const release = () => {
    const previous = gate;
    gate = null;
    if (previous) { releasedGates++; previous.release(); }
  };
  useEffect(() => { ready = true; return () => { ready = false; }; }, []);
  return <main>
    <div id="fixture-controls">
      <button id="outside" type="button">Outside control</button>
      <button id="source-a" type="button" onClick={() => select(sourceA)}>Source A</button>
      <button id="source-b" type="button" onClick={() => select(sourceB)}>Source B</button>
      <button id="source-empty" type="button" onClick={() => select(empty)}>Empty</button>
      <button id="source-label" type="button" onClick={() => setLabel("Synthetic label changed")}>Label only</button>
      <button id="source-missing-empty" type="button" onClick={() => select(missingEmpty)}>Null / empty</button>
      <button id="source-delimiter" type="button" onClick={() => select(delimiter)}>Delimiter pairs</button>
      <button id="unmount-left" type="button" onClick={() => setMounted(false)}>Unmount left</button>
      <button id="mount-left" type="button" onClick={() => setMounted(true)}>Mount left</button>
      <button id="suspend-b" type="button" onClick={suspendB}>Prepare suspended B</button>
      <button id="cancel-b" type="button" onClick={() => select(sourceA)}>Discard B and keep A</button>
      <button id="release-b" type="button" onClick={release}>Release suspended render</button>
      <output id="transition-pending">{pending ? "pending" : "idle"}</output>
    </div>
    <Suspense fallback={<p id="transition-fallback">Waiting for synthetic B</p>}>
      <div id="left-panel">
        <UrgentProbe />
        {mounted && <IdentityMapPanel embedded entries={request.entries} sourceLabel={label} />}
        <AfterPanel request={request} />
        <CommitMarker request={request} />
      </div>
    </Suspense>
    <div id="right-panel"><IdentityMapPanel embedded entries={sourceA} sourceLabel="Synthetic independent panel" /></div>
  </main>;
}
const root = document.getElementById("fixture-root");
if (!root) throw new Error("SYNTHETIC_ROOT_MISSING");
createRoot(root).render(<StrictMode><Fixture /></StrictMode>);
