import type { Request, Response } from "express";
import type { VayoDbAdapter } from "@vayo/types";
import { describe, expect, it, vi } from "vitest";
import {
  buildPathTemplate,
  capture,
  extractFileFieldNames,
  mergeFileFieldPlaceholders,
  redact,
  tryParseJson,
  unsupportedExpressVersionWarning,
} from "./index.js";

function mockRequest(baseUrl: string, routePath: string | undefined): Request {
  return { baseUrl, route: routePath !== undefined ? { path: routePath } : undefined } as unknown as Request;
}

describe("buildPathTemplate", () => {
  it("concatenates baseUrl and route path for a route registered directly on app", () => {
    expect(buildPathTemplate(mockRequest("", "/api/orders"))).toBe("/api/orders");
  });

  it("strips the spurious trailing slash from a router's own root route", () => {
    // router.get("/", ...) mounted via app.use("/api/v1/admin/customers", router)
    expect(buildPathTemplate(mockRequest("/api/v1/admin/customers", "/"))).toBe("/api/v1/admin/customers");
  });

  it("keeps a relative sub-path on a mounted router intact", () => {
    expect(buildPathTemplate(mockRequest("/api/v1/admin/customers", "/:id"))).toBe("/api/v1/admin/customers/:id");
  });

  it("keeps the literal root path as / when there's no mount prefix at all", () => {
    expect(buildPathTemplate(mockRequest("", "/"))).toBe("/");
  });

  it("collapses accidental double slashes", () => {
    expect(buildPathTemplate(mockRequest("/api/v1/cart/", "/items"))).toBe("/api/v1/cart/items");
  });

  it("returns null when the route never matched (e.g. a 404)", () => {
    expect(buildPathTemplate(mockRequest("", undefined))).toBeNull();
  });
});

describe("extractFileFieldNames", () => {
  it("returns nothing for a request with no multer file/files at all", () => {
    expect(extractFileFieldNames({} as Request)).toEqual([]);
  });

  it("picks up req.file's fieldname from a .single() upload", () => {
    const req = { file: { fieldname: "avatar" } } as unknown as Request;
    expect(extractFileFieldNames(req)).toEqual(["avatar"]);
  });

  it("picks up every fieldname from req.files as an array (.array()/.any())", () => {
    const req = { files: [{ fieldname: "photos" }, { fieldname: "photos" }, { fieldname: "receipt" }] } as unknown as Request;
    expect(extractFileFieldNames(req)).toEqual(["photos", "receipt"]);
  });

  it("picks up every key from req.files as a map (.fields())", () => {
    const req = { files: { avatar: [{ fieldname: "avatar" }], resume: [{ fieldname: "resume" }] } } as unknown as Request;
    expect(extractFileFieldNames(req)).toEqual(["avatar", "resume"]);
  });
});

describe("mergeFileFieldPlaceholders", () => {
  it("is a no-op when there are no file fields", () => {
    expect(mergeFileFieldPlaceholders({ name: "Jane" }, [])).toEqual({ name: "Jane" });
  });

  it("merges a placeholder for each file field alongside the real text fields", () => {
    expect(mergeFileFieldPlaceholders({ caption: "hi" }, ["avatar"])).toEqual({
      caption: "hi",
      avatar: "[binary file]",
    });
  });

  it("builds a fresh object from just the file fields when the body itself isn't an object", () => {
    expect(mergeFileFieldPlaceholders(undefined, ["avatar"])).toEqual({ avatar: "[binary file]" });
  });
});

describe("tryParseJson", () => {
  it("parses a hand-built JSON string back into its real shape", () => {
    expect(tryParseJson('{"id":"1","active":true}')).toEqual({ id: "1", active: true });
  });

  it("falls back to the raw string when it isn't valid JSON", () => {
    expect(tryParseJson("plain text body")).toBe("plain text body");
  });
});

describe("redact", () => {
  it("flips the optional state.redacted flag the moment any field is scrubbed", () => {
    const state = { redacted: false };
    redact({ email: "jane@corp.com", password: "hunter2" }, [/password/i], state);
    expect(state.redacted).toBe(true);
  });

  it("leaves state.redacted false when nothing matched", () => {
    const state = { redacted: false };
    redact({ email: "jane@corp.com" }, [/password/i], state);
    expect(state.redacted).toBe(false);
  });

  it("still works with no state argument at all (backward compatible)", () => {
    expect(redact({ password: "hunter2" }, [/password/i])).toEqual({ password: "[REDACTED]" });
  });
});

