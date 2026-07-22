// @vayo/ui — thin typed fetch client for @vayo/server's REST API.
// Never talks to MongoDB or any package below @vayo/server directly
// (docs/08-packages-and-repo-structure.md).

import type {
  ApiVersionDoc,
  AttachmentDoc,
  AuditLogDoc,
  CommentDoc,
  EndpointDoc,
  EnvironmentDoc,
  ExampleDoc,
  FlowDoc,
  FolderDoc,
  NotificationDoc,
  TeamRole,
  TestScriptDoc,
} from "@vayo/types";
import type { SpecDiff } from "@vayo/openapi-compiler";
import type { CoverageReport, CreatedInvite, CurrentMember, OpenApiDoc, PendingInvite, TeamMember } from "./types.js";

export interface ApiConfig {
  baseUrl: string;
  token: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(config: ApiConfig, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // response wasn't JSON — keep the status text
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  login: (config: ApiConfig, email: string, password: string) =>
    request<{ token: string; expiresAt: string; member: CurrentMember }>(config, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  logout: (config: ApiConfig) => request<void>(config, "/api/auth/logout", { method: "POST" }),

  me: (config: ApiConfig) => request<CurrentMember>(config, "/api/me"),

  getSpec: (config: ApiConfig, version: string) =>
    request<OpenApiDoc>(config, `/api/spec?version=${encodeURIComponent(version)}`),

  postOverride: (config: ApiConfig, targetId: string, value: unknown, reason: string | null) =>
    request(config, "/api/overrides", { method: "POST", body: JSON.stringify({ targetId, value, reason }) }),

  listComments: (config: ApiConfig, vayoId: string) =>
    request<CommentDoc[]>(config, `/api/comments/${encodeURIComponent(vayoId)}`),

  /** Comments tagging 2+ endpoints, newest first — backs the header's
   * cross-endpoint chat drawer. */
  listCrossCuttingComments: (config: ApiConfig, limit = 50) =>
    request<CommentDoc[]>(config, `/api/comments/cross-cutting?limit=${limit}`),

  postComment: (
    config: ApiConfig,
    vayoId: string,
    body: string,
    flagged: boolean,
    replyToId: string | null,
    attachmentIds: string[] = [],
  ) =>
    request<CommentDoc>(config, "/api/comments", {
      method: "POST",
      body: JSON.stringify({ vayoId, body, flagged, replyToId, attachmentIds }),
    }),

  resolveComment: (config: ApiConfig, commentId: string) =>
    request<CommentDoc>(config, `/api/comments/${encodeURIComponent(commentId)}/resolve`, { method: "POST" }),

  setCommentFlagged: (config: ApiConfig, commentId: string, flagged: boolean) =>
    request<CommentDoc>(config, `/api/comments/${encodeURIComponent(commentId)}/flag`, {
      method: "PATCH",
      body: JSON.stringify({ flagged }),
    }),

  // ---- Team Chat attachments (files/screen recordings) ----
  listAttachments: (config: ApiConfig, vayoId: string) =>
    request<AttachmentDoc[]>(config, `/api/attachments?vayoId=${encodeURIComponent(vayoId)}`),

  /** Uploads immediately on file selection (not on Send) — the attachment
   * sits unclaimed until the message is actually sent, letting multiple
   * files/recordings queue up as pending chips in the compose box. */
  uploadAttachment: async (config: ApiConfig, vayoId: string, file: Blob, filename: string, kind: "file" | "screen-recording") => {
    const form = new FormData();
    form.append("vayoId", vayoId);
    form.append("kind", kind);
    form.append("file", file, filename);
    const res = await fetch(`${config.baseUrl}/api/attachments`, {
      method: "POST",
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
      body: form,
    });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // response wasn't JSON — keep the status text
      }
      throw new ApiError(res.status, message);
    }
    return (await res.json()) as AttachmentDoc;
  },

