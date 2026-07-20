// @vayo/server — identity resolution + role gating, shared by every REST
// route and the Socket.IO handshake (docs/05-security.md §4-5). This is the
// one place a request's identity is ever derived — every route handler and
// every socket event handler just reads the result (`req.vayoAuth` /
// `socket.data`), never re-implements auth itself.
import type { NextFunction, Request, Response } from "express";
import type { TeamRole, VayoDbAdapter } from "@vayo/types";
import { createHmac } from "node:crypto";

export interface AuthResult {
  memberId: string;
  role: TeamRole;
}

export interface VayoAuthedRequest extends Request {
  vayoAuth?: AuthResult | null;
}

export const ROLE_RANK: Record<TeamRole, number> = { viewer: 0, editor: 1, owner: 2 };

/**
 * Express middleware factory. `requireRole("editor")` rejects with 401 (no
 * session) or 403 (session present, insufficient role) — never trusts a
 * role claim without the fresh DB re-check already performed by the
 * auth-resolution middleware mounted ahead of every route
 * (docs/05-security.md §4: "a demoted editor loses access on their very
 * next request, not whenever their token happens to expire").
 */
export function requireRole(minRole: TeamRole) {
  return (req: VayoAuthedRequest, res: Response, next: NextFunction): void => {
    const auth = req.vayoAuth ?? null;
    if (!auth) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (ROLE_RANK[auth.role] < ROLE_RANK[minRole]) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  };
}

export function hashToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

export function extractBearerToken(headers: { authorization?: string }): string | null {
  const header = headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/** Re-derives the caller's identity + CURRENT role from the DB on every
 * call — the one function both the REST auth middleware and the socket
 * handshake middleware go through, so the "never trust a stale role claim"
 * rule (docs/05-security.md §4) applies identically to both transports. */
export async function resolveAuth(
  headers: { authorization?: string },
  authMiddlewareInput: Request | null,
  db: VayoDbAdapter,
  authMiddleware: ((req: Request) => AuthResult | null) | undefined,
  sessionSecret: string,
): Promise<AuthResult | null> {
  if (authMiddleware && authMiddlewareInput) {
    const claim = authMiddleware(authMiddlewareInput);
    if (!claim) return null;
    const member = await db.getTeamMember(claim.memberId);
    if (!member || member.status !== "active") return null;
    return { memberId: member._id, role: member.role };
  }

  const token = extractBearerToken(headers);
  if (!token) return null;
  const tokenHash = hashToken(token, sessionSecret);
  const session = await db.getSessionByTokenHash(tokenHash);
  if (!session || Date.parse(session.expiresAt) < Date.now()) return null;
  const member = await db.getTeamMember(session.memberId);
  if (!member || member.status !== "active") return null;
  return { memberId: member._id, role: member.role };
}
