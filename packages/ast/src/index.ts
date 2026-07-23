// @vayo/ast
// Static analysis pass — docs/04-capture-engine.md Step 2 and §3a.
// Framework-specific bootstrapping (getting a live `app` instance) is
// isolated behind the adapter path passed in via VayoConfig; this module's
// own logic doesn't otherwise assume Express beyond that one boundary
// (and the express-list-endpoints dependency itself, per
// docs/08-packages-and-repo-structure.md's own description of this package).

import path from "node:path";
import { pathToFileURL } from "node:url";
import expressListEndpoints from "express-list-endpoints";
import { Node, Project, SyntaxKind, type CallExpression, type SourceFile } from "ts-morph";
import type { JSONSchema } from "@vayo/types";

export const DEFAULT_AUTH_MIDDLEWARE_PATTERNS = [
  "authenticate",
  "requireAuth",
  "isLoggedIn",
  "verifyToken",
  "passport.authenticate",
];

export const DEFAULT_SCOPE_CHECK_PATTERNS = [
  "requireScope",
  "checkPermission",
  "authorize",
];

/** Body-validation middleware names to recognize a Zod schema argument
 * against (docs/04-capture-engine.md Step 2 #3) — configurable the same way
 * auth/scope patterns are, since every team names this differently. */
export const DEFAULT_VALIDATION_MIDDLEWARE_PATTERNS = [
  "validateBody",
  "validate",
  "validateRequest",
  "zValidator",
];

export interface VayoConfig {
  appEntryPath: string; // e.g. "./src/app.ts" — must export a bootstrapped Express app
  authMiddlewarePatterns?: string[];
  scopeCheckPatterns?: string[];
  validationMiddlewarePatterns?: string[];
  redact?: string[];
}

export interface StaticRouteResult {
  method: string;
  pathTemplate: string;
  middlewareChain: string[];
  authRequiredGuess: boolean;
  scopes: string[];
  group: string;
  /** "declared" when an explicit `@group <name>` tag was found in the
   * route's leading comment (swagger-jsdoc's own convention), "inferred"
   * when `group` instead came from the `routes/` file-layout convention or
   * the URL-segment fallback (docs/04-capture-engine.md Step 2 #4). Lets
   * the UI treat a `"declared"` grouping as authoritative — e.g. refusing
   * to let a drag-and-drop move it to a different sidebar folder, since
   * that would silently diverge from what the code itself says. */
  groupSource: "declared" | "inferred";
  summary: string | null;
  /** Longer, potentially multi-line/multi-paragraph explanation from an
   * explicit `@description` tag — OpenAPI's own standard Operation Object
   * distinguishes this from `summary` (a short one-liner); see
   * `extractDescription`. `null` when absent, same as `summary`. */
  description: string | null;
  /** True when an explicit bare `@deprecated` tag was found in the route's
   * leading comment (the same OpenAPI/swagger-jsdoc convention `deprecated:
   * true` on an Operation Object mirrors) — docs/04-capture-engine.md Step
   * 2 #4a. Always `false` when absent; there's no inferred/guessed
   * "probably deprecated" signal the way `group` has multiple fallbacks. */
  deprecated: boolean;
  /** A Zod- or Mongoose-derived request body shape, when one could be
   * traced statically — see `findRequestSchemaForRoute`/
   * `findMongooseRequestSchemaForRoute` below. `null` (not an empty
   * object) when nothing was found, so a merge never mistakes "found
   * nothing" for "this endpoint genuinely takes no body." */
  requestSchema: JSONSchema | null;
  /** "declared" when `requestSchema` came from a Zod schema the code
   * itself validates against, "inferred" when it came from a Mongoose
   * model's schema instead (docs/03-data-model.md) — `null` exactly when
   * `requestSchema` is. */
  requestSchemaSource: "declared" | "inferred" | null;
  /** Response body shape(s) declared via one or more `@response <status>
   * <SchemaName>` tags in the route's leading comment, keyed by status code
   * (docs/04-capture-engine.md Step 2 #4b) — see `extractDeclaredResponseSchemas`
   * below. Empty when none were found; unlike `requestSchema` there's no
   * "inferred" convention for a response shape (no Mongoose-model
   * equivalent for "what does this endpoint send back"), so a declared
   * response schema is always high-confidence when present at all. */
  declaredResponseSchemas: Record<string, JSONSchema>;
  /** Literal example response value(s) declared via one or more `@example
   * <status> <JSON>` tags, keyed by status code — see
   * `extractDeclaredExamples` below. Empty when none were found. */
  declaredExamples: Record<string, unknown>;
}

export interface StaticScanResult {
  routes: StaticRouteResult[];
}

const HTTP_METHOD_PROPERTY_NAMES = new Set(["get", "post", "put", "patch", "delete", "all"]);

/** Unwraps `export default app`'s value out of a dynamically-`import()`ed
 * module. Some TS-execution loaders (tsx among them) double-wrap a CJS
 * module's default export when it's dynamically imported from a CJS
 * caller — `mod.default` ends up being the raw `module.exports` object
 * (itself `{ default: app }`) rather than `app` directly. An Express app is
 * always a callable function, so unwrap one more `.default` layer at a time
 * until we find one (or run out of layers). */
function unwrapApp(mod: { default?: unknown; app?: unknown }): unknown {
  let candidate: unknown = mod.default ?? mod.app;
  while (
    candidate !== null &&
    typeof candidate === "object" &&
    "default" in (candidate as Record<string, unknown>)
  ) {
    candidate = (candidate as Record<string, unknown>).default;
  }
  return candidate;
}

/** Folder/mount-path convention (docs/04-capture-engine.md Step 2 #4): a
 * route registered from a file under `routes/orders/*.ts` -> "Orders", and
 * one under `routes/admin/users/*.ts` -> "Admin/Users" — every directory
 * segment between `routes/` and the file itself becomes one level of the
 * "/"-separated group path, so `@vayo/db-mongo`'s `autoOrganizeFolders` can
 * turn a nested route-file layout into real nested sidebar folders instead
 * of flattening it to one level. Falls back to the first meaningful path
 * segment (never nested — a URL's own segments aren't a reliable
 * organizational signal the way a deliberate file layout is) when the entry
 * file isn't organized that way at all (e.g. a single flat app.ts, as in
 * the demo app). */
