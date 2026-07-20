import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { autoCatchAsyncErrors, errorHandler } from "./error-handling.js";

describe("autoCatchAsyncErrors + errorHandler", () => {
  function buildApp() {
    const app = express();
    const router = autoCatchAsyncErrors(express.Router());

    router.get("/sync-throw", () => {
      throw new Error("boom (sync)");
    });
    router.get("/async-reject", async () => {
      throw new Error("boom (async)");
    });
    router.get("/ok", async (_req, res) => {
      res.json({ ok: true });
    });
    // A route with non-async middleware ahead of the async handler — proves
    // wrapping every handler in the chain doesn't break a normal multi-
    // middleware route (the shape every real @vayo/server route actually is:
    // requireRole, then an async body).
    router.post("/with-middleware", (_req, _res, next) => next(), async () => {
      throw new Error("boom (after sync middleware)");
    });

    app.use(express.json());
    app.use(router);
    app.use(errorHandler);
    return app;
  }

  it("a route that synchronously throws still gets a clean 500, not a crash", async () => {
    const app = buildApp();
    const res = await request(app).get("/sync-throw");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal server error" });
  });

  it("a route whose async handler rejects gets a clean 500 instead of hanging forever", async () => {
    const app = buildApp();
    const res = await request(app).get("/async-reject");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal server error" });
  });

  it("a route with sync middleware ahead of a rejecting async handler still gets a clean 500", async () => {
    const app = buildApp();
    const res = await request(app).post("/with-middleware");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal server error" });
  });

  it("does not interfere with a route that succeeds normally", async () => {
    const app = buildApp();
    const res = await request(app).get("/ok");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("errorHandler is a no-op if headers were already sent", () => {
    const res = {
      headersSent: true,
      status: () => {
        throw new Error("should not be called");
      },
    };
    expect(() => errorHandler(new Error("late"), {} as never, res as never, () => {})).not.toThrow();
  });
});
