// @vayo/openapi-compiler
// Framework-agnostic. Produces valid OpenAPI 3.1 + x-vayo-* extensions.
// See docs/02-architecture.md and docs/07-api-versioning.md.

import type { AuthType, ExampleDoc, JSONSchema, ResolvedEndpoint } from "@vayo/types";
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
// "declared" (EndpointDoc.deprecatedSource verbatim), present only when set
// — an explicit `@deprecated` tag in code produced `deprecated: true`
// (docs/04-capture-engine.md Step 2 #4a). Unlike X_VAYO_GROUP_SOURCE, this
// one omits the "inferred" case entirely rather than emitting it: there's
// no guessed-deprecation signal to distinguish from a human's own override,
// so its mere presence (vs. absence) is the whole signal, same pattern as
// X_VAYO_POSSIBLY_REMOVED_SINCE. Lets the UI refuse to un-deprecate an
// endpoint the code itself marks deprecated, while a NOT-code-declared one
// (this key absent) stays freely toggleable.
export const X_VAYO_DEPRECATED_SOURCE = "x-vayo-deprecated-source";
// Status codes within `responses` whose schema came (at least in part)
// from an explicit `@response <status> <SchemaName>` tag in code
// (EndpointDoc.declaredResponseStatuses verbatim, docs/04-capture-engine.md
// Step 2 #4b) — the response-schema equivalent of X_VAYO_REQUEST_SCHEMA_SOURCE,
// kept as a list of statuses rather than one value since a response schema
// is itself a per-status map. Omitted entirely when empty, same pattern as
// X_VAYO_POSSIBLY_REMOVED_SINCE.
export const X_VAYO_RESPONSE_SCHEMA_DECLARED_STATUSES = "x-vayo-response-schema-declared-statuses";

export interface OpenAPIDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description?: string };
  /** OpenAPI's own standard field, populated from Vayo's own Environments
   * (docs/03-data-model.md `vayo_environments`) rather than a separate
   * concept — each environment with a `baseUrl` variable becomes one
   * Server Object. Omitted entirely when there are none, same pattern as
   * `tags`/`components` below. */
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, unknown>;
  components?: Record<string, unknown>;
  /** OpenAPI's own standard tag-declaration list (distinct `group` values,
   * in first-appearance order) — optional per spec, but populating it is
   * what lets a *third-party* renderer (real Swagger UI, Redoc, Postman's
   * import, Stoplight) group operations by tag at all. Without this AND
   * each operation's own `tags` array (see `buildOperation`), Vayo's
   * exported spec would still be valid OpenAPI 3.1, but every operation
   * would show up in one flat, ungrouped list outside Vayo's own UI —
   * despite Vayo's own sidebar being organized by `group` the whole time. */
  tags?: Array<{ name: string }>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Project-wide metadata for `compile()`'s `info`/`servers` — the
 * equivalent of swagger-jsdoc's `options.definition.info`/`servers`, just
 * sourced from Vayo's own `vayo_settings`/`vayo_environments` (docs/03-data-model.md)
 * instead of a static config object, so it's editable through the docs UI.
 * All optional; omitting everything reproduces `compile`'s original
 * behavior exactly ("Vayo API" title, no description, no servers). */
