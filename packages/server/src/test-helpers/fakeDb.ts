// An in-memory VayoDbAdapter for @vayo/server's own tests. Server route
// handlers are the thing under test here — the Mongo adapter's own
// correctness (merge logic, rolling caps, reparenting) is already covered by
// packages/db-mongo/src/index.test.ts, so this fake just needs to satisfy the
// interface plausibly, not replicate every algorithmic subtlety.
import type {
  ApiVersionDoc,
  AttachmentDoc,
  AuditLogDoc,
  CapturedSample,
  CommentDoc,
  EndpointDoc,
  EnvironmentDoc,
  ExampleDoc,
  FlowDoc,
  FolderDoc,
  InviteDoc,
  NotificationDoc,
  OverrideDoc,
  SessionDoc,
  TeamMemberDoc,
  TeamRole,
  TestRunResult,
  TestScriptDoc,
  VayoDbAdapter,
} from "@vayo/types";
import { stableHash } from "@vayo/schema-engine";
import { Readable } from "node:stream";

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

export function createFakeDb(): VayoDbAdapter {
  const endpoints = new Map<string, EndpointDoc>();
  const overrides = new Map<string, OverrideDoc>();
  const examples = new Map<string, ExampleDoc>();
  const auditLog: AuditLogDoc[] = [];
  const comments = new Map<string, CommentDoc>();
  const teamMembers = new Map<string, TeamMemberDoc>();
  const invites = new Map<string, InviteDoc>();
  const sessions = new Map<string, SessionDoc>();
  const folders = new Map<string, FolderDoc>();
  const environments = new Map<string, EnvironmentDoc>();
  const testScripts = new Map<string, TestScriptDoc>();
  const flows = new Map<string, FlowDoc>();
  const notifications = new Map<string, NotificationDoc>();
  const apiVersions = new Map<string, ApiVersionDoc>();
  const attachments = new Map<string, AttachmentDoc>();
  const attachmentBytes = new Map<string, Uint8Array>();

  return {
    // No @vayo/server route calls this directly (real capture merge/inference
    // lives in db-mongo, covered there) — kept minimally functional so tests
    // can seed a "real, captured" endpoint (source !== "manual") to exercise
    // routes that branch on it, e.g. the manual-only delete guard.
    async upsertEndpoint(sample: CapturedSample): Promise<EndpointDoc> {
      const vayoId = stableHash(sample.method, sample.pathTemplate, sample.version);
      const now = new Date().toISOString();
      const existing = endpoints.get(vayoId);
      const doc: EndpointDoc = {
        _id: existing?._id ?? genId("ep"),
        vayoId,
        method: sample.method.toUpperCase(),
        pathTemplate: sample.pathTemplate,
        version: sample.version,
        group: existing?.group ?? "General",
        summary: existing?.summary ?? null,
        notes: existing?.notes ?? null,
        authRequired: existing?.authRequired ?? false,
        authType: existing?.authType ?? null,
        scopes: existing?.scopes ?? [],
        middlewareChain: sample.middlewareNames,
        requestSchema: existing?.requestSchema ?? null,
        requestSchemaSource: existing?.requestSchemaSource ?? null,
        responseSchemas: existing?.responseSchemas ?? {},
        paramsSchema: existing?.paramsSchema ?? null,
        querySchema: existing?.querySchema ?? null,
        source: existing?.source === "manual" ? "merged" : (existing?.source ?? "runtime"),
        sampleCount: (existing?.sampleCount ?? 0) + 1,
        lastSeenAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      endpoints.set(vayoId, doc);
      return doc;
    },
    async upsertStaticResult(): Promise<EndpointDoc> {
      throw new Error("fakeDb: upsertStaticResult is not exercised by any @vayo/server route");
    },
    async getEndpoint(vayoId) {
      return endpoints.get(vayoId) ?? null;
    },
    async listEndpoints(version) {
      return [...endpoints.values()].filter((e) => e.version === version);
    },

    async upsertOverride(override) {
      const existing = overrides.get(override.targetId);
      const saved: OverrideDoc = { _id: existing?._id ?? genId("ov"), ...override };
      overrides.set(override.targetId, saved);
      return saved;
    },
    async getOverride(targetId) {
      return overrides.get(targetId) ?? null;
    },
    async listOverrides(vayoId) {
      return [...overrides.values()].filter((o) => o.targetId.startsWith(`${vayoId}.`));
    },

    async appendExample(example) {
      const id = genId("ex");
      examples.set(id, { _id: id, ...example });
    },
    async appendAuditLog(entry) {
      auditLog.push({ _id: genId("audit"), ...entry });
    },
    async listAuditLog(targetId) {
      return auditLog.filter((e) => e.targetId === targetId);
    },

    async listAllAuditLog(limit) {
      return [...auditLog].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
    },

    async createComment(comment) {
      const id = genId("comment");
      const saved = { _id: id, ...comment };
      comments.set(id, saved);
      return saved;
    },
    async listComments(vayoId) {
      return [...comments.values()].filter((c) => c.vayoIds.includes(vayoId));
    },
    async listCrossCuttingComments(limit) {
      return [...comments.values()]
        .filter((c) => c.vayoIds.length > 1)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
    },
    async resolveComment(commentId) {
      const comment = comments.get(commentId);
      if (!comment) return null;
      const updated = { ...comment, resolved: true };
      comments.set(commentId, updated);
      return updated;
    },
    async setCommentFlagged(commentId, flagged) {
      const comment = comments.get(commentId);
      if (!comment) return null;
      const updated = { ...comment, flagged };
      comments.set(commentId, updated);
      return updated;
    },

    async uploadAttachment(input) {
      const id = genId("attachment");
      const saved: AttachmentDoc = {
        _id: id,
        commentId: null,
        vayoId: input.vayoId,
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.data.byteLength,
        kind: input.kind,
        uploadedBy: input.uploadedBy,
        uploadedAt: new Date().toISOString(),
      };
      attachments.set(id, saved);
      attachmentBytes.set(id, input.data);
      return saved;
    },
    async getAttachment(attachmentId) {
      return attachments.get(attachmentId) ?? null;
    },
    async downloadAttachment(attachmentId) {
      const attachment = attachments.get(attachmentId);
      const bytes = attachmentBytes.get(attachmentId);
      if (!attachment || !bytes) return null;
      return { attachment, stream: Readable.from(Buffer.from(bytes)) };
    },
    async listAttachments(vayoId) {
      return [...attachments.values()].filter((a) => a.vayoId === vayoId);
    },
    async claimAttachments(commentId, attachmentIds, uploadedBy) {
      for (const id of attachmentIds) {
        const attachment = attachments.get(id);
        if (attachment && attachment.commentId === null && attachment.uploadedBy === uploadedBy) {
          attachments.set(id, { ...attachment, commentId });
        }
      }
    },
    async deleteUnclaimedAttachment(attachmentId, uploadedBy) {
      const attachment = attachments.get(attachmentId);
      if (!attachment || attachment.commentId !== null || attachment.uploadedBy !== uploadedBy) return false;
      attachments.delete(attachmentId);
      attachmentBytes.delete(attachmentId);
      return true;
    },

    async createTeamMember(member) {
      const id = genId("member");
      const saved = { _id: id, ...member };
      teamMembers.set(id, saved);
      return saved;
    },
    async getTeamMember(memberId) {
      return teamMembers.get(memberId) ?? null;
    },
    async getTeamMemberByEmail(email) {
      return [...teamMembers.values()].find((m) => m.email === email) ?? null;
    },
    async listTeamMembers() {
      return [...teamMembers.values()];
    },
    async updateTeamMemberRole(memberId, role: TeamRole) {
      const member = teamMembers.get(memberId);
      if (!member) return null;
      const updated = { ...member, role };
      teamMembers.set(memberId, updated);
      return updated;
    },
    async updateTeamMemberName(memberId, name: string) {
      const member = teamMembers.get(memberId);
      if (!member) return null;
      const updated = { ...member, name };
      teamMembers.set(memberId, updated);
      return updated;
    },
    async updateTeamMemberAvatar(memberId, avatarUrl: string | null) {
      const member = teamMembers.get(memberId);
      if (!member) return null;
      const updated = { ...member, avatarUrl };
      teamMembers.set(memberId, updated);
      return updated;
    },
    async touchTeamMemberLastSeen(memberId, at: string) {
      const member = teamMembers.get(memberId);
      if (!member) return;
      teamMembers.set(memberId, { ...member, lastSeenAt: at });
    },
    async setNicknameForMember(callerMemberId, targetMemberId: string, nickname: string | null) {
      const caller = teamMembers.get(callerMemberId);
      if (!caller) return null;
      const nicknames = { ...caller.nicknames };
      if (nickname === null) delete nicknames[targetMemberId];
      else nicknames[targetMemberId] = nickname;
      const updated = { ...caller, nicknames };
      teamMembers.set(callerMemberId, updated);
      return updated;
    },
    async deleteTeamMember(memberId) {
      return teamMembers.delete(memberId);
    },
    async markNotificationsSeen(memberId, at) {
      const member = teamMembers.get(memberId);
      if (!member) return;
      teamMembers.set(memberId, { ...member, lastSeenNotificationsAt: at });
    },

    async createInvite(invite) {
      const id = genId("invite");
      const saved = { _id: id, ...invite };
      invites.set(id, saved);
      return saved;
    },
    async getInviteByTokenHash(tokenHash) {
      return [...invites.values()].find((i) => i.tokenHash === tokenHash) ?? null;
    },
    async markInviteUsed(tokenHash, usedAt) {
      const invite = [...invites.values()].find((i) => i.tokenHash === tokenHash);
      if (!invite || invite.usedAt) return null; // already used — atomic check-and-set
      const updated = { ...invite, usedAt };
      invites.set(invite._id, updated);
      return updated;
    },
    async listPendingInvites() {
      return [...invites.values()].filter((i) => i.usedAt === null);
    },
    async revokeInvite(inviteId) {
      const invite = invites.get(inviteId);
      if (!invite || invite.usedAt) return null;
      invites.delete(inviteId);
      return invite;
    },

    async createSession(session) {
      const id = genId("session");
      const saved = { _id: id, ...session };
      sessions.set(id, saved);
      return saved;
    },
    async getSessionByTokenHash(tokenHash) {
      return [...sessions.values()].find((s) => s.tokenHash === tokenHash) ?? null;
    },
    async deleteSession(tokenHash) {
      for (const [id, session] of sessions) {
        if (session.tokenHash === tokenHash) sessions.delete(id);
      }
    },
    async deleteSessionsByMemberId(memberId) {
      for (const [id, session] of sessions) {
        if (session.memberId === memberId) sessions.delete(id);
      }
    },

    async createManualEndpoint(input) {
      // A real, URL-safe id — same stableHash() the production db-mongo
      // adapter uses, and for the same reason: this id is embedded directly
      // into route paths like PATCH /api/endpoints/:vayoId/placement, so it
      // must never contain "/" or other path-breaking characters.
      const vayoId = stableHash(input.method, input.pathTemplate, input.version);
      if (endpoints.has(vayoId)) {
        throw new Error(`An endpoint already exists for ${input.method.toUpperCase()} ${input.pathTemplate} (${input.version}).`);
      }
      const now = new Date().toISOString();
      const doc: EndpointDoc = {
        _id: genId("ep"),
        vayoId,
        method: input.method.toUpperCase(),
        pathTemplate: input.pathTemplate,
        version: input.version,
        group: input.group,
        summary: input.summary,
        notes: null,
        authRequired: false,
        authType: null,
        scopes: [],
        middlewareChain: [],
        requestSchema: null,
        requestSchemaSource: null,
        responseSchemas: {},
        paramsSchema: null,
        querySchema: null,
        source: "manual",
        sampleCount: 0,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      };
      endpoints.set(vayoId, doc);
      return doc;
    },
    async deleteEndpoint(vayoId) {
      return endpoints.delete(vayoId);
    },

    async createFolder(folder) {
      const id = genId("folder");
      const saved = { _id: id, ...folder };
      folders.set(id, saved);
      return saved;
    },
    async listFolders(version) {
      return [...folders.values()].filter((f) => f.version === version).sort((a, b) => a.order - b.order);
    },
    async updateFolder(folderId, patch) {
      const folder = folders.get(folderId);
      if (!folder) return null;
      const updated = { ...folder, ...patch, updatedAt: new Date().toISOString() };
      folders.set(folderId, updated);
      return updated;
    },
    async getFolder(folderId) {
      return folders.get(folderId) ?? null;
    },
    async deleteFolder(folderId) {
      const folder = folders.get(folderId);
      if (!folder) return;
      for (const [id, child] of folders) {
        if (child.parentId === folderId) folders.set(id, { ...child, parentId: folder.parentId });
      }
      folders.delete(folderId);
    },
    async autoOrganizeFolders() {
      return { foldersCreated: 0, endpointsPlaced: 0 };
    },

    async createEnvironment(environment) {
      const id = genId("env");
      const saved = { _id: id, ...environment };
      environments.set(id, saved);
      return saved;
    },
    async listEnvironments() {
      return [...environments.values()];
    },
    async updateEnvironment(environmentId, patch) {
      const environment = environments.get(environmentId);
      if (!environment) return null;
      const updated = { ...environment, ...patch, updatedAt: new Date().toISOString() };
      environments.set(environmentId, updated);
      return updated;
    },
    async deleteEnvironment(environmentId) {
      environments.delete(environmentId);
    },

    async pinExample(example) {
      const id = genId("ex");
      const saved: ExampleDoc = { _id: id, ...example, pinned: true };
      examples.set(id, saved);
      return saved;
    },
    async listExamples(vayoId) {
      // Mirrors the real adapter: the full mixed list (rolling-window
      // captures + pinned), not pre-filtered — see @vayo/types' own doc
      // comment on VayoDbAdapter.listExamples.
      return [...examples.values()]
        .filter((e) => e.vayoId === vayoId)
        .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
    },
    async deleteExample(exampleId) {
      examples.delete(exampleId);
    },

    async getTestScript(vayoId) {
      return testScripts.get(vayoId) ?? null;
    },
    async upsertTestScript(vayoId, scripts, updatedBy) {
      const existing = testScripts.get(vayoId);
      const saved: TestScriptDoc = {
        _id: existing?._id ?? genId("script"),
        vayoId,
        ...scripts,
        lastRun: existing?.lastRun ?? null,
        updatedBy,
        updatedAt: new Date().toISOString(),
      };
      testScripts.set(vayoId, saved);
      return saved;
    },
    async recordTestRun(vayoId, run: TestRunResult) {
      const existing = testScripts.get(vayoId);
      if (!existing) return null;
      const updated = { ...existing, lastRun: run };
      testScripts.set(vayoId, updated);
      return updated;
    },

    async createFlow(flow) {
      const id = genId("flow");
      const saved = { _id: id, ...flow };
      flows.set(id, saved);
      return saved;
    },
    async listFlows(version) {
      return [...flows.values()].filter((f) => f.version === version);
    },
    async updateFlow(flowId, patch) {
      const flow = flows.get(flowId);
      if (!flow) return null;
      const updated = { ...flow, ...patch, updatedAt: new Date().toISOString() };
      flows.set(flowId, updated);
      return updated;
    },
    async deleteFlow(flowId) {
      flows.delete(flowId);
    },

    async createApiVersion(apiVersion) {
      const id = genId("ver");
      const saved = { _id: id, ...apiVersion };
      apiVersions.set(apiVersion.version, saved);
      return saved;
    },
    async listApiVersions() {
      return [...apiVersions.values()];
    },
    async updateApiVersion(version, patch) {
      const apiVersion = apiVersions.get(version);
      if (!apiVersion) return null;
      const updated = { ...apiVersion, ...patch };
      apiVersions.set(version, updated);
      return updated;
    },

    async createNotification(notification) {
      const id = genId("notif");
      const saved: NotificationDoc = { _id: id, ...notification };
      notifications.set(id, saved);
      return saved;
    },
    async listNotifications(limit) {
      return [...notifications.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
    },
  };
}

/** Seeds a team member directly (bypassing invite/signup flows) for tests
 * that need an authenticated caller of a specific role. Returns the member
 * doc plus a raw bearer token already hashed into a valid session. */
export async function seedMemberWithSession(
  db: VayoDbAdapter,
  sessionSecret: string,
  role: TeamRole,
  overrides: Partial<Pick<TeamMemberDoc, "email" | "name" | "status">> = {},
): Promise<{ member: TeamMemberDoc; token: string }> {
  const { createHmac, randomBytes } = await import("node:crypto");
  const member = await db.createTeamMember({
    email: overrides.email ?? `${role}-${genId("seed")}@corp.test`,
    name: overrides.name ?? `Test ${role}`,
    role,
    passwordHash: null,
    status: overrides.status ?? "active",
    invitedBy: null,
    createdAt: new Date().toISOString(),
    lastSeenNotificationsAt: null,
    avatarUrl: null,
    lastSeenAt: null,
    nicknames: {},
  });
  const token = randomBytes(16).toString("hex");
  const tokenHash = createHmac("sha256", sessionSecret).update(token).digest("hex");
  await db.createSession({
    memberId: member._id,
    tokenHash,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return { member, token };
}
