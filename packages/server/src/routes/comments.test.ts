import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

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
