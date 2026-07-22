// @vayo/ui — header bell: the notification center for real changes across
// the whole API surface (docs/06-realtime-collaboration.md "Notifications").
// Automatic-only for v1 — overrides, schema changes, comments, version
// status changes. No hand-authored announcements (a deliberate scope call).

import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import type { NotificationDoc, NotificationType } from "@vayo/types";
import { api } from "../api.js";
import type { EndpointSummary } from "../types.js";
import { timeAgo } from "../time-format.js";
import { useDismiss } from "../hooks/useDismiss.js";
import { useConfig } from "../contexts/ConfigContext.js";
import { useSocket } from "../contexts/SocketContext.js";

interface NotificationBellProps {
  endpoints: EndpointSummary[];
  memberNames: Record<string, string>;
  currentMemberId: string;
  /** `targetId` means something different per `type` — see `NotificationDoc`
   * (comment id, override's own compound targetId, or null). The caller
   * decides what "jump to and highlight" means for each. */
  onNavigate: (vayoId: string, type: NotificationType, targetId: string | null) => void;
}

export function NotificationBell({ endpoints, memberNames, currentMemberId, onNavigate }: NotificationBellProps): JSX.Element {
  const config = useConfig();
  const socket = useSocket();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationDoc[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, () => setOpen(false), open);

  function refresh() {
    api
      .listNotifications(config)
      .then((result) => {
        setItems(result.items);
        setUnreadCount(result.unreadCount);
      })
      .catch(() => {});
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [config.baseUrl, config.token]);

  useEffect(() => {
    if (!socket) return;
    const onNotificationNew = () => refresh();
    socket.on("notification:new", onNotificationNew);
    return () => {
      socket.off("notification:new", onNotificationNew);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  function toggleOpen() {
    setOpen((wasOpen) => {
      const nowOpen = !wasOpen;
      if (nowOpen && unreadCount > 0) {
        api.markNotificationsSeen(config).catch(() => {});
        setUnreadCount(0);
      }
      return nowOpen;
    });
  }

  return (
    <div className="notification-bell" ref={ref}>
      <button type="button" className="notification-bell__trigger" onClick={toggleOpen} title="Notifications">
        <Bell size={16} />
        {unreadCount > 0 && <span className="notification-bell__badge">{unreadCount > 9 ? "9+" : unreadCount}</span>}
      </button>
      {open && (
        <div className="notification-bell__menu">
          <div className="notification-bell__heading">Notifications</div>
          {items.length === 0 && <p className="muted notification-bell__empty">Nothing yet — changes across your API show up here.</p>}
          {items.map((item) => {
            const endpoint = item.vayoId ? endpoints.find((e) => e.vayoId === item.vayoId) : undefined;
            const actor = item.actorId === currentMemberId ? "You" : (item.actorId ? (memberNames[item.actorId] ?? "Former member") : null);
            // Defensive: notifications created before this field existed
            // have no mentionedMemberIds at all, not just an empty array.
            const mentionsMe = (item.mentionedMemberIds ?? []).includes(currentMemberId);
            return (
              <button
                type="button"
                key={item._id}
                className={`notification-bell__item ${mentionsMe ? "notification-bell__item--mention" : ""}`}
                disabled={!item.vayoId}
                onClick={() => {
                  if (item.vayoId) {
                    onNavigate(item.vayoId, item.type, item.targetId);
                    setOpen(false);
                  }
                }}
              >
                {mentionsMe && <span className="badge badge--flagged notification-bell__item-mention-badge">mentioned you</span>}
                <div className="notification-bell__item-message">
                  {actor && <strong>{actor} </strong>}
                  {item.message}
                </div>
                {endpoint && (
                  <div className="notification-bell__item-endpoint muted">
                    {endpoint.method} {endpoint.path}
                  </div>
                )}
                <div className="notification-bell__item-time muted">{timeAgo(item.createdAt)}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
