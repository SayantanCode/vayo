import { describe, expect, it } from "vitest";
import type { CapturedSample, EndpointDoc, OverrideDoc } from "@vayo/types";
import {
  detectSchemaChange,
  mergeCapturedSample,
  mergeStaticResult,
  resolveAuthRequired,
  resolveAuthType,
  resolveEndpoint,
  resolveVersion,
  stableHash,
  type StaticRouteMergeInput,
} from "./index.js";

function sample(overrides: Partial<CapturedSample> = {}): CapturedSample {
  return {
    method: "GET",
    pathTemplate: "/api/v1/users/:id",
    version: "v1",
    requestHeaders: {},
    requestParams: { id: "64f1a2" },
    requestQuery: {},
    requestBody: null,
    responseStatus: 200,
    responseBody: { id: "64f1a2", name: "Jane Doe", email: "jane@corp.com" },
    middlewareNames: ["rateLimiter", "authenticate"],
    capturedAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("stableHash", () => {
  it("is deterministic and case-normalizes method", () => {
    const a = stableHash("get", "/api/v1/users/:id", "v1");
    const b = stableHash("GET", "/api/v1/users/:id", "v1");
    expect(a).toBe(b);
  });

  it("differs across method/path/version", () => {
    const base = stableHash("GET", "/api/v1/users/:id", "v1");
    expect(stableHash("POST", "/api/v1/users/:id", "v1")).not.toBe(base);
    expect(stableHash("GET", "/api/v1/orders/:id", "v1")).not.toBe(base);
    expect(stableHash("GET", "/api/v1/users/:id", "v2")).not.toBe(base);
  });
});

describe("mergeCapturedSample", () => {
  it("creates a new EndpointDoc from a first sample", () => {
    const doc = mergeCapturedSample(null, sample());

    expect(doc.vayoId).toBe(stableHash("GET", "/api/v1/users/:id", "v1"));
    expect(doc.method).toBe("GET");
    expect(doc.group).toBe("Users");
    expect(doc.source).toBe("runtime");
    expect(doc.sampleCount).toBe(1);
    expect(doc.middlewareChain).toEqual(["rateLimiter", "authenticate"]);
    expect(doc.createdAt).toBe("2026-07-01T10:00:00.000Z");
    expect(doc.responseSchemas["200"]).toMatchObject({
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
      },
    });
  });

  it("increments sampleCount and widens the schema on a second, differently-shaped sample", () => {
    const first = mergeCapturedSample(null, sample());
    const second = mergeCapturedSample(
      first,
      sample({
        capturedAt: "2026-07-02T09:00:00.000Z",
        responseBody: { id: "58ab90", name: "Sam Lee", email: "sam@corp.com", preferences: { theme: "dark" } },
      }),
    );

    expect(second.sampleCount).toBe(2);
    expect(second.createdAt).toBe("2026-07-01T10:00:00.000Z"); // unchanged
    expect(second.lastSeenAt).toBe("2026-07-02T09:00:00.000Z");
    expect(second.updatedAt).toBe("2026-07-02T09:00:00.000Z");

    const props = (second.responseSchemas["200"] as any).properties;
    expect(props.preferences).toBeDefined();
  });

  it("collapses many samples of the same route into one endpoint (path already normalized upstream)", () => {
    let doc: EndpointDoc | null = null;
    doc = mergeCapturedSample(doc, sample({ requestParams: { id: "64f1a2" } }));
    doc = mergeCapturedSample(doc, sample({ requestParams: { id: "58ab90" } }));
    expect(doc.sampleCount).toBe(2);
  });

  it("infers querySchema from requestQuery, mirroring paramsSchema", () => {
    const doc = mergeCapturedSample(null, sample({ requestQuery: { page: "2", limit: "20" } }));
    expect(doc.querySchema).toMatchObject({
      type: "object",
      properties: {
        page: { type: "string" },
        limit: { type: "string" },
      },
    });
  });

  it("leaves querySchema null when no request ever carried a query string", () => {
    const doc = mergeCapturedSample(null, sample({ requestQuery: {} }));
    expect(doc.querySchema).toBeNull();
  });

  it("widens querySchema across samples the same way paramsSchema widens", () => {
    const first = mergeCapturedSample(null, sample({ requestQuery: { page: "1" } }));
    const second = mergeCapturedSample(
      first,
      sample({ requestQuery: { page: "2", sort: "desc" }, capturedAt: "2026-07-02T00:00:00.000Z" }),
    );
    const props = (second.querySchema as any).properties;
    expect(props.page).toBeDefined();
    expect(props.sort).toBeDefined();
  });

  it("does not pollute the schema when the body is null (e.g. a 204)", () => {
    const first = mergeCapturedSample(null, sample());
    const second = mergeCapturedSample(
      first,
      sample({ responseStatus: 204, responseBody: null, capturedAt: "2026-07-02T00:00:00.000Z" }),
    );
    expect(second.responseSchemas["204"]).toBeUndefined();
    expect(second.responseSchemas["200"]).toBeDefined();
  });

  it("marks requestBodyFileFields as format:binary rather than an indistinguishable plain string", () => {
    const doc = mergeCapturedSample(
      null,
      sample({
        requestBody: { caption: "vacation photo", avatar: "[binary file]" },
        requestBodyFileFields: ["avatar"],
      }),
    );
    const props = (doc.requestSchema as any).properties;
    expect(props.caption).toEqual({ type: "string" });
    expect(props.avatar).toMatchObject({ type: "string", format: "binary" });
  });

  it("leaves requestSchema untouched when requestBodyFileFields is absent (ordinary JSON bodies)", () => {
    const doc = mergeCapturedSample(null, sample({ requestBody: { name: "Jane" } }));
    const props = (doc.requestSchema as any).properties;
    expect(props.name).toEqual({ type: "string" });
  });

  it("keeps middlewareChain a de-duplicated union in first-seen order", () => {
    const first = mergeCapturedSample(null, sample({ middlewareNames: ["rateLimiter", "authenticate"] }));
    const second = mergeCapturedSample(
      first,
      sample({ middlewareNames: ["authenticate", "validateBody"], capturedAt: "2026-07-02T00:00:00.000Z" }),
    );
    expect(second.middlewareChain).toEqual(["rateLimiter", "authenticate", "validateBody"]);
  });

  describe("authRequired OR-merge (docs/04-capture-engine.md Step 3)", () => {
    it("flips to true when a request with no auth header gets a 401", () => {
      const doc = mergeCapturedSample(
        null,
        sample({ responseStatus: 401, responseBody: { error: "unauthorized" }, requestHeaders: {} }),
      );
      expect(doc.authRequired).toBe(true);
    });

    it("stays false for a 401 that isn't evidence of auth (auth header was present)", () => {
      const doc = mergeCapturedSample(
        null,
        sample({ responseStatus: 401, requestHeaders: { authorization: true } }),
      );
      expect(doc.authRequired).toBe(false);
    });

    it("never flips back to false once observed true (OR semantics, no false negatives)", () => {
      const first = mergeCapturedSample(null, sample({ responseStatus: 401, requestHeaders: {} }));
      expect(first.authRequired).toBe(true);
      const second = mergeCapturedSample(
        first,
        sample({ responseStatus: 200, capturedAt: "2026-07-02T00:00:00.000Z" }),
      );
      expect(second.authRequired).toBe(true);
    });
  });

  describe("authType inference (docs/04-capture-engine.md Step 3c)", () => {
    it("sets authType to 'cookie' end-to-end from a successful cookie-only request", () => {
      const doc = mergeCapturedSample(
        null,
        sample({ responseStatus: 200, requestHeaders: { authorization: false, cookie: true } }),
      );
      expect(doc.authType).toBe("cookie");
    });

    it("leaves authType null when only a 401 has ever been observed", () => {
      const doc = mergeCapturedSample(
        null,
        sample({ responseStatus: 401, requestHeaders: { authorization: false, cookie: true } }),
      );
      expect(doc.authType).toBeNull();
    });
  });
});

function staticRoute(overrides: Partial<StaticRouteMergeInput> = {}): StaticRouteMergeInput {
  return {
    method: "GET",
    pathTemplate: "/api/v1/users/:id",
    middlewareChain: ["requireAuth"],
    authRequiredGuess: true,
    scopes: ["customer:read"],
    group: "Users",
    summary: null,
    ...overrides,
  };
}

describe("requestSchemaSource — confidence tier tracking", () => {
  it("is null when no requestSchema has ever been found", () => {
    const doc = mergeCapturedSample(null, sample({ requestBody: null }));
    expect(doc.requestSchema).toBeNull();
    expect(doc.requestSchemaSource).toBeNull();
  });

  it("is 'observed' once real traffic contributes a request body", () => {
    const doc = mergeCapturedSample(null, sample({ requestBody: { name: "Jane" } }));
    expect(doc.requestSchemaSource).toBe("observed");
  });

  it("takes 'declared' or 'inferred' straight from a static scan result", () => {
    const declared = mergeStaticResult(
      null,
      staticRoute({ requestSchema: { type: "object" }, requestSchemaSource: "declared" }),
      "v1",
    );
    expect(declared.requestSchemaSource).toBe("declared");

    const inferred = mergeStaticResult(
      null,
      staticRoute({ requestSchema: { type: "object" }, requestSchemaSource: "inferred" }),
      "v1",
    );
    expect(inferred.requestSchemaSource).toBe("inferred");
  });

  it("defaults to 'declared' when a static result carries a requestSchema but no explicit source (older-shape callers)", () => {
    const doc = mergeStaticResult(null, staticRoute({ requestSchema: { type: "object" } }), "v1");
    expect(doc.requestSchemaSource).toBe("declared");
  });

  it("graduates an 'inferred' schema to 'observed' once real traffic actually confirms it", () => {
    const staticFirst = mergeStaticResult(
      null,
      staticRoute({ requestSchema: { type: "object", properties: { name: { type: "string" } } }, requestSchemaSource: "inferred" }),
      "v1",
    );
    expect(staticFirst.requestSchemaSource).toBe("inferred");

    const afterTraffic = mergeCapturedSample(staticFirst, sample({ requestBody: { name: "Jane" } }));
    expect(afterTraffic.requestSchemaSource).toBe("observed");
  });

  it("does not downgrade an already-'observed' source when a later sample carries no body", () => {
    const observed = mergeCapturedSample(null, sample({ requestBody: { name: "Jane" } }));
    const noBodySample = mergeCapturedSample(observed, sample({ requestBody: null, capturedAt: "2026-07-02T00:00:00.000Z" }));
    expect(noBodySample.requestSchemaSource).toBe("observed");
  });

  it("never invents a source when requestSchema itself stays null (a rescan that finds nothing new)", () => {
    const first = mergeStaticResult(null, staticRoute({ requestSchema: null }), "v1");
    expect(first.requestSchema).toBeNull();
    expect(first.requestSchemaSource).toBeNull();
  });

  it("clears a 'possibly removed' flag the moment real traffic hits the endpoint again", () => {
    const flagged = mergeCapturedSample(null, sample());
    const withFlag: EndpointDoc = { ...flagged, possiblyRemovedSince: "2026-07-10T00:00:00.000Z" };
    const afterTraffic = mergeCapturedSample(withFlag, sample({ capturedAt: "2026-07-11T00:00:00.000Z" }));
    expect(afterTraffic.possiblyRemovedSince).toBeNull();
  });

  it("has no deprecation signal of its own — a fresh runtime-only doc defaults to not deprecated", () => {
    const doc = mergeCapturedSample(null, sample());
    expect(doc.deprecated).toBe(false);
    expect(doc.deprecatedSource).toBeNull();
  });

  it("preserves an existing 'declared' deprecation across further runtime samples", () => {
    const declared = mergeStaticResult(null, staticRoute({ deprecated: true }), "v1");
    const afterTraffic = mergeCapturedSample(declared, sample({ capturedAt: "2026-07-11T00:00:00.000Z" }));
    expect(afterTraffic.deprecated).toBe(true);
    expect(afterTraffic.deprecatedSource).toBe("declared");
  });
});

describe("mergeStaticResult", () => {
  it("creates a static-sourced EndpointDoc when nothing existed yet", () => {
    const doc = mergeStaticResult(null, staticRoute(), "v1");
    expect(doc.vayoId).toBe(stableHash("GET", "/api/v1/users/:id", "v1"));
    expect(doc.source).toBe("static");
    expect(doc.scopes).toEqual(["customer:read"]);
    expect(doc.middlewareChain).toEqual(["requireAuth"]);
    expect(doc.authRequired).toBe(true);
    expect(doc.group).toBe("Users");
    expect(doc.sampleCount).toBe(0); // static pass never touches sample-derived fields
  });

  it("marks source 'merged' when a runtime doc already exists, and vice versa", () => {
    const runtimeDoc = mergeCapturedSample(
      null,
      sample({ pathTemplate: "/api/v1/users/:id", requestParams: { id: "1" } }),
    );
    const merged = mergeStaticResult(runtimeDoc, staticRoute(), "v1");
    expect(merged.source).toBe("merged");

    const staticFirst = mergeStaticResult(null, staticRoute(), "v1");
    const thenRuntime = mergeCapturedSample(staticFirst, sample({ pathTemplate: "/api/v1/users/:id" }));
    expect(thenRuntime.source).toBe("merged");
  });

  it("never overwrites requestSchema/responseSchemas/paramsSchema/querySchema — those stay runtime-only", () => {
    const runtimeDoc = mergeCapturedSample(null, sample({ requestQuery: { page: "1" } }));
    const merged = mergeStaticResult(runtimeDoc, staticRoute(), "v1");
    expect(merged.responseSchemas).toEqual(runtimeDoc.responseSchemas);
    expect(merged.paramsSchema).toEqual(runtimeDoc.paramsSchema);
    expect(merged.querySchema).toEqual(runtimeDoc.querySchema);
    expect(merged.sampleCount).toBe(runtimeDoc.sampleCount);
    expect(merged.lastSeenAt).toBe(runtimeDoc.lastSeenAt);
  });

  it("OR-merges authRequired with whatever runtime already observed (never flips true back to false)", () => {
    const runtimeSaysProtected = mergeCapturedSample(
      null,
      sample({ responseStatus: 401, requestHeaders: {} }),
    );
    expect(runtimeSaysProtected.authRequired).toBe(true);
    const merged = mergeStaticResult(runtimeSaysProtected, staticRoute({ authRequiredGuess: false }), "v1");
    expect(merged.authRequired).toBe(true);
  });

  it("does not erase previously-found scopes when a rescan finds none", () => {
    const first = mergeStaticResult(null, staticRoute({ scopes: ["admin:read"] }), "v1");
    const second = mergeStaticResult(first, staticRoute({ scopes: [] }), "v1");
    expect(second.scopes).toEqual(["admin:read"]);
  });

  it("never demotes 'merged' back to 'static' or 'runtime' on a later single-source merge", () => {
    // Regression: source must be monotonic. runtime -> static gets you to
    // "merged"; a *second* static-only rescan (or a later runtime sample)
    // must not regress it back down to "static" (or "runtime").
    const runtimeDoc = mergeCapturedSample(null, sample());
    const merged = mergeStaticResult(runtimeDoc, staticRoute(), "v1");
    expect(merged.source).toBe("merged");

    const rescanned = mergeStaticResult(merged, staticRoute(), "v1");
    expect(rescanned.source).toBe("merged");

    const capturedAgain = mergeCapturedSample(rescanned, sample({ capturedAt: "2026-07-06T00:00:00.000Z" }));
    expect(capturedAgain.source).toBe("merged");
  });

  it("unions middlewareChain across repeated scans without duplicating", () => {
    const first = mergeStaticResult(null, staticRoute({ middlewareChain: ["rateLimiter"] }), "v1");
    const second = mergeStaticResult(first, staticRoute({ middlewareChain: ["rateLimiter", "requireAuth"] }), "v1");
    expect(second.middlewareChain).toEqual(["rateLimiter", "requireAuth"]);
  });

  it("clears a 'possibly removed' flag the moment a later scan re-finds the route", () => {
    const first = mergeStaticResult(null, staticRoute(), "v1");
    const flagged: EndpointDoc = { ...first, possiblyRemovedSince: "2026-07-10T00:00:00.000Z" };
    const rescanned = mergeStaticResult(flagged, staticRoute(), "v1");
    expect(rescanned.possiblyRemovedSince).toBeNull();
  });

  it("sets deprecated=true and deprecatedSource='declared' when the scan found an @deprecated tag", () => {
    const doc = mergeStaticResult(null, staticRoute({ deprecated: true }), "v1");
    expect(doc.deprecated).toBe(true);
    expect(doc.deprecatedSource).toBe("declared");
  });

  it("defaults deprecated=false and deprecatedSource=null when there's no @deprecated tag", () => {
    const doc = mergeStaticResult(null, staticRoute(), "v1");
    expect(doc.deprecated).toBe(false);
    expect(doc.deprecatedSource).toBeNull();
  });

  it("clears deprecatedSource back to null (and deprecated back to false) once a later scan's route no longer carries the @deprecated tag", () => {
    const declared = mergeStaticResult(null, staticRoute({ deprecated: true }), "v1");
    expect(declared.deprecatedSource).toBe("declared");

    const rescanned = mergeStaticResult(declared, staticRoute({ deprecated: false }), "v1");
    expect(rescanned.deprecated).toBe(false);
    expect(rescanned.deprecatedSource).toBeNull();
  });

  it("promotes a 'manual' placeholder to 'merged' once real runtime traffic arrives", () => {
    const manualDoc: EndpointDoc = {
      _id: "1",
      vayoId: stableHash("GET", "/api/v1/users/:id", "v1"),
      method: "GET",
      pathTemplate: "/api/v1/users/:id",
      version: "v1",
      group: "Users",
      groupSource: "inferred",
      summary: "Planned: fetch a single user",
      deprecated: false,
      deprecatedSource: null,
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
      source: "manual",
      sampleCount: 0,
      lastSeenAt: "2026-07-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      possiblyRemovedSince: null,
    };

    const afterCapture = mergeCapturedSample(manualDoc, sample());
    expect(afterCapture.source).toBe("merged");
    expect(afterCapture.summary).toBe("Planned: fetch a single user"); // untouched by capture

    const afterScan = mergeStaticResult(manualDoc, staticRoute(), "v1");
    expect(afterScan.source).toBe("merged");
  });
});

describe("resolveVersion", () => {
  it("falls back to the zero-config regex heuristic when no versions are configured", () => {
    expect(resolveVersion("/api/v2/users/:id", [])).toBe("v2");
    expect(resolveVersion("/api/users/:id", [])).toBe("v1");
  });

  it("matches a configured basePathPattern, {n} standing in for the version number", () => {
    const configured = [
      { version: "v1", basePathPattern: "/api/v1" },
      { version: "v2", basePathPattern: "/api/v2" },
    ];
    expect(resolveVersion("/api/v1/widgets", configured)).toBe("v1");
    expect(resolveVersion("/api/v2/widgets", configured)).toBe("v2");
  });

  it("supports a single templated pattern with {n}", () => {
    const configured = [{ version: "v1", basePathPattern: "/api/v{n}" }];
    expect(resolveVersion("/api/v1/widgets", configured)).toBe("v1");
  });

  it("buckets an unmatched path as 'unversioned' once versions are explicitly configured", () => {
    const configured = [{ version: "v1", basePathPattern: "/api/v1" }];
    expect(resolveVersion("/legacy/ping", configured)).toBe("unversioned");
  });

  it("does not false-positive match a longer segment sharing the same prefix", () => {
    const configured = [{ version: "v1", basePathPattern: "/api/v1" }];
    expect(resolveVersion("/api/v10/widgets", configured)).toBe("unversioned");
  });
});

describe("resolveAuthRequired", () => {
  it("is a plain OR", () => {
    expect(resolveAuthRequired(false, false)).toBe(false);
    expect(resolveAuthRequired(true, false)).toBe(true);
    expect(resolveAuthRequired(false, true)).toBe(true);
    expect(resolveAuthRequired(true, true)).toBe(true);
  });
});

describe("resolveAuthType", () => {
  it("infers 'cookie' from a successful request that carried a cookie but no Authorization header", () => {
    const result = resolveAuthType(null, {
      responseStatus: 200,
      requestHeaders: { authorization: false, cookie: true },
    });
    expect(result).toBe("cookie");
  });

  it("does not infer anything from a 401 — a failure proves nothing about which mechanism would have worked", () => {
    const result = resolveAuthType(null, {
      responseStatus: 401,
      requestHeaders: { authorization: false, cookie: true },
    });
    expect(result).toBeNull();
  });

  it("does not infer 'cookie' when an Authorization header was also present (ambiguous — could be bearer)", () => {
    const result = resolveAuthType(null, {
      responseStatus: 200,
      requestHeaders: { authorization: true, cookie: true },
    });
    expect(result).toBeNull();
  });

  it("never overwrites an already-known authType, whether inferred earlier or manually overridden", () => {
    expect(
      resolveAuthType("bearer", { responseStatus: 200, requestHeaders: { authorization: false, cookie: true } }),
    ).toBe("bearer");
    expect(
      resolveAuthType("cookie", { responseStatus: 200, requestHeaders: { authorization: true, cookie: false } }),
    ).toBe("cookie");
  });
});

describe("detectSchemaChange", () => {
  it("returns null when nothing changed", () => {
    const doc = mergeCapturedSample(null, sample());
    expect(detectSchemaChange(doc, doc)).toBeNull();
  });

  it("returns a before/after diff when the schema widens", () => {
    const first = mergeCapturedSample(null, sample());
    const second = mergeCapturedSample(
      first,
      sample({
        capturedAt: "2026-07-02T00:00:00.000Z",
        responseBody: { id: "1", name: "x", email: "y", preferences: { theme: "dark" } },
      }),
    );
    const diff = detectSchemaChange(first, second);
    expect(diff).not.toBeNull();
    expect(diff!.after).not.toEqual(diff!.before);
  });

  it("returns null->after shape for a brand new endpoint (before is null)", () => {
    const doc = mergeCapturedSample(null, sample());
    const diff = detectSchemaChange(null, doc);
    expect(diff).not.toBeNull();
    expect(diff!.before).toBeNull();
  });
});

describe("resolveEndpoint", () => {
  function endpointFixture(): EndpointDoc {
    return mergeCapturedSample(null, sample());
  }

  it("returns the endpoint unchanged (plus an empty overridden list) with no overrides", () => {
    const endpoint = endpointFixture();
    const resolved = resolveEndpoint(endpoint, []);
    expect(resolved.overridden).toEqual([]);
    expect(resolved.summary).toBe(endpoint.summary);
  });

  it("applies a matching override and records it in `overridden`", () => {
    const endpoint = endpointFixture();
    const override: OverrideDoc = {
      _id: "ov_1",
      targetId: `${endpoint.vayoId}.summary`,
      value: "Fetch a single user by id.",
      updatedBy: "member_1",
      updatedAt: "2026-07-03T00:00:00.000Z",
      reason: null,
    };
    const resolved = resolveEndpoint(endpoint, [override]);
    expect(resolved.summary).toBe("Fetch a single user by id.");
    expect(resolved.overridden).toEqual(["summary"]);
  });

  it("ignores overrides targeting a different vayoId", () => {
    const endpoint = endpointFixture();
    const override: OverrideDoc = {
      _id: "ov_1",
      targetId: "some_other_id.summary",
      value: "should not apply",
      updatedBy: "member_1",
      updatedAt: "2026-07-03T00:00:00.000Z",
      reason: null,
    };
    const resolved = resolveEndpoint(endpoint, [override]);
    expect(resolved.summary).toBeNull();
    expect(resolved.overridden).toEqual([]);
  });

  it("never mutates the input EndpointDoc", () => {
    const endpoint = endpointFixture();
    const before = JSON.stringify(endpoint);
    resolveEndpoint(endpoint, [
      {
        _id: "ov_1",
        targetId: `${endpoint.vayoId}.summary`,
        value: "mutated?",
        updatedBy: "member_1",
        updatedAt: "2026-07-03T00:00:00.000Z",
        reason: null,
      },
    ]);
    expect(JSON.stringify(endpoint)).toBe(before);
  });

  it("last updatedAt wins when two overrides target the same field path", () => {
    const endpoint = endpointFixture();
    const older: OverrideDoc = {
      _id: "ov_1",
      targetId: `${endpoint.vayoId}.summary`,
      value: "older",
      updatedBy: "member_1",
      updatedAt: "2026-07-03T00:00:00.000Z",
      reason: null,
    };
    const newer: OverrideDoc = {
      _id: "ov_2",
      targetId: `${endpoint.vayoId}.summary`,
      value: "newer",
      updatedBy: "member_2",
      updatedAt: "2026-07-04T00:00:00.000Z",
      reason: null,
    };
    // order in the input array shouldn't matter
    expect(resolveEndpoint(endpoint, [newer, older]).summary).toBe("newer");
    expect(resolveEndpoint(endpoint, [older, newer]).summary).toBe("newer");
  });

  it("supports nested field paths (e.g. inside a JSON Schema tree)", () => {
    const endpoint = endpointFixture();
    const override: OverrideDoc = {
      _id: "ov_1",
      targetId: `${endpoint.vayoId}.responseSchemas.200.description`,
      value: "The user record.",
      updatedBy: "member_1",
      updatedAt: "2026-07-03T00:00:00.000Z",
      reason: null,
    };
    const resolved = resolveEndpoint(endpoint, [override]);
    expect((resolved.responseSchemas["200"] as any).description).toBe("The user record.");
    expect(resolved.overridden).toEqual(["responseSchemas.200.description"]);
  });

  it("re-scanning (another mergeCapturedSample pass) never destroys a previously applied override", () => {
    // This is the specific case docs/09-roadmap.md M2 calls out as the
    // hardest to get right: overrides live outside EndpointDoc, so a re-scan
    // that changes the schema must not erase an override applied earlier.
    const endpoint = endpointFixture();
    const override: OverrideDoc = {
      _id: "ov_1",
      targetId: `${endpoint.vayoId}.summary`,
      value: "Manually written summary.",
      updatedBy: "member_1",
      updatedAt: "2026-07-03T00:00:00.000Z",
      reason: "AST summary was wrong",
    };

    const rescanned = mergeCapturedSample(
      endpoint,
      sample({
        capturedAt: "2026-07-05T00:00:00.000Z",
        responseBody: { id: "1", name: "x", email: "y", newField: true },
      }),
    );

    // the raw EndpointDoc's own `summary` field is untouched by the rescan...
    expect(rescanned.summary).toBeNull();
    // ...and the override still applies cleanly on top of the rescanned doc.
    const resolved = resolveEndpoint(rescanned, [override]);
    expect(resolved.summary).toBe("Manually written summary.");
    expect((resolved.responseSchemas["200"] as any).properties.newField).toBeDefined();
  });
});
