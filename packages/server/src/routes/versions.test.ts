import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

describe("api versions + diff + spec", () => {
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
