// @vayo/server — pure computation for GET /api/coverage, split out so the
// review-queue logic is unit-testable directly against hand-built
// ResolvedEndpoint fixtures. That matters here specifically because two of
// its inputs (a "static"-sourced endpoint, a schema_change-worthy history)
// aren't reachable through any @vayo/server HTTP route at all — only
// @vayo/ast's scan output and real captured traffic produce them, neither of
// which this package can fabricate through its own API surface.

import type { ResolvedEndpoint } from "@vayo/types";

export interface CoverageRef {
  vayoId: string;
  method: string;
  pathTemplate: string;
}

export interface CoverageReport {
  totalEndpoints: number;
  missingSummary: CoverageRef[];
  onlySuccessStatus: CoverageRef[];
  /** source === "static": found by the AST scanner but never merged with a
   * single real captured request — the shapes shown are inferred from code,
   * not observed traffic. The highest-value flag here: it separates
   * "documented" from "verified." */
  neverConfirmedByTraffic: CoverageRef[];
  /** notes === null — no per-endpoint frontend-workflow guidance written
   * yet, distinct from missingSummary (just the title). */
  missingNotes: CoverageRef[];
  /** Rounded 0-100: endpoints with no gap across every check above, divided
   * by totalEndpoints — a single trackable number instead of just lists. */
  fullyDocumentedPercent: number;
}

export function computeCoverageReport(resolved: ResolvedEndpoint[]): CoverageReport {
  const ref = (e: ResolvedEndpoint): CoverageRef => ({ vayoId: e.vayoId, method: e.method, pathTemplate: e.pathTemplate });

  const missingSummary = resolved.filter((e) => !e.summary).map(ref);
  const onlySuccessStatus = resolved
    .filter((e) => {
      const statuses = Object.keys(e.responseSchemas);
      return statuses.length > 0 && statuses.every((s) => s.startsWith("2"));
    })
    .map(ref);
  const neverConfirmedByTraffic = resolved.filter((e) => e.source === "static").map(ref);
  const missingNotes = resolved.filter((e) => !e.notes).map(ref);

  const gapVayoIds = new Set(
    [...missingSummary, ...onlySuccessStatus, ...neverConfirmedByTraffic, ...missingNotes].map((r) => r.vayoId),
  );
  const fullyDocumentedPercent =
    resolved.length === 0 ? 100 : Math.round(((resolved.length - gapVayoIds.size) / resolved.length) * 100);

  return {
    totalEndpoints: resolved.length,
    missingSummary,
    onlySuccessStatus,
    neverConfirmedByTraffic,
    missingNotes,
    fullyDocumentedPercent,
  };
}
