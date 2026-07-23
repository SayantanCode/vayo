// vayo — vayo export: compiles the resolved spec for a version and
// writes it to disk, either as OpenAPI 3.1 (docs/09-roadmap.md M2 done-when)
// or a Postman Collection v2.1 — the same logic apps/demo-app/src/export.ts
// and @vayo/server's /api/export/postman route already prove independently.

import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ExampleDoc, ResolvedEndpoint, TestScriptDoc } from "@vayo/types";
import { resolveEndpoint } from "@vayo/schema-engine";
import { compile } from "@vayo/openapi-compiler";
import { compilePostmanCollection } from "@vayo/server";
import { createAdapter } from "@vayo/db-mongo";
import { requireMongoUri } from "../config.js";

export interface ExportOptions {
  version: string;
  format: "openapi" | "postman";
  out?: string;
}

export async function exportCommand(options: ExportOptions): Promise<void> {
  const mongoUri = requireMongoUri();
  const db = createAdapter(mongoUri);

  const endpoints = await db.listEndpoints(options.version);
  const resolved: ResolvedEndpoint[] = await Promise.all(
    endpoints.map(async (endpoint) => resolveEndpoint(endpoint, await db.listOverrides(endpoint.vayoId))),
  );

  // The equivalent of swagger-jsdoc's static options.definition.info/servers
  // (docs/03-data-model.md `vayo_settings`/`vayo_environments`) — editable
  // through the docs UI rather than only ever hardcoded here.
  const [settings, environments] = await Promise.all([db.getSettings(), db.listEnvironments()]);
  const servers = environments
    .filter((env) => env.variables.baseUrl)
    .map((env) => ({ url: env.variables.baseUrl!, description: env.name }));

  // Only `pinned` examples (not the ephemeral rolling-window auto-captures)
  // — shared by both export formats so a team's saved Try It Now responses
  // show up in the OpenAPI export exactly as they already did in Postman's.
  const pinnedExamples = new Map<string, ExampleDoc[]>();
  for (const endpoint of resolved) {
    const pinned = (await db.listExamples(endpoint.vayoId)).filter((e) => e.pinned);
    if (pinned.length > 0) pinnedExamples.set(endpoint.vayoId, pinned);
  }

  if (options.format === "postman") {
    const folders = await db.listFolders(options.version);
    const placements = new Map<string, string | null>();
    const testScripts = new Map<string, TestScriptDoc>();
    for (const endpoint of resolved) {
      const folderId = (endpoint as unknown as { folderId?: string | null }).folderId ?? null;
      placements.set(endpoint.vayoId, folderId);

      const script = await db.getTestScript(endpoint.vayoId);
      if (script) testScripts.set(endpoint.vayoId, script);
    }
    const collection = compilePostmanCollection(
      `${settings.title} (${options.version})`,
      resolved,
      folders,
      placements,
      testScripts,
      pinnedExamples,
    );
    const outPath = path.resolve(process.cwd(), options.out ?? `postman-collection.${options.version}.json`);
    writeFileSync(outPath, JSON.stringify(collection, null, 2));
    console.log(`vayo: wrote ${outPath} (${collection.item.length} top-level item(s), version ${options.version})`);
  } else {
    const doc = await compile(resolved, options.version, {
      title: settings.title,
      description: settings.description ?? undefined,
      servers,
      pinnedExamplesByVayoId: pinnedExamples,
    });
    const outPath = path.resolve(process.cwd(), options.out ?? "openapi.json");
    writeFileSync(outPath, JSON.stringify(doc, null, 2));
    console.log(`vayo: wrote ${outPath} (${Object.keys(doc.paths).length} path(s), version ${options.version})`);
  }

  // createAdapter's MongoClient has no public close() — see scan.ts.
  process.exit(0);
}
