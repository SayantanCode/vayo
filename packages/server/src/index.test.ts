import { createServer as createHttpServer } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VayoDbAdapter } from "@vayo/types";
import { createServer, requireRole } from "./index.js";
import { createFakeDb, seedMemberWithSession } from "./test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

describe("createServer — httpServer / socketPath options", () => {
  it("creates its own httpServer when none is provided", () => {
    const db = createFakeDb();
    const { httpServer } = createServer({ db, sessionSecret: SESSION_SECRET });
    expect(httpServer).toBeDefined();
  });

  it("returns the exact same httpServer instance when one is provided — no second server created", () => {
    const db = createFakeDb();
    const myOwnHttpServer = createHttpServer();
    const { httpServer } = createServer({ db, sessionSecret: SESSION_SECRET, httpServer: myOwnHttpServer });
    expect(httpServer).toBe(myOwnHttpServer);
  });

  it("defaults the Socket.IO path to `${mountPath}/socket.io`, not Engine.IO's bare default", () => {
    const db = createFakeDb();
    const { io } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/docs" });
    expect(io.path()).toBe("/docs/socket.io");
  });

  it("normalizes a root mountPath so the socket path isn't a doubled slash", () => {
    const db = createFakeDb();
    const { io } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    expect(io.path()).toBe("/socket.io");
  });

  it("lets socketPath override the mountPath-derived default entirely", () => {
    const db = createFakeDb();
    const { io } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/docs", socketPath: "/my-custom-ws" });
    expect(io.path()).toBe("/my-custom-ws");
  });

  describe("upgrade-listener conflict warning", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("does not warn when Vayo creates its own httpServer (can't possibly have a pre-existing upgrade listener)", () => {
      const db = createFakeDb();
      createServer({ db, sessionSecret: SESSION_SECRET });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not warn when a provided httpServer has no upgrade listeners yet", () => {
      const db = createFakeDb();
      const myOwnHttpServer = createHttpServer();
      createServer({ db, sessionSecret: SESSION_SECRET, httpServer: myOwnHttpServer });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns when a provided httpServer already has an upgrade handler attached", () => {
      const db = createFakeDb();
      const myOwnHttpServer = createHttpServer();
      // Standing in for the host's own WebSocket/Socket.IO server, already
      // attached before Vayo's createServer() gets a chance to.
      myOwnHttpServer.on("upgrade", () => {});
      createServer({ db, sessionSecret: SESSION_SECRET, httpServer: myOwnHttpServer });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/upgrade|websocket/i);
    });
  });
});

describe("requireRole (pure middleware factory)", () => {
  function mockRes() {
    const res: { statusCode?: number; body?: unknown; status: (n: number) => typeof res; json: (b: unknown) => void } = {
      status(n: number) {
        res.statusCode = n;
        return res;
      },
      json(b: unknown) {
        res.body = b;
      },
    };
    return res;
  }

  it("returns 401 when there's no auth at all", () => {
    const res = mockRes();
    let nextCalled = false;
    requireRole("viewer")({ vayoAuth: null } as never, res as never, () => {
      nextCalled = true;
    });
    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it("returns 403 when the role is present but ranked too low", () => {
    const res = mockRes();
    requireRole("owner")({ vayoAuth: { memberId: "m", role: "editor" } } as never, res as never, () => {});
    expect(res.statusCode).toBe(403);
  });

  it("calls next() when the role meets the minimum", () => {
    const res = mockRes();
    let nextCalled = false;
    requireRole("editor")({ vayoAuth: { memberId: "m", role: "owner" } } as never, res as never, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });
});

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

describe("overrides — persistence + audit log", () => {
  it("applies the override, writes it under the endpoint's vayoId (not the full targetId) in the audit log", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token, member } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    const res = await request(app)
      .post("/api/overrides")
      .set("Authorization", `Bearer ${token}`)
      .send({ targetId: "ep_1.summary", value: "Fetch a widget", reason: "clarify" });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe("Fetch a widget");

    const stored = await db.getOverride("ep_1.summary");
    expect(stored?.updatedBy).toBe(member._id);

    const log = await db.listAuditLog("ep_1");
    expect(log).toHaveLength(1);
    expect(log[0]!.action).toBe("override");
    expect(log[0]!.diff).toEqual({ before: null, after: "Fetch a widget" });

    const notifications = await db.listNotifications(50);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ type: "override", vayoId: "ep_1", actorId: member._id, message: "updated summary" });
  });

  it("returns 400 for a body missing the required targetId", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    const res = await request(app).post("/api/overrides").set("Authorization", `Bearer ${token}`).send({ value: "x" });
    expect(res.status).toBe(400);
  });
});

