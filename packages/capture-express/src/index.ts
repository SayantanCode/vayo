// @vayo/capture-express
// The ONLY Vayo package allowed to import express types. See
// docs/04-capture-engine.md Step 1 and docs/05-security.md §2.

import type { Request, RequestHandler, Response } from "express";
import type { CapturedSample, VayoDbAdapter } from "@vayo/types";
import { resolveVersion } from "@vayo/schema-engine";

/** Default redaction deny-list — docs/05-security.md §2. Additive via
 * CaptureOptions.redact, never replaced. */
export const DEFAULT_REDACT_PATTERNS: RegExp[] = [
  /password/i,
  /token/i,
  /secret/i,
  /api[-_ ]?key/i,
  /ssn/i,
  /credit ?card/i,
  /cvv/i,
  /authorization/i,
];

export interface CaptureOptions {
  db: VayoDbAdapter;
  redact?: string[];
  authMiddlewarePatterns?: string[];
  authMiddleware?: (req: Request) => boolean;
}

/** Recursively redacts values whose KEY matches any pattern. Keeps the key
 * and infers-a-type-friendly placeholder so schema inference still records
 * "there's a password: string" without storing the real value. The optional
 * `state` object is flipped to `redacted: true` the moment any field is
 * scrubbed — `vayo_examples.redacted` (docs/05-security.md §2: "shown as a
 * visible badge, never silently presented as complete") reads this. */
export function redact(value: unknown, patterns: RegExp[], state?: { redacted: boolean }): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, patterns, state));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (patterns.some((p) => p.test(key))) {
      out[key] = "[REDACTED]";
      if (state) state.redacted = true;
    } else {
      out[key] = redact(v, patterns, state);
    }
  }
  return out;
}

/** Path normalization (docs/04-capture-engine.md Step 1 #1): use
 * `req.route.path` + `req.baseUrl` to reconstruct the full template
 * ("/api/users/:id"), not the raw URL — this is what collapses
 * `/api/users/64f1a2` and `/api/users/58ab90` into one endpoint. Returns
 * null when the route didn't actually match (e.g. a 404) — there's no
 * stable template to attribute an unmatched request to.
 *
 * A route registered at an `express.Router()`'s own root
 * (`router.get("/", ...)`, mounted via `app.use("/api/widgets", router)`)
 * has `req.route.path === "/"`, so the naive concatenation produces
 * `/api/widgets/` — a spurious trailing slash that never matches the same
 * endpoint's real path anywhere else (the static AST pass's own
 * mount-prefix resolution, `@vayo/ast`'s `joinMountedPath`, hits this exact
 * case and special-cases it the same way). Only ever strips *one* trailing
 * slash and never touches the literal root path `"/"` itself. */
export function buildPathTemplate(req: Request): string | null {
  const routePath = req.route?.path;
  if (!routePath || typeof routePath !== "string") return null;
  const full = `${req.baseUrl}${routePath}`.replace(/\/{2,}/g, "/");
  if (full.length === 0) return "/";
  return full.length > 1 && full.endsWith("/") ? full.slice(0, -1) : full;
}

/** In-memory cache of `vayo_api_versions`, refreshed at most every
 * `VERSION_CACHE_TTL_MS` — not a latency concern (`recordSample` already
 * runs in a `queueMicrotask` after the real response was sent, so even an
 * uncached `await` here wouldn't slow the target app down), purely to
 * avoid hitting the DB on every single captured request. Keyed per `db`
 * instance so tests/multiple adapters don't share stale state. */
const versionCache = new WeakMap<VayoDbAdapter, { versions: Array<{ version: string; basePathPattern: string }>; fetchedAt: number }>();
const VERSION_CACHE_TTL_MS = 30_000;

async function getConfiguredVersions(db: VayoDbAdapter): Promise<Array<{ version: string; basePathPattern: string }>> {
  const cached = versionCache.get(db);
  if (cached && Date.now() - cached.fetchedAt < VERSION_CACHE_TTL_MS) return cached.versions;

  const docs = await db.listApiVersions();
  const versions = docs.map((d) => ({ version: d.version, basePathPattern: d.basePathPattern }));
  versionCache.set(db, { versions, fetchedAt: Date.now() });
  return versions;
}

/** Named functions registered for this specific route, in registration
 * order — Express attaches them to `req.route.stack`. This is a real,
 * zero-config runtime signal for `middlewareChain` (docs/03-data-model.md)
 * in addition to the AST static pass's own capture of the same data
 * (docs/04-capture-engine.md Step 4). Mirrors `express-list-endpoints`'s own
 * convention: anonymous handlers are dropped (nothing useful to show), but
 * no attempt is made to guess which named entry is "the" handler vs.
 * middleware — a named route handler will legitimately show up here too,
 * same as it would from a static `express-list-endpoints` scan. */
