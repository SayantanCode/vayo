// apps/demo-app/src/vayo-server.ts — runs @vayo/server standalone against
// the same MongoDB the demo-app's capture middleware writes to. Proves
// docs/09-roadmap.md M3 done-when: a viewer-role session gets a 403 hitting
// /api/overrides directly, even with no UI yet to stop them.

import { createServer } from "@vayo/server";
import { createAdapter } from "@vayo/db-mongo";

const mongoUri = process.env.VAYO_MONGO_URI;
if (!mongoUri) {
  throw new Error("VAYO_MONGO_URI is not set — copy .env.example to .env and fill it in.");
}
if (!process.env.VAYO_SESSION_SECRET) {
  throw new Error("VAYO_SESSION_SECRET is not set.");
}

const db = createAdapter(mongoUri);
const { httpServer } = createServer({
  db,
  mountPath: "/vayo",
  // @vayo/ui's Vite dev server runs on a different origin/port during
  // local development — explicit opt-in, same-origin stays the default
  // for any origin not listed here (docs/05-security.md §7).
  corsOrigins: ["http://localhost:5173"],
});

const port = process.env.VAYO_SERVER_PORT ? Number(process.env.VAYO_SERVER_PORT) : 4100;
httpServer.listen(port, () => {
  console.log(`@vayo/server listening on http://localhost:${port}${"/vayo"}`);
});
