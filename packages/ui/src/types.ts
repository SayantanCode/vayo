// @vayo/ui — UI-facing shapes derived from the compiled OpenAPI document
// (@vayo/openapi-compiler's output, including its x-vayo-* extensions).
// Deliberately loose/local rather than importing OpenAPI types from
// elsewhere — the UI only ever reads a handful of fields off this document.

import type { FolderDoc, JSONSchema, TeamRole } from "@vayo/types";

export interface OpenApiParameter {
  name: string;
  in: string;
  required: boolean;
  schema: JSONSchema;
}

export interface OpenApiResponse {
  description: string;
  content?: { "application/json": { schema: JSONSchema } };
}

export interface OpenApiOperation {
  operationId: string;
  summary?: string;
  parameters?: OpenApiParameter[];
  requestBody?: { content: { "application/json": { schema: JSONSchema } } };
  responses: Record<string, OpenApiResponse>;
  security?: Array<Record<string, string[]>>;
  "x-vayo-id": string;
  "x-vayo-group": string;
  /** "declared" when an explicit `@group` tag in code produced
   * `x-vayo-group`, "inferred" otherwise (docs/04-capture-engine.md Step 2
   * #4). A "declared" endpoint can be reordered within its current sidebar
   * folder via drag-and-drop, but the sidebar refuses to move it to a
   * different folder — see FolderTree's handleDragEnd. */
  "x-vayo-group-source": "declared" | "inferred";
  "x-vayo-scopes": string[];
  "x-vayo-middleware-chain": string[];
  "x-vayo-auth-required": boolean;
  "x-vayo-auth-type": string | null;
  "x-vayo-folder-id"?: string | null;
  "x-vayo-order"?: number;
  "x-vayo-notes"?: string | null;
  /** "manual" | "static" | "runtime" | "merged" — only "manual" (a
   * human-created placeholder never backed by real capture data) can be
   * deleted through the docs; see the delete route's own comment. */
  "x-vayo-source": string;
  /** "declared" | "inferred" | "observed" — present only alongside a real
   * `requestBody`. Drives the "inferred, not confirmed by real traffic"
   * badge in DetailsTab: an "inferred" (Mongoose-model-guessed) request
   * schema is shown with visibly less confidence than a "declared"
   * (Zod-enforced) or "observed" (real traffic already matched it) one. */
  "x-vayo-request-schema-source"?: "declared" | "inferred" | "observed" | null;
  /** ISO timestamp, present only when set — the most recent `vayo scan`
   * didn't re-find this endpoint (docs/04-capture-engine.md §3d). Alongside
   * "manual", this is the other condition under which the delete route
   * allows removing an endpoint through the docs. */
  "x-vayo-possibly-removed-since"?: string | null;
  /** OpenAPI's own standard field, not an x-vayo-* extension — present
   * (and always `true`) only when this endpoint is deprecated; omitted
   * entirely otherwise, matching how the compiler emits it. */
  deprecated?: true;
  /** "declared", present only alongside `deprecated: true`, only when an
   * explicit `@deprecated` tag in code produced it (docs/04-capture-engine.md
   * Step 2 #4a) — the UI refuses to un-deprecate such an endpoint, while one
   * a human flagged deprecated via the UI (this key absent) stays freely
   * toggleable. */
  "x-vayo-deprecated-source"?: "declared";
}

export interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { securitySchemes?: Record<string, unknown> };
}

/** One row in the sidebar / one selectable endpoint — a flattened view over
 * one (path, method) entry in the compiled spec. */
export interface EndpointSummary {
  vayoId: string;
  method: string;
  path: string; // OpenAPI-style, e.g. "/api/users/{id}"
  group: string;
  summary?: string;
  operation: OpenApiOperation;
}

/** GET /api/coverage's shape — endpoints still auto-only vs. human-confirmed
 * for a version. Same `{vayoId, method, pathTemplate}` ref shape as the
 * diff endpoint's operations, for consistency. */
