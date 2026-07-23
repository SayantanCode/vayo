import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

describe("settings", () => {
  it("defaults to 'Vayo API'/null description, editor-gated for writes, viewer-readable", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const { token: viewerToken } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const initial = await request(app).get("/api/settings").set("Authorization", `Bearer ${viewerToken}`);
    expect(initial.body).toMatchObject({ title: "Vayo API", description: null });

    const asViewer = await request(app)
      .patch("/api/settings")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ title: "Nope" });
    expect(asViewer.status).toBe(403);

    const updated = await request(app)
      .patch("/api/settings")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ title: "My Company API", description: "Internal order-management API." });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ title: "My Company API", description: "Internal order-management API." });

    const refetched = await request(app).get("/api/settings").set("Authorization", `Bearer ${viewerToken}`);
    expect(refetched.body).toMatchObject({ title: "My Company API", description: "Internal order-management API." });
  });

  it("rejects an empty title, but allows clearing description back to null", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    const emptyTitle = await request(app).patch("/api/settings").set("Authorization", `Bearer ${token}`).send({ title: "" });
    expect(emptyTitle.status).toBe(400);

    await request(app)
      .patch("/api/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ description: "Something." });
    const cleared = await request(app)
      .patch("/api/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ description: null });
    expect(cleared.body.description).toBeNull();
  });
});
