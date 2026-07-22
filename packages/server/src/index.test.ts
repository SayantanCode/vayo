import { createServer as createHttpServer } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./index.js";
import { createFakeDb } from "./test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";

describe("createServer — httpServer / socketPath options", () => {
  it("creates its own httpServer when none is provided", () => {
    const db = createFakeDb();
    const { httpServer } = createServer({ db, sessionSecret: SESSION_SECRET });
    expect(httpServer).toBeDefined();
  });

  it("returns the exact same httpServer instance when one is provided — no second server created", () => {
    const db = createFakeDb();
    const myOwnHttpServer = createHttpServer();
    const { httpServer } = createServer({ db, sessionSecret: SESSION_SECRET, httpServer: myOwnHttpServer });
    expect(httpServer).toBe(myOwnHttpServer);
  });

  it("defaults the Socket.IO path to `${mountPath}/socket.io`, not Engine.IO's bare default", () => {
    const db = createFakeDb();
    const { io } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/docs" });
    expect(io.path()).toBe("/docs/socket.io");
  });

  it("normalizes a root mountPath so the socket path isn't a doubled slash", () => {
    const db = createFakeDb();
    const { io } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/" });
    expect(io.path()).toBe("/socket.io");
  });

  it("lets socketPath override the mountPath-derived default entirely", () => {
    const db = createFakeDb();
    const { io } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/docs", socketPath: "/my-custom-ws" });
    expect(io.path()).toBe("/my-custom-ws");
  });

  describe("upgrade-listener conflict warning", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("does not warn when Vayo creates its own httpServer (can't possibly have a pre-existing upgrade listener)", () => {
      const db = createFakeDb();
      createServer({ db, sessionSecret: SESSION_SECRET });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not warn when a provided httpServer has no upgrade listeners yet", () => {
      const db = createFakeDb();
      const myOwnHttpServer = createHttpServer();
      createServer({ db, sessionSecret: SESSION_SECRET, httpServer: myOwnHttpServer });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns when a provided httpServer already has an upgrade handler attached", () => {
      const db = createFakeDb();
      const myOwnHttpServer = createHttpServer();
      // Standing in for the host's own WebSocket/Socket.IO server, already
      // attached before Vayo's createServer() gets a chance to.
      myOwnHttpServer.on("upgrade", () => {});
      createServer({ db, sessionSecret: SESSION_SECRET, httpServer: myOwnHttpServer });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/upgrade|websocket/i);
    });
  });
});

describe("static UI serving (@vayo/ui's built bundle, dist-app/)", () => {
  // Exercises the real @vayo/ui/dist-app built alongside this test run
  // (`pnpm --filter @vayo/ui build`) — no auth needed, these routes serve
  // the app shell itself, not data.
  it("serves the built index.html at mountPath, with the configured mountPath injected for main.tsx to read", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/vayo" });

    const res = await request(app).get("/vayo/").set("Accept", "text/html");
    expect(res.status).toBe(200);
    expect(res.type).toBe("text/html");
    expect(res.text).toContain('window.__VAYO_MOUNT_PATH__ = "/vayo"');
  });

  it("serves the same app shell for a nested client-side path (SPA fallback), not a 404", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/vayo" });

    const res = await request(app).get("/vayo/some/deep/client/route").set("Accept", "text/html");
    expect(res.status).toBe(200);
    expect(res.text).toContain('window.__VAYO_MOUNT_PATH__ = "/vayo"');
  });

  it("still serves /vayo/api/* as real API routes, not the SPA shell", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/vayo" });

    const res = await request(app).get("/vayo/api/versions");
    expect(res.status).toBe(401); // a real API 401, not a 200 HTML shell
    expect(res.type).toBe("application/json");
  });

  it("serves a real built JS asset with the right content-type", async () => {
    const db = createFakeDb();
    const { app } = createServer({ db, sessionSecret: SESSION_SECRET, mountPath: "/vayo" });

    const indexRes = await request(app).get("/vayo/").set("Accept", "text/html");
    const scriptSrc = indexRes.text.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1];
    expect(scriptSrc).toBeTruthy();

    const assetRes = await request(app).get(`/vayo/${scriptSrc}`);
    expect(assetRes.status).toBe(200);
    expect(assetRes.type).toBe("application/javascript");
  });
});