export function inferGroup(pathTemplate: string, sourceFilePath: string): string {
  const folderMatch = sourceFilePath.replace(/\\/g, "/").match(/\/routes\/(.+)\/[^/]+$/i);
  if (folderMatch) {
    const segments = folderMatch[1]!.split("/").filter((s) => s.length > 0);
    if (segments.length > 0) {
      return segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("/");
    }
  }
  const raw = pathTemplate.split("/").find((s) => s.length > 0 && !s.startsWith(":") && !/^v\d+$/i.test(s) && s !== "api");
  if (!raw) return "General";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** True when `registrationPath` (a literal string found at a route
 * registration site, e.g. `router.get("/:id", ...)`) resolves to
 * `runtimePath` (the fully-mounted path `express-list-endpoints` reports,
 * e.g. `/api/admin/products/:id`). Exact equality covers routes registered
 * directly on `app` with their full path repeated (today's flat demo-app
 * style); segment-suffix equality covers `express.Router()` composition
 * mounted via `app.use(prefix, router)` at any nesting depth — the router's
 * own registration only ever sees its path relative to wherever it gets
 * mounted, but `express-list-endpoints` resolves the live app's actual
 * router stack at runtime, so the runtime path is always the source of
 * truth here; only the static side needs to tolerate the prefix it can't
 * see. Segment-based (not raw substring) so `/id` can never accidentally
 * suffix-match inside `/userid`. */
export function pathSegmentsMatch(registrationPath: string, runtimePath: string): boolean {
  if (registrationPath === runtimePath) return true;
  const regSegments = registrationPath.split("/").filter((s) => s.length > 0);
  const runtimeSegments = runtimePath.split("/").filter((s) => s.length > 0);
  if (regSegments.length === 0 || regSegments.length > runtimeSegments.length) return false;
  const suffix = runtimeSegments.slice(runtimeSegments.length - regSegments.length);
  return suffix.every((segment, i) => segment === regSegments[i]);
}

function calleeName(call: CallExpression): string | null {
  const expr = call.getExpression();
  if (Node.isIdentifier(expr)) return expr.getText();
  if (Node.isPropertyAccessExpression(expr)) return expr.getName();
  return null;
}

interface RouteRegistration {
  method: string; // uppercased, matches express-list-endpoints' endpoint.methods
  pathTemplate: string;
  call: CallExpression;
}

/** Finds every `app.<method>("/path", ...)` (or `router.<method>(...)`,
 * `someRouter.<method>(...)` — any receiver, since a route can be registered
 * on `app` directly or on any `express.Router()`) call in the source file —
 * the literal registration sites we can pattern-match scope-check calls and
 * JSDoc summaries against. Captures the method name too since two different
 * methods are frequently registered at the identical literal path (e.g.
 * `router.get("/", list)` and `router.post("/", create)` both mounted at the
 * same prefix) — matching on path alone would silently pick the wrong one. */
function findRouteRegistrations(sourceFile: SourceFile): RouteRegistration[] {
  const registrations: RouteRegistration[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    if (!HTTP_METHOD_PROPERTY_NAMES.has(expr.getName())) continue;
    const [first] = call.getArguments();
    if (!first || !Node.isStringLiteral(first)) continue;
    registrations.push({ method: expr.getName().toUpperCase(), pathTemplate: first.getLiteralValue(), call });
  }
  return registrations;
}

/** Joins an `express.Router()`'s own relative registration path onto the
 * literal prefix it's mounted at (`app.use(prefix, router)`) — mirrors how
 * Express itself resolves it, including the router-root special case
 * (`router.get("/", ...)` mounted at `prefix` resolves to exactly `prefix`,
 * not `prefix + "/"`). Empty `prefix` (a registration found directly on
 * `app`, never resolved through a mount call) is a no-op, so today's flat
 * style keeps matching by plain equality with zero special-casing. */
export function joinMountedPath(prefix: string, relativePath: string): string {
  if (relativePath === "/" || relativePath === "") return prefix || "/";
  return `${prefix}${relativePath}`;
}

/** Resolves the identifier passed as the second argument of an
 * `X.use("/prefix", identifier)` call back to the source file it was
 * imported from — e.g. `import productsRouter from "./routes/products/
 * products.routes.js"` — by reading the *default* import bindings actually
 * declared in `callSiteFile`, purely syntactically (no full symbol/alias
 * resolution). This only ever recognizes the "one exported router per
 * file, imported and mounted by identifier" convention; anything else
 * (named exports, re-exports, indirection through a barrel file) simply
 * fails to resolve a prefix for that router, which is always a safe
 * fallback — `pathSegmentsMatch` below still catches it. */
function resolveRouterSourceFile(identifierName: string, callSiteFile: SourceFile): SourceFile | null {
  for (const importDecl of callSiteFile.getImportDeclarations()) {
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport?.getText() === identifierName) {
      return importDecl.getModuleSpecifierSourceFile() ?? null;
    }
  }
  return null;
}

/** Scans every file in the project for `X.use("/prefix", router)` calls and
 * maps each mounted router's *source file* to the literal prefix it's
 * mounted at — the piece `express-list-endpoints` can't give us (it only
 * reports the live app's fully-*resolved* runtime paths, not which static
 * file each route came from). One level of mounting only (a router
 * mounted directly on `app` or on another router) — sufficient for the
 * "one router per domain, all mounted in one place" convention this is
 * built around; deeper indirection just falls through to the
 * `pathSegmentsMatch` fallback below. */
export function buildMountPrefixMap(project: Project): Map<string, string> {
  const prefixByFilePath = new Map<string, string>();
  for (const sourceFile of project.getSourceFiles()) {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== "use") continue;
      const [prefixArg, routerArg] = call.getArguments();
      if (!prefixArg || !routerArg || !Node.isStringLiteral(prefixArg) || !Node.isIdentifier(routerArg)) continue;
      const routerFile = resolveRouterSourceFile(routerArg.getText(), sourceFile);
      if (routerFile) prefixByFilePath.set(routerFile.getFilePath(), prefixArg.getLiteralValue());
    }
  }
  return prefixByFilePath;
}

/**
 * Scope detection (docs/04-capture-engine.md §3a): looks for calls to a
 * configurable set of scope-check function names anywhere inside a route
 * registration call (e.g. `requireScope("admin:read")` passed as one of
 * `app.get(path, ...middlewares, handler)`'s arguments) and extracts the
 * literal string(s) passed to it. Never invents a scope from runtime
 * behavior — if no matching call exists, this returns [].
 */
function extractScopes(call: CallExpression, scopePatterns: string[]): string[] {
  const scopes = new Set<string>();
  for (const nested of call.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const name = calleeName(nested);
    if (!name || !scopePatterns.includes(name)) continue;
    for (const arg of nested.getArguments()) {
      if (Node.isStringLiteral(arg)) {
        scopes.add(arg.getLiteralValue());
      } else if (Node.isArrayLiteralExpression(arg)) {
        for (const element of arg.getElements()) {
          if (Node.isStringLiteral(element)) scopes.add(element.getLiteralValue());
        }
      }
    }
  }
  return [...scopes].sort();
}

/** Extracts the middleware chain from a static route registration's own
 * arguments (e.g. `router.post("/", requireAuth, requireRole("admin"),
 * handler)` -> `["requireAuth", "requireRole"]`), in registration order.
 *
 * Needed because `express-list-endpoints` (7.x) merges endpoints that share
 * a literal path across different HTTP methods by concatenating their
 * `methods` arrays, but silently keeps only the *first-registered* method's
 * own `middlewares` array for the merged entry (see its `addEndpoints`) — a
 * public `GET "/"` registered before a protected `POST "/"` on the same
 * path makes the protected POST inherit GET's *empty* middleware chain.
 * Reading it statically, per registration, sidesteps that upstream bug —
 * this is the actual mechanism the Flowmap tab and `authRequiredGuess`
 * below depend on being correct per method, not just per path.
 *
 * The first argument (the path string) and the last (the handler, always
 * anonymous in every convention this cares about) are dropped; everything
 * between is either a plain identifier (`requireAuth`) or a middleware
 * factory call (`requireRole("admin")`, reported by its callee name). */