describe("manual endpoint creation", () => {
  it("creates one, and rejects a duplicate for the same method+path+version with 409", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    const body = { method: "post", pathTemplate: "/api/v1/widgets", version: "v1", group: "Widgets", summary: "Create a widget" };
    const first = await request(app).post("/api/endpoints/manual").set("Authorization", `Bearer ${token}`).send(body);
    expect(first.status).toBe(201);

    const second = await request(app).post("/api/endpoints/manual").set("Authorization", `Bearer ${token}`).send(body);
    expect(second.status).toBe(409);

    const log = await db.listAuditLog(first.body.vayoId);
    expect(log[0]!.action).toBe("endpoint_created");
  });
});

describe("DELETE /api/endpoints/:vayoId — manual endpoints only", () => {
  it("deletes a manual endpoint and records an endpoint_deleted audit entry", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    const created = await request(app)
      .post("/api/endpoints/manual")
      .set("Authorization", `Bearer ${token}`)
      .send({ method: "post", pathTemplate: "/api/v1/widgets", version: "v1", group: "Widgets", summary: "Create a widget" });
    expect(created.status).toBe(201);

    const deleted = await request(app).delete(`/api/endpoints/${created.body.vayoId}`).set("Authorization", `Bearer ${token}`);
    expect(deleted.status).toBe(204);
    expect(await db.getEndpoint(created.body.vayoId)).toBeNull();

    const log = await db.listAuditLog(created.body.vayoId);
    expect(log.at(-1)!.action).toBe("endpoint_deleted");
    expect(log.at(-1)!.diff).toEqual({ before: { method: "POST", pathTemplate: "/api/v1/widgets" }, after: null });
  });

  it("refuses to delete an endpoint detected from real traffic, with 400", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    const captured = await db.upsertEndpoint({
      method: "GET",
      pathTemplate: "/api/v1/widgets",
      version: "v1",
      requestHeaders: {},
      requestParams: {},
      requestQuery: {},
      requestBody: null,
      responseStatus: 200,
      responseBody: { id: "w1" },
      middlewareNames: [],
      capturedAt: new Date().toISOString(),
    });
    expect(captured.source).toBe("runtime");

    const res = await request(app).delete(`/api/endpoints/${captured.vayoId}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(await db.getEndpoint(captured.vayoId)).not.toBeNull();
  });

  it("404s for a vayoId that doesn't exist", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    const res = await request(app).delete("/api/endpoints/no-such-vayo-id").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("403s for a viewer (editor role required)", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app).delete("/api/endpoints/no-such-vayo-id").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe("Team Chat — flagging (only flagged messages need resolving)", () => {
  it("posts a message with flagged defaulting to false, and creates a comment notification", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app)
      .post("/api/comments")
      .set("Authorization", `Bearer ${token}`)
      .send({ vayoId: "ep_1", body: "looks good to me" });
    expect(res.status).toBe(201);
    expect(res.body.flagged).toBe(false);

    const notifications = await db.listNotifications(50);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ type: "comment", vayoId: "ep_1" });
    expect(notifications[0]!.message).toContain("looks good to me");
  });

  it("posts a flagged message when the sender marks it as a question", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app)
      .post("/api/comments")
      .set("Authorization", `Bearer ${token}`)
      .send({ vayoId: "ep_1", body: "does this endpoint need auth?", flagged: true });
    expect(res.body.flagged).toBe(true);
  });

  it("defaults replyToId to null when the message isn't a reply", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app).post("/api/comments").set("Authorization", `Bearer ${token}`).send({ vayoId: "ep_1", body: "hello" });
    expect(res.body.replyToId).toBeNull();
  });

  it("stores replyToId so a reply can be linked back to the message it's responding to", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const original = await request(app)
      .post("/api/comments")
      .set("Authorization", `Bearer ${token}`)
      .send({ vayoId: "ep_1", body: "does this need auth?" });

    const reply = await request(app)
      .post("/api/comments")
      .set("Authorization", `Bearer ${token}`)
      .send({ vayoId: "ep_1", body: "yes, editor role required", replyToId: original.body._id });

    expect(reply.status).toBe(201);
    expect(reply.body.replyToId).toBe(original.body._id);
  });

  it("lets a viewer flag an existing message after the fact (same bar as posting one)", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const comment = await db.createComment({
      vayoIds: ["ep_1"],
      authorId: "someone",
      body: "hmm",
      replyToId: null,
      flagged: false,
      resolved: false,
      createdAt: new Date().toISOString(),
    });

    const res = await request(app).patch(`/api/comments/${comment._id}/flag`).set("Authorization", `Bearer ${token}`).send({ flagged: true });
    expect(res.status).toBe(200);
    expect(res.body.flagged).toBe(true);
  });

  it("returns 404 flagging an unknown comment, and 400 for an invalid body", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const notFound = await request(app).patch("/api/comments/does-not-exist/flag").set("Authorization", `Bearer ${token}`).send({ flagged: true });
    expect(notFound.status).toBe(404);

    const badBody = await request(app).patch("/api/comments/ep_1/flag").set("Authorization", `Bearer ${token}`).send({ flagged: "yes" });
    expect(badBody.status).toBe(400);
  });
});

describe("Team Chat — cross-endpoint tagging", () => {
  it("derives vayoIds from the posted-from endpoint plus any #[path](vayoId) tags typed inline", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app)
      .post("/api/comments")
      .set("Authorization", `Bearer ${token}`)
      .send({ vayoId: "ep_1", body: "does this relate to #[/api/v1/cart](ep_2) and #[/api/v1/inventory](ep_3)?" });

    expect(res.status).toBe(201);
    expect(res.body.vayoIds).toEqual(["ep_1", "ep_2", "ep_3"]);
  });

  it("de-duplicates when the posted-from endpoint is also tagged inline", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app)
      .post("/api/comments")
      .set("Authorization", `Bearer ${token}`)
      .send({ vayoId: "ep_1", body: "re-tagging #[/api/v1/orders](ep_1) itself, plus #[/api/v1/cart](ep_2)" });

    expect(res.body.vayoIds).toEqual(["ep_1", "ep_2"]);
  });

  it("stays single-endpoint when no #tag is typed", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app).post("/api/comments").set("Authorization", `Bearer ${token}`).send({ vayoId: "ep_1", body: "no tags here" });

    expect(res.body.vayoIds).toEqual(["ep_1"]);
  });

  it("a cross-cutting comment shows up under every tagged endpoint's own GET /api/comments/:vayoId", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    await request(app)
      .post("/api/comments")
      .set("Authorization", `Bearer ${token}`)
      .send({ vayoId: "ep_1", body: "cross-cutting with #[/api/v1/cart](ep_2)" });

    const forEp1 = await request(app).get("/api/comments/ep_1").set("Authorization", `Bearer ${token}`);
    const forEp2 = await request(app).get("/api/comments/ep_2").set("Authorization", `Bearer ${token}`);
    const forEp3 = await request(app).get("/api/comments/ep_3").set("Authorization", `Bearer ${token}`);
    expect(forEp1.body).toHaveLength(1);
    expect(forEp2.body).toHaveLength(1);
    expect(forEp3.body).toHaveLength(0);
  });

  describe("GET /api/comments/cross-cutting", () => {
    it("returns only comments tagging 2+ endpoints, not the ordinary single-endpoint ones", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

      await request(app).post("/api/comments").set("Authorization", `Bearer ${token}`).send({ vayoId: "ep_1", body: "just about ep_1" });
      await request(app)
        .post("/api/comments")
        .set("Authorization", `Bearer ${token}`)
        .send({ vayoId: "ep_1", body: "about ep_1 and #[/x](ep_2)" });

      const res = await request(app).get("/api/comments/cross-cutting").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].body).toBe("about ep_1 and #[/x](ep_2)");
    });

    it("is not shadowed by the parameterized /api/comments/:vayoId route", async () => {
      // Registration-order regression guard: if "cross-cutting" were ever
      // matched as a literal vayoId by the :vayoId route instead, this
      // would 200 with an empty array rather than exercising the dedicated
      // handler — this test's other assertion above is what actually
      // proves the two aren't confused, but a bare reachability check here
      // catches routing-order mistakes fast.
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

      const res = await request(app).get("/api/comments/cross-cutting").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("rejects an unauthenticated caller (401)", async () => {
      const db = createFakeDb();
      const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
      const res = await request(app).get("/api/comments/cross-cutting");
      expect(res.status).toBe(401);
    });
  });
});

describe("Team Chat — attachments (GridFS-backed files/screen recordings)", () => {
  it("lists attachments for a conversation via GET /api/attachments?vayoId=", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .field("vayoId", "ep_1")
      .attach("file", Buffer.from("a"), { filename: "a.png" });

    const res = await request(app).get("/api/attachments?vayoId=ep_1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].filename).toBe("a.png");
  });

  it("requires vayoId on the list route", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app).get("/api/attachments").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("uploads a file as an unclaimed attachment, viewer role sufficient", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .field("vayoId", "ep_1")
      .attach("file", Buffer.from("fake screenshot bytes"), { filename: "bug.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body.filename).toBe("bug.png");
    expect(res.body.mimeType).toBe("image/png");
    expect(res.body.kind).toBe("file");
    expect(res.body.commentId).toBeNull();
  });

  it("accepts kind=screen-recording", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .field("vayoId", "ep_1")
      .field("kind", "screen-recording")
      .attach("file", Buffer.from("fake webm bytes"), { filename: "recording.webm", contentType: "video/webm" });

    expect(res.body.kind).toBe("screen-recording");
  });

  it("rejects an upload with no vayoId", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("x"), { filename: "x.txt" });

    expect(res.status).toBe(400);
  });

  it("rejects an upload with no file at all", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app).post("/api/attachments").set("Authorization", `Bearer ${token}`).field("vayoId", "ep_1");
    expect(res.status).toBe(400);
  });

  it("rejects a file over the size cap with 413", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const tooBig = Buffer.alloc(41 * 1024 * 1024);
    const res = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .field("vayoId", "ep_1")
      .attach("file", tooBig, { filename: "huge.bin" });

    expect(res.status).toBe(413);
  }, 20000);

  it("downloads an attachment's bytes back with the right content-type", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const uploaded = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .field("vayoId", "ep_1")
      .attach("file", Buffer.from("hello attachment"), { filename: "note.txt", contentType: "text/plain" });

    const downloaded = await request(app).get(`/api/attachments/${uploaded.body._id}/download`).set("Authorization", `Bearer ${token}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers["content-type"]).toContain("text/plain");
  });

  it("404s downloading an attachment that doesn't exist", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app).get("/api/attachments/does-not-exist/download").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("accepts a ?token= query param for downloads specifically, since <img>/<video> can't set headers", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const uploaded = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .field("vayoId", "ep_1")
      .attach("file", Buffer.from("hi"), { filename: "hi.txt", contentType: "text/plain" });

    const res = await request(app).get(`/api/attachments/${uploaded.body._id}/download?token=${token}`);
    expect(res.status).toBe(200);
  });

  it("does not accept a ?token= query param on any other route", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app).get(`/api/comments/ep_1?token=${token}`);
    expect(res.status).toBe(401);
  });

  it("claims attachments onto the comment they're sent with", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const uploaded = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .field("vayoId", "ep_1")
      .attach("file", Buffer.from("screenshot"), { filename: "s.png" });

    const comment = await request(app)
      .post("/api/comments")
      .set("Authorization", `Bearer ${token}`)
      .send({ vayoId: "ep_1", body: "here's what's happening", attachmentIds: [uploaded.body._id] });

    expect(comment.status).toBe(201);
    const attachment = await db.getAttachment(uploaded.body._id);
    expect(attachment?.commentId).toBe(comment.body._id);
  });

  it("lets the uploader delete their own unclaimed attachment", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const uploaded = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${token}`)
      .field("vayoId", "ep_1")
      .attach("file", Buffer.from("x"), { filename: "x.txt" });

    const res = await request(app).delete(`/api/attachments/${uploaded.body._id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(await db.getAttachment(uploaded.body._id)).toBeNull();
  });

  it("refuses to delete an attachment uploaded by a different member", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token: uploaderToken } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const { token: otherToken } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const uploaded = await request(app)
      .post("/api/attachments")
      .set("Authorization", `Bearer ${uploaderToken}`)
      .field("vayoId", "ep_1")
      .attach("file", Buffer.from("x"), { filename: "x.txt" });

    const res = await request(app).delete(`/api/attachments/${uploaded.body._id}`).set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(404);
    expect(await db.getAttachment(uploaded.body._id)).not.toBeNull();
  });
});

