# 03 — Data Model

All collections live in the database the user configured via their Mongo URI.
Vayo creates them on `vayo init` (see `08-packages-and-repo-structure.md`,
`vayo`). Collection names are prefixed `vayo_` to avoid colliding with
the user's own collections in a shared database.

## The generic capture format (the stack-agnostic contract)

This is the shape `capture-express` emits, and the shape any future
`capture-<other-stack>` package must also emit. `schema-engine` only ever consumes
this — never anything Express-specific.

```typescript
interface CapturedSample {
  method: string;                 // "GET", "POST", ...
  pathTemplate: string;           // "/api/users/:id" — already normalized
  version: string;                // resolved from path prefix or config, e.g. "v1"
  requestHeaders: Record<string, boolean>;   // presence only, e.g. { authorization: true }
  requestParams: Record<string, unknown>;    // path params, redacted per 05-security.md
  requestQuery: Record<string, unknown>;
  requestBody: unknown | null;    // redacted
  requestBodyFileFields?: string[]; // keys of requestBody that are uploaded files (multer req.file/req.files), not JSON values
  responseStatus: number;
  responseBody: unknown | null;   // redacted
  middlewareNames: string[];      // e.g. ["authenticate", "rateLimiter"] — auth-detection input
  capturedAt: string;             // ISO timestamp
}
```

## `vayo_endpoints`

The canonical record for one (method, pathTemplate, version) triple.

```typescript
interface EndpointDoc {
  _id: ObjectId;
  vayoId: string;         // stableHash(method + pathTemplate + version) — never changes
  method: string;
  pathTemplate: string;
  version: string;           // FK to vayo_api_versions.version
  group: string;             // display grouping, e.g. "Orders", or "Admin/Users" when nested — see below
  groupSource: "declared" | "inferred"; // how `group` was populated — see below
  summary: string | null;    // AST-derived if available (e.g. JSDoc), else null
  deprecated: boolean;       // OpenAPI's own standard field, not x-vayo-* — see below
  deprecatedSource: "declared" | null; // "declared" only when an @deprecated tag set deprecated — see below
  notes: string | null;      // markdown (+ Mermaid), the per-endpoint frontend-workflow notes — set via override like every other field
  authRequired: boolean;     // see 05-security.md §3 for detection algorithm
  authType: "bearer" | "apiKey" | "basic" | "cookie" | null; // "cookie" is the only auto-detected value (04-capture-engine.md §3c); the rest are override-only
  scopes: string[];          // e.g. ["customer:read", "admin:read"] — see 05-security.md §3a
  middlewareChain: string[]; // ordered middleware names, e.g. ["rateLimiter","authenticate","validateBody"]
                             // — this is the data source for the Flowmap tab, see 04-capture-engine.md §5
  requestSchema: JSONSchema | null;
  requestSchemaSource: "declared" | "inferred" | "observed" | null; // how requestSchema was populated — see below
  responseSchemas: Record<string /* status code */, JSONSchema>;
  paramsSchema: JSONSchema | null;  // path (:id-style) parameters, always required
  querySchema: JSONSchema | null;   // query-string parameters (?page=&limit=) — required per-field only when genson-js's own required list says a sample always carried it
  source: "runtime" | "static" | "merged" | "manual"; // "manual" = created from the UI, see "Manual endpoints & folders" below
  sampleCount: number;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  possiblyRemovedSince: string | null; // set when a `vayo scan` no longer finds this route — see below
}
```

**Path parameters in the compiled spec don't actually wait on `paramsSchema`.**
`paramsSchema` itself is still only ever populated by runtime capture or
static Zod extraction, same as `requestSchema`/`querySchema` — but a path
param's *name* is already fully known from the route registration itself
(the `:id` in `/api/v1/users/:id`), independent of whether any traffic has
been captured yet or the project uses Zod at all. `openapi-compiler`'s
`buildParameters` (`02-architecture.md`) always derives one `{name, in:
"path", required: true}` entry per `:name` segment straight from
`pathTemplate`, defaulting each one's `schema` to `{type: "string"}` — then
overlays a richer per-name type from `paramsSchema` when one exists. This
means every endpoint documents its path params from the very first static
scan, for any project regardless of its validation library, with
`paramsSchema`/capture only ever *refining* the type, never gatekeeping
whether the param is documented at all. `querySchema` has no such
fallback — there's no syntactic source for a query string's shape the way
a route's own path segments are, so it still needs capture-observed
traffic.