  deleteAttachment: (config: ApiConfig, attachmentId: string) =>
    request<void>(config, `/api/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" }),

  /** Not a `request()` call — this URL is handed straight to an <img>/
   * <video>/<a> tag, which needs the token as a query param since those
   * elements can't set an Authorization header. `requireRole("viewer")`
   * on the download route accepts a token either way (see the route). */
  attachmentDownloadUrl: (config: ApiConfig, attachmentId: string) =>
    `${config.baseUrl}/api/attachments/${encodeURIComponent(attachmentId)}/download${config.token ? `?token=${encodeURIComponent(config.token)}` : ""}`,

  listHistory: (config: ApiConfig, vayoId: string) =>
    request<AuditLogDoc[]>(config, `/api/history/${encodeURIComponent(vayoId)}`),

  listTeam: (config: ApiConfig) => request<TeamMember[]>(config, "/api/team"),

  createInvite: (config: ApiConfig, email: string, role: Exclude<TeamRole, "owner">) =>
    request<CreatedInvite>(config, "/api/team/invite", {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),

  createInvitesBulk: (config: ApiConfig, emails: string[], role: Exclude<TeamRole, "owner">) =>
    request<CreatedInvite[]>(config, "/api/team/invite/bulk", {
      method: "POST",
      body: JSON.stringify({ emails, role }),
    }),

  updateTeamMemberRole: (config: ApiConfig, memberId: string, role: TeamRole) =>
    request<{ id: string; email: string; name: string; role: TeamRole }>(config, `/api/team/${encodeURIComponent(memberId)}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),

  updateMyName: (config: ApiConfig, name: string) =>
    request<{ id: string; email: string; name: string; role: TeamRole }>(config, "/api/team/me/name", {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  /** Sets/clears (`nickname: null`) the CALLER's own private nickname for
   * `memberId` — never renames `memberId` itself, only how the caller sees
   * them. Returns the caller's whole updated nickname book, not just the
   * one entry, so the caller can replace their local copy in one step. */
  setNicknameFor: (config: ApiConfig, memberId: string, nickname: string | null) =>
    request<{ nicknames: Record<string, string> }>(config, `/api/team/${encodeURIComponent(memberId)}/nickname`, {
      method: "PATCH",
      body: JSON.stringify({ nickname }),
    }),

  /** Not a `request()` call — same reasoning as `uploadAttachment`: a real
   * file needs `FormData`, not a JSON body. */
  uploadMyAvatar: async (config: ApiConfig, file: Blob) => {
    const form = new FormData();
    form.append("avatar", file);
    const res = await fetch(`${config.baseUrl}/api/team/me/avatar`, {
      method: "PATCH",
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
      body: form,
    });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // response wasn't JSON — keep the status text
      }
      throw new ApiError(res.status, message);
    }
    return (await res.json()) as { id: string; email: string; name: string; role: TeamRole; avatarUrl: string | null };
  },

  removeMyAvatar: (config: ApiConfig) =>
    request<{ id: string; email: string; name: string; role: TeamRole; avatarUrl: string | null }>(
      config,
      "/api/team/me/avatar",
      { method: "DELETE" },
    ),

  removeTeamMember: (config: ApiConfig, memberId: string) =>
    request<void>(config, `/api/team/${encodeURIComponent(memberId)}`, { method: "DELETE" }),

  listPendingInvites: (config: ApiConfig) => request<PendingInvite[]>(config, "/api/team/invites"),

