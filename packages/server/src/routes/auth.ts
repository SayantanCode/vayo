// @vayo/server — standalone auth mode (docs/05-security.md §5): login,
// logout, and session introspection. Meaningless in delegated auth mode
// (the host app owns sessions), so /api/auth/login 404s there instead of
// silently doing nothing.
import { randomBytes } from "node:crypto";
import { Router, type RequestHandler } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { hashToken, extractBearerToken, requireRole, type VayoAuthedRequest } from "../auth-middleware.js";
import { autoCatchAsyncErrors } from "../error-handling.js";
import type { RouteDeps } from "../server-deps.js";

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createAuthRouter({ db, sessionSecret, authMiddleware }: RouteDeps, authRateLimiter: RequestHandler): Router {
  const router = autoCatchAsyncErrors(Router());

  // In delegated mode, login is meaningless — the host app owns sessions.
  router.post("/api/auth/login", authRateLimiter, async (req, res) => {
    if (authMiddleware) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid body", details: parsed.error.issues });
      return;
    }
    const member = await db.getTeamMemberByEmail(parsed.data.email);
    if (!member?.passwordHash) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    const ok = await bcrypt.compare(parsed.data.password, member.passwordHash);
    if (!ok) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken, sessionSecret);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await db.createSession({ memberId: member._id, tokenHash, expiresAt });
    // The raw token is returned exactly once, here — only its hash is ever
    // stored (docs/05-security.md §5).
    res.json({
      token: rawToken,
      expiresAt,
      member: { id: member._id, name: member.name, role: member.role, avatarUrl: member.avatarUrl, nicknames: member.nicknames ?? {} },
    });
  });

  router.post("/api/auth/logout", async (req, res) => {
    const token = extractBearerToken(req.headers);
    if (token) await db.deleteSession(hashToken(token, sessionSecret));
    res.status(204).end();
  });

  // ---- session introspection (lets the UI know who it's logged in as) ----
  router.get("/api/me", requireRole("viewer"), async (req: VayoAuthedRequest, res) => {
    const member = await db.getTeamMember(req.vayoAuth!.memberId);
    if (!member) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({
      id: member._id,
      name: member.name,
      email: member.email,
      role: member.role,
      avatarUrl: member.avatarUrl,
      nicknames: member.nicknames ?? {},
    });
  });

  return router;
}
