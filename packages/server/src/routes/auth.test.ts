import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import type { VayoDbAdapter } from "@vayo/types";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

describe("standalone auth (login/logout/me)", () => {
  let db: VayoDbAdapter;
  let app: ReturnType<typeof createServer>["app"];

  beforeEach(() => {
    db = createFakeDb();
    ({ app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" }));
  });

  it("rejects login with the wrong password", async () => {
    const bcrypt = await import("bcrypt");
    await db.createTeamMember({
      email: "owner@corp.test",
      name: "Owner",
      role: "owner",
      passwordHash: await bcrypt.hash("correct-password", 10),
      status: "active",
      invitedBy: null,
      createdAt: new Date().toISOString(),
      lastSeenNotificationsAt: null,
      avatarUrl: null,
      lastSeenAt: null,
      nicknames: {},
    });

    const res = await request(app).post("/api/auth/login").send({ email: "owner@corp.test", password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("logs in with correct credentials, then /api/me reflects that session", async () => {
    const bcrypt = await import("bcrypt");
    await db.createTeamMember({
      email: "owner@corp.test",
      name: "Owner",
      role: "owner",
      passwordHash: await bcrypt.hash("correct-password", 10),
      status: "active",
      invitedBy: null,
      createdAt: new Date().toISOString(),
      lastSeenNotificationsAt: null,
      avatarUrl: null,
      lastSeenAt: null,
      nicknames: {},
    });

    const login = await request(app).post("/api/auth/login").send({ email: "owner@corp.test", password: "correct-password" });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();

    const me = await request(app).get("/api/me").set("Authorization", `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: "owner@corp.test", role: "owner" });
    expect(me.body.passwordHash).toBeUndefined();
  });

  it("logout invalidates the session — a later request with the same token is unauthorized", async () => {
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`);

    const me = await request(app).get("/api/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(401);
  });

  it("returns 400 on a malformed login body rather than a 500", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });
});

describe("delegated auth mode", () => {
  it("disables /api/auth/login (404) and trusts authMiddleware's claim, re-reading the role from the DB", async () => {
    const db = createFakeDb();
    const member = await db.createTeamMember({
      email: "delegated@corp.test",
      name: "Delegated User",
      role: "editor",
      passwordHash: null,
      status: "active",
      invitedBy: null,
      createdAt: new Date().toISOString(),
      lastSeenNotificationsAt: null,
      avatarUrl: null,
      lastSeenAt: null,
      nicknames: {},
    });
    const { app } = createServer({
      db,
      sessionSecret: SESSION_SECRET,
      mountPath: "/",
      authMiddleware: () => ({ memberId: member._id, role: "owner" }), // role claim is ignored — DB wins
    });

    const loginAttempt = await request(app).post("/api/auth/login").send({ email: "x", password: "y" });
    expect(loginAttempt.status).toBe(404);

    // requireRole("owner") must fail — the DB says "editor", not the claimed "owner".
    const asOwnerRoute = await request(app).post("/api/team/invite").send({ email: "new@corp.test", role: "viewer" });
    expect(asOwnerRoute.status).toBe(403);

    // requireRole("editor") must succeed — the real DB role.
    const asEditorRoute = await request(app).post("/api/overrides").send({ targetId: "ep_1.summary", value: "hi" });
    expect(asEditorRoute.status).toBe(200);
  });

  it("rejects a claim for a deactivated member even if authMiddleware still vouches for them", async () => {
    const db = createFakeDb();
    const member = await db.createTeamMember({
      email: "gone@corp.test",
      name: "Departed",
      role: "editor",
      passwordHash: null,
      status: "invited", // not "active"
      invitedBy: null,
      createdAt: new Date().toISOString(),
      lastSeenNotificationsAt: null,
      avatarUrl: null,
      lastSeenAt: null,
      nicknames: {},
    });
    const { app } = createServer({
      db,
      sessionSecret: SESSION_SECRET,
      mountPath: "/",
      authMiddleware: () => ({ memberId: member._id, role: "editor" }),
    });

    const res = await request(app).get("/api/me");
    expect(res.status).toBe(401);
  });
});

describe("role-gating matrix on real routes", () => {
  let db: VayoDbAdapter;
  let app: ReturnType<typeof createServer>["app"];

  beforeEach(() => {
    db = createFakeDb();
    ({ app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" }));
  });

  it("a viewer-gated route: 401 with no token, 200 with any active member", async () => {
    const noAuth = await request(app).get("/api/versions");
    expect(noAuth.status).toBe(401);

    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const withAuth = await request(app).get("/api/versions").set("Authorization", `Bearer ${token}`);
    expect(withAuth.status).toBe(200);
  });

  it("an editor-gated route: 403 for a viewer, 200 for an editor", async () => {
    const { token: viewerToken } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const asViewer = await request(app)
      .post("/api/overrides")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ targetId: "ep_1.summary", value: "x" });
    expect(asViewer.status).toBe(403);

    const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const asEditor = await request(app)
      .post("/api/overrides")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ targetId: "ep_1.summary", value: "x" });
    expect(asEditor.status).toBe(200);
  });

  it("an owner-gated route: 403 for an editor, 201 for an owner", async () => {
    const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const asEditor = await request(app)
      .post("/api/team/invite")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ email: "new@corp.test", role: "viewer" });
    expect(asEditor.status).toBe(403);

    const { token: ownerToken } = await seedMemberWithSession(db, SESSION_SECRET, "owner");
    const asOwner = await request(app)
      .post("/api/team/invite")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: "new@corp.test", role: "viewer" });
    expect(asOwner.status).toBe(201);
  });
});
