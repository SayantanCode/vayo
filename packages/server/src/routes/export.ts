// @vayo/server — Postman collection/environment export. The actual compile
// logic is framework-agnostic (../postman-export.ts, usable directly by
// vayo's `vayo export --format postman` with no running server) — this
// is just the thin HTTP wrapper around it.
import { Router } from "express";
import type { ExampleDoc, ResolvedEndpoint, TestScriptDoc } from "@vayo/types";
import { resolveEndpoint } from "@vayo/schema-engine";
import { requireRole } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import { compilePostmanCollection, compilePostmanEnvironment } from "../postman-export.js";
import type { RouteDeps } from "../server-deps.js";

export function createExportRouter({ db }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  router.get("/api/export/postman", requireRole("viewer"), async (req, res) => {
    const version = typeof req.query.version === "string" ? req.query.version : "v1";
    const endpoints = await db.listEndpoints(version);
    const resolved: ResolvedEndpoint[] = await Promise.all(
      endpoints.map(async (endpoint) => resolveEndpoint(endpoint, await db.listOverrides(endpoint.vayoId))),
    );
    const folders = await db.listFolders(version);
    const placements = new Map<string, string | null>();
    const testScripts = new Map<string, TestScriptDoc>();
    const pinnedExamples = new Map<string, ExampleDoc[]>();
    for (const endpoint of resolved) {
      const folderId = (endpoint as unknown as { folderId?: string | null }).folderId ?? null;
      placements.set(endpoint.vayoId, folderId);

      const script = await db.getTestScript(endpoint.vayoId);
      if (script) testScripts.set(endpoint.vayoId, script);

      const pinned = (await db.listExamples(endpoint.vayoId)).filter((e) => e.pinned);
      if (pinned.length > 0) pinnedExamples.set(endpoint.vayoId, pinned);
    }
    res.json(compilePostmanCollection(`Vayo API (${version})`, resolved, folders, placements, testScripts, pinnedExamples));
  });

  router.get("/api/export/postman-environment/:id", requireRole("viewer"), async (req, res) => {
    const environments = await db.listEnvironments();
    const environment = environments.find((e) => e._id === req.params.id);
    if (!environment) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(compilePostmanEnvironment(environment));
  });

  return router;
}
