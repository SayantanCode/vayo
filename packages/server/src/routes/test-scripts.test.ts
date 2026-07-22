import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

describe("test scripts — smoke coverage", () => {
  it("upserts a test script and records a run against it", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    const saved = await request(app)
      .put("/api/test-scripts/ep_1")
      .set("Authorization", `Bearer ${token}`)
      .send({ preRequestScript: "", testScript: "pm.test('ok', () => true)" });
    expect(saved.status).toBe(200);

    const run = await request(app)
      .patch("/api/test-scripts/ep_1/last-run")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "pass", results: [{ name: "ok", passed: true }], at: new Date().toISOString() });
    expect(run.status).toBe(200);
    expect(run.body.lastRun.status).toBe("pass");
  });
});
