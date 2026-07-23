# 08 — Packages & Repo Structure

## Monorepo layout

```text
vayo/
├── pnpm-workspace.yaml
├── package.json                 (root — shared devDependencies, scripts)
├── tsconfig.base.json
├── docs/                        (this documentation set)
├── packages/
│   ├── shared-types/            @vayo/types
│   ├── capture-express/         @vayo/capture-express
│   ├── ast/                     @vayo/ast
│   ├── schema-engine/           @vayo/schema-engine
│   ├── openapi-compiler/        @vayo/openapi-compiler
│   ├── db-mongo/                @vayo/db-mongo
│   ├── server/                  @vayo/server
│   ├── ui/                      @vayo/ui
│   └── cli/                     vayo
└── apps/
    └── demo-app/                 example Express app for local end-to-end dev
```

pnpm workspaces + TypeScript project references (`tsconfig.base.json` +
per-package `tsconfig.json` with `references`) handle build ordering. No
Turborepo/Nx for v1 — revisit once build time or contributor count justifies it.

## `@vayo/types`

Pure type-only package. No runtime code. Exports every interface defined in
`03-data-model.md` (`CapturedSample`, `EndpointDoc`, `OverrideDoc`, etc.) plus
the `ResolvedEndpoint` and `ResolvedSpec` shapes. Every other package depends on
this one; it depends on nothing.

## `@vayo/capture-express`

```typescript
export function capture(options: CaptureOptions): express.RequestHandler;

interface CaptureOptions {
  db: VayoDbAdapter;              // from @vayo/db-mongo
  redact?: string[];                 // additive to default deny-list, 05-security.md §2
  authMiddlewarePatterns?: string[]; // additive to default list, 04-capture-engine.md §2
  authMiddleware?: (req: Request) => AuthResult; // delegated docs-viewer auth, 05-security.md §5
}
```

The **only** package allowed to import Express types. Emits `CapturedSample`
(from `@vayo/types`) and hands it to `@vayo/schema-engine` — never talks
to MongoDB directly, only through the `VayoDbAdapter` interface, so it stays
unit-testable without a real database.

`peerDependencies` pins `express: "^4.19.0"` — v1 targets Express 4 only
(`00-README.md` constraint 5), and this is enforced, not just declared: a
bare `npm install express` in a fresh project resolves to Express 5 today,
which this peer range rejects. Consumers must install `express@^4` explicitly.
Not a bug to fix here — a deliberate v1 scope boundary that needs to be
stated plainly in end-user setup docs, since it's the kind of thing that
only surfaces once someone installs for real. The specific reason it's
Express-4-only, not just an unverified guess: `@vayo/ast`'s
`express-list-endpoints` dependency has its own test suite pinned to
Express 4 with no Express 5 coverage, and Express 5 rewrote router
internals (path-to-regexp version, wildcard route syntax, `Layer` shape) —
exactly the kind of internal `express-list-endpoints` and this package's own
`extractMiddlewareChain` (`req.route.stack`) both read directly.