export interface CompileOptions {
  title?: string;
  description?: string;
  servers?: Array<{ url: string; description?: string }>;
  /** Pinned/saved examples (`vayo_examples`, `pinned: true`) keyed by
   * `vayoId` — compiled into each response's `examples` field alongside
   * any `@example`-declared one (see `buildResponses`). Absent entirely
   * (or a missing/empty entry for a given endpoint) reproduces `compile`'s
   * original behavior for that endpoint's examples exactly. */
  pinnedExamplesByVayoId?: Map<string, ExampleDoc[]>;
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
 * the field (which would itself fail validation). Two sources compile into
 * the response's own standard OpenAPI `examples` field (not an `x-vayo-*`
 * extension; `examples` is itself part of the spec), so any OpenAPI-
 * consuming tool — not just Vayo's own UI — sees them:
 *   - `declaredExamples` — a literal value per status from one or more
 *     `@example <status> <JSON>` tags (docs/04-capture-engine.md Step 2
 *     #4b), under the name `"declared"`.
 *   - `pinnedExamples` — real captured responses a team member explicitly
 *     saved from Try It Now (`vayo_examples`, `pinned: true`), one named
 *     entry per example (its own `label` when set, else a generic
 *     `pinned`/`pinned-N`). Real, observed traffic — same "actual evidence
 *     outranks a comment" precedence the UI's own ResponseSamplePanel
 *     already follows for its own display, just now also reflected in the
 *     exported spec instead of staying UI-only.
 * A status with only an example and no schema still gets a response entry
 * — an example is useful on its own even before any shape is known. */
function buildResponses(
  responseSchemas: Record<string, JSONSchema>,
  declaredExamples: Record<string, unknown>,
  pinnedExamples: ExampleDoc[],
): Record<string, unknown> {
  const pinnedByStatus = new Map<string, ExampleDoc[]>();
  for (const example of pinnedExamples) {
    const status = String(example.statusCode);
    pinnedByStatus.set(status, [...(pinnedByStatus.get(status) ?? []), example]);
  }

  const statuses = new Set([
    ...Object.keys(responseSchemas),
    ...Object.keys(declaredExamples),
    ...pinnedByStatus.keys(),
  ]);
  if (statuses.size === 0) {
    // OpenAPI requires at least one response; nothing was ever captured.
    return { "200": { description: "OK" } };
  }
  const responses: Record<string, unknown> = {};
  for (const status of statuses) {
    const schema = responseSchemas[status];
    const content: Record<string, unknown> = {};
    if (schema) content.schema = schema;
    const examples = buildExamplesForStatus(declaredExamples[status], pinnedByStatus.get(status) ?? []);
    if (examples) content.examples = examples;
    responses[status] = {
      description: STATUS_DESCRIPTIONS[status] ?? "Response",
      content: { "application/json": content },
    };
  }
  return responses;
}

/** Turns a slug-unfriendly human label ("Successful login!") into a valid,
 * readable OpenAPI examples-object key ("successful-login") — falls back
 * to `null` when nothing alphanumeric survives, so callers can supply their
 * own generic name instead of emitting an empty key. */
function slugifyExampleLabel(label: string): string | null {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
}

function buildExamplesForStatus(
  declaredValue: unknown,
  pinned: ExampleDoc[],
): Record<string, { value: unknown }> | undefined {
  const examples: Record<string, { value: unknown }> = {};
  if (declaredValue !== undefined) examples.declared = { value: declaredValue };
  pinned.forEach((example, i) => {
    const fallbackName = pinned.length > 1 ? `pinned-${i + 1}` : "pinned";
    const name = (example.label && slugifyExampleLabel(example.label)) || fallbackName;
    examples[name] = { value: example.responseBody };
  });
  return Object.keys(examples).length > 0 ? examples : undefined;
}

/** True when any top-level property carries `format: "binary"` —
 * `schema-engine`'s `markFileFields` sets this for a key `capture-express`
 * reported as an uploaded file (`req.file`/`req.files`, via multer),
 * docs/03-data-model.md `CapturedSample.requestBodyFileFields`. A real file
 * upload is never actually JSON on the wire — labeling it
 * `application/json` (even with a `format: binary` field inside) would be
 * non-compliant enough to mislead a code generator or a Postman import into
 * rendering a text field instead of a file picker for it. */
function requestBodyIsMultipart(schema: JSONSchema): boolean {
  const properties = schema.properties as Record<string, JSONSchema> | undefined;
  if (!properties) return false;
  return Object.values(properties).some((property) => property?.format === "binary");
}

/** Omits a requestBody entirely when the inferred schema has no properties
 * (e.g. a GET route, where `req.body` was always `{}`) — an empty
 * `{type:"object"}` requestBody is technically valid but documents nothing
 * and is misleading on a body-less method. */
function buildRequestBody(requestSchema: JSONSchema | null): Record<string, unknown> | null {
  const properties = requestSchema?.properties as Record<string, unknown> | undefined;
  if (!properties || Object.keys(properties).length === 0) return null;
  const mediaType = requestBodyIsMultipart(requestSchema!) ? "multipart/form-data" : "application/json";
  return { content: { [mediaType]: { schema: requestSchema } } };
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
  pinnedExamplesByVayoId: Map<string, ExampleDoc[]>,
): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    operationId: `${endpoint.method.toLowerCase()}_${endpoint.vayoId}`,
    // OpenAPI's own standard grouping mechanism — a single-element array
    // holding the full "/"-separated group path as one tag name (rather
    // than one tag per path segment), so a nested "Admin/Users" reads as
    // one unambiguous label in a flat-tag renderer instead of risking two
    // different "Users" groups (under different parents) merging together.
    tags: [endpoint.group],
    responses: buildResponses(
      endpoint.responseSchemas,
      endpoint.declaredExamples,
      pinnedExamplesByVayoId.get(endpoint.vayoId) ?? [],
    ),
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
  if (endpoint.description) operation.description = endpoint.description;
  if (endpoint.notes) operation[X_VAYO_NOTES] = endpoint.notes;
  if (endpoint.possiblyRemovedSince) operation[X_VAYO_POSSIBLY_REMOVED_SINCE] = endpoint.possiblyRemovedSince;
  if (endpoint.declaredResponseStatuses.length > 0) {
    operation[X_VAYO_RESPONSE_SCHEMA_DECLARED_STATUSES] = endpoint.declaredResponseStatuses;
  }
  // `deprecated` is OpenAPI's own standard Operation Object field, not an
  // x-vayo-* extension — omitted entirely when false (its documented
  // default), matching how every other optional field here is only added
  // when it has something to say.
  if (endpoint.deprecated) {
    operation.deprecated = true;
    if (endpoint.deprecatedSource === "declared") operation[X_VAYO_DEPRECATED_SOURCE] = endpoint.deprecatedSource;
  }

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

function buildDocument(endpoints: ResolvedEndpoint[], version: string, options: CompileOptions = {}): OpenAPIDocument {
  const inVersion = endpoints.filter((endpoint) => endpoint.version === version);
  const paths: Record<string, Record<string, unknown>> = {};
  const securitySchemes: Record<string, unknown> = {};
  // First-appearance order — compile() only ever sees the flat resolved
  // endpoint list, not vayo_folders' own ordering, so this is the best
  // available default; still far better for a third-party renderer than
  // no top-level `tags` declaration at all (see OpenAPIDocument.tags).
  const seenTags = new Set<string>();

  const pinnedExamplesByVayoId = options.pinnedExamplesByVayoId ?? new Map<string, ExampleDoc[]>();
  for (const endpoint of inVersion) {
    const path = toOpenApiPath(endpoint.pathTemplate);
    paths[path] ??= {};
    paths[path][endpoint.method.toLowerCase()] = buildOperation(endpoint, securitySchemes, pinnedExamplesByVayoId);
    seenTags.add(endpoint.group);
  }

  const doc: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: options.title || "Vayo API", version },
    paths,
  };
  if (options.description) doc.info.description = options.description;
  if (options.servers && options.servers.length > 0) doc.servers = options.servers;
  if (seenTags.size > 0) {
    doc.tags = [...seenTags].map((name) => ({ name }));
  }
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
export async function compile(
  endpoints: ResolvedEndpoint[],
  version: string,
  options?: CompileOptions,
): Promise<OpenAPIDocument> {
  const doc = buildDocument(endpoints, version, options);
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

// ---------------------------------------------------------------------------
// OpenAPI import (migration/onboarding, not a parallel authoring path):
// enriches endpoints Vayo *already discovered* via capture/AST scan with
// content from an existing spec (e.g. a team migrating off swagger-jsdoc) —
// deliberately never invents new endpoints from a spec alone. Capture/scan
// stay the sole source of truth for *what exists*; a spec operation with no
// matching, already-discovered endpoint is reported unmatched, not created
// as a placeholder. Pure/no I/O — `vayo import` (the CLI) is what turns this
// plan into real `vayo_overrides`/`vayo_examples`/`vayo_settings`/
// `vayo_environments` writes, the same "plan here, apply there" split
// `diffSpecs` above and `compile()` itself already follow.
// ---------------------------------------------------------------------------

/** The subset of an existing `EndpointDoc` the planner needs to know about:
 * enough to match a spec operation to it, and enough of its *current*
 * request/response schemas to decide which of the spec's field
 * descriptions have something real to attach to (see
 * `collectDescriptionOverrides` below) — deliberately not the full
 * `EndpointDoc`, so a caller building this from a DB read doesn't have to
 * think about which fields matter here. */
export interface ImportableEndpointRef {
  vayoId: string;
  method: string;
  pathTemplate: string; // Express-style, e.g. "/api/v1/users/:id" — not "/api/v1/users/{id}"
  requestSchema: JSONSchema | null;
  responseSchemas: Record<string, JSONSchema>;
}

export interface ImportedExample {
  statusCode: number;
  responseBody: unknown;
  label: string | null;
}

export interface ImportMatch {
  vayoId: string;
  method: string;
  pathTemplate: string;
  /** Field path (relative to the endpoint, e.g. `"summary"`,
   * `"requestSchema.properties.email.description"`) → value to write as an
   * override — the exact same generic `${vayoId}.${fieldPath}` mechanism
   * every other override in the system already uses. */
  overrides: Record<string, unknown>;
  examples: ImportedExample[];
}

export interface ImportPlan {
  title?: string;
  description?: string;
  servers: Array<{ url: string; description?: string }>;
  matched: ImportMatch[];
  /** Spec operations with no corresponding already-discovered endpoint —
   * never auto-created (see this section's own header comment); surfaced
   * so a human importing can see what didn't apply and why (route not yet
   * captured/scanned, or genuinely gone). */
  unmatched: Array<{ method: string; path: string }>;
}

/** Inverse of `toOpenApiPath` above — a spec's `{param}` back to Express's
 * `:param`, so a spec operation's path can be matched against
 * `ImportableEndpointRef.pathTemplate`. */
function fromOpenApiPath(specPath: string): string {
  return specPath.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1");
}

const HTTP_METHOD_KEYS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

/** A media-type object's own schema/examples only ever needs to be read
 * from one entry — `application/json` when present (Vayo's own
 * convention), else whichever the spec actually declared (a spec Vayo
 * didn't produce itself may use something else entirely, e.g. `text/plain`
 * for a legacy endpoint). */
function pickMediaType(content: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!content) return undefined;
  return (
    (content["application/json"] as Record<string, unknown> | undefined) ??
    (Object.values(content)[0] as Record<string, unknown> | undefined)
  );
}