describe("Team Chat — @mentions", () => {
  it("stores mentioned member ids on the comment's notification", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    await request(app)
      .post("/api/comments")
      .set("Authorization", `Bearer ${token}`)
      .send({ vayoId: "ep_1", body: "@[Editor Ed](member_42) can you take a look?" });

    const notifications = await db.listNotifications(50);
    expect(notifications[0]!.mentionedMemberIds).toEqual(["member_42"]);
  });

  it("leaves mentionedMemberIds empty for an ordinary message", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    await request(app).post("/api/comments").set("Authorization", `Bearer ${token}`).send({ vayoId: "ep_1", body: "no mentions here" });

    const notifications = await db.listNotifications(50);
    expect(notifications[0]!.mentionedMemberIds).toEqual([]);
  });
});

describe("notifications (header bell)", () => {
  it("lists recent notifications with an unread count that excludes the caller's own actions", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const { token: viewerToken } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    await request(app)
      .post("/api/overrides")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ targetId: "ep_1.summary", value: "Fetch a widget" });

    const asEditor = await request(app).get("/api/notifications").set("Authorization", `Bearer ${editorToken}`);
    expect(asEditor.body.items).toHaveLength(1);
    expect(asEditor.body.unreadCount).toBe(0); // the editor's own change isn't "unread" for them

    const asViewer = await request(app).get("/api/notifications").set("Authorization", `Bearer ${viewerToken}`);
    expect(asViewer.body.unreadCount).toBe(1); // but it IS unread for everyone else
  });

  it("mark-seen clears the unread count for that member going forward", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const { token: viewerToken } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    await request(app)
      .post("/api/overrides")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ targetId: "ep_1.summary", value: "Fetch a widget" });

    const markSeen = await request(app).post("/api/notifications/mark-seen").set("Authorization", `Bearer ${viewerToken}`);
    expect(markSeen.status).toBe(204);

    const after = await request(app).get("/api/notifications").set("Authorization", `Bearer ${viewerToken}`);
    expect(after.body.unreadCount).toBe(0);
  });

  it("PATCH /api/versions/:version only creates a notification when status actually changes", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    await request(app).post("/api/versions").set("Authorization", `Bearer ${token}`).send({ version: "v1", basePathPattern: "/api/v1" });

    const patchPattern = await request(app).patch("/api/versions/v1").set("Authorization", `Bearer ${token}`).send({ basePathPattern: "/api/v1/" });
    expect(patchPattern.status).toBe(200);
    expect(await db.listNotifications(50)).toHaveLength(0);

    const patchStatus = await request(app).patch("/api/versions/v1").set("Authorization", `Bearer ${token}`).send({ status: "deprecated" });
    expect(patchStatus.status).toBe(200);
    const notifications = await db.listNotifications(50);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ type: "version_status", vayoId: null });
    expect(notifications[0]!.message).toContain("deprecated");
  });
});

