// @vayo/server — manual endpoint creation + folder/order placement.
import { Router } from "express";
import { z } from "zod";
import { requireRole, type VayoAuthedRequest } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import { applyOverride, checkOverrideAllowed } from "./overrides.js";
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

const deprecatedBodySchema = z.object({
  deprecated: z.boolean(),
  reason: z.string().nullable().optional(),
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
    const endpoint = await db.getEndpoint(vayoId);
    if (!endpoint) {
      res.status(404).json({ error: "not found" });
      return;
    }
    // A "declared" group (an explicit @group tag in code,
    // docs/04-capture-engine.md Step 2 #4) locks folder PLACEMENT —
    // checked here (via the same `checkOverrideAllowed` the generic
    // /api/overrides route and the Socket.IO transport also enforce, so
    // there's exactly one place this rule lives), not just in the sidebar
    // UI, since a client-side-only guard isn't a real guarantee (same
    // "never trust what the UI already hid" posture as every other rule in
    // this file). Same-folder reordering (an order-only change) still goes
    // through. Only applies once a placement override actually EXISTS — a
    // brand new "declared" endpoint that autoOrganizeFolders (or this very
    // route) hasn't placed anywhere yet has nothing to diverge from, so its
    // first placement always goes through unrestricted.
    const blockedReason = await checkOverrideAllowed(db, `${vayoId}.folderId`, parsed.data.folderId);
    if (blockedReason) {
      res.status(400).json({ error: blockedReason });
      return;
    }
    await applyOverride(db, req.vayoAuth!.memberId, `${vayoId}.folderId`, parsed.data.folderId, null);
    await applyOverride(db, req.vayoAuth!.memberId, `${vayoId}.order`, parsed.data.order, null);
    res.status(204).end();
  });

  // A human can freely flag ANY endpoint deprecated (or not) — EXCEPT
  // un-deprecating one whose `deprecatedSource` is "declared", meaning an
  // explicit `@deprecated` tag in the route's own code produced it
  // (docs/04-capture-engine.md Step 2 #4a). Checked here via the same
  // `checkOverrideAllowed` the generic /api/overrides route and the
  // Socket.IO transport also enforce (one shared place this rule lives),
  // not just left to the UI to hide the toggle — same "never trust what
  // the UI already hid" posture as the placement lock above. Re-declaring
  // an already-`true` value (whether code-declared or human-set) is a
  // no-op, not an error — it isn't actually contradicting anything.
  router.patch("/api/endpoints/:vayoId/deprecated", requireRole("editor"), async (req: VayoAuthedRequest, res) => {
    const parsed = deprecatedBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const vayoId = req.params.vayoId!;
    const endpoint = await db.getEndpoint(vayoId);
    if (!endpoint) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const blockedReason = await checkOverrideAllowed(db, `${vayoId}.deprecated`, parsed.data.deprecated);
    if (blockedReason) {
      res.status(400).json({ error: blockedReason });
      return;
    }
    await applyOverride(db, req.vayoAuth!.memberId, `${vayoId}.deprecated`, parsed.data.deprecated, parsed.data.reason ?? null);
    res.status(204).end();
  });

  // Deletable through the docs only when either (a) it's a "manual"
  // placeholder — never backed by real capture data in the first place — or
  // (b) `possiblyRemovedSince` is set, meaning the most recent `vayo scan`
  // didn't re-find it (docs/04-capture-engine.md §3d): that's the positive
  // evidence needed to know deleting it won't just have it silently
  // reappear on the next scan or request. Absent either condition, deleting
  // a still-confirmed captured endpoint would just undo itself — the route
  // it documents isn't something this tool controls in the first place
  // (docs/00-README.md's BYODB/capture stance), so removing it from docs
  // means removing the route in the backend itself, not deleting a row here.
  router.delete("/api/endpoints/:vayoId", requireRole("editor"), async (req: VayoAuthedRequest, res) => {
    const endpoint = await db.getEndpoint(req.params.vayoId!);
    if (!endpoint) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (endpoint.source !== "manual" && !endpoint.possiblyRemovedSince) {
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
