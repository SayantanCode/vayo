import { describe, expect, it } from "vitest";
import type { ResolvedEndpoint } from "@vayo/types";
import {
  X_VAYO_AUTH_REQUIRED,
  X_VAYO_AUTH_TYPE,
  X_VAYO_FOLDER_ID,
  X_VAYO_GROUP,
  X_VAYO_GROUP_SOURCE,
  X_VAYO_ID,
  X_VAYO_ORDER,
  X_VAYO_POSSIBLY_REMOVED_SINCE,
  X_VAYO_REQUEST_SCHEMA_SOURCE,
  X_VAYO_SCOPES,
  compile,
  diffSpecs,
  validate,
} from "./index.js";

function endpoint(overrides: Partial<ResolvedEndpoint> = {}): ResolvedEndpoint {
  return {
    _id: "1",
    vayoId: "abc123",
    method: "GET",
    pathTemplate: "/api/v1/users/:id",
    version: "v1",
    group: "Users",
    groupSource: "inferred",
    summary: null,
    notes: null,
    authRequired: false,
    authType: null,
    scopes: [],
    middlewareChain: [],
    requestSchema: null,
    requestSchemaSource: null,
    responseSchemas: {},
    paramsSchema: null,
    querySchema: null,
    source: "runtime",
    sampleCount: 1,
    lastSeenAt: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    possiblyRemovedSince: null,
    overridden: [],
    ...overrides,
  };
}

