import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { IdentityMapPanel } from "./features/identity-map/IdentityMapPanel";
import { DiscoveryInboxPanel } from "./features/discovery-inbox/DiscoveryInboxPanel";
import { SyntheticSignupMailDiscoveryPanel } from "./features/signup-mail-discovery/SyntheticSignupMailDiscoveryPanel";
import { LocalVaultPanel } from "./features/local-vault/LocalVaultPanel";
import { SyntheticBackupPanel } from "./features/local-vault/SyntheticBackupPanel";
import { readSyntheticView, SyntheticAppShell } from "./ui/shell/SyntheticAppShell";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("KeyAtlas root element was not found.");
}

const view = readSyntheticView(window.location.search);
createRoot(rootElement).render(
  <StrictMode>
    <SyntheticAppShell view={view}>
      {view === "local-vault" ? <LocalVaultPanel />
        : view === "synthetic-backup" ? <SyntheticBackupPanel />
        : view === "identity-map" ? <IdentityMapPanel />
        : view === "discovery-inbox" ? <DiscoveryInboxPanel />
        : view === "signup-mail-discovery" ? <main className="signup-mail-screen"><SyntheticSignupMailDiscoveryPanel /></main>
        : <App />}
    </SyntheticAppShell>
  </StrictMode>,
);