/** Walks an imported schema alongside the endpoint's *existing* schema in
 * lockstep, collecting a `description` override for every node where both
 * sides have something at the same path — deliberately guarded on the
 * existing side (`existing` must be present, not just `imported`), so
 * import never synthesizes schema structure Vayo's own capture/AST scan
 * hasn't actually found yet; it only ever annotates what's really there.
 * Recurses through `properties`/`items` only (no `allOf`/`oneOf`/`anyOf`)
 * — the only shapes `schema-engine`'s own genson-based inference and Zod
 * extraction ever produce, so there's nothing on the *existing* side those
 * branches could ever match against anyway. */
function collectDescriptionOverrides(
  imported: JSONSchema | undefined,
  existing: JSONSchema | undefined,
  basePath: string,
  out: Record<string, unknown>,
): void {
  if (!imported || !existing) return;
  if (typeof imported.description === "string" && imported.description.trim()) {
    out[`${basePath}.description`] = imported.description;
  }
  const importedProps = imported.properties as Record<string, JSONSchema> | undefined;
  const existingProps = existing.properties as Record<string, JSONSchema> | undefined;
  if (importedProps && existingProps) {
    for (const [key, importedProp] of Object.entries(importedProps)) {
      if (existingProps[key]) {
        collectDescriptionOverrides(importedProp, existingProps[key], `${basePath}.properties.${key}`, out);
      }
    }
  }
  const importedItems = imported.items as JSONSchema | undefined;
  const existingItems = existing.items as JSONSchema | undefined;
  collectDescriptionOverrides(importedItems, existingItems, `${basePath}.items`, out);
}

