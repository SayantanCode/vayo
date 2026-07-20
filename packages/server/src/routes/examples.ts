// @vayo/server — vayo_examples: saved/pinned request+response pairs, on top
// of the rolling-window captures @vayo/capture-express already writes.
import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import type { RouteDeps } from "../server-deps.js";

const pinExampleBodySchema = z.object({
  statusCode: z.number(),
  requestBody: z.unknown(),
  responseBody: z.unknown(),
  label: z.string().nullable().optional(),
});

export function createExamplesRouter({ db }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  router.get("/api/examples/:vayoId", requireRole("viewer"), async (req, res) => {
    res.json(await db.listExamples(req.params.vayoId!));
  });

  router.post("/api/examples/:vayoId/pin", requireRole("viewer"), async (req, res) => {
    const parsed = pinExampleBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const example = await db.pinExample({
      vayoId: req.params.vayoId!,
      statusCode: parsed.data.statusCode,
      requestBody: parsed.data.requestBody ?? null,
      responseBody: parsed.data.responseBody ?? null,
      capturedAt: new Date().toISOString(),
      redacted: false,
      label: parsed.data.label ?? null,
    });
    res.status(201).json(example);
  });

  router.delete("/api/examples/:id", requireRole("editor"), async (req, res) => {
    await db.deleteExample(req.params.id!);
    res.status(204).end();
  });

  return router;
}
