import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

export default defineConfig({
  // Neither donor .env files nor ambient VITE_* provider settings enter this app.
  envDir: false,
  envPrefix: [],
  plugins: [
    tanstackStart({ server: { entry: "server" } }),
    nitro({ preset: "node-server" }),
    react(),
  ],
  server: { host: "127.0.0.1", port: 4317, strictPort: true },
  preview: { host: "127.0.0.1", port: 4317, strictPort: true },
});