describe("folders", () => {
  it("creates, patches, and deletes with reparenting of both sub-folders and placed endpoints", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const auth = { Authorization: `Bearer ${token}` };

    const grandparent = await request(app).post("/api/folders").set(auth).send({ name: "API", parentId: null, version: "v1" });
    const parent = await request(app).post("/api/folders").set(auth).send({ name: "Widgets", parentId: grandparent.body._id, version: "v1" });
    const child = await request(app).post("/api/folders").set(auth).send({ name: "Legacy", parentId: parent.body._id, version: "v1" });

    const renamed = await request(app).patch(`/api/folders/${parent.body._id}`).set(auth).send({ name: "Widgets v2" });
    expect(renamed.body.name).toBe("Widgets v2");

    // Place a manual endpoint into "parent", then delete "parent" — the
    // endpoint's placement override must be reparented to grandparent, not
    // silently orphaned.
    const endpoint = await request(app)
      .post("/api/endpoints/manual")
      .set(auth)
      .send({ method: "get", pathTemplate: "/api/v1/widgets", version: "v1", group: "Widgets", summary: null });
    await request(app).patch(`/api/endpoints/${endpoint.body.vayoId}/placement`).set(auth).send({ folderId: parent.body._id, order: 0 });

    const del = await request(app).delete(`/api/folders/${parent.body._id}`).set(auth);
    expect(del.status).toBe(204);

    const reparentedChild = await db.getFolder(child.body._id);
    expect(reparentedChild?.parentId).toBe(grandparent.body._id);

    const placement = await db.getOverride(`${endpoint.body.vayoId}.folderId`);
    expect(placement?.value).toBe(grandparent.body._id);
  });

  it("returns 400 for an invalid folder body", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const res = await request(app).post("/api/folders").set("Authorization", `Bearer ${token}`).send({ name: "" });
    expect(res.status).toBe(400);
  });
});

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

