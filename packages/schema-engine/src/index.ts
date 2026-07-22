// @vayo/schema-engine
// Framework-agnostic. Never import express, never talk to MongoDB directly.
// See docs/04-capture-engine.md and docs/03-data-model.md "Resolving a read".

import type {
  AuthType,
  CapturedSample,
  EndpointDoc,
  JSONSchema,
  OverrideDoc,
  ResolvedEndpoint,
} from "@vayo/types";
import { mergeSchemas, createSchema, type Schema } from "genson-js";

import { createHash } from "node:crypto";

/** Cap on stored examples per (vayoId, statusCode) — docs/03-data-model.md
 * `vayo_examples`: "5 most recent" isn't expressible as a DB TTL, so
 * `@vayo/db-mongo` enforces this value (defined here, once) by deleting the
 * oldest rows past the cap whenever it appends a new example. */
export const MAX_EXAMPLES_PER_STATUS = 5;

/** Stable, deterministic ID for one (method, pathTemplate, version) triple.
 * Never changes across re-scans — this is the join key for overrides,
 * examples, comments, and audit log entries. See docs/03-data-model.md. */
export function stableHash(method: string, pathTemplate: string, version: string): string {
  return createHash("sha256")
    .update(`${method.toUpperCase()}:${pathTemplate}:${version}`)
    .digest("hex")
    .slice(0, 16);
}

/** Merge one more observed value into an (possibly absent) inferred schema.
 * `null`/`undefined` samples (e.g. a 204 with no body) leave the schema
 * untouched rather than polluting it with a spurious "null" branch. */
function mergeSchemaValue(existing: Schema | null, value: unknown): Schema | null {
  if (value === null || value === undefined) return existing;
  const next = createSchema(value) as Schema;
  if (!existing) return next;
  return mergeSchemas([existing, next]) as Schema;
}

/** Marks the given top-level properties of a (possibly absent) object schema
 * `format: "binary"` — `capture-express`'s `requestBodyFileFields` names
 * which keys came from `req.file`/`req.files` (multer) rather than the JSON
 * body itself, so an uploaded file renders as a proper OpenAPI file field
 * instead of an indistinguishable plain string. No-op when there are no file
 * fields, or the schema isn't a plain object schema (nothing to mark). */
function markFileFields(schema: Schema | null, fileFields: string[] | undefined): Schema | null {
  if (!schema || !fileFields || fileFields.length === 0) return schema;
  const properties = (schema as { properties?: Record<string, JSONSchema> }).properties;
  if (!properties) return schema;
  for (const field of fileFields) {
    const property = properties[field];
    if (property && typeof property === "object") {
      (property as Record<string, unknown>).format = "binary";
    }
  }
  return schema;
}

/** Union of two middleware-name lists, preserving first-seen order —
 * docs/04-capture-engine.md Step 1: "fold sample.middlewareNames into
 * middlewareChain (union, preserve order)". */
