// @vayo/server — GET /api/coverage. Thin route wrapper: the actual report
// logic (computeCoverageReport) is framework-agnostic and lives in
// ../coverage.ts, unit-tested directly against hand-built fixtures rather
// than through this HTTP layer.
import { Router } from "express";
import { resolveEndpoint } from "@vayo/schema-engine";
import { requireRole } from "../auth-middleware.js";
import { computeCoverageReport } from "../coverage.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import type { RouteDeps } from "../server-deps.js";

export function createCoverageRouter({ db }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  router.get("/api/coverage", requireRole("viewer"), async (req, res) => {
    const version = typeof req.query.version === "string" ? req.query.version : "v1";
    const endpoints = await db.listEndpoints(version);
    const resolved = await Promise.all(
      endpoints.map(async (endpoint) => resolveEndpoint(endpoint, await db.listOverrides(endpoint.vayoId))),
    );
    res.json(computeCoverageReport(resolved));
  });

  return router;
}
