import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { LocalVaultPanel } from "./features/local-vault/LocalVaultPanel";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("KeyAtlas root element was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).get("view") === "local-vault"
      ? <LocalVaultPanel /> : <App />}
  </StrictMode>,
);
