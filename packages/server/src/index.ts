// @vayo/server
// REST API + Socket.IO gateway + static UI hosting.
// Every mutating route MUST be wrapped in requireRole — docs/05-security.md §4.
// Realtime event contract — docs/06-realtime-collaboration.md.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { Server as SocketIOServer } from "socket.io";
import { type VayoDbAdapter } from "@vayo/types";
import { autoCatchAsyncErrors, errorHandler } from "./error-handling.js";
import { resolveAuth } from "./auth-middleware.js";
import type { AuthResult, VayoAuthedRequest } from "./auth-middleware.js";
import type { RouteDeps } from "./server-deps.js";
import { attachRealtimeGateway } from "./realtime.js";
import { createCoverageRouter } from "./routes/coverage.js";
import { createNotificationsRouter } from "./routes/notifications.js";
import { createEnvironmentsRouter } from "./routes/environments.js";
import { createSettingsRouter } from "./routes/settings.js";
import { createExamplesRouter } from "./routes/examples.js";
import { createTestScriptsRouter } from "./routes/test-scripts.js";
import { createFlowsRouter } from "./routes/flows.js";
import { createExportRouter } from "./routes/export.js";
import { createVersionsRouter } from "./routes/versions.js";
import { createOverridesRouter } from "./routes/overrides.js";
import { createFoldersRouter } from "./routes/folders.js";
import { createEndpointsRouter } from "./routes/endpoints.js";
import { createHistoryRouter } from "./routes/history.js";
import { createCommentsRouter } from "./routes/comments.js";
import { createAttachmentsRouter } from "./routes/attachments.js";
import { createAuthRouter } from "./routes/auth.js";
import { createTeamRouter } from "./routes/team.js";

// Re-exported so vayo's `vayo export --format postman` can compile a
// collection directly against the DB, without needing a running server —
// the same reason `compile`/`diffSpecs` from @vayo/openapi-compiler are
// already usable that way (both re-exported the same way from
// routes/versions.js's own dependencies).
export { compilePostmanCollection, compilePostmanEnvironment } from "./postman-export.js";
export { requireRole } from "./auth-middleware.js";
export type { AuthResult, VayoAuthedRequest } from "./auth-middleware.js";

export interface ServerOptions {
  db: VayoDbAdapter;
  /** Delegated auth (docs/05-security.md §5): validates the host app's
   * existing session against a claim of *who* the caller is. The *role* is
   * never trusted from this claim directly — every request re-reads the
   * member's current role from `vayo_team_members` (docs §4). Omit to use
   * standalone auth (`POST /api/auth/login` + `vayo_sessions`) instead. */
  authMiddleware?: (req: Request) => AuthResult | null;
  /** default "/vayo" — for in-process mounting on the user's own app. */
  mountPath?: string;
  /** HMAC key for hashing session + invite tokens (docs/05-security.md §5:
   * raw tokens are never stored). Required in BOTH auth modes — invites are
   * always managed by Vayo's own `vayo_team_members`/`vayo_invites` even
   * when login itself is delegated elsewhere. Falls back to
   * `process.env.VAYO_SESSION_SECRET`. */
  sessionSecret?: string;
  /** CORS is same-origin-only by default (docs/05-security.md §7) — this is
   * additive, explicit opt-in for cross-origin access. */
  corsOrigins?: string[];
  /** Provide your own already-created `http.Server` (the one behind your
   * own Express app) to mount Vayo directly into it — no second port, no
   * separate `.listen()` call, the same one-liner ergonomics as
   * `app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec))`:
   *
   * ```ts
   * const { app: vayoApp, httpServer } = createServer({ db, mountPath: "/docs", httpServer: myHttpServer });
   * myExpressApp.use(vayoApp); // no path needed — vayoApp already only answers under mountPath
   * ```
   *
   * Omit for today's fully-standalone behavior (what `vayo serve` does): a
   * dedicated `app` + `httpServer` that the caller `.listen()`s separately,
   * on its own port. */
  httpServer?: HttpServer;
  /** Socket.IO's own listen path — defaults to `${mountPath}/socket.io`,
   * not Engine.IO's bare `/socket.io` default. Deliberately namespaced
   * under `mountPath`: since that's already guaranteed distinct from
   * whatever paths the host app uses for itself, this makes an accidental
   * collision with the host's *own* WebSocket/Socket.IO server (almost
   * always still sitting at ITS default path) unlikely without either side
   * doing anything extra. Override directly if the default still collides
   * with something. */
  socketPath?: string;
}

