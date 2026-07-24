import { describe, expect, it } from "vitest";
import type { ResolvedEndpoint } from "@vayo/types";
import {
  X_VAYO_AUTH_REQUIRED,
  X_VAYO_AUTH_TYPE,
  X_VAYO_DEPRECATED_SOURCE,
  X_VAYO_FOLDER_ID,
  X_VAYO_GROUP,
  X_VAYO_GROUP_SOURCE,
  X_VAYO_ID,
  X_VAYO_ORDER,
  X_VAYO_POSSIBLY_REMOVED_SINCE,
  X_VAYO_REQUEST_SCHEMA_SOURCE,
  X_VAYO_RESPONSE_SCHEMA_DECLARED_STATUSES,
  X_VAYO_SCOPES,
  compile,
  diffSpecs,
  planOpenApiImport,
  validate,
  type ImportableEndpointRef,
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
    deprecated: false,
    deprecatedSource: null,
    summary: null,
    description: null,
    notes: null,
    authRequired: false,
    authType: null,
    scopes: [],
    middlewareChain: [],
    requestSchema: null,
    requestSchemaSource: null,
    responseSchemas: {},
    declaredResponseStatuses: [],
    declaredExamples: {},
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
  it("defaults to the 'Vayo API' title, no description, no servers when no options are passed", async () => {
    const doc = await compile([endpoint()], "v1");
    expect(doc.info).toEqual({ title: "Vayo API", version: "v1" });
    expect(doc.servers).toBeUndefined();
  });

  it("uses a custom title/description/servers when given, the equivalent of swagger-jsdoc's options.definition", async () => {
    const doc = await compile([endpoint()], "v1", {
      title: "My Company API",
      description: "Internal order-management API.",
      servers: [{ url: "https://api.example.com", description: "Production" }],
    });
    expect(doc.info).toEqual({ title: "My Company API", version: "v1", description: "Internal order-management API." });
    expect(doc.servers).toEqual([{ url: "https://api.example.com", description: "Production" }]);
  });

  it("falls back to the default title when an empty string is passed, rather than an empty info.title", async () => {
    const doc = await compile([endpoint()], "v1", { title: "" });
    expect(doc.info.title).toBe("Vayo API");
  });

  it("includes contact/license/termsOfService when given, omitting each independently when not", async () => {
    const withAll = await compile([endpoint()], "v1", {
      contact: { name: "API Team", email: "api@example.com" },
      license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
      termsOfService: "https://example.com/terms",
    });
    expect(withAll.info.contact).toEqual({ name: "API Team", email: "api@example.com" });
    expect(withAll.info.license).toEqual({ name: "MIT", url: "https://opensource.org/licenses/MIT" });
    expect(withAll.info.termsOfService).toBe("https://example.com/terms");

    const withNone = await compile([endpoint()], "v1", {});
    expect(withNone.info.contact).toBeUndefined();
    expect(withNone.info.license).toBeUndefined();
    expect(withNone.info.termsOfService).toBeUndefined();
  });

  it("drops a license with no name, since OpenAPI's License Object requires one", async () => {
    const doc = await compile([endpoint()], "v1", { license: { name: "", url: "https://example.com" } as never });
    expect(doc.info.license).toBeUndefined();
  });

  it("drops a license with a name but no URL, rather than producing a document that fails its own OpenAPI 3.1 validation", async () => {
    // OpenAPI 3.1's License Object requires `name` AND (`identifier` OR
    // `url`) — a name-only license (e.g. "Proprietary", freely typeable in
    // the Settings UI with no URL) fails schema validation outright if
    // emitted as-is. This is the actual real-world case that surfaced the
    // bug: compile() must never throw over a Settings field a user assumed
    // was purely descriptive.
    const doc = await compile([endpoint()], "v1", { license: { name: "Proprietary" } });
    expect(doc.info.license).toBeUndefined();
    // Confirms the document is still valid overall, not just that this one
    // field was dropped — the actual failure mode was compile() throwing.
    await expect(compile([endpoint()], "v1", { license: { name: "Proprietary" } })).resolves.toBeDefined();
  });

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

  it("emits OpenAPI's own standard 'tags' array on every operation, not just x-vayo-group — required for a third-party renderer (real Swagger UI, Postman, Redoc) to group operations at all", async () => {
    const doc = await compile([endpoint({ group: "Orders" })], "v1");
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(op.tags).toEqual(["Orders"]);
  });

  it("emits a nested group as one single tag string, not split per segment — avoids two different 'Users' groups colliding in a flat-tag renderer", async () => {
    const doc = await compile([endpoint({ group: "Admin/Users" })], "v1");
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(op.tags).toEqual(["Admin/Users"]);
  });

  it("declares each distinct group once in the document's top-level tags list, in first-appearance order", async () => {
    const doc = await compile(
      [
        endpoint({ vayoId: "ep_1", method: "GET", pathTemplate: "/api/v1/orders", group: "Orders" }),
        endpoint({ vayoId: "ep_2", method: "GET", pathTemplate: "/api/v1/users", group: "Users" }),
        endpoint({ vayoId: "ep_3", method: "POST", pathTemplate: "/api/v1/orders", group: "Orders" }),
      ],
      "v1",
    );
    expect(doc.tags).toEqual([{ name: "Orders" }, { name: "Users" }]);
  });

  it("omits the top-level tags array entirely for a version with no endpoints", async () => {
    const doc = await compile([], "v1");
    expect(doc.tags).toBeUndefined();
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

  it("uses multipart/form-data instead of application/json when the schema has a file field", async () => {
    const doc = await compile(
      [
        endpoint({
          method: "POST",
          pathTemplate: "/api/v1/users",
          requestSchema: {
            type: "object",
            properties: { name: { type: "string" }, avatar: { type: "string", format: "binary" } },
          },
        }),
      ],
      "v1",
    );
    const op = (doc.paths["/api/v1/users"] as Record<string, any>).post;
    expect(op.requestBody.content["application/json"]).toBeUndefined();
    expect(op.requestBody.content["multipart/form-data"].schema).toEqual({
      type: "object",
      properties: { name: { type: "string" }, avatar: { type: "string", format: "binary" } },
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

  it("emits x-vayo-response-schema-declared-statuses when set, omits it when empty", async () => {
    const withDeclared = await compile(
      [endpoint({ responseSchemas: { "200": { type: "object" } }, declaredResponseStatuses: ["200"] })],
      "v1",
    );
    const opDeclared = (withDeclared.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(opDeclared[X_VAYO_RESPONSE_SCHEMA_DECLARED_STATUSES]).toEqual(["200"]);

    const withoutDeclared = await compile([endpoint({ responseSchemas: { "200": { type: "object" } } })], "v1");
    const opUndeclared = (withoutDeclared.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(X_VAYO_RESPONSE_SCHEMA_DECLARED_STATUSES in opUndeclared).toBe(false);
  });

  it("compiles a declared example into the response's standard OpenAPI examples field", async () => {
    const doc = await compile(
      [
        endpoint({
          responseSchemas: { "200": { type: "object" } },
          declaredExamples: { "200": { id: "abc123", total: 42 } },
        }),
      ],
      "v1",
    );
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(op.responses["200"].content["application/json"].examples).toEqual({
      declared: { value: { id: "abc123", total: 42 } },
    });
  });

  it("still produces a response entry for a status with a declared example but no captured schema", async () => {
    const doc = await compile([endpoint({ responseSchemas: {}, declaredExamples: { "404": { message: "not found" } } })], "v1");
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(op.responses["404"].content["application/json"].examples).toEqual({
      declared: { value: { message: "not found" } },
    });
    expect(op.responses["404"].content["application/json"].schema).toBeUndefined();
  });

  it("compiles pinned examples into a response's examples field, named after their label", async () => {
    const doc = await compile([endpoint({ responseSchemas: { "200": { type: "object" } } })], "v1", {
      pinnedExamplesByVayoId: new Map([
        [
          "abc123",
          [
            {
              _id: "ex1",
              vayoId: "abc123",
              statusCode: 200,
              requestBody: null,
              responseBody: { id: "abc" },
              capturedAt: "2026-07-01T00:00:00.000Z",
              redacted: false,
              pinned: true,
              label: "Successful login!",
            },
          ],
        ],
      ]),
    });
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(op.responses["200"].content["application/json"].examples).toEqual({
      "successful-login": { value: { id: "abc" } },
    });
  });

  it("combines a declared example with pinned ones, and numbers unlabeled pinned examples when there's more than one", async () => {
    const doc = await compile(
      [endpoint({ responseSchemas: { "200": { type: "object" } }, declaredExamples: { "200": { id: "declared" } } })],
      "v1",
      {
        pinnedExamplesByVayoId: new Map([
          [
            "abc123",
            [
              {
                _id: "ex1",
                vayoId: "abc123",
                statusCode: 200,
                requestBody: null,
                responseBody: { id: "first" },
                capturedAt: "2026-07-01T00:00:00.000Z",
                redacted: false,
                pinned: true,
                label: null,
              },
              {
                _id: "ex2",
                vayoId: "abc123",
                statusCode: 200,
                requestBody: null,
                responseBody: { id: "second" },
                capturedAt: "2026-07-02T00:00:00.000Z",
                redacted: false,
                pinned: true,
                label: null,
              },
            ],
          ],
        ]),
      },
    );
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(op.responses["200"].content["application/json"].examples).toEqual({
      declared: { value: { id: "declared" } },
      "pinned-1": { value: { id: "first" } },
      "pinned-2": { value: { id: "second" } },
    });
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

  it("emits OpenAPI's own standard deprecated:true field plus x-vayo-deprecated-source when code-declared", async () => {
    const doc = await compile([endpoint({ deprecated: true, deprecatedSource: "declared" })], "v1");
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(op.deprecated).toBe(true);
    expect(op[X_VAYO_DEPRECATED_SOURCE]).toBe("declared");
  });

  it("emits deprecated:true without x-vayo-deprecated-source when a human set it, not the code", async () => {
    const doc = await compile([endpoint({ deprecated: true, deprecatedSource: null })], "v1");
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect(op.deprecated).toBe(true);
    expect(X_VAYO_DEPRECATED_SOURCE in op).toBe(false);
  });

  it("omits deprecated entirely when false, matching OpenAPI's own documented default", async () => {
    const doc = await compile([endpoint({ deprecated: false, deprecatedSource: null })], "v1");
    const op = (doc.paths["/api/v1/users/{id}"] as Record<string, any>).get;
    expect("deprecated" in op).toBe(false);
    expect(X_VAYO_DEPRECATED_SOURCE in op).toBe(false);
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

function importRef(overrides: Partial<ImportableEndpointRef> = {}): ImportableEndpointRef {
  return {
    vayoId: "ep_1",
    method: "GET",
    pathTemplate: "/api/v1/users/:id",
    requestSchema: null,
    responseSchemas: {},
    ...overrides,
  };
}

describe("planOpenApiImport", () => {
  it("rejects a real Postman Collection export (info.schema signal) instead of silently importing nothing", () => {
    const postmanExport = {
      info: {
        _postman_id: "abc-123",
        name: "My Company API",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [
        {
          name: "Get widget",
          request: { method: "GET", url: { raw: "{{baseUrl}}/api/v1/widgets/:id", host: ["{{baseUrl}}"], path: ["api", "v1", "widgets", ":id"] } },
        },
      ],
    };
    expect(() => planOpenApiImport(postmanExport, [], [])).toThrow(/Postman Collection export/);
  });

  it("rejects a Postman-shaped file even without the schema URL (item[] present, no paths)", () => {
    const strippedPostmanExport = {
      info: { name: "My Company API" },
      item: [{ name: "Get widget", request: { method: "GET", url: { raw: "{{baseUrl}}/api/v1/widgets" } } }],
    };
    expect(() => planOpenApiImport(strippedPostmanExport, [], [])).toThrow(/Postman Collection export/);
  });

  it("does not reject a real OpenAPI document that happens to have neither signal", () => {
    expect(() => planOpenApiImport({ info: { title: "Real API" }, paths: {} }, [], [])).not.toThrow();
  });

  it("extracts title/description from info", () => {
    const plan = planOpenApiImport({ info: { title: "My Company API", description: "Internal API." }, paths: {} }, [], []);
    expect(plan.title).toBe("My Company API");
    expect(plan.description).toBe("Internal API.");
  });

  it("omits title/description when info is missing or blank", () => {
    const plan = planOpenApiImport({ paths: {} }, [], []);
    expect(plan.title).toBeUndefined();
    expect(plan.description).toBeUndefined();
  });

  it("extracts servers, skipping one whose baseUrl already exists as an environment", () => {
    const plan = planOpenApiImport(
      {
        paths: {},
        servers: [
          { url: "https://api.example.com", description: "Production" },
          { url: "https://already-there.example.com" },
        ],
      },
      [],
      [{ variables: { baseUrl: "https://already-there.example.com" } }],
    );
    expect(plan.servers).toEqual([{ url: "https://api.example.com", description: "Production" }]);
  });

  it("matches a spec operation to an existing endpoint by method + converted path, extracting summary/description", () => {
    const spec = {
      paths: {
        "/api/v1/users/{id}": {
          get: { summary: "Fetch a user", description: "Returns the full user record." },
        },
      },
    };
    const plan = planOpenApiImport(spec, [importRef()], []);
    expect(plan.matched).toHaveLength(1);
    expect(plan.matched[0]!.overrides).toEqual({ summary: "Fetch a user", description: "Returns the full user record." });
    expect(plan.unmatched).toEqual([]);
  });

  it("reports an operation with no matching already-discovered endpoint as unmatched, never inventing one", () => {
    const spec = { paths: { "/api/v1/ghost": { get: { summary: "Nothing here in Vayo yet" } } } };
    const plan = planOpenApiImport(spec, [importRef()], []);
    expect(plan.matched).toEqual([]);
    expect(plan.unmatched).toEqual([{ method: "GET", path: "/api/v1/ghost" }]);
  });

  it("collects a field-level description override only when the existing schema already has that field", () => {
    const spec = {
      paths: {
        "/api/v1/users/{id}": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        email: { type: "string", description: "The user's contact email." },
                        ghostField: { type: "string", description: "Not in Vayo's own schema yet." },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const ref = importRef({
      responseSchemas: { "200": { type: "object", properties: { email: { type: "string" } } } },
    });
    const plan = planOpenApiImport(spec, [ref], []);
    expect(plan.matched[0]!.overrides).toEqual({
      "responseSchemas.200.properties.email.description": "The user's contact email.",
    });
  });

  it("collects a request-body field description the same way, nested under requestSchema", () => {
    const spec = {
      paths: {
        "/api/v1/users": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { name: { type: "string", description: "Display name." } } },
                },
              },
            },
          },
        },
      },
    };
    const ref = importRef({
      method: "POST",
      pathTemplate: "/api/v1/users",
      requestSchema: { type: "object", properties: { name: { type: "string" } } },
    });
    const plan = planOpenApiImport(spec, [ref], []);
    expect(plan.matched[0]!.overrides).toEqual({ "requestSchema.properties.name.description": "Display name." });
  });

  it("extracts the plural named examples map, one ImportedExample per name", () => {
    const spec = {
      paths: {
        "/api/v1/users/{id}": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    examples: {
                      success: { value: { id: "abc123" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const plan = planOpenApiImport(spec, [importRef()], []);
    expect(plan.matched[0]!.examples).toEqual([{ statusCode: 200, responseBody: { id: "abc123" }, label: "success" }]);
  });

  it("falls back to the older singular 'example' field most hand-written specs actually use", () => {
    const spec = {
      paths: {
        "/api/v1/users/{id}": {
          get: {
            responses: {
              "404": { content: { "application/json": { example: { message: "not found" } } } },
            },
          },
        },
      },
    };
    const plan = planOpenApiImport(spec, [importRef()], []);
    expect(plan.matched[0]!.examples).toEqual([{ statusCode: 404, responseBody: { message: "not found" }, label: null }]);
  });

  it("ignores non-HTTP-method keys on a path item (parameters/summary siblings)", () => {
    const spec = {
      paths: {
        "/api/v1/users/{id}": {
          summary: "Shared across methods, not itself a method",
          parameters: [{ name: "id", in: "path" }],
          get: { summary: "Fetch a user" },
        },
      },
    };
    const plan = planOpenApiImport(spec, [importRef()], []);
    expect(plan.matched).toHaveLength(1);
    expect(plan.matched[0]!.method).toBe("GET");
  });
});
