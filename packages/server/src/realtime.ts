// @vayo/server — the Socket.IO gateway (docs/06-realtime-collaboration.md).
// Presence, live comments, and live overrides — every mutating event also
// goes through the same DB-writing helpers the REST routes use
// (routes/comments.ts's addComment, routes/overrides.ts's applyOverride),
// never instead of them: "Socket.IO is a transport, not a source of truth."
import type { Request } from "express";
import type { Server as SocketIOServer } from "socket.io";
import type { TeamRole } from "@vayo/types";
import { resolveAuth, ROLE_RANK, type AuthResult } from "./auth-middleware.js";
import { addComment } from "./routes/comments.js";
import { applyOverride } from "./routes/overrides.js";
import type { RouteDeps } from "./server-deps.js";

export function attachRealtimeGateway(io: SocketIOServer, { db, sessionSecret, authMiddleware }: RouteDeps): void {
  const presence = new Map<string, Set<string>>();
  // Global "is this member online at all right now" — distinct from
  // `presence` above, which is scoped to *which endpoint* a member is
  // currently viewing. Counts connections rather than storing a boolean:
  // the same member can have several tabs/devices open, and only their
  // LAST socket closing should count as "went offline" (docs/06-realtime-
  // collaboration.md "Presence"). A memberId's absence from this map means
  // "offline" — no entry is ever stored at count 0.
  const onlineCounts = new Map<string, number>();

  io.use(async (socket, next) => {
    const auth = await resolveAuth(
      socket.handshake.headers as { authorization?: string },
      authMiddleware ? (socket.request as unknown as Request) : null,
      db,
      authMiddleware,
      sessionSecret,
    ).catch((): AuthResult | null => null);

    // Standalone mode reads the token from the handshake `auth` payload
    // (docs/06 §"Rooms": "Auth handshake validates session token"), not a
    // header — sockets don't carry an Authorization header by default.
    let resolved = auth;
    if (!resolved && !authMiddleware) {
      const token = socket.handshake.auth?.token as string | undefined;
      if (token) {
        resolved = await resolveAuth({ authorization: `Bearer ${token}` }, null, db, undefined, sessionSecret);
      }
    }

    if (!resolved) {
      next(new Error("unauthorized"));
      return;
    }
    socket.data.memberId = resolved.memberId;
    socket.data.role = resolved.role;
    next();
  });

  io.on("connection", (socket) => {
    const memberId = socket.data.memberId as string;
    const role = socket.data.role as TeamRole;

    socket.join("project");

    // Global online/offline — see onlineCounts' own comment above. Only the
    // FIRST connection for this member flips them online project-wide;
    // later ones (a second tab) just bump the count silently.
    const wasOffline = !onlineCounts.has(memberId);
    onlineCounts.set(memberId, (onlineCounts.get(memberId) ?? 0) + 1);
    if (wasOffline) io.to("project").emit("presence:online", { memberId });
    // Lets a freshly-connected client learn who's ALREADY online without
    // waiting for the next presence:online event — those only fire on a
    // future state change, not for members already connected when this
    // socket joined.
    socket.emit("presence:online-list", { memberIds: [...onlineCounts.keys()] });

    // Re-sent on request, not just once at raw connection time: a UI piece
    // that cares about presence (the Team modal) usually mounts well after
    // the socket itself first connected — e.g. the socket connects the
    // moment the docs app loads, but the Team modal only mounts when the
    // user clicks "Team" minutes later. That component missed the one-time
    // broadcast above, so it needs to be able to ask for a fresh snapshot
    // instead of starting from an empty set and looking like everyone
    // (including the requester's own, definitely-online, connection) is
    // offline until the next unrelated state change happens to fire.
    socket.on("presence:request-online-list", () => {
      socket.emit("presence:online-list", { memberIds: [...onlineCounts.keys()] });
    });

    socket.on("presence:join", ({ vayoId }: { vayoId: string }) => {
      socket.join(`endpoint:${vayoId}`);
      if (!presence.has(vayoId)) presence.set(vayoId, new Set());
      presence.get(vayoId)!.add(memberId);
      io.to(`endpoint:${vayoId}`).emit("presence:join", { vayoId, memberId });
    });

    socket.on("presence:leave", ({ vayoId }: { vayoId: string }) => {
      socket.leave(`endpoint:${vayoId}`);
      presence.get(vayoId)?.delete(memberId);
      io.to(`endpoint:${vayoId}`).emit("presence:leave", { vayoId, memberId });
    });

    socket.on(
      "comment:new",
      async ({
        vayoId,
        body,
        flagged,
        replyToId,
        attachmentIds,
      }: {
        vayoId: string;
        body: string;
        flagged?: boolean;
        replyToId?: string | null;
        attachmentIds?: string[];
      }) => {
        // Every connected socket already passed handshake auth as some team
        // member, and viewer is the lowest rank — this check is here for
        // clarity/symmetry with the other events, not because it can fail today.
        if (ROLE_RANK[role] < ROLE_RANK.viewer) return;
        const comment = await addComment(db, vayoId, memberId, body, flagged ?? false, replyToId ?? null, attachmentIds ?? []);
        for (const v of comment.vayoIds) io.to(`endpoint:${v}`).emit("comment:new", comment);
        if (comment.vayoIds.length > 1) io.to("project").emit("comment:new", comment);
        io.to("project").emit("notification:new", { type: "comment", vayoId });
      },
    );

    socket.on("comment:resolved", async ({ commentId }: { commentId: string }) => {
      if (ROLE_RANK[role] < ROLE_RANK.editor) {
        socket.emit("vayo:error", { event: "comment:resolved", error: "forbidden" });
        return;
      }
      const comment = await db.resolveComment(commentId);
      if (!comment) return;
      for (const v of comment.vayoIds) io.to(`endpoint:${v}`).emit("comment:resolved", { commentId: comment._id });
    });

    socket.on("override:updated", async ({ vayoId, fieldPath, value }: { vayoId: string; fieldPath: string; value: unknown }) => {
      // The one event a viewer-role socket must never be able to trigger,
      // even though the client UI would never normally let them try
      // (docs/05-security.md §6, docs/09-roadmap.md M4 done-when).
      if (ROLE_RANK[role] < ROLE_RANK.editor) {
        socket.emit("vayo:error", { event: "override:updated", error: "forbidden" });
        return;
      }
      const saved = await applyOverride(db, memberId, `${vayoId}.${fieldPath}`, value, null);
      io.to(`endpoint:${vayoId}`).emit("override:updated", { vayoId, fieldPath, value: saved.value, updatedBy: memberId });
      io.to("project").emit("notification:new", { type: "override", vayoId });
    });

    socket.on("disconnect", () => {
      for (const [vayoId, members] of presence) {
        if (members.delete(memberId)) {
          io.to(`endpoint:${vayoId}`).emit("presence:leave", { vayoId, memberId });
        }
      }

      // Only the LAST open socket for this member disconnecting counts as
      // "went offline" — a second tab closing shouldn't flip them offline
      // while the first is still connected.
      const remaining = (onlineCounts.get(memberId) ?? 1) - 1;
      if (remaining <= 0) {
        onlineCounts.delete(memberId);
        const lastSeenAt = new Date().toISOString();
        db.touchTeamMemberLastSeen(memberId, lastSeenAt).catch(() => {
          // Best-effort — a missed lastSeenAt write just means the next
          // disconnect (or the member's next login) overwrites it anyway,
          // not worth surfacing as an unhandled rejection.
        });
        io.to("project").emit("presence:offline", { memberId, lastSeenAt });
      } else {
        onlineCounts.set(memberId, remaining);
      }
    });
  });
}
