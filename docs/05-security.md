# 05 — Security

Vayo's entire value proposition rests on "your data never leaves your
database." That promise is only as good as this document's enforcement. Every
package that touches captured data, credentials, or role checks must be built
against this file, not against convenience.

## 1. Threat model summary

| Actor | Capability | What must not happen |
| --- | --- | --- |
| A `viewer`-role team member | Authenticated, read + comment only | Must not be able to call override/delete/invite endpoints even by hitting the API directly (not just hidden in UI) |
| An unauthenticated visitor | Can reach `/vayo` if the docs-viewer auth gate is off | Should never see request bodies containing secrets, even if the underlying API itself leaks them |
| A malicious/compromised dependency | Runs inside the capture middleware's process | Must not be able to exfiltrate the Mongo URI or captured data anywhere outside the user's own DB — no telemetry, no phone-home, ever |
| An attacker with a stolen invite link | Has the raw token | Token must be single-use, short-lived, and scoped to exactly one role |

## 2. Capture-time redaction (before anything is stored)

This runs inside `capture-express`'s `recordSample`, before data reaches
`genson-js` or `db-mongo`. Non-negotiable for v1:

- **Never store the `Authorization` header's value.** Only store a boolean:
  was one present. (`requestHeaders: { authorization: true }` — see the
  `CapturedSample` shape in `03-data-model.md`.)
- **Deny-list field-name redaction**, applied recursively to request/response
  bodies before schema inference: any key matching
  `/password|token|secret|apikey|api_key|ssn|credit ?card|cvv|authorization/i`
  has its *value* replaced with a `"[REDACTED]"` sentinel before it's shown to
  `genson-js` — the field's presence and type are still inferred (so the schema
  still documents "there's a `password: string`"), only the real value is
  scrubbed.
- **The deny-list is user-configurable** (`vayo.config.js` → `redact: [...]`),
  additive to the default list, never replacing it.
- **Examples are marked `redacted: true`** whenever any scrubbing occurred on
  that sample, and the UI must show this as a visible badge — never silently
  present a scrubbed example as if it were complete.
- **Sample volume is capped** (`03-data-model.md`, `vayo_examples`) both to
  bound storage growth and to reduce the surface of stored real data over time.

## 3. Auth-requirement detection — what it is and isn't

Auto-detecting whether an endpoint requires a token (`04-capture-engine.md` §3)
is a **documentation aid, not a security control**. It tells a docs reader "this
looked protected when we last checked" — it must never be used as the actual
authorization mechanism for anything Vayo itself does. Concretely:

- Vayo's own API (`@vayo/server`) has its own independent auth/session
  layer (§4, §5) that does not depend on or trust the `authRequired` field.
- If detection is wrong (marks a protected endpoint as public, or vice versa),
  the blast radius is "the documentation is momentarily misleading," never "an
  actual endpoint became reachable without auth." Vayo does not sit in the
  request path of the user's real API in a way that could enforce or bypass
  anything.

Everything above applies identically to `authType`'s one auto-detected value,
`"cookie"` (`04-capture-engine.md` §3b) — inferred from a *presence* signal
(was a `Cookie` header there at all), same "documentation aid" posture, never
a claim strong enough to act on. It's also why the underlying signal is safe
to compute in the first place: `CapturedSample.requestHeaders.cookie` is a
boolean, same as `.authorization` — the cookie's actual name and contents are
never read, stored, or inspected anywhere in this pipeline.

## 3a. Scope tags — same principle, one extra caution

The `scopes` field (e.g. `customer:read`, `admin:read`, shown as tags in the
endpoint header) is subject to the identical rule: **displayed for a reader's
benefit, never consulted by Vayo to make an access decision.** One additional
consideration specific to scopes: unlike a bare "requires auth" badge, a full
scope list can reveal the shape of an API's internal permission model (e.g.
that an `admin:*` tier exists at all) to anyone who can view the docs. This is
a reasonable default for a team's internal docs, but is the concrete case worth
pointing to when recommending the docs-viewer auth gate (§5) be turned on by
default for any deployment that might be reachable outside a trusted network —
scopes are documentation the team almost certainly wants gated, even on an
otherwise-permissive setup.

## 4. Role enforcement — server-side, always

`viewer` / `editor` / `owner` (from `03-data-model.md`) are enforced in
`@vayo/server`'s route handlers themselves, not inferred from what the UI
shows:

