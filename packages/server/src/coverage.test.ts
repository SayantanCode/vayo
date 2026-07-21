import { describe, expect, it } from "vitest";
import type { ResolvedEndpoint } from "@vayo/types";
import { computeCoverageReport } from "./coverage.js";

let nextId = 1;
function endpoint(overrides: Partial<ResolvedEndpoint> = {}): ResolvedEndpoint {
  const n = nextId++;
  return {
    _id: `id_${n}`,
    vayoId: `ep_${n}`,
    method: "GET",
    pathTemplate: `/api/v1/thing-${n}`,
    version: "v1",
    group: "Things",
    summary: "A summary",
    notes: "Some frontend-workflow notes",
    authRequired: false,
    authType: null,
    scopes: [],
    middlewareChain: [],
    requestSchema: null,
    requestSchemaSource: null,
    // Includes a non-2xx status by default so a "fully documented" fixture
    // endpoint doesn't accidentally trip the onlySuccessStatus check itself
    // — that check has its own dedicated test with a deliberately
    // success-only override instead.
    responseSchemas: { "200": { type: "object" }, "404": { type: "object" } },
    paramsSchema: null,
    querySchema: null,
    source: "merged",
    sampleCount: 5,
    lastSeenAt: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    possiblyRemovedSince: null,
    overridden: [],
    ...overrides,
  };
}

describe("computeCoverageReport", () => {
  it("reports 100% and empty lists for an already fully-documented endpoint set", () => {
    const report = computeCoverageReport([endpoint(), endpoint()]);
    expect(report.totalEndpoints).toBe(2);
    expect(report.missingSummary).toHaveLength(0);
    expect(report.onlySuccessStatus).toHaveLength(0);
    expect(report.neverConfirmedByTraffic).toHaveLength(0);
    expect(report.missingNotes).toHaveLength(0);
    expect(report.fullyDocumentedPercent).toBe(100);
  });

  it("defaults to 100% for zero endpoints, not NaN", () => {
    const report = computeCoverageReport([]);
    expect(report.totalEndpoints).toBe(0);
    expect(report.fullyDocumentedPercent).toBe(100);
  });

  it("flags endpoints with no summary", () => {
    const report = computeCoverageReport([endpoint({ summary: null })]);
    expect(report.missingSummary).toHaveLength(1);
    expect(report.fullyDocumentedPercent).toBe(0);
  });

  it("flags endpoints that have only ever seen 2xx responses", () => {
    const report = computeCoverageReport([endpoint({ responseSchemas: { "200": {}, "201": {} } })]);
    expect(report.onlySuccessStatus).toHaveLength(1);
  });

  it("does not flag an endpoint with no responses observed yet as 'only success'", () => {
    const report = computeCoverageReport([endpoint({ responseSchemas: {} })]);
    expect(report.onlySuccessStatus).toHaveLength(0);
  });

  it("flags source === 'static' as never confirmed by real traffic", () => {
    const report = computeCoverageReport([endpoint({ source: "static" })]);
    expect(report.neverConfirmedByTraffic).toHaveLength(1);
  });

  it("does not flag 'manual' endpoints as never-confirmed — they're deliberately hand-authored, not AST stubs", () => {
    const report = computeCoverageReport([endpoint({ source: "manual" })]);
    expect(report.neverConfirmedByTraffic).toHaveLength(0);
  });

  it("flags endpoints with no notes written", () => {
    const report = computeCoverageReport([endpoint({ notes: null })]);
    expect(report.missingNotes).toHaveLength(1);
  });

  it("counts an endpoint with multiple simultaneous gaps only once toward fullyDocumentedPercent", () => {
    const report = computeCoverageReport([
      endpoint({ summary: null, notes: null }), // two gaps, same endpoint
      endpoint(), // fully documented
    ]);
    expect(report.fullyDocumentedPercent).toBe(50);
  });

  it("rounds fullyDocumentedPercent to the nearest whole number", () => {
    const report = computeCoverageReport([endpoint(), endpoint(), endpoint({ summary: null })]);
    expect(report.fullyDocumentedPercent).toBe(67); // 2/3 rounded
  });
});
