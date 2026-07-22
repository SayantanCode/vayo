import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

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