**`requestSchemaSource` tracks *how confidently* `requestSchema` is known**,
surfaced in the UI as an "Inferred, unconfirmed" badge on the Request Body
section (DetailsTab) whenever it isn't at the top tier:

- `"declared"` — traced from a Zod schema the code itself validates
  `req.body` against (`04-capture-engine.md` Step 2 #3). Requests that
  reach the handler are guaranteed to match it, by construction.
- `"inferred"` — traced from a Mongoose model's schema instead (Step 2
  #3b), for the very common case where a project has no Zod (or
  equivalent) at all. Reflects the *stored document's* shape, which may be
  a superset (server-stamped fields the request never sent) or subset (a
  route that only needs some of the model's fields) of what's actually
  required — a best-effort default, not a guarantee.
- `"observed"` — real captured traffic has contributed to this schema.
  The highest-confidence tier regardless of how the schema originally got
  its declared/inferred starting shape, since real requests have now been
  confirmed against it; a schema that started `"inferred"` graduates to
  `"observed"` the moment real traffic actually flows through it.
- `null` exactly when `requestSchema` is (nothing traced yet, from any
  source).

**`group`/`groupSource` — grouping and its provenance** (`04-capture-engine.md`
Step 2 #4). `group` can be a plain name (`"Orders"`) or a "/"-separated
nested path (`"Admin/Users"`) — the latter comes from either a nested
`routes/<a>/<b>/*.ts` file layout or a nested `@group Admin/Users` tag, and
`autoOrganizeFolders` (`@vayo/db-mongo`) turns each segment into one level
of real nested sidebar folders. `groupSource` is `"declared"` only when an
explicit `@group <name>` tag (swagger-jsdoc's own convention, and only
recognized inside a comment also carrying the `@vayo` sentinel line —
`04-capture-engine.md` "Disambiguating a doc comment from an ordinary
one") produced `group`; every other source — the `routes/` file
convention, the first-URL-segment fallback, or a manually-created
endpoint's free-text group field — is `"inferred"`. The UI treats
`"declared"` as authoritative for folder *placement* specifically: such an
endpoint can still be reordered among its current folder's own siblings
via drag-and-drop, but a move to a different folder is refused — enforced
once, in `checkOverrideAllowed`, and applied at every write path capable
of setting `folderId` (the dedicated `/placement` route, the generic
`/api/overrides` route, and the Socket.IO `override:updated` event), not
just the sidebar UI, since that would silently diverge from what the code
itself says and a check on only one write path isn't a real guarantee.
The lock only applies once a placement override already exists — a brand
new "declared" endpoint that hasn't been placed anywhere yet has nothing
to diverge from, so its first placement is never blocked. If the tag's
*value* later changes (e.g. renamed from `@group Admin/Users` to `@group
Admin/Customers`), the lock would otherwise leave the endpoint stuck in
its old folder forever with no way for a human to ever move it —
`autoOrganizeFolders` is the one place this is allowed to self-heal: it
re-places a "declared" endpoint whenever its current folder no longer
matches its current `group`, leaving `order` (and everything else)
untouched when the folder already matches. This is one of two deliberate
exceptions to this app's usual "manual override always wins" rule (the
other is `deprecatedSource`, below) — every other field (summary, notes,
scopes, `authType`, etc.) still lets a human's edit win outright over
whatever the code or runtime capture says.

**`deprecated`/`deprecatedSource` — the second such exception**
(`04-capture-engine.md` Step 2 #4a). `deprecated` is OpenAPI's own
standard Operation Object field (not `x-vayo-*`) — independent of the
whole API *version*'s own lifecycle (`ApiVersionDoc.status`,
`07-api-versioning.md`): one route can be deprecated while its version is
still fully active. `deprecatedSource` is `"declared"` only when an
explicit bare `@deprecated` tag (also gated by the same `@vayo` sentinel)
in code produced `deprecated: true`; `null` otherwise, including when a
human (not the code) set `deprecated` true via the normal override
mechanism. A human can freely flag any NOT-code-declared endpoint
deprecated (or not) through the UI, but once `deprecatedSource` is
`"declared"`, nothing can un-deprecate it — the same `checkOverrideAllowed`
check, applied at the same three write paths as the folder-placement lock
above, not just a hidden UI toggle.

**`tags` (OpenAPI standard) vs. `x-vayo-group`** — `@vayo/openapi-compiler`
also emits `group` as a real, standard OpenAPI `tags: [group]` array on
each operation (the full "/"-separated path as one tag string, not one
tag per segment — a flat-tag renderer has no concept of nesting, and two
different "Users" groups under different parents would otherwise collide
into one), plus a top-level `tags: [{name}, ...]` declaration listing
every distinct group in first-appearance order. Without this, grouping
would only ever work inside Vayo's own UI (which reads `x-vayo-group`
directly) — opening the exported spec in an actual third-party Swagger UI,
Postman import, or Redoc would show every operation in one flat,
ungrouped list. Purely an output-side addition — no new stored field,
`vayo_folders`/`EndpointDoc.group` stay the only source of truth.

**`possiblyRemovedSince` flags a static/merged endpoint a `vayo scan` run no
longer found** (`04-capture-engine.md` §3d), so a genuinely-removed route's
doc entry doesn't sit here forever with no path to disappear. Only ever set
for `source: "static"` or `"merged"` — a purely `"runtime"`/`"manual"`
endpoint was never subject to static confirmation, so its absence from a
scan means nothing. Cleared the instant either a later scan re-finds it
(`mergeStaticResult`) or real traffic hits it again (`mergeCapturedSample`)
— both are positive evidence it's still there. This is also the second
condition (alongside `source: "manual"`) under which the docs UI allows
deleting an endpoint outright: deleting one that's still confirmed would
just have it silently reappear on the next scan/request.

**Indexes:** unique on `vayoId`; compound on `{ version: 1, group: 1 }` for
sidebar queries.

## `vayo_overrides`

Non-destructive diff layer. Never delete an `EndpointDoc` field to apply an
override — always write here and merge at read time. This is what makes
re-scanning safe (constraint #3 in `00-README.md`).

```typescript
interface OverrideDoc {
  _id: ObjectId;
  targetId: string;         // `${vayoId}.${fieldPath}` e.g. "ep_9f21.responseSchemas.200.email.description"
  value: unknown;           // the overriding value
  updatedBy: string;        // team_members._id as string
  updatedAt: string;
  reason: string | null;    // optional free-text, shown in UI as "why this was overridden"
}
```

**Indexes:** unique on `targetId` (last write wins per field — see `06-realtime-collaboration.md`
for how concurrent edits are surfaced to users before they collide).

## `vayo_examples`

Rolling window of real request/response pairs per endpoint, capped so storage
doesn't grow unbounded on a busy API.

```typescript
interface ExampleDoc {
  _id: ObjectId;
  vayoId: string;
  statusCode: number;
  requestBody: unknown | null;
  responseBody: unknown | null;
  capturedAt: string;
  redacted: boolean;        // true if any field was scrubbed — shown as a UI badge
  pinned: boolean;          // true for a response a team member explicitly saved (below)
  label: string | null;     // optional human label on a pinned example, e.g. "Successful login"
}
```

**Indexes:** compound `{ vayoId: 1, capturedAt: -1 }`. Application logic caps
at N=5 most recent per `(vayoId, statusCode)` — enforced in `schema-engine`,
not by a DB TTL, since "5 most recent" isn't expressible as a simple TTL.
**Pinned examples are exempt from this cap** — a team member explicitly
"saved" that response from the Try It Now tab (the **Saved Responses**
feature), so auto-rotation must never touch it, same non-destructive
principle as overrides.

## `vayo_team_members`

```typescript
interface TeamMemberDoc {
  _id: ObjectId;
  email: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  passwordHash: string | null;   // null if SSO/delegated-auth only, see 05-security.md §5
  status: "active" | "invited";
  invitedBy: string | null;      // team_members._id
  createdAt: string;
  lastSeenNotificationsAt: string | null; // header bell's unread cursor — see vayo_notifications
  avatarUrl: string | null;      // self-uploaded, base64 data: URI, capped at MAX_AVATAR_BYTES (256KB
                                  // raw) — inline rather than a vayo_attachments reference, since that
                                  // GridFS bucket is keyed by vayoId (an endpoint) and a profile picture
                                  // isn't tied to one. null renders as an initials-in-a-circle fallback.
  lastSeenAt: string | null;     // stamped by realtime.ts's disconnect handler the moment this
                                  // member's LAST open socket closes — see "Presence UI data" in
                                  // 06-realtime-collaboration.md. null if they've never had a realtime
                                  // connection, or while they're currently online (the live socket
                                  // state wins then, not this field).
  nicknames: Record<string, string>; // THIS member's own private contact book: targetMemberId ->
                                  // nickname, for how THEY refer to someone else — independent of that
                                  // member's own `name` (a chat app's per-contact nickname, not a
                                  // team-wide rename). A missing key means "no nickname, show their
                                  // real name." Never exposed on anyone else's row in GET /api/team's
                                  // roster list — only GET /api/me returns the caller's own map.
}
```

## `vayo_invites`

```typescript
interface InviteDoc {
  _id: ObjectId;
  tokenHash: string;   // HMAC-SHA256 of the raw token; raw token is never stored
  email: string;
  role: "editor" | "viewer";
  createdBy: string;
  expiresAt: string;   // default 7 days
  usedAt: string | null;
}
```

## `vayo_comments`

Backs the **Team Chat** tab in the UI (per-endpoint threaded chat, not a
generic sitewide comment box — see `06-realtime-collaboration.md` for the
naming rationale and the live-update event contract).

```typescript
interface CommentDoc {
  _id: ObjectId;
  vayoIds: string[];   // every endpoint this message is about — see below
  authorId: string;
  body: string;
  replyToId: string | null; // the message this one is quoting/responding to — see below
  flagged: boolean;   // marks this message as an actual question/issue — see below
  resolved: boolean;  // only meaningful (and only ever shown in the UI) when flagged is true
  createdAt: string;
}
```

`vayoIds` is an array, not a single `vayoId`, so one message can be *about*
more than one endpoint at once — "does this relate to the cart endpoint in
this way?" asked from the endpoint you're already looking at, without
opening a second, disconnected conversation. It's always at least one
element: the endpoint the message was posted from, plus whichever further
endpoints got `#[path](vayoId)`-tagged inline in `body` (see below). A
message with 2+ `vayoIds` is "cross-cutting": `GET /api/comments/:vayoId`
matches it for *every* tagged endpoint (array-contains, not equality), so it
shows up in each of those endpoints' own Team Chat tabs, each one showing an
"also about: …" line for the *other* tagged endpoints — and it also shows up
in the header's cross-endpoint chat drawer (`GET
/api/comments/cross-cutting`, `08-packages-and-repo-structure.md`), which is
deliberately scoped to only these cross-cutting messages rather than a
firehose of every single-endpoint message in the project. There is exactly
one stored copy either way — the drawer and every tagged tab are reading the
same `CommentDoc`, not duplicates, which is what keeps them in sync for
free.

`flagged` exists because most messages in a real conversation are just that —
conversation — and never need a resolution at all. Only a flagged message
shows a resolved/unresolved state or a "Mark resolved" control; an ordinary
message renders with no resolve affordance whatsoever. Set by the sender at
send time (`POST /api/comments`'s `flagged` field), or toggled after the fact
by anyone who could comment at all — same `viewer`+ bar as posting one
(`PATCH /api/comments/:id/flag`), since flagging is a form of asking a
question, not a mutation of substance. A resolved message stays visible,
deemphasized, exactly like an unflagged one — nothing about an endpoint's
past silently vanishes (same principle as the History tab, below).

`replyToId` exists so two team members with different opinions on the same
message can each reply *to that message*, not just append to the bottom of
the thread — real usage surfaces this quickly once more than two people are
discussing one endpoint. `vayo_comments` stays a flat, chronological list
per `vayoId` — this is not a tree. The UI renders a reply with a small
quoted preview of its target above it (clicking it scrolls to and briefly
highlights the original), which is enough to disambiguate "who's replying
to what" without a full nested-thread view, matching how Team Chat is
scoped (one running conversation per endpoint, not a detached review
thread — see `06-realtime-collaboration.md`'s "Naming note"). Comments are
never deleted, so a `replyToId` is never left dangling.

**@mentions** are encoded directly in `body` as `@[Display Name](memberId)`,
not a separate field — a deliberate choice over freeform "@Jane Smith" text
matching, since the token carries the exact `memberId` and stays unambiguous
even with duplicate first names. `@vayo/ui`'s `mentions.ts` parses this
syntax for both the compose-time autocomplete and rendering a resolved
mention as a highlighted span. This is explicitly *not* a private-messaging
feature: a mention still posts to the same shared, endpoint-scoped
conversation everyone already sees — it only draws one person's attention
(and flags their copy of the notification bell, see `vayo_notifications`
below), rather than opening a second, separate communication channel
alongside Team Chat.

**#endpoint-tags** use the identical mechanic, one sigil over: `#[path
template](vayoId)` in `body`, parsed by the same `mentions.ts` (a single
combined tokenizer, not two independent parsers — a message can freely
interleave `@mentions` and `#tags` in one linear pass) and independently
re-extracted server-side (`@vayo/server`'s `extractTaggedVayoIds`,
duplicated rather than shared for the same reason `extractMentionedMemberIds`
already is: server and UI don't depend on each other). Every `#tag` typed
becomes one more entry in `vayoIds`, unioned with the endpoint the message
was posted from — this is the entire mechanism behind cross-cutting
messages above, not a separate "which endpoints is this about" form field.
Unlike a mention, a rendered `#tag` is clickable (jumps to that endpoint),
since — unlike a person — there's always somewhere useful to go.

## `vayo_attachments`

Files and screen recordings attached to a Team Chat message — real value for
"here's what's actually happening" bug reports (a screenshot of a console
error, a short screen recording of the bug reproducing) instead of
describing it in prose or pasting it into a separate tool. Stored via
**GridFS in the same MongoDB the user already configured** (BYODB,
`00-README.md` constraint 1) — not a new external storage dependency, and
not a separate metadata collection either: GridFS's own `metadata`
subdocument on each file *is* the record, so there's exactly one place
this data lives, not two kept in sync.

```typescript
interface AttachmentDoc {
  _id: ObjectId;              // the GridFS file's own _id in the `vayo_attachments` bucket
  commentId: string | null;   // set once claimed by a real message — see below
  vayoId: string;             // denormalized from the eventual comment, for a fast authorization check
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: "file" | "screen-recording";
  uploadedBy: string;
  uploadedAt: string;
}
```

**Indexes:** on the GridFS bucket's own `vayo_attachments.files` collection —
`{ "metadata.vayoId": 1 }` and `{ "metadata.commentId": 1 }`.

Uploaded *before* the comment exists — `POST /api/attachments` (multipart,
one file per call) stores the bytes and returns metadata with `commentId:
null` immediately, so multiple files/recordings can sit as pending chips in
the sender's compose box before they hit Send. `POST /api/comments`'s
`attachmentIds` field then claims them: `db.claimAttachments` sets
`commentId` on any of those ids that are still unclaimed *and* were
uploaded by the same actor — silently skipping anything already claimed,
uploaded by someone else, or nonexistent, rather than failing the whole
comment over one stale id. An attachment removed from the compose box
before sending (`DELETE /api/attachments/:id`, same unclaimed-and-same-
uploader check) is deleted outright; one abandoned by closing the tab
mid-compose is a known, accepted storage leak for v1, not cleaned up by a
background job yet.

Capped at **40MB per file** (`MAX_ATTACHMENT_BYTES`, enforced by `multer`'s
own size limit before the bytes ever reach GridFS, returning a clean `413`)
— screen recordings and log bundles are the intended use, not a
general-purpose file-sharing bucket, and an unbounded cap would let a large
video meaningfully bloat the size of the user's own operational database
and its backups.

`GET /api/attachments/:id/download` additionally accepts the session token
as a `?token=` query parameter, not just the `Authorization` header — the
one exception to header-only auth anywhere in this API, scoped to exactly
this route (`05-security.md` §7 explains why: an `<img>`/`<video>` tag
embedding this URL directly can't set a custom header at all).

Backs the header bell — an aggregated feed of real events across every
endpoint, so a team member can see what changed without visiting each
endpoint's History tab individually. Deliberately automatic-only for v1: no
hand-authored announcements.

```typescript
type NotificationType = "override" | "schema_change" | "comment" | "version_status";

interface NotificationDoc {
  _id: ObjectId;
  type: NotificationType;
  vayoId: string | null;    // null for a version-level event (version_status)
  actorId: string | null;   // null for schema_change — system-detected, not a human action
  message: string;          // human-readable, composed once at write time
  mentionedMemberIds: string[]; // @mentioned in a "comment" message — empty for every other type
  targetId: string | null;  // comment's own _id for "comment"; null for every other type
  createdAt: string;
}
```

**Indexes:** `{ createdAt: -1 }`. Written alongside the existing write path
for each event type — `applyOverride`/`addComment` (both the REST route and
the equivalent socket handler) in `@vayo/server`, and `db-mongo`'s own
`upsertEndpoint` for `schema_change`. A `schema_change` notification is only
created when a *previously known* endpoint's schema actually changes — the
very first sample for a brand-new endpoint is a discovery, not a change, and
would otherwise flood the feed with one notification per endpoint on a fresh
install's first day of traffic.

`targetId` exists purely so the UI's `NotificationBell`/`DocsApp` can jump to
*exactly* the right place on click, not just the right endpoint: for a
"comment" notification it's the comment's own `_id`, letting Team Chat scroll
to and briefly highlight that specific message (the same mechanism a
reply-quote jump uses) instead of just opening the tab and leaving the
member to scroll and find it themselves. Every other type leaves it `null` —
`override` and `schema_change` only need to land on the right tab (Details,
History), not a specific DOM node within it.

`mentionedMemberIds` doesn't create a second, per-recipient notification —
the bell stays one shared feed everyone sees, same as every other entry;
this field just lets that shared entry render as "you were mentioned" for
whichever member's id appears here, alongside its ordinary "X commented"
framing for everyone else.

Unread state is a single cursor, not a per-notification read receipt:
`TeamMemberDoc.lastSeenNotificationsAt` (`vayo_team_members`, above) — a notification is "unread"
for a member if it was created after that timestamp, and simple enough to be
correct at the team sizes this product targets. A member's own actions are
never counted as unread for themselves.

## `vayo_api_versions`

```typescript
interface ApiVersionDoc {
  _id: ObjectId;
  version: string;             // "v1", "v2"
  status: "active" | "deprecated" | "sunset";
  basePathPattern: string;     // e.g. "/api/v{n}" used to resolve version from captured paths
  deprecatedAt: string | null;
  sunsetAt: string | null;
}
```

## `vayo_sessions`

```typescript
interface SessionDoc {
  _id: ObjectId;
  memberId: string;
  tokenHash: string;
  expiresAt: string;
}
```

## `vayo_audit_log`

Append-only. Powers both the global "who changed what, when" record *and* the
per-endpoint **History** tab in the UI (filter by `targetId` = a given
`vayoId`, sorted by `at`) — never mutated, only inserted.

```typescript
interface AuditLogDoc {
  _id: ObjectId;
  actorId: string;           // team_members._id, or the literal string "system"
  actorType: "human" | "system";
  action:
    | "override"
    | "comment"
    | "invite"
    | "role_change"
    | "schema_change"
    | "endpoint_created"
    | "endpoint_deleted"
    | "member_removed"
    | "invite_revoked";
  targetId: string;
  fieldPath: string | null; // which field changed, for "override" (e.g. "notes"); null otherwise
  diff: { before: unknown; after: unknown } | null;
  at: string;
}
```

`schema_change` entries are written automatically by `schema-engine` whenever
`mergeCapturedSample` (`04-capture-engine.md`) changes an endpoint's inferred
schema — e.g. a new optional field appears in a response. This is what makes
the History tab useful from day one, before any human has touched the
endpoint: it already shows "this response gained a `preferences` field on
2026-07-02" purely from observed traffic.

`fieldPath` exists because `diff.before`/`diff.after` alone can't say *which*
field an override touched — only its raw value. Without it, the History tab
could show an override happened and what the value became, but never what
it was an override *of*. Only `"override"` sets it to a real path today;
every other action's diff already names its own shape (`role_change`'s is
always the role; `schema_change`'s before/after are whole schema objects,
diffed field-by-field by the History tab itself, not by this field).

(An `"endpoint_visibility"` action existed in this enum but was never
actually written by any code path — no feature ever used it. Removed rather
than left as a dead entry the History tab's UI would otherwise have to
account for.)

`member_removed` (`targetId` = the removed member's own id, `diff.before` =
`{email, name, role}`, `diff.after` = `null`) and `invite_revoked`
(`targetId` = the invite's own id, `diff.before` = `{email, role}`) are
written by `DELETE /api/team/:memberId` and `DELETE
/api/team/invites/:inviteId` respectively (`05-security.md` §4a) — same
convention `role_change`/`invite` already use (a raw entity id as `targetId`,
not a `vayoId`), and the same caveat applies: none of these four
team-administration actions are reachable through the per-endpoint History
tab's `targetId`-as-`vayoId` lookup, since a memberId/inviteId never matches
one. They're written for a complete audit trail regardless.

## Manual endpoints & folders

Postman-parity organization, added without compromising "zero manual
annotation" for endpoints that *are* captured — this is a deliberate,
additive escape hatch, not a replacement.

**Manual endpoints:** a team member can create a placeholder `EndpointDoc`
from the UI (e.g. to document a planned route) with `source: "manual"`,
via the same `stableHash(method, pathTemplate, version)` real capture would
use. If real traffic later hits that exact route, `upsertEndpoint`'s normal
find-by-`vayoId`-then-merge path takes over with zero special-casing — the
doc's `source` naturally becomes `"merged"`, exactly like `"static"` does.

**Deleting an endpoint** (`DELETE /api/endpoints/:vayoId`, `05-security.md`
§4b) is restricted to `source: "manual"` docs only — a captured endpoint
(`"runtime"`/`"static"`/`"merged"`) is re-derived from the user's real API on
the next scan or the next request, so deleting it here would just have it
silently reappear; the only real way to remove it from the docs is to remove
the route in the backend itself. The compiled OpenAPI spec exposes an
endpoint's `source` as `x-vayo-source` (`02-architecture.md`) precisely so
the UI can decide, per endpoint, whether to offer a delete action at all.
Writes an `endpoint_deleted` audit entry (`diff.before` = `{method,
pathTemplate}`, `diff.after` = `null`) — the mirror image of
`endpoint_created`.

**`vayo_folders`** — the organizable sidebar tree:

```typescript
interface FolderDoc {
  _id: ObjectId;
  name: string;
  parentId: string | null;  // null = root level
  version: string;          // folders are scoped per API version, like endpoints
  order: number;            // sort key among siblings
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

**Indexes:** compound `{ version: 1, parentId: 1, order: 1 }`.

**Endpoint → folder assignment is NOT a new collection** — it's an
`OverrideDoc` like any other: `targetId = "${vayoId}.folderId"` and
`"${vayoId}.order"`. This means placement is non-destructive and
audit-logged for free through the existing override machinery, and
`resolveEndpoint` needs zero changes to surface it. The UI's drag-and-drop
sidebar refuses to write a *different* `folderId` for an endpoint whose
`groupSource` is `"declared"` (an explicit `@group` tag, above) — it can
still reorder that endpoint among its current folder's own siblings (a same-folder
`.order` change), just not relocate it elsewhere; see
`04-capture-engine.md` Step 2 #4 for the reasoning.

**Deleting a folder** reparents its direct sub-folders *and* any endpoints
placed in it to the deleted folder's own parent — never silently orphans or
cascade-deletes anything, the same principle that governs every other
destructive-looking action in this system.

**Auto-organizing by detected group:** `VayoDbAdapter.autoOrganizeFolders(version, actorId)`
resolves `group` as a "/"-separated path (e.g. `"Admin/Users"`), creating
(or reusing) one folder per segment nested under the previous one — a
flat, single-segment `group` still resolves to exactly the one top-level
folder it always did. It places every endpoint that has *never been placed
anywhere* (no `folderId` override of any kind — including one explicitly
set to root by a human, which is itself a placement) into its group's
(deepest/leaf) folder. Additive only for an `"inferred"` group: re-running
it after a human has since reorganized things only picks up whatever's
still unplaced, the same non-destructive philosophy as overrides.

The one exception is a **`"declared"`** group (`groupSource`, above) — a
human is never allowed to move that endpoint's folder in the first place,
so if its already-placed folder no longer matches its *current* `group`
value (the `@group` tag changed since it was last placed), this is the one
place it's allowed to self-heal: re-placed into the new matching folder
(creating it if needed), with a freshly-appended `order`. Left completely
untouched — including `order` — when the current folder already matches,
so a human's own same-folder reordering of a "declared" endpoint always
survives a rescan.

`vayo scan` (`vayo`) runs this automatically once per version
touched; `POST /api/folders/auto-organize` exposes the same behavior for
teams that add manual endpoints straight from the UI.

## Environments & variables

**`vayo_environments`** — named variable sets for the Try It Now tab's
`{{variable}}` interpolation (Postman's environments, equivalently):

```typescript
interface EnvironmentDoc {
  _id: ObjectId;
  name: string;                      // "Development", "Staging", "Production"
  variables: Record<string, string>;
  isDefault: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

These are user-entered convenience values the team explicitly manages
(e.g. a dev bearer token, a staging base URL) — not captured production
traffic, so none of `05-security.md`'s redaction rules apply to them; the
team is responsible for what they put here, same as a `.env` file they'd
otherwise maintain themselves.

## Scripts & flows

Executed **entirely client-side**, never server-side — running arbitrary
team-authored JavaScript on our own infrastructure would be a real
code-execution risk, a hard line, not a style choice. The UI runs both in a
sandboxed Web Worker with no access to `window`, `document`, `localStorage`,
or the page's own cookies/fetch — only an injected `pm`-like object
(`pm.test`, `pm.expect`, `pm.response`, `pm.environment.get/set`). This
isolates *accidents* (infinite loops, crashes) and blocks DOM/storage
access; it is not a hardened multi-tenant sandbox, and doesn't need to be —
a script's author is already a logged-in team member, the same trust level
as writing an override reason or a comment.

**`vayo_test_scripts`** — one pre-request + test script pair per endpoint:

```typescript
interface TestScriptDoc {
  _id: ObjectId;
  vayoId: string;
  preRequestScript: string; // JS, runs before sending — set/derive variables
  testScript: string;       // JS, pm.test()/pm.expect() style, runs after the response
  lastRun: {
    status: "pass" | "fail";
    results: Array<{ name: string; passed: boolean; error?: string }>;
    at: string;
  } | null;
  updatedBy: string;
  updatedAt: string;
}
```

**Indexes:** unique on `vayoId`.

**`vayo_flows`** — ordered, related-endpoint sequences (Postman's Collection
Runner equivalent — e.g. "login, then use the token to call a protected
endpoint"):

```typescript
interface FlowDoc {
  _id: ObjectId;
  name: string;
  version: string;
  steps: Array<{
    vayoId: string;
    extractVariables?: Record<string, string>; // e.g. { authToken: "response.body.token" }
  }>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
```

Flow execution is a sequence of ordinary client-side requests (reusing Try
It Now's own request logic), piping each step's extracted values into a
variable bag that later steps interpolate via the same `{{var}}` mechanism
as environments.

## Resolving a read: the merge function

`openapi-compiler` and `@vayo/server`'s resolver both call the same pure
function — implement it once in `schema-engine`, import everywhere:

```typescript
function resolveEndpoint(
  endpoint: EndpointDoc,
  overrides: OverrideDoc[],   // pre-filtered to this endpoint's vayoId
): ResolvedEndpoint {
  // start from endpoint, apply each override at its fieldPath,
  // last updatedAt wins per field, never touches the underlying EndpointDoc
}
```

Keep this function pure (no DB calls inside it) — it's the single most
unit-testable piece of the whole system, and its correctness is what the
"re-scans never destroy manual edits" promise actually rests on.