describe("api versions + diff + coverage + spec", () => {
  it("creates versions and lists them", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    await request(app).post("/api/versions").set("Authorization", `Bearer ${token}`).send({ version: "v1", basePathPattern: "/api/v1" });
    const list = await request(app).get("/api/versions").set("Authorization", `Bearer ${token}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].version).toBe("v1");
  });

  it("/api/spec compiles a real OpenAPI document for the version's resolved endpoints", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    await request(app)
      .post("/api/endpoints/manual")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ method: "get", pathTemplate: "/api/v1/widgets", version: "v1", group: "Widgets", summary: "List widgets" });

    const spec = await request(app).get("/api/spec?version=v1").set("Authorization", `Bearer ${token}`);
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toMatch(/^3\.1/);
    expect(Object.keys(spec.body.paths)).toContain("/api/v1/widgets");
  });

  it("/api/coverage flags endpoints with no summary and endpoints with only 2xx responses documented", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    await request(app)
      .post("/api/endpoints/manual")
      .set("Authorization", `Bearer ${token}`)
      .send({ method: "get", pathTemplate: "/api/v1/widgets", version: "v1", group: "Widgets", summary: null });

    const res = await request(app).get("/api/coverage?version=v1").set("Authorization", `Bearer ${token}`);
    expect(res.body.totalEndpoints).toBe(1);
    expect(res.body.missingSummary).toHaveLength(1);
  });

  it("/api/diff reports an endpoint added only in the target version", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    await request(app)
      .post("/api/endpoints/manual")
      .set("Authorization", `Bearer ${token}`)
      .send({ method: "get", pathTemplate: "/api/v2/widgets", version: "v2", group: "Widgets", summary: "List widgets" });

    const diff = await request(app).get("/api/diff?from=v1&to=v2").set("Authorization", `Bearer ${token}`);
    expect(diff.status).toBe(200);
    expect(diff.body.added.length).toBeGreaterThan(0);
  });

  it("/api/diff returns 400 when 'from' or 'to' is missing", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const res = await request(app).get("/api/diff?from=v1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("environments", () => {
  it("full CRUD lifecycle, editor-gated for writes, viewer-readable", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const { token: viewerToken } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const created = await request(app)
      .post("/api/environments")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ name: "Local", variables: { baseUrl: "http://localhost:4000" } });
    expect(created.status).toBe(201);

    const asViewer = await request(app)
      .post("/api/environments")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ name: "Nope", variables: {} });
    expect(asViewer.status).toBe(403);

    const list = await request(app).get("/api/environments").set("Authorization", `Bearer ${viewerToken}`);
    expect(list.body).toHaveLength(1);

    const patched = await request(app)
      .patch(`/api/environments/${created.body._id}`)
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ isDefault: true });
    expect(patched.body.isDefault).toBe(true);

    const deleted = await request(app).delete(`/api/environments/${created.body._id}`).set("Authorization", `Bearer ${editorToken}`);
    expect(deleted.status).toBe(204);
    expect(await db.listEnvironments()).toHaveLength(0);
  });
});

describe("pinned examples, test scripts, flows — smoke coverage", () => {
  it("pins an example and lists it back", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const pinned = await request(app)
      .post("/api/examples/ep_1/pin")
      .set("Authorization", `Bearer ${token}`)
      .send({ statusCode: 200, requestBody: null, responseBody: { ok: true }, label: "Happy path" });
    expect(pinned.status).toBe(201);

    const list = await request(app).get("/api/examples/ep_1").set("Authorization", `Bearer ${token}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].label).toBe("Happy path");
  });

  it("GET /api/examples/:vayoId returns real captured examples alongside pinned ones, not pinned-only", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    // A real capture (never pinned) — the rolling-window path capture-express
    // writes through, not the manual "save this response" pin action.
    await db.appendExample({
      vayoId: "ep_1",
      statusCode: 200,
      requestBody: null,
      responseBody: { id: "w1" },
      capturedAt: "2026-01-01T00:00:00.000Z",
      redacted: false,
      pinned: false,
      label: null,
    });

    const list = await request(app).get("/api/examples/ep_1").set("Authorization", `Bearer ${token}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].pinned).toBe(false);
  });

  it("upserts a test script and records a run against it", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    const saved = await request(app)
      .put("/api/test-scripts/ep_1")
      .set("Authorization", `Bearer ${token}`)
      .send({ preRequestScript: "", testScript: "pm.test('ok', () => true)" });
    expect(saved.status).toBe(200);

    const run = await request(app)
      .patch("/api/test-scripts/ep_1/last-run")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "pass", results: [{ name: "ok", passed: true }], at: new Date().toISOString() });
    expect(run.status).toBe(200);
    expect(run.body.lastRun.status).toBe("pass");
  });

  it("creates a flow, patches it, and deletes it", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    const created = await request(app)
      .post("/api/flows")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Checkout", version: "v1", steps: [{ vayoId: "ep_1" }] });
    expect(created.status).toBe(201);

    const patched = await request(app)
      .patch(`/api/flows/${created.body._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Checkout flow" });
    expect(patched.body.name).toBe("Checkout flow");

    const deleted = await request(app).delete(`/api/flows/${created.body._id}`).set("Authorization", `Bearer ${token}`);
    expect(deleted.status).toBe(204);
    expect(await db.listFlows("v1")).toHaveLength(0);
  });
});

