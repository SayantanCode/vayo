// @vayo/server — vayo_overrides: the diff-layer that lets a human correct
// the auto-generated baseline without ever mutating the underlying captured
// data (docs/03-data-model.md, constraint #3 "overrides are additive, never
// destructive").
import { Router } from "express";
import { z } from "zod";
import type { AuditAction, VayoDbAdapter } from "@vayo/types";
import { requireRole, type VayoAuthedRequest } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import type { RouteDeps } from "../server-deps.js";

const overrideBodySchema = z.object({
  targetId: z.string().min(1),
  value: z.unknown(),
  reason: z.string().nullable().optional(),
});

/** Shared by the REST route below and the `override:updated` socket handler
 * (realtime.ts) — same DB write either way, so the audit-log entry and
 * notification are guaranteed to exist regardless of which transport the
 * change came in through. */
export async function applyOverride(db: VayoDbAdapter, memberId: string, targetId: string, value: unknown, reason: string | null) {
  const existing = await db.getOverride(targetId);
  const now = new Date().toISOString();
  const saved = await db.upsertOverride({ targetId, value, updatedBy: memberId, updatedAt: now, reason });
  // The audit log's targetId is the endpoint's vayoId (the part of the
  // override's compound targetId before the first "."), not the override's
  // own targetId — docs/03-data-model.md: the History tab filters
  // vayo_audit_log by "targetId = a given vayoId" to show every change to
  // that endpoint (overrides on any field, comments, schema changes) in one
  // place, not just changes to this one field path.
  const vayoId = targetId.split(".")[0]!;
  const fieldPath = targetId.slice(vayoId.length + 1);
  await db.appendAuditLog({
    actorId: memberId,
    actorType: "human",
    action: "override" satisfies AuditAction,
    targetId: vayoId,
    fieldPath,
    diff: { before: existing?.value ?? null, after: value },
    at: now,
  });
  await db.createNotification({
    type: "override",
    vayoId,
    actorId: memberId,
    message: `updated ${fieldPath}`,
    mentionedMemberIds: [],
    targetId,
    createdAt: now,
  });
  return saved;
}

export function createOverridesRouter({ db, io }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  router.post("/api/overrides", requireRole("editor"), async (req: VayoAuthedRequest, res) => {
    const parsed = overrideBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const saved = await applyOverride(db, req.vayoAuth!.memberId, parsed.data.targetId, parsed.data.value, parsed.data.reason ?? null);
    const vayoId = parsed.data.targetId.split(".")[0];
    io.to(`endpoint:${vayoId}`).emit("override:updated", {
      vayoId,
      fieldPath: parsed.data.targetId.slice(vayoId!.length + 1),
      value: saved.value,
      updatedBy: req.vayoAuth!.memberId,
    });
    io.to("project").emit("notification:new", { type: "override", vayoId });
    res.json(saved);
  });

  return router;
}
