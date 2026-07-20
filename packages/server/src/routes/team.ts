// @vayo/server — team membership, invites (single/bulk/list/revoke), role
// and self-service name changes, and accept-invite. The single largest
// resource — team administration is the entirety of what the `owner` role
// is for (docs/05-security.md §4) — but still one cohesive resource, not
// several bundled together.
import { randomBytes } from "node:crypto";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import bcrypt from "bcrypt";
import multer from "multer";
import { z } from "zod";
import { MAX_AVATAR_BYTES, type TeamRole, type VayoDbAdapter } from "@vayo/types";
import { hashToken, requireRole, type VayoAuthedRequest } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import type { RouteDeps } from "../server-deps.js";

const AVATAR_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AVATAR_BYTES } });

const inviteBodySchema = z.object({
  email: z.string().email(),
  role: z.enum(["editor", "viewer"]),
});

// Capped well above any real team's onboarding batch — guards against one
// request creating an unbounded number of invite documents, not against a
// realistic use case (the whole point is "invite my frontend team at once,"
// not "invite ten thousand people").
const MAX_BULK_INVITES = 50;

const inviteBulkBodySchema = z.object({
  emails: z.array(z.string().email()).min(1).max(MAX_BULK_INVITES),
  role: z.enum(["editor", "viewer"]),
});

const teamRoleBodySchema = z.object({
  role: z.enum(["owner", "editor", "viewer"]),
});

const teamNameBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
});

// `null`/empty-string both mean "clear it" — an empty text field is the
// natural way a user expresses "I don't want a custom nickname for them
// anymore," not a distinct error case from explicitly passing null.
const nicknameBodySchema = z.object({
  nickname: z.string().trim().max(200).nullable(),
});

const acceptInviteBodySchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1),
  password: z.string().min(8),
});

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Shared by the single-invite and bulk-invite routes — same reasoning as
 * addComment/applyOverride elsewhere in routes/. */
async function createOneInvite(
  db: VayoDbAdapter,
  sessionSecret: string,
  email: string,
  role: Exclude<TeamRole, "owner">,
  createdBy: string,
): Promise<{ token: string; email: string; role: TeamRole; expiresAt: string }> {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken, sessionSecret);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const invite = await db.createInvite({ email, role, tokenHash, createdBy, expiresAt, usedAt: null });
  await db.appendAuditLog({
    actorId: createdBy,
    actorType: "human",
    action: "invite",
    targetId: invite._id,
    fieldPath: null,
    diff: { before: null, after: { email: invite.email, role: invite.role } },
    at: new Date().toISOString(),
  });
  // Raw token returned exactly once — the inviter shares it themselves;
  // Vayo cannot regenerate a lost invite link (docs/05-security.md §5).
  return { token: rawToken, email: invite.email, role: invite.role, expiresAt: invite.expiresAt };
}