describe("export", () => {
  it("/api/export/postman produces a Postman collection for the resolved endpoints", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    await request(app)
      .post("/api/endpoints/manual")
      .set("Authorization", `Bearer ${token}`)
      .send({ method: "get", pathTemplate: "/api/v1/widgets", version: "v1", group: "Widgets", summary: "List widgets" });

    const res = await request(app).get("/api/export/postman?version=v1").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.info).toBeTruthy();
    expect(res.body.item.length).toBeGreaterThan(0);
  });

  it("/api/export/postman-environment/:id returns 404 for an unknown environment", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const res = await request(app).get("/api/export/postman-environment/does-not-exist").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("static UI serving (@vayo/ui's built bundle, dist-app/)", () => {
  // Exercises the real @vayo/ui/dist-app built alongside this test run
  // (`pnpm --filter @vayo/ui build`) — no auth needed, these routes serve
  // the app shell itself, not data.
  it("serves the built index.html at mountPath, with the configured mountPath injected for main.tsx to read", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/vayo" });

    const res = await request(app).get("/vayo/").set("Accept", "text/html");
    expect(res.status).toBe(200);
    expect(res.type).toBe("text/html");
    expect(res.text).toContain('window.__VAYO_MOUNT_PATH__ = "/vayo"');
  });

  it("serves the same app shell for a nested client-side path (SPA fallback), not a 404", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/vayo" });

    const res = await request(app).get("/vayo/some/deep/client/route").set("Accept", "text/html");
    expect(res.status).toBe(200);
    expect(res.text).toContain('window.__VAYO_MOUNT_PATH__ = "/vayo"');
  });

  it("still serves /vayo/api/* as real API routes, not the SPA shell", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/vayo" });

    const res = await request(app).get("/vayo/api/versions");
    expect(res.status).toBe(401); // a real API 401, not a 200 HTML shell
    expect(res.type).toBe("application/json");
  });

  it("serves a real built JS asset with the right content-type", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/vayo" });

    const indexRes = await request(app).get("/vayo/").set("Accept", "text/html");
    const scriptSrc = indexRes.text.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1];
    expect(scriptSrc).toBeTruthy();

    const assetRes = await request(app).get(`/vayo/${scriptSrc}`);
    expect(assetRes.status).toBe(200);
    expect(assetRes.type).toBe("application/javascript");
  });
});
