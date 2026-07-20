// @vayo/server — the header bell's feed (docs/06-realtime-collaboration.md
// "Notifications").
import { Router } from "express";
import { requireRole, type VayoAuthedRequest } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import type { RouteDeps } from "../server-deps.js";

export function createNotificationsRouter({ db }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  router.get("/api/notifications", requireRole("viewer"), async (req: VayoAuthedRequest, res) => {
    const member = await db.getTeamMember(req.vayoAuth!.memberId);
    const items = await db.listNotifications(50);
    // A member's own actions never count as "unread" for them — nobody
    // needs to be told they just did the thing they did.
    const unreadCount = items.filter(
      (n) => n.actorId !== req.vayoAuth!.memberId && (!member?.lastSeenNotificationsAt || n.createdAt > member.lastSeenNotificationsAt),
    ).length;
    res.json({ items, unreadCount, lastSeenNotificationsAt: member?.lastSeenNotificationsAt ?? null });
  });

  router.post("/api/notifications/mark-seen", requireRole("viewer"), async (req: VayoAuthedRequest, res) => {
    await db.markNotificationsSeen(req.vayoAuth!.memberId, new Date().toISOString());
    res.status(204).end();
  });

  return router;
}