export interface CoverageRef {
  vayoId: string;
  method: string;
  pathTemplate: string;
}
export interface CoverageReport {
  totalEndpoints: number;
  missingSummary: CoverageRef[];
  onlySuccessStatus: CoverageRef[];
  /** source === "static": found by the AST scanner but never merged with a
   * single real captured request — the request/response shapes shown for
   * these are inferred from code (Zod schemas, etc.), not observed traffic.
   * The highest-value flag here: it separates "documented" from "verified." */
  neverConfirmedByTraffic: CoverageRef[];
  /** notes === null — no per-endpoint frontend-workflow guidance written yet,
   * distinct from missingSummary (just the title). */
  missingNotes: CoverageRef[];
  /** Rounded 0-100. Endpoints with no gaps across every check above, divided
   * by totalEndpoints — a single trackable number instead of just lists. */
  fullyDocumentedPercent: number;
}

export function flattenSpec(doc: OpenApiDoc): EndpointSummary[] {
  const out: EndpointSummary[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      out.push({
        vayoId: operation["x-vayo-id"],
        method: method.toUpperCase(),
        path,
        group: operation["x-vayo-group"],
        summary: operation.summary,
        operation,
      });
    }
  }
  return out;
}

/** Replaces `{{key}}` tokens against an environment's variable map — used
 * everywhere Try It Now builds a URL, header, or body. An unmatched token is
 * left as-is (rather than becoming an empty string) so a missing variable
 * is visible in the resolved request instead of silently vanishing. */
export function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key: string) => {
    const value = variables[key];
    return value === undefined ? match : value;
  });
}

/** Resolves a base-URL template (e.g. `{{baseUrl}}`, or a literal URL typed
 * ad hoc) against the active environment for *read-only, documentation*
 * contexts (Details tab, code samples) — unlike Try It Now's editable
 * field, these views should never show raw unresolved `{{...}}` syntax to
 * a reader. Returns "" when the template is empty or still has an
 * unresolved token after interpolation, so callers can show their own
 * empty/fallback state instead of a broken-looking URL. */
export function resolveOrigin(template: string, variables: Record<string, string>): string {
  const resolved = interpolate(template, variables);
  const hasUnresolvedToken = /\{\{\s*[\w.-]+\s*\}\}/.test(resolved);
  return !resolved || hasUnresolvedToken ? "" : resolved;
}

export function groupBy<T>(items: T[], keyFn: (item: T) => string): Array<[string, T[]]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export interface CurrentMember {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  avatarUrl: string | null;
  /** This member's own private "contact book" — `targetMemberId ->
   * nickname` for how THEY refer to another member, independent of that
   * member's own `name` (a chat app's per-contact nickname, not a
   * team-wide rename). Never present on any OTHER member's `TeamMember`
   * row below — only the current member's own copy, via GET /api/me. */
  nicknames: Record<string, string>;
}

/** One row in the Team modal's roster — GET /api/team's shape (passwordHash
 * always stripped server-side, docs/05-security.md §5). Distinct from
 * `CurrentMember` above: this is any member on the roster, not specifically
 * "myself," so it carries `_id`/`status` instead of `id` and has no
 * password-adjacent fields to omit in the first place. */
export interface TeamMember {
  _id: string;
  email: string;
  name: string;
  role: TeamRole;
  status: "active" | "invited";
  avatarUrl: string | null;
  /** `null` while online (the live socket state is authoritative then) or
   * for a member who's never had a realtime connection at all — see
   * TeamMemberDoc.lastSeenAt's own comment. */
  lastSeenAt: string | null;
}

/** GET /api/team/invites' shape — an outstanding, not-yet-redeemed invite an
 * owner can still revoke. */
export interface PendingInvite {
  _id: string;
  email: string;
  role: TeamRole;
  expiresAt: string;
}

