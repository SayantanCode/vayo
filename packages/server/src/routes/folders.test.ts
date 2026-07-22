import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

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
