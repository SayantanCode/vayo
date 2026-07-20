// apps/demo-app/src/scan.ts — stand-in for the future `vayo scan` CLI
// command (packages/cli isn't built yet). Runs @vayo/ast's static pass
// against this app and merges the result into vayo_endpoints via
// VayoDbAdapter.upsertStaticResult (docs/04-capture-engine.md Step 2).

import { scanProject, type VayoConfig } from "@vayo/ast";
import { createAdapter } from "@vayo/db-mongo";
import { resolveVersion } from "@vayo/schema-engine";

const mongoUri = process.env.VAYO_MONGO_URI;
if (!mongoUri) {
  throw new Error("VAYO_MONGO_URI is not set — copy .env.example to .env and fill it in.");
}

const rootDir = __dirname;
const config: VayoConfig = { appEntryPath: "./ast-entry.ts" };

const db = createAdapter(mongoUri);

scanProject(rootDir, config)
  .then(async (result) => {
    const configuredVersions = (await db.listApiVersions()).map((v) => ({
      version: v.version,
      basePathPattern: v.basePathPattern,
    }));
    for (const route of result.routes) {
      const version = resolveVersion(route.pathTemplate, configuredVersions);
      await db.upsertStaticResult(route, version);
      console.log(`merged ${route.method} ${route.pathTemplate} (${version}) — scopes=${JSON.stringify(route.scopes)} middlewareChain=${JSON.stringify(route.middlewareChain)}`);
    }
    // process.exit() right after console.log can truncate stdout on Windows
    // when it's piped rather than a TTY — give it a tick to flush before
    // forcing the still-open Mongo connection to let the process exit.
    setTimeout(() => process.exit(0), 100);
  })
  .catch((err) => {
    console.error("vayo scan failed:", err);
    process.exit(1);
  });
