// @vayo/server — centralized async error handling.
//
// Express 4 (this package's pinned version — 08-packages-and-repo-structure.md
// on why v4, not v5) does NOT catch a rejected promise thrown inside an
// `async (req, res) => {...}` route handler. Left alone, a DB call that
// rejects inside any route handler here either hangs the request forever (no
// response ever gets sent) or crashes the process with an unhandled
// rejection — neither is "the caller gets a clean error," which
// 05-security.md assumes every route already does.
//
// Rather than thread a manual try/catch (or an asyncHandler(...) wrapper)
// through every individual route registration by hand, autoCatchAsyncErrors
// patches the router's own get/post/put/patch/delete methods once, so every
// route @vayo/server registers — present and future — is covered
// automatically, with no route author able to forget it.
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";

const WRAPPED_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Call once, immediately after creating the router and before registering
 * any routes on it. Safe to call on a router that also carries non-async
 * middleware (auth resolution, multer, requireRole, rate limiters) — a
 * handler that never returns a promise just resolves on the next microtask
 * after calling `next()`/`res.json()` itself, a negligible cost for
 * blanket correctness. */
export function autoCatchAsyncErrors(router: Router): Router {
  for (const method of WRAPPED_METHODS) {
    const original = (router[method] as (...args: unknown[]) => Router).bind(router);
    (router as unknown as Record<string, unknown>)[method] = (path: unknown, ...handlers: RequestHandler[]) => {
      const wrapped = handlers.map(
        (handler) =>
          ((req: Request, res: Response, next: NextFunction) => {
            Promise.resolve(handler(req, res, next)).catch(next);
          }) as RequestHandler,
      );
      return original(path, ...wrapped);
    };
  }
  return router;
}

/** Registered once, last, after every route and the static-asset/SPA-shell
 * block — anything that reaches here already failed to produce its own
 * response. Logs the real error server-side but never leaks internals to
 * the client (05-security.md §7). `res.headersSent` guards the rare case
 * where a handler partially wrote a response before throwing. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  console.error("vayo: unhandled error in route handler:", err);
  res.status(500).json({ error: "internal server error" });
}
