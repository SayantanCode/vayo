// @vayo/server — vayo_folders: sidebar organization.
import { Router } from "express";
import { z } from "zod";
import { requireRole, type VayoAuthedRequest } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import { applyOverride } from "./overrides.js";
import type { RouteDeps } from "../server-deps.js";

const folderBodySchema = z.object({
  name: z.string().min(1),
  parentId: z.string().nullable(),
  version: z.string().min(1),
});

const folderPatchSchema = z.object({
  name: z.string().min(1).optional(),
  parentId: z.string().nullable().optional(),
  order: z.number().optional(),
});

export function createFoldersRouter({ db }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  router.get("/api/folders", requireRole("viewer"), async (req, res) => {
    const version = typeof req.query.version === "string" ? req.query.version : "v1";
    res.json(await db.listFolders(version));
  });

  router.post("/api/folders", requireRole("editor"), async (req, res) => {
    const parsed = folderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const existingSiblings = await db.listFolders(parsed.data.version);
    const order = existingSiblings.filter((f) => f.parentId === parsed.data.parentId).length;
    const now = new Date().toISOString();
    const folder = await db.createFolder({
      name: parsed.data.name,
      parentId: parsed.data.parentId,
      version: parsed.data.version,
      order,
      createdBy: (req as VayoAuthedRequest).vayoAuth!.memberId,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json(folder);
  });

  router.patch("/api/folders/:id", requireRole("editor"), async (req, res) => {
    const parsed = folderPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const updated = await db.updateFolder(req.params.id!, parsed.data);
    if (!updated) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(updated);
  });

  router.delete("/api/folders/:id", requireRole("editor"), async (req: VayoAuthedRequest, res) => {
    const folder = await db.getFolder(req.params.id!);
    if (!folder) {
      res.status(404).json({ error: "not found" });
      return;
    }
    // Endpoints placed directly in this folder are reparented to the
    // deleted folder's own parent — never silently orphaned (same
    // non-destructive philosophy as overrides). Sub-folder reparenting is
    // handled inside db.deleteFolder itself.
    const siblingEndpoints = await db.listEndpoints(folder.version);
    for (const endpoint of siblingEndpoints) {
      const overrides = await db.listOverrides(endpoint.vayoId);
      const placement = overrides.find((o) => o.targetId === `${endpoint.vayoId}.folderId`);
      if (placement && placement.value === folder._id) {
        await applyOverride(db, req.vayoAuth!.memberId, placement.targetId, folder.parentId, "parent folder deleted");
      }
    }
    await db.deleteFolder(folder._id);
    res.status(204).end();
  });

  // Auto-organize by detected group — same non-destructive additive pass
  // "vayo scan" runs automatically (docs/04-capture-engine.md), exposed
  // here too for teams that add manual endpoints straight from the UI and
  // never run the CLI, or just want to re-trigger it after doing so.
  router.post("/api/folders/auto-organize", requireRole("editor"), async (req: VayoAuthedRequest, res) => {
    const version = typeof req.query.version === "string" ? req.query.version : "v1";
    const result = await db.autoOrganizeFolders(version, req.vayoAuth!.memberId);
    res.json(result);
  });

  return router;
}
