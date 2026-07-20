// apps/demo-app/src/middleware/auth.ts — requireAuth checks only that a
// bearer token is present and stashes it as the caller's role for
// requireRole to consult downstream. Real token verification isn't the
// point of this fixture (same spirit as the rest of demo-app); what matters
// for Vayo is that the middleware chain SHAPE (authenticate-then-authorize)
// is realistic, so its auth-detection (docs/04-capture-engine.md Step 2 #2)
// has real signal to find.

import type { NextFunction, Request, Response } from "express";

declare global {
  namespace Express {
    interface Request {
      user?: { role: string };
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  req.user = { role: header.slice("Bearer ".length) };
  next();
}
