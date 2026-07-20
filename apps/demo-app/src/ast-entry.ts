// apps/demo-app/src/ast-entry.ts — the adapter `@vayo/ast`'s scanProject
// points at (VayoConfig.appEntryPath, docs/04-capture-engine.md Step 2 #1).
// Exports the plain, already-configured app with no Vayo middleware mounted.

import { createApp } from "./app.js";

export default createApp();
