import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

describe("pinned examples — smoke coverage", () => {
  it("pins an example and lists it back", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    const pinned = await request(app)
      .post("/api/examples/ep_1/pin")
      .set("Authorization", `Bearer ${token}`)
      .send({ statusCode: 200, requestBody: null, responseBody: { ok: true }, label: "Happy path" });
    expect(pinned.status).toBe(201);

    const list = await request(app).get("/api/examples/ep_1").set("Authorization", `Bearer ${token}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].label).toBe("Happy path");
  });

  it("GET /api/examples/:vayoId returns real captured examples alongside pinned ones, not pinned-only", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");

    // A real capture (never pinned) — the rolling-window path capture-express
    // writes through, not the manual "save this response" pin action.
    await db.appendExample({
      vayoId: "ep_1",
      statusCode: 200,
      requestBody: null,
      responseBody: { id: "w1" },
      capturedAt: "2026-01-01T00:00:00.000Z",
      redacted: false,
      pinned: false,
      label: null,
    });

    const list = await request(app).get("/api/examples/ep_1").set("Authorization", `Bearer ${token}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].pinned).toBe(false);
  });
});