function extractMiddlewareChain(req: Request): string[] {
  const stack = (req.route as { stack?: Array<{ name?: string }> } | undefined)?.stack ?? [];
  return stack.map((layer) => layer.name).filter((name): name is string => Boolean(name) && name !== "<anonymous>");
}

/** A multer-populated file, duck-typed rather than importing `multer` as a
 * dependency just for its type — every multer file object carries at least
 * a `fieldname`, regardless of storage engine (disk/memory) or version. */
interface MulterFileLike {
  fieldname?: string;
}

/** Field names of any uploaded files on this request (multer's `req.file`
 * for `.single()`, `req.files` as an array for `.array()`/`.any()`, or as a
 * `{ [field]: File[] }` map for `.fields()`). multer strips these out of
 * `req.body` entirely — without this, a file-upload endpoint's file fields
 * never show up in the documented request body at all. */
export function extractFileFieldNames(req: Request): string[] {
  const names = new Set<string>();
  const single = (req as unknown as { file?: MulterFileLike }).file;
  if (single?.fieldname) names.add(single.fieldname);

  const files = (req as unknown as { files?: unknown }).files;
  if (Array.isArray(files)) {
    for (const file of files as MulterFileLike[]) {
      if (file?.fieldname) names.add(file.fieldname);
    }
  } else if (files && typeof files === "object") {
    for (const field of Object.keys(files as Record<string, unknown>)) names.add(field);
  }
  return [...names];
}

/** Merges synthesized placeholder values for uploaded files into the
 * captured body, so schema inference sees a flat object with every field —
 * text and file alike — rather than silently omitting the file fields multer
 * already removed from `req.body`. The placeholder is a plain string
 * (`schema-engine` marks these keys `format: "binary"` afterward using
 * `requestBodyFileFields`, rather than this package guessing at OpenAPI
 * semantics itself). */
export function mergeFileFieldPlaceholders(body: unknown, fileFields: string[]): unknown {
  if (fileFields.length === 0) return body;
  const base = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const merged = { ...base };
  for (const field of fileFields) merged[field] = "[binary file]";
  return merged;
}

/** Best-effort recovery of a JSON value from a raw `res.end(chunk)` call —
 * some real handlers build the JSON string by hand (e.g.
 * `res.end(JSON.stringify(body))`) instead of calling `res.json`, which
 * would otherwise mean the response schema never gets recorded at all. Falls
 * back to the raw string (still a valid, if less precise, sample) rather
 * than guessing further. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function recordSample(
  req: Request,
  res: Response,
  body: unknown,
  options: CaptureOptions,
  redactPatterns: RegExp[],
): Promise<void> {
  try {
    const pathTemplate = buildPathTemplate(req);
    if (!pathTemplate) return; // unmatched route — nothing stable to attribute this to

    const configuredVersions = await getConfiguredVersions(options.db);
    const fileFields = extractFileFieldNames(req);
    const bodyWithFiles = mergeFileFieldPlaceholders(req.body, fileFields);
    const redactionState = { redacted: false };
    const capturedAt = new Date().toISOString();

    const requestBody = bodyWithFiles !== undefined ? (redact(bodyWithFiles, redactPatterns, redactionState) as unknown) : null;
    const responseBody = body !== undefined ? (redact(body, redactPatterns, redactionState) as unknown) : null;

    const sample: CapturedSample = {
      method: req.method,
      pathTemplate,
      version: resolveVersion(pathTemplate, configuredVersions),
      // docs/05-security.md §2: never store the Authorization header's (or
      // any header's) actual value, only whether one was present. `cookie`
      // is what lets schema-engine's authType inference recognize
      // session-cookie auth (docs/04-capture-engine.md) as distinct from
      // bearer/apiKey — never the cookie's own name or value, just presence.
      requestHeaders: {
        authorization: Boolean(req.headers.authorization),
        cookie: Boolean(req.headers.cookie),
      },
      requestParams: redact(req.params ?? {}, redactPatterns) as Record<string, unknown>,
      requestQuery: redact(req.query ?? {}, redactPatterns) as Record<string, unknown>,
      requestBody,
      ...(fileFields.length > 0 ? { requestBodyFileFields: fileFields } : {}),
      responseStatus: res.statusCode,
      responseBody,
      middlewareNames: extractMiddlewareChain(req),
      capturedAt,
    };

    const vayoId = await options.db.upsertEndpoint(sample).then((doc) => doc.vayoId);

    // docs/03-data-model.md vayo_examples: "rolling window of real
    // request/response pairs per endpoint" — db-mongo's own appendExample
    // enforces the N=5-most-recent-per-status cap, so every sample can be
    // appended here without unbounded growth.
    await options.db.appendExample({
      vayoId,
      statusCode: res.statusCode,
      requestBody,
      responseBody,
      capturedAt,
      redacted: redactionState.redacted,
      pinned: false,
      label: null,
    });
  } catch (err) {
    // Capture must never crash or add latency/errors to the user's real
    // API — log and move on (docs/04-capture-engine.md Step 1 #2).
    console.error("[vayo/capture-express] failed to record sample:", err instanceof Error ? err.message : err);
  }
}

/**
 * Express middleware that captures real traffic into Vayo's schema
 * inference pipeline. Wraps `res.json`/`res.send`/`res.end` so the real
 * response is never delayed — recording happens in a microtask after the
 * response has already been written (docs/04-capture-engine.md Step 1 #2).
 *
 * `res.end` is wrapped too, not just `.json`/`.send` — real handlers often
 * respond without ever calling either: `res.redirect()`, a bare
 * `res.status(204).end()`, or a hand-built `res.end(JSON.stringify(body))`.
 * `.json`/`.send` both call `this.end(...)` internally, so `captureOnce`'s
 * guard (not the wrapping order) is what keeps a single response from being
 * recorded twice regardless of which of the three the handler called.
 */
