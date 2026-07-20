// Entry point for the STANDALONE bundle @vayo/server serves at runtime
// (dist/index.html + dist/assets/*, built by `vite build`, not the library
// entry in src/index.ts) — as distinct from a host app importing <DocsApp>
// directly into its own bundle. Also doubles as the dev-preview entry for
// `pnpm dev` against a real running @vayo/server on localhost.
//
// A static bundle can't know its own deployment's origin or mountPath at
// build time (mountPath is a runtime ServerOptions choice, and the same
// build is meant to work unmodified wherever it's served) — so @vayo/server
// injects `window.__VAYO_MOUNT_PATH__` into the index.html it serves
// (see packages/server/src/index.ts's static-serving setup) before this
// script ever runs. Falls back to the existing hardcoded dev-server values
// when that global isn't present, i.e. exactly today's `pnpm dev` behavior.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DocsApp } from "./DocsApp.js";

declare global {
  interface Window {
    __VAYO_MOUNT_PATH__?: string;
  }
}

const mountPath = window.__VAYO_MOUNT_PATH__;
const apiBaseUrl = mountPath ? `${window.location.origin}${mountPath}` : "http://localhost:4100/vayo";
const socketUrl = mountPath ? window.location.origin : "http://localhost:4100";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

createRoot(container).render(
  <StrictMode>
    <DocsApp apiBaseUrl={apiBaseUrl} socketUrl={socketUrl} />
  </StrictMode>,
);