export function extractMiddlewareNames(call: CallExpression): string[] {
  const middlewareArgs = call.getArguments().slice(1, -1);
  const names: string[] = [];
  for (const arg of middlewareArgs) {
    if (Node.isIdentifier(arg)) {
      names.push(arg.getText());
    } else if (Node.isCallExpression(arg)) {
      const name = calleeName(arg);
      if (name) names.push(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------
// Zod → JSON Schema (docs/04-capture-engine.md Step 2 #3): a real Zod
// schema, when a team already writes one, is higher-fidelity than runtime
// inference alone — it documents fields no traffic has exercised yet, and
// carries `.describe()` text runtime capture could never produce. Scoped
// deliberately narrow rather than a general Zod interpreter: object/string/
// number/boolean/array/enum base types, a handful of common modifiers, and
// schema *composition* (`.extend()`, `.merge()`, unions, `z.date()`, ...) is
// left unresolved on purpose — an unresolved schema just falls back to
// runtime inference, which is always the safe default, never a hard error.
// ---------------------------------------------------------------------

interface ZodChainLink {
  method: string;
  args: Node[];
}

/** Walks a Zod builder chain (`z.string().email().describe("x")`) from the
 * outermost call inward until it hits the literal `z.<type>(...)` base —
 * returns null for anything that isn't a chain rooted at the `z` import
 * itself (schema composition via `.extend()`/`.merge()`, a reused variable
 * as the base, `z.union()`/`z.record()`, etc. — all intentionally
 * unsupported rather than guessed at). */
function unwindZodChain(expr: Node): { base: ZodChainLink; modifiers: ZodChainLink[] } | null {
  const modifiers: ZodChainLink[] = [];
  let current: Node = expr;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!Node.isCallExpression(current)) return null;
    const callee = current.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return null;
    const method = callee.getName();
    const args = current.getArguments();
    const receiver = callee.getExpression();
    if (Node.isIdentifier(receiver) && receiver.getText() === "z") {
      return { base: { method, args }, modifiers: modifiers.reverse() };
    }
    modifiers.push({ method, args });
    current = receiver;
  }
}

function zodBaseToJsonSchema(base: ZodChainLink): JSONSchema | null {
  switch (base.method) {
    case "object": {
      const [shape] = base.args;
      if (!shape || !Node.isObjectLiteralExpression(shape)) return null;
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];
      for (const prop of shape.getProperties()) {
        if (!Node.isPropertyAssignment(prop)) continue;
        const key = prop.getName();
        const valueExpr = prop.getInitializer();
        if (!valueExpr) continue;
        const field = zodExpressionToField(valueExpr);
        if (!field) continue;
        properties[key] = field.schema;
        if (!field.optional) required.push(key);
      }
      return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
    }
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "array": {
      const [itemExpr] = base.args;
      const itemSchema = itemExpr ? zodExpressionToField(itemExpr)?.schema : undefined;
      return itemSchema ? { type: "array", items: itemSchema } : { type: "array" };
    }
    case "enum": {
      const [arr] = base.args;
      if (arr && Node.isArrayLiteralExpression(arr)) {
        const values: string[] = [];
        for (const el of arr.getElements()) {
          if (Node.isStringLiteral(el)) values.push(el.getLiteralValue());
        }
        if (values.length > 0) return { type: "string", enum: values };
      }
      return { type: "string" };
    }
    default:
      return null; // z.date()/z.union()/z.record()/z.any()/... — not modeled
  }
}

/** Applies chained modifier calls on top of a base schema — `.describe()`
 * for the field description this whole pass exists to recover, plus a
 * handful of the most common validators. Anything unrecognized
 * (`.refine()`, `.transform()`, `.default()`, `.strict()`, ...) is silently
 * skipped rather than failing the field. */
function applyZodModifiers(schema: JSONSchema, modifiers: ZodChainLink[]): { schema: JSONSchema; optional: boolean } {
  let optional = false;
  const result: JSONSchema = { ...schema };
  for (const mod of modifiers) {
    const [arg] = mod.args;
    switch (mod.method) {
      case "describe":
        if (arg && Node.isStringLiteral(arg)) result.description = arg.getLiteralValue();
        break;
      case "optional":
      case "nullish":
        optional = true;
        break;
      case "email":
        result.format = "email";
        break;
      case "uuid":
        result.format = "uuid";
        break;
      case "url":
        result.format = "uri";
        break;
      case "datetime":
        result.format = "date-time";
        break;
      case "int":
        result.type = "integer";
        break;
      case "min":
        if (arg && Node.isNumericLiteral(arg)) {
          const n = Number(arg.getText());
          if (result.type === "string") result.minLength = n;
          else if (result.type === "number" || result.type === "integer") result.minimum = n;
        }
        break;
      case "max":
        if (arg && Node.isNumericLiteral(arg)) {
          const n = Number(arg.getText());
          if (result.type === "string") result.maxLength = n;
          else if (result.type === "number" || result.type === "integer") result.maximum = n;
        }
        break;
      default:
        break;
    }
  }
  return { schema: result, optional };
}

function zodExpressionToField(expr: Node): { schema: JSONSchema; optional: boolean } | null {
  const chain = unwindZodChain(expr);
  if (!chain) return null;
  const base = zodBaseToJsonSchema(chain.base);
  if (!base) return null;
  return applyZodModifiers(base, chain.modifiers);
}

/** Resolves a bare identifier (`CreateOrderSchema`) back to whatever it was
 * declared as (`const CreateOrderSchema = z.object({...})`), wherever that
 * declaration lives — same file or a different one, ts-morph's own
 * definition-lookup handles cross-file resolution, unlike the narrower
 * hand-rolled import-following `resolveRouterSourceFile` needs elsewhere in
 * this file for a different purpose. */
function resolveIdentifierInitializer(identifier: Node): Node | null {
  if (!Node.isIdentifier(identifier)) return null;
  for (const def of identifier.getDefinitionNodes()) {
    if (Node.isVariableDeclaration(def)) {
      const init = def.getInitializer();
      if (init) return init;
    }
  }
  return null;
}

/** A schema reference is either the Zod expression written inline, or an
 * identifier pointing at one declared elsewhere — tries both. */
function resolveZodSchema(node: Node): JSONSchema | null {
  const direct = zodExpressionToField(node)?.schema;
  if (direct) return direct;
  const resolved = resolveIdentifierInitializer(node);
  return resolved ? zodExpressionToField(resolved)?.schema ?? null : null;
}

/** Finds a request-body Zod schema statically associated with a route
 * registration, trying two conventions in order: (1) a validation-
 * middleware call among the route's own arguments (`validateBody(Schema)`,
 * `zValidator("json", Schema)` — the schema is whichever argument actually
 * resolves, checked last-to-first since the schema is usually the final
 * arg), then (2) `Schema.parse(req.body)`/`.safeParse(...)` called directly
 * inside the handler body. Returns null — never throws, never guesses —
 * when neither convention matches. */
export function findRequestSchemaForRoute(call: CallExpression, validationPatterns: string[]): JSONSchema | null {
  const middlewareArgs = call.getArguments().slice(1, -1);
  for (const arg of middlewareArgs) {
    if (!Node.isCallExpression(arg)) continue;
    const name = calleeName(arg);
    if (!name || !validationPatterns.includes(name)) continue;
    const schemaArgs = arg.getArguments();
    for (let i = schemaArgs.length - 1; i >= 0; i--) {
      const candidate = schemaArgs[i];
      const resolved = candidate ? resolveZodSchema(candidate) : null;
      if (resolved) return resolved;
    }
  }

  const handler = call.getArguments().at(-1);
  if (handler && (Node.isArrowFunction(handler) || Node.isFunctionExpression(handler))) {
    for (const inner of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = inner.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      if (expr.getName() !== "parse" && expr.getName() !== "safeParse") continue;
      const resolved = resolveZodSchema(expr.getExpression());
      if (resolved) return resolved;
    }
  }

  return null;
}

// ---------------------------------------------------------------------
// Mongoose model → JSON Schema (docs/04-capture-engine.md Step 2 #3b): the
// other real-world source of "what does this request body look like" for
// the very common case where a project validates through nothing more
// formal than its Mongoose model — the model *is* the closest thing to a
// declared schema many real Express APIs ever write. Two conventions,
// tried in order, each a single fixed pattern rather than a general
// data-flow analysis — same "detect a convention, never guess" bar the Zod
// path above holds itself to:
//
//   1. Direct passthrough — `Model.create(req.body)`, `new Model(req.body)`,
//      `Model.findByIdAndUpdate(id, req.body)`,
//      `Model.findOneAndUpdate(filter, req.body)`,
//      `Model.updateOne(filter, req.body)` — the model's full schema shape
//      wins outright, highest fidelity of the two.
//   2. Destructure-and-cross-reference — `const { a, b } = req.body;`
//      followed somewhere in the same handler by a call on an identifier
//      that resolves to a Mongoose model (the extremely common "pull named
//      fields off req.body, then build the doc from local variables"
//      style, e.g. `new Model({ a, b, ...stampedFields })` a few lines
//      later) — the schema is restricted to exactly the destructured
//      names, each one's type looked up from that model's own field
//      definitions when the name matches (falling back to a generic
//      string for a name the model doesn't declare, e.g. a
//      request-only/computed field).
//
// Both are marked `requestSchemaSource: "inferred"` (docs/03-data-model.md)
// rather than "declared" like Zod: a Mongoose schema describes the
// *stored document*, not necessarily the exact accepted request shape.
// ---------------------------------------------------------------------

const MONGOOSE_DIRECT_WRITE_METHODS = new Set(["create", "findByIdAndUpdate", "findOneAndUpdate", "updateOne"]);

function isReqBodyExpression(node: Node): boolean {
  return Node.isPropertyAccessExpression(node) && node.getName() === "body" && node.getExpression().getText() === "req";
}

/** `mongoose.Schema({...})` / `new mongoose.Schema({...})` / bare
 * `Schema({...})` / `new Schema({...})` — Mongoose supports the factory
 * call and `new` forms interchangeably, and a project may destructure
 * `Schema` off the `mongoose` import instead of qualifying it every time;
 * matched purely by callee name (`.Schema`/`Schema`), same syntactic-only
 * pragmatism `unwindZodChain` already applies to recognizing `z`. */
function schemaCallShapeArgument(node: Node): Node | null {
  if (!Node.isCallExpression(node) && !Node.isNewExpression(node)) return null;
  const expr = node.getExpression();
  const name = Node.isIdentifier(expr) ? expr.getText() : Node.isPropertyAccessExpression(expr) ? expr.getName() : null;
  if (name !== "Schema") return null;
  const [shape] = node.getArguments();
  return shape ?? null;
}

/** Resolves an identifier back to whatever it was declared as, wherever
 * that declaration lives. TypeScript's own checker (even with plain JS +
 * `allowJs`) already follows both ES `import` bindings AND CommonJS
 * `require()` bindings all the way to the exporting declaration —
 * `const X = require("./path")` + `module.exports = Y`, and a destructured
 * `const { name } = require("./path")` + `exports.name = Y` / `module.
 * exports.name = Y`, both resolve `getDefinitionNodes()` straight to the
 * *exports* property-access itself (confirmed empirically — there's no
 * public API for this, it falls out of the language service's ordinary
 * "go to definition"). This only has to peel back one more layer: take
 * that property access's parent assignment and return its right-hand
 * side, the actual exported value. A `module.exports = { name }` shorthand
 * object literal instead resolves `getDefinitionNodes()` straight to that
 * `ShorthandPropertyAssignment` itself (confirmed empirically, alongside
 * the property-access case above) — one more hop through *its* own name
 * node's definition (an ordinary same-file variable reference) reaches the
 * real declaration. */
function resolveIdentifierDeclarationInitializer(node: Node): Node | null {
  if (!Node.isIdentifier(node)) return null;
  for (const def of node.getDefinitionNodes()) {
    if (Node.isVariableDeclaration(def)) {
      const init = def.getInitializer();
      if (init) return init;
    }
    if (Node.isPropertyAccessExpression(def)) {
      const assignment = def.getParentIfKind(SyntaxKind.BinaryExpression);
      if (assignment && assignment.getLeft() === def) return assignment.getRight();
    }
    if (Node.isShorthandPropertyAssignment(def)) {
      const resolved = resolveIdentifierDeclarationInitializer(def.getNameNode());
      if (resolved) return resolved;
    }
  }
  return null;
}

/** Resolves the schema identifier named in an `@response <status> <Name>`
 * tag (see `extractDeclaredResponseSchemas` below) back to its Zod schema,
 * by *name* rather than from an already-found AST reference the way every
 * other resolver in this file works — the tag only gives us plain text
 * pulled out of a comment, not a node. Tries, in order: a same-file
 * `const <Name> = ...`, a named ESM import (`import { Name } from "..."`),
 * and a CommonJS destructured require (`const { Name } = require("...")`) —
 * the same three binding shapes `findMongooseRequestSchemaForRoute`'s
 * cross-reference case already resolves via identifier references, just
 * located here by name first. Returns null (never guesses) when `name`
 * doesn't resolve to a real Zod schema through any of the three. */
function findSchemaByName(sourceFile: SourceFile, name: string): JSONSchema | null {
  // Deliberately a descendant search, not `sourceFile.getVariableDeclaration`/
  // `getVariableDeclarations()` — those only ever see declarations directly
  // at the file's top level, missing the extremely common real-world case
  // of a schema declared inside a `createApp()`-style factory function
  // (this project's own demo app and CLI-generated scaffold both use
  // exactly that shape) — confirmed empirically, not an assumption.
  const allVarDecls = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);

  for (const varDecl of allVarDecls) {
    const nameNode = varDecl.getNameNode();
    if (Node.isIdentifier(nameNode) && nameNode.getText() === name) {
      const init = varDecl.getInitializer();
      const schema = init ? zodExpressionToField(init)?.schema : undefined;
      if (schema) return schema;
    }
  }

  for (const imp of sourceFile.getImportDeclarations()) {
    const named = imp.getNamedImports().find((n) => (n.getAliasNode() ?? n.getNameNode()).getText() === name);
    if (!named) continue;
    const resolved = resolveIdentifierDeclarationInitializer(named.getAliasNode() ?? named.getNameNode());
    const schema = resolved ? zodExpressionToField(resolved)?.schema : undefined;
    if (schema) return schema;
  }

  for (const varDecl of allVarDecls) {
    const nameNode = varDecl.getNameNode();
    if (!Node.isObjectBindingPattern(nameNode)) continue;
    for (const element of nameNode.getElements()) {
      if (element.getName() !== name) continue;
      const resolved = resolveIdentifierDeclarationInitializer(element.getNameNode());
      const schema = resolved ? zodExpressionToField(resolved)?.schema : undefined;
      if (schema) return schema;
    }
  }

  return null;
}

