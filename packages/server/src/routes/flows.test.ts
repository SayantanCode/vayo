import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

describe("flows — smoke coverage", () => {
  it("creates a flow, patches it, and deletes it", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    const created = await request(app)
      .post("/api/flows")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Checkout", version: "v1", steps: [{ vayoId: "ep_1" }] });
    expect(created.status).toBe(201);

    const patched = await request(app)
      .patch(`/api/flows/${created.body._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Checkout flow" });
    expect(patched.body.name).toBe("Checkout flow");

    const deleted = await request(app).delete(`/api/flows/${created.body._id}`).set("Authorization", `Bearer ${token}`);
    expect(deleted.status).toBe(204);
    expect(await db.listFlows("v1")).toHaveLength(0);
  });
});
