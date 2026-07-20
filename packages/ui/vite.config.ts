import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only config: runs src/main.tsx against index.html so DocsApp can be
// previewed against a real running @vayo/server during development
// (`pnpm dev` from this package). The library build (`vite build` in
// package.json's build script) uses this same config's plugin setup — that
// build's real consumer is @vayo/server, which serves this bundle's
// dist/index.html + dist/assets/* at whatever mountPath the host configured
// (default "/vayo", but user-configurable). `base: "./"` makes every asset
// reference in the built index.html relative to wherever it's actually
// served from, rather than baked in at "/" — the one thing that must be
// true for the same build to work under any mountPath.
export default defineConfig({
  plugins: [react()],
  base: "./",
  // A SEPARATE output directory from tsc's `dist/` (package.json's
  // main/types) — vite build's default emptyOutDir would otherwise wipe
  // out the library build every time, which is exactly backwards: a host
  // app importing <DocsApp> directly needs dist/index.js to keep existing
  // after `pnpm build`, and @vayo/server (the standalone-bundle consumer)
  // reads from this directory specifically, never from dist/.
  build: { outDir: "dist-app" },
  server: { port: 5173 },
});
