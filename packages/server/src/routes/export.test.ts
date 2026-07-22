import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

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