/** A media type's example(s) — the plural, named `examples` map (OpenAPI
 * 3.1's preferred form, and what `@vayo/openapi-compiler` itself emits) when
 * present, else the older singular `example` field most hand-written specs
 * (swagger-jsdoc among them) actually use in practice. Each becomes a
 * pinned `vayo_examples` entry, not another `@example`-style declared one —
 * there's no code for a *literal* imported value to be declared *in*. */
function collectImportedExamples(mediaType: Record<string, unknown> | undefined, statusCode: number): ImportedExample[] {
  if (!mediaType) return [];
  const examplesMap = mediaType.examples as Record<string, { value?: unknown }> | undefined;
  if (examplesMap && Object.keys(examplesMap).length > 0) {
    return Object.entries(examplesMap).map(([name, example]) => ({
      statusCode,
      responseBody: example?.value,
      label: name,
    }));
  }
  if ("example" in mediaType) {
    return [{ statusCode, responseBody: mediaType.example, label: null }];
  }
  return [];
}

/** A Postman Collection export (`info: {name, schema}`, a top-level `item`
 * array of requests/folders — see `@vayo/server`'s own `PostmanCollection`
 * interface, `postman-export.ts`) has no `paths` object at all, so feeding
 * one into `planOpenApiImport` would otherwise silently produce an empty,
 * misleadingly-successful-looking plan (0 matched, 0 unmatched, no error)
 * rather than a clear "wrong file" signal — worse than an error, since it
 * looks like there was simply nothing to import instead of looking like a
 * mistake. Checked before anything else runs. The `postman.com` schema URL
 * is the definitive signal when present; `item` + no `paths` is the
 * fallback for a collection whose `info.schema` was stripped/edited. */
