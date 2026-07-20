// @vayo/ui — structured filters for the endpoint search (Cmd/Ctrl+K
// command palette), on top of the free-text match that already existed.
// Pulled out as pure functions for the same reason as mentions.ts/
// chat-filters.ts.

import type { EndpointSummary } from "./types.js";

export type AuthFilter = "any" | "required" | "not-required";

export interface EndpointFilters {
  /** Empty means "every method" — not an impossible-to-match filter. */
  methods: string[];
  group: string | null;
  auth: AuthFilter;
}

export const EMPTY_ENDPOINT_FILTERS: EndpointFilters = { methods: [], group: null, auth: "any" };

export function hasActiveEndpointFilters(filters: EndpointFilters): boolean {
  return filters.methods.length > 0 || filters.group !== null || filters.auth !== "any";
}

export function matchesEndpointFilters(endpoint: EndpointSummary, filters: EndpointFilters): boolean {
  if (filters.methods.length > 0 && !filters.methods.includes(endpoint.method)) return false;
  if (filters.group !== null && endpoint.group !== filters.group) return false;
  const authRequired = Boolean(endpoint.operation["x-vayo-auth-required"]);
  if (filters.auth === "required" && !authRequired) return false;
  if (filters.auth === "not-required" && authRequired) return false;
  return true;
}

/** Every method actually present in the current endpoint list, in a fixed
 * conventional order — not just whatever order they happen to appear in,
 * and not cluttered with methods nobody's API even uses. */
const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export function availableMethods(endpoints: EndpointSummary[]): string[] {
  const present = new Set(endpoints.map((e) => e.method));
  const known = METHOD_ORDER.filter((m) => present.has(m));
  const other = [...present].filter((m) => !METHOD_ORDER.includes(m)).sort();
  return [...known, ...other];
}

export function availableGroups(endpoints: EndpointSummary[]): string[] {
  return [...new Set(endpoints.map((e) => e.group))].sort((a, b) => a.localeCompare(b));
}