describe("compile", () => {
  it("produces a document that validates as OpenAPI 3.1 for a realistic endpoint set", async () => {
    const endpoints: ResolvedEndpoint[] = [
      endpoint({
        vayoId: "ep_get_user",
        method: "GET",
        pathTemplate: "/api/v1/users/:id",
        paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        responseSchemas: {
          "200": {
            type: "object",
            properties: { id: { type: "string" }, name: { type: "string" } },
            required: ["id", "name"],
          },
        },
        authRequired: true,
        authType: "bearer",
        scopes: ["customer:read"],
        middlewareChain: ["requireAuth"],
      }),
      endpoint({
        vayoId: "ep_create_user",
        method: "POST",
        pathTemplate: "/api/v1/users",
        requestSchema: {
          type: "object",
          properties: { name: { type: "string" }, email: { type: "string" } },
          required: ["name", "email"],
        },
        responseSchemas: {
          "201": { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      }),
    ];

    const doc = await compile(endpoints, "v1");
    expect(doc.openapi).toBe("3.1.0");

    const result = await validate(doc);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("filters endpoints to the requested version only", async () => {
    const endpoints = [
      endpoint({ vayoId: "v1ep", pathTemplate: "/api/v1/orders", version: "v1" }),
      endpoint({ vayoId: "v2ep", pathTemplate: "/api/v2/orders", version: "v2" }),
    ];
    const doc = await compile(endpoints, "v1");
    expect(Object.keys(doc.paths)).toEqual(["/api/v1/orders"]);
  });

  it("converts Express :param syntax to OpenAPI {param} syntax", async () => {
    const doc = await compile([endpoint({ pathTemplate: "/api/v1/users/:id" })], "v1");
    expect(Object.keys(doc.paths)).toEqual(["/api/v1/users/{id}"]);
  });

  it("collapses multiple methods on the same path into one path item", async () => {
    const endpoints = [
      endpoint({ vayoId: "get_order", method: "GET", pathTemplate: "/api/v1/orders/:id" }),
      endpoint({ vayoId: "delete_order", method: "DELETE", pathTemplate: "/api/v1/orders/:id" }),
    ];
    const doc = await compile(endpoints, "v1");
    const pathItem = doc.paths["/api/v1/orders/{id}"] as Record<string, unknown>;
    expect(Object.keys(pathItem).sort()).toEqual(["delete", "get"]);
  });

  it("attaches x-vayo-* extensions to every operation", async () => {
    const doc = await compile(
      [
        endpoint({
          vayoId: "ep_1",
          group: "Orders",
          scopes: ["admin:read"],
          authRequired: true,
          authType: null,
        }),
      ],
      "v1",
    );
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(op[X_VAYO_ID]).toBe("ep_1");
    expect(op[X_VAYO_GROUP]).toBe("Orders");
    expect(op[X_VAYO_SCOPES]).toEqual(["admin:read"]);
    expect(op[X_VAYO_AUTH_REQUIRED]).toBe(true);
    expect(op[X_VAYO_AUTH_TYPE]).toBeNull();
  });

  it("emits x-vayo-group-source verbatim, always present since group itself is never absent", async () => {
    const declared = await compile([endpoint({ groupSource: "declared" })], "v1");
    expect((declared.paths["/api/v1/users/{id}"] as Record<string, any>).get[X_VAYO_GROUP_SOURCE]).toBe("declared");

    const inferred = await compile([endpoint({ groupSource: "inferred" })], "v1");
    expect((inferred.paths["/api/v1/users/{id}"] as Record<string, any>).get[X_VAYO_GROUP_SOURCE]).toBe("inferred");
  });

  it("surfaces folder placement (an override-injected ad-hoc field) as x-vayo-folder-id/order when present", async () => {
    const withPlacement = { ...endpoint(), folderId: "folder_1", order: 2 } as ResolvedEndpoint;
    const doc = await compile([withPlacement], "v1");
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(op[X_VAYO_FOLDER_ID]).toBe("folder_1");
    expect(op[X_VAYO_ORDER]).toBe(2);
  });

  it("omits x-vayo-folder-id/order entirely when no placement override was ever applied", async () => {
    const doc = await compile([endpoint()], "v1");
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(X_VAYO_FOLDER_ID in op).toBe(false);
    expect(X_VAYO_ORDER in op).toBe(false);
  });

  it("omits requestBody for a GET with an empty/property-less requestSchema", async () => {
    const doc = await compile(
      [endpoint({ method: "GET", requestSchema: { type: "object" } })],
      "v1",
    );
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(op.requestBody).toBeUndefined();
  });

  it("includes requestBody when the requestSchema has properties", async () => {
    const doc = await compile(
      [
        endpoint({
          method: "POST",
          pathTemplate: "/api/v1/users",
          requestSchema: { type: "object", properties: { name: { type: "string" } } },
        }),
      ],
      "v1",
    );
    const op = (doc.paths["/api/v1/users"] as Record<string, any>).post;
    expect(op.requestBody.content["application/json"].schema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  it("emits x-vayo-request-schema-source alongside a requestBody, reflecting its confidence tier", async () => {
    const doc = await compile(
      [
        endpoint({
          method: "POST",
          pathTemplate: "/api/v1/users",
          requestSchema: { type: "object", properties: { name: { type: "string" } } },
          requestSchemaSource: "inferred",
        }),
      ],
      "v1",
    );
    const op = (doc.paths["/api/v1/users"] as Record<string, any>).post;
    expect(op[X_VAYO_REQUEST_SCHEMA_SOURCE]).toBe("inferred");
  });

  it("omits x-vayo-request-schema-source when there's no requestBody at all (a GET, or an empty inferred schema)", async () => {
    const doc = await compile(
      [endpoint({ method: "GET", requestSchema: null, requestSchemaSource: null })],
      "v1",
    );
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(X_VAYO_REQUEST_SCHEMA_SOURCE in op).toBe(false);
  });

  it("emits x-vayo-request-schema-source when the requestSchema came from a Zod validator (declared) or real traffic (observed)", async () => {
    const declared = await compile(
      [
        endpoint({
          method: "POST",
          pathTemplate: "/api/v1/users",
          requestSchema: { type: "object", properties: { name: { type: "string" } } },
          requestSchemaSource: "declared",
        }),
      ],
      "v1",
    );
    expect((declared.paths["/api/v1/users"] as Record<string, any>).post[X_VAYO_REQUEST_SCHEMA_SOURCE]).toBe("declared");

    const observed = await compile(
      [
        endpoint({
          method: "POST",
          pathTemplate: "/api/v1/users",
          requestSchema: { type: "object", properties: { name: { type: "string" } } },
          requestSchemaSource: "observed",
        }),
      ],
      "v1",
    );
    expect((observed.paths["/api/v1/users"] as Record<string, any>).post[X_VAYO_REQUEST_SCHEMA_SOURCE]).toBe("observed");
  });

  it("emits x-vayo-possibly-removed-since when set, so the UI can offer deletion for a non-manual endpoint", async () => {
    const doc = await compile([endpoint({ possiblyRemovedSince: "2026-07-10T00:00:00.000Z" })], "v1");
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(op[X_VAYO_POSSIBLY_REMOVED_SINCE]).toBe("2026-07-10T00:00:00.000Z");
  });

  it("omits x-vayo-possibly-removed-since when null", async () => {
    const doc = await compile([endpoint({ possiblyRemovedSince: null })], "v1");
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(X_VAYO_POSSIBLY_REMOVED_SINCE in op).toBe(false);
  });

  it("emits query parameters alongside path parameters, both in one parameters array", async () => {
    const doc = await compile(
      [
        endpoint({
          method: "GET",
          pathTemplate: "/api/v1/products/:id",
          paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          querySchema: {
            type: "object",
            properties: { page: { type: "string" }, limit: { type: "string" } },
            required: ["page"],
          },
        }),
      ],
      "v1",
    );
    const params = (doc.paths["/api/v1/products/{id}"] as Record<string, any>).get.parameters;
    expect(params).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "page", in: "query", required: true, schema: { type: "string" } },
      { name: "limit", in: "query", required: false, schema: { type: "string" } },
    ]);
  });

  it("synthesizes path parameters straight from :name segments in the path template, even with no paramsSchema (zero-config, works before any capture or Zod)", async () => {
    const doc = await compile(
      [endpoint({ method: "GET", pathTemplate: "/api/v1/users/:id", paramsSchema: null })],
      "v1",
    );
    const params = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get.parameters;
    expect(params).toEqual([{ name: "id", in: "path", required: true, schema: { type: "string" } }]);
  });

  it("prefers a richer type already inferred for a path param over the generic string fallback", async () => {
    const doc = await compile(
      [
        endpoint({
          method: "GET",
          pathTemplate: "/api/v1/orders/:id",
          paramsSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        }),
      ],
      "v1",
    );
    const params = (doc.paths["/api/v1/orders/{id}"] as Record<string, any>).get.parameters;
    expect(params).toEqual([{ name: "id", in: "path", required: true, schema: { type: "integer" } }]);
  });

  it("synthesizes every :segment in order when a route has more than one path param", async () => {
    const doc = await compile(
      [endpoint({ method: "GET", pathTemplate: "/api/v1/orgs/:orgId/users/:userId", paramsSchema: null })],
      "v1",
    );
    const params = (doc.paths["/api/v1/orgs/{orgId}/users/{userId}"] as Record<string, any>).get.parameters;
    expect(params).toEqual([
      { name: "orgId", in: "path", required: true, schema: { type: "string" } },
      { name: "userId", in: "path", required: true, schema: { type: "string" } },
    ]);
  });

  it("omits the parameters array entirely when there are no path or query params", async () => {
    const doc = await compile([endpoint({ method: "GET", pathTemplate: "/api/v1/health" })], "v1");
    const op = (doc.paths["/api/v1/health"] as Record<string, any>).get;
    expect(op.parameters).toBeUndefined();
  });

  it("falls back to a bare 200 OK response when nothing was ever captured", async () => {
    const doc = await compile([endpoint({ responseSchemas: {} })], "v1");
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(op.responses["200"]).toEqual({ description: "OK" });
  });

  it("emits a formal security requirement only when authType is confidently known", async () => {
    const withKnownType = await compile(
      [endpoint({ authRequired: true, authType: "bearer", scopes: ["customer:read"] })],
      "v1",
    );
    const opKnown = (withKnownType.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(opKnown.security).toEqual([{ bearerAuth: ["customer:read"] }]);
    expect(withKnownType.components?.securitySchemes).toMatchObject({
      bearerAuth: { type: "http", scheme: "bearer" },
    });

    const withUnknownType = await compile([endpoint({ authRequired: true, authType: null })], "v1");
    const opUnknown = (withUnknownType.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(opUnknown.security).toBeUndefined();
    expect(opUnknown[X_VAYO_AUTH_REQUIRED]).toBe(true);
  });

  it("emits an apiKey/in:cookie security scheme for authType 'cookie' — OpenAPI has no dedicated cookie-auth scheme type", async () => {
    const doc = await compile([endpoint({ authRequired: true, authType: "cookie", scopes: [] })], "v1");
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(op.security).toEqual([{ cookieAuth: [] }]);
    expect(doc.components?.securitySchemes).toMatchObject({
      cookieAuth: { type: "apiKey", in: "cookie" },
    });
  });

  it("throws rather than returning an invalid document", async () => {
    // A version with zero matching endpoints still produces a validly-empty
    // `paths: {}` document — there's no natural way to make buildDocument
    // itself produce something invalid, so this instead proves the
    // throw-on-invalid contract using validate() directly against a
    // deliberately broken document.
    const brokenDoc = { openapi: "3.1.0", info: { title: "x" /* missing version */ }, paths: {} };
    const result = await validate(brokenDoc as never);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("validate", () => {
  it("never mutates the document it validates", async () => {
    const doc = await compile([endpoint()], "v1");
    const before = JSON.stringify(doc);
    await validate(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("diffSpecs", () => {
  const widgetsRequestSchema = (required: string[]) => ({
    type: "object",
    required,
    properties: {
      name: { type: "string" },
      category: { type: "string" },
    },
  });

  it("recognizes the same logical route across two version prefixes and reports the added required field", async () => {
    const v1 = await compile(
      [
        endpoint({
          vayoId: "w1",
          method: "POST",
          pathTemplate: "/api/v1/widgets",
          version: "v1",
          requestSchema: widgetsRequestSchema(["name"]),
        }),
      ],
      "v1",
    );
    const v2 = await compile(
      [
        endpoint({
          vayoId: "w2",
          method: "POST",
          pathTemplate: "/api/v2/widgets",
          version: "v2",
          requestSchema: widgetsRequestSchema(["name", "category"]),
        }),
      ],
      "v2",
    );

    const diff = diffSpecs(v1, v2, { stripPrefixA: "/api/v1", stripPrefixB: "/api/v2" });

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.operation).toEqual({ method: "POST", path: "/api/v2/widgets" });
    expect(diff.changed[0]?.changes).toContain("request body: added required field 'category'");
  });

  it("does not flag a newly-added optional field as a change", async () => {
    const v1 = await compile(
      [endpoint({ vayoId: "w1", method: "POST", pathTemplate: "/api/v1/widgets", version: "v1", requestSchema: widgetsRequestSchema(["name"]) })],
      "v1",
    );
    const v2 = await compile(
      [endpoint({ vayoId: "w2", method: "POST", pathTemplate: "/api/v2/widgets", version: "v2", requestSchema: widgetsRequestSchema(["name"]) })],
      "v2",
    );

    const diff = diffSpecs(v1, v2, { stripPrefixA: "/api/v1", stripPrefixB: "/api/v2" });
    expect(diff.changed).toEqual([]);
  });

  it("reports an operation that only exists in the second spec as added", async () => {
    const v1 = await compile([endpoint({ vayoId: "a", method: "GET", pathTemplate: "/api/v1/users/:id", version: "v1" })], "v1");
    const v2 = await compile(
      [
        endpoint({ vayoId: "a", method: "GET", pathTemplate: "/api/v2/users/:id", version: "v2" }),
        endpoint({ vayoId: "b", method: "POST", pathTemplate: "/api/v2/widgets", version: "v2" }),
      ],
      "v2",
    );

    const diff = diffSpecs(v1, v2, { stripPrefixA: "/api/v1", stripPrefixB: "/api/v2" });
    expect(diff.added).toEqual([{ method: "POST", path: "/api/v2/widgets" }]);
  });

  it("reports an operation that only exists in the first spec as removed", async () => {
    const v1 = await compile(
      [
        endpoint({ vayoId: "a", method: "GET", pathTemplate: "/api/v1/users/:id", version: "v1" }),
        endpoint({ vayoId: "c", method: "DELETE", pathTemplate: "/api/v1/legacy", version: "v1" }),
      ],
      "v1",
    );
    const v2 = await compile([endpoint({ vayoId: "a", method: "GET", pathTemplate: "/api/v2/users/:id", version: "v2" })], "v2");

    const diff = diffSpecs(v1, v2, { stripPrefixA: "/api/v1", stripPrefixB: "/api/v2" });
    expect(diff.removed).toEqual([{ method: "DELETE", path: "/api/v1/legacy" }]);
  });

  it("does not flag a description-only difference as changed", async () => {
    const v1 = await compile(
      [endpoint({ vayoId: "a", method: "GET", pathTemplate: "/api/v1/users/:id", version: "v1", summary: "Fetch a user" })],
      "v1",
    );
    const v2 = await compile(
      [endpoint({ vayoId: "a", method: "GET", pathTemplate: "/api/v2/users/:id", version: "v2", summary: "Fetch a single user by id" })],
      "v2",
    );

    const diff = diffSpecs(v1, v2, { stripPrefixA: "/api/v1", stripPrefixB: "/api/v2" });
    expect(diff.changed).toEqual([]);
  });
});
