import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

describe("team & invites", () => {
  it("never includes passwordHash in the team list, even for an owner", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

    const res = await request(app).get("/api/team").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    for (const member of res.body) expect(member.passwordHash).toBeUndefined();
  });

  describe("PATCH /api/team/:memberId/role", () => {
    it("lets an owner change another member's role, and audit-logs it", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");
      const { member: editor } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

      const res = await request(app)
        .patch(`/api/team/${editor._id}/role`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ role: "viewer" });
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("viewer");
      expect(res.body.passwordHash).toBeUndefined();

      const log = await db.listAuditLog(editor._id);
      expect(log[0]).toMatchObject({ action: "role_change", diff: { before: "editor", after: "viewer" } });
    });

    it("rejects a non-owner (403)", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
      const { member: viewer } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

      const res = await request(app)
        .patch(`/api/team/${viewer._id}/role`)
        .set("Authorization", `Bearer ${editorToken}`)
        .send({ role: "editor" });
      expect(res.status).toBe(403);
    });

    it("refuses to let an owner change their own role through this endpoint", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken, member: owner } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const res = await request(app)
        .patch(`/api/team/${owner._id}/role`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ role: "viewer" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for an unknown member and 400 for an invalid role", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const notFound = await request(app)
        .patch("/api/team/does-not-exist/role")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ role: "editor" });
      expect(notFound.status).toBe(404);

      const { member: editor } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
      const badRole = await request(app)
        .patch(`/api/team/${editor._id}/role`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ role: "superadmin" });
      expect(badRole.status).toBe(400);
    });
  });

  describe("PATCH /api/team/me/name", () => {
    it("lets any authenticated member rename themselves", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token, member } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

      const res = await request(app).patch("/api/team/me/name").set("Authorization", `Bearer ${token}`).send({ name: "New Name" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("New Name");
      expect(res.body.passwordHash).toBeUndefined();

      const stored = await db.getTeamMember(member._id);
      expect(stored?.name).toBe("New Name");
    });

    it("rejects an empty name", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

      const res = await request(app).patch("/api/team/me/name").set("Authorization", `Bearer ${token}`).send({ name: "  " });
      expect(res.status).toBe(400);
    });

    it("rejects an unauthenticated caller (401)", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const res = await request(app).patch("/api/team/me/name").send({ name: "Someone" });
      expect(res.status).toBe(401);
    });
  });

  describe("PATCH/DELETE /api/team/me/avatar", () => {
    it("sets a self-uploaded avatar as a data: URI, returned from both the upload response and GET /api/team", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token, member } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

      const res = await request(app)
        .patch("/api/team/me/avatar")
        .set("Authorization", `Bearer ${token}`)
        .attach("avatar", Buffer.from("fake png bytes"), { filename: "me.png", contentType: "image/png" });

      expect(res.status).toBe(200);
      expect(res.body.avatarUrl).toMatch(/^data:image\/png;base64,/);

      const stored = await db.getTeamMember(member._id);
      expect(stored?.avatarUrl).toBe(res.body.avatarUrl);

      const roster = await request(app).get("/api/team").set("Authorization", `Bearer ${token}`);
      expect(roster.body.find((m: { _id: string }) => m._id === member._id).avatarUrl).toBe(res.body.avatarUrl);
    });

    it("rejects a non-image upload", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

      const res = await request(app)
        .patch("/api/team/me/avatar")
        .set("Authorization", `Bearer ${token}`)
        .attach("avatar", Buffer.from("not an image"), { filename: "me.txt", contentType: "text/plain" });

      expect(res.status).toBe(400);
    });

    it("rejects an avatar over the size cap with 413", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

      const tooBig = Buffer.alloc(257 * 1024);
      const res = await request(app)
        .patch("/api/team/me/avatar")
        .set("Authorization", `Bearer ${token}`)
        .attach("avatar", tooBig, { filename: "huge.png", contentType: "image/png" });

      expect(res.status).toBe(413);
    });

    it("clears the avatar back to null", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token, member } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
      await request(app)
        .patch("/api/team/me/avatar")
        .set("Authorization", `Bearer ${token}`)
        .attach("avatar", Buffer.from("fake png bytes"), { filename: "me.png", contentType: "image/png" });

      const res = await request(app).delete("/api/team/me/avatar").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.avatarUrl).toBeNull();

      const stored = await db.getTeamMember(member._id);
      expect(stored?.avatarUrl).toBeNull();
    });

    it("rejects an unauthenticated caller (401)", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const res = await request(app).patch("/api/team/me/avatar").attach("avatar", Buffer.from("x"), { filename: "x.png" });
      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /api/team/:memberId/nickname", () => {
    it("lets any authenticated member set a private nickname for someone else, without touching the target's own name", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: callerToken, member: caller } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
      const { member: target } = await seedMemberWithSession(db, SESSION_SECRET, "editor", { name: "Sayantan" });

      const res = await request(app)
        .patch(`/api/team/${target._id}/nickname`)
        .set("Authorization", `Bearer ${callerToken}`)
        .send({ nickname: "SC sir" });

      expect(res.status).toBe(200);
      expect(res.body.nicknames[target._id]).toBe("SC sir");

      const storedCaller = await db.getTeamMember(caller._id);
      expect(storedCaller?.nicknames[target._id]).toBe("SC sir");
      const storedTarget = await db.getTeamMember(target._id);
      expect(storedTarget?.name).toBe("Sayantan"); // untouched
    });

    it("clears a nickname when sent null (or an empty string)", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: callerToken, member: caller } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
      const { member: target } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
      await db.setNicknameForMember(caller._id, target._id, "Boss");

      const res = await request(app)
        .patch(`/api/team/${target._id}/nickname`)
        .set("Authorization", `Bearer ${callerToken}`)
        .send({ nickname: "" });

      expect(res.status).toBe(200);
      expect(res.body.nicknames[target._id]).toBeUndefined();
    });

    it("404s for a nonexistent target member", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

      const res = await request(app)
        .patch("/api/team/000000000000000000000000/nickname")
        .set("Authorization", `Bearer ${token}`)
        .send({ nickname: "Anyone" });
      expect(res.status).toBe(404);
    });

    it("rejects an unauthenticated caller (401)", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { member: target } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
      const res = await request(app).patch(`/api/team/${target._id}/nickname`).send({ nickname: "x" });
      expect(res.status).toBe(401);
    });

    it("GET /api/team never leaks anyone's private nicknames map, while GET /api/me returns the caller's own", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: callerToken, member: caller } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
      const { token: otherToken, member: other } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
      await db.setNicknameForMember(caller._id, other._id, "Secret Nickname");

      const roster = await request(app).get("/api/team").set("Authorization", `Bearer ${callerToken}`);
      expect(roster.status).toBe(200);
      for (const member of roster.body as Array<Record<string, unknown>>) {
        expect(member.nicknames).toBeUndefined();
      }

      const me = await request(app).get("/api/me").set("Authorization", `Bearer ${callerToken}`);
      expect(me.body.nicknames).toEqual({ [other._id]: "Secret Nickname" });

      // The OTHER member never sees the caller's private nickname for them.
      const meAsOther = await request(app).get("/api/me").set("Authorization", `Bearer ${otherToken}`);
      expect(meAsOther.body.nicknames).toEqual({});
    });
  });

  describe("DELETE /api/team/:memberId", () => {
    it("lets an owner remove another member, who instantly loses access, while their past comments stay attributed to them", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");
      const { token: viewerToken, member: viewer } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

      // Confirm the session works before removal, so the post-removal 401
      // actually demonstrates something (not just "never worked").
      const before = await request(app).get("/api/team").set("Authorization", `Bearer ${viewerToken}`);
      expect(before.status).toBe(200);

      const res = await request(app).delete(`/api/team/${viewer._id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(204);

      const after = await request(app).get("/api/team").set("Authorization", `Bearer ${viewerToken}`);
      expect(after.status).toBe(401);

      expect(await db.getTeamMember(viewer._id)).toBeNull();

      const log = await db.listAuditLog(viewer._id);
      expect(log[0]).toMatchObject({ action: "member_removed" });
    });

    it("refuses to let an owner remove themselves", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken, member: owner } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const res = await request(app).delete(`/api/team/${owner._id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(400);
      expect(await db.getTeamMember(owner._id)).not.toBeNull();
    });

    it("removing the second-to-last owner still leaves exactly one — the team never needs a separate 'last owner' guard here, since removing the truly last owner would require them to remove themselves, already blocked above", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: firstOwnerToken, member: firstOwner } = await seedMemberWithSession(db, SESSION_SECRET, "owner");
      const { member: secondOwner } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const res = await request(app).delete(`/api/team/${secondOwner._id}`).set("Authorization", `Bearer ${firstOwnerToken}`);
      expect(res.status).toBe(204);

      const remaining = (await db.listTeamMembers()).filter((m) => m.role === "owner");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!._id).toBe(firstOwner._id);
    });

    it("rejects a non-owner caller (403)", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
      const { member: viewer } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

      const res = await request(app).delete(`/api/team/${viewer._id}`).set("Authorization", `Bearer ${editorToken}`);
      expect(res.status).toBe(403);
    });

    it("returns 404 for an unknown member", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const res = await request(app).delete("/api/team/does-not-exist").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/team/invites and DELETE /api/team/invites/:inviteId", () => {
    it("lists a pending invite and lets an owner revoke it, after which it can no longer be accepted", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const invite = await request(app)
        .post("/api/team/invite")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ email: "wrong-person@corp.test", role: "editor" });
      expect(invite.status).toBe(201);

      const list = await request(app).get("/api/team/invites").set("Authorization", `Bearer ${ownerToken}`);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].email).toBe("wrong-person@corp.test");
      expect(list.body[0].tokenHash).toBeUndefined();

      const revoke = await request(app).delete(`/api/team/invites/${list.body[0]._id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(revoke.status).toBe(204);

      const acceptAttempt = await request(app)
        .post("/api/team/accept-invite")
        .send({ token: invite.body.token, name: "Wrong Person", password: "a-real-password" });
      expect(acceptAttempt.status).toBe(400);

      const listAfter = await request(app).get("/api/team/invites").set("Authorization", `Bearer ${ownerToken}`);
      expect(listAfter.body).toHaveLength(0);
    });

    it("does not list an already-accepted invite as pending", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const invite = await request(app)
        .post("/api/team/invite")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ email: "accepted@corp.test", role: "viewer" });
      await request(app)
        .post("/api/team/accept-invite")
        .send({ token: invite.body.token, name: "Accepted Person", password: "a-real-password" });

      const list = await request(app).get("/api/team/invites").set("Authorization", `Bearer ${ownerToken}`);
      expect(list.body).toHaveLength(0);
    });

    it("returns 404 revoking an invite that's already been accepted or doesn't exist", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const res = await request(app).delete("/api/team/invites/does-not-exist").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });

    it("rejects a non-owner caller for both routes (403)", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

      const list = await request(app).get("/api/team/invites").set("Authorization", `Bearer ${editorToken}`);
      expect(list.status).toBe(403);

      const revoke = await request(app).delete("/api/team/invites/some-id").set("Authorization", `Bearer ${editorToken}`);
      expect(revoke.status).toBe(403);
    });
  });

  describe("POST /api/team/invite/bulk", () => {
    it("creates one invite per unique email, all sharing the given role, each independently acceptable", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const res = await request(app)
        .post("/api/team/invite/bulk")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ emails: ["alex@corp.test", "jamie@corp.test"], role: "editor" });
      expect(res.status).toBe(201);
      expect(res.body).toHaveLength(2);
      expect(res.body.map((r: { email: string }) => r.email).sort()).toEqual(["alex@corp.test", "jamie@corp.test"]);
      expect(res.body.every((r: { role: string }) => r.role === "editor")).toBe(true);
      expect(res.body.every((r: { token: string }) => typeof r.token === "string" && r.token.length > 0)).toBe(true);
      // Tokens must be distinct — this is N separate single-use invites, not
      // one shared link handed to everyone.
      expect(new Set(res.body.map((r: { token: string }) => r.token)).size).toBe(2);

      const acceptAlex = await request(app)
        .post("/api/team/accept-invite")
        .send({ token: res.body[0].token, name: "Alex", password: "a-real-password" });
      expect(acceptAlex.status).toBe(201);

      const acceptJamie = await request(app)
        .post("/api/team/accept-invite")
        .send({ token: res.body[1].token, name: "Jamie", password: "a-real-password" });
      expect(acceptJamie.status).toBe(201);
    });

    it("de-dupes repeated emails within the same request", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const res = await request(app)
        .post("/api/team/invite/bulk")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ emails: ["dup@corp.test", "dup@corp.test"], role: "viewer" });
      expect(res.status).toBe(201);
      expect(res.body).toHaveLength(1);
    });

    it("rejects a non-owner caller (403)", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

      const res = await request(app)
        .post("/api/team/invite/bulk")
        .set("Authorization", `Bearer ${editorToken}`)
        .send({ emails: ["new@corp.test"], role: "viewer" });
      expect(res.status).toBe(403);
    });

    it("rejects an empty emails array (400)", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const res = await request(app)
        .post("/api/team/invite/bulk")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ emails: [], role: "viewer" });
      expect(res.status).toBe(400);
    });

    it("rejects a batch over the MAX_BULK_INVITES cap (400)", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const emails = Array.from({ length: 51 }, (_, i) => `person${i}@corp.test`);
      const res = await request(app)
        .post("/api/team/invite/bulk")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ emails, role: "viewer" });
      expect(res.status).toBe(400);
    });

    it("rejects a malformed email in the batch (400) and creates none of them", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const res = await request(app)
        .post("/api/team/invite/bulk")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ emails: ["fine@corp.test", "not-an-email"], role: "viewer" });
      expect(res.status).toBe(400);

      const list = await request(app).get("/api/team/invites").set("Authorization", `Bearer ${ownerToken}`);
      expect(list.body).toHaveLength(0);
    });

    it("rejects role: \"owner\" (400) — bulk invite can only grant editor/viewer, same as the single-invite route", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const res = await request(app)
        .post("/api/team/invite/bulk")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ emails: ["new@corp.test"], role: "owner" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/audit-log/export", () => {
    it("returns every audit-log entry across the whole project, newest first, as JSON (owner-only)", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      // Two unrelated actions against two different targetIds — a per-endpoint
      // GET /api/history/:vayoId could never show both in one call.
      await request(app)
        .post("/api/team/invite")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ email: "export-check@corp.test", role: "viewer" });
      await request(app)
        .post("/api/overrides")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ targetId: "ep_export.summary", value: "hi" });

      const res = await request(app).get("/api/audit-log/export").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
      const actions = res.body.map((e: { action: string }) => e.action);
      expect(actions).toContain("invite");
      expect(actions).toContain("override");
      // Newest first.
      for (let i = 1; i < res.body.length; i++) {
        expect(Date.parse(res.body[i - 1].at)).toBeGreaterThanOrEqual(Date.parse(res.body[i].at));
      }
    });

    it("returns a CSV file with a matching row count and a Content-Disposition download header", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      await request(app)
        .post("/api/team/invite")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ email: "csv-check@corp.test", role: "viewer" });

      const res = await request(app).get("/api/audit-log/export?format=csv").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.headers["content-disposition"]).toMatch(/attachment/);
      const lines = (res.text as string).trim().split("\n");
      expect(lines[0]).toBe("id,actorId,actorType,action,targetId,fieldPath,before,after,at");
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });

    it("rejects a non-owner caller (403)", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

      const res = await request(app).get("/api/audit-log/export").set("Authorization", `Bearer ${editorToken}`);
      expect(res.status).toBe(403);
    });

    it("clamps an out-of-range ?limit= to MAX_AUDIT_EXPORT_LIMIT rather than erroring", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

      const res = await request(app).get("/api/audit-log/export?limit=999999999").set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  it("accept-invite: succeeds once, and a later sequential redemption of the same token is rejected (400, already used)", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

    const invite = await request(app)
      .post("/api/team/invite")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: "new@corp.test", role: "editor" });
    expect(invite.status).toBe(201);
    const inviteToken = invite.body.token;

    const accept1 = await request(app)
      .post("/api/team/accept-invite")
      .send({ token: inviteToken, name: "New Person", password: "a-real-password" });
    expect(accept1.status).toBe(201);
    expect(accept1.body.role).toBe("editor");

    // Once usedAt is visibly set, the route's own "invalid or expired"
    // guard catches it before ever reaching the atomic check-and-set —
    // 409 is reserved for the genuine race below, not a sequential retry.
    const accept2 = await request(app)
      .post("/api/team/accept-invite")
      .send({ token: inviteToken, name: "New Person", password: "a-real-password" });
    expect(accept2.status).toBe(400);
  });

  it("accept-invite: returns 409 (not 500 or 201) when markInviteUsed loses the atomic race, even though the invite still looked unused a moment earlier", async () => {
    // Real concurrent HTTP requests don't reliably interleave at exactly the
    // read/write boundary in a test, so this exercises the route's own
    // branch directly: getInviteByTokenHash still sees the invite as unused
    // (another request hasn't visibly committed yet), but the atomic
    // markInviteUsed call itself loses the race — db-mongo's own test suite
    // already proves markInviteUsed is atomic; this proves the ROUTE
    // reports that outcome as 409, not a 500 or a false 201.
    const db = createFakeDb();
    const originalMarkInviteUsed = db.markInviteUsed.bind(db);
    let calls = 0;
    db.markInviteUsed = async (tokenHash, usedAt) => {
      calls++;
      if (calls === 1) return null; // simulates losing the race to a concurrent redemption
      return originalMarkInviteUsed(tokenHash, usedAt);
    };
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");

    const invite = await request(app)
      .post("/api/team/invite")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: "race@corp.test", role: "editor" });

    const res = await request(app)
      .post("/api/team/accept-invite")
      .send({ token: invite.body.token, name: "A", password: "a-real-password" });

    expect(res.status).toBe(409);
    // Only the owner (seeded to send the invite) exists — no additional
    // member was created for the redemption that lost the race.
    expect(await db.listTeamMembers()).toHaveLength(1);
  });

  it("rejects accept-invite for an unknown token with 400, not 500", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const res = await request(app)
      .post("/api/team/accept-invite")
      .send({ token: "bogus", name: "Someone", password: "a-real-password" });
    expect(res.status).toBe(400);
  });
});
