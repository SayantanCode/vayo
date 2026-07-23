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

  it("/api/spec pulls title/description from vayo_settings and servers from vayo_environments (baseUrl only)", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    await request(app)
      .patch("/api/settings")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ title: "My Company API", description: "Internal order-management API." });
    await request(app)
      .post("/api/environments")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ name: "Production", variables: { baseUrl: "https://api.example.com" } });
    await request(app)
      .post("/api/environments")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ name: "No base URL yet", variables: {} });

    const spec = await request(app).get("/api/spec?version=v1").set("Authorization", `Bearer ${token}`);
    expect(spec.body.info).toMatchObject({ title: "My Company API", description: "Internal order-management API." });
    expect(spec.body.servers).toEqual([{ url: "https://api.example.com", description: "Production" }]);
  });

  it("/api/spec compiles a pinned example into the response's own examples field, but not an unpinned one", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    const created = await request(app)
      .post("/api/endpoints/manual")
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ method: "get", pathTemplate: "/api/v1/widgets", version: "v1", group: "Widgets", summary: "List widgets" });
    const vayoId = created.body.vayoId as string;

    await request(app)
      .post(`/api/examples/${vayoId}/pin`)
      .set("Authorization", `Bearer ${token}`)
      .send({ statusCode: 200, requestBody: null, responseBody: { id: "abc123" }, label: "Successful list" });

    const spec = await request(app).get("/api/spec?version=v1").set("Authorization", `Bearer ${token}`);
    const response200 = spec.body.paths["/api/v1/widgets"].get.responses["200"];
    expect(response200.content["application/json"].examples).toEqual({
      "successful-list": { value: { id: "abc123" } },
    });
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
