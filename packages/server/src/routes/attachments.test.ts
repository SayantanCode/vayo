import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

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
