import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SyntheticSignupMailDiscoveryPanel } from "./SyntheticSignupMailDiscoveryPanel";

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><SyntheticSignupMailDiscoveryPanel /></StrictMode>);
