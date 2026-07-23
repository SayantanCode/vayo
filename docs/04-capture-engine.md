# 04 — Capture Engine

This is the core differentiator. Get this right before touching the UI.

## Libraries to adopt, not rebuild

| Need | Library | Why |
| --- | --- | --- |
| List all registered Express routes + their named middleware | `express-list-endpoints` | Mature (140+ dependents), gives `{ path, methods, middlewares }` per route in one call. `middlewares` includes function *names*, which is the input to auth-detection (§3 below). Run it once at app boot against the live `app` instance. |
| Infer/merge JSON Schema from real request/response samples | `genson-js` | `createSchema(sample)` and `mergeSchemas([...])` — exactly the "runtime capture → schema" mechanic. Pure JS, no native deps, works synchronously in a middleware without blocking the response. |
| Static AST analysis (types from Zod/TS interfaces, JSDoc summaries) | `ts-morph` | Higher-level, more ergonomic API over the TS compiler than raw `@babel/parser` for this use case since we're reading types, not just syntax. |
| OpenAPI 3.1 validation | `@apidevtools/swagger-parser` | Validates the compiled document is actually spec-valid before it's ever served — never ship an invalid spec, even internally. |
| Version-to-version diffing | *(none — custom)* | `oasdiff` looked like the obvious reuse here but is Go-only (binaries/Docker/Homebrew, no npm/WASM), so `@vayo/openapi-compiler` implements its own small `diffSpecs`, scoped to exactly the rules in `07-api-versioning.md` rather than a general-purpose diff engine. |

## Step 1 — Runtime capture (the middleware)

```typescript
// packages/capture-express/src/middleware.ts (contract, not final code)
export function capture(options: CaptureOptions): RequestHandler {
  return (req, res, next) => {
    const start = Date.now();
    const originalJson = res.json.bind(res);

    res.json = (body: unknown) => {
      queueMicrotask(() => recordSample(req, res, body, options)); // never block the response
      return originalJson(body);
    };

    next();
  };
}
```

Key decisions baked into `recordSample`:

1. **Path normalization.** Use `req.route.path` plus `req.baseUrl` to reconstruct
   the full template (`/api/users/:id`), not the raw URL. This is what makes
   `/api/users/64f1a2` and `/api/users/58ab90` collapse into one endpoint instead
   of two thousand.
2. **Non-blocking.** Schema inference happens in a microtask/next-tick after the
   response has already been sent. Capture must never add latency to the user's
   real API.
3. **Redaction before anything touches memory beyond the request handler.** See
   `05-security.md` §2 — this happens inside `recordSample`, before the sample
   ever reaches `genson-js` or the database.
4. **Write path:** `recordSample` calls into `@vayo/schema-engine`'s
   `mergeCapturedSample(existing, newSample)`, then upserts through
   `@vayo/db-mongo`. The middleware package itself never talks to MongoDB
   directly — only through the db-adapter package (keeps `capture-express`
   swappable/testable without a real database).
5. **Version tagging** (`07-api-versioning.md`). Every sample's normalized
   path template is run through `@vayo/schema-engine`'s `resolveVersion` to
   decide which `EndpointDoc.version` bucket it belongs to, against
   `db.listApiVersions()`'s configured `basePathPattern`s. `recordSample`
   already runs after the response is sent (point 2 above), so `await`ing
   that DB read here adds no latency to the real request; it's still
   cached in-process with a short TTL purely to reduce load on the
   database under real traffic, not because of any latency concern.

## Step 2 — Static pass (`vayo scan`, CLI-triggered, not per-request)

Run less frequently (on demand, or as a `postinstall`/CI step), against the
user's source tree:

