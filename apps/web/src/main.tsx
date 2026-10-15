import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { IdentityMapPanel } from "./features/identity-map/IdentityMapPanel";
import { LocalVaultPanel } from "./features/local-vault/LocalVaultPanel";
import { SyntheticBackupPanel } from "./features/local-vault/SyntheticBackupPanel";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("KeyAtlas root element was not found.");
}

const view = new URLSearchParams(window.location.search).get("view");
createRoot(rootElement).render(
  <StrictMode>
    {view === "local-vault" ? <LocalVaultPanel />
      : view === "synthetic-backup" ? <SyntheticBackupPanel />
      : view === "identity-map" ? <IdentityMapPanel /> : <App />}
  </StrictMode>,
);