```typescript
// every mutating route in @vayo/server, not just some of them
router.post("/api/overrides", requireRole("editor"), handler);
router.post("/api/team/invite", requireRole("owner"), handler);
router.patch("/api/team/:memberId/role", requireRole("owner"), handler);
```

`requireRole` re-reads the session's role from `vayo_team_members` on every
request — it does not trust a role claim embedded in a client-supplied token
without verifying it server-side against the current DB state (so a demoted
editor loses access on their very next request, not whenever their token
happens to expire).

**Why three roles, not granular per-action permissions.** Auditing every
route by its `requireRole` argument shows a clean split with no bundled-together
concerns to tease apart: `viewer` is everything read-only plus Team Chat
(discussing an endpoint isn't editing it); `editor` is every single
content-mutation there is — overrides, folders, manual endpoints,
environments, Flows, API versions, resolving a flagged comment — which is
all one job ("maintain the docs"), not several; `owner` is *only* team
administration — `POST /api/team/invite`, `POST /api/team/invite/bulk`,
`PATCH /api/team/:memberId/role`,
`DELETE /api/team/:memberId`, `GET /api/team/invites`, `DELETE
/api/team/invites/:inviteId` — nothing else. There's no route today that's
owner-gated for any reason other than team membership itself. Splitting
`editor` into finer permissions (e.g. "can edit folders but not
environments") would invent distinctions real teams don't organize around,
for a tool whose actual scale is one team's own internal docs, not a
multi-tenant SaaS with segregation-of-duties requirements. If a genuine need
for a differently-scoped role shows up, add one — but don't build a
permission-matrix UI speculatively against a threat model this project
doesn't have.

## 4a. Removing a member or a pending invite

`DELETE /api/team/:memberId` (owner-only) is a hard delete of the
`vayo_team_members` document — no separate revocation step is needed for
that to take effect immediately: `resolveAuth` (§4, above) already re-reads
`vayo_team_members` on every single request and rejects when the lookup
returns nothing, the exact mechanism that makes a demoted editor lose access
on their next request. A removed member's session rows are also deleted for
hygiene, but that's not what actually blocks them — the member-lookup miss
already does. Their past comments, audit-log entries, and notifications are
left untouched (constraint #3's "overrides are additive, never destructive,"
applied to team membership itself) and render as "Former member" wherever
their name would have appeared.

Two guards, both server-side regardless of what the UI shows or hides:

- **Can't remove yourself through this route** — same reasoning as `PATCH
  /api/team/:memberId/role` already refusing to let an owner change their
  own role: a client-supplied intent to self-modify the one thing gating
  further changes is never trusted, even from a legitimate owner acting on
  themselves.
- **No separate "last owner" check is needed.** This route requires the
  *caller* to already be an owner. If only one owner exists at all, that
  owner is necessarily the caller — and the self-removal guard above already
  blocks that case. The team can never reach zero owners through this route.

`DELETE /api/team/invites/:inviteId` (owner-only) revokes a not-yet-accepted
invite — for the same mistake one step earlier: an invite sent to the wrong
address, before anyone's redeemed it. It deletes the `vayo_invites` document
outright (`usedAt` must still be `null`), so the raw token — already only
ever held by whoever the inviter shared it with, never stored unhashed
(§5, below) — simply stops resolving to anything on the next
`accept-invite` attempt.

`PATCH /api/team/me/name` (any authenticated member, self only) lets a
member correct their own display name after the fact. There is no
owner-editing-another-member's-name route: the invitee already picks their
own name once, at `accept-invite` time, so correcting it later stays
self-service too — an owner has never been the one to set anyone else's name
in the first place.

`PATCH /api/team/:memberId/nickname` looks like it edits someone else, but
doesn't: it writes into the *caller's own* `nicknames` map (docs/03-data-model.md),
never `:memberId`'s doc, so it's `requireRole("viewer")` — open to any
authenticated member, the same as the self-service routes above, not
owner-gated like the actual account-management routes (`role`, remove,
revoke-invite) elsewhere on this router. `GET /api/team`'s roster list
strips every member's own `nicknames` map before returning it (nobody's
private "how I refer to people" book is anyone else's business) — only
`GET /api/me` ever returns the caller's own.

## 4b. Deleting a folder or a manual endpoint

`DELETE /api/folders/:id` (editor) never cascades: it reparents the folder's
direct sub-folders *and* any endpoints placed inside it to the deleted
folder's own parent (`03-data-model.md`), so a deletion can never silently
take other people's placements down with it. The UI backs this with a
confirmation step before the request ever fires, but that's a courtesy, not
the control — the server would behave identically if the request arrived
with no confirmation UI in front of it at all.

`DELETE /api/endpoints/:vayoId` (editor) only ever deletes the `EndpointDoc`
outright when at least one of two conditions holds: `source === "manual"`
(a human-created placeholder that no capture path has touched yet), or
`possiblyRemovedSince` is set (the most recent `vayo scan` didn't re-find
this route — `04-capture-engine.md` §3d). Absent either condition, the
request 400s — a still-confirmed captured endpoint reflects a route that,
as far as Vayo can tell, still exists in the user's real API, so deleting
the doc here would just have `upsertEndpoint`/`upsertStaticResult` recreate
it on the very next request or scan, silently undoing the delete. This is
checked server-side by re-reading the endpoint's own `source` and
`possiblyRemovedSince` fields on every request, the same "never trust what
the UI already hid" posture as every other role/ownership check in this
document — a still-confirmed captured endpoint's Delete action isn't
rendered in the UI at all, but that's the courtesy layer, not the
enforcement. Writes an `endpoint_deleted` audit entry (`03-data-model.md`).

## 4c. Code-declared fields a human can't silently override

Two fields carve out a narrow, deliberate exception to this app's usual
"manual override always wins" rule — everywhere else, a human's edit
always beats whatever the code or runtime capture says. In both cases
below, the code is treated as the more authoritative source instead, and
the restriction is enforced server-side, not just by hiding the control in
the UI (same posture as every rule in this document):

- `PATCH /api/endpoints/:vayoId/placement` (editor) refuses to move an
  endpoint whose `groupSource` is `"declared"` (an explicit `@group` tag,
  `04-capture-engine.md` Step 2 #4) to a folder other than its current
  one — same-folder reordering still goes through. Only applies once a
  placement override already exists; a brand new "declared" endpoint with
  no placement yet has nothing to diverge from, so its first placement is
  never blocked.
- `PATCH /api/endpoints/:vayoId/deprecated` (editor) refuses to set
  `deprecated: false` for an endpoint whose `deprecatedSource` is
  `"declared"` (an explicit `@deprecated` tag, Step 2 #4a). A human can
  still freely flag any NOT-code-declared endpoint deprecated (or not).

Both routes 404 for an unknown `vayoId` and require `editor` role, same as
every other mutating endpoint route.

## 5. Docs-viewer authentication

Two supported modes, both documented in `08-packages-and-repo-structure.md` for
`@vayo/server`:

1. **Delegated auth** — Vayo validates the user's *existing* session
   cookie/JWT against a function the developer supplies
   (`authMiddleware: (req) => AuthResult`), so teams don't stand up a second
   login system. Vayo never sees the user's real password in this mode.

   **This is also Vayo's SSO story, today, with no additional code.**
   `authMiddleware` just needs to read whatever the *host app's own*
   session already contains — and a team behind Okta/Azure AD/Google
   Workspace SSO (or any SAML/OIDC provider) almost always already
   terminates that SSO handshake in their own Express app, via their own
   middleware (`passport-saml`, `openid-client`, their IdP's own SDK,
   whatever they've already wired up), landing on a plain `req.user`/
   `req.session` object same as any other authenticated request. Vayo's
   `authMiddleware` reads *that* — it never speaks SAML/OIDC itself, the
   same way it never speaks whatever session-cookie format the host chose.
   Concretely: `authMiddleware: (req) => req.user ? { memberId: req.user.id, role: lookupRole(req.user) } : null`.
   The one thing this doesn't give a team today is Vayo *enforcing* that
   SSO is the only login path (that enforcement lives entirely in the host
   app choosing not to expose any other one) — worth being explicit about
   for a team evaluating this against a product with SSO as a literal,
   separately-configured feature of its own.
2. **Standalone auth** — for teams with no existing session system, Vayo
   manages its own `vayo_team_members` + `vayo_sessions`. Passwords are
   hashed with `bcrypt` (or `argon2id` if available in the target environment) —
   **never stored or logged in plaintext**, and never included in any API
   response, including to `owner`-role callers.

   In this mode `vayo_team_members` starts empty, and the invite flow
   (`POST /api/team/invite`, `owner`-only) needs an existing owner to send an
   invite in the first place — so a brand-new deployment needs one
   out-of-band bootstrap step before anyone can sign in at all. That step is
   `vayo create-owner` (`packages/cli`): it hashes the given password with
   the same `bcrypt` cost factor as the signup route and inserts a single
   `role: "owner"` document directly, refusing if that email already exists.
   It's a one-time setup command, not a general user-management API — every
   `owner`/`editor`/`viewer` created after that first one goes through the
   normal invite flow like anyone else.

Invite links (`vayo_invites`): the raw token is generated once, returned to
the inviter to share themselves (email/Slack/whatever they already use), and
**only the HMAC hash is stored** — Vayo cannot regenerate a lost invite link;
a new one must be issued. Tokens expire (default 7 days) and are single-use
(`usedAt` set atomically on redemption, checked-and-set in one operation to
prevent a race where two people redeem the same link simultaneously).

`POST /api/team/invite/bulk` (owner-only, same `inviteRateLimiter` as the
single-invite route) batches *creation* of several invites sharing one role
into one request — up to `MAX_BULK_INVITES` (50, a defensive cap against one
request creating an unbounded number of invite documents, not a realistic
onboarding-batch limit) — but changes nothing about the security model above:
it's still N independent single-use, individually-revocable tokens, one per
email, each going through the exact same `createOneInvite` helper the
single-invite route calls. There is deliberately no reusable "anyone with
this link can join" invite mode — that would trade the single-use property
for convenience, and bulk creation solves the actual problem ("invite my
whole frontend team at once") without that tradeoff.

## 6. Realtime (Socket.IO) auth

Every socket connection authenticates during the handshake using the same
session token validated in §5 — not a separate, weaker mechanism. Room
membership (`06-realtime-collaboration.md`) is re-checked server-side before
accepting any mutating event (`comment:new`, `override:updated`); a `viewer`
role socket that emits an override event is rejected server-side even if the
client UI would never normally let them try.

## 7. Operational hygiene

- The Mongo connection string is read from an environment variable
  (`VAYO_MONGO_URI`) or a secrets manager the user already has — never
  written to a committed config file, and never logged, including in error
  messages (redact the credentials portion of the URI in any log output).
- All `@vayo/server` inputs are validated with `zod` at the route boundary
  before touching any DB call — no raw `req.body` reaches a Mongo query.
- CORS on `@vayo/server`'s API defaults to same-origin-only unless the user
  explicitly configures allowed origins.
- Basic rate limiting on the invite-generation and login endpoints specifically
  (these are the two most abuse-prone routes) — a token-bucket limiter per IP is
  sufficient for v1.
- Dependency hygiene: lockfile committed, `npm audit`/`pnpm audit` in CI on every
  PR, Dependabot (or equivalent) enabled from day one — this is cheap and
  prevents the project from becoming the soft target in someone else's supply
  chain.
- Team Chat attachments (`vayo_attachments`, `03-data-model.md`) are capped
  at 40MB per file, enforced by `multer` before the bytes ever reach GridFS
  — this is a chat-attachment store for screenshots/recordings/log bundles,
  not an unbounded file-sharing bucket that could meaningfully bloat the
  user's own operational database and its backups.
- `GET /api/attachments/:id/download` is the **one route in this API** that
  also accepts the session token as a `?token=` query parameter instead of
  the `Authorization` header. This exists because that URL gets embedded
  directly in an `<img>`/`<video>` tag for inline preview, and neither can
  set a custom header — there's no other way for the browser to authenticate
  that request at all. Scoped narrowly (a regex match on this one path in
  the auth middleware, `packages/server/src/index.ts`) rather than accepted
  globally, since a token in a URL is more exposed — server access logs,
  browser history — than one in a header, and every other route keeps
  requiring the header.

## 8. What Vayo must never do, stated plainly

- Never make an outbound network call containing captured request/response data,
  to any Vayo-operated or third-party endpoint, for any reason (no telemetry
  "to improve the product," no crash reporting that includes payloads).
- Never store a raw credential (password, API key, session secret) anywhere
  except as a salted hash, and never in a log line.
- Never let a client-supplied role claim be trusted without a server-side
  re-check against the current database state.
