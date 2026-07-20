// @vayo/server — vayo_environments (Try It Now's environment/variable switcher).
import { Router } from "express";
import { z } from "zod";
import { requireRole, type VayoAuthedRequest } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import type { RouteDeps } from "../server-deps.js";

const environmentBodySchema = z.object({
  name: z.string().min(1),
  variables: z.record(z.string()),
  isDefault: z.boolean().optional(),
});

const environmentPatchSchema = z.object({
  name: z.string().min(1).optional(),
  variables: z.record(z.string()).optional(),
  isDefault: z.boolean().optional(),
});

export function createEnvironmentsRouter({ db }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  router.get("/api/environments", requireRole("viewer"), async (_req, res) => {
    res.json(await db.listEnvironments());
  });

  router.post("/api/environments", requireRole("editor"), async (req: VayoAuthedRequest, res) => {
    const parsed = environmentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const now = new Date().toISOString();
    const environment = await db.createEnvironment({
      name: parsed.data.name,
      variables: parsed.data.variables,
      isDefault: parsed.data.isDefault ?? false,
      createdBy: req.vayoAuth!.memberId,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json(environment);
  });

  router.patch("/api/environments/:id", requireRole("editor"), async (req, res) => {
    const parsed = environmentPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const updated = await db.updateEnvironment(req.params.id!, parsed.data);
    if (!updated) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(updated);
  });

  router.delete("/api/environments/:id", requireRole("editor"), async (req, res) => {
    await db.deleteEnvironment(req.params.id!);
    res.status(204).end();
  });

  return router;
}