function detectPostmanCollection(doc: Record<string, unknown>): boolean {
  const info = doc.info as Record<string, unknown> | undefined;
  const schemaUrl = typeof info?.schema === "string" ? info.schema : "";
  if (schemaUrl.toLowerCase().includes("getpostman.com")) return true;
  return Array.isArray(doc.item) && !doc.paths;
}

/**
 * Plans an import from an existing OpenAPI document (3.0.x or 3.1 — read
 * permissively, since this only ever extracts plain text/example values,
 * never reconciles schema-shape differences between the two spec
 * versions) against endpoints Vayo has already discovered. Pure — no I/O,
 * no DB access; the CLI (`vayo import`) turns the returned plan into real
 * writes, the same split `compile()`/`diffSpecs()` above already use.
 *
 * Throws (rather than returning an empty plan) when the input looks like a
 * Postman Collection export instead of an OpenAPI document — Postman
 * collection import is a distinct, not-yet-built feature (different
 * shape entirely: `item[]`/`request`/`response`, no `paths`), and silently
 * matching nothing would be a worse failure mode than a clear error naming
 * exactly what was wrong.
 */
export function planOpenApiImport(
  spec: unknown,
  existingEndpoints: ImportableEndpointRef[],
  existingEnvironments: Array<{ variables: Record<string, string> }>,
): ImportPlan {
  const doc = (spec ?? {}) as Record<string, unknown>;
  if (detectPostmanCollection(doc)) {
    throw new Error(
      '@vayo/openapi-compiler: this file looks like a Postman Collection export ("item"/a postman.com schema URL, no "paths") — vayo import only reads OpenAPI specs right now.',
    );
  }
  const info = doc.info as Record<string, unknown> | undefined;
  const title = typeof info?.title === "string" && info.title.trim() ? info.title : undefined;
  const description = typeof info?.description === "string" && info.description.trim() ? info.description : undefined;

  const existingBaseUrls = new Set(existingEnvironments.map((env) => env.variables.baseUrl).filter(Boolean));
  const specServers = Array.isArray(doc.servers) ? (doc.servers as Array<Record<string, unknown>>) : [];
  const servers = specServers
    .filter((server) => typeof server.url === "string" && !existingBaseUrls.has(server.url as string))
    .map((server) => ({
      url: server.url as string,
      description: typeof server.description === "string" ? server.description : undefined,
    }));

  const endpointByKey = new Map<string, ImportableEndpointRef>();
  for (const ref of existingEndpoints) {
    endpointByKey.set(`${ref.method.toUpperCase()} ${ref.pathTemplate}`, ref);
  }

  const matched: ImportMatch[] = [];
  const unmatched: Array<{ method: string; path: string }> = [];
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;

  for (const [specPath, pathItem] of Object.entries(paths)) {
    const expressPath = fromOpenApiPath(specPath);
    for (const [methodKey, rawOperation] of Object.entries(pathItem)) {
      if (!HTTP_METHOD_KEYS.has(methodKey)) continue;
      const operation = rawOperation as Record<string, unknown>;
      const method = methodKey.toUpperCase();
      const ref = endpointByKey.get(`${method} ${expressPath}`);
      if (!ref) {
        unmatched.push({ method, path: specPath });
        continue;
      }

      const overrides: Record<string, unknown> = {};
      if (typeof operation.summary === "string" && operation.summary.trim()) overrides.summary = operation.summary;
      if (typeof operation.description === "string" && operation.description.trim()) {
        overrides.description = operation.description;
      }

      const requestContent = (operation.requestBody as Record<string, unknown> | undefined)?.content as
        | Record<string, unknown>
        | undefined;
      const requestSchema = pickMediaType(requestContent)?.schema as JSONSchema | undefined;
      collectDescriptionOverrides(requestSchema, ref.requestSchema ?? undefined, "requestSchema", overrides);

      const examples: ImportedExample[] = [];
      const responses = (operation.responses ?? {}) as Record<string, Record<string, unknown>>;
      for (const [status, response] of Object.entries(responses)) {
        const mediaType = pickMediaType(response.content as Record<string, unknown> | undefined);
        const responseSchema = mediaType?.schema as JSONSchema | undefined;
        collectDescriptionOverrides(responseSchema, ref.responseSchemas[status], `responseSchemas.${status}`, overrides);
        const statusCode = Number(status);
        if (Number.isFinite(statusCode)) examples.push(...collectImportedExamples(mediaType, statusCode));
      }

      matched.push({ vayoId: ref.vayoId, method, pathTemplate: ref.pathTemplate, overrides, examples });
    }
  }

  return { title, description, servers, matched, unmatched };
}