1. Call `express-list-endpoints(app)` once against a bootstrapped instance of the
   user's app (`vayo scan`'s `appEntryPath`, from `vayo.config.js` — see
   `08-packages-and-repo-structure.md`'s `vayo` section). This is also
   what makes matching each *static* route registration (found separately via
   `ts-morph`, below) back to its runtime endpoint non-trivial: a real app
   almost always composes routes with `express.Router()` mounted via
   `app.use("/api/products", router)`, so the router's own registration
   (`router.get("/:id", ...)`) only ever contains its path *relative to
   wherever it gets mounted* — never the full path `express-list-endpoints`
   reports. `@vayo/ast` resolves this by tracing `X.use("/prefix", router)`
   calls across the project's module graph (default-exported router,
   imported and mounted by identifier — the common convention) and joining
   each registration's relative path onto its router's resolved prefix
   before matching; a looser segment-suffix match is the fallback for
   compositions it can't trace. Registrations found directly on `app` with a
   full literal path (no separate router file) keep matching by plain
   equality, unaffected.
   - The `ts-morph` `Project` that walks this module graph is constructed
     with `compilerOptions: { allowJs: true }` — without it, TypeScript's own
     module resolution silently refuses to follow imports into plain `.js`
     files, so a project written in JavaScript (not TypeScript — extremely
     common for real Express apps, and true of `vayo.config.js` itself)
     would only ever see its single entry file and nothing it imports.
2. For each route, its `middlewares` array gives named functions. Cross-reference
   against a configurable list of known auth-middleware name patterns
   (`authenticate`, `requireAuth`, `isLoggedIn`, `passport.authenticate`,
   `verifyToken`, plus user-supplied additions in `vayo.config.js`) to produce
   an **initial** `authRequired` guess before any traffic has been observed.
   - This chain is read from the *static registration's own arguments*
     (`router.post("/", requireAuth, handler)` → `["requireAuth"]`), not
     from `express-list-endpoints`' own `middlewares` field directly.
     `express-list-endpoints` (7.x) merges endpoints sharing a literal path
     across different HTTP methods by concatenating their `methods` arrays,
     but keeps only the *first-registered* method's middleware list for the
     merged entry — a public `GET "/"` registered before a protected
     `POST "/"` on the same path would otherwise make the protected POST
     silently inherit GET's empty chain. Reading it statically, per method,
     sidesteps that upstream behavior entirely.
3. Use `ts-morph` to open each route file, find the handler function, and if its
   request/response types are typed via Zod schemas or TS interfaces, extract a
   schema directly — this is higher-fidelity than runtime inference and should
   win when both exist (see merge precedence below).
4. Folder/mount-path convention infers `group` (`routes/orders/*.ts` →
   `"Orders"`, and `routes/admin/users/*.ts` → `"Admin/Users"` — every
   directory segment between `routes/` and the file itself becomes one
   level of the "/"-separated group path) unless a `route.group` override
   exists. An explicit `@group <name>` tag in the route's leading comment
   (swagger-jsdoc's own convention, e.g. `@group Orders` or a nested
   `@group Admin/Users`) wins outright over both this convention and the
   URL-segment fallback — `EndpointDoc.groupSource` records "declared" when
   this tag produced `group`, "inferred" otherwise. **Only recognized
   inside a comment that also carries a bare `@vayo` sentinel line** (see
   "Disambiguating a doc comment from an ordinary one" below) — a route's
   leading comment is often written for something else entirely (a TODO, a
   workaround note), and `@group`/`@deprecated` carry real behavioral
   weight, so an unrelated comment must never be misread as a declaration.
   `autoOrganizeFolders` (`@vayo/db-mongo`) turns a "/"-separated `group`
   into real nested sidebar folders, creating (or reusing) one folder per
   segment; a flat, single-segment group still resolves to exactly the one
   top-level folder it always did. A "declared" grouping is treated as
   authoritative: such an endpoint can be reordered among its current
   folder's own siblings via drag-and-drop, but a move to a different
   folder is refused — checked once, in `checkOverrideAllowed`
   (`packages/server/src/routes/overrides.ts`), and enforced at every
   write path that can set `folderId` (the dedicated `PATCH
   /api/endpoints/:vayoId/placement` route, the generic `POST
   /api/overrides` route, AND the Socket.IO `override:updated` event) —
   not just hidden in the sidebar UI (`FolderTree.tsx`'s
   `isBlockedGroupMove`), since a client-side-only guard, or a check on only
   ONE of several write paths, is not a real guarantee. The lock only ever
   applies once a placement already exists: a brand new "declared" endpoint
   `autoOrganizeFolders` hasn't placed anywhere yet has nothing to diverge
   from, so its very first placement always goes through. If the tag's
   VALUE later changes (e.g. `@group Admin/Users` renamed to `@group
   Admin/Customers`) after the endpoint was already placed, the lock would
   otherwise leave it stuck in the old folder forever — `autoOrganizeFolders`
   is the one place a "declared" endpoint's placement is allowed to
   self-heal: it re-places (only) a "declared" endpoint whose current
   folder no longer matches its current `group`, leaving its `order` (and
   everything else) untouched when the folder already matches. This is a
   deliberate, narrow exception to the "manual override always wins"
   philosophy every other field in this app follows; it applies only to
   folder placement, and only when the group came from an explicit tag —
   an inferred group (file convention or URL guess) stays fully
   drag-and-drop-able, same as before.
