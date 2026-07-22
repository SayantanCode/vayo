// @vayo/openapi-compiler
// Framework-agnostic. Produces valid OpenAPI 3.1 + x-vayo-* extensions.
// See docs/02-architecture.md and docs/07-api-versioning.md.

import type { AuthType, JSONSchema, ResolvedEndpoint } from "@vayo/types";
import SwaggerParser from "@apidevtools/swagger-parser";

/** x-vayo-* extension keys — the ONLY place Vayo-specific data may live in
 * the exported spec (beyond DB-referenced IDs). Keep this list authoritative;
 * never invent a new top-level OpenAPI key instead of an x- extension. */
export const X_VAYO_ID = "x-vayo-id";
export const X_VAYO_GROUP = "x-vayo-group";
export const X_VAYO_SCOPES = "x-vayo-scopes";
export const X_VAYO_MIDDLEWARE_CHAIN = "x-vayo-middleware-chain";
// authRequired/authType are a documentation aid, never a security control
// (docs/05-security.md §3) — carried as x-vayo-* even when a formal OpenAPI
// `security` requirement can also be emitted (only possible once authType
// is confidently known; see securitySchemeFor below).
export const X_VAYO_AUTH_REQUIRED = "x-vayo-auth-required";
export const X_VAYO_AUTH_TYPE = "x-vayo-auth-type";
// Sidebar folder placement (docs/03-data-model.md "Manual endpoints &
// folders") is UI-organizational metadata, not API documentation — but it's
// set via the same override mechanism as every other field, so it arrives
// here the same ad-hoc way `group`/`scopes` do. Curated as an extension
// (not silently omitted) so the UI can read it straight off /api/spec
// without a second round-trip, same reasoning as every field above.
export const X_VAYO_FOLDER_ID = "x-vayo-folder-id";
export const X_VAYO_ORDER = "x-vayo-order";
// Free-form Markdown (with Mermaid diagram support, rendered client-side)
// explaining how this endpoint fits into a larger frontend workflow — e.g.
// cascading-dropdown dependencies between endpoints. A first-class
// EndpointDoc field (unlike folderId/order above), set via the same
// override mechanism as summary/group.
export const X_VAYO_NOTES = "x-vayo-notes";
// "manual" | "static" | "runtime" | "merged" (EndpointDoc.source verbatim) —
// the UI's own signal for whether an endpoint is a human-created
// placeholder (deletable) or backed by real capture data (not: deleting it
// would just have it reappear on the next scan/request, silently undoing
// the delete — docs/05-security.md's endpoint-deletion rule).
export const X_VAYO_SOURCE = "x-vayo-source";
// "declared" | "inferred" | "observed" (EndpointDoc.requestSchemaSource
// verbatim) — lets the UI show an "inferred, not confirmed by real
// traffic" badge on a requestBody that came from a best-effort Mongoose
// model guess, without treating it as confidently as a Zod-enforced or
// traffic-observed one (docs/03-data-model.md). Present only alongside a
// real requestBody, same null-exactly-when-requestSchema-is rule the
// underlying field itself follows.
export const X_VAYO_REQUEST_SCHEMA_SOURCE = "x-vayo-request-schema-source";
// ISO timestamp (EndpointDoc.possiblyRemovedSince verbatim), present only
// when set — the moment a `vayo scan` run completed without re-finding this
// endpoint (docs/04-capture-engine.md §3d). Lets the UI show "this route may
// no longer exist in your backend" and offer deletion for a non-manual
// endpoint, which is otherwise blocked (docs/05-security.md's
// endpoint-deletion rule).
export const X_VAYO_POSSIBLY_REMOVED_SINCE = "x-vayo-possibly-removed-since";
// "declared" | "inferred" (EndpointDoc.groupSource verbatim), always
// present (unlike the fields above, `group` itself is never absent either)
// — "declared" means an explicit `@group` tag in code produced `group`
// (docs/04-capture-engine.md Step 2 #4), and the UI treats that as
// authoritative: such an endpoint can be reordered within its current
// sidebar folder via drag-and-drop, but not relocated to a different one.
export const X_VAYO_GROUP_SOURCE = "x-vayo-group-source";

