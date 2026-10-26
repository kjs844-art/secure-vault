// Synthetic-only browser fixture, not a product route or provider adapter.
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { SyntheticSignupMailDiscoveryPanel } from "../../src/features/signup-mail-discovery/SyntheticSignupMailDiscoveryPanel";

const container = document.getElementById("fixture-root");
if (!container) throw new Error("Missing synthetic fixture root");
let root = createRoot(container);
let ready = false;
const marker = `${Date.now()}-${Math.random()}`;
const events: { type: string; persisted: boolean; trusted: boolean; empty: boolean }[] = [];
const empty = () => document.querySelector("[data-testid='discovery-inbox-item']") === null
  && !document.querySelector(".signup-mail-card")
  && !document.querySelector("[data-testid='discovery-filter-confirmed']");

function Fixture() {
  useEffect(() => {
    // Child effects install the real cleanup before this event-time observer.
    const observe = (event: PageTransitionEvent) => events.push({
      type: event.type, persisted: event.persisted, trusted: event.isTrusted, empty: empty(),
    });
    window.addEventListener("pagehide", observe);
    window.addEventListener("pageshow", observe);
    ready = true;
    return () => {
      ready = false;
      window.removeEventListener("pagehide", observe);
      window.removeEventListener("pageshow", observe);
    };
  }, []);
  return <SyntheticSignupMailDiscoveryPanel />;
}

function mount() { root.render(<StrictMode><Fixture /></StrictMode>); }
const api = {
  ready: () => ready,
  stats: () => ({ marker, events: [...events], empty: empty() }),
  unmount: () => root.unmount(),
  mount: () => { root = createRoot(container); mount(); },
};
declare global { interface Window { signupReviewHarness: typeof api } }
window.signupReviewHarness = api;
mount();
