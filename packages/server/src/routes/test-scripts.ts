// @vayo/server — vayo_test_scripts (Try It Now's pre/post-request scripts).
// The scripts themselves only ever execute client-side, sandboxed in a Web
// Worker (packages/ui/src/script-runner.worker.ts) — this route just
// persists the script text and the most recent run's pass/fail summary.
import { Router } from "express";
import { z } from "zod";
import { requireRole, type VayoAuthedRequest } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import type { RouteDeps } from "../server-deps.js";

const testScriptBodySchema = z.object({
  preRequestScript: z.string(),
  testScript: z.string(),
});

const testRunBodySchema = z.object({
  status: z.enum(["pass", "fail"]),
  results: z.array(z.object({ name: z.string(), passed: z.boolean(), error: z.string().optional() })),
  at: z.string(),
});

export function createTestScriptsRouter({ db }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  router.get("/api/test-scripts/:vayoId", requireRole("viewer"), async (req, res) => {
    const script = await db.getTestScript(req.params.vayoId!);
    res.json(script ?? { vayoId: req.params.vayoId, preRequestScript: "", testScript: "", lastRun: null });
  });

  router.put("/api/test-scripts/:vayoId", requireRole("editor"), async (req: VayoAuthedRequest, res) => {
    const parsed = testScriptBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const saved = await db.upsertTestScript(req.params.vayoId!, parsed.data, req.vayoAuth!.memberId);
    res.json(saved);
  });

  router.patch("/api/test-scripts/:vayoId/last-run", requireRole("viewer"), async (req, res) => {
    const parsed = testRunBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const saved = await db.recordTestRun(req.params.vayoId!, parsed.data);
    if (!saved) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(saved);
  });

  return router;
}