`peerDependencies` alone only produces an `npm`-level warning that's
routinely skipped with `--force`/`--legacy-peer-deps`, so `capture()` also
checks the actually-installed Express version at call time
(`unsupportedExpressVersionWarning`, resolved via
`require("express/package.json")` — this package only imports Express's
*types*, so this is the one place it looks at what's really installed) and
logs a `console.warn` naming both versions if it's not 4.x. A warning, not a
thrown error — some Express 5 apps might partially work, and refusing to
run at all over an unverified peer would be worse than the risk it guards
against.

## `@vayo/ast`

```typescript
export function scanProject(rootDir: string, config: VayoConfig): StaticScanResult;
```

Wraps `ts-morph` + `express-list-endpoints`. Framework-specific bootstrapping
(how to get a live `app` instance to introspect) is isolated to a small adapter
the CLI generates per project — the AST logic itself doesn't assume Express
beyond that one adapter boundary, so a future Fastify AST adapter is a small
addition, not a rewrite.

## `@vayo/schema-engine`

```typescript
export function mergeCapturedSample(existing: EndpointDoc | null, sample: CapturedSample): EndpointDoc;
export function resolveEndpoint(endpoint: EndpointDoc, overrides: OverrideDoc[]): ResolvedEndpoint;
```

Wraps `genson-js` for schema inference/merging. Framework-agnostic — consumes
only `@vayo/types` shapes. `resolveEndpoint` is the pure merge function
described in `03-data-model.md` — no side effects, no I/O, exhaustively unit
tested with fixtures before anything else in the system depends on it.

## `@vayo/openapi-compiler`

```typescript
export function compile(endpoints: ResolvedEndpoint[], version: string, options?: CompileOptions): OpenAPIDocument;
export function validate(doc: OpenAPIDocument): ValidationResult; // via @apidevtools/swagger-parser
```

Produces the `x-vayo-*`-annotated OpenAPI 3.1 document described in
`02-architecture.md`. Never emits an unvalidated document — `compile()` calls
`validate()` internally and throws on failure rather than silently serving a
broken spec. `options` (all fields optional, omitting it entirely reproduces
the original default behavior) sources `info.title`/`info.description`/
`servers` from `vayo_settings`/`vayo_environments` — see `03-data-model.md`
"`vayo_settings`".

## `@vayo/db-mongo`

```typescript
export function createAdapter(mongoUri: string): VayoDbAdapter;
export function runMigrations(adapter: VayoDbAdapter): Promise<void>; // creates vayo_* collections + indexes
```

Uses the native MongoDB driver (not Mongoose) — captured schemas are inherently
dynamic/arbitrary shapes, which is the opposite of what an ODM's fixed-schema
model is good at; the native driver's flexibility is the right fit here.
`VayoDbAdapter` is the interface every other package codes against, so a
future `@vayo/db-postgres` is a drop-in alternative implementation, not a
rewrite of every consumer.

Beyond the M1-M5 CRUD, `VayoDbAdapter` also covers the Postman-parity
features (`03-data-model.md` "Manual endpoints & folders", "Environments &
variables", "Scripts & flows"): `createManualEndpoint`, folder CRUD
(`createFolder`/`listFolders`/`updateFolder`/`getFolder`/`deleteFolder` —
reparents children rather than orphaning them), environment CRUD, pinned-
example CRUD (`pinExample`/`listExamples`/`deleteExample` — pinned examples
are exempt from the M1 rolling-window cap), test-script CRUD, and flow CRUD.
Endpoint→folder placement is deliberately *not* one of these methods — it's
just another override (`${vayoId}.folderId`/`${vayoId}.order`), so it goes
through the existing `upsertOverride`/`getOverride` pair instead.

M6 (`07-api-versioning.md`) adds `createApiVersion`/`listApiVersions`/
`updateApiVersion` against `vayo_api_versions`. No `deleteApiVersion` —
`sunset` is a terminal lifecycle state, not a deletion; versions are never
removed, same non-destructive philosophy as everything else in `VayoDbAdapter`.

Team Chat attachments (`03-data-model.md`) add `uploadAttachment`/
`getAttachment`/`downloadAttachment`/`listAttachments`/`claimAttachments`/
`deleteUnclaimedAttachment`, backed by GridFS (`GridFSBucket`, already part
of the `mongodb` driver dependency this package already has — no new
storage dependency). These are the one place `@vayo/types`' own
"zero dependencies" rule got a second look: `uploadAttachment`'s file data
is typed `Uint8Array` and `downloadAttachment`'s stream is typed `unknown`,
specifically so `@vayo/types` never needs `@types/node` — `@vayo/server`
casts the opaque stream back to a real Node stream at the one call site
that pipes it to a response.

## `@vayo/server`

```typescript
export function createServer(options: ServerOptions): VayoServerHandle;

interface ServerOptions {
  db: VayoDbAdapter;
  authMiddleware?: (req: Request) => AuthResult;
  mountPath?: string;    // default "/vayo"
  sessionSecret?: string; // falls back to VAYO_SESSION_SECRET
  corsOrigins?: string[]; // same-origin-only unless explicitly opted into
  httpServer?: HttpServer; // mount into a host's own server — see below
  socketPath?: string;    // default "${mountPath}/socket.io" — see below
}

interface VayoServerHandle {
  app: express.Express;
  io: SocketIOServer;
  httpServer: HttpServer; // callers must .listen(port) on THIS, never on `app`
}
```

REST API (spec resolution, overrides, comments, team/invites, versions) +
embedded Socket.IO gateway (`06-realtime-collaboration.md`) + serves the built
`@vayo/ui` static assets. Every mutating route wrapped in `requireRole(...)`
per `05-security.md` §4 — this is the one package where a missing role check is
a real vulnerability, not a UX bug, so it gets the most thorough test coverage
of any package.

**File layout** (2026-07 pre-launch review, `09-roadmap.md`) — `index.ts` is
the orchestrator only (createServer's setup: helmet/CORS/auth-resolution
middleware, mounting every resource router below, static-asset serving) at
331 lines, down from a single 1,546-line file holding everything. Everything
else lives in its own module:

- `auth-middleware.ts` — `requireRole`, `resolveAuth`, `hashToken`,
  `extractBearerToken`, `ROLE_RANK`, `VayoAuthedRequest`/`AuthResult`.
- `error-handling.ts` — `autoCatchAsyncErrors` (patches a router's own
  `get/post/patch/delete/put` so every handler's rejected promise reaches
  Express's error pipeline automatically — Express 4 doesn't do this
  natively) + the final `errorHandler` middleware.
- `realtime.ts` — the Socket.IO gateway (`attachRealtimeGateway`), calling
  into `routes/comments.ts`'s `addComment` and `routes/overrides.ts`'s
  `applyOverride` — the same DB-writing helpers the REST routes use, so both
  transports persist identically.
- `server-deps.ts` — the small `RouteDeps` (`db`/`sessionSecret`/`io`/
  `authMiddleware`) bag every resource router receives.
- `routes/*.ts` — one file per resource (`auth`, `team`, `comments`,
  `attachments`, `overrides`, `folders`, `endpoints`, `history`,
  `versions`, `export`, `environments`, `examples`, `test-scripts`, `flows`,
  `coverage`, `notifications`), each exporting a `createXRouter(deps)`
  factory. Zod schemas live next to the route that validates against them,
  not in one shared schema file — each is only ever used by its own resource.
- `coverage.ts`, `postman-export.ts` — pre-existing framework-agnostic logic
  modules, unchanged; `routes/coverage.ts`/`routes/export.ts` are their thin
  HTTP wrappers.

Two deployment modes, both first-class. Omit `httpServer` and you get
`vayo serve`'s own behavior: a dedicated `app` + `http.Server` that you
`.listen(port)` on yourself, on its own port, no host app involved. Pass
your own already-created `http.Server` (the one behind your own Express
app) and Vayo mounts directly into it instead — no second port, no second
`.listen()` call:

```typescript
const { app: vayoApp, httpServer } = createServer({ db, mountPath: "/docs", httpServer: myHttpServer });
myExpressApp.use(vayoApp); // no path argument — vayoApp only answers under /docs internally already
// myHttpServer.listen(port) — whatever you already had
```

the same one-liner ergonomics as
`app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec))`. Sharing one
`http.Server` is exactly the scenario where a host app is most likely to
already run its own WebSocket/Socket.IO server, so `socketPath` defaults to
`${mountPath}/socket.io` rather than Engine.IO's bare `/socket.io` — and if
`options.httpServer` already has an `upgrade` listener attached (checked via
`httpServer.listeners("upgrade").length` right before Vayo attaches its own —
a heuristic, since Node can't say *which* path an existing listener answers
to, only that one exists), `createServer` logs a `console.warn` naming the
exact Socket.IO path it's about to use, so a real conflict is a loud,
explained one at startup rather than a connection silently misbehaving
later (`06-realtime-collaboration.md`).

Serving the UI is more than `express.static`: `@vayo/ui` builds into TWO
separate output directories from ONE source tree, because it has two
genuinely different consumers. `dist/` (`tsc -b`, `main`/`types` fields) is
the library entry — a host app that wants to import `<DocsApp>` directly into
its own React tree. `dist-app/` (`vite build`, a *separate* `build.outDir`
specifically so it never collides with `dist/`) is the standalone,
browser-ready bundle this package serves — built with `base: "./"` so its
asset references are relative, since the same build has to work under
whatever `mountPath` a given deployment chose, not just the default `/vayo`.
The one thing a static build can't know ahead of time is *which* mountPath
that is, so `createServer` injects `window.__VAYO_MOUNT_PATH__` into
`dist-app/index.html` at serve time (a plain string replace before
`</head>`, not a template engine), and `@vayo/ui`'s own `main.tsx` reads it
at startup to compute `apiBaseUrl`/`socketUrl` — falling back to the
hardcoded `localhost:4100` dev values when the global isn't present, i.e.
exactly `pnpm dev`'s existing behavior. If `@vayo/ui` was only ever
`tsc -b`'d and never `vite build`'t (no `dist-app/index.html` on disk),
`createServer` degrades to API-only rather than throwing — the same "a
missing optional piece must never take down the real service" posture as
capture's own error handling.

Also covers the Postman-parity REST surface: folders (`/api/folders`),
manual endpoint creation (`/api/endpoints/manual`) and placement
(`/api/endpoints/:vayoId/placement`), environments (`/api/environments`),
saved responses (`/api/examples/:vayoId`), test scripts
(`/api/test-scripts/:vayoId`), flows (`/api/flows`), and export
(`/api/export/postman` + `/api/export/postman-environment/:id`, alongside
the existing OpenAPI spec endpoint) — same `requireRole` pattern throughout.
Postman Collection/Environment compilation lives in a colocated
`postman-export.ts` module rather than its own package, since nothing else
depends on that format the way things depend on `@vayo/openapi-compiler`'s
OpenAPI output.

M6 (`07-api-versioning.md`) adds `/api/versions` (list/create/patch lifecycle
status) and `/api/diff?from=&to=`, the latter compiling both versions through
the same pipeline as `/api/spec` and running `@vayo/openapi-compiler`'s
`diffSpecs`. Same `requireRole` pattern: viewer can read both, only editor+
can create a version or change its status.

Beyond that: `POST /api/folders/auto-organize?version=` (editor+) exposes
`VayoDbAdapter.autoOrganizeFolders` for teams that add manual endpoints from
the UI and never run `vayo scan` (`03-data-model.md` "Manual endpoints &
folders"); `GET /api/coverage?version=` (viewer+, logic split into
`coverage.ts`'s pure `computeCoverageReport` so it's unit-testable against
hand-built `ResolvedEndpoint` fixtures rather than needing real captured
traffic or AST-scan output through routes that can't produce either) reports
four gaps plus a single trackable `fullyDocumentedPercent`: no human summary,
only-ever-2xx responses observed, no frontend-workflow notes, and — the
highest-value one — `source === "static"`, meaning the AST scanner found the
endpoint but it's never been merged with one real captured request, so its
shapes are inferred from code, not observed. A review queue, not a
validation gate. The Postman export
(`compilePostmanCollection` in `postman-export.ts`) sets auth natively at
the collection level (with per-request `noauth` for public endpoints,
rather than a manually-repeated header), exports each endpoint's saved
test scripts as `event` entries and pinned examples as saved `response`
entries, and carries `notes` through as the request's `description` —
closing the gap between "exports to Postman" and "round-trips what Vayo
itself already knows." `EndpointDoc.querySchema` (query-string parameters,
inferred the same way `paramsSchema` already was) flows through the same
export and into `/api/spec`'s `parameters` array as `in: "query"` entries.

Also: `PATCH /api/comments/:id/flag` (viewer+, `06-realtime-collaboration.md`
"Naming note") toggles whether a Team Chat message is an actual question/issue
worth resolving, and `GET /api/notifications` / `POST
/api/notifications/mark-seen` (viewer+) back the header bell
(`06-realtime-collaboration.md` "Notifications") — `applyOverride`/
`addComment` and the version-status PATCH route each also write a
`NotificationDoc` and broadcast `notification:new` to the `project` room.

Team membership can now be corrected, not just granted: `DELETE
/api/team/:memberId` (owner-only) hard-deletes the member — for the "wrong
person got invited and joined" case, since `resolveAuth`'s existing
member-lookup check (`05-security.md` §4a) revokes their access on the very
next request with no separate mechanism needed, while their past
comments/audit-log entries stay intact and render as "Former member." `GET
/api/team/invites` / `DELETE /api/team/invites/:inviteId` (owner-only)
list and revoke a not-yet-accepted invite — the same mistake one step
earlier. `PATCH /api/team/me/name` (any authenticated member) is
self-service display-name editing — the invitee already picks their own
name at `accept-invite` time, so there's no owner-edits-someone-else's-name
route to begin with.

Inviting several people at the same role no longer means repeating the
single-invite flow by hand for each one: `POST /api/team/invite/bulk`
(owner-only, `zod`-capped at `MAX_BULK_INVITES` = 50) takes an `emails`
array + one shared `role` and returns an array of `{token, email, role,
expiresAt}` results, one per de-duped email. It shares a `createOneInvite`
helper with the single-invite route rather than duplicating the
token/hash/audit-log sequence — same pattern as `addComment`/
`applyOverride` above. This only batches *creation*; the underlying model is
still N separate single-use, owner-revocable tokens, not one shared
reusable link (`05-security.md` §5).

Team Chat attachments (`vayo_attachments`, `03-data-model.md`) add
`POST /api/attachments` (`multer`, memory storage, `MAX_ATTACHMENT_BYTES`
size limit mapped to a `413`), `GET /api/attachments/:id/download` (pipes
the GridFS read stream through — the one route that also accepts
`?token=`, see `05-security.md` §7), and `DELETE /api/attachments/:id`
(unclaimed + same-uploader only). `addComment`'s `attachmentIds` param
calls `db.claimAttachments` right after creating the comment, and also
extracts `@[Name](memberId)` tokens from the body
(`extractMentionedMemberIds`, a small regex — the richer parsing for
autocomplete/rendering lives client-side in `@vayo/ui`'s `mentions.ts`,
duplicated rather than shared since `@vayo/server` and `@vayo/ui` don't
depend on each other) to populate the comment notification's
`mentionedMemberIds`.

`addComment` likewise extracts `#[path](vayoId)` tokens (`extractTaggedVayoIds`,
the same small-regex-duplicated-not-shared pattern) and unions them with the
endpoint the request names explicitly, storing the result as
`CommentDoc.vayoIds` — this is the entire mechanism behind a cross-cutting
message, not a separate field the client has to populate. `GET
/api/comments/:vayoId` (unchanged route, array-contains query now) and the
new `GET /api/comments/cross-cutting` (viewer+, `vayoIds.length` ≥ 2 only —
registered *before* the `:vayoId` route so Express doesn't match the literal
path segment "cross-cutting" as if it were one) both read from the same
collection. Realtime broadcast follows the same fan-out: `comment:new` goes
to every tagged endpoint's own `endpoint:{vayoId}` room, plus the shared
`project` room when there are 2+ (`06-realtime-collaboration.md`).

## `@vayo/ui`

Schema-driven React, per your explicit call to build fully custom rather than
prototype on a third-party renderer. Core primitive:

```typescript
function SchemaField({ schema, name, depth }: SchemaFieldProps): JSX.Element;
```

Recursively renders any JSON Schema shape — no per-endpoint JSX. Each endpoint
page has five tabs, matching the working prototype: **Details** (path, scopes,
parameters, schema trees — the M5 baseline described elsewhere in these docs),
**Flowmap** (renders `EndpointDoc.middlewareChain` as a linear chain, per
`04-capture-engine.md` §4, *plus* which saved `FlowDoc`s this endpoint
participates in, each rendered as its own step sequence with the current
endpoint highlighted and an "Open in Flows" link back into the Flows panel —
`04-capture-engine.md` §4's closing note), **History** (reads
`vayo_audit_log` filtered to this endpoint, per `03-data-model.md` — each
entry rendered through `audit-diff.ts`'s `describeAuditEntry`, which turns
the raw `action`/`fieldPath`/`diff` fields into a plain-language summary
plus a leaf-level list of exactly which fields changed, with a filter
between "Changes" (override/schema_change/endpoint_created) and "Team
activity" (comment/invite/role_change) so the two very different questions
— "what changed" vs. "what did people do" — don't have to be read out of
one interleaved list), **Team Chat** (per `06-realtime-collaboration.md` —
including reply-to: any message can quote another, rendered as a small
clickable reference above the reply that jumps to and briefly highlights
the original, so two people with different takes on the same message can
each respond to *that message* without the flat list losing track of who's
answering what; also a client-side search box filtering the current
conversation by body text, alongside All-time/Today/Last-7-days/Last-30-days
date filter chips (`chat-filters.ts`'s `matchesDateFilter`, using the
viewer's own local calendar day for "Today" rather than UTC) so a long-running
endpoint conversation can be narrowed by *when* something was said as well as
what was said, a right-click context menu (Reply/Flag/Copy) on
every message, an "R" keyboard shortcut that replies to whichever message is
currently moused over — guarded to never fire while focus is already in a
text field — file/screen-recording attachments (`vayo_attachments`,
`03-data-model.md`; a paperclip button, drag-and-drop onto the message
list, and a screen-record button using `MediaRecorder`/`getDisplayMedia`,
all uploading immediately as pending chips before Send so several files can
queue up for one message), `@mentions` (`packages/ui/src/mentions.ts`
parses/renders the `@[Name](memberId)` token and drives the compose-time
autocomplete dropdown; a mentioned member's copy of the notification bell
entry is flagged "you were mentioned" — still the same shared conversation
everyone sees, not a private channel), and `#endpoint-tags` — same
`mentions.ts`, same trigger-and-autocomplete mechanic with `#` in place of
`@` and the endpoint list in place of the member list, rendered as a
clickable jump (`MessageBody.tsx`, shared with the drawer below) rather than
plain highlighted text. Tagging 1+ *other* endpoints this way is what turns
an ordinary message into a cross-cutting one (`03-data-model.md`'s
`CommentDoc.vayoIds`); each tab shows an "also about: …" line, with its own
jump chips, for whichever tagged endpoints aren't this one), and **Try It Now** (the live request panel,
including the token/no-token flow from the auth-detection demo, and a
`status === 0` "no response at all" hint explaining that browsers hide the
real reason a cross-origin request failed, showing the page's *actual*
origin next to a pointer at `Access-Control-Allow-Origin` — the practical
answer to "it works in Postman and in Try It Now but not my own frontend,"
since Postman isn't a browser page subject to CORS at all and Try It Now
just happens to run from an origin the API's CORS config allows). Slot-based
customization for teams that want to override specific panels:

```typescript
<DocsApp
  renderTryItPanel={CustomTryIt}
  renderAuthBadge={CustomAuthBadge}
  renderFlowmap={CustomFlowmap} // (vayoId, middlewareChain, flows, endpoints, canEdit, onOpenFlow, onOpenFlowsPanel)
  renderHistory={CustomHistory}
/>
```

Talks to `@vayo/server`'s REST API and Socket.IO gateway — never touches
MongoDB or any package below `@vayo/server` directly.

Beyond the five endpoint tabs, the sidebar is a real drag-and-drop folder
tree (`@dnd-kit`) with inline rename and a create/rename/delete/move context
menu, backed by `/api/folders` + the endpoint-placement override — plus a
command-palette (Cmd/Ctrl+K) search — layered with structured filters
(`endpoint-filters.ts`): method chips, an auth-required/not-required cycle
button, and a group `<select>` (shown only once a project has more than one
group), all combined with the existing free-text match rather than replacing
it, so "every unauthenticated POST in Orders" doesn't require guessing at
search terms. Clicking a header notification (`NotificationBell`) jumps
straight to the right endpoint *and* tab instead of leaving you to find the
context yourself — Team Chat for a comment (scrolling to and briefly
blinking the exact message via the same jump-and-highlight mechanism
reply-quotes already use), History for a schema change, Details for an
override. A header environment switcher drives
`{{variable}}` interpolation in the Try It Now tab, which also gained a
"Save response" action (pinned examples), a Tests sub-panel (CodeMirror
editors for pre-request/test scripts, executed in a sandboxed Web Worker —
`03-data-model.md` "Scripts & flows"), and a Flows section for running
related-endpoint sequences. An export menu covers OpenAPI (existing) plus
Postman Collection/Environment.

M6 (`07-api-versioning.md`) adds a header version switcher (`VersionSwitcher`)
next to the environment switcher — lists every configured version plus a
permanent "Unversioned" entry, switching re-fetches `/api/spec` for that
version. Its menu opens `VersionsModal` (create a version, walk its
active→deprecated→sunset lifecycle) and `DiffModal` (pick two versions, see
added/removed/changed operations from `/api/diff`). A non-active version's
docs page shows a presentation-only deprecated/sunset banner — the
underlying `EndpointDoc`s are never hidden or deleted.

The sidebar header also has an "auto-organize" trigger (`Sparkles` icon,
next to "New folder") that calls `/api/folders/auto-organize` — the same
non-destructive pass `vayo scan` already runs automatically, exposed for
teams working entirely from the UI. A `CoverageModal` (header, "Coverage")
reads `/api/coverage` and leads with a single `fullyDocumentedPercent`
figure, then four sections — never confirmed by real traffic (the
`source === "static"` check, framed as "found by static analysis only, not
yet observed"), only-ever-success responses, no summary, no notes — each row
jumping straight to that endpoint. A review queue, not a gate.

A header "Team" button opens a roster modal (viewable by everyone; only an
owner sees the invite form, role picker, remove action, or pending-invites
panel) backed by `/api/team` + the owner-only `/api/team/invite`,
`/api/team/invite/bulk`, `/api/team/:memberId/role`, `/api/team/:memberId`
(DELETE), `/api/team/invites`
(GET), and `/api/team/invites/:inviteId` (DELETE) routes. The invite form is
a multi-line email textarea (parsed client-side on newlines/commas, trimmed,
de-duped) rather than a single email input — one shared role, one "Send N
invites" click, whatever `N` is — sending the whole batch to
`/api/team/invite/bulk` in one request. Each resulting link renders in its
own card with "Copy link," a feature-detected "Share…" using
`navigator.share()` where the browser supports it, and explicit `wa.me`
(WhatsApp) and `mailto:` fallback links so sharing doesn't depend on that
API — plus a "Copy all as one message" action for pasting the whole batch
into a single Slack/email message at once. No email-sending service was
built for this: it would be a new outbound dependency and new credentials to
secure, at odds with the project's self-hosted/BYODB philosophy, for a
problem the share links already solve (`09-roadmap.md`). Removing a member
shows an inline "remove this person? they lose access immediately" confirm
step before the request fires — no browser-native `confirm()`, and a
deliberately higher bar than this codebase's other destructive actions
(folder/flow delete just fire on click) given removing a person is harder to
undo than recreating a folder. Any member can also edit their own display
name (`PATCH /api/team/me/name`) — propagated immediately to the header's
own name display via a `onMyNameChanged` callback, not just the roster list.
Accepting an invite is a *separate* top-level screen (`?invite=<token>` in
the URL, checked before the logged-in gate specifically so it wins even in a
browser that already has someone else's session — the invite is addressed to
whoever holds the link, not to whoever this browser happens to be signed in
as) that creates the account via `POST /api/team/accept-invite` and then
hands off to the normal sign-in form, since that route never returns a
session of its own (`05-security.md` §5).

Both the invite-role picker and the per-member role-change picker, plus the
accept-invite confirmation screen, show a one-line description of what the
selected role actually grants (`role-descriptions.ts`'s
`ROLE_DESCRIPTIONS`) — a bare `<option>viewer</option>` doesn't say what
that means, which was the real gap once "can I do granular access here"
came up, not a missing role (`05-security.md` §4's audit of every route
found the 3-role split already clean, with no bundled-together concerns to
split further).

A header "Chat" button opens `GlobalChatDrawer` — a side drawer sliding in
from the right, deliberately not a centered modal like Team/Coverage/Flows:
the entire point is asking a question that spans multiple endpoints without
losing your place on whatever tab you're already on, so the page behind it
is never dimmed or blocked. Backed by `GET /api/comments/cross-cutting`, and
scoped to exactly those cross-cutting messages (`03-data-model.md`), not
every chat message in the project. Its own compose box pre-fills a `#tag`
for whichever endpoint is currently open (a lazy `useState` initializer, so
each open/close cycle re-derives it fresh) — tag one more via the same `#`
autocomplete used in Team Chat and Send is enabled; there's no separate
"which endpoints is this about" field beyond the tags actually typed. Live
updates reuse the `project` room broadcast already described in
`06-realtime-collaboration.md`, so a second team member's cross-cutting
question appears without a refresh regardless of which endpoint's page
they're on.

**File layout** (2026-07 pre-launch review, `09-roadmap.md`) — a pre-launch
review found this package had grown with no shared primitives: every modal
reimplemented its own overlay-dismiss logic, `config`/`socket` were passed
as props into 11+ separate components from `DocsApp.tsx` individually, and
`TeamMember`/`PendingInvite`/`InviteResult` were redefined locally instead
of shared. Fixed, all verified with no regressions (build, the existing
pure-logic test suite, and live browser checks — this package has no
component-rendering tests, only tests of extracted pure functions, so the
browser is where a UI regression would actually show up):

- `hooks/` (new) — `useDismiss` (outside-click + Escape, the one shared
  version of what 8 files each reimplemented by hand) and `useEscapeKey`
  (Escape only, for a persistent panel like `GlobalChatDrawer` that
  shouldn't close on an outside click the way a modal or dropdown should).
  `useVayoSocket` (previously the standalone `socket.ts`) also lives here
  now.
- `components/Modal.tsx` (new) — the shared backdrop+panel shell now used
  by all 9 modals that used to each hand-roll `.modal-overlay` +
  `onClick={onClose}` + `stopPropagation()`, with no Escape support anywhere
  before this. Every header dropdown (`EnvironmentSwitcher`, `ExportMenu`,
  `VersionSwitcher`, `NotificationBell`) and every context-menu-style
  popover (`ContextMenu`, `CommandPalette`'s group filter, `TeamChatTab`'s
  message menu and date-jump popover, extracted below) now uses the same
  `useDismiss` hook directly instead of its own copy of the same effect.
- `contexts/ConfigContext.tsx`, `contexts/SocketContext.tsx` (new) —
  `useConfig()`/`useSocket()`, replacing `config={config}`/`socket={socket}`
  props previously threaded individually into `ExportMenu`,
  `NotificationBell`, `DetailsTab`, `HistoryTab`, `TeamChatTab`,
  `TryItNowTab`, `FlowsModal`, `DiffModal`, `CoverageModal`,
  `GlobalChatDrawer`, and `TeamModal` from `DocsApp.tsx`. (Theme state was
  audited too and found *not* to have the same problem — `ThemeToggle` is
  rendered in exactly one place, so passing it `value`/`onChange` as plain
  props is normal React, not drilling; a Context there would have been
  abstraction for its own sake.)
- `types.ts` gained `TeamMember`, `PendingInvite`, `CreatedInvite`, and
  `InviteResult` — previously redefined locally in `TeamModal.tsx` and
  duplicated again as inline anonymous types in `api.ts`'s own
  `listTeam`/`createInvite`/`createInvitesBulk`/`listPendingInvites`
  signatures.
- `components/tabs/try-it-now-utils.tsx` (new) — every pure
  format-detection/pretty-printing/matching function `TryItNowTab.tsx` used
  to define inline (`detectFormat`, `prettyPrintBody`, `formatBytes`,
  `findMatches`, …) plus its two presentational-only sub-components
  (`ResponseTableView`, `HighlightedText`), moved out since none of it
  touches the tab's own state. `TryItNowTab.test.ts` already tested these
  as standalone functions; only its import path changed. Cut the main file
  from 1,536 to 1,262 lines.
- `components/tabs/team-chat-pieces.tsx` (new) — `ChatContextMenu`,
  `DateJumpPopover`, `AttachmentPreview`, and the `snippet` helper, same
  reasoning (self-contained, no shared state with the tab). Cut
  `TeamChatTab.tsx` from 761 to 614 lines.
- `components/Avatar.tsx` (new) — a member's uploaded picture, or a
  deterministic initials-in-a-circle fallback, with an optional presence
  dot. One shared component for the header's own user chip, the Team
  modal's roster rows, and its detail panel's bigger profile view.
- `hooks/usePresence.ts` (new) — subscribes to the three global-presence
  socket events (`presence:online`, `presence:offline`,
  `presence:online-list` — see 06-realtime-collaboration.md) and exposes
  `isOnline`/`lastSeenOverride`, so the Team modal doesn't hand-roll socket
  listeners itself.
- `time-format.ts` (new) — `timeAgo`, extracted out of `NotificationBell.tsx`
  (its original, only caller) so the Team modal's "last seen" display
  doesn't duplicate the same relative-time thresholds.
- `components/FullDocView.tsx` (new) — the whole active API version as one
  scrollable reference page, toggled from a header button
  (`DocsApp.tsx`'s `viewMode: "endpoint" | "fulldoc"`), the same pattern
  Postman's own collection documentation view, Redoc, and Swagger UI all
  converge on. Stacks every endpoint's existing `DetailsTab` content in
  folder order (via `flattenTree` with every folder forced "expanded") —
  reused as-is, not duplicated — with an `id` per section so the sidebar
  becomes this view's own "jump to" nav: `DocsApp.tsx`'s
  `selectEndpointOrScrollTo` scrolls to a section instead of switching the
  selected endpoint while this mode is active. Only ever read-only
  reference content; Flowmap/History/Team Chat/Try It Now stay exclusive to
  the normal one-endpoint workspace, since they're inherently interactive
  and don't make sense stacked in a continuous scroll — clicking "Try it"
  inside a section exits Full Docs and lands on that one endpoint's Try It
  Now tab instead.

## `vayo`

The actual product surface for anyone outside this repo — every other
package only proves itself via hand-wired scripts inside `apps/demo-app`;
this is what a real adopter runs against their own project. `commander`
(subcommands) + `prompts` (interactive `init`) + `dotenv` (auto-loads `.env`
before every command, so nobody has to export env vars by hand the way every
demo-app script requires today).

```bash
npx vayo init                      # prompts for Mongo URI + AST-entry path,
                                    # writes .env + vayo.config.js + a starter
                                    # AST-entry file, runs migrations
npx vayo scan [--config <path>]    # @vayo/ast static pass, merges vayo_endpoints,
                                    # then auto-organizes detected groups into folders
npx vayo export [--version v1] [--format openapi|postman] [--out <path>]
npx vayo import <file> [--version v1] [--overwrite]   # enrich already-discovered
                                    # endpoints from an existing OpenAPI spec
npx vayo create-owner [--email <e>] [--name <n>] [--password <p>] # bootstrap
                                    # the first standalone-auth login (05-security.md §5)
npx vayo serve [--port 4100] [--mount /vayo]   # standalone auth mode only
npx vayo diff <from> <to> [--fail-on-breaking] # CI-friendly breaking-change gate
```

`vayo.config.js` is deliberately plain JS, not `.ts` — the CLI ships as
compiled JS with no TS loader bundled in, and a bare `import()` of a `.js`
file needs none (the same mechanism `@vayo/ast`'s `scanProject` already uses
for the user's own app entry). A JSDoc `@type` comment gives editor
autocomplete without requiring a build step. `init` generates it (and the
AST-entry placeholder, and the printed wiring snippet) as ESM `export
default` or CommonJS `module.exports` to match the target project's own
`package.json` `"type"` field — getting this wrong isn't cosmetic: a plain
`.js` file with `export default` is invalid syntax to Node's CommonJS
loader (the default when `"type"` is absent, which is most real Express
apps), and made `vayo scan` crash outright the one time this was tested
against a project this repo didn't hand-build.

`vayo init` never edits the user's existing source files — it only creates
new ones (`.env`, `vayo.config.js`, a placeholder AST-entry file) and prints
the one wiring step it can't safely automate: mounting `capture()` into
whatever file the user actually calls `app.listen()` from. Auto-rewriting
code this package doesn't own is exactly the kind of risky default to avoid.

Every one-shot command that opens `@vayo/db-mongo`'s `createAdapter` (`scan`,
`export`, `create-owner` — not `init`, which only ever touches `runMigrations`'s
own short-lived, self-closing client) force-exits with `process.exit()` at
the end. `createAdapter`'s `MongoClient` has no public `close()` — it's built
to live for a long-running server's whole lifetime — so without an explicit
exit, Node's event loop just never drains and the command hangs forever
after finishing its actual work. `create-owner` catches its own expected
error case (an email that's already registered) before that final
`process.exit()` specifically so the message still reaches the terminal
instead of silently hanging.

`vayo export --format postman` and `vayo diff` reuse `@vayo/server`'s own
`compilePostmanCollection`/`diffSpecs` logic directly against the database —
re-exported from `@vayo/server`'s public entry specifically so the CLI never
needs a running server just to compile or diff a spec.

`vayo import <file>` is a migration/onboarding aid, not a parallel authoring
path — `01-vision-and-market.md`'s own Apidog comparison is explicit that
Vayo's differentiator is a human *not* needing to author or import a spec
for it to work at all, so this deliberately never invents an endpoint from
a spec alone. It only enriches endpoints capture/`vayo scan` have *already*
discovered (matched by method + path) with `summary`/`description`,
per-field schema descriptions (guarded: only for a field the endpoint's own
captured/declared schema already has — never synthesizes schema structure
from the import alone), and response examples (as new pinned
`vayo_examples`, deduped against what's already pinned) — plus project-wide
`vayo_settings`/`vayo_environments` from the spec's own `info`/`servers`. A
spec operation with no matching endpoint is reported unmatched, not
created. Every enriched field is written through the ordinary
`vayo_overrides` mechanism (skipped when one already exists, unless
`--overwrite`) — the pure matching/extraction logic
(`@vayo/openapi-compiler`'s `planOpenApiImport`) is fully unit-tested
without touching a database at all; this command is the thin I/O layer on
top, the same "plan here, apply there" split `compile()`/`diffSpecs`
already follow. Deliberately v1-scoped: JSON input only (no YAML yet — a
clean follow-up via `@apidevtools/swagger-parser`'s own loader, already a
`@vayo/openapi-compiler` dependency), and parameter-level descriptions
aren't imported (only request/response body schema fields).

## Enforcing the framework-agnostic boundary in code, not just docs

Add an ESLint rule (or a simple CI grep check as a v1 stopgap) that fails the
build if `schema-engine`, `openapi-compiler`, `db-mongo`, or `ui` import
anything from `express` or `capture-express`. This is cheap to set up and is
what actually guarantees `01-vision-and-market.md`'s "other stacks later"
claim stays true as the codebase grows past what one person can manually review.

Note `@vayo/server` is deliberately *not* in this list, even though the same
principle sounds like it should apply: `@vayo/server` is Vayo's own REST
API/dashboard server (`createServer(): { app: express.Express; ... }` above),
built on Express as its own implementation choice — a different thing
entirely from "the *user's captured app* might be on a different framework,"
which is what this boundary actually protects against. `capture-express`
is "the only package allowed to import Express types" in that
user's-app-facing sense; `@vayo/server` using Express to build its own
server is orthogonal to that and not a violation.
