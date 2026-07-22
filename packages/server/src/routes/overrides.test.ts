import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

describe("overrides — persistence + audit log", () => {
  it("applies the override, writes it under the endpoint's vayoId (not the full targetId) in the audit log", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token, member } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    const res = await request(app)
      .post("/api/overrides")
      .set("Authorization", `Bearer ${token}`)
      .send({ targetId: "ep_1.summary", value: "Fetch a widget", reason: "clarify" });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe("Fetch a widget");

    const stored = await db.getOverride("ep_1.summary");
    expect(stored?.updatedBy).toBe(member._id);

    const log = await db.listAuditLog("ep_1");
    expect(log).toHaveLength(1);
    expect(log[0]!.action).toBe("override");
    expect(log[0]!.diff).toEqual({ before: null, after: "Fetch a widget" });

    const notifications = await db.listNotifications(50);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ type: "override", vayoId: "ep_1", actorId: member._id, message: "updated summary" });
  });

  it("returns 400 for a body missing the required targetId", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    const res = await request(app).post("/api/overrides").set("Authorization", `Bearer ${token}`).send({ value: "x" });
    expect(res.status).toBe(400);
  });

  it("refuses to write ${vayoId}.deprecated=false through this generic route too, not just the dedicated /deprecated route", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const auth = { Authorization: `Bearer ${token}` };

    const endpoint = await db.upsertStaticResult(
      { method: "GET", pathTemplate: "/api/v1/legacy", middlewareChain: [], authRequiredGuess: false, scopes: [], group: "Legacy", summary: null, deprecated: true },
      "v1",
    );
    expect(endpoint.deprecatedSource).toBe("declared");

    const res = await request(app).post("/api/overrides").set(auth).send({ targetId: `${endpoint.vayoId}.deprecated`, value: false });
    expect(res.status).toBe(400);
  });

  it("refuses to move a 'declared'-group endpoint's folderId through this generic route too, not just /placement", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const auth = { Authorization: `Bearer ${token}` };

    const endpoint = await db.upsertStaticResult(
      { method: "GET", pathTemplate: "/api/v1/admin/users/:id", middlewareChain: [], authRequiredGuess: false, scopes: [], group: "Admin/Users", groupSource: "declared", summary: null },
      "v1",
    );
    await request(app).patch(`/api/endpoints/${endpoint.vayoId}/placement`).set(auth).send({ folderId: "folder_home", order: 0 });

    const res = await request(app).post("/api/overrides").set(auth).send({ targetId: `${endpoint.vayoId}.folderId`, value: "folder_elsewhere" });
    expect(res.status).toBe(400);
    expect((await db.getOverride(`${endpoint.vayoId}.folderId`))?.value).toBe("folder_home");
  });
});
