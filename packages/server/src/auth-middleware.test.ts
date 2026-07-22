import { describe, expect, it } from "vitest";
import { requireRole } from "./auth-middleware.js";

describe("requireRole (pure middleware factory)", () => {
  function mockRes() {
    const res: { statusCode?: number; body?: unknown; status: (n: number) => typeof res; json: (b: unknown) => void } = {
      status(n: number) {
        res.statusCode = n;
        return res;
      },
      json(b: unknown) {
        res.body = b;
      },
    };
    return res;
  }

  it("returns 401 when there's no auth at all", () => {
    const res = mockRes();
    let nextCalled = false;
    requireRole("viewer")({ vayoAuth: null } as never, res as never, () => {
      nextCalled = true;
    });
    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it("returns 403 when the role is present but ranked too low", () => {
    const res = mockRes();
    requireRole("owner")({ vayoAuth: { memberId: "m", role: "editor" } } as never, res as never, () => {});
    expect(res.statusCode).toBe(403);
  });

  it("calls next() when the role meets the minimum", () => {
    const res = mockRes();
    let nextCalled = false;
    requireRole("editor")({ vayoAuth: { memberId: "m", role: "owner" } } as never, res as never, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });
});