/** Pure decision logic, split out from `warnIfUnsupportedExpressVersion` so
 * it's unit-testable without mocking Node's module resolution (a raw
 * `require()` call bypasses Vitest's usual `vi.mock` interception). Returns
 * the warning message, or null when the installed version is fine. */
export function unsupportedExpressVersionWarning(installedVersion: string): string | null {
  const major = Number(installedVersion.split(".")[0]);
  if (major === 4) return null;
  return (
    `vayo: @vayo/capture-express expects Express 4.x ("express": "^4.19.0") but found Express ${installedVersion} installed. ` +
    "Express 5 changed router internals (path matching, middleware stack shape) this package hasn't been verified against " +
    "— captured route paths or middleware chains may be wrong or missing. Install express@^4.19.0."
  );
}

/** This package only imports Express's TYPES, never its runtime module — the
 * actual Express instance belongs to the consuming app, not this package. So
 * this is the one place that looks at what's really installed:
 * `require("express/package.json")` resolves from capture-express's own
 * location up through the consumer's node_modules, the same as any other
 * Node module resolution, and reliably finds whichever Express the host app
 * actually has. Worth checking explicitly rather than leaving it to `npm`'s
 * peer-dependency warning (routinely skipped with `--force`/
 * `--legacy-peer-deps`) because getting this wrong doesn't fail loudly — it
 * fails as silently wrong route paths or a missing middleware chain deep
 * inside capture, which is a much worse debugging experience than one clear
 * message at startup. A warning, not a thrown error: some Express 5 apps may
 * partially work, and refusing to run at all over an unverified peer would
 * be worse than the risk it's guarding against. */
function warnIfUnsupportedExpressVersion(): void {
  try {
    const { version } = require("express/package.json") as { version: string };
    const message = unsupportedExpressVersionWarning(version);
    if (message) console.warn(message);
  } catch {
    // Can't resolve express/package.json (unusual install layout) — not this
    // package's job to enforce project structure, so skip the check silently.
  }
}

export function capture(options: CaptureOptions): RequestHandler {
  warnIfUnsupportedExpressVersion();
  const redactPatterns = [
    ...DEFAULT_REDACT_PATTERNS,
    ...(options.redact ?? []).map((pattern) => new RegExp(pattern, "i")),
  ];

  return (req: Request, res: Response, next) => {
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    const originalEnd = res.end.bind(res);
    let captured = false;

    const captureOnce = (body: unknown) => {
      if (captured) return;
      captured = true;
      queueMicrotask(() => void recordSample(req, res, body, options, redactPatterns));
    };

    res.json = ((body?: unknown) => {
      captureOnce(body);
      return originalJson(body);
    }) as typeof res.json;

    res.send = ((body?: unknown) => {
      captureOnce(body);
      return originalSend(body as Parameters<typeof originalSend>[0]);
    }) as typeof res.send;

    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      // Only a plain string/Buffer chunk is meaningfully capturable — a
      // Buffer (binary payload) is left as `undefined` (no body recorded,
      // status/method/path still are) rather than dumping raw bytes.
      const body = typeof chunk === "string" ? tryParseJson(chunk) : undefined;
      captureOnce(body);
      return (originalEnd as (...args: unknown[]) => Response)(chunk, ...rest);
    }) as typeof res.end;

    next();
  };
}
