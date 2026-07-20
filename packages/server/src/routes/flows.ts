// @vayo/server — vayo_flows: saved related-endpoint sequences (Postman
// Collection Runner equivalent for Try It Now).
import { Router } from "express";
import { z } from "zod";
import { requireRole, type VayoAuthedRequest } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import type { RouteDeps } from "../server-deps.js";

const flowStepSchema = z.object({
  vayoId: z.string().min(1),
  extractVariables: z.record(z.string()).optional(),
});

const flowBodySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  steps: z.array(flowStepSchema),
});

const flowPatchSchema = z.object({
  name: z.string().min(1).optional(),
  steps: z.array(flowStepSchema).optional(),
});

export function createFlowsRouter({ db }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  router.get("/api/flows", requireRole("viewer"), async (req, res) => {
    const version = typeof req.query.version === "string" ? req.query.version : "v1";
    res.json(await db.listFlows(version));
  });

  router.post("/api/flows", requireRole("editor"), async (req: VayoAuthedRequest, res) => {
    const parsed = flowBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const now = new Date().toISOString();
    const flow = await db.createFlow({
      name: parsed.data.name,
      version: parsed.data.version,
      steps: parsed.data.steps,
      createdBy: req.vayoAuth!.memberId,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json(flow);
  });

  router.patch("/api/flows/:id", requireRole("editor"), async (req, res) => {
    const parsed = flowPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const updated = await db.updateFlow(req.params.id!, parsed.data);
    if (!updated) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(updated);
  });

  router.delete("/api/flows/:id", requireRole("editor"), async (req, res) => {
    await db.deleteFlow(req.params.id!);
    res.status(204).end();
  });

  return router;
}
