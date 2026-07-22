import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

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