export interface OpenAPIDocument {
  openapi: "3.1.0";
  info: { title: string; version: string };
  paths: Record<string, unknown>;
  components?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const STATUS_DESCRIPTIONS: Record<string, string> = {
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "204": "No Content",
  "400": "Bad Request",
  "401": "Unauthorized",
  "403": "Forbidden",
  "404": "Not Found",
  "409": "Conflict",
  "422": "Unprocessable Entity",
  "500": "Internal Server Error",
};

/** OpenAPI path templates use `{param}`, not Express's `:param`. */
function toOpenApiPath(pathTemplate: string): string {
  return pathTemplate.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** Path param *names* are always known from the route registration itself
 * (`:id` in an Express path template) — unlike request/response bodies,
 * documenting them never needed Zod or a single request to be captured.
 * `paramsSchema` only exists once runtime capture or static Zod extraction
 * has run (docs/04-capture-engine.md's "runtime inference is the fallback
 * that always exists" — but that fallback still requires *some* traffic).
 * Deriving names straight from `pathTemplate` means every endpoint
 * documents its path params from the very first static scan, with zero
 * config and no dependency on the project's validation library of choice;
 * a richer type already inferred by capture/Zod still wins per name when
 * present, falling back to a generic string otherwise. */
function buildParameters(
  pathTemplate: string,
  paramsSchema: JSONSchema | null,
  querySchema: JSONSchema | null,
): Array<Record<string, unknown>> {
  const inferredProperties = (paramsSchema?.properties as Record<string, JSONSchema> | undefined) ?? {};
  const pathParamNames = [...pathTemplate.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);
  const pathParams = pathParamNames.map((name) => ({
    name,
    in: "path",
    required: true, // an Express route param is always present when the route matches
    schema: inferredProperties[name] ?? { type: "string" },
  }));

  const queryProperties = (querySchema?.properties as Record<string, JSONSchema> | undefined) ?? {};
  // Unlike path params, a query param's presence varies sample to sample —
  // `required` here reflects genson-js's own merged `required` array (a
  // param present on every captured sample), the same signal requestSchema
  // already uses to decide which body fields are required.
  const queryRequired = new Set((querySchema?.required as string[] | undefined) ?? []);
  const queryParams = Object.entries(queryProperties).map(([name, schema]) => ({
    name,
    in: "query",
    required: queryRequired.has(name),
    schema,
  }));

  return [...pathParams, ...queryParams];
}

/** Every response OpenAPI 3.1 requires a `description`; a captured status
 * code with no known text falls back to a generic one rather than omitting
 * the field (which would itself fail validation). */
function buildResponses(responseSchemas: Record<string, JSONSchema>): Record<string, unknown> {
  const entries = Object.entries(responseSchemas);
  if (entries.length === 0) {
    // OpenAPI requires at least one response; nothing was ever captured.
    return { "200": { description: "OK" } };
  }
  const responses: Record<string, unknown> = {};
  for (const [status, schema] of entries) {
    responses[status] = {
      description: STATUS_DESCRIPTIONS[status] ?? "Response",
      content: { "application/json": { schema } },
    };
  }
  return responses;
}

/** Omits a requestBody entirely when the inferred schema has no properties
 * (e.g. a GET route, where `req.body` was always `{}`) — an empty
 * `{type:"object"}` requestBody is technically valid but documents nothing
 * and is misleading on a body-less method. */
function buildRequestBody(requestSchema: JSONSchema | null): Record<string, unknown> | null {
  const properties = requestSchema?.properties as Record<string, unknown> | undefined;
  if (!properties || Object.keys(properties).length === 0) return null;
  return { content: { "application/json": { schema: requestSchema } } };
}

/** Maps a confidently-known authType to a standard OpenAPI security scheme.
 * Returns null for unknown authType — inventing a scheme when we don't
 * actually know the mechanism would be worse than omitting it
 * (docs/05-security.md: false positives here are a documentation nicety
 * either way, but a wrong scheme name is actively misleading). */
function securitySchemeFor(authType: AuthType): { name: string; scheme: Record<string, unknown> } | null {
  switch (authType) {
    case "bearer":
      return { name: "bearerAuth", scheme: { type: "http", scheme: "bearer" } };
    case "basic":
      return { name: "basicAuth", scheme: { type: "http", scheme: "basic" } };
    case "apiKey":
      return { name: "apiKeyAuth", scheme: { type: "apiKey", in: "header", name: "X-API-Key" } };
    case "cookie":
      // OpenAPI has no dedicated "cookie auth" scheme type — `apiKey` +
      // `in: "cookie"` is the spec's own documented way to express it. The
      // actual cookie name isn't captured anywhere (only its *presence* is,
      // docs/05-security.md §2 — never a credential's real name or value),
      // so this is a generic placeholder a team can rename via their own
      // reading of the spec; still far more useful than omitting security
      // entirely for an endpoint known to require cookie-based auth.
      return { name: "cookieAuth", scheme: { type: "apiKey", in: "cookie", name: "session" } };
    default:
      return null;
  }
}

function buildOperation(
  endpoint: ResolvedEndpoint,
  securitySchemes: Record<string, unknown>,
): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    operationId: `${endpoint.method.toLowerCase()}_${endpoint.vayoId}`,
    responses: buildResponses(endpoint.responseSchemas),
    [X_VAYO_ID]: endpoint.vayoId,
    [X_VAYO_GROUP]: endpoint.group,
    [X_VAYO_GROUP_SOURCE]: endpoint.groupSource,
    [X_VAYO_SCOPES]: endpoint.scopes,
    [X_VAYO_MIDDLEWARE_CHAIN]: endpoint.middlewareChain,
    [X_VAYO_AUTH_REQUIRED]: endpoint.authRequired,
    [X_VAYO_AUTH_TYPE]: endpoint.authType,
    [X_VAYO_SOURCE]: endpoint.source,
  };

  if (endpoint.summary) operation.summary = endpoint.summary;
  if (endpoint.notes) operation[X_VAYO_NOTES] = endpoint.notes;
  if (endpoint.possiblyRemovedSince) operation[X_VAYO_POSSIBLY_REMOVED_SINCE] = endpoint.possiblyRemovedSince;

  // folderId/order arrive as ad-hoc properties set by the
  // "${vayoId}.folderId"/"${vayoId}.order" overrides — not part of
  // EndpointDoc's static shape, same as any override-injected field.
  const placement = endpoint as unknown as { folderId?: string | null; order?: number };
  if (placement.folderId !== undefined) operation[X_VAYO_FOLDER_ID] = placement.folderId;
  if (placement.order !== undefined) operation[X_VAYO_ORDER] = placement.order;

  const parameters = buildParameters(endpoint.pathTemplate, endpoint.paramsSchema, endpoint.querySchema);
  if (parameters.length > 0) operation.parameters = parameters;

  const requestBody = buildRequestBody(endpoint.requestSchema);
  if (requestBody) {
    operation.requestBody = requestBody;
    if (endpoint.requestSchemaSource) operation[X_VAYO_REQUEST_SCHEMA_SOURCE] = endpoint.requestSchemaSource;
  }

  if (endpoint.authRequired && endpoint.authType) {
    const schemeInfo = securitySchemeFor(endpoint.authType);
    if (schemeInfo) {
      securitySchemes[schemeInfo.name] = schemeInfo.scheme;
      operation.security = [{ [schemeInfo.name]: endpoint.scopes }];
    }
  }

  return operation;
}

function buildDocument(endpoints: ResolvedEndpoint[], version: string): OpenAPIDocument {
  const inVersion = endpoints.filter((endpoint) => endpoint.version === version);
  const paths: Record<string, Record<string, unknown>> = {};
  const securitySchemes: Record<string, unknown> = {};

  for (const endpoint of inVersion) {
    const path = toOpenApiPath(endpoint.pathTemplate);
    paths[path] ??= {};
    paths[path][endpoint.method.toLowerCase()] = buildOperation(endpoint, securitySchemes);
  }

  const doc: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: "Vayo API", version },
    paths,
  };
  if (Object.keys(securitySchemes).length > 0) {
    doc.components = { securitySchemes };
  }
  return doc;
}

