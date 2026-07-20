// @vayo/cli — vayo diff: the same compileVersion + diffSpecs logic as
// @vayo/server's GET /api/diff route, run directly against the DB so CI
// doesn't need a running server just to gate a breaking change
// (docs/07-api-versioning.md).

import type { ResolvedEndpoint } from "@vayo/types";
import { resolveEndpoint } from "@vayo/schema-engine";
import { compile, diffSpecs } from "@vayo/openapi-compiler";
import { createAdapter } from "@vayo/db-mongo";
import { requireMongoUri } from "../config.js";

export interface DiffOptions {
  failOnBreaking?: boolean;
}

export async function diffCommand(from: string, to: string, options: DiffOptions): Promise<void> {
  const mongoUri = requireMongoUri();
  const db = createAdapter(mongoUri);

  const versions = await db.listApiVersions();
  const fromVersion = versions.find((v) => v.version === from);
  const toVersion = versions.find((v) => v.version === to);

  async function compileVersion(version: string) {
    const endpoints = await db.listEndpoints(version);
    const resolved: ResolvedEndpoint[] = await Promise.all(
      endpoints.map(async (endpoint) => resolveEndpoint(endpoint, await db.listOverrides(endpoint.vayoId))),
    );
    return compile(resolved, version);
  }

  const [specFrom, specTo] = await Promise.all([compileVersion(from), compileVersion(to)]);
  const diff = diffSpecs(specFrom, specTo, {
    stripPrefixA: fromVersion?.basePathPattern,
    stripPrefixB: toVersion?.basePathPattern,
  });

  console.log(`vayo: diffing ${from} -> ${to}`);
  for (const op of diff.added) console.log(`  + added   ${op.method} ${op.path}`);
  for (const op of diff.removed) console.log(`  - removed ${op.method} ${op.path}`);
  for (const change of diff.changed) {
    console.log(`  ~ changed ${change.operation.method} ${change.operation.path}`);
    for (const line of change.changes) console.log(`      ${line}`);
  }
  console.log(
    `\nvayo: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed.`,
  );

  if (options.failOnBreaking && (diff.removed.length > 0 || diff.changed.length > 0)) {
    console.error("vayo: breaking changes detected, failing (--fail-on-breaking).");
    process.exitCode = 1;
  }

  // createAdapter's MongoClient has no public close() — see scan.ts.
  // Exiting with no argument preserves the exitCode set above.
  process.exit();
}
