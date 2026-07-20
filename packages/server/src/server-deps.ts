// @vayo/server — the dependency bag every resource router receives from
// createServer(). `io` is included alongside `db`/`sessionSecret` because
// several REST routes also broadcast a realtime event right after their own
// DB write succeeds — not just the Socket.IO event handlers in realtime.ts
// (docs/06-realtime-collaboration.md: "Socket.IO is a transport, not a
// source of truth" — the REST write and the broadcast happen in the same
// handler, one right after the other).
import type { Request } from "express";
import type { VayoDbAdapter } from "@vayo/types";
import type { Server as SocketIOServer } from "socket.io";
import type { AuthResult } from "./auth-middleware.js";

export interface RouteDeps {
  db: VayoDbAdapter;
  sessionSecret: string;
  io: SocketIOServer;
  /** Present only in delegated auth mode — routes/auth.ts uses its mere
   * presence to 404 the standalone-only /api/auth/login route (login is
   * meaningless when the host app owns sessions, docs/05-security.md §5). */
  authMiddleware?: (req: Request) => AuthResult | null;
}