5. **Standard OpenAPI `tags`, not just `x-vayo-group`.** `group` also
   becomes a real, standard OpenAPI `tags: [group]` array on the operation
   (one tag, the full "/"-separated path as a single string — not one tag
   per segment, since a flat-tag renderer has no concept of nesting and
   two different "Users" groups under different parents would otherwise
   collide into one) plus a top-level `tags: [{name}, ...]` declaration
   listing every distinct group in first-appearance order
   (`@vayo/openapi-compiler`'s `buildDocument`/`buildOperation`). Without
   this, `x-vayo-group` alone would only ever group operations inside
   Vayo's own UI — the exported spec, opened in an actual third-party
   Swagger UI, Postman import, or Redoc, would show every operation in one
   flat, ungrouped list despite Vayo's own sidebar being organized by group
   the whole time. `EndpointDoc`/`vayo_folders` stay the source of truth;
   this is purely an output-side addition with no new stored field.

## Disambiguating a doc comment from an ordinary one

A route's leading comment is frequently NOT written for Vayo at all — a
TODO, a lint-disable justification, an explanation of a workaround — and
such a comment could easily contain text that *looks* like a tag without
meaning to declare anything ("routes moved out of the old `@group` of
helpers", "the `@deprecated` flag was removed from the validator", "see
`@response` docs for the old format"). `@group`/`@deprecated` carry real
behavioral weight (they lock an endpoint's folder placement / deprecation
status against being changed in the UI — #4/#4a above), so misreading an
unrelated comment as one of them would be a silent correctness problem, not
just a cosmetic wrong-guess the way an odd `summary` would be.
`@response`/`@example` (#4b) carry no such lock, but the same
misreading risk applies to them too — an incidental sentence mentioning
either word shouldn't silently overwrite a real, captured response
shape/example — so all four tags share the one gate.

A bare `@vayo` line anywhere in the comment is the required opt-in signal
— the same role `@swagger`/`@openapi` play in swagger-jsdoc, marking a
comment block as deliberately written for API-doc annotation rather than
incidentally sitting above a route registration. Without it, none of
`@group`/`@deprecated`/`@response`/`@example` are ever parsed, no matter
what text appears in the comment — they're just prose, exactly as if the
tag characters weren't there at all (`@vayo/ast`'s `hasVayoDocSentinel`).
This gate does **not** apply to the plain-text `summary` itself: a summary
being "whatever the nearest comment says" is the existing,
zero-annotation-required M1 behavior and carries no locking behavior, so
there's nothing to guard there — the `@vayo` line (like the four tags
above) is simply stripped out of the displayed summary text when present.

```js
/**
 * Fetch a single order by ID.
 * @vayo
 * @group Orders
 * @deprecated
 * @response 200 OrderSchema
 * @example 404 {"message": "Order not found"}
 */
router.get("/orders/:id", getOrder);
```

## Step 2 #3b — Mongoose model extraction (when there's no Zod schema to trace)

Runtime capture (Step 3 below) is the "always works, zero config" fallback,
but a project that hasn't sent any traffic through `capture()` yet, and
doesn't use Zod (or an equivalent) either, gets nothing from either source
— a common combination, since plenty of real Express APIs validate through
nothing more formal than their Mongoose model. When step 2 #3 above finds
no Zod schema, `@vayo/ast` tries one more static
convention before giving up: tracing the request body through a Mongoose
model. Two forms, tried in that order, both requiring the handler to
resolve to an actual function body first — following one cross-file hop
when the route registration references a named controller export rather
than an inline handler (`router.post("/add", addCustomer)` importing
`addCustomer` from a controller file — the dominant real-world convention),
then unwrapping one layer of HOC-wrapping (`expressAsyncHandler(async (req,
res) => {...})` and similar):

1. **Direct passthrough** — `Model.create(req.body)`, `new
   Model(req.body)`, `Model.findByIdAndUpdate(id, req.body)`,
   `Model.findOneAndUpdate(filter, req.body)`,
   `Model.updateOne(filter, req.body)`. The model identifier is resolved
   back to its `mongoose.model("name", schema)` declaration (following one
   further hop if the schema itself was assigned to its own variable
   first), and the schema's full field-type map — including nested
   subdocuments, arrays, `enum`, and `required`/`required: [true,
   "message"]` — becomes the request schema wholesale.
2. **Destructure-and-cross-reference** — `const { a, b } = req.body;`
   followed somewhere in the same handler by a call on an identifier that
   resolves to a Mongoose model (the very common "pull named fields off
   `req.body`, then build the doc from local variables a few lines later"
   style — the dominant convention in practice, more so than direct
   passthrough). The schema is restricted to exactly the destructured
   names, each one's type looked up from that model's own fields when the
   name matches, falling back to a generic string for a name the model
   doesn't declare (e.g. a request-only or computed field).

A handler that reshapes `req.body` any other way (spreads it into a new
object literal alongside extra fields, transforms values before storing
them, ...) matches neither convention and is left alone — arbitrary
data-flow analysis is out of scope here, same "detect a fixed convention,
never guess" bar the Zod path holds itself to.

Marked `requestSchemaSource: "inferred"` (`03-data-model.md`), one tier
below Zod's `"declared"`: a Mongoose schema describes the *stored
document*, not necessarily the exact accepted request shape — a POST might
only need a subset of fields, or the handler might stamp on server-only
ones (`businessOwner`, `isImported`, ...) the request never sent. The UI
surfaces this directly (DetailsTab's "Inferred, unconfirmed" badge on the
Request Body section) rather than presenting a guess with the same
confidence as an enforced validator or literally-observed traffic.

## Step 2 #4a — Explicit `@deprecated` tag (endpoint-level, not version-level)

A bare `@deprecated` tag in the same leading comment `@group`/summary read
sets `EndpointDoc.deprecated: true` (OpenAPI's own standard Operation
Object field, not an `x-vayo-*` extension) and `deprecatedSource:
"declared"` — independent of the whole API *version*'s own lifecycle
(`ApiVersionDoc.status`, `07-api-versioning.md`): a single route can be
deprecated while the version it belongs to is still fully active. Unlike
`group`, there's no inferred/guessed "probably deprecated" signal — the
tag's mere presence is the whole signal, so `deprecated` is simply `false`
and `deprecatedSource` is `null` whenever it's absent. Like `@group`, only
recognized inside a comment that also carries the `@vayo` sentinel line
(see "Disambiguating a doc comment from an ordinary one" above), and the
whole line must be nothing but `@deprecated` — a stray "the `@deprecated`
tag needs cleanup" TODO elsewhere in an otherwise legitimately
`@vayo`-tagged block still shouldn't flip this on.

A human can still flag ANY endpoint deprecated through the UI even when
the code hasn't said so (a normal override on `${vayoId}.deprecated`,
freely reversible like any other field) — but once `deprecatedSource` is
`"declared"`, the UI can't un-deprecate it. Checked once, in
`checkOverrideAllowed` (`packages/server/src/routes/overrides.ts`), and
enforced at every write path that can set `deprecated` (the dedicated
`PATCH /api/endpoints/:vayoId/deprecated` route, the generic `POST
/api/overrides` route, AND the Socket.IO `override:updated` event) — not
just a hidden UI toggle, the same narrow, deliberate exception to "manual
override always wins" that `groupSource: "declared"` already carves out
for folder placement, above. Re-declaring an already-`true` value (whether
code-declared or human-set) is treated as a no-op, not an error, since it
isn't actually contradicting anything.

## Step 2 #4b — Explicit `@response`/`@example` tags (per-status response documentation)

Two more tags recognized in the same `@vayo`-sentinel-gated leading comment,
each declaring something about a *response*, keyed by HTTP status code —
the one part of an endpoint's shape that, until now, only ever came from
runtime capture (no static convention for "guess the response shape" the
way Zod/Mongoose extraction covers the request body):

- **`@response <status> <SchemaName>`** points at an existing Zod schema
  identifier and merges its shape into `EndpointDoc.responseSchemas[status]`
  — the identifier is resolved in scope the same way a validation-middleware
  argument is (same-file `const`, a named ESM import, or a CommonJS
  destructured `require`), just located by the plain-text name in the
  comment rather than from an already-found call-site reference. One line
  per status code declares multiple statuses. A name that doesn't resolve
  to a real Zod schema anywhere in scope is silently skipped for that line
  — never guessed, same bar every other static-extraction convention in
  this doc holds itself to. The declared schema is *merged* into whatever
  was already at that status via the same genson-js union
  `mergeCapturedSample` itself uses (`mergeStaticResult`'s own
  `mergeDeclaredResponseSchemas`), deliberately not a flat overwrite unlike
  `requestSchema`'s own "static wins outright" rule immediately above: a
  response isn't enforced against the referenced Zod schema the way an
  incoming request is (Zod validates `req.body`, never what a handler sends
  back), so real traffic routinely reveals fields — a joined/computed
  property, an extra debug field — the schema never declared, and a flat
  overwrite on every rescan would silently erase exactly that
  traffic-learned shape each time the same tag gets re-read.
  `EndpointDoc.declaredResponseStatuses` records which status keys came
  from a tag at all, so the UI/spec consumers can tell "the code guarantees
  this shape" apart from "this is only ever what traffic happened to
  produce" — recomputed unconditionally on every scan, same as
  `deprecatedSource`: remove the tag, and the next scan drops that status
  back out of the list (though the `responseSchemas` value itself isn't
  cleared, since runtime capture may still legitimately hold one there).
- **`@example <status> <JSON>`** is a literal example response value for a
  given status — single-line JSON only (no multi-line objects), to keep
  parsing it out of a free-text comment unambiguous; invalid JSON on a
  matching line is silently skipped, never thrown. Stored in
  `EndpointDoc.declaredExamples`, recomputed unconditionally on every scan
  just like `declaredResponseStatuses` above. `openapi-compiler` compiles
  it straight into the response's own standard OpenAPI `examples` field
  (under the name `"declared"`) — not an `x-vayo-*` extension, since
  `examples` is itself part of the spec, so any OpenAPI-consuming tool sees
  it, not just Vayo's own UI. The Response panel (DetailsTab) prefers a
  real captured/pinned `ExampleDoc` first (actual traffic, highest
  confidence), then a declared example (code says this is what it looks
  like), and only falls back to a value synthesized from the schema alone
  (a guess) when neither exists yet.

Unlike `@group`/`@deprecated`, neither tag carries any UI-lock behavior —
`checkOverrideAllowed` never blocks editing a response schema or an
example through the docs UI, since these are purely descriptive content,
not an access-control or placement decision the code needs to stay
authoritative over.

## Step 2 #4c — Explicit `@description` tag (the longer counterpart to `summary`)

OpenAPI's own standard Operation Object has both a short `summary`
(one-liner) and a longer `description` (can be multiple paragraphs,
Markdown-supported) — Vayo's zero-annotation `summary` extraction only ever
produces the former (whatever plain text sits above the route, with no
structure to split it further). An explicit `@description` tag fills that
gap, in the same leading comment `summary`/`@group` read. Unlike every
other structured tag in this doc, its own text can continue across
multiple lines: everything from right after `@description` (inline text on
the same line is allowed too) through the line before the next recognized
`@`-tag, or the comment's end, is joined together:

```js
/**
 * Fetch a single order by ID.
 * @vayo
 * @description
 * Returns the full order record including line items.
 * Use `include=customer` to also embed customer info.
 * @group Orders
 */
router.get("/orders/:id", getOrder);
```

Only recognized inside a comment carrying the `@vayo` sentinel, same
reasoning as every other structured tag — an incidental "see the
`@description` field" sentence elsewhere in an unrelated comment shouldn't
silently become this endpoint's documented description. Purely descriptive
like `summary`: no "source" tracking, no UI lock, unconditionally
overwritten (or cleared to `null`) on every rescan, same as `summary`
itself. Compiles straight into the operation's own standard OpenAPI
`description` field (not an `x-vayo-*` extension).

## Step 3 — Merge precedence (static vs. runtime vs. override)

When `openapi-compiler` reads an `EndpointDoc`, precedence for any given field is:

```text
override (vayo_overrides)  >  static AST result  >  runtime-inferred result
```

Runtime inference is the *fallback that always exists* (works with zero config).
Static analysis *refines* it when available. Overrides *win* over both, always.
`authRequired` specifically merges with OR logic rather than override precedence
for the two non-manual sources: if either static middleware-detection or runtime
401-observation says "protected," treat it as protected until a human explicitly
overrides it — false positives (marking an open endpoint as protected) are far
less costly than false negatives (marking a protected endpoint as public) here,
so tilt the whole heuristic toward that side.

## Step 3a — Scope detection (auth granularity beyond "requires a token")

`authRequired`/`authType` answer "is a token needed." `scopes`
(`03-data-model.md`) answers the finer question a real team actually asks:
*which* permission does this endpoint need. Unlike `authRequired`, this is
**primarily static-detected, not runtime-inferred** — a 403 response tells you
"the caller lacked some permission," but not which one, so runtime capture
cannot reliably name a scope on its own.

The static pass (`vayo scan`) looks for calls to a configurable set of
scope-check function names against each route's middleware chain — e.g.
`requireScope("admin:read")`, `checkPermission(["customer:read"])`,
`authorize("employee:read")` — configurable in `vayo.config.js` the same way
auth-middleware patterns are (§2 above), since every team names this function
differently. Extracted scope literals are written to `EndpointDoc.scopes`
tagged `source: "static"`; runtime capture can still *confirm* a scope is
exercised (by correlating which scope a valid token carried on a successful
request) but never invents a scope name from nothing. If static detection
finds no scope-check call, `scopes` stays empty and an override is the only way
to add one — this is one of the few fields where "we found nothing" is treated
as "unknown," not "public," precisely because scopes can't be safely inferred
from runtime behavior the way `authRequired` can.

## Step 3b — Auth-type inference from runtime evidence

`authType` (`"bearer" | "apiKey" | "basic" | "cookie" | null`,
`03-data-model.md`) is override-only for three of its four values — nothing
in the static or runtime pass ever sets `"bearer"`/`"apiKey"`/`"basic"`
automatically, on purpose: the `Authorization` header's actual *value* is
never stored (`05-security.md` §2), and a bearer token vs. an API key vs.
HTTP Basic auth can't be told apart from presence alone.

`"cookie"` is the one exception, because it doesn't need the value at all —
just a second presence signal. `capture-express` tracks `Cookie` header
presence the identical way it already tracks `Authorization`
(`CapturedSample.requestHeaders.cookie`, boolean, never the cookie's own
name or contents). `schema-engine`'s `resolveAuthType` infers `"cookie"`
from one specific piece of evidence: a **successful** (2xx) response to a
request that carried a Cookie header but no Authorization header. A 401
proves nothing about which mechanism *would* have worked, only that
whichever one is required wasn't satisfied — so only 2xx samples count.
Same monotonic posture as `authRequired`: once any `authType` is known
(inferred or manually overridden), a later ambiguous sample never clears or
flips it.

The compiled spec's security scheme for `"cookie"` uses OpenAPI 3.1's own
documented way to express it — there's no dedicated "cookie auth" scheme
type, so `openapi-compiler` emits `{ type: "apiKey", in: "cookie", name:
"session" }`. The `name` is a generic placeholder (the real cookie's name
is never captured, same reasoning as never storing its value) — accurate
enough to be useful, a team should still correct it via read-through of
their own code if the exact name matters to them.

**Known limitation, stated plainly:** the docs UI's "Try It Now" tab cannot
actually exercise a cookie-authenticated endpoint today. Browsers forbid
JavaScript from ever setting a `Cookie` request header manually — it's a
"forbidden header name" in the Fetch spec, silently stripped, not even an
error — so this isn't unwritten code, it's a browser platform restriction
that a client-side `fetch()` can never work around. Testing a cookie-based
endpoint requires an external tool (curl, Postman) for now. Fixing this
properly would mean routing "Try It Now" requests through `@vayo/server`
itself as a proxy (the server, not the browser, makes the real outbound
request, so the `Cookie` header restriction doesn't apply) — a genuinely
separate feature, not a quick add-on, because an authenticated user's
ability to make the *server* issue arbitrary outbound requests is a classic
SSRF surface. It would need, at minimum: strict target-URL allowlisting
(only the active environment's configured `baseUrl`, never an arbitrary
host), response size/time caps, and audit logging of every proxied call —
scoped and reviewed as its own piece of work, not bundled into this one.

## Step 3d — Stale/phantom endpoint detection (`possiblyRemovedSince`)

A documented endpoint has never had a way to disappear on its own, even
after the route it describes is permanently removed from the user's real
API: `EndpointDoc` fields are all additive/OR-merge (constraint #3,
`00-README.md`), and the docs UI's delete route has only ever allowed
removing a `source: "manual"` placeholder — deleting a captured endpoint
would just have it reappear on the next scan or the next request, silently
undoing the delete. That left genuinely-removed routes with no cleanup
path at all, and a misleading error message ("remove the route in your
backend instead") that doesn't actually make the stale entry go away.

`EndpointDoc.possiblyRemovedSince` (`03-data-model.md`) closes this gap.
After `vayo scan` finishes merging every route it found in the current
pass, it calls `db.flagEndpointsNotInScan(version, confirmedVayoIds,
flaggedAt)` once per version it touched. That method sets
`possiblyRemovedSince: flaggedAt` on every endpoint in that version whose
`source` is `"static"` or `"merged"` (the only ones ever subject to static
confirmation in the first place — a purely `"runtime"`/`"manual"` endpoint
was never confirmed by a scan, so its absence from one means nothing) and
whose `vayoId` didn't appear in this scan's confirmed set — but only if it
isn't already flagged, so a second, still-negative rescan doesn't roll the
flagged-since date forward.

The flag clears itself automatically the moment either signal reappears:
`mergeStaticResult` clears it because being called at all means the
current scan just found the route again; `mergeCapturedSample` clears it
because real traffic hitting the endpoint is its own positive evidence.
Neither merge function needs to know *why* the flag was set — only that
finding the endpoint again is reason enough to clear it.

Once flagged, the "it'll just reappear" objection to deleting a captured
endpoint no longer holds, so the delete route (`05-security.md`) allows
removing it — same as a manual placeholder. The compiled spec carries the
flag as `x-vayo-possibly-removed-since` (one of `@vayo/openapi-compiler`'s
`x-vayo-*` extension constants) so the UI can show a "this route may no
longer exist" banner and unlock the Delete option in the sidebar without a
second round-trip.

## Step 4 — Middleware chain capture (one half of the Flowmap tab's data)

`express-list-endpoints` already returns each route's middleware functions **in
registration order** — this is captured once into `EndpointDoc.middlewareChain`
(`03-data-model.md`) during the static pass, no new capture mechanism required.
The Flowmap tab (`@vayo/ui`) renders this directly as a linear flow:

```text
Client request → rateLimiter → authenticate → validateBody → [handler] → response
```

This stays middleware-chain-only, sourced entirely from data already being
captured for other reasons — extending the AST pass to detect downstream
calls inside the handler itself (a DB query, a call to another internal
service) and add those as additional flowmap nodes is still a real
enhancement worth pursuing, not built here.

Flowmap's other half — **cross-endpoint journeys** ("signup, then fetch
profile") — was originally scoped as a from-scratch, inference-based
feature and deferred past v1 for that reason. It shipped anyway, by reusing
data that already exists for a different reason: `FlowDoc`/`FlowStep`
(`03-data-model.md`), the user-authored, ordered endpoint sequences that
back the Flows panel's Postman-Collection-Runner-style request runner.
Flowmap now shows which saved Flows a given endpoint participates in and
highlights its position in each — no separate inference mechanism, no new
collection, just a second read of data a human already had a reason to
create.

## What "done" looks like for this package before touching the UI

Run the CLI against a real Express app for a day of normal traffic, then dump
`vayo_endpoints` to JSON. A senior engineer glancing at that dump should be
able to say "yes, this matches what the API actually does" without having
written a single comment. That's the milestone gate in `09-roadmap.md` M1.
