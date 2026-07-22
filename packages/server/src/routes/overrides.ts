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

/** Guards the two fields that carry "declared in code, can't be silently
 * changed through the docs" behavior (docs/04-capture-engine.md Step 2
 * #4/#4a): `folderId` when `groupSource === "declared"`, and `deprecated`
 * when `deprecatedSource === "declared"` and the write would set it back to
 * `false`. Returns an error message when the write should be refused, or
 * `null` when it's fine.
 *
 * This is a generic REST endpoint (any `targetId`/`value` pair) and the
 * Socket.IO `override:updated` handler (realtime.ts) both accept an
 * arbitrary caller-supplied field path — the same two locks already
 * enforced by their own purpose-built routes in `endpoints.ts`
 * (`/placement`, `/deprecated`) would otherwise be trivially bypassable by
 * writing the exact same override through either of these more generic
 * paths instead, same "never trust what the UI already hid" posture as
 * every other rule in this codebase. Deliberately NOT built into
 * `applyOverride` itself below: folder deletion's reparenting call
 * (`routes/folders.ts`) legitimately needs to relocate a "declared"
 * endpoint out of a folder that no longer exists, with no reasonable
 * alternative — `applyOverride` stays a trusting low-level primitive, same
 * as `VayoDbAdapter.deleteEndpoint` trusting its own caller
 * (`03-data-model.md`); it's each caller's job to check first when the
 * field path comes from outside this codebase's own control. */
export async function checkOverrideAllowed(db: VayoDbAdapter, targetId: string, value: unknown): Promise<string | null> {
  const vayoId = targetId.split(".")[0]!;
  const fieldPath = targetId.slice(vayoId.length + 1);
  if (fieldPath !== "folderId" && fieldPath !== "deprecated") return null;

  const endpoint = await db.getEndpoint(vayoId);
  if (!endpoint) return null; // let the caller's own not-found handling (if any) take over

  if (fieldPath === "folderId" && endpoint.groupSource === "declared") {
    const existing = await db.getOverride(targetId);
    if (existing && value !== existing.value) {
      return "this endpoint's group is declared in code via @group — move it there instead of in the sidebar";
    }
  }
  if (fieldPath === "deprecated" && endpoint.deprecatedSource === "declared" && value === false) {
    return "this endpoint is declared deprecated in code via @deprecated — remove the tag there instead";
  }
  return null;
}

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
    const blockedReason = await checkOverrideAllowed(db, parsed.data.targetId, parsed.data.value);
    if (blockedReason) {
      res.status(400).json({ error: blockedReason });
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
