// @vayo/server — vayo_comments (Team Chat, docs/06-realtime-collaboration.md).
import { Router } from "express";
import { z } from "zod";
import type { AuditAction, CommentDoc, VayoDbAdapter } from "@vayo/types";
import { requireRole, type VayoAuthedRequest } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import type { RouteDeps } from "../server-deps.js";

const commentBodySchema = z.object({
  vayoId: z.string().min(1),
  body: z.string().min(1),
  flagged: z.boolean().optional(),
  replyToId: z.string().nullable().optional(),
  attachmentIds: z.array(z.string()).optional(),
});

const commentFlagBodySchema = z.object({
  flagged: z.boolean(),
});

/** `@[Display Name](memberId)` — the raw form a mention is stored in, chosen
 * over freeform "@Jane Smith" text matching so a mention is unambiguous
 * even with duplicate first names, and rendering doesn't need the full
 * member list to know which teammate a token refers to. */
const MENTION_PATTERN = /@\[([^\]]+)\]\(([^)]+)\)/g;
export function extractMentionedMemberIds(body: string): string[] {
  return [...body.matchAll(MENTION_PATTERN)].map((m) => m[2]!);
}

/** `#[path](vayoId)` — same idea as `@mention`, one sigil over for endpoints
 * instead of people. A message tagging 2+ distinct vayoIds this way (plus
 * whichever endpoint it was posted from) is what makes it "cross-cutting" —
 * shown in every tagged endpoint's own Team Chat tab and in the header's
 * cross-endpoint chat drawer, not just the one it was sent from. */
const ENDPOINT_TAG_PATTERN = /#\[([^\]]+)\]\(([^)]+)\)/g;
export function extractTaggedVayoIds(body: string): string[] {
  return [...body.matchAll(ENDPOINT_TAG_PATTERN)].map((m) => m[2]!);
}

/** Shared by the REST route below and the `comment:new` socket handler
 * (realtime.ts) — same reasoning as applyOverride (routes/overrides.ts). */
export async function addComment(
  db: VayoDbAdapter,
  vayoId: string,
  authorId: string,
  body: string,
  flagged: boolean,
  replyToId: string | null,
  attachmentIds: string[] = [],
): Promise<CommentDoc> {
  const now = new Date().toISOString();
  // vayoId is the endpoint this was posted from (always present); any
  // #[path](vayoId) tokens typed inline add further endpoints, making this
  // comment "cross-cutting" the moment there's more than one distinct id.
  const vayoIds = [...new Set([vayoId, ...extractTaggedVayoIds(body)])];
  const comment = await db.createComment({ vayoIds, authorId, body, replyToId, flagged, resolved: false, createdAt: now });
  if (attachmentIds.length > 0) {
    await db.claimAttachments(comment._id, attachmentIds, authorId);
  }
  await db.appendAuditLog({
    actorId: authorId,
    actorType: "human",
    action: "comment" satisfies AuditAction,
    targetId: vayoId,
    fieldPath: null,
    diff: { before: null, after: comment.body },
    at: now,
  });
  const snippet = body.length > 60 ? `${body.slice(0, 60)}…` : body;
  await db.createNotification({
    type: "comment",
    vayoId,
    actorId: authorId,
    message: `commented: "${snippet}"`,
    mentionedMemberIds: extractMentionedMemberIds(body),
    targetId: comment._id,
    createdAt: now,
  });
  return comment;
}

export function createCommentsRouter({ db, io }: RouteDeps): Router {
  const router = autoCatchAsyncErrors(Router());

  // Registered before the parameterized :vayoId route below it, otherwise
  // Express would match the literal path segment "cross-cutting" as if it
  // were a vayoId.
  router.get("/api/comments/cross-cutting", requireRole("viewer"), async (req, res) => {
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
    const comments = await db.listCrossCuttingComments(Number.isFinite(limit) && limit > 0 ? limit : 50);
    res.json(comments);
  });

  router.get("/api/comments/:vayoId", requireRole("viewer"), async (req, res) => {
    const comments = await db.listComments(req.params.vayoId!);
    res.json(comments);
  });

  router.post("/api/comments", requireRole("viewer"), async (req: VayoAuthedRequest, res) => {
    const parsed = commentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const comment = await addComment(
      db,
      parsed.data.vayoId,
      req.vayoAuth!.memberId,
      parsed.data.body,
      parsed.data.flagged ?? false,
      parsed.data.replyToId ?? null,
      parsed.data.attachmentIds ?? [],
    );
    for (const vayoId of comment.vayoIds) io.to(`endpoint:${vayoId}`).emit("comment:new", comment);
    // Everyone's socket already joins "project" (used for notification:new
    // below) — reusing it here means the header's cross-endpoint chat
    // drawer can live-update with no new room to track, without also
    // spamming that room for the common single-endpoint case.
    if (comment.vayoIds.length > 1) io.to("project").emit("comment:new", comment);
    io.to("project").emit("notification:new", { type: "comment", vayoId: parsed.data.vayoId });
    res.status(201).json(comment);
  });

  router.patch("/api/comments/:id/flag", requireRole("viewer"), async (req, res) => {
    const parsed = commentFlagBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const comment = await db.setCommentFlagged(req.params.id!, parsed.data.flagged);
    if (!comment) {
      res.status(404).json({ error: "not found" });
      return;
    }
    for (const vayoId of comment.vayoIds) {
      io.to(`endpoint:${vayoId}`).emit("comment:flagged", { commentId: comment._id, flagged: comment.flagged });
    }
    res.json(comment);
  });

  router.post("/api/comments/:id/resolve", requireRole("editor"), async (req, res) => {
    const comment = await db.resolveComment(req.params.id!);
    if (!comment) {
      res.status(404).json({ error: "not found" });
      return;
    }
    for (const vayoId of comment.vayoIds) io.to(`endpoint:${vayoId}`).emit("comment:resolved", { commentId: comment._id });
    res.json(comment);
  });

  return router;
}
