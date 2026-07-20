// @vayo/ui — tracks which team members are online right now, and the most
// recent `lastSeenAt` reported for anyone who's gone offline since this
// hook mounted. Global presence (docs/06-realtime-collaboration.md), not
// the per-endpoint `presence:join`/`presence:leave` FolderTree/DetailsTab
// have no need for — this is specifically "is this person online at all,"
// for the Team modal's roster.
import { useEffect, useState } from "react";
import { useSocket } from "../contexts/SocketContext.js";

export interface PresenceState {
  isOnline: (memberId: string) => boolean;
  /** The freshest `lastSeenAt` seen live over the socket for this member
   * since mount, if any — falls back to whatever the roster fetch itself
   * returned when this is `undefined`. */
  lastSeenOverride: (memberId: string) => string | undefined;
}

export function usePresence(): PresenceState {
  const socket = useSocket();
  const [online, setOnline] = useState<Set<string>>(() => new Set());
  const [lastSeen, setLastSeen] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    if (!socket) return;

    const onOnlineList = ({ memberIds }: { memberIds: string[] }) => setOnline(new Set(memberIds));
    const onOnline = ({ memberId }: { memberId: string }) => setOnline((prev) => new Set(prev).add(memberId));
    const onOffline = ({ memberId, lastSeenAt }: { memberId: string; lastSeenAt: string }) => {
      setOnline((prev) => {
        const next = new Set(prev);
        next.delete(memberId);
        return next;
      });
      setLastSeen((prev) => new Map(prev).set(memberId, lastSeenAt));
    };

    socket.on("presence:online-list", onOnlineList);
    socket.on("presence:online", onOnline);
    socket.on("presence:offline", onOffline);
    // The server also pushes this once at raw connection time, but this
    // hook typically mounts well after that (e.g. the socket connects when
    // the docs app loads; the Team modal using this hook only mounts when
    // the user opens it later) — request a fresh snapshot explicitly rather
    // than starting from an empty set and waiting on an unrelated future
    // state change to ever populate it.
    socket.emit("presence:request-online-list");
    return () => {
      socket.off("presence:online-list", onOnlineList);
      socket.off("presence:online", onOnline);
      socket.off("presence:offline", onOffline);
    };
  }, [socket]);

  return {
    isOnline: (memberId) => online.has(memberId),
    lastSeenOverride: (memberId) => lastSeen.get(memberId),
  };
}
