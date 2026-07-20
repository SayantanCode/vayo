// apps/demo-app/src/middleware/roles.ts — requireRole gates a route to a
// set of the demo app's OWN business roles (customer/admin/super_admin) —
// unrelated to Vayo's own viewer/editor/owner doc-collaborator roles.
// Always follows requireAuth in a route's middleware chain, which is what
// makes Vayo's static auth-detection correctly flag these routes as
// protected — requireRole itself isn't a recognized auth-pattern name,
// requireAuth is.

import type { NextFunction, Request, RequestHandler, Response } from "express";

export function requireRole(...roles: string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  };
}