/** A single Mongoose schema field's type reference — `String`, `Number`,
 * `mongoose.Schema.Types.ObjectId`/`Schema.Types.ObjectId` (a Mongo
 * document reference, documented as a plain string id), or an array of
 * either (`[String]`, `[{...subdocument...}]`). Anything else (a custom
 * class, `Schema.Types.Mixed`, a getter/setter function) falls back to an
 * untyped field rather than guessing. */
function mongooseTypeRefToJsonSchema(expr: Node): JSONSchema {
  if (Node.isArrayLiteralExpression(expr)) {
    const [item] = expr.getElements();
    return item ? { type: "array", items: mongooseFieldValueToJsonSchema(item).schema } : { type: "array" };
  }
  const text = expr.getText();
  if (/\bObjectId\b/.test(text)) return { type: "string" };
  switch (text) {
    case "String":
      return { type: "string" };
    case "Number":
      return { type: "number" };
    case "Boolean":
      return { type: "boolean" };
    case "Date":
      return { type: "string", format: "date-time" };
    case "Buffer":
      return { type: "string", format: "binary" };
    default:
      return {};
  }
}

/** Converts one schema-shape object literal (`{ field: String, other: {
 * type: Number, required: true }, nested: { city: String } }`) into JSON
 * Schema — the single recursive step both the top-level schema and any
 * nested subdocument share. A property's value is one of: a full field
 * definition (an object literal that itself has a `type` key), a bare
 * type reference (identifier/array/property-access), or — when the object
 * literal has no `type` key at all — a nested subdocument, recursed into
 * as its own schema shape. */
