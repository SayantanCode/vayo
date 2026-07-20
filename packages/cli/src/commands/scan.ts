// @vayo/cli — vayo scan: runs @vayo/ast's static pass and merges the result
// into vayo_endpoints (docs/04-capture-engine.md Step 2), the same logic
// apps/demo-app/src/scan.ts proved by hand.

import { scanProject } from "@vayo/ast";
import { createAdapter } from "@vayo/db-mongo";
import { resolveVersion } from "@vayo/schema-engine";
import { loadConfig, requireMongoUri } from "../config.js";

export interface ScanOptions {
  config?: string;
}

export async function scanCommand(options: ScanOptions): Promise<void> {
  const mongoUri = requireMongoUri();
  const config = await loadConfig(options.config);
  const db = createAdapter(mongoUri);

  const result = await scanProject(process.cwd(), config);
  const configuredVersions = (await db.listApiVersions()).map((v) => ({
    version: v.version,
    basePathPattern: v.basePathPattern,
  }));

  const groups = new Set<string>();
  const versionsTouched = new Set<string>();
  for (const route of result.routes) {
    const version = resolveVersion(route.pathTemplate, configuredVersions);
    await db.upsertStaticResult(route, version);
    groups.add(route.group);
    versionsTouched.add(version);
    console.log(
      `merged ${route.method} ${route.pathTemplate} (${version}) — scopes=${JSON.stringify(route.scopes)} middlewareChain=${JSON.stringify(route.middlewareChain)}`,
    );
  }

  console.log(`\nvayo: scanned ${result.routes.length} route(s) across ${groups.size} group(s).`);

  // Auto-organize into folders by detected group — additive only, never
  // touches an endpoint that already has a placement of any kind (see
  // autoOrganizeFolders' own doc comment). This is what turns "here's a
  // flat list of everything I found" into "here's a reasonable starting
  // sidebar" on the very first scan.
  for (const version of versionsTouched) {
    const { foldersCreated, endpointsPlaced } = await db.autoOrganizeFolders(version, "system:cli-scan");
    if (foldersCreated > 0 || endpointsPlaced > 0) {
      console.log(`vayo: organized ${version} — ${foldersCreated} folder(s) created, ${endpointsPlaced} endpoint(s) placed.`);
    }
  }

  // createAdapter's MongoClient has no public close() (it's meant to live
  // for a long-running server's whole lifetime, not a one-shot command) —
  // same reason every one-shot script in apps/demo-app force-exits too.
  process.exit(0);
}
