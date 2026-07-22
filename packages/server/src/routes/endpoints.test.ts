import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

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

  it("allows deleting a non-manual endpoint once flagEndpointsNotInScan has marked it possibly removed", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    // Promote to a non-manual source first — real capture traffic on a
    // manual placeholder merges it, same as the db-mongo adapter's own rule.
    const manual = await db.createManualEndpoint({
      method: "get",
      pathTemplate: "/api/v1/soon-to-be-removed",
      version: "v1",
      group: "Widgets",
      summary: null,
    });
    const merged = await db.upsertEndpoint({
      method: "GET",
      pathTemplate: "/api/v1/soon-to-be-removed",
      version: "v1",
      requestHeaders: {},
      requestParams: {},
      requestQuery: {},
      requestBody: null,
      responseStatus: 200,
      responseBody: {},
      middlewareNames: [],
      capturedAt: new Date().toISOString(),
    });
    expect(merged.source).toBe("merged");

    // Still blocked before it's flagged.
    const beforeFlag = await request(app).delete(`/api/endpoints/${merged.vayoId}`).set("Authorization", `Bearer ${token}`);
    expect(beforeFlag.status).toBe(400);

    const flaggedCount = await db.flagEndpointsNotInScan("v1", [], new Date().toISOString());
    expect(flaggedCount).toBe(1);

    const afterFlag = await request(app).delete(`/api/endpoints/${merged.vayoId}`).set("Authorization", `Bearer ${token}`);
    expect(afterFlag.status).toBe(204);
    expect(await db.getEndpoint(manual.vayoId)).toBeNull();
  });
});

describe("PATCH /api/endpoints/:vayoId/placement — declared group lock", () => {
  it("refuses to move a 'declared'-group endpoint to a different folder, even via a direct API call", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const auth = { Authorization: `Bearer ${token}` };

    const endpoint = await db.upsertStaticResult(
      {
        method: "GET",
        pathTemplate: "/api/v1/admin/users/:id",
        middlewareChain: [],
        authRequiredGuess: false,
        scopes: [],
        group: "Admin/Users",
        groupSource: "declared",
        summary: null,
      },
      "v1",
    );
    const homeFolder = await request(app).post("/api/folders").set(auth).send({ name: "Users", parentId: null, version: "v1" });
    const otherFolder = await request(app).post("/api/folders").set(auth).send({ name: "Somewhere else", parentId: null, version: "v1" });

    // Establish an initial placement first — a brand new "declared" endpoint
    // with no placement override yet has nothing to diverge from, so only a
    // SECOND, different placement attempt should ever be refused.
    await request(app).patch(`/api/endpoints/${endpoint.vayoId}/placement`).set(auth).send({ folderId: homeFolder.body._id, order: 0 });

    const res = await request(app)
      .patch(`/api/endpoints/${endpoint.vayoId}/placement`)
      .set(auth)
      .send({ folderId: otherFolder.body._id, order: 0 });
    expect(res.status).toBe(400);
    expect((await db.getOverride(`${endpoint.vayoId}.folderId`))?.value).toBe(homeFolder.body._id);
  });

  it("still allows reordering a 'declared'-group endpoint within its current folder", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const auth = { Authorization: `Bearer ${token}` };

    const endpoint = await db.upsertStaticResult(
      {
        method: "GET",
        pathTemplate: "/api/v1/admin/users/:id",
        middlewareChain: [],
        authRequiredGuess: false,
        scopes: [],
        group: "Admin/Users",
        groupSource: "declared",
        summary: null,
      },
      "v1",
    );
    const folder = await request(app).post("/api/folders").set(auth).send({ name: "Users", parentId: null, version: "v1" });
    // First placement — establishes its "current" folder.
    await request(app).patch(`/api/endpoints/${endpoint.vayoId}/placement`).set(auth).send({ folderId: folder.body._id, order: 0 });

    // Same folder, different order — must go through.
    const res = await request(app)
      .patch(`/api/endpoints/${endpoint.vayoId}/placement`)
      .set(auth)
      .send({ folderId: folder.body._id, order: 3 });
    expect(res.status).toBe(204);
    expect((await db.getOverride(`${endpoint.vayoId}.order`))?.value).toBe(3);
  });

  it("allows the very first placement of a 'declared'-group endpoint that has never been placed anywhere yet", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const auth = { Authorization: `Bearer ${token}` };

    const endpoint = await db.upsertStaticResult(
      {
        method: "GET",
        pathTemplate: "/api/v1/admin/users/:id",
        middlewareChain: [],
        authRequiredGuess: false,
        scopes: [],
        group: "Admin/Users",
        groupSource: "declared",
        summary: null,
      },
      "v1",
    );
    const folder = await request(app).post("/api/folders").set(auth).send({ name: "Users", parentId: null, version: "v1" });

    const res = await request(app).patch(`/api/endpoints/${endpoint.vayoId}/placement`).set(auth).send({ folderId: folder.body._id, order: 0 });
    expect(res.status).toBe(204);
    expect((await db.getOverride(`${endpoint.vayoId}.folderId`))?.value).toBe(folder.body._id);
  });

  it("does not restrict an 'inferred'-group endpoint's placement at all", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const auth = { Authorization: `Bearer ${token}` };

    const endpoint = await db.upsertStaticResult(
      {
        method: "GET",
        pathTemplate: "/api/v1/widgets/:id",
        middlewareChain: [],
        authRequiredGuess: false,
        scopes: [],
        group: "Widgets",
        groupSource: "inferred",
        summary: null,
      },
      "v1",
    );
    const folder = await request(app).post("/api/folders").set(auth).send({ name: "Anywhere", parentId: null, version: "v1" });

    const res = await request(app)
      .patch(`/api/endpoints/${endpoint.vayoId}/placement`)
      .set(auth)
      .send({ folderId: folder.body._id, order: 0 });
    expect(res.status).toBe(204);
  });
});