function unionPreserveOrder(existing: string[], incoming: string[]): string[] {
  const out = [...existing];
  const seen = new Set(existing);
  for (const name of incoming) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Best-effort `group` fallback when nothing else (AST pass, override) has
 * supplied one yet — runtime capture has no folder-convention signal, so
 * this just takes the first non-parameter, non-version path segment and
 * capitalizes it (e.g. "/api/v1/orders/:id" -> "Orders"). The AST static
 * pass's folder-convention result and any override both take precedence
 * over this once they exist (docs/04-capture-engine.md Step 3). */
function inferGroupFromPath(pathTemplate: string): string {
  const segment = pathTemplate
    .split("/")
    .find((s) => s.length > 0 && !s.startsWith(":") && !/^v\d+$/i.test(s) && s !== "api");
  if (!segment) return "General";
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

/**
 * OR-merge for authRequired specifically (docs/04-capture-engine.md Step 3):
 * true if EITHER static middleware-detection OR runtime 401-observation says
 * protected. Tilt toward false negatives being worse than false positives.
 */
export function resolveAuthRequired(staticGuess: boolean, runtimeObserved401WithoutAuth: boolean): boolean {
  return staticGuess || runtimeObserved401WithoutAuth;
}

/**
 * Infers `authType: "cookie"` from runtime evidence (docs/04-capture-engine.md
 * Step 3c) — the first (and so far only) automatic `authType` detection;
 * bearer/apiKey/basic have none, `authType` is otherwise override-only. A
 * *successful* (2xx) response to a request that carried a session cookie
 * but no Authorization header is reasonable evidence the endpoint's auth
 * mechanism is cookie-based — a 401 proves nothing about *which* mechanism
 * would have worked, only that whichever one is required wasn't satisfied,
 * so only 2xx samples count as positive evidence here. Never overwrites an
 * already-known `authType`, whether previously inferred or manually
 * overridden — the same "never flip-flop something already established"
 * posture `resolveAuthRequired` holds itself to for the boolean field.
 */
export function resolveAuthType(
  existing: AuthType,
  sample: Pick<CapturedSample, "responseStatus" | "requestHeaders">,
): AuthType {
  if (existing) return existing;
  const successfulCookieOnly =
    sample.responseStatus >= 200 &&
    sample.responseStatus < 300 &&
    sample.requestHeaders.cookie === true &&
    sample.requestHeaders.authorization !== true;
  return successfulCookieOnly ? "cookie" : null;
}

/** Converts a `vayo_api_versions.basePathPattern` (e.g. `/api/v{n}`) into a
 * prefix-matching regex — `{n}` becomes `\d+`, everything else is escaped
 * literally. Matches as a path *prefix* (basePathPattern is a mount point,
 * not a full route template). */
function basePathPatternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("{n}")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\d+");
  return new RegExp(`^${escaped}(?:/|$)`);
}

/**
 * Resolves which API version a captured request belongs to
 * (docs/07-api-versioning.md "Resolving version from a captured request").
 * Pure — no I/O; callers (capture-express, the AST static scanner) supply
 * the current `vayo_api_versions` list themselves.
 *
 * With zero versions configured, this is today's zero-config heuristic
 * (`/v(\d+)/` in the path -> `vN`, else `"v1"`) — unchanged, so an existing
 * install never regresses just because this feature now exists. Once at
 * least one version is explicitly configured, pattern-matching takes over
 * and an unmatched path falls into the explicit `"unversioned"` bucket
 * instead — "unversioned" means "you've opted into versioning, but this
 * route matches none of your patterns," not "you haven't set this up yet."
 */
export function resolveVersion(
  pathTemplate: string,
  configuredVersions: Array<{ version: string; basePathPattern: string }>,
): string {
  if (configuredVersions.length === 0) {
    const match = pathTemplate.match(/\/v(\d+)(?:\/|$)/i);
    return match ? `v${match[1]}` : "v1";
  }
  for (const { version, basePathPattern } of configuredVersions) {
    if (basePathPatternToRegex(basePathPattern).test(pathTemplate)) return version;
  }
  return "unversioned";
}

/**
 * Merge a newly captured sample into an existing (or absent) EndpointDoc.
 * Pure — no I/O, no DB access. See docs/04-capture-engine.md Step 1.
 */
export function mergeCapturedSample(
  existing: EndpointDoc | null,
  sample: CapturedSample,
): EndpointDoc {
  const vayoId = stableHash(sample.method, sample.pathTemplate, sample.version);
  const statusKey = String(sample.responseStatus);

  const requestSchema = markFileFields(
    mergeSchemaValue((existing?.requestSchema as Schema | null) ?? null, sample.requestBody),
    sample.requestBodyFileFields,
  );
  // Real traffic contributing to the schema at all graduates it to the
  // highest-confidence tier, regardless of whatever declared/inferred
  // starting shape it had (docs/03-data-model.md) — once requests have
  // actually been confirmed against it, "was this originally a guess" no
  // longer matters.
  const requestSchemaSource =
    sample.requestBody !== null && sample.requestBody !== undefined ? "observed" : (existing?.requestSchemaSource ?? null);
  const paramsSchema = mergeSchemaValue(
    (existing?.paramsSchema as Schema | null) ?? null,
    Object.keys(sample.requestParams).length > 0 ? sample.requestParams : null,
  );
  const querySchema = mergeSchemaValue(
    (existing?.querySchema as Schema | null) ?? null,
    Object.keys(sample.requestQuery).length > 0 ? sample.requestQuery : null,
  );
  const responseSchemas = { ...(existing?.responseSchemas ?? {}) };
  const mergedResponseSchema = mergeSchemaValue(
    (responseSchemas[statusKey] as Schema | undefined) ?? null,
    sample.responseBody,
  );
  if (mergedResponseSchema) responseSchemas[statusKey] = mergedResponseSchema;

  // Runtime 401-observation: a request that carried no Authorization header
  // and got a 401 back is evidence the endpoint requires auth. OR-merged
  // against whatever's already known (static guess or prior observation) —
  // never used to clear authRequired back to false.
  const runtimeObserved401WithoutAuth =
    sample.responseStatus === 401 && sample.requestHeaders.authorization !== true;
  const authRequired = resolveAuthRequired(existing?.authRequired ?? false, runtimeObserved401WithoutAuth);
  const authType = resolveAuthType(existing?.authType ?? null, sample);

  const middlewareChain = unionPreserveOrder(existing?.middlewareChain ?? [], sample.middlewareNames);

  return {
    _id: existing?._id ?? "",
    vayoId,
    method: sample.method.toUpperCase(),
    pathTemplate: sample.pathTemplate,
    version: sample.version,
    group: existing?.group ?? inferGroupFromPath(sample.pathTemplate),
    groupSource: existing?.groupSource ?? "inferred",
    summary: existing?.summary ?? null,
    // Runtime capture has no deprecation signal of its own — preserve
    // whatever the static scan (or a human override, layered on top later
    // by resolveEndpoint) already established.
    deprecated: existing?.deprecated ?? false,
    deprecatedSource: existing?.deprecatedSource ?? null,
    notes: existing?.notes ?? null,
    authRequired,
    authType,
    scopes: existing?.scopes ?? [],
    middlewareChain,
    requestSchema,
    requestSchemaSource,
    responseSchemas,
    paramsSchema,
    querySchema,
    // Monotonic: once a doc has ever been "merged" (both static and runtime
    // have contributed), a later runtime-only sample must not demote it
    // back to "runtime" — same bug class in reverse for mergeStaticResult.
    // "manual" (a UI-created placeholder, docs/03-data-model.md "Manual
    // endpoints") transitions the same way "static" does: real traffic
    // arriving on a manually-documented route becomes "merged", not
    // "runtime" — the human-provided info didn't disappear.
    source:
      existing?.source === "static" || existing?.source === "merged" || existing?.source === "manual"
        ? "merged"
        : "runtime",
    sampleCount: (existing?.sampleCount ?? 0) + 1,
    lastSeenAt: sample.capturedAt,
    createdAt: existing?.createdAt ?? sample.capturedAt,
    updatedAt: sample.capturedAt,
    // Real traffic hitting this route at all is positive evidence it's
    // still there — clears a previous "possibly removed" flag the same
    // way mergeStaticResult's own re-confirmation does (04-capture-engine.md §3d).
    possiblyRemovedSince: null,
  };
}

/** Structural shape of `@vayo/ast`'s `StaticRouteResult` — declared locally
 * rather than imported so schema-engine (a foundation package other
 * packages sit on top of) doesn't depend on `@vayo/ast` (a consumer). Any
 * object with this shape works, including the real `StaticRouteResult`. */
export interface StaticRouteMergeInput {
  method: string;
  pathTemplate: string;
  middlewareChain: string[];
  authRequiredGuess: boolean;
  scopes: string[];
  group: string;
  /** "declared" when `@vayo/ast` found an explicit `@group` tag,
   * "inferred" otherwise (docs/04-capture-engine.md Step 2 #4) — optional
   * so any caller still constructing the older shape keeps compiling;
   * defaults to "inferred" when omitted. */
  groupSource?: "declared" | "inferred";
  summary: string | null;
  /** True when `@vayo/ast` found an explicit bare `@deprecated` tag
   * (docs/04-capture-engine.md Step 2 #4a) — optional so any caller still
   * constructing the older shape keeps compiling; defaults to `false`
   * when omitted. */
  deprecated?: boolean;
  /** A Zod- or Mongoose-derived request body shape, when `@vayo/ast` could
   * trace one statically (docs/04-capture-engine.md Step 2 #3/#3b) —
   * optional so any caller still constructing the older shape (without
   * this field) keeps compiling; treated identically to `undefined` when
   * absent. */
  requestSchema?: JSONSchema | null;
  /** "declared" (Zod) or "inferred" (Mongoose) — which static convention
   * traced `requestSchema`, when present (docs/03-data-model.md). Defaults
   * to "declared" when omitted, matching every caller that predates this
   * field (all Zod-only). */
  requestSchemaSource?: "declared" | "inferred" | null;
}

/**
 * Merge one static-scan result (`@vayo/ast`'s `scanProject`) into an
 * existing (or absent) EndpointDoc. Pure — no I/O. Mirrors
 * `mergeCapturedSample`'s shape but for the other half of the merge
 * precedence in docs/04-capture-engine.md Step 3: static analysis *refines*
 * the runtime fallback (group, scopes, middlewareChain, authRequired) and,
 * when a Zod schema was traced, `requestSchema` too — a real schema a team
 * already wrote wins outright over whatever shape runtime traffic happened
 * to exercise, same "static wins when both exist" rule as every other
 * field here. `responseSchemas`/`paramsSchema`/`querySchema` still come
 * from runtime capture only — extracting a route's *response* shape or its
 * param types statically isn't attempted (no tractable single convention
 * the way request-body validation has). A rescan that finds nothing new
 * (empty scopes, no schema traced, e.g.) never erases what a previous scan
 * or runtime capture already found — non-destructive, same guarantee
 * `resolveEndpoint` gives for overrides.
 */
export function mergeStaticResult(
  existing: EndpointDoc | null,
  route: StaticRouteMergeInput,
  version: string,
): EndpointDoc {
  const vayoId = stableHash(route.method, route.pathTemplate, version);
  const now = new Date().toISOString();

  const authRequired = resolveAuthRequired(route.authRequiredGuess, existing?.authRequired ?? false);
  const middlewareChain = unionPreserveOrder(existing?.middlewareChain ?? [], route.middlewareChain);
  const scopes = route.scopes.length > 0 ? route.scopes : (existing?.scopes ?? []);

  return {
    _id: existing?._id ?? "",
    vayoId,
    method: route.method.toUpperCase(),
    pathTemplate: route.pathTemplate,
    version,
    group: route.group,
    // Mirrors group's own unconditional overwrite immediately above — the
    // two must never drift apart, or a rescan whose route no longer has an
    // explicit @group tag would leave a stale "declared" lock in place on a
    // group value that's actually just a fresh guess.
    groupSource: route.groupSource ?? "inferred",
    summary: route.summary ?? existing?.summary ?? null,
    // Unconditional, same reasoning as group/groupSource immediately
    // above: if the current scan's route no longer carries an explicit
    // @deprecated tag, that must clear deprecatedSource back to null too
    // (a stale "declared" lock would otherwise block a human from ever
    // un-deprecating it again in the UI, on a fact the code no longer
    // asserts). A human's own override for "deprecated" — set via the UI
    // independent of any code tag — lives in vayo_overrides and survives
    // this unconditional base-layer overwrite regardless, applied on top
    // by resolveEndpoint exactly like every other overridable field.
    deprecated: route.deprecated ?? false,
    deprecatedSource: route.deprecated ? "declared" : null,
    notes: existing?.notes ?? null,
    authRequired,
    authType: existing?.authType ?? null,
    scopes,
    middlewareChain,
    requestSchema: route.requestSchema ?? existing?.requestSchema ?? null,
    // Mirrors requestSchema's own "static wins outright when it found
    // something" precedence immediately above.
    requestSchemaSource: route.requestSchema
      ? (route.requestSchemaSource ?? "declared")
      : (existing?.requestSchemaSource ?? null),
    responseSchemas: existing?.responseSchemas ?? {},
    paramsSchema: existing?.paramsSchema ?? null,
    querySchema: existing?.querySchema ?? null,
    // Monotonic — see the matching comment in mergeCapturedSample: a
    // rescan that finds nothing new must not demote an already-"merged"
    // doc back down to "static". A "manual" placeholder that the AST scan
    // now has real data for becomes "merged" too, same reasoning.
    source:
      existing?.source === "runtime" || existing?.source === "merged" || existing?.source === "manual"
        ? "merged"
        : "static",
    sampleCount: existing?.sampleCount ?? 0,
    lastSeenAt: existing?.lastSeenAt ?? now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    // This scan just found the route, which is exactly the positive
    // evidence that clears a previous "possibly removed" flag
    // (04-capture-engine.md §3d) — mirrors mergeCapturedSample's own clear.
    possiblyRemovedSince: null,
  };
}

/**
 * Did merging this sample actually change the inferred schema? Used by
 * `@vayo/db-mongo` to decide whether to append a `schema_change` entry to
 * `vayo_audit_log` (docs/03-data-model.md) — kept here, not in db-mongo, so
 * the "what counts as a schema change" definition has one home. Pure: takes
 * the before/after docs, does no I/O itself.
 */
export function detectSchemaChange(
  before: EndpointDoc | null,
  after: EndpointDoc,
): { before: unknown; after: unknown } | null {
  const beforeShape = before
    ? {
        requestSchema: before.requestSchema,
        responseSchemas: before.responseSchemas,
        paramsSchema: before.paramsSchema,
        querySchema: before.querySchema,
      }
    : null;
  const afterShape = {
    requestSchema: after.requestSchema,
    responseSchemas: after.responseSchemas,
    paramsSchema: after.paramsSchema,
    querySchema: after.querySchema,
  };
  if (JSON.stringify(beforeShape) === JSON.stringify(afterShape)) return null;
  return { before: beforeShape, after: afterShape };
}

/** Sets `value` at a dotted path inside `obj`, creating intermediate objects
 * as needed. Purely structural — has no idea what an EndpointDoc or JSON
 * Schema "means", it just walks the path the override's targetId encodes
 * (docs/03-data-model.md `OverrideDoc.targetId`). */
function setDeep(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i] as string;
    const next = cursor[key];
    if (typeof next !== "object" || next === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = value;
}

/**
 * The pure merge function — docs/03-data-model.md "Resolving a read".
 * No I/O, no mutation of `endpoint`. This is what makes "re-scans never
 * destroy manual edits" true: overrides live in a separate collection and
 * are re-applied on every read, never written back into the EndpointDoc.
 *
 * Precedence when multiple overrides target the same field path: last
 * `updatedAt` wins (docs/03-data-model.md `vayo_overrides` indexes note —
 * in practice the unique index on `targetId` means this rarely happens, but
 * the merge stays defensive in case duplicates ever exist in `overrides`).
 */
export function resolveEndpoint(
  endpoint: EndpointDoc,
  overrides: OverrideDoc[],
): ResolvedEndpoint {
  const prefix = `${endpoint.vayoId}.`;
  const winningByFieldPath = new Map<string, OverrideDoc>();

  for (const override of overrides) {
    if (!override.targetId.startsWith(prefix)) continue;
    const fieldPath = override.targetId.slice(prefix.length);
    const current = winningByFieldPath.get(fieldPath);
    if (!current || Date.parse(override.updatedAt) >= Date.parse(current.updatedAt)) {
      winningByFieldPath.set(fieldPath, override);
    }
  }

  const result = structuredClone(endpoint) as unknown as Record<string, unknown>;
  const overridden = [...winningByFieldPath.keys()].sort();
  for (const fieldPath of overridden) {
    setDeep(result, fieldPath, winningByFieldPath.get(fieldPath)!.value);
  }

  return { ...(result as unknown as EndpointDoc), overridden };
}
