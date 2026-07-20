// apps/demo-app/src/seed-team.ts — one-off script to seed team members for
// manually verifying @vayo/server's RBAC (docs/09-roadmap.md M3 done-when).
// Real bootstrapping is `vayo init`'s job (packages/cli, not built yet);
// this bypasses the invite flow only to create the very first owner, same
// as any real deployment would need some out-of-band first-admin step.

import bcrypt from "bcrypt";
import { createAdapter } from "@vayo/db-mongo";

const mongoUri = process.env.VAYO_MONGO_URI;
if (!mongoUri) {
  throw new Error("VAYO_MONGO_URI is not set — copy .env.example to .env and fill it in.");
}

const db = createAdapter(mongoUri);

async function upsertMember(email: string, name: string, role: "owner" | "editor" | "viewer", password: string) {
  const existing = await db.getTeamMemberByEmail(email);
  if (existing) {
    console.log(`already exists: ${email} (${existing.role})`);
    return;
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const member = await db.createTeamMember({
    email,
    name,
    role,
    passwordHash,
    status: "active",
    invitedBy: null,
    createdAt: new Date().toISOString(),
    lastSeenNotificationsAt: null,
    avatarUrl: null,
    lastSeenAt: null,
    nicknames: {},
  });
  console.log(`created ${role}: ${member.email} / password: ${password}`);
}

async function main() {
  await upsertMember("owner@demo.local", "Owner Olivia", "owner", "owner-pass-123");
  await upsertMember("editor@demo.local", "Editor Ed", "editor", "editor-pass-123");
  await upsertMember("viewer@demo.local", "Viewer Vic", "viewer", "viewer-pass-123");
}

main()
  .then(() => setTimeout(() => process.exit(0), 100))
  .catch((err) => {
    console.error("seed-team failed:", err);
    process.exit(1);
  });
