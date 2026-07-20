// apps/demo-app/src/seed-versions.ts — one-off script to seed the two
// vayo_api_versions docs the M6 done-when bar needs (docs/09-roadmap.md):
// v1/v2 basePathPatterns so versioned routes (Products/Admin-products —
// v2 adds a required `sku` field, see src/routes/products/ and
// src/routes/admin/) resolve to their own version instead of falling
// through to the zero-config default. Not every resource has a v2
// counterpart, which is realistic — a version bump doesn't mean every
// route changed.

import { createAdapter } from "@vayo/db-mongo";

const mongoUri = process.env.VAYO_MONGO_URI;
if (!mongoUri) {
  throw new Error("VAYO_MONGO_URI is not set — copy .env.example to .env and fill it in.");
}

const db = createAdapter(mongoUri);

async function upsertVersion(version: string, basePathPattern: string) {
  const existing = (await db.listApiVersions()).find((v) => v.version === version);
  if (existing) {
    console.log(`already exists: ${version} (${existing.status})`);
    return;
  }
  await db.createApiVersion({
    version,
    status: "active",
    basePathPattern,
    deprecatedAt: null,
    sunsetAt: null,
  });
  console.log(`created version: ${version} (${basePathPattern})`);
}

async function main() {
  await upsertVersion("v1", "/api/v1");
  await upsertVersion("v2", "/api/v2");
}

main()
  .then(() => setTimeout(() => process.exit(0), 100))
  .catch((err) => {
    console.error("seed-versions failed:", err);
    process.exit(1);
  });
