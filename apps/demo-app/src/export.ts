// apps/demo-app/src/export.ts — stand-in for the future `vayo export` CLI
// command (packages/cli isn't built yet). Reads all endpoints for a
// version, resolves overrides on top (docs/03-data-model.md "Resolving a
// read"), compiles to OpenAPI 3.1, and writes openapi.json
// (docs/09-roadmap.md M2 done-when).

import { writeFileSync } from "node:fs";
import path from "node:path";
import { resolveEndpoint } from "@vayo/schema-engine";
import { compile } from "@vayo/openapi-compiler";
import { createAdapter } from "@vayo/db-mongo";

const mongoUri = process.env.VAYO_MONGO_URI;
if (!mongoUri) {
  throw new Error("VAYO_MONGO_URI is not set — copy .env.example to .env and fill it in.");
}

const version = process.argv[2] ?? "v1";
const db = createAdapter(mongoUri);

async function main() {
  const endpoints = await db.listEndpoints(version);
  const resolved = await Promise.all(
    endpoints.map(async (endpoint) => {
      const overrides = await db.listOverrides(endpoint.vayoId);
      return resolveEndpoint(endpoint, overrides);
    }),
  );

  const doc = await compile(resolved, version);

  const outPath = path.join(__dirname, "..", "openapi.json");
  writeFileSync(outPath, JSON.stringify(doc, null, 2));
  console.log(`wrote ${outPath} (${Object.keys(doc.paths).length} paths, version ${version})`);
}

main()
  .then(() => setTimeout(() => process.exit(0), 100))
  .catch((err) => {
    console.error("vayo export failed:", err);
    process.exit(1);
  });