describe("unsupportedExpressVersionWarning", () => {
  it("returns null for a 4.x version — no warning needed", () => {
    expect(unsupportedExpressVersionWarning("4.19.2")).toBeNull();
  });

  it("returns a warning message naming both the expected and installed version for Express 5", () => {
    const message = unsupportedExpressVersionWarning("5.1.0");
    expect(message).toMatch(/expects Express 4\.x/);
    expect(message).toMatch(/found Express 5\.1\.0/);
  });
});

describe("capture() — Express version guard", () => {
  it("does not warn against the real installed Express (4.x)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = { listApiVersions: vi.fn().mockResolvedValue([]) } as unknown as VayoDbAdapter;

    capture({ db });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("capture() — appendExample wiring (docs/03-data-model.md vayo_examples)", () => {
  function mockReqRes(overrides: Partial<Request> = {}) {
    const req = {
      method: "GET",
      route: { path: "/:id" },
      baseUrl: "/api/v1/widgets",
      headers: {},
      params: { id: "w1" },
      query: {},
      body: undefined,
      ...overrides,
    } as unknown as Request;

    const res = {
      statusCode: 200,
      json(this: Response, _body?: unknown) {
        return this;
      },
      send(this: Response, _body?: unknown) {
        return this;
      },
      end(this: Response, _chunk?: unknown) {
        return this;
      },
    } as unknown as Response;

    return { req, res };
  }

  function fakeDb(): VayoDbAdapter & { appendExample: ReturnType<typeof vi.fn>; upsertEndpoint: ReturnType<typeof vi.fn> } {
    return {
      listApiVersions: vi.fn().mockResolvedValue([]),
      upsertEndpoint: vi.fn().mockResolvedValue({ vayoId: "ep_1" }),
      appendExample: vi.fn().mockResolvedValue(undefined),
    } as unknown as VayoDbAdapter & { appendExample: ReturnType<typeof vi.fn>; upsertEndpoint: ReturnType<typeof vi.fn> };
  }

  async function flushMicrotasks() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("appends a real example after a successful res.json() response", async () => {
    const db = fakeDb();
    const middleware = capture({ db });
    const { req, res } = mockReqRes();

    middleware(req, res, () => {});
    (res.json as (body: unknown) => Response)({ id: "w1", name: "Widget" });
    await flushMicrotasks();

    expect(db.appendExample).toHaveBeenCalledTimes(1);
    const example = db.appendExample.mock.calls[0]![0];
    expect(example).toMatchObject({
      vayoId: "ep_1",
      statusCode: 200,
      responseBody: { id: "w1", name: "Widget" },
      pinned: false,
      label: null,
      redacted: false,
    });
  });

  it("marks the example redacted when a sensitive field was scrubbed from the response body", async () => {
    const db = fakeDb();
    const middleware = capture({ db });
    const { req, res } = mockReqRes();

    middleware(req, res, () => {});
    (res.json as (body: unknown) => Response)({ id: "w1", apiKey: "sk_live_secret" });
    await flushMicrotasks();

    const example = db.appendExample.mock.calls[0]![0];
    expect(example.redacted).toBe(true);
    expect(example.responseBody).toEqual({ id: "w1", apiKey: "[REDACTED]" });
  });

  it("records cookie header presence (not its value) alongside authorization, for authType: cookie inference", async () => {
    const db = fakeDb();
    const middleware = capture({ db });
    const { req, res } = mockReqRes({ headers: { cookie: "sessionId=abc123; other=x" } } as Partial<Request>);

    middleware(req, res, () => {});
    (res.json as (body: unknown) => Response)({ id: "w1" });
    await flushMicrotasks();

    const sample = db.upsertEndpoint.mock.calls[0]![0];
    expect(sample.requestHeaders).toEqual({ authorization: false, cookie: true });
  });

  it("records cookie: false when no Cookie header was sent", async () => {
    const db = fakeDb();
    const middleware = capture({ db });
    const { req, res } = mockReqRes();

    middleware(req, res, () => {});
    (res.json as (body: unknown) => Response)({ id: "w1" });
    await flushMicrotasks();

    const sample = db.upsertEndpoint.mock.calls[0]![0];
    expect(sample.requestHeaders).toEqual({ authorization: false, cookie: false });
  });
});
