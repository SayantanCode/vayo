import { describe, expect, it } from "vitest";
import {
  availableGroups,
  availableMethods,
  EMPTY_ENDPOINT_FILTERS,
  hasActiveEndpointFilters,
  matchesEndpointFilters,
  type EndpointFilters,
} from "./endpoint-filters.js";
import type { EndpointSummary } from "./types.js";

function endpoint(overrides: Partial<EndpointSummary> = {}): EndpointSummary {
  return {
    vayoId: "ep_1",
    method: "GET",
    path: "/api/v1/widgets",
    group: "Widgets",
    summary: "List widgets",
    operation: { "x-vayo-auth-required": false } as EndpointSummary["operation"],
    ...overrides,
  };
}

describe("hasActiveEndpointFilters", () => {
  it("is false for the empty filter set", () => {
    expect(hasActiveEndpointFilters(EMPTY_ENDPOINT_FILTERS)).toBe(false);
  });

  it("is true once any single filter is set", () => {
    expect(hasActiveEndpointFilters({ ...EMPTY_ENDPOINT_FILTERS, methods: ["GET"] })).toBe(true);
    expect(hasActiveEndpointFilters({ ...EMPTY_ENDPOINT_FILTERS, group: "Orders" })).toBe(true);
    expect(hasActiveEndpointFilters({ ...EMPTY_ENDPOINT_FILTERS, auth: "required" })).toBe(true);
  });
});

describe("matchesEndpointFilters", () => {
  it("matches anything against the empty filter set", () => {
    expect(matchesEndpointFilters(endpoint(), EMPTY_ENDPOINT_FILTERS)).toBe(true);
  });

  it("filters by method", () => {
    const filters: EndpointFilters = { ...EMPTY_ENDPOINT_FILTERS, methods: ["POST"] };
    expect(matchesEndpointFilters(endpoint({ method: "GET" }), filters)).toBe(false);
    expect(matchesEndpointFilters(endpoint({ method: "POST" }), filters)).toBe(true);
  });

  it("matches any of several selected methods", () => {
    const filters: EndpointFilters = { ...EMPTY_ENDPOINT_FILTERS, methods: ["GET", "POST"] };
    expect(matchesEndpointFilters(endpoint({ method: "POST" }), filters)).toBe(true);
    expect(matchesEndpointFilters(endpoint({ method: "DELETE" }), filters)).toBe(false);
  });

  it("filters by group", () => {
    const filters: EndpointFilters = { ...EMPTY_ENDPOINT_FILTERS, group: "Orders" };
    expect(matchesEndpointFilters(endpoint({ group: "Widgets" }), filters)).toBe(false);
    expect(matchesEndpointFilters(endpoint({ group: "Orders" }), filters)).toBe(true);
  });

  it("filters by auth-required", () => {
    const requiredFilter: EndpointFilters = { ...EMPTY_ENDPOINT_FILTERS, auth: "required" };
    expect(matchesEndpointFilters(endpoint({ operation: { "x-vayo-auth-required": false } as EndpointSummary["operation"] }), requiredFilter)).toBe(
      false,
    );
    expect(matchesEndpointFilters(endpoint({ operation: { "x-vayo-auth-required": true } as EndpointSummary["operation"] }), requiredFilter)).toBe(
      true,
    );
  });

  it("filters by auth-not-required", () => {
    const notRequiredFilter: EndpointFilters = { ...EMPTY_ENDPOINT_FILTERS, auth: "not-required" };
    expect(
      matchesEndpointFilters(endpoint({ operation: { "x-vayo-auth-required": true } as EndpointSummary["operation"] }), notRequiredFilter),
    ).toBe(false);
    expect(
      matchesEndpointFilters(endpoint({ operation: { "x-vayo-auth-required": false } as EndpointSummary["operation"] }), notRequiredFilter),
    ).toBe(true);
  });

  it("requires every active filter to match at once", () => {
    const filters: EndpointFilters = { methods: ["POST"], group: "Orders", auth: "required" };
    const matching = endpoint({ method: "POST", group: "Orders", operation: { "x-vayo-auth-required": true } as EndpointSummary["operation"] });
    const wrongGroup = endpoint({ method: "POST", group: "Widgets", operation: { "x-vayo-auth-required": true } as EndpointSummary["operation"] });
    expect(matchesEndpointFilters(matching, filters)).toBe(true);
    expect(matchesEndpointFilters(wrongGroup, filters)).toBe(false);
  });
});

describe("availableMethods", () => {
  it("returns only methods actually present, in conventional order", () => {
    const endpoints = [endpoint({ method: "DELETE" }), endpoint({ method: "GET" }), endpoint({ method: "POST" })];
    expect(availableMethods(endpoints)).toEqual(["GET", "POST", "DELETE"]);
  });

  it("de-duplicates repeated methods", () => {
    const endpoints = [endpoint({ method: "GET" }), endpoint({ method: "GET" })];
    expect(availableMethods(endpoints)).toEqual(["GET"]);
  });
});

describe("availableGroups", () => {
  it("returns unique groups sorted alphabetically", () => {
    const endpoints = [endpoint({ group: "Widgets" }), endpoint({ group: "Auth" }), endpoint({ group: "Widgets" })];
    expect(availableGroups(endpoints)).toEqual(["Auth", "Widgets"]);
  });
});