/** POST /api/team/invite and /api/team/invite/bulk's response shape — the
 * raw token, returned exactly once (docs/05-security.md §5: only its hash
 * is ever stored, so Vayo can't regenerate a lost invite link). */
export interface CreatedInvite {
  token: string;
  email: string;
  role: TeamRole;
  expiresAt: string;
}

/** A `CreatedInvite` plus the shareable link built client-side from its raw
 * token — what the invite panel actually renders, one per invite just
 * created. */
export interface InviteResult {
  email: string;
  role: TeamRole;
  expiresAt: string;
  link: string;
}

export type TabId = "details" | "flowmap" | "history" | "chat" | "tryit";

// ---------------------------------------------------------------------------
// Sidebar folder tree (docs/03-data-model.md "Manual endpoints & folders")
// ---------------------------------------------------------------------------

export interface FolderTreeNode {
  type: "folder";
  folder: FolderDoc;
  children: TreeNode[];
}

export interface EndpointTreeNode {
  type: "endpoint";
  endpoint: EndpointSummary;
}

export type TreeNode = FolderTreeNode | EndpointTreeNode;

/** Builds the sidebar tree from the flat folder list + endpoint list.
 * Folder placement/order come from `x-vayo-folder-id`/`x-vayo-order` —
 * ad-hoc override-injected fields (docs/03-data-model.md), absent entirely
 * for an endpoint that's never been placed (treated as root, order 0). */
export function buildTree(folders: FolderDoc[], endpoints: EndpointSummary[]): TreeNode[] {
  const childFolders = new Map<string | null, FolderDoc[]>();
  for (const folder of folders) {
    const key = folder.parentId;
    if (!childFolders.has(key)) childFolders.set(key, []);
    childFolders.get(key)!.push(folder);
  }
  for (const list of childFolders.values()) list.sort((a, b) => a.order - b.order);

  const endpointsByFolder = new Map<string | null, EndpointSummary[]>();
  for (const endpoint of endpoints) {
    const folderId = endpoint.operation["x-vayo-folder-id"] ?? null;
    if (!endpointsByFolder.has(folderId)) endpointsByFolder.set(folderId, []);
    endpointsByFolder.get(folderId)!.push(endpoint);
  }
  for (const list of endpointsByFolder.values()) {
    list.sort((a, b) => (a.operation["x-vayo-order"] ?? 0) - (b.operation["x-vayo-order"] ?? 0));
  }

  function build(parentId: string | null): TreeNode[] {
    const nodes: TreeNode[] = [];
    for (const folder of childFolders.get(parentId) ?? []) {
      nodes.push({ type: "folder", folder, children: build(folder._id) });
    }
    for (const endpoint of endpointsByFolder.get(parentId) ?? []) {
      nodes.push({ type: "endpoint", endpoint });
    }
    return nodes;
  }

  return build(null);
}

/** Flattens the tree into visible rows (respecting which folders are
 * expanded), each carrying its depth and parentId — the shape the drag-drop
 * sidebar's single flat `SortableContext` needs (docs: dnd-kit operates on
 * a flat list; nesting is expressed via parentId + depth, not by nesting
 * DndContexts). */
export interface FlatTreeRow {
  id: string; // "folder:<id>" | "endpoint:<vayoId>" — unique across both kinds
  depth: number;
  parentId: string | null;
  node: TreeNode;
}

export function flattenTree(nodes: TreeNode[], expanded: Set<string>, depth = 0, parentId: string | null = null): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  for (const node of nodes) {
    if (node.type === "folder") {
      rows.push({ id: `folder:${node.folder._id}`, depth, parentId, node });
      if (expanded.has(node.folder._id)) {
        rows.push(...flattenTree(node.children, expanded, depth + 1, node.folder._id));
      }
    } else {
      rows.push({ id: `endpoint:${node.endpoint.vayoId}`, depth, parentId, node });
    }
  }
  return rows;
}