function mongooseSchemaShapeToJsonSchema(shape: Node): JSONSchema {
  if (!Node.isObjectLiteralExpression(shape)) return { type: "object" };
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  for (const prop of shape.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;
    const key = prop.getName();
    const valueExpr = prop.getInitializer();
    if (!valueExpr) continue;
    const field = mongooseFieldValueToJsonSchema(valueExpr);
    properties[key] = field.schema;
    if (field.required) required.push(key);
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

function mongooseFieldValueToJsonSchema(valueExpr: Node): { schema: JSONSchema; required: boolean } {
  if (Node.isObjectLiteralExpression(valueExpr)) {
    const typeProp = valueExpr.getProperty("type");
    if (!typeProp || !Node.isPropertyAssignment(typeProp)) {
      // No "type" key at all -> a nested subdocument, not a field definition.
      return { schema: mongooseSchemaShapeToJsonSchema(valueExpr), required: false };
    }
    const typeExpr = typeProp.getInitializer();
    const schema = typeExpr ? mongooseTypeRefToJsonSchema(typeExpr) : {};

    const enumProp = valueExpr.getProperty("enum");
    if (enumProp && Node.isPropertyAssignment(enumProp)) {
      const enumInit = enumProp.getInitializer();
      if (enumInit && Node.isArrayLiteralExpression(enumInit)) {
        const values = enumInit
          .getElements()
          .filter(Node.isStringLiteral)
          .map((el) => el.getLiteralValue());
        if (values.length > 0) schema.enum = values;
      }
    }

    const requiredProp = valueExpr.getProperty("required");
    let required = false;
    if (requiredProp && Node.isPropertyAssignment(requiredProp)) {
      const requiredInit = requiredProp.getInitializer();
      if (requiredInit) {
        // `required: true` or `required: [true, "message"]` (Mongoose's
        // own "required with a custom message" shorthand) — either way,
        // only the leading boolean literal matters here.
        const boolNode = Node.isArrayLiteralExpression(requiredInit) ? requiredInit.getElements()[0] : requiredInit;
        required = boolNode?.getKind() === SyntaxKind.TrueKeyword;
      }
    }
    return { schema, required };
  }
  return { schema: mongooseTypeRefToJsonSchema(valueExpr), required: false };
}

/** Resolves a model identifier (`customerModel` in `import customerModel
 * from "../models/customerModel.js"`) back to the Mongoose schema shape it
 * was declared with — `const customerModel = mongoose.model("customer",
 * customerSchema)`, then one further hop if the schema itself was
 * assigned to its own variable first (`const customerSchema =
 * mongoose.Schema({...})`) rather than passed inline. Returns null at any
 * unresolved step (an unrecognized export/declaration style, a model
 * defined via a factory function, ...) rather than guessing. */
function resolveMongooseModelSchemaShape(modelIdentifier: Node): Node | null {
  const modelInit = resolveIdentifierDeclarationInitializer(modelIdentifier);
  if (!modelInit || !Node.isCallExpression(modelInit)) return null;
  if (calleeName(modelInit) !== "model") return null;
  const [, schemaArg] = modelInit.getArguments();
  if (!schemaArg) return null;

  const inlineShape = schemaCallShapeArgument(schemaArg);
  if (inlineShape) return inlineShape;

  const resolvedSchemaExpr = resolveIdentifierDeclarationInitializer(schemaArg);
  return resolvedSchemaExpr ? schemaCallShapeArgument(resolvedSchemaExpr) : null;
}

/** Resolves the last argument of a route registration (the handler) to the
 * function body this pass actually searches — following one cross-file
 * hop when the handler is a bare identifier imported from a controller
 * file (`import { addCustomer } from "../controllers/customerController.js"`,
 * `router.post("/add", addCustomer)` — the dominant real-world convention,
 * routes referencing named controller exports rather than inlining
 * handlers), then unwrapping exactly one layer of HOC-wrapping
 * (`expressAsyncHandler(async (req, res) => {...})`,
 * `express-async-handler`'s own convention and others like it) to reach
 * the actual function body. */
function resolveHandlerFunctionBody(handlerExpr: Node): Node | null {
  let target: Node | null = handlerExpr;
  if (Node.isIdentifier(handlerExpr)) {
    target = resolveIdentifierDeclarationInitializer(handlerExpr);
  }
  if (target && Node.isCallExpression(target)) {
    const inner = target.getArguments().find((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a));
    if (inner) target = inner;
  }
  return target && (Node.isArrowFunction(target) || Node.isFunctionExpression(target)) ? target : null;
}

/** Convention 1 — a call anywhere in the handler body passing `req.body`
 * straight into a recognized Mongoose write method, on a receiver that
 * resolves to an actual Mongoose model. */
function findDirectPassthroughSchema(handlerBody: Node): JSONSchema | null {
  for (const call of handlerBody.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const args = call.getArguments();
    if (Node.isPropertyAccessExpression(expr) && MONGOOSE_DIRECT_WRITE_METHODS.has(expr.getName())) {
      const bodyArg = expr.getName() === "create" ? args[0] : args[1];
      if (!bodyArg || !isReqBodyExpression(bodyArg)) continue;
      const shape = Node.isIdentifier(expr.getExpression()) ? resolveMongooseModelSchemaShape(expr.getExpression()) : null;
      if (shape) return mongooseSchemaShapeToJsonSchema(shape);
    }
  }
  for (const newExpr of handlerBody.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const callee = newExpr.getExpression();
    const [arg] = newExpr.getArguments();
    if (!arg || !isReqBodyExpression(arg) || !Node.isIdentifier(callee)) continue;
    const shape = resolveMongooseModelSchemaShape(callee);
    if (shape) return mongooseSchemaShapeToJsonSchema(shape);
  }
  return null;
}

/** Convention 2 — `const { a, b } = req.body;` plus some other
 * model-resolving identifier called anywhere in the same handler,
 * restricting the model's full schema down to just the destructured
 * field names. */
function findDestructuredCrossReferencedSchema(handlerBody: Node): JSONSchema | null {
  let destructuredNames: string[] | null = null;
  for (const stmt of handlerBody.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const nameNode = stmt.getNameNode();
    const init = stmt.getInitializer();
    if (init && isReqBodyExpression(init) && Node.isObjectBindingPattern(nameNode)) {
      destructuredNames = nameNode.getElements().map((el) => (el.getPropertyNameNode() ?? el.getNameNode()).getText());
      break;
    }
  }
  if (!destructuredNames || destructuredNames.length === 0) return null;

  for (const call of handlerBody.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr) || !Node.isIdentifier(expr.getExpression())) continue;
    const shape = resolveMongooseModelSchemaShape(expr.getExpression());
    if (!shape) continue;
    const fullSchema = mongooseSchemaShapeToJsonSchema(shape);
    const fullProperties = (fullSchema.properties as Record<string, JSONSchema> | undefined) ?? {};
    const fullRequired = new Set((fullSchema.required as string[] | undefined) ?? []);
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];
    for (const name of destructuredNames) {
      properties[name] = fullProperties[name] ?? { type: "string" };
      if (fullRequired.has(name)) required.push(name);
    }
    return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
  }
  return null;
}

