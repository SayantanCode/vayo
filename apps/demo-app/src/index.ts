// apps/demo-app — proves the M1 capture pipeline against real traffic.
// docs/09-roadmap.md M1 "done when": dump vayo_endpoints after a day of
// traffic and confirm the inferred schema looks right, with zero
// annotations written anywhere in this file (or app.ts).

import { capture } from "@vayo/capture-express";
import { createAdapter, runMigrations } from "@vayo/db-mongo";
import { createApp } from "./app.js";

const mongoUri = process.env.VAYO_MONGO_URI;
if (!mongoUri) {
  throw new Error("VAYO_MONGO_URI is not set — copy .env.example to .env and fill it in.");
}

const db = createAdapter(mongoUri);
const app = createApp([capture({ db })]);

const port = process.env.PORT ? Number(process.env.PORT) : 4000;

runMigrations(mongoUri)
  .then(() => {
    app.listen(port, () => {
      console.log(`demo-app listening on http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to run Vayo migrations:", err);
    process.exit(1);
  });