export interface VayoServerHandle {
  app: express.Express;
  io: SocketIOServer;
  /** Not in the shape sketched in docs/08-packages-and-repo-structure.md —
   * added because Socket.IO must attach to the actual `http.Server` that
   * ends up listening, and calling `app.listen()` instead (the only option
   * with just `app`) creates a *second*, disconnected server that Socket.IO
   * was never attached to. Callers must call `httpServer.listen(port)`,
   * never `app.listen(port)` — unless `options.httpServer` was provided, in
   * which case this is just that same object handed back, already the
   * caller's own responsibility to listen on. */
  httpServer: HttpServer;
}

/** `${mountPath}/socket.io`, not Engine.IO's bare `/socket.io` default —
 * namespaced under mountPath so it doesn't collide with a host app's own
 * Socket.IO server (almost certainly still at ITS default path) when both
 * share one httpServer (`options.httpServer`, above). Normalizes a root
 * mountPath ("/" or "") so the result is never a doubled slash. Duplicated
 * in @vayo/ui's socket.ts — same reasoning as routes/comments.ts's
 * extractMentionedMemberIds/extractTaggedVayoIds: the two packages don't
 * depend on each other, and a string transform this small isn't worth
 * sharing a package over. */
function defaultSocketPath(mountPath: string): string {
  const trimmed = mountPath === "/" ? "" : mountPath.replace(/\/$/, "");
  return `${trimmed}/socket.io`;
}

