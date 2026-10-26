import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** 파일 하나로 묶는 빌드 — 더블클릭으로 열리는 미리보기용. 폰트까지 data: URI로 넣는다. */
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist-single", sourcemap: false, assetsInlineLimit: 100_000_000, cssCodeSplit: false },
});
