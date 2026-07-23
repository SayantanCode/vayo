// vayo — vayo import: enriches endpoints Vayo already discovered (via
// capture/AST scan) with content from an existing OpenAPI spec — a
// migration/onboarding tool, not a parallel authoring path. Never invents
// endpoints from the spec alone (docs/01-vision-and-market.md's own Apidog
// comparison: Vayo's differentiator is exactly that a human doesn't have
// to author/import a spec for it to work — capture/scan stay the sole
// source of truth for *what exists*; import only ever adds descriptive
// content on top). See @vayo/openapi-compiler's planOpenApiImport for the
// pure planning logic this command turns into real writes.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { VayoDbAdapter } from "@vayo/types";
import { planOpenApiImport, type ImportableEndpointRef } from "@vayo/openapi-compiler";
import { createAdapter } from "@vayo/db-mongo";
import { requireMongoUri } from "../config.js";

export interface ImportOptions {
  format: "openapi";
  file: string;
  version: string;
  overwrite?: boolean;
}

const IMPORT_ACTOR = "system:cli-import";

/** Writes one override without the per-field notification `applyOverride`
 * (@vayo/server) creates on every human-triggered write — a bulk import
 * setting summary/description/schema-field descriptions across every
 * matched endpoint would otherwise flood the notification bell with one
 * "updated X" entry per field per endpoint. Still audit-logged
 * (`actorType: "system"`), so History still shows where the change came
 * from, just without the live notification noise. */
async function applyImportOverride(db: VayoDbAdapter, targetId: string, value: unknown): Promise<void> {
  const existing = await db.getOverride(targetId);
  const now = new Date().toISOString();
  await db.upsertOverride({ targetId, value, updatedBy: IMPORT_ACTOR, updatedAt: now, reason: "Imported from OpenAPI spec" });
  const vayoId = targetId.split(".")[0]!;
  const fieldPath = targetId.slice(vayoId.length + 1);
  await db.appendAuditLog({
    actorId: IMPORT_ACTOR,
    actorType: "system",
    action: "override",
    targetId: vayoId,
    fieldPath,
    diff: { before: existing?.value ?? null, after: value },
    at: now,
  });
}

export async function importCommand(options: ImportOptions): Promise<void> {
  const mongoUri = requireMongoUri();
  const db = createAdapter(mongoUri);

  try {
    const filePath = path.resolve(process.cwd(), options.file);
    const spec: unknown = JSON.parse(readFileSync(filePath, "utf-8"));

    const endpoints = await db.listEndpoints(options.version);
    const refs: ImportableEndpointRef[] = endpoints.map((endpoint) => ({
      vayoId: endpoint.vayoId,
      method: endpoint.method,
      pathTemplate: endpoint.pathTemplate,
      requestSchema: endpoint.requestSchema,
      responseSchemas: endpoint.responseSchemas,
    }));
    const environments = await db.listEnvironments();

    // planOpenApiImport throws on a Postman-Collection-shaped file rather
    // than returning an empty plan — let it propagate to the catch below
    // rather than a wrapped/duplicated message.
    const plan = planOpenApiImport(spec, refs, environments);

    if (plan.title || plan.description) {
      await db.updateSettings({ title: plan.title, description: plan.description }, IMPORT_ACTOR);
      console.log("vayo: updated project settings (title/description) from the imported spec.");
    }

    for (const server of plan.servers) {
      const now = new Date().toISOString();
      await db.createEnvironment({
        name: server.description || `Imported (${server.url})`,
        variables: { baseUrl: server.url },
        isDefault: false,
        createdBy: IMPORT_ACTOR,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`vayo: created an environment for server ${server.url}`);
    }

    let overridesApplied = 0;
    let overridesSkipped = 0;
    let examplesCreated = 0;
    for (const match of plan.matched) {
      for (const [fieldPath, value] of Object.entries(match.overrides)) {
        const targetId = `${match.vayoId}.${fieldPath}`;
        if (!options.overwrite && (await db.getOverride(targetId))) {
          overridesSkipped++;
          continue;
        }
        await applyImportOverride(db, targetId, value);
        overridesApplied++;
      }

      if (match.examples.length > 0) {
        // Dedupe against what's already pinned (by status + label) so
        // re-running the same import doesn't pile up duplicate examples —
        // pinExample itself always inserts a new document, it has no
        // upsert-by-identity of its own.
        const alreadyPinned = await db.listExamples(match.vayoId);
        for (const example of match.examples) {
          const exists = alreadyPinned.some(
            (existing) => existing.pinned && existing.statusCode === example.statusCode && existing.label === example.label,
          );
          if (exists) continue;
          await db.pinExample({
            vayoId: match.vayoId,
            statusCode: example.statusCode,
            requestBody: null,
            responseBody: example.responseBody,
            capturedAt: new Date().toISOString(),
            redacted: false,
            label: example.label,
          });
          examplesCreated++;
        }
      }

      console.log(`vayo: enriched ${match.method} ${match.pathTemplate}`);
    }

    if (plan.unmatched.length > 0) {
      console.log(
        `\nvayo: ${plan.unmatched.length} spec operation(s) had no matching endpoint in ${options.version} (not yet captured/scanned, or genuinely gone) — skipped:`,
      );
      for (const op of plan.unmatched) console.log(`  ? ${op.method} ${op.path}`);
    }

    console.log(
      `\nvayo: import complete — ${plan.matched.length} endpoint(s) matched, ${overridesApplied} override(s) applied` +
        (overridesSkipped > 0 ? `, ${overridesSkipped} skipped (already overridden — pass --overwrite to replace)` : "") +
        `, ${examplesCreated} example(s) pinned.`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    // createAdapter's MongoClient has no public close() — see scan.ts.
    // Caught above so a thrown error (invalid file, a Postman-shaped
    // input, an unreadable path) still prints instead of hanging forever
    // on the still-open connection, the same reason create-owner.ts wraps
    // its own risky logic the identical way.
    process.exit();
  }
}