export function createServer(options: ServerOptions): VayoServerHandle {
  const sessionSecret = options.sessionSecret ?? process.env.VAYO_SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error(
      "@vayo/server: sessionSecret (or VAYO_SESSION_SECRET env var) is required in both auth modes — used to HMAC-hash session and invite tokens (docs/05-security.md §5).",
    );
  }

  const db = options.db;
  const mountPath = options.mountPath ?? "/vayo";
  const corsOrigins = options.corsOrigins ?? [];
  const socketPath = options.socketPath ?? defaultSocketPath(mountPath);

  const app = express();
  const httpServer = options.httpServer ?? createHttpServer(app);
  // A heuristic, not a certainty: Node only lets us see THAT an 'upgrade'
  // listener already exists on this httpServer, not what path it answers
  // to — but 'upgrade' listeners are rare enough (almost always a
  // WebSocket-family library) that seeing one here, on an httpServer the
  // caller brought with them, is worth a loud warning rather than a silent
  // maybe-works. Only checked in this mode: a freshly-created httpServer
  // (the default, no `options.httpServer`) can't possibly have one yet.
  if (options.httpServer && httpServer.listeners("upgrade").length > 0) {
    console.warn(
      `vayo: the httpServer passed to createServer() already has a WebSocket/upgrade handler attached. ` +
        `Vayo's realtime gateway will listen at Socket.IO path "${socketPath}" on this same httpServer — if your ` +
        `own WebSocket/Socket.IO server also uses that exact path, connections from one will be dropped or ` +
        `misrouted. Pass a distinct \`socketPath\` (or \`mountPath\`) to createServer() to rule this out for good.`,
    );
  }
  // Socket.IO's handshake (and its polling-transport fallback) is subject
  // to CORS independently of Express's own middleware below — needs the
  // same allow-list, same same-origin-by-default reasoning.
  const io = new SocketIOServer(httpServer, {
    path: socketPath,
    ...(corsOrigins.length > 0 ? { cors: { origin: corsOrigins, credentials: true } } : {}),
  });

  // Per-request nonce for the one inline <script> the SPA shell injects
  // (window.__VAYO_MOUNT_PATH__, below) — lets script-src stay 'self'-only
  // instead of the much weaker 'unsafe-inline'. Must run before helmet so
  // res.locals.cspNonce already exists when helmet's directive functions read it.
  app.use((_req, res, next) => {
    res.locals.cspNonce = randomBytes(16).toString("hex");
    next();
  });

  // Baseline security headers (docs/05-security.md §7) — HSTS, X-Frame-Options,
  // X-Content-Type-Options, and a real CSP: this server serves real HTML/JS/CSS
  // today (the static-asset + SPA-shell block below), so a content policy is
  // not inert — script-src is 'self' plus the per-request nonce above;
  // style-src additionally allows 'unsafe-inline' because React's own
  // `style={{...}}` props compile to inline style attributes, a standard,
  // much-lower-severity relaxation than allowing inline scripts (which stays
  // strict). Cast (through `unknown`, as TS's own error suggests): helmet
  // types its middleware against bare Node http types
  // (IncomingMessage/ServerResponse), not Express's Request/Response. These
  // are normally structurally compatible via Request extends IncomingMessage,
  // but the currently resolved @types/node added an IncomingMessage.signal
  // property that @types/express-serve-static-core's Request doesn't declare
  // — an upstream types-package version skew, not a real runtime
  // incompatibility (helmet only ever reads/writes response headers).
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Untyped params, cast inside: helmet's directive-function type is
          // checked against bare node:http types (IncomingMessage/ServerResponse),
          // not Express's Request/Response — the same types-package skew the
          // comment above the outer `as unknown as express.RequestHandler`
          // cast already describes, surfacing here too since `res.locals` is
          // an Express-only extension bare ServerResponse doesn't declare.
          scriptSrc: ["'self'", (_req, res) => `'nonce-${(res as unknown as Response).locals.cspNonce as string}'`],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          fontSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'self'"],
        },
      },
    }) as unknown as express.RequestHandler,
  );

  app.use(express.json());

  // CORS: same-origin-only by default (docs/05-security.md §7) — a browser
  // already enforces that with no CORS headers at all, so this middleware
  // only ever ADDS permission, for explicitly configured origins.
  if (corsOrigins.length > 0) {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && corsOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      }
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }

  const router = autoCatchAsyncErrors(express.Router());

  // Resolves req.vayoAuth for every route below — the ONLY place identity
  // is derived from a request; every route handler just reads req.vayoAuth.
  router.use(async (req: VayoAuthedRequest, _res, next) => {
    // Query-param token fallback, scoped ONLY to the attachment download
    // route: an <img>/<video>/<a> tag can't set an Authorization header,
    // and that's the one route a real HTML media embed needs to hit
    // directly. Every other route still requires the header — a bearer
    // token in a URL is more exposed (server logs, browser history) than
    // one in a header, so this isn't widened beyond the one place that
    // genuinely needs it.
    const isAttachmentDownload = /^\/api\/attachments\/[^/]+\/download$/.test(req.path);
    const headers =
      isAttachmentDownload && !req.headers.authorization && typeof req.query.token === "string"
        ? { authorization: `Bearer ${req.query.token}` }
        : req.headers;
    req.vayoAuth = await resolveAuth(headers, req, db, options.authMiddleware, sessionSecret);
    next();
  });

  const authRateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
  const inviteRateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

  // Every resource router below receives the same small dependency bag —
  // db/sessionSecret/io — rather than each reaching into createServer()'s
  // own closure (server-deps.ts).
  const deps: RouteDeps = { db, sessionSecret, io, authMiddleware: options.authMiddleware };
  router.use(createAuthRouter(deps, authRateLimiter));
  router.use(createTeamRouter(deps, inviteRateLimiter));
  router.use(createCoverageRouter(deps));
  router.use(createNotificationsRouter(deps));
  router.use(createEnvironmentsRouter(deps));
  router.use(createSettingsRouter(deps));
  router.use(createExamplesRouter(deps));
  router.use(createTestScriptsRouter(deps));
  router.use(createFlowsRouter(deps));
  router.use(createExportRouter(deps));
  router.use(createVersionsRouter(deps));
  router.use(createOverridesRouter(deps));
  router.use(createFoldersRouter(deps));
  router.use(createEndpointsRouter(deps));
  router.use(createHistoryRouter(deps));
  router.use(createCommentsRouter(deps));
  router.use(createAttachmentsRouter(deps));

  // ---- standalone auth (docs/05-security.md §5) ----
  // In delegated mode, login is meaningless — the host app owns sessions.
  // ---- team / invites ----
  app.use(mountPath, router);

  // Serves @vayo/ui's built bundle (dist/index.html + dist/assets/*) at the
  // same mountPath the API lives under — this is what makes `vayo serve`
  // (or createServer() mounted into a host app) an actual browsable docs
  // site, not just a JSON API. `@vayo/ui`'s own vite.config.ts sets
  // `base: "./"` specifically so this same build works under any
  // mountPath; the one piece a static build can't know ahead of time is
  // *which* mountPath a given deployment chose, so it's injected into
  // index.html as `window.__VAYO_MOUNT_PATH__` at serve time (read by
  // packages/ui/src/main.tsx) rather than baked in at build time.
  //
  // Resolved lazily and tolerated if missing — `vayo serve` against a copy
  // of @vayo/ui that was only `tsc -b`'d (library output) and never
  // `vite build`'t (the bundled dist/index.html) still starts up as an
  // API-only server rather than crashing, the same "never let a missing
  // optional piece take down the real service" posture as capture's own
  // error handling.
  try {
    const uiPackageDir = path.dirname(require.resolve("@vayo/ui/package.json"));
    // dist-app/, not dist/ — @vayo/ui's vite.config.ts builds the
    // standalone SPA bundle there specifically so it never collides with
    // dist/index.js, the library entry point (this package's own
    // main/types fields).
    const uiDistDir = path.join(uiPackageDir, "dist-app");
    const indexHtmlPath = path.join(uiDistDir, "index.html");
    if (existsSync(indexHtmlPath)) {
      const indexHtmlTemplate = readFileSync(indexHtmlPath, "utf-8");
      app.use(mountPath, express.static(uiDistDir, { index: false }));
      // Express 4's path-to-regexp doesn't support Express 5's `{/*splat}`
      // optional-wildcard syntax — an explicit two-path array (the bare
      // mountPath, and anything nested under it) is the v4-compatible way
      // to say the same thing: serve the SPA shell for any GET that isn't
      // a real static file or an /api/* route (both already handled above).
      app.get([mountPath, `${mountPath}/*`], (_req, res) => {
        const html = indexHtmlTemplate.replace(
          "</head>",
          `<script nonce="${res.locals.cspNonce as string}">window.__VAYO_MOUNT_PATH__ = ${JSON.stringify(mountPath)};</script></head>`,
        );
        res.type("html").send(html);
      });
    }
  } catch {
    // @vayo/ui not installed/built alongside this server — API-only, same
    // as before this feature existed.
  }

  // Must be the LAST Express middleware registered — catches anything that
  // reached here via `next(err)`, including every rejected promise from an
  // async route handler now that autoCatchAsyncErrors (above) forwards them
  // here automatically (error-handling.ts).
  app.use(errorHandler);

  attachRealtimeGateway(io, deps);

  return { app, io, httpServer };
}
