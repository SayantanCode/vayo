// @vayo/types — the shared contract every other Vayo package codes against.
// Source of truth: docs/03-data-model.md. If you change a shape here,
// update that doc in the same commit — they must never drift apart.

/** A JSON Schema document/fragment. Kept as `unknown`-friendly rather than
 * pulling in a full JSON Schema type dependency for v1 — tighten this once
 * @vayo/schema-engine's actual inference output shape is finalized. */
export type JSONSchema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The generic, stack-agnostic capture format (docs/03-data-model.md)
// Every capture-<stack> package must emit exactly this shape.
// ---------------------------------------------------------------------------
export interface CapturedSample {
  method: string;
  pathTemplate: string;
  version: string;
  requestHeaders: Record<string, boolean>;
  requestParams: Record<string, unknown>;
  requestQuery: Record<string, unknown>;
  requestBody: unknown | null;
  /** Top-level keys of `requestBody` that are uploaded files (multer's
   * `req.file`/`req.files`, or an equivalent for a future capture-<stack>
   * package) rather than plain JSON values. `schema-engine` uses this to
   * mark those properties `format: "binary"` after inference instead of
   * guessing from the placeholder value alone. Omitted/empty for ordinary
   * JSON bodies. */
  requestBodyFileFields?: string[];
  responseStatus: number;
  responseBody: unknown | null;
  middlewareNames: string[];
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// vayo_endpoints
// ---------------------------------------------------------------------------
export type AuthType = "bearer" | "apiKey" | "basic" | "cookie" | null;
/** "manual" is a team member creating a placeholder entry from the UI
 * (e.g. to document a planned route) before any real traffic exists — see
 * docs/03-data-model.md "Manual endpoints". If real traffic later hits that
 * exact (method, pathTemplate, version), `upsertEndpoint`'s normal
 * find-by-vayoId-then-merge path takes over with no special-casing, the
 * same way "static" naturally becomes "merged". */
export type EndpointSource = "runtime" | "static" | "merged" | "manual";

export interface EndpointDoc {
  _id: string;
  vayoId: string;
  method: string;
  pathTemplate: string;
  version: string;
  group: string;
  summary: string | null;
  /** Markdown (with embedded Mermaid diagram support in the UI) explaining
   * how this endpoint fits into a larger frontend workflow — e.g. "this
   * endpoint's response.id feeds the next endpoint's categoryId param."
   * Set via the same override mechanism as every other field
   * (docs/03-data-model.md "Resolving a read"), not a separate collection. */
  notes: string | null;
  authRequired: boolean;
  authType: AuthType;
  scopes: string[];
  middlewareChain: string[];
  requestSchema: JSONSchema | null;
  /** How `requestSchema` was populated, when it's non-null — surfaced in the
   * UI (an "inferred, not confirmed" badge) so a schema guessed from a
   * Mongoose model's *storage* shape isn't shown with the same confidence
   * as one the app's own validator actually enforces, or one literally
   * observed from real traffic:
   *   - "declared" — traced from a Zod (or equivalent) schema the code
   *     itself validates `req.body` against (docs/04-capture-engine.md
   *     Step 2 #3). Requests that reach the handler are guaranteed to
   *     match it, by construction — high confidence despite zero traffic.
   *   - "inferred" — traced from a Mongoose model's schema definition
   *     (Step 2 #3b) because the handler passes `req.body` straight into a
   *     model-write call. Reflects the *stored document's* shape, which
   *     may be a superset (extra server-stamped fields) or subset (a PATCH
   *     accepting only some fields) of what a given route actually
   *     requires — a best-effort default, not a guarantee.
   *   - "observed" — real captured traffic has contributed to this schema
   *     (`mergeCapturedSample`), the highest-confidence tier regardless of
   *     how the schema originally got its declared/inferred starting
   *     shape, since real requests have now been confirmed against it.
   * `null` exactly when `requestSchema` is. */
  requestSchemaSource: "declared" | "inferred" | "observed" | null;
  responseSchemas: Record<string, JSONSchema>;
  paramsSchema: JSONSchema | null;
  /** Schema inferred from `CapturedSample.requestQuery` — query-string
   * parameters (pagination, filtering, sort). Mirrors `paramsSchema` exactly
   * (same merge rule, same "only runtime capture populates it" boundary);
   * kept as a separate field rather than folded into `paramsSchema` since
   * OpenAPI represents path (`in: "path"`) and query (`in: "query"`)
   * parameters distinctly, and Postman's URL object keeps them in separate
   * arrays (`path` segments vs. `query`) too. */
  querySchema: JSONSchema | null;
  source: EndpointSource;
  sampleCount: number;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  /** Set the moment a `vayo scan` run completes without re-finding this
   * endpoint (docs/04-capture-engine.md §3d) — only ever applies to an
   * endpoint whose `source` includes a static contribution ("static" or
   * "merged"); a purely "runtime"/"manual" endpoint was never subject to
   * static confirmation in the first place, so its absence from a scan
   * means nothing. Cleared automatically the moment either a later scan
   * re-finds it, or real traffic hits it again — both are positive
   * evidence it's still there. Exists specifically so a genuinely-removed
   * route's doc entry doesn't sit in `vayo_endpoints` forever with no path
   * to disappear: once flagged, deleting it through the docs no longer
   * risks "it'll just reappear next scan" (docs/05-security.md §4b). */
  possiblyRemovedSince: string | null;
}

// ---------------------------------------------------------------------------
// vayo_overrides — the non-destructive diff layer (docs/03-data-model.md)
// ---------------------------------------------------------------------------
export interface OverrideDoc {
  _id: string;
  targetId: string; // `${vayoId}.${fieldPath}`
  value: unknown;
  updatedBy: string;
  updatedAt: string;
  reason: string | null;
}

/** The result of merging an EndpointDoc with its overrides. Pure, no I/O —
 * see docs/03-data-model.md "Resolving a read" for the function this backs. */
export type ResolvedEndpoint = EndpointDoc & { overridden: string[] };

// ---------------------------------------------------------------------------
// vayo_examples
// ---------------------------------------------------------------------------
export interface ExampleDoc {
  _id: string;
  vayoId: string;
  statusCode: number;
  requestBody: unknown | null;
  responseBody: unknown | null;
  capturedAt: string;
  redacted: boolean;
  /** True for a response a team member explicitly saved from Try It Now
   * (the "saved responses" feature) — exempt from the N=5 rolling-cap
   * deletion that applies to auto-captured examples (docs/03-data-model.md). */
  pinned: boolean;
  /** Optional human label for a pinned example, e.g. "Successful login". */
  label: string | null;
}

// ---------------------------------------------------------------------------
// vayo_team_members / vayo_invites / vayo_sessions
// ---------------------------------------------------------------------------
export type TeamRole = "owner" | "editor" | "viewer";

export interface TeamMemberDoc {
  _id: string;
  email: string;
  name: string;
  role: TeamRole;
  passwordHash: string | null;
  status: "active" | "invited";
  invitedBy: string | null;
  createdAt: string;
  /** Cursor for the notification bell's unread count — everything in
   * `vayo_notifications` created after this timestamp is "unread" for this
   * member. Simpler than a per-notification read-receipt array, and correct
   * at the team sizes this product targets (docs/06-realtime-collaboration.md).
   * `null` until the member opens the bell for the first time. */
  lastSeenNotificationsAt: string | null;
  /** A self-uploaded profile picture as a `data:` URI (already base64,
   * capped at `MAX_AVATAR_BYTES` before encoding) — not a reference into
   * `vayo_attachments`, since that GridFS bucket is keyed by `vayoId` (an
   * endpoint), and a profile picture isn't tied to one. Storing the whole
   * image inline keeps rendering a one-line `<img src>` with no separate
   * authenticated download route to build. `null` renders as an
   * initials-in-a-circle fallback client-side. */
  avatarUrl: string | null;
  /** Set to "now" the moment this member's last Socket.IO connection
   * disconnects (realtime.ts) — read only when they're NOT currently
   * online (docs/06-realtime-collaboration.md "Presence"); while online,
   * the UI shows "Online now" from the live socket state instead. `null`
   * for a member who has never had a realtime connection at all (e.g. one
   * who accepted an invite but hasn't opened the docs yet). */
  lastSeenAt: string | null;
  /** This member's own private "contact book": `targetMemberId -> nickname`
   * for how THEY personally refer to another member, independent of that
   * member's own self-chosen `name` — the same idea as a chat app's
   * per-contact nickname (you might save a colleague as "Team Lead" while
   * someone else still sees them by their real name). Never exposed to
   * anyone but the member who owns it — `GET /api/team`'s roster strips
   * every member's own `nicknames` map before returning the list, and only
   * `GET /api/me` returns the caller's. A missing key (not an empty-string
   * value) means "no nickname set, show their real name." */
  nicknames: Record<string, string>;
}

export interface InviteDoc {
  _id: string;
  tokenHash: string;
  email: string;
  role: Exclude<TeamRole, "owner">;
  createdBy: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface SessionDoc {
  _id: string;
  memberId: string;
  tokenHash: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// vayo_comments — backs the "Team Chat" tab (docs/06-realtime-collaboration.md)
// ---------------------------------------------------------------------------
export interface CommentDoc {
  _id: string;
  /** Every endpoint this message is about — one entry for an ordinary
   * per-endpoint message, two or more for a cross-cutting question that
   * tags multiple APIs inline (`#[path](vayoId)` tokens in `body`,
   * extracted server-side the same way `mentionedMemberIds` already is).
   * A comment with 2+ vayoIds shows up in each of those endpoints' own
   * Team Chat tabs *and* in the header's cross-endpoint chat drawer. */
  vayoIds: string[];
  authorId: string;
  body: string;
  /** The message this one is quoting/responding to, or null for a normal
   * new message in the running conversation — lets two team members with
   * different opinions on the same message both reply *to that message*
   * instead of just appending to the bottom of the thread. Not a tree:
   * `vayo_comments` stays one flat, chronological list per endpoint and
   * this just renders a quoted preview above the reply — Team Chat is
   * framed as one running conversation, not nested sub-threads
   * (`06-realtime-collaboration.md`'s "Naming note"). */
  replyToId: string | null;
  /** Marks this message as an actual question/issue that warrants a
   * resolution, rather than ordinary conversation — `resolved` is only
   * meaningful (and only ever shown in the UI) when this is true. Most
   * messages in a real conversation never need resolving at all; this is
   * what keeps "Mark resolved" from appearing under every single line. Set
   * by the sender at send time, or toggled after the fact by anyone who
   * could comment (same role bar as posting one). */
  flagged: boolean;
  resolved: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// vayo_attachments — files/screen recordings attached to a Team Chat
// message (03-data-model.md). Stored in the same MongoDB the user already
// configured via GridFS, not a new external storage dependency (BYODB,
// docs/00-README.md constraint 1).
// ---------------------------------------------------------------------------
export interface AttachmentDoc {
  /** The GridFS file's own _id in the `vayo_attachments` bucket — there's
   * no separate metadata collection; everything else here lives in that
   * file's `metadata` subdocument, so there's exactly one record to keep
   * in sync, not two. */
  _id: string;
  /** Set once the upload is attached to a real message — null right after
   * upload, while it's just sitting in the sender's compose box as a
   * pending chip. An attachment that's never claimed (someone uploads,
   * then navigates away without sending) is a known, accepted storage
   * leak for v1, not something a background job cleans up yet. */
  commentId: string | null;
  /** Denormalized from the eventual comment so an authorization check on
   * download doesn't need an extra lookup — every attachment is scoped to
   * one endpoint's conversation, same as the comment it'll belong to. */
  vayoId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Distinguishes a browser-recorded screen capture from a picked/dropped
   * file — same storage and download path either way, just a different
   * icon/label in the UI. */
  kind: "file" | "screen-recording";
  uploadedBy: string;
  uploadedAt: string;
}

/** The one place this limit is defined — both `@vayo/db-mongo` (rejects an
 * upload over this size before it reaches GridFS) and `@vayo/server`
 * (multer's own `limits.fileSize`, so an oversized request is rejected
 * before the handler even runs) import it from here. Previously duplicated
 * by hand in both packages; centralizing it here removes that drift risk
 * without giving `@vayo/server` a direct dependency on `@vayo/db-mongo` —
 * `@vayo/types` is the one layer every adapter (including a future
 * `@vayo/db-postgres`) and `@vayo/server` already share, so this is the
 * adapter-agnostic home for a constant both sides need to agree on. */
export const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;

/** Caps a profile-picture upload before it's base64-encoded into
 * `TeamMemberDoc.avatarUrl` (see that field's own comment for why it's
 * stored inline rather than through the `vayo_attachments` GridFS bucket).
 * A raw 256KB image becomes ~342KB of base64 text — comfortably small
 * per member, and `listTeamMembers()` returns the whole roster in one
 * response, so this stays deliberately tight rather than matching
 * `MAX_ATTACHMENT_BYTES`'s much larger chat-attachment budget. */
export const MAX_AVATAR_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// vayo_notifications — the header bell's feed (docs/06-realtime-collaboration.md
// "Notifications"). Aggregates real events across every endpoint so a team
// member can see what changed without visiting each endpoint's History tab.
// Deliberately automatic-only for v1 — no hand-authored announcements.
// ---------------------------------------------------------------------------
export type NotificationType = "override" | "schema_change" | "comment" | "version_status";

export interface NotificationDoc {
  _id: string;
  type: NotificationType;
  /** The endpoint this relates to — null for a version-level event
   * (version_status), which isn't scoped to one endpoint. */
  vayoId: string | null;
  /** Who triggered it. Null for schema_change, which is system-detected
   * from real traffic shape, not a human action. */
  actorId: string | null;
  /** Human-readable summary, already composed at write time (e.g. "Sam
   * updated the summary for GET /orders") — the bell just renders this
   * directly, no client-side templating from raw diffs. */
  message: string;
  /** Team members `@mentioned` in a "comment" notification's message body —
   * empty for every other notification type. The bell is one shared feed,
   * not per-recipient inboxes, so this doesn't create a private channel;
   * it just lets the bell highlight "you were mentioned" for whoever's ID
   * appears here, same list everyone else already sees. */
  mentionedMemberIds: string[];
  /** What to jump to and highlight when this notification is clicked, on
   * top of just navigating to `vayoId` — meaning depends on `type`:
   * a `CommentDoc._id` for "comment" (scrolls Team Chat to and briefly
   * highlights that exact message), or an `OverrideDoc.targetId` for
   * "override" (`${vayoId}.${fieldPath}`). Null for "schema_change" (no
   * single audit-log entry is threaded back to the notification that
   * announced it) and "version_status" (not endpoint-scoped at all). */
  targetId: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// vayo_api_versions
// ---------------------------------------------------------------------------
export type ApiVersionStatus = "active" | "deprecated" | "sunset";

export interface ApiVersionDoc {
  _id: string;
  version: string;
  status: ApiVersionStatus;
  basePathPattern: string;
  deprecatedAt: string | null;
  sunsetAt: string | null;
}

// ---------------------------------------------------------------------------
// vayo_audit_log — backs the "History" tab (docs/03-data-model.md)
// ---------------------------------------------------------------------------
export type AuditAction =
  | "override"
  | "comment"
  | "invite"
  | "role_change"
  | "schema_change"
  | "endpoint_created"
  | "endpoint_deleted"
  | "member_removed"
  | "invite_revoked";

export interface AuditLogDoc {
  _id: string;
  actorId: string;
  actorType: "human" | "system";
  action: AuditAction;
  targetId: string;
  /** Which field changed, for actions that target one specific field
   * (currently just "override") — null for actions where the diff already
   * names its own shape (`schema_change`'s before/after are whole schema
   * objects; `role_change`/`endpoint_created`/`invite`/`comment` are each a
   * single self-explanatory value). Without this, the History tab has no
   * way to say *which* field an override changed — only an unlabeled
   * before/after value. */
  fieldPath: string | null;
  diff: { before: unknown; after: unknown } | null;
  at: string;
}

// ---------------------------------------------------------------------------
// vayo_folders — the user-organizable sidebar tree (docs/03-data-model.md
// "Manual endpoints & folders"). Endpoint -> folder assignment is NOT stored
// here — it's an override (`${vayoId}.folderId` / `${vayoId}.order`) so
// placement stays non-destructive and audit-logged for free, same as every
// other override.
// ---------------------------------------------------------------------------
export interface FolderDoc {
  _id: string;
  name: string;
  parentId: string | null; // null = root level
  version: string; // folders are scoped per API version, like endpoints
  order: number; // sort key among siblings
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// vayo_environments — named variable sets for Try It Now's {{var}}
// interpolation (docs/03-data-model.md "Environments & variables").
// ---------------------------------------------------------------------------
export interface EnvironmentDoc {
  _id: string;
  name: string;
  variables: Record<string, string>;
  isDefault: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// vayo_test_scripts — one pre-request + test script pair per endpoint,
// executed entirely client-side in a sandboxed Web Worker (never
// server-side — see docs/05-security.md's threat-model reasoning extended
// in docs/03-data-model.md "Scripts & flows").
// ---------------------------------------------------------------------------
export interface TestRunResult {
  status: "pass" | "fail";
  results: Array<{ name: string; passed: boolean; error?: string }>;
  at: string;
}

export interface TestScriptDoc {
  _id: string;
  vayoId: string;
  preRequestScript: string;
  testScript: string;
  lastRun: TestRunResult | null;
  updatedBy: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// vayo_flows — ordered, related-endpoint sequences (Postman's Collection
// Runner equivalent). Execution is entirely client-side; `extractVariables`
// values are simple dot-paths like "response.body.token" evaluated against
// the step's own response, feeding later steps' {{var}} interpolation.
// ---------------------------------------------------------------------------
export interface FlowStep {
  vayoId: string;
  extractVariables?: Record<string, string>;
}

export interface FlowDoc {
  _id: string;
  name: string;
  version: string;
  steps: FlowStep[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Socket.IO event payloads (docs/06-realtime-collaboration.md)
// ---------------------------------------------------------------------------
export interface PresenceEvent {
  vayoId: string;
  memberId: string;
}

export interface CommentNewEvent {
  vayoId: string;
  body: string;
}

export interface CommentResolvedEvent {
  commentId: string;
}

export interface OverrideUpdatedEvent {
  vayoId: string;
  fieldPath: string;
  value: unknown;
}

// ---------------------------------------------------------------------------
// The DB adapter contract (docs/08-packages-and-repo-structure.md)
// Lives here, not in @vayo/db-mongo, so that capture-express/server/cli can
// depend on the *shape* of persistence without depending on the concrete
// Mongo implementation — this is what makes a future @vayo/db-postgres a
// drop-in rather than a rewrite of every consumer.
// ---------------------------------------------------------------------------
export interface VayoDbAdapter {
  upsertEndpoint(sample: CapturedSample): Promise<EndpointDoc>;
  /** Merges one `@vayo/ast` static-scan route result into the matching
   * EndpointDoc (docs/04-capture-engine.md Step 2/3). `route` is typed
   * loosely here (rather than importing `@vayo/ast`'s `StaticRouteResult`)
   * to avoid a dependency from the shared types package onto a downstream
   * consumer — any object with this shape works. */
  upsertStaticResult(
    route: {
      method: string;
      pathTemplate: string;
      middlewareChain: string[];
      authRequiredGuess: boolean;
      scopes: string[];
      group: string;
      summary: string | null;
    },
    version: string,
  ): Promise<EndpointDoc>;
  getEndpoint(vayoId: string): Promise<EndpointDoc | null>;
  listEndpoints(version: string): Promise<EndpointDoc[]>;
  upsertOverride(override: Omit<OverrideDoc, "_id">): Promise<OverrideDoc>;
  /** Single-override lookup by targetId — used by @vayo/server to compute
   * an accurate before/after diff for the audit log on write. */
  getOverride(targetId: string): Promise<OverrideDoc | null>;
  listOverrides(vayoId: string): Promise<OverrideDoc[]>;
  appendExample(example: Omit<ExampleDoc, "_id">): Promise<void>;
  appendAuditLog(entry: Omit<AuditLogDoc, "_id">): Promise<void>;
  listAuditLog(targetId: string): Promise<AuditLogDoc[]>;
  /** Every audit-log entry across the whole project, newest first, capped at
   * `limit` — unlike `listAuditLog` (scoped to one endpoint's own History
   * tab), this backs a full compliance/audit export: every override,
   * comment, invite, role change, and member removal, project-wide, in one
   * call. Nothing here is new data — it's the same `vayo_audit_log`
   * collection every other write already appends to; this just exposes
   * reading all of it at once. */
  listAllAuditLog(limit: number): Promise<AuditLogDoc[]>;

  // -------------------------------------------------------------------------
  // Team Chat (vayo_comments, docs/06-realtime-collaboration.md)
  // -------------------------------------------------------------------------
  createComment(comment: Omit<CommentDoc, "_id">): Promise<CommentDoc>;
  /** Every comment whose `vayoIds` includes this one — an ordinary
   * single-endpoint message and a cross-cutting one tagging this endpoint
   * both match. */
  listComments(vayoId: string): Promise<CommentDoc[]>;
  /** Comments tagging 2+ endpoints, newest first, capped at `limit` — backs
   * the header's cross-endpoint chat drawer. Deliberately not "every comment
   * everywhere": that would be a noisier, less focused feed than "questions
   * that actually span APIs," which is the thing the drawer exists for. */
  listCrossCuttingComments(limit: number): Promise<CommentDoc[]>;
  resolveComment(commentId: string): Promise<CommentDoc | null>;
  /** Toggles whether a message is an actual question/issue worth resolving —
   * settable after the fact, not just at send time. */
  setCommentFlagged(commentId: string, flagged: boolean): Promise<CommentDoc | null>;

  // -------------------------------------------------------------------------
  // Attachments (vayo_attachments, docs/03-data-model.md) — files and screen
  // recordings on a Team Chat message, stored via GridFS in the same
  // MongoDB already configured (BYODB).
  // -------------------------------------------------------------------------
  /** Stores the file's bytes in GridFS and creates its metadata row —
   * `commentId` starts null (see `AttachmentDoc`). `Uint8Array`, not
   * `Buffer` — this package has zero dependencies by design (not even
   * `@types/node`), and a real `Buffer` (from `req.file.buffer` in
   * `@vayo/server`) already satisfies `Uint8Array` directly. */
  uploadAttachment(input: {
    vayoId: string;
    filename: string;
    mimeType: string;
    kind: "file" | "screen-recording";
    uploadedBy: string;
    data: Uint8Array;
  }): Promise<AttachmentDoc>;
  getAttachment(attachmentId: string): Promise<AttachmentDoc | null>;
  /** Null if the attachment doesn't exist — otherwise its metadata plus a
   * readable stream of the actual bytes for the download route to pipe.
   * Typed as `unknown` rather than `NodeJS.ReadableStream` for the same
   * zero-dependencies reason as `data` above — `@vayo/server` (which does
   * have real Node types) casts it back at the one call site that pipes
   * it to a response. */
  downloadAttachment(attachmentId: string): Promise<{ attachment: AttachmentDoc; stream: unknown } | null>;
  /** Every attachment across the whole conversation, one call — the client
   * groups by `commentId` itself, same pattern as `listComments` already
   * fetching everything in one round-trip rather than one query per message. */
  listAttachments(vayoId: string): Promise<AttachmentDoc[]>;
  /** Links previously-uploaded, still-unclaimed attachments to the comment
   * that was just created — silently skips any id that's already claimed,
   * belongs to a different uploader, or doesn't exist, rather than failing
   * the whole comment over a stale/tampered attachment id. */
  claimAttachments(commentId: string, attachmentIds: string[], uploadedBy: string): Promise<void>;
  /** Deletes an attachment's GridFS bytes + metadata — only while it's
   * still unclaimed and only for whoever uploaded it (removing a pending
   * chip before sending). Returns false if those conditions aren't met. */
  deleteUnclaimedAttachment(attachmentId: string, uploadedBy: string): Promise<boolean>;

  // -------------------------------------------------------------------------
  // Notifications (vayo_notifications, docs/06-realtime-collaboration.md
  // "Notifications")
  // -------------------------------------------------------------------------
  createNotification(notification: Omit<NotificationDoc, "_id">): Promise<NotificationDoc>;
  /** Most recent notifications, newest first, capped at `limit`. */
  listNotifications(limit: number): Promise<NotificationDoc[]>;
  /** Stamps `lastSeenNotificationsAt` for the calling member — the bell's
   * unread count is just "how many notifications came after this." */
  markNotificationsSeen(memberId: string, at: string): Promise<void>;

  // -------------------------------------------------------------------------
  // Team / RBAC (vayo_team_members, docs/05-security.md §4-5)
  // -------------------------------------------------------------------------
  createTeamMember(member: Omit<TeamMemberDoc, "_id">): Promise<TeamMemberDoc>;
  getTeamMember(memberId: string): Promise<TeamMemberDoc | null>;
  getTeamMemberByEmail(email: string): Promise<TeamMemberDoc | null>;
  listTeamMembers(): Promise<TeamMemberDoc[]>;
  updateTeamMemberRole(memberId: string, role: TeamRole): Promise<TeamMemberDoc | null>;
  /** Self-service display-name edit — the invitee is the one who picks
   * their own name at accept-invite time in the first place, so there's no
   * "owner edits someone else's name" path; this is the same idea applied
   * to changing it later. */
  updateTeamMemberName(memberId: string, name: string): Promise<TeamMemberDoc | null>;
  /** Self-service avatar set/clear — `null` clears it back to the
   * initials fallback, the same "remove" affordance as any other optional
   * profile field, not a separate route. */
  updateTeamMemberAvatar(memberId: string, avatarUrl: string | null): Promise<TeamMemberDoc | null>;
  /** Stamps `lastSeenAt` to `at` — called once, from realtime.ts's
   * `disconnect` handler, the moment a member's last open socket closes. */
  touchTeamMemberLastSeen(memberId: string, at: string): Promise<void>;
  /** Sets or clears (`nickname: null`) the CALLER's own private nickname for
   * `targetMemberId` — mutates `callerMemberId`'s own `nicknames` map, never
   * `targetMemberId`'s doc (they don't own this label; the caller does).
   * Returns the caller's updated doc. */
  setNicknameForMember(callerMemberId: string, targetMemberId: string, nickname: string | null): Promise<TeamMemberDoc | null>;
  /** Hard-delete — revokes access (the very next `resolveAuth` call for this
   * memberId returns null, same as any other missing member) without
   * touching their past comments/audit-log entries/notifications, which
   * stay attributed to them and render as "Former member" in the UI
   * (docs/05-security.md §4, "overrides are additive, never destructive"
   * applied to team membership itself). Returns false if no such member. */
  deleteTeamMember(memberId: string): Promise<boolean>;

  // -------------------------------------------------------------------------
  // Invites (vayo_invites, docs/05-security.md §5)
  // -------------------------------------------------------------------------
  createInvite(invite: Omit<InviteDoc, "_id">): Promise<InviteDoc>;
  getInviteByTokenHash(tokenHash: string): Promise<InviteDoc | null>;
  /** Atomically sets usedAt — checked-and-set in one operation so two people
   * redeeming the same link at once can't both succeed (docs/05-security.md §5). */
  markInviteUsed(tokenHash: string, usedAt: string): Promise<InviteDoc | null>;
  /** Outstanding (not yet redeemed) invites, newest first — lets an owner see
   * and revoke a wrong-email invite before it's ever accepted. */
  listPendingInvites(): Promise<InviteDoc[]>;
  /** Revokes a not-yet-accepted invite so its link can never be redeemed,
   * returning the now-deleted invite (so the caller can log who it was for)
   * or null if no such invite exists, or it was already used (revoking a
   * used invite would do nothing — the membership it created stands on its
   * own and is removed via deleteTeamMember instead). */
  revokeInvite(inviteId: string): Promise<InviteDoc | null>;

  // -------------------------------------------------------------------------
  // Sessions (vayo_sessions, standalone auth mode, docs/05-security.md §5)
  // -------------------------------------------------------------------------
  createSession(session: Omit<SessionDoc, "_id">): Promise<SessionDoc>;
  getSessionByTokenHash(tokenHash: string): Promise<SessionDoc | null>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Deletes every session for a member — not required for security (the
   * member-lookup check in resolveAuth already rejects a deleted member
   * regardless of any session row that happens to still exist), just
   * hygiene so removing a member doesn't leave orphaned session documents. */
  deleteSessionsByMemberId(memberId: string): Promise<void>;

  // -------------------------------------------------------------------------
  // Manual endpoint creation (docs/03-data-model.md "Manual endpoints")
  // -------------------------------------------------------------------------
  /** Pre-seeds an EndpointDoc via the same vayoId real capture would use, so
   * traffic hitting this route later just merges in naturally. */
  createManualEndpoint(input: {
    method: string;
    pathTemplate: string;
    version: string;
    group: string;
    summary: string | null;
  }): Promise<EndpointDoc>;
  /** Hard-delete. Callers must check `source === "manual"` OR
   * `possiblyRemovedSince` is set first — deleting a real (captured)
   * endpoint that's still actively confirmed would just have it reappear
   * on the next scan or the next request, silently undoing the delete;
   * this method itself doesn't re-check, same as `deleteFolder` trusting
   * its own caller (docs/05-security.md — the route is where that rule
   * lives). */
  deleteEndpoint(vayoId: string): Promise<boolean>;
  /** Flags every endpoint in `version` whose `source` includes a static
   * contribution ("static"/"merged") and whose `vayoId` isn't in
   * `confirmedVayoIds` (the full route set a `vayo scan` run just
   * produced) with `possiblyRemovedSince: flaggedAt` — but only if it
   * isn't already flagged, so re-running a scan that still doesn't find
   * it keeps the *original* flagged-since date, not a rolling one.
   * Returns how many were newly flagged, for `vayo scan` to report.
   * Purely additive/informational — never deletes anything itself. */
  flagEndpointsNotInScan(version: string, confirmedVayoIds: string[], flaggedAt: string): Promise<number>;

  // -------------------------------------------------------------------------
  // Folders (vayo_folders)
  // -------------------------------------------------------------------------
  createFolder(folder: Omit<FolderDoc, "_id">): Promise<FolderDoc>;
  listFolders(version: string): Promise<FolderDoc[]>;
  updateFolder(
    folderId: string,
    patch: Partial<Pick<FolderDoc, "name" | "parentId" | "order">>,
  ): Promise<FolderDoc | null>;
  getFolder(folderId: string): Promise<FolderDoc | null>;
  /** Deletes the folder and reparents its direct children (sub-folders) to
   * the deleted folder's own parent — never silently drops anything
   * (docs/03-data-model.md, same non-destructive philosophy as overrides).
   * Endpoints placed in the deleted folder are reparented the same way via
   * their placement override, which the caller (server route) handles since
   * it owns override writes. */
  deleteFolder(folderId: string): Promise<void>;
  /** Creates a root-level folder for any detected `group` that has no
   * matching folder yet, and places every endpoint that has *never been
   * placed anywhere* (no `folderId` override at all — a human who already
   * moved an endpoint elsewhere is never touched) into its group's folder.
   * Additive only, same non-destructive philosophy as everything else here:
   * re-running it after a human has since reorganized things only picks up
   * whatever's still unplaced, never undoes a manual move.
   * `actorId` is who to record as having triggered it — a real memberId
   * from an authenticated UI/API call, or a fixed sentinel like
   * `"system:cli-scan"` when triggered from the CLI, which has no team-
   * member/session concept of its own. */
  autoOrganizeFolders(version: string, actorId: string): Promise<{ foldersCreated: number; endpointsPlaced: number }>;

  // -------------------------------------------------------------------------
  // Environments (vayo_environments)
  // -------------------------------------------------------------------------
  createEnvironment(environment: Omit<EnvironmentDoc, "_id">): Promise<EnvironmentDoc>;
  listEnvironments(): Promise<EnvironmentDoc[]>;
  updateEnvironment(
    environmentId: string,
    patch: Partial<Pick<EnvironmentDoc, "name" | "variables" | "isDefault">>,
  ): Promise<EnvironmentDoc | null>;
  deleteEnvironment(environmentId: string): Promise<void>;

  // -------------------------------------------------------------------------
  // Saved/pinned examples (vayo_examples, extends the M1 rolling-window use)
  // -------------------------------------------------------------------------
  pinExample(example: Omit<ExampleDoc, "_id" | "pinned"> & { label: string | null }): Promise<ExampleDoc>;
  /** Returns EVERY example for this endpoint, most recent first — both the
   * rolling-window captures `appendExample` writes and anything `pinExample`
   * pinned, mixed together. Callers that want only pinned ones filter by
   * `.pinned` themselves (the Postman export); the UI's own
   * "prefer pinned, else most recent" selection also expects the full,
   * unfiltered mix. */
  listExamples(vayoId: string): Promise<ExampleDoc[]>;
  deleteExample(exampleId: string): Promise<void>;

  // -------------------------------------------------------------------------
  // Test scripts (vayo_test_scripts)
  // -------------------------------------------------------------------------
  getTestScript(vayoId: string): Promise<TestScriptDoc | null>;
  upsertTestScript(
    vayoId: string,
    scripts: { preRequestScript: string; testScript: string },
    updatedBy: string,
  ): Promise<TestScriptDoc>;
  recordTestRun(vayoId: string, run: TestRunResult): Promise<TestScriptDoc | null>;

  // -------------------------------------------------------------------------
  // Flows (vayo_flows)
  // -------------------------------------------------------------------------
  createFlow(flow: Omit<FlowDoc, "_id">): Promise<FlowDoc>;
  listFlows(version: string): Promise<FlowDoc[]>;
  updateFlow(flowId: string, patch: Partial<Pick<FlowDoc, "name" | "steps">>): Promise<FlowDoc | null>;
  deleteFlow(flowId: string): Promise<void>;

  // -------------------------------------------------------------------------
  // API versions (vayo_api_versions, docs/07-api-versioning.md). No delete —
  // the lifecycle diagram treats "sunset" as terminal; versions are never
  // removed, same non-destructive philosophy as everything else in Vayo.
  // -------------------------------------------------------------------------
  createApiVersion(apiVersion: Omit<ApiVersionDoc, "_id">): Promise<ApiVersionDoc>;
  listApiVersions(): Promise<ApiVersionDoc[]>;
  updateApiVersion(
    version: string,
    patch: Partial<Pick<ApiVersionDoc, "status" | "basePathPattern" | "deprecatedAt" | "sunsetAt">>,
  ): Promise<ApiVersionDoc | null>;
}