/** Wraps `@apidevtools/swagger-parser`'s `.validate()` against the OpenAPI
 * 3.1 meta-schema. Validates a deep clone — swagger-parser dereferences
 * `$ref`s in place as a side effect, and callers of `validate()` shouldn't
 * see their document mutated just from checking it. */
export async function validate(doc: OpenAPIDocument): Promise<ValidationResult> {
  try {
    await SwaggerParser.validate(structuredClone(doc) as never);
    return { valid: true, errors: [] };
  } catch (err) {
    return { valid: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

/**
 * Compiles resolved endpoints for one version into an OpenAPI 3.1 document.
 * Never returns a document that fails `validate()` — throws instead
 * (docs/08-packages-and-repo-structure.md: "never emits an unvalidated
 * document").
 *
 * Async (unlike the synchronous signature sketched in
 * docs/08-packages-and-repo-structure.md) because `validate()` — which
 * this calls internally before ever returning — is inherently async in
 * `@apidevtools/swagger-parser`.
 */
export async function compile(endpoints: ResolvedEndpoint[], version: string): Promise<OpenAPIDocument> {
  const doc = buildDocument(endpoints, version);
  const result = await validate(doc);
  if (!result.valid) {
    throw new Error(
      `@vayo/openapi-compiler: compiled document failed OpenAPI 3.1 validation:\n${result.errors.join("\n")}`,
    );
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Version diffing (docs/07-api-versioning.md) — a small, purpose-built
// structural diff over two of Vayo's own compiled OpenAPI documents, not a
// binding to `oasdiff` (Go-only, no npm/WASM distribution — see that doc for
// the full reasoning). Scoped to exactly its "what counts as changed" rules:
// added/removed operations, added/removed *required* fields, type changes,
// added/removed enum values. Deliberately does NOT flag cosmetic diffs
// (property order, description-only overrides, a newly-added *optional*
// field) — the badge's job is "will this break an integration," not "did
// anything at all change."
// ---------------------------------------------------------------------------

export interface OperationRef {
  method: string;
  path: string;
}

export interface ChangedOperation {
  operation: OperationRef;
  changes: string[];
}

export interface SpecDiff {
  added: OperationRef[];
  removed: OperationRef[];
  changed: ChangedOperation[];
}

interface FlattenedOperation {
  path: string;
  method: string;
  operation: Record<string, unknown>;
}

function stripPrefix(path: string, prefix: string | undefined): string {
  if (!prefix || !path.startsWith(prefix)) return path;
  const rest = path.slice(prefix.length);
  return rest.length > 0 ? rest : "/";
}

function flattenOperations(doc: OpenAPIDocument, stripPrefixValue: string | undefined): Map<string, FlattenedOperation> {
  const map = new Map<string, FlattenedOperation>();
  for (const [path, methods] of Object.entries(doc.paths as Record<string, Record<string, unknown>>)) {
    for (const [method, operation] of Object.entries(methods)) {
      const logicalPath = stripPrefix(path, stripPrefixValue);
      map.set(`${method.toUpperCase()} ${logicalPath}`, {
        path,
        method: method.toUpperCase(),
        operation: operation as Record<string, unknown>,
      });
    }
  }
  return map;
}

/** Recursively compares two JSON Schemas, collecting only the differences
 * `docs/07-api-versioning.md` says should count: added/removed required
 * fields, type changes, and added/removed enum values on properties present
 * in *both* schemas. Adding a brand-new optional property is deliberately
 * not flagged (backward compatible by definition). */
function diffSchema(label: string, before: JSONSchema | undefined, after: JSONSchema | undefined): string[] {
  if (!before || !after) return [];
  const changes: string[] = [];

  const beforeRequired = new Set((before.required as string[] | undefined) ?? []);
  const afterRequired = new Set((after.required as string[] | undefined) ?? []);
  for (const field of afterRequired) {
    if (!beforeRequired.has(field)) changes.push(`${label}: added required field '${field}'`);
  }
  for (const field of beforeRequired) {
    if (!afterRequired.has(field)) changes.push(`${label}: removed required field '${field}'`);
  }

  const beforeType = Array.isArray(before.type) ? before.type.join("|") : before.type;
  const afterType = Array.isArray(after.type) ? after.type.join("|") : after.type;
  if (beforeType && afterType && beforeType !== afterType) {
    changes.push(`${label}: type changed from ${String(beforeType)} to ${String(afterType)}`);
  }

  if (before.enum || after.enum) {
    const beforeEnum = new Set(((before.enum as unknown[] | undefined) ?? []).map((v) => JSON.stringify(v)));
    const afterEnum = new Set(((after.enum as unknown[] | undefined) ?? []).map((v) => JSON.stringify(v)));
    for (const v of afterEnum) if (!beforeEnum.has(v)) changes.push(`${label}: added enum value ${v}`);
    for (const v of beforeEnum) if (!afterEnum.has(v)) changes.push(`${label}: removed enum value ${v}`);
  }

  const beforeProps = (before.properties as Record<string, JSONSchema> | undefined) ?? {};
  const afterProps = (after.properties as Record<string, JSONSchema> | undefined) ?? {};
  for (const key of Object.keys(beforeProps)) {
    if (key in afterProps) {
      changes.push(...diffSchema(`${label}.${key}`, beforeProps[key], afterProps[key]));
    }
  }

  if (before.items && after.items) {
    changes.push(...diffSchema(`${label}[]`, before.items as JSONSchema, after.items as JSONSchema));
  }

  return changes;
}

function jsonBodySchema(container: unknown): JSONSchema | undefined {
  return (container as { content?: { "application/json"?: { schema?: JSONSchema } } } | undefined)?.content?.[
    "application/json"
  ]?.schema;
}

function diffOperation(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const changes = diffSchema("request body", jsonBodySchema(before.requestBody), jsonBodySchema(after.requestBody));

  const beforeResponses = (before.responses as Record<string, unknown>) ?? {};
  const afterResponses = (after.responses as Record<string, unknown>) ?? {};
  for (const status of Object.keys(beforeResponses)) {
    if (status in afterResponses) {
      changes.push(...diffSchema(`response ${status}`, jsonBodySchema(beforeResponses[status]), jsonBodySchema(afterResponses[status])));
    }
  }
  return changes;
}

/**
 * Diffs two compiled OpenAPI documents — typically two versions of the same
 * API. `stripPrefixA`/`stripPrefixB` should be each version's own
 * `ApiVersionDoc.basePathPattern` (e.g. `/api/v1`, `/api/v2`) so
 * `/api/v1/widgets` and `/api/v2/widgets` are recognized as the *same*
 * logical operation across versions rather than two unrelated ones.
 */
export function diffSpecs(
  specA: OpenAPIDocument,
  specB: OpenAPIDocument,
  options?: { stripPrefixA?: string; stripPrefixB?: string },
): SpecDiff {
  const opsA = flattenOperations(specA, options?.stripPrefixA);
  const opsB = flattenOperations(specB, options?.stripPrefixB);

  const added: OperationRef[] = [];
  const removed: OperationRef[] = [];
  const changed: ChangedOperation[] = [];

  for (const [key, entryB] of opsB) {
    const entryA = opsA.get(key);
    if (!entryA) {
      added.push({ method: entryB.method, path: entryB.path });
      continue;
    }
    const changes = diffOperation(entryA.operation, entryB.operation);
    if (changes.length > 0) {
      changed.push({ operation: { method: entryB.method, path: entryB.path }, changes });
    }
  }
  for (const [key, entryA] of opsA) {
    if (!opsB.has(key)) removed.push({ method: entryA.method, path: entryA.path });
  }

  return { added, removed, changed };
}
