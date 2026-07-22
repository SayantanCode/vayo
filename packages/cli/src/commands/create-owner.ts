// vayo — vayo create-owner: bootstraps the very first team member
// account for standalone auth mode. Without this, a fresh standalone
// deployment's docs UI shows only a login screen with no way to reach it —
// the invite flow (packages/server's /api/team/invite) needs an existing
// owner to send the invite in the first place. Before this command existed,
// the only place this logic lived was apps/demo-app's private
// seed-team.ts script, which ships with the monorepo, not with the
// published vayo package a real user installs.

import bcrypt from "bcrypt";
import prompts from "prompts";
import { createAdapter } from "@vayo/db-mongo";
import { requireMongoUri } from "../config.js";

export interface CreateOwnerOptions {
  email?: string;
  name?: string;
  password?: string;
}

export async function createOwnerCommand(options: CreateOwnerOptions): Promise<void> {
  let { email, name, password } = options;
  if (!email || !name || !password) {
    const answers = await prompts([
      { type: "text", name: "email", message: "Owner email", initial: email },
      { type: "text", name: "name", message: "Owner name", initial: name },
      { type: "password", name: "password", message: "Owner password (min 8 characters)" },
    ]);
    email ??= answers.email;
    name ??= answers.name;
    password ??= answers.password;
  }
  if (!email || !name || !password) {
    console.log("vayo: create-owner cancelled.");
    return;
  }
  if (password.length < 8) {
    throw new Error("vayo: password must be at least 8 characters.");
  }

  const db = createAdapter(requireMongoUri());
  try {
    const existing = await db.getTeamMemberByEmail(email);
    if (existing) {
      throw new Error(`vayo: a team member with email ${email} already exists (role: ${existing.role}).`);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const member = await db.createTeamMember({
      email,
      name,
      role: "owner",
      passwordHash,
      status: "active",
      invitedBy: null,
      createdAt: new Date().toISOString(),
      lastSeenNotificationsAt: null,
      avatarUrl: null,
      lastSeenAt: null,
      nicknames: {},
    });

    console.log(`vayo: created owner ${member.email} — sign in at your docs URL with this email and password.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    // createAdapter's MongoClient has no public close() (it's meant to live
    // for a long-running server's whole lifetime, not a one-shot command) —
    // same reason every one-shot command in this package force-exits too
    // (see scan.ts/export.ts). Caught above so a duplicate-email error still
    // prints instead of getting lost when the process exits.
    process.exit();
  }
}
