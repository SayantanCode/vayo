// @vayo/server — manual endpoint creation + folder/order placement.
import { Router } from "express";
import { z } from "zod";
import { requireRole, type VayoAuthedRequest } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import { applyOverride } from "./overrides.js";
import type { RouteDeps } from "../server-deps.js";

const manualEndpointBodySchema = z.object({
  method: z.string().min(1),
  pathTemplate: z.string().min(1),
  version: z.string().min(1),
  group: z.string().min(1),
  summary: z.string().nullable().optional(),
});

const placementBodySchema = z.object({
  folderId: z.string().nullable(),
  order: z.number(),
});

export function createEndpointsRouter({ db }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  router.post("/api/endpoints/manual", requireRole("editor"), async (req: VayoAuthedRequest, res) => {
    const parsed = manualEndpointBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    try {
      const endpoint = await db.createManualEndpoint({
        method: parsed.data.method,
        pathTemplate: parsed.data.pathTemplate,
        version: parsed.data.version,
        group: parsed.data.group,
        summary: parsed.data.summary ?? null,
      });
      await db.appendAuditLog({
        actorId: req.vayoAuth!.memberId,
        actorType: "human",
        action: "endpoint_created",
        targetId: endpoint.vayoId,
        fieldPath: null,
        diff: { before: null, after: { method: endpoint.method, pathTemplate: endpoint.pathTemplate } },
        at: new Date().toISOString(),
      });
      res.status(201).json(endpoint);
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : "conflict" });
    }
  });

  router.patch("/api/endpoints/:vayoId/placement", requireRole("editor"), async (req: VayoAuthedRequest, res) => {
    const parsed = placementBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const vayoId = req.params.vayoId!;
    await applyOverride(db, req.vayoAuth!.memberId, `${vayoId}.folderId`, parsed.data.folderId, null);
    await applyOverride(db, req.vayoAuth!.memberId, `${vayoId}.order`, parsed.data.order, null);
    res.status(204).end();
  });

  // Only a "manual" endpoint (a human-created placeholder, never backed by
  // real capture data) may be deleted through the docs — deleting a
  // captured one would just have it reappear on the next static scan or
  // the next request, silently undoing the delete and confusing whoever
  // did it. The route the real endpoint belongs to isn't something this
  // tool controls in the first place (docs/00-README.md's BYODB/capture
  // stance) — removing it from docs means removing the route in the
  // backend itself, not deleting a row here.
  router.delete("/api/endpoints/:vayoId", requireRole("editor"), async (req: VayoAuthedRequest, res) => {
    const endpoint = await db.getEndpoint(req.params.vayoId!);
    if (!endpoint) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (endpoint.source !== "manual") {
      res.status(400).json({
        error: "can't delete an endpoint detected from your real API — remove the route in your backend instead",
      });
      return;
    }
    await db.deleteEndpoint(endpoint.vayoId);
    await db.appendAuditLog({
      actorId: req.vayoAuth!.memberId,
      actorType: "human",
      action: "endpoint_deleted",
      targetId: endpoint.vayoId,
      fieldPath: null,
      diff: { before: { method: endpoint.method, pathTemplate: endpoint.pathTemplate }, after: null },
      at: new Date().toISOString(),
    });
    res.status(204).end();
  });

  return router;
}