export function createTeamRouter({ db, sessionSecret }: RouteDeps, inviteRateLimiter: RequestHandler): Router {
  const router = autoCatchAsyncErrors(Router());

  router.get("/api/team", requireRole("viewer"), async (_req, res) => {
    const members = await db.listTeamMembers();
    // passwordHash is never included in any API response, including to
    // owner-role callers (docs/05-security.md §5). nicknames is each
    // member's own private "how I refer to others" book — nobody else's
    // business, not even an owner's; GET /api/me returns the caller's own.
    res.json(members.map(({ passwordHash: _passwordHash, nicknames: _nicknames, ...member }) => member));
  });

  router.post("/api/team/invite", requireRole("owner"), inviteRateLimiter, async (req: VayoAuthedRequest, res) => {
    const parsed = inviteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const result = await createOneInvite(db, sessionSecret, parsed.data.email, parsed.data.role, req.vayoAuth!.memberId);
    res.status(201).json(result);
  });

  // Batches CREATION of several same-role invites into one request — still
  // one single-use, individually-revocable token per email underneath (not
  // a Slack-style reusable "anyone with this link" invite), so inviting a
  // whole team at once no longer means repeating the single-invite flow by
  // hand for every person (docs/09-roadmap.md).
  router.post("/api/team/invite/bulk", requireRole("owner"), inviteRateLimiter, async (req: VayoAuthedRequest, res) => {
    const parsed = inviteBulkBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const uniqueEmails = [...new Set(parsed.data.emails)];
    const results = await Promise.all(
      uniqueEmails.map((email) => createOneInvite(db, sessionSecret, email, parsed.data.role, req.vayoAuth!.memberId)),
    );
    res.status(201).json(results);
  });

  router.patch("/api/team/:memberId/role", requireRole("owner"), async (req: VayoAuthedRequest, res) => {
    const parsed = teamRoleBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    // Never let an owner strip their own last line of ownership by
    // accident through this endpoint — same reasoning as not letting a
    // client-supplied role claim be trusted (docs/05-security.md §4), just
    // applied to self-service instead of a stolen token.
    if (req.params.memberId === req.vayoAuth!.memberId) {
      res.status(400).json({ error: "cannot change your own role" });
      return;
    }
    const before = await db.getTeamMember(req.params.memberId!);
    const updated = await db.updateTeamMemberRole(req.params.memberId!, parsed.data.role);
    if (!updated) {
      res.status(404).json({ error: "not found" });
      return;
    }
    await db.appendAuditLog({
      actorId: req.vayoAuth!.memberId,
      actorType: "human",
      action: "role_change",
      targetId: updated._id,
      fieldPath: "role",
      diff: { before: before?.role ?? null, after: updated.role },
      at: new Date().toISOString(),
    });
    res.json({ id: updated._id, email: updated.email, name: updated.name, role: updated.role });
  });

  // A private label for how the CALLER refers to :memberId — never
  // touches :memberId's own doc, only the caller's own `nicknames` map, so
  // this is open to any authenticated member (viewer+), not owner-gated
  // like the role/removal routes above that actually act on someone else's
  // account. Same idea as a chat app's per-contact nickname: you might know
  // a colleague as "Team Lead," and that's yours to set regardless of what
  // they or anyone else calls them.
  router.patch("/api/team/:memberId/nickname", requireRole("viewer"), async (req: VayoAuthedRequest, res) => {
    const parsed = nicknameBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const target = await db.getTeamMember(req.params.memberId!);
    if (!target) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const nickname = parsed.data.nickname && parsed.data.nickname.length > 0 ? parsed.data.nickname : null;
    const updatedCaller = await db.setNicknameForMember(req.vayoAuth!.memberId, req.params.memberId!, nickname);
    res.json({ nicknames: updatedCaller?.nicknames ?? {} });
  });

  // Self-service display-name edit — the invitee picks their own name at
  // accept-invite time in the first place, so an owner never sets someone
  // else's name; this is the same self-authorship applied to changing it
  // later. Any authenticated member may rename themselves, hence "me"
  // rather than an owner-gated /:memberId route.
  router.patch("/api/team/me/name", requireRole("viewer"), async (req: VayoAuthedRequest, res) => {
    const parsed = teamNameBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const updated = await db.updateTeamMemberName(req.vayoAuth!.memberId, parsed.data.name);
    if (!updated) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ id: updated._id, email: updated.email, name: updated.name, role: updated.role });
  });

  // Self-service avatar set — same self-authorship reasoning as the name
  // route above. Stored inline as a base64 data: URI on the member doc
  // itself (see TeamMemberDoc.avatarUrl's own comment for why, not a
  // vayo_attachments reference), so this returns immediately usable as an
  // <img src>, no separate download route to hit afterward.
  router.patch(
    "/api/team/me/avatar",
    requireRole("viewer"),
    (req: Request, res: Response, next: NextFunction) => {
      avatarUpload.single("avatar")(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({ error: `image too large — max ${Math.round(MAX_AVATAR_BYTES / 1024)}KB` });
          return;
        }
        if (err) {
          res.status(400).json({ error: "upload failed" });
          return;
        }
        next();
      });
    },
    async (req: VayoAuthedRequest, res) => {
      if (!req.file) {
        res.status(400).json({ error: "no image uploaded" });
        return;
      }
      if (!AVATAR_MIME_TYPES.has(req.file.mimetype)) {
        res.status(400).json({ error: "unsupported image type — use PNG, JPEG, WebP, or GIF" });
        return;
      }
      const avatarUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      const updated = await db.updateTeamMemberAvatar(req.vayoAuth!.memberId, avatarUrl);
      if (!updated) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json({ id: updated._id, email: updated.email, name: updated.name, role: updated.role, avatarUrl: updated.avatarUrl });
    },
  );

  router.delete("/api/team/me/avatar", requireRole("viewer"), async (req: VayoAuthedRequest, res) => {
    const updated = await db.updateTeamMemberAvatar(req.vayoAuth!.memberId, null);
    if (!updated) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ id: updated._id, email: updated.email, name: updated.name, role: updated.role, avatarUrl: updated.avatarUrl });
  });

  // Removes a member's access outright — for the "wrong person got invited
  // and joined" case this whole route exists for. Hard-deletes the
  // vayo_team_members doc: resolveAuth's existing "!member" check (the same
  // one that already makes a demoted editor lose access on their very next
  // request, docs/05-security.md §4) rejects them immediately, with no
  // separate revocation mechanism needed. Their past comments/audit-log
  // entries/notifications are left untouched — non-destructive, same
  // principle as overrides never erasing a manual edit — and render as
  // "Former member" in the UI wherever their name would have appeared.
  //
  // No separate "can't remove the last owner" guard is needed: this route
  // requires the *caller* to already be an owner, so if only one owner
  // exists at all, that owner is the caller — and the self-removal check
  // right below already blocks that. The team can never reach zero owners
  // through this route (same reasoning already applies to the role-change
  // route's own "can't change your own role" guard above).
  router.delete("/api/team/:memberId", requireRole("owner"), async (req: VayoAuthedRequest, res) => {
    const memberId = req.params.memberId!;
    if (memberId === req.vayoAuth!.memberId) {
      res.status(400).json({ error: "cannot remove yourself" });
      return;
    }
    const target = await db.getTeamMember(memberId);
    if (!target) {
      res.status(404).json({ error: "not found" });
      return;
    }
    await db.deleteTeamMember(memberId);
    await db.deleteSessionsByMemberId(memberId);
    await db.appendAuditLog({
      actorId: req.vayoAuth!.memberId,
      actorType: "human",
      action: "member_removed",
      targetId: memberId,
      fieldPath: null,
      diff: { before: { email: target.email, name: target.name, role: target.role }, after: null },
      at: new Date().toISOString(),
    });
    res.status(204).end();
  });

  // Outstanding invites an owner hasn't revoked yet — the other half of
  // "wrong person got invited": catching the mistake *before* it's ever
  // accepted, rather than only after (that's the DELETE above).
  router.get("/api/team/invites", requireRole("owner"), async (_req, res) => {
    const invites = await db.listPendingInvites();
    res.json(invites.map(({ tokenHash: _tokenHash, ...invite }) => invite));
  });

  router.delete("/api/team/invites/:inviteId", requireRole("owner"), async (req: VayoAuthedRequest, res) => {
    const revoked = await db.revokeInvite(req.params.inviteId!);
    if (!revoked) {
      res.status(404).json({ error: "not found, or already used" });
      return;
    }
    await db.appendAuditLog({
      actorId: req.vayoAuth!.memberId,
      actorType: "human",
      action: "invite_revoked",
      targetId: req.params.inviteId!,
      fieldPath: null,
      diff: { before: { email: revoked.email, role: revoked.role }, after: null },
      at: new Date().toISOString(),
    });
    res.status(204).end();
  });

  router.post("/api/team/accept-invite", async (req, res) => {
    const parsed = acceptInviteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const tokenHash = hashToken(parsed.data.token, sessionSecret);
    const invite = await db.getInviteByTokenHash(tokenHash);
    if (!invite || invite.usedAt || Date.parse(invite.expiresAt) < Date.now()) {
      res.status(400).json({ error: "invalid or expired invite" });
      return;
    }
    // Atomic check-and-set: if two people race to redeem the same link,
    // only one of these succeeds (docs/05-security.md §5).
    const marked = await db.markInviteUsed(tokenHash, new Date().toISOString());
    if (!marked) {
      res.status(409).json({ error: "invite already used" });
      return;
    }
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const member = await db.createTeamMember({
      email: invite.email,
      name: parsed.data.name,
      role: invite.role,
      passwordHash,
      status: "active",
      invitedBy: invite.createdBy,
      createdAt: new Date().toISOString(),
      lastSeenNotificationsAt: null,
      avatarUrl: null,
      lastSeenAt: null,
      nicknames: {},
    });
    res.status(201).json({ id: member._id, email: member.email, role: member.role });
  });

  return router;
}
