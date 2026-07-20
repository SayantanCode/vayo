// apps/demo-app/src/reset-docs-data.ts — one-off script to clear out the
// documentation content captured from demo-app's OLD flat toy routes,
// before re-capturing against the rebuilt multi-role e-commerce API.
// Empties every collection that's either per-endpoint content or
// references an old `vayoId` — none of it means anything once the routes
// it describes are gone. Deliberately leaves `vayo_team_members`,
// `vayo_sessions`, `vayo_invites` (your Vayo login accounts — unrelated to
// the demo app's own business roles) and `vayo_environments` (workspace-
// level `{{var}}` config, not tied to specific old endpoints) untouched.

import { MongoClient } from "mongodb";

const mongoUri = process.env.VAYO_MONGO_URI;
if (!mongoUri) {
  throw new Error("VAYO_MONGO_URI is not set — copy .env.example to .env and fill it in.");
}

const COLLECTIONS_TO_RESET = [
  "vayo_endpoints",
  "vayo_folders",
  "vayo_overrides",
  "vayo_examples",
  "vayo_comments",
  "vayo_api_versions",
  "vayo_audit_log",
  "vayo_test_scripts",
  "vayo_flows",
];

async function main() {
  const client = new MongoClient(mongoUri!);
  try {
    await client.connect();
    const db = client.db();
    for (const name of COLLECTIONS_TO_RESET) {
      const { deletedCount } = await db.collection(name).deleteMany({});
      console.log(`cleared ${name} (${deletedCount} documents)`);
    }
  } finally {
    await client.close();
  }
}

main()
  .then(() => setTimeout(() => process.exit(0), 100))
  .catch((err) => {
    console.error("reset-docs-data failed:", err);
    process.exit(1);
  });
