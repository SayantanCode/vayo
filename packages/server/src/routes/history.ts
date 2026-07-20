// @vayo/server — the per-endpoint History tab, and the full-project
// compliance/audit export (docs/01-vision-and-market.md "Segments this
// honestly doesn't serve yet" — the audit-trail half of the enterprise
// SSO/SOC2/audit-logs question).
import { Router } from "express";
import { requireRole } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import type { RouteDeps } from "../server-deps.js";

const MAX_AUDIT_EXPORT_LIMIT = 10_000;

export function createHistoryRouter({ db }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  router.get("/api/history/:vayoId", requireRole("viewer"), async (req, res) => {
    const entries = await db.listAuditLog(req.params.vayoId!);
    res.json(entries);
  });

  // Full-project compliance export (owner-only), not scoped to one endpoint
  // like the History tab above. Nothing new is recorded for this — it just
  // exposes reading every entry `vayo_audit_log` already has, in one call,
  // in JSON or CSV — the kind of "give an auditor an exportable record" ask
  // a SOC2/compliance review actually needs, which the per-endpoint History
  // tab alone couldn't answer.
  router.get("/api/audit-log/export", requireRole("owner"), async (req, res) => {
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_AUDIT_EXPORT_LIMIT) : MAX_AUDIT_EXPORT_LIMIT;
    const entries = await db.listAllAuditLog(limit);
    if (req.query.format === "csv") {
      const csvField = (value: unknown): string => {
        const str = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
        return `"${str.replace(/"/g, '""')}"`;
      };
      const header = "id,actorId,actorType,action,targetId,fieldPath,before,after,at";
      const rows = entries.map((e) =>
        [e._id, e.actorId, e.actorType, e.action, e.targetId, e.fieldPath, e.diff?.before, e.diff?.after, e.at].map(csvField).join(","),
      );
      res.type("text/csv").attachment("vayo-audit-log.csv").send([header, ...rows].join("\n"));
      return;
    }
    res.json(entries);
  });

  return router;
}