/** Finds a request-body schema inferred from a Mongoose model, when the
 * Zod path above found nothing — see the two conventions documented
 * above. Never throws, never guesses; null when neither matches. */
export function findMongooseRequestSchemaForRoute(call: CallExpression): JSONSchema | null {
  const handler = call.getArguments().at(-1);
  if (!handler) return null;
  const handlerBody = resolveHandlerFunctionBody(handler);
  if (!handlerBody) return null;
  return findDirectPassthroughSchema(handlerBody) ?? findDestructuredCrossReferencedSchema(handlerBody);
}

/** Shared by `extractSummary`/`extractExplicitGroup` below — the leading
 * JSDoc/comment above a route registration statement, stripped of comment
 * syntax (`/** */`, `//`, leading ` * `), or null if there isn't one. */
function getCleanedLeadingComment(call: CallExpression): string | null {
  const statement = call.getParentIfKind(SyntaxKind.ExpressionStatement) ?? call;
  const ranges = statement.getLeadingCommentRanges();
  if (ranges.length === 0) return null;
  const text = ranges[ranges.length - 1]!.getText();
  const cleaned = text
    .replace(/^\/\*\*?|\*\/$/g, "")
    .replace(/^\/\/\s?/, "")
    .replace(/^\s*\*\s?/gm, "")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** A route's leading comment is often NOT written for Vayo at all — a
 * TODO, a workaround explanation, a lint-disable justification — and any
 * such comment could otherwise accidentally contain text that *looks* like
 * a `@group`/`@deprecated` tag ("routes moved out of the old @group of
 * helpers", "the @deprecated flag was removed from the validator") without
 * meaning to declare anything. Since those two tags carry real behavioral
 * weight (they lock the endpoint's folder placement / deprecation status
 * against being changed in the UI — docs/04-capture-engine.md Step 2
 * #4/#4a), misreading an unrelated comment as one of them would be a real,
 * silent correctness problem, not just a cosmetic one the way a wrong
 * `summary` guess would be.
 *
 * A bare `@vayo` line anywhere in the comment is the required opt-in
 * signal — the same role `@swagger`/`@openapi` play in swagger-jsdoc,
 * marking a comment block as deliberately written for API-doc annotation
 * rather than incidentally sitting above a route registration. Without it,
 * `@group`/`@deprecated` are never parsed, no matter what text appears —
 * they're just prose, exactly as if the tag characters weren't there at
 * all. This gate does NOT apply to the plain-text summary itself (see
 * `extractSummary`): a summary being "whatever the nearest comment says" is
 * the existing, zero-annotation-required M1 behavior and carries no
 * locking behavior, so there's nothing to guard there. */
function hasVayoDocSentinel(cleaned: string): boolean {
  return cleaned.split("\n").some((line) => /^@vayo\b/i.test(line.trim()));
}

/** JSDoc/leading-comment above a route registration statement, if any —
 * higher fidelity than nothing, never required (docs/04-capture-engine.md
 * Step 2 #6). Absent for the demo app on purpose: the M1 done-when bar
 * requires zero annotations in demo-app's own code. Strips out any
 * `@vayo`/`@group`/`@deprecated` tag lines (see `hasVayoDocSentinel`/
 * `extractExplicitGroup`/`extractDeprecated` below) — same
 * description-vs-structured-tags split swagger-jsdoc itself uses, so a tag
 * doesn't show up twice (once as this summary, once as its own structured
 * field). */
export function extractSummary(call: CallExpression): string | null {
  const cleaned = getCleanedLeadingComment(call);
  if (!cleaned) return null;
  const lines = cleaned.split("\n");
  const descriptionRange = findDescriptionBlockRange(lines);
  const withoutTags = lines
    .filter((line, i) => {
      if (/^@(vayo|group|deprecated|response|example|description)\b/i.test(line.trim())) return false;
      // A multi-line @description block's continuation lines don't start
      // with "@" themselves, so the filter above alone wouldn't catch them
      // — they'd otherwise leak into summary too, duplicating the text.
      if (descriptionRange && i > descriptionRange.start && i < descriptionRange.end) return false;
      return true;
    })
    .join("\n")
    .trim();
  return withoutTags.length > 0 ? withoutTags : null;
}

/** Line range (inclusive start, exclusive end) of a multi-line `@description`
 * block within a cleaned comment's lines — from the `@description` line
 * itself through the line before the next `@`-tag, or the comment's end.
 * Shared by `extractSummary` (to exclude the block's continuation lines,
 * which don't start with `@` and so wouldn't otherwise be filtered as tag
 * lines) and `extractDescription` (to capture it). */
function findDescriptionBlockRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => /^@description\b/i.test(line.trim()));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^@\w+/.test(lines[i]!.trim())) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Explicit `@description` tag in the same leading comment `extractSummary`
 * reads — OpenAPI's own standard Operation Object distinguishes a short
 * `summary` (one-liner) from a longer `description` (can be multiple
 * paragraphs, markdown-supported); Vayo's zero-annotation `summary`
 * extraction only ever produces the former. Unlike `@group`/`@deprecated`/
 * `@response`/`@example`, the tag's own text can continue across multiple
 * lines — everything from right after `@description` on its own line
 * through the line before the next recognized `@`-tag (or the comment's
 * end) is joined together, e.g.:
 * ```
 *  * @description
 *  * Returns the full order record including line items.
 *  * Use `include=customer` to also embed customer info.
 * ```
 * Only recognized inside a comment carrying the `@vayo` sentinel
 * (`hasVayoDocSentinel`) — same reasoning as every other structured tag
 * here: an incidental "see the @description field" sentence elsewhere
 * shouldn't silently become this endpoint's documented description. */
export function extractDescription(call: CallExpression): string | null {
  const cleaned = getCleanedLeadingComment(call);
  if (!cleaned || !hasVayoDocSentinel(cleaned)) return null;
  const lines = cleaned.split("\n");
  const range = findDescriptionBlockRange(lines);
  if (!range) return null;
  const firstLine = lines[range.start]!.trim().replace(/^@description\s*/i, "");
  const rest = lines.slice(range.start + 1, range.end).map((line) => line.trim());
  const combined = [firstLine, ...rest].join("\n").trim();
  return combined.length > 0 ? combined : null;
}

/** Explicit `@group <name>` tag in the same leading comment `extractSummary`
 * reads — swagger-jsdoc's own convention (e.g. `@group Orders - order
 * management`) for declaring a route's documentation grouping directly in
 * code, rather than leaving it to the `routes/` file-layout convention or a
 * guessed URL segment (docs/04-capture-engine.md Step 2 #4). A trailing
 * `- description` some tools also allow after the name is trimmed off,
 * since that's redundant with `extractSummary`'s own result. Nested groups
 * follow the same "/"-separated convention `inferGroup` uses, e.g.
 * `@group Admin/Users`. Only recognized inside a comment carrying the
 * `@vayo` sentinel (`hasVayoDocSentinel`) — otherwise this text is treated
 * as ordinary prose, never a declaration. */
export function extractExplicitGroup(call: CallExpression): string | null {
  const cleaned = getCleanedLeadingComment(call);
  if (!cleaned || !hasVayoDocSentinel(cleaned)) return null;
  for (const line of cleaned.split("\n")) {
    const match = line.trim().match(/^@group\s+([^-]+)/i);
    if (match) {
      const name = match[1]!.trim();
      return name.length > 0 ? name : null;
    }
  }
  return null;
}

/** Bare `@deprecated` tag in the same leading comment `extractSummary`
 * reads — the OpenAPI/swagger-jsdoc convention for marking a specific
 * route deprecated in code, independent of the whole API *version*'s own
 * lifecycle (`ApiVersionDoc.status`, `07-api-versioning.md`): a route can
 * be deprecated while the version it belongs to is still fully active.
 * Unlike `@group`, this tag carries no value of its own — its mere
 * presence is the signal, matching how `@deprecated` is used bare in both
 * conventions, so the whole line must be nothing else (a stray "the
 * @deprecated tag needs cleanup" TODO elsewhere in a legitimately
 * `@vayo`-tagged block still shouldn't flip this on). Only recognized
 * inside a comment carrying the `@vayo` sentinel — see
 * `extractExplicitGroup`'s own comment for why that gate exists at all. */
export function extractDeprecated(call: CallExpression): boolean {
  const cleaned = getCleanedLeadingComment(call);
  if (!cleaned || !hasVayoDocSentinel(cleaned)) return false;
  return cleaned.split("\n").some((line) => /^@deprecated$/i.test(line.trim()));
}

/** Explicit `@response <status> <SchemaName>` tag(s) in the same leading
 * comment `extractSummary` reads — declares a route's response body shape
 * for a given status code by pointing at an existing Zod schema identifier
 * (`findSchemaByName` above), the mirror of how `findRequestSchemaForRoute`
 * traces a *request* body from a Zod schema — just declared explicitly
 * rather than found at a fixed call-site convention, since there's no
 * equivalent "always the last argument to X" shape for a response the way
 * there is for request-validation middleware. One line per status code,
 * e.g. `@response 200 OrderSchema` / `@response 404 ErrorSchema` — multiple
 * lines declare multiple statuses. A name that doesn't resolve to a real
 * Zod schema anywhere in scope is silently skipped for that line, never
 * guessed. Only recognized inside a comment carrying the `@vayo` sentinel —
 * see `extractExplicitGroup`'s comment for why that gate exists at all. */
export function extractDeclaredResponseSchemas(call: CallExpression): Record<string, JSONSchema> {
  const cleaned = getCleanedLeadingComment(call);
  const result: Record<string, JSONSchema> = {};
  if (!cleaned || !hasVayoDocSentinel(cleaned)) return result;
  const sourceFile = call.getSourceFile();
  for (const line of cleaned.split("\n")) {
    const match = line.trim().match(/^@response\s+(\d{3})\s+([A-Za-z_$][\w$]*)\s*$/i);
    if (!match) continue;
    const [, status, name] = match;
    const schema = findSchemaByName(sourceFile, name!);
    if (schema) result[status!] = schema;
  }
  return result;
}

/** Explicit `@example <status> <JSON>` tag(s) in the same leading comment —
 * a literal example response value for a given status code, declared
 * directly in code rather than captured from real traffic or pinned by a
 * team member from Try It Now (docs/03-data-model.md `vayo_examples`).
 * One line per status code, e.g. `@example 200 {"id":"abc","total":42}` —
 * single-line JSON only (no multi-line objects), to keep parsing this out
 * of a free-text comment unambiguous. Invalid JSON on a matching line is
 * silently skipped for that line, never thrown — same "never guess" bar
 * every other tag here holds itself to. Only recognized inside a comment
 * carrying the `@vayo` sentinel. */
export function extractDeclaredExamples(call: CallExpression): Record<string, unknown> {
  const cleaned = getCleanedLeadingComment(call);
  const result: Record<string, unknown> = {};
  if (!cleaned || !hasVayoDocSentinel(cleaned)) return result;
  for (const line of cleaned.split("\n")) {
    const match = line.trim().match(/^@example\s+(\d{3})\s+(.+)$/i);
    if (!match) continue;
    const [, status, json] = match;
    try {
      result[status!] = JSON.parse(json!);
    } catch {
      // not valid JSON — skip rather than guess
    }
  }
  return result;
}

/**
 * Runs the static pass against a bootstrapped instance of the user's app.
 *
 * `config.appEntryPath` (resolved relative to `rootDir`) must be a module
 * loadable via dynamic `import()` that exports a already-configured Express
 * app — either `export default app` or `export const app`. It should be the
 * user's plain app (no Vayo middleware mounted), so express-list-endpoints
 * reports only the user's own routes/middleware — see apps/demo-app for the
 * create-app-vs-start-server split this implies.
 *
 * Async (unlike the synchronous signature sketched in
 * docs/08-packages-and-repo-structure.md) because bootstrapping a live app
 * instance is inherently a dynamic import — there's no way to do that
 * synchronously in an ESM-resolution world.
 */
export async function scanProject(rootDir: string, config: VayoConfig): Promise<StaticScanResult> {
  const entryAbsPath = path.resolve(rootDir, config.appEntryPath);
  const mod = (await import(pathToFileURL(entryAbsPath).href)) as { default?: unknown; app?: unknown };
  const app = unwrapApp(mod);
  if (!app) {
    throw new Error(
      `@vayo/ast: ${config.appEntryPath} must export a bootstrapped Express app as "export default app" or "export const app"`,
    );
  }

  const authPatterns = [...DEFAULT_AUTH_MIDDLEWARE_PATTERNS, ...(config.authMiddlewarePatterns ?? [])];
  const scopePatterns = [...DEFAULT_SCOPE_CHECK_PATTERNS, ...(config.scopeCheckPatterns ?? [])];
  const validationPatterns = [...DEFAULT_VALIDATION_MIDDLEWARE_PATTERNS, ...(config.validationMiddlewarePatterns ?? [])];

  const endpoints = expressListEndpoints(app as never);

  // Route registrations (and the scope-check/JSDoc calls inside them) live
  // wherever the user actually wrote `app.get(...)` — often not the entry
  // file itself, which may just import and call a `createApp()` factory
  // (as apps/demo-app does). Resolve the entry's own module graph so every
  // file it imports gets searched too, not just the entry file.
  //
  // `allowJs` is required, not optional, here — without it TypeScript's own
  // module resolution (which `resolveSourceFileDependencies` relies on)
  // silently refuses to follow imports into plain `.js` files, so a project
  // written in JavaScript rather than TypeScript would only ever see its
  // single entry file and nothing it imports. `vayo.config.js` itself (the
  // CLI's own config format) is plain JS specifically so it doesn't need a
  // TS loader — this has to work for a project written the same way.
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: false,
    compilerOptions: { allowJs: true },
  });
  project.addSourceFileAtPath(entryAbsPath);
  project.resolveSourceFileDependencies();
  const registrations = project.getSourceFiles().flatMap((sourceFile) => findRouteRegistrations(sourceFile));
  const mountPrefixByFilePath = buildMountPrefixMap(project);

  // Two-pass match per (method, runtime path): first the exact match once
  // each registration's own router-mount prefix (if any) is resolved and
  // joined on — this is what makes `express.Router()` composition resolve
  // correctly, including a router's own root path. Falls back to the
  // looser segment-suffix heuristic only when no registration resolves to
  // an exact match (an unrecognized composition style, e.g. re-exported or
  // indirectly-referenced routers `buildMountPrefixMap` couldn't trace).
  function findRegistration(method: string, runtimePath: string): RouteRegistration | undefined {
    const sameMethod = registrations.filter((r) => r.method === method);
    const exact = sameMethod.find((r) => {
      const prefix = mountPrefixByFilePath.get(r.call.getSourceFile().getFilePath()) ?? "";
      return joinMountedPath(prefix, r.pathTemplate) === runtimePath;
    });
    if (exact) return exact;
    const suffixMatches = sameMethod.filter((r) => pathSegmentsMatch(r.pathTemplate, runtimePath));
    suffixMatches.sort((a, b) => b.pathTemplate.length - a.pathTemplate.length);
    return suffixMatches[0];
  }

  const routes: StaticRouteResult[] = [];
  for (const endpoint of endpoints) {
    for (const method of endpoint.methods) {
      const registration = findRegistration(method, endpoint.path);
      // Static, per-method chain wins over express-list-endpoints' merged
      // (and, across differently-protected sibling methods, wrong) one —
      // see extractMiddlewareNames. Only falls back to the runtime-derived
      // chain when no registration was found at all (an unrecognized
      // composition style neither match strategy in findRegistration
      // above could trace).
      const middlewareChain = registration
        ? extractMiddlewareNames(registration.call)
        : endpoint.middlewares.filter((name) => name !== "anonymous");
      const authRequiredGuess = middlewareChain.some((name) =>
        authPatterns.some((pattern) => name === pattern || name.toLowerCase() === pattern.toLowerCase()),
      );
      const scopes = registration ? extractScopes(registration.call, scopePatterns) : [];
      const summary = registration ? extractSummary(registration.call) : null;
      const description = registration ? extractDescription(registration.call) : null;
      const explicitGroup = registration ? extractExplicitGroup(registration.call) : null;
      const group = explicitGroup ?? inferGroup(endpoint.path, registration?.call.getSourceFile().getFilePath() ?? entryAbsPath);
      const groupSource: "declared" | "inferred" = explicitGroup ? "declared" : "inferred";
      const deprecated = registration ? extractDeprecated(registration.call) : false;
      const zodRequestSchema = registration ? findRequestSchemaForRoute(registration.call, validationPatterns) : null;
      const mongooseRequestSchema = registration && !zodRequestSchema ? findMongooseRequestSchemaForRoute(registration.call) : null;
      const requestSchema = zodRequestSchema ?? mongooseRequestSchema;
      const requestSchemaSource = zodRequestSchema ? "declared" : mongooseRequestSchema ? "inferred" : null;
      const declaredResponseSchemas = registration ? extractDeclaredResponseSchemas(registration.call) : {};
      const declaredExamples = registration ? extractDeclaredExamples(registration.call) : {};
      routes.push({
        method,
        pathTemplate: endpoint.path,
        middlewareChain,
        authRequiredGuess,
        scopes,
        group,
        groupSource,
        summary,
        description,
        deprecated,
        requestSchema,
        requestSchemaSource,
        declaredResponseSchemas,
        declaredExamples,
      });
    }
  }

  return { routes };
}