describe("PATCH /api/endpoints/:vayoId/deprecated", () => {
  it("lets a human flag a not-code-declared endpoint deprecated, and un-deprecate it again", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const auth = { Authorization: `Bearer ${token}` };

    const created = await request(app)
      .post("/api/endpoints/manual")
      .set(auth)
      .send({ method: "get", pathTemplate: "/api/v1/widgets", version: "v1", group: "Widgets", summary: null });

    const flagged = await request(app).patch(`/api/endpoints/${created.body.vayoId}/deprecated`).set(auth).send({ deprecated: true });
    expect(flagged.status).toBe(204);
    expect((await db.getOverride(`${created.body.vayoId}.deprecated`))?.value).toBe(true);

    const unflagged = await request(app).patch(`/api/endpoints/${created.body.vayoId}/deprecated`).set(auth).send({ deprecated: false });
    expect(unflagged.status).toBe(204);
    expect((await db.getOverride(`${created.body.vayoId}.deprecated`))?.value).toBe(false);
  });

  it("refuses to un-deprecate an endpoint whose deprecatedSource is 'declared'", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const auth = { Authorization: `Bearer ${token}` };

    const endpoint = await db.upsertStaticResult(
      {
        method: "GET",
        pathTemplate: "/api/v1/legacy",
        middlewareChain: [],
        authRequiredGuess: false,
        scopes: [],
        group: "Legacy",
        summary: null,
        deprecated: true,
      },
      "v1",
    );
    expect(endpoint.deprecatedSource).toBe("declared");

    const res = await request(app).patch(`/api/endpoints/${endpoint.vayoId}/deprecated`).set(auth).send({ deprecated: false });
    expect(res.status).toBe(400);
    expect(await db.getOverride(`${endpoint.vayoId}.deprecated`)).toBeNull();
  });

  it("allows re-declaring an already-true 'declared' deprecation as a no-op", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const auth = { Authorization: `Bearer ${token}` };

    const endpoint = await db.upsertStaticResult(
      {
        method: "GET",
        pathTemplate: "/api/v1/legacy",
        middlewareChain: [],
        authRequiredGuess: false,
        scopes: [],
        group: "Legacy",
        summary: null,
        deprecated: true,
      },
      "v1",
    );

    const res = await request(app).patch(`/api/endpoints/${endpoint.vayoId}/deprecated`).set(auth).send({ deprecated: true });
    expect(res.status).toBe(204);
  });

  it("404s for a vayoId that doesn't exist", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const res = await request(app)
      .patch("/api/endpoints/no-such-vayo-id/deprecated")
      .set("Authorization", `Bearer ${token}`)
      .send({ deprecated: true });
    expect(res.status).toBe(404);
  });

  it("403s for a viewer (editor role required)", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const res = await request(app)
      .patch("/api/endpoints/no-such-vayo-id/deprecated")
      .set("Authorization", `Bearer ${token}`)
      .send({ deprecated: true });
    expect(res.status).toBe(403);
  });
});
