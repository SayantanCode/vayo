import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { createFakeDb, seedMemberWithSession } from "../test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

// Route-level integration test for GET /api/coverage — the pure
// computeCoverageReport function it calls has its own dedicated unit tests
// in packages/server/src/coverage.test.ts (a different file, one directory
// up: this package's convention is a top-level *.test.ts next to a pure
// logic module, vs. routes/*.test.ts for the HTTP-route integration tests).
describe("GET /api/coverage", () => {
  it("flags endpoints with no summary and endpoints with only 2xx responses documented", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");

    await request(app)
      .post("/api/endpoints/manual")
      .set("Authorization", `Bearer ${token}`)
      .send({ method: "get", pathTemplate: "/api/v1/widgets", version: "v1", group: "Widgets", summary: null });

    const res = await request(app).get("/api/coverage?version=v1").set("Authorization", `Bearer ${token}`);
    expect(res.body.totalEndpoints).toBe(1);
    expect(res.body.missingSummary).toHaveLength(1);
  });
});
