// @vayo/cli — vayo serve: runs @vayo/server standalone against the same
// MongoDB the user's capture middleware writes to. Standalone auth mode
// only — delegated auth (ServerOptions.authMiddleware) needs code specific
// to the user's own auth system, which a CLI can't generically prompt into
// existence.

import { createServer } from "@vayo/server";
import { createAdapter } from "@vayo/db-mongo";
import { requireMongoUri } from "../config.js";

export interface ServeOptions {
  port: string;
  mount: string;
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  const mongoUri = requireMongoUri();
  if (!process.env.VAYO_SESSION_SECRET) {
    throw new Error('vayo: VAYO_SESSION_SECRET is not set — run "vayo init" or set it in your .env.');
  }

  const db = createAdapter(mongoUri);
  const { httpServer } = createServer({ db, mountPath: options.mount });

  const port = Number(options.port);
  httpServer.listen(port, () => {
    console.log(`vayo: serving on http://localhost:${port}${options.mount} (standalone auth mode)`);
  });
}