  revokeInvite: (config: ApiConfig, inviteId: string) =>
    request<void>(config, `/api/team/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" }),

  acceptInvite: (config: ApiConfig, token: string, name: string, password: string) =>
    request<{ id: string; email: string; role: TeamRole }>(config, "/api/team/accept-invite", {
      method: "POST",
      body: JSON.stringify({ token, name, password }),
    }),

  // ---- notifications (header bell) ----
  listNotifications: (config: ApiConfig) =>
    request<{ items: NotificationDoc[]; unreadCount: number; lastSeenNotificationsAt: string | null }>(config, "/api/notifications"),

  markNotificationsSeen: (config: ApiConfig) =>
    request(config, "/api/notifications/mark-seen", { method: "POST" }),

  // ---- audit log export (owner-only, compliance/SOC2-readiness) ----
  // Returns a raw Blob rather than parsed JSON — this is a file download
  // (JSON or CSV), not typed data the UI reads field-by-field, so it bypasses
  // the generic `request()` helper's res.json() assumption.
  exportAuditLog: async (config: ApiConfig, format: "json" | "csv" = "json"): Promise<Blob> => {
    const res = await fetch(`${config.baseUrl}/api/audit-log/export?format=${format}`, {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
    });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // response wasn't JSON — keep the status text
      }
      throw new ApiError(res.status, message);
    }
    return res.blob();
  },

  // ---- folders ----
  listFolders: (config: ApiConfig, version: string) =>
    request<FolderDoc[]>(config, `/api/folders?version=${encodeURIComponent(version)}`),

  createFolder: (config: ApiConfig, name: string, parentId: string | null, version: string) =>
    request<FolderDoc>(config, "/api/folders", { method: "POST", body: JSON.stringify({ name, parentId, version }) }),

  renameFolder: (config: ApiConfig, folderId: string, name: string) =>
    request<FolderDoc>(config, `/api/folders/${encodeURIComponent(folderId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  moveFolder: (config: ApiConfig, folderId: string, parentId: string | null, order: number) =>
    request<FolderDoc>(config, `/api/folders/${encodeURIComponent(folderId)}`, {
      method: "PATCH",
      body: JSON.stringify({ parentId, order }),
    }),

  deleteFolder: (config: ApiConfig, folderId: string) =>
    request<void>(config, `/api/folders/${encodeURIComponent(folderId)}`, { method: "DELETE" }),

  autoOrganizeFolders: (config: ApiConfig, version: string) =>
    request<{ foldersCreated: number; endpointsPlaced: number }>(
      config,
      `/api/folders/auto-organize?version=${encodeURIComponent(version)}`,
      { method: "POST" },
    ),

  // ---- manual endpoints + placement ----
  createManualEndpoint: (
    config: ApiConfig,
    input: { method: string; pathTemplate: string; version: string; group: string; summary: string | null },
  ) => request<EndpointDoc>(config, "/api/endpoints/manual", { method: "POST", body: JSON.stringify(input) }),

  setPlacement: (config: ApiConfig, vayoId: string, folderId: string | null, order: number) =>
    request<void>(config, `/api/endpoints/${encodeURIComponent(vayoId)}/placement`, {
      method: "PATCH",
      body: JSON.stringify({ folderId, order }),
    }),

  /** Only succeeds for a "manual" endpoint — the server 400s otherwise; see
   * the DELETE route's own comment for why. */
  deleteEndpoint: (config: ApiConfig, vayoId: string) =>
    request<void>(config, `/api/endpoints/${encodeURIComponent(vayoId)}`, { method: "DELETE" }),

  /** Rejects `deprecated: false` for an endpoint whose group is declared
   * deprecated in code via `@deprecated` — see the PATCH route's own comment. */
  setDeprecated: (config: ApiConfig, vayoId: string, deprecated: boolean, reason?: string | null) =>
    request<void>(config, `/api/endpoints/${encodeURIComponent(vayoId)}/deprecated`, {
      method: "PATCH",
      body: JSON.stringify({ deprecated, reason: reason ?? null }),
    }),

  // ---- environments ----
  listEnvironments: (config: ApiConfig) => request<EnvironmentDoc[]>(config, "/api/environments"),

  createEnvironment: (config: ApiConfig, name: string, variables: Record<string, string>, isDefault?: boolean) =>
    request<EnvironmentDoc>(config, "/api/environments", {
      method: "POST",
      body: JSON.stringify({ name, variables, isDefault }),
    }),

  updateEnvironment: (
    config: ApiConfig,
    id: string,
    patch: Partial<{ name: string; variables: Record<string, string>; isDefault: boolean }>,
  ) => request<EnvironmentDoc>(config, `/api/environments/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }),

  deleteEnvironment: (config: ApiConfig, id: string) =>
    request<void>(config, `/api/environments/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // ---- saved/pinned responses ----
  listExamples: (config: ApiConfig, vayoId: string) =>
    request<ExampleDoc[]>(config, `/api/examples/${encodeURIComponent(vayoId)}`),

  pinExample: (
    config: ApiConfig,
    vayoId: string,
    input: { statusCode: number; requestBody: unknown; responseBody: unknown; label: string | null },
  ) =>
    request<ExampleDoc>(config, `/api/examples/${encodeURIComponent(vayoId)}/pin`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  deleteExample: (config: ApiConfig, id: string) =>
    request<void>(config, `/api/examples/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // ---- test scripts ----
  getTestScript: (config: ApiConfig, vayoId: string) =>
    request<TestScriptDoc>(config, `/api/test-scripts/${encodeURIComponent(vayoId)}`),

  saveTestScript: (config: ApiConfig, vayoId: string, preRequestScript: string, testScript: string) =>
    request<TestScriptDoc>(config, `/api/test-scripts/${encodeURIComponent(vayoId)}`, {
      method: "PUT",
      body: JSON.stringify({ preRequestScript, testScript }),
    }),

  recordTestRun: (
    config: ApiConfig,
    vayoId: string,
    run: { status: "pass" | "fail"; results: Array<{ name: string; passed: boolean; error?: string }>; at: string },
  ) =>
    request<TestScriptDoc>(config, `/api/test-scripts/${encodeURIComponent(vayoId)}/last-run`, {
      method: "PATCH",
      body: JSON.stringify(run),
    }),

  // ---- flows ----
  listFlows: (config: ApiConfig, version: string) =>
    request<FlowDoc[]>(config, `/api/flows?version=${encodeURIComponent(version)}`),

  createFlow: (config: ApiConfig, name: string, version: string, steps: FlowDoc["steps"]) =>
    request<FlowDoc>(config, "/api/flows", { method: "POST", body: JSON.stringify({ name, version, steps }) }),

  updateFlow: (config: ApiConfig, id: string, patch: Partial<Pick<FlowDoc, "name" | "steps">>) =>
    request<FlowDoc>(config, `/api/flows/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),

  deleteFlow: (config: ApiConfig, id: string) =>
    request<void>(config, `/api/flows/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // ---- export ----
  exportPostmanCollection: (config: ApiConfig, version: string) =>
    request<unknown>(config, `/api/export/postman?version=${encodeURIComponent(version)}`),

  exportPostmanEnvironment: (config: ApiConfig, environmentId: string) =>
    request<unknown>(config, `/api/export/postman-environment/${encodeURIComponent(environmentId)}`),

  // ---- API versions ----
  listApiVersions: (config: ApiConfig) => request<ApiVersionDoc[]>(config, "/api/versions"),

  createApiVersion: (config: ApiConfig, version: string, basePathPattern: string) =>
    request<ApiVersionDoc>(config, "/api/versions", { method: "POST", body: JSON.stringify({ version, basePathPattern }) }),

  updateApiVersion: (
    config: ApiConfig,
    version: string,
    patch: Partial<Pick<ApiVersionDoc, "status" | "basePathPattern" | "deprecatedAt" | "sunsetAt">>,
  ) =>
    request<ApiVersionDoc>(config, `/api/versions/${encodeURIComponent(version)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  diffVersions: (config: ApiConfig, from: string, to: string) =>
    request<SpecDiff>(config, `/api/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),

  getCoverage: (config: ApiConfig, version: string) =>
    request<CoverageReport>(config, `/api/coverage?version=${encodeURIComponent(version)}`),
};
