// @vayo/server — vayo_settings (project-wide title/description, the
// equivalent of swagger-jsdoc's options.definition.info, but editable
// through the docs UI — docs/03-data-model.md).
import { Router } from "express";
import { z } from "zod";
import { requireRole, type VayoAuthedRequest } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import type { RouteDeps } from "../server-deps.js";

const settingsPatchSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  contactName: z.string().nullable().optional(),
  contactEmail: z.string().nullable().optional(),
  contactUrl: z.string().nullable().optional(),
  licenseName: z.string().nullable().optional(),
  licenseUrl: z.string().nullable().optional(),
  termsOfService: z.string().nullable().optional(),
});

export function createSettingsRouter({ db }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  router.get("/api/settings", requireRole("viewer"), async (_req, res) => {
    res.json(await db.getSettings());
  });

  router.patch("/api/settings", requireRole("editor"), async (req: VayoAuthedRequest, res) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const updated = await db.updateSettings(parsed.data, req.vayoAuth!.memberId);
    res.json(updated);
  });

  return router;
}
