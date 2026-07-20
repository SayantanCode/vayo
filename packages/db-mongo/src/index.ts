// @vayo/db-mongo
// Native MongoDB driver (not Mongoose) — see docs/08-packages-and-repo-structure.md
// for why: captured schemas are inherently variable-shape.

import {
  MAX_ATTACHMENT_BYTES,
  type ApiVersionDoc,
  type AttachmentDoc,
  type AuditLogDoc,
  type CapturedSample,
  type CommentDoc,
  type EndpointDoc,
  type EnvironmentDoc,
  type ExampleDoc,
  type FlowDoc,
  type FolderDoc,
  type InviteDoc,
  type NotificationDoc,
  type OverrideDoc,
  type SessionDoc,
  type TeamMemberDoc,
  type TeamRole,
  type TestRunResult,
  type TestScriptDoc,
  type VayoDbAdapter,
} from "@vayo/types";
// Re-exported for backward compatibility — anything already importing
// MAX_ATTACHMENT_BYTES from @vayo/db-mongo keeps working; @vayo/types is now
// the one place this limit is actually defined (docs/03-data-model.md).
export { MAX_ATTACHMENT_BYTES } from "@vayo/types";
import {
  detectSchemaChange,
  mergeCapturedSample,
  mergeStaticResult,
  resolveEndpoint,
  stableHash,
  MAX_EXAMPLES_PER_STATUS,
  type StaticRouteMergeInput,
} from "@vayo/schema-engine";
import { GridFSBucket, MongoClient, ObjectId, type Db, type Document, type WithId } from "mongodb";

/** Collection names — prefixed to avoid colliding with the user's own
 * collections in a shared database. docs/03-data-model.md. */
export const COLLECTIONS = {
  endpoints: "vayo_endpoints",
  overrides: "vayo_overrides",
  examples: "vayo_examples",
  teamMembers: "vayo_team_members",
  invites: "vayo_invites",
  comments: "vayo_comments",
  apiVersions: "vayo_api_versions",
  sessions: "vayo_sessions",
  auditLog: "vayo_audit_log",
  folders: "vayo_folders",
  environments: "vayo_environments",
  testScripts: "vayo_test_scripts",
  flows: "vayo_flows",
  notifications: "vayo_notifications",
} as const;

/** GridFS bucket for Team Chat attachments (03-data-model.md) — not a plain
 * collection, so it isn't in `COLLECTIONS` above. Creates
 * `vayo_attachments.files`/`vayo_attachments.chunks` in the same MongoDB
 * the user already configured (BYODB) rather than a new storage
 * dependency. Files over `MAX_ATTACHMENT_BYTES` are rejected before
 * reaching here (docs/05-security.md) — this is a chat attachment store,
 * not a general-purpose blob bucket. */
export const ATTACHMENTS_BUCKET = "vayo_attachments";

/** Mongo's `_id` is an ObjectId; every shared type in @vayo/types models it
 * as `string`. This is the one place that boundary gets crossed. */
function fromMongo<T extends { _id: string }>(doc: WithId<Document>): T {
  const { _id, ...rest } = doc;
  return { _id: _id.toString(), ...rest } as unknown as T;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toObjectId(id: string): ObjectId {
  return new ObjectId(id);
}

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection(COLLECTIONS.endpoints).createIndex({ vayoId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.endpoints).createIndex({ version: 1, group: 1 }),
    db.collection(COLLECTIONS.overrides).createIndex({ targetId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.examples).createIndex({ vayoId: 1, capturedAt: -1 }),
    db.collection(COLLECTIONS.auditLog).createIndex({ targetId: 1, at: -1 }),
    // Supports listAllAuditLog's full-collection export sorted by time,
    // independent of any one targetId (the compound index above is scoped
    // to a single endpoint's own history and doesn't serve that query well).
    db.collection(COLLECTIONS.auditLog).createIndex({ at: -1 }),
    db.collection(COLLECTIONS.teamMembers).createIndex({ email: 1 }, { unique: true }),
    db.collection(COLLECTIONS.invites).createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection(COLLECTIONS.invites).createIndex({ usedAt: 1 }),
    db.collection(COLLECTIONS.sessions).createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection(COLLECTIONS.sessions).createIndex({ memberId: 1 }),
    db.collection(COLLECTIONS.apiVersions).createIndex({ version: 1 }, { unique: true }),
    db.collection(COLLECTIONS.folders).createIndex({ version: 1, parentId: 1, order: 1 }),
    db.collection(COLLECTIONS.testScripts).createIndex({ vayoId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.flows).createIndex({ version: 1 }),
    db.collection(COLLECTIONS.notifications).createIndex({ createdAt: -1 }),
    db.collection(COLLECTIONS.comments).createIndex({ vayoIds: 1 }),
    db.collection(COLLECTIONS.comments).createIndex({ createdAt: -1 }),
    db.collection(`${ATTACHMENTS_BUCKET}.files`).createIndex({ "metadata.vayoId": 1 }),
    db.collection(`${ATTACHMENTS_BUCKET}.files`).createIndex({ "metadata.commentId": 1 }),
  ]);
}

/** GridFS attaches arbitrary custom fields via a file's `metadata`
 * subdocument — there's no separate attachment collection to keep in sync
 * with the file itself, just this one. */
interface GridFSAttachmentMetadata {
  commentId: string | null;
  vayoId: string;
  mimeType: string;
  kind: "file" | "screen-recording";
  uploadedBy: string;
}

interface GridFSFileDoc {
  _id: ObjectId;
  filename: string;
  length: number;
  uploadDate: Date;
  metadata?: GridFSAttachmentMetadata;
}

function attachmentFromGridFSFile(file: GridFSFileDoc): AttachmentDoc {
  const metadata = file.metadata!;
  return {
    _id: file._id.toString(),
    commentId: metadata.commentId,
    vayoId: metadata.vayoId,
    filename: file.filename,
    mimeType: metadata.mimeType,
    sizeBytes: file.length,
    kind: metadata.kind,
    uploadedBy: metadata.uploadedBy,
    uploadedAt: file.uploadDate.toISOString(),
  };
}

/**
 * Creates every `vayo_*` collection (implicitly, on first write) and index
 * (docs/03-data-model.md per-collection "Indexes" notes). Idempotent — safe
 * to run on every `vayo init` / server boot. Opens and closes its own
 * connection; independent of `createAdapter` since a future
 * `@vayo/db-postgres` would have its own migration mechanism entirely, not
 * a shared one across the `VayoDbAdapter` interface.
 */
export async function runMigrations(mongoUri: string): Promise<void> {
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    await ensureIndexes(client.db());
  } finally {
    await client.close();
  }
}

/**
 * Implements `VayoDbAdapter` (@vayo/types) against the native MongoDB
 * driver. Reads `mongoUri` once at call time — never logs it
 * (docs/05-security.md §7). Connects lazily on first use and reuses one
 * connection for the adapter's lifetime.
 */
export function createAdapter(mongoUri: string): VayoDbAdapter {
  const client = new MongoClient(mongoUri);
  let connecting: Promise<Db> | null = null;
  function getDb(): Promise<Db> {
    if (!connecting) {
      connecting = client.connect().then((connected) => connected.db());
    }
    return connecting;
  }

  return {
    async upsertEndpoint(sample: CapturedSample): Promise<EndpointDoc> {
      const db = await getDb();
      const col = db.collection(COLLECTIONS.endpoints);
      const vayoId = stableHash(sample.method, sample.pathTemplate, sample.version);

      const existingRaw = await col.findOne({ vayoId });
      const existing = existingRaw ? fromMongo<EndpointDoc>(existingRaw) : null;

      const merged = mergeCapturedSample(existing, sample);
      const { _id: _ignored, ...mergedFields } = merged;

      const savedRaw = await col.findOneAndUpdate(
        { vayoId },
        { $set: mergedFields },
        { upsert: true, returnDocument: "after" },
      );
      const saved = fromMongo<EndpointDoc>(savedRaw!);

      // docs/03-data-model.md: schema_change entries are written
      // automatically whenever mergeCapturedSample changes the inferred
      // schema — schema-engine (pure) detects the diff, db-mongo (I/O)
      // writes it.
      const diff = detectSchemaChange(existing, saved);
      if (diff) {
        await db.collection(COLLECTIONS.auditLog).insertOne({
          actorId: "system",
          actorType: "system",
          action: "schema_change",
          targetId: vayoId,
          fieldPath: null,
          diff,
          at: sample.capturedAt,
        });
        // Only notify for an ACTUAL change to a previously-known endpoint —
        // `existing === null` just means "first time we've ever seen this
        // route," which isn't something worth pushing to the whole team
        // (a fresh install's first day of traffic would otherwise generate
        // one notification per endpoint discovered).
        if (existing) {
          await db.collection(COLLECTIONS.notifications).insertOne({
            type: "schema_change",
            vayoId,
            actorId: null,
            message: `Schema changed for ${saved.method} ${saved.pathTemplate}`,
            mentionedMemberIds: [],
            targetId: null,
            createdAt: sample.capturedAt,
          });
        }
      }

      return saved;
    },

    async upsertStaticResult(route: StaticRouteMergeInput, version: string): Promise<EndpointDoc> {
      const db = await getDb();
      const col = db.collection(COLLECTIONS.endpoints);
      const vayoId = stableHash(route.method, route.pathTemplate, version);

      const existingRaw = await col.findOne({ vayoId });
      const existing = existingRaw ? fromMongo<EndpointDoc>(existingRaw) : null;

      const merged = mergeStaticResult(existing, route, version);
      const { _id: _ignored, ...mergedFields } = merged;

      const savedRaw = await col.findOneAndUpdate(
        { vayoId },
        { $set: mergedFields },
        { upsert: true, returnDocument: "after" },
      );
      return fromMongo<EndpointDoc>(savedRaw!);
    },

    async getEndpoint(vayoId: string): Promise<EndpointDoc | null> {
      const db = await getDb();
      const raw = await db.collection(COLLECTIONS.endpoints).findOne({ vayoId });
      return raw ? fromMongo<EndpointDoc>(raw) : null;
    },

    async listEndpoints(version: string): Promise<EndpointDoc[]> {
      const db = await getDb();
      const raws = await db
        .collection(COLLECTIONS.endpoints)
        .find({ version })
        .sort({ group: 1, pathTemplate: 1 })
        .toArray();
      return raws.map((raw) => fromMongo<EndpointDoc>(raw));
    },

    async upsertOverride(override: Omit<OverrideDoc, "_id">): Promise<OverrideDoc> {
      const db = await getDb();
      const savedRaw = await db.collection(COLLECTIONS.overrides).findOneAndUpdate(
        { targetId: override.targetId },
        { $set: override },
        { upsert: true, returnDocument: "after" },
      );
      return fromMongo<OverrideDoc>(savedRaw!);
    },

    async getOverride(targetId: string): Promise<OverrideDoc | null> {
      const db = await getDb();
      const raw = await db.collection(COLLECTIONS.overrides).findOne({ targetId });
      return raw ? fromMongo<OverrideDoc>(raw) : null;
    },

    async listOverrides(vayoId: string): Promise<OverrideDoc[]> {
      const db = await getDb();
      const prefix = new RegExp(`^${escapeRegExp(vayoId)}\\.`);
      const raws = await db
        .collection(COLLECTIONS.overrides)
        .find({ targetId: prefix })
        .toArray();
      return raws.map((raw) => fromMongo<OverrideDoc>(raw));
    },

    async appendExample(example: Omit<ExampleDoc, "_id">): Promise<void> {
      const db = await getDb();
      const col = db.collection(COLLECTIONS.examples);
      await col.insertOne(example);

      // Cap at MAX_EXAMPLES_PER_STATUS most recent per (vayoId, statusCode) —
      // docs/03-data-model.md: not expressible as a TTL, enforced here.
      // Pinned (explicitly saved) examples are exempt from this cap — a
      // team member chose to keep them, so auto-rotation must never touch
      // them (same non-destructive principle as overrides).
      const excess = await col
        .find({ vayoId: example.vayoId, statusCode: example.statusCode, pinned: false })
        .sort({ capturedAt: -1 })
        .skip(MAX_EXAMPLES_PER_STATUS)
        .toArray();
      if (excess.length > 0) {
        await col.deleteMany({ _id: { $in: excess.map((doc) => doc._id) } });
      }
    },

    async appendAuditLog(entry: Omit<AuditLogDoc, "_id">): Promise<void> {
      const db = await getDb();
      await db.collection(COLLECTIONS.auditLog).insertOne(entry);
    },

    async listAuditLog(targetId: string): Promise<AuditLogDoc[]> {
      const db = await getDb();
      const raws = await db
        .collection(COLLECTIONS.auditLog)
        .find({ targetId })
        .sort({ at: -1 })
        .toArray();
      return raws.map((raw) => fromMongo<AuditLogDoc>(raw));
    },

    async listAllAuditLog(limit: number): Promise<AuditLogDoc[]> {
      const db = await getDb();
      const raws = await db.collection(COLLECTIONS.auditLog).find({}).sort({ at: -1 }).limit(limit).toArray();
      return raws.map((raw) => fromMongo<AuditLogDoc>(raw));
    },

    async createComment(comment: Omit<CommentDoc, "_id">): Promise<CommentDoc> {
      const db = await getDb();
      const result = await db.collection(COLLECTIONS.comments).insertOne(comment);
      return { ...comment, _id: result.insertedId.toString() };
    },

    async listComments(vayoId: string): Promise<CommentDoc[]> {
      const db = await getDb();
      // `vayoIds` is an array — a scalar query value against it is Mongo's
      // standard array-contains match, no `$elemMatch` needed.
      const raws = await db.collection(COLLECTIONS.comments).find({ vayoIds: vayoId }).sort({ createdAt: 1 }).toArray();
      return raws.map((raw) => fromMongo<CommentDoc>(raw));
    },

    async listCrossCuttingComments(limit: number): Promise<CommentDoc[]> {
      const db = await getDb();
      // "vayoIds.1 exists" is the standard Mongo idiom for "array has at
      // least 2 elements" via a plain find() — no aggregation/$expr needed.
      const raws = await db
        .collection(COLLECTIONS.comments)
        .find({ "vayoIds.1": { $exists: true } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
      return raws.map((raw) => fromMongo<CommentDoc>(raw));
    },

    async resolveComment(commentId: string): Promise<CommentDoc | null> {
      const db = await getDb();
      const savedRaw = await db
        .collection(COLLECTIONS.comments)
        .findOneAndUpdate(
          { _id: toObjectId(commentId) },
          { $set: { resolved: true } },
          { returnDocument: "after" },
        );
      return savedRaw ? fromMongo<CommentDoc>(savedRaw) : null;
    },

    async setCommentFlagged(commentId: string, flagged: boolean): Promise<CommentDoc | null> {
      const db = await getDb();
      const savedRaw = await db
        .collection(COLLECTIONS.comments)
        .findOneAndUpdate(
          { _id: toObjectId(commentId) },
          { $set: { flagged } },
          { returnDocument: "after" },
        );
      return savedRaw ? fromMongo<CommentDoc>(savedRaw) : null;
    },

    async uploadAttachment(input): Promise<AttachmentDoc> {
      const db = await getDb();
      const bucket = new GridFSBucket(db, { bucketName: ATTACHMENTS_BUCKET });
      const metadata: GridFSAttachmentMetadata = {
        commentId: null,
        vayoId: input.vayoId,
        mimeType: input.mimeType,
        kind: input.kind,
        uploadedBy: input.uploadedBy,
      };
      const uploadStream = bucket.openUploadStream(input.filename, { metadata });
      await new Promise<void>((resolve, reject) => {
        uploadStream.once("finish", () => resolve());
        uploadStream.once("error", reject);
        uploadStream.end(input.data);
      });
      const fileRaw = (await db
        .collection(`${ATTACHMENTS_BUCKET}.files`)
        .findOne({ _id: uploadStream.id })) as GridFSFileDoc | null;
      return attachmentFromGridFSFile(fileRaw!);
    },

    async getAttachment(attachmentId: string): Promise<AttachmentDoc | null> {
      const db = await getDb();
      const fileRaw = (await db
        .collection(`${ATTACHMENTS_BUCKET}.files`)
        .findOne({ _id: toObjectId(attachmentId) })) as GridFSFileDoc | null;
      return fileRaw ? attachmentFromGridFSFile(fileRaw) : null;
    },

    async downloadAttachment(attachmentId: string) {
      const db = await getDb();
      const fileRaw = (await db
        .collection(`${ATTACHMENTS_BUCKET}.files`)
        .findOne({ _id: toObjectId(attachmentId) })) as GridFSFileDoc | null;
      if (!fileRaw) return null;
      const bucket = new GridFSBucket(db, { bucketName: ATTACHMENTS_BUCKET });
      const stream = bucket.openDownloadStream(toObjectId(attachmentId));
      return { attachment: attachmentFromGridFSFile(fileRaw), stream };
    },

    async listAttachments(vayoId: string): Promise<AttachmentDoc[]> {
      const db = await getDb();
      const filesRaw = await db
        .collection(`${ATTACHMENTS_BUCKET}.files`)
        .find({ "metadata.vayoId": vayoId })
        .sort({ uploadDate: 1 })
        .toArray();
      return (filesRaw as unknown as GridFSFileDoc[]).map(attachmentFromGridFSFile);
    },

    async claimAttachments(commentId: string, attachmentIds: string[], uploadedBy: string): Promise<void> {
      if (attachmentIds.length === 0) return;
      const db = await getDb();
      await db.collection(`${ATTACHMENTS_BUCKET}.files`).updateMany(
        { _id: { $in: attachmentIds.map(toObjectId) }, "metadata.commentId": null, "metadata.uploadedBy": uploadedBy },
        { $set: { "metadata.commentId": commentId } },
      );
    },

    async deleteUnclaimedAttachment(attachmentId: string, uploadedBy: string): Promise<boolean> {
      const db = await getDb();
      const fileRaw = await db
        .collection(`${ATTACHMENTS_BUCKET}.files`)
        .findOne({ _id: toObjectId(attachmentId), "metadata.commentId": null, "metadata.uploadedBy": uploadedBy });
      if (!fileRaw) return false;
      const bucket = new GridFSBucket(db, { bucketName: ATTACHMENTS_BUCKET });
      await bucket.delete(toObjectId(attachmentId));
      return true;
    },

    async createTeamMember(member: Omit<TeamMemberDoc, "_id">): Promise<TeamMemberDoc> {
      const db = await getDb();
      const result = await db.collection(COLLECTIONS.teamMembers).insertOne(member);
      return { ...member, _id: result.insertedId.toString() };
    },

    async getTeamMember(memberId: string): Promise<TeamMemberDoc | null> {
      const db = await getDb();
      const raw = await db.collection(COLLECTIONS.teamMembers).findOne({ _id: toObjectId(memberId) });
      return raw ? fromMongo<TeamMemberDoc>(raw) : null;
    },

    async getTeamMemberByEmail(email: string): Promise<TeamMemberDoc | null> {
      const db = await getDb();
      const raw = await db.collection(COLLECTIONS.teamMembers).findOne({ email });
      return raw ? fromMongo<TeamMemberDoc>(raw) : null;
    },

    async listTeamMembers(): Promise<TeamMemberDoc[]> {
      const db = await getDb();
      const raws = await db.collection(COLLECTIONS.teamMembers).find({}).sort({ createdAt: 1 }).toArray();
      return raws.map((raw) => fromMongo<TeamMemberDoc>(raw));
    },

    async updateTeamMemberRole(memberId: string, role: TeamRole): Promise<TeamMemberDoc | null> {
      const db = await getDb();
      const savedRaw = await db
        .collection(COLLECTIONS.teamMembers)
        .findOneAndUpdate({ _id: toObjectId(memberId) }, { $set: { role } }, { returnDocument: "after" });
      return savedRaw ? fromMongo<TeamMemberDoc>(savedRaw) : null;
    },

    async updateTeamMemberName(memberId: string, name: string): Promise<TeamMemberDoc | null> {
      const db = await getDb();
      const savedRaw = await db
        .collection(COLLECTIONS.teamMembers)
        .findOneAndUpdate({ _id: toObjectId(memberId) }, { $set: { name } }, { returnDocument: "after" });
      return savedRaw ? fromMongo<TeamMemberDoc>(savedRaw) : null;
    },

    async updateTeamMemberAvatar(memberId: string, avatarUrl: string | null): Promise<TeamMemberDoc | null> {
      const db = await getDb();
      const savedRaw = await db
        .collection(COLLECTIONS.teamMembers)
        .findOneAndUpdate({ _id: toObjectId(memberId) }, { $set: { avatarUrl } }, { returnDocument: "after" });
      return savedRaw ? fromMongo<TeamMemberDoc>(savedRaw) : null;
    },

    async touchTeamMemberLastSeen(memberId: string, at: string): Promise<void> {
      const db = await getDb();
      await db.collection(COLLECTIONS.teamMembers).updateOne({ _id: toObjectId(memberId) }, { $set: { lastSeenAt: at } });
    },

    async setNicknameForMember(callerMemberId: string, targetMemberId: string, nickname: string | null): Promise<TeamMemberDoc | null> {
      const db = await getDb();
      // A dotted path into the map field — updates/removes just this one
      // entry without touching the rest of the caller's own nickname book.
      const update = nickname === null ? { $unset: { [`nicknames.${targetMemberId}`]: "" } } : { $set: { [`nicknames.${targetMemberId}`]: nickname } };
      const savedRaw = await db
        .collection(COLLECTIONS.teamMembers)
        .findOneAndUpdate({ _id: toObjectId(callerMemberId) }, update, { returnDocument: "after" });
      return savedRaw ? fromMongo<TeamMemberDoc>(savedRaw) : null;
    },

    async deleteTeamMember(memberId: string): Promise<boolean> {
      const db = await getDb();
      const result = await db.collection(COLLECTIONS.teamMembers).deleteOne({ _id: toObjectId(memberId) });
      return result.deletedCount > 0;
    },

    async createInvite(invite: Omit<InviteDoc, "_id">): Promise<InviteDoc> {
      const db = await getDb();
      const result = await db.collection(COLLECTIONS.invites).insertOne(invite);
      return { ...invite, _id: result.insertedId.toString() };
    },

    async getInviteByTokenHash(tokenHash: string): Promise<InviteDoc | null> {
      const db = await getDb();
      const raw = await db.collection(COLLECTIONS.invites).findOne({ tokenHash });
      return raw ? fromMongo<InviteDoc>(raw) : null;
    },

    async markInviteUsed(tokenHash: string, usedAt: string): Promise<InviteDoc | null> {
      const db = await getDb();
      // Checked-and-set in one atomic operation (docs/05-security.md §5): only
      // succeeds if usedAt was still null, so two simultaneous redemptions of
      // the same link can't both win.
      const savedRaw = await db
        .collection(COLLECTIONS.invites)
        .findOneAndUpdate(
          { tokenHash, usedAt: null },
          { $set: { usedAt } },
          { returnDocument: "after" },
        );
      return savedRaw ? fromMongo<InviteDoc>(savedRaw) : null;
    },

    async listPendingInvites(): Promise<InviteDoc[]> {
      const db = await getDb();
      const raws = await db.collection(COLLECTIONS.invites).find({ usedAt: null }).sort({ expiresAt: -1 }).toArray();
      return raws.map((raw) => fromMongo<InviteDoc>(raw));
    },

    async revokeInvite(inviteId: string): Promise<InviteDoc | null> {
      const db = await getDb();
      const raw = await db.collection(COLLECTIONS.invites).findOneAndDelete({ _id: toObjectId(inviteId), usedAt: null });
      return raw ? fromMongo<InviteDoc>(raw) : null;
    },

    async createSession(session: Omit<SessionDoc, "_id">): Promise<SessionDoc> {
      const db = await getDb();
      const result = await db.collection(COLLECTIONS.sessions).insertOne(session);
      return { ...session, _id: result.insertedId.toString() };
    },

    async getSessionByTokenHash(tokenHash: string): Promise<SessionDoc | null> {
      const db = await getDb();
      const raw = await db.collection(COLLECTIONS.sessions).findOne({ tokenHash });
      return raw ? fromMongo<SessionDoc>(raw) : null;
    },

    async deleteSession(tokenHash: string): Promise<void> {
      const db = await getDb();
      await db.collection(COLLECTIONS.sessions).deleteOne({ tokenHash });
    },

    async deleteSessionsByMemberId(memberId: string): Promise<void> {
      const db = await getDb();
      await db.collection(COLLECTIONS.sessions).deleteMany({ memberId });
    },

    async createManualEndpoint(input): Promise<EndpointDoc> {
      const db = await getDb();
      const col = db.collection(COLLECTIONS.endpoints);
      const vayoId = stableHash(input.method, input.pathTemplate, input.version);

      const existing = await col.findOne({ vayoId });
      if (existing) {
        throw new Error(
          `An endpoint already exists for ${input.method.toUpperCase()} ${input.pathTemplate} (${input.version}) — edit its group/summary via an override instead of creating a new manual entry.`,
        );
      }

      const now = new Date().toISOString();
      const doc: Omit<EndpointDoc, "_id"> = {
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
      const result = await col.insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    },

    async deleteEndpoint(vayoId: string): Promise<boolean> {
      const db = await getDb();
      const result = await db.collection(COLLECTIONS.endpoints).deleteOne({ vayoId });
      return result.deletedCount > 0;
    },

    async createFolder(folder: Omit<FolderDoc, "_id">): Promise<FolderDoc> {
      const db = await getDb();
      const result = await db.collection(COLLECTIONS.folders).insertOne(folder);
      return { ...folder, _id: result.insertedId.toString() };
    },

    async listFolders(version: string): Promise<FolderDoc[]> {
      const db = await getDb();
      const raws = await db.collection(COLLECTIONS.folders).find({ version }).sort({ order: 1 }).toArray();
      return raws.map((raw) => fromMongo<FolderDoc>(raw));
    },

    async updateFolder(folderId, patch): Promise<FolderDoc | null> {
      const db = await getDb();
      const savedRaw = await db
        .collection(COLLECTIONS.folders)
        .findOneAndUpdate(
          { _id: toObjectId(folderId) },
          { $set: { ...patch, updatedAt: new Date().toISOString() } },
          { returnDocument: "after" },
        );
      return savedRaw ? fromMongo<FolderDoc>(savedRaw) : null;
    },

    async getFolder(folderId: string): Promise<FolderDoc | null> {
      const db = await getDb();
      const raw = await db.collection(COLLECTIONS.folders).findOne({ _id: toObjectId(folderId) });
      return raw ? fromMongo<FolderDoc>(raw) : null;
    },

    async deleteFolder(folderId: string): Promise<void> {
      const db = await getDb();
      const col = db.collection(COLLECTIONS.folders);
      const folder = await col.findOne({ _id: toObjectId(folderId) });
      if (!folder) return;
      // Reparent direct sub-folders to the deleted folder's own parent —
      // never silently orphans or cascades-deletes them. Endpoints placed
      // in this folder are reparented separately by the caller (a server
      // route), which owns override writes.
      await col.updateMany({ parentId: folderId }, { $set: { parentId: (folder.parentId as string | null) ?? null } });
      await col.deleteOne({ _id: toObjectId(folderId) });
    },

    async autoOrganizeFolders(version: string, actorId: string): Promise<{ foldersCreated: number; endpointsPlaced: number }> {
      const db = await getDb();
      const endpointRaws = await db.collection(COLLECTIONS.endpoints).find({ version }).toArray();
      const rawEndpoints = endpointRaws.map((raw) => fromMongo<EndpointDoc>(raw));

      const resolved = await Promise.all(
        rawEndpoints.map(async (endpoint) => {
          const overrideRaws = await db
            .collection(COLLECTIONS.overrides)
            .find({ targetId: new RegExp(`^${escapeRegExp(endpoint.vayoId)}\\.`) })
            .toArray();
          return resolveEndpoint(endpoint, overrideRaws.map((raw) => fromMongo<OverrideDoc>(raw)));
        }),
      );

      const existingFolders = (await db.collection(COLLECTIONS.folders).find({ version }).sort({ order: 1 }).toArray()).map(
        (raw) => fromMongo<FolderDoc>(raw),
      );
      const folderIdByName = new Map(existingFolders.filter((f) => f.parentId === null).map((f) => [f.name, f._id] as const));

      // Seed each folder's next `order` from whatever's already placed
      // there, so a newly auto-placed endpoint never collides with a
      // human's existing arrangement inside that same folder.
      const nextOrderByFolderId = new Map<string, number>();
      for (const endpoint of resolved) {
        const placement = endpoint as unknown as { folderId?: string | null; order?: number };
        if (placement.folderId) {
          const current = nextOrderByFolderId.get(placement.folderId) ?? 0;
          nextOrderByFolderId.set(placement.folderId, Math.max(current, (placement.order ?? -1) + 1));
        }
      }

      let foldersCreated = 0;
      let endpointsPlaced = 0;
      const now = new Date().toISOString();

      for (const endpoint of resolved) {
        // Never touch an endpoint that has a placement of any kind already
        // — including one explicitly set to root (null) by a human, which
        // is itself a deliberate placement, not "unplaced".
        const placement = endpoint as unknown as { folderId?: string | null };
        if (placement.folderId !== undefined) continue;

        let folderId = folderIdByName.get(endpoint.group);
        if (!folderId) {
          const newFolder: Omit<FolderDoc, "_id"> = {
            name: endpoint.group,
            parentId: null,
            version,
            order: folderIdByName.size,
            createdBy: actorId,
            createdAt: now,
            updatedAt: now,
          };
          const result = await db.collection(COLLECTIONS.folders).insertOne(newFolder);
          folderId = result.insertedId.toString();
          folderIdByName.set(endpoint.group, folderId);
          foldersCreated++;
        }

        const order = nextOrderByFolderId.get(folderId) ?? 0;
        await db.collection(COLLECTIONS.overrides).findOneAndUpdate(
          { targetId: `${endpoint.vayoId}.folderId` },
          { $set: { targetId: `${endpoint.vayoId}.folderId`, value: folderId, updatedBy: actorId, updatedAt: now, reason: null } },
          { upsert: true },
        );
        await db.collection(COLLECTIONS.overrides).findOneAndUpdate(
          { targetId: `${endpoint.vayoId}.order` },
          { $set: { targetId: `${endpoint.vayoId}.order`, value: order, updatedBy: actorId, updatedAt: now, reason: null } },
          { upsert: true },
        );
        nextOrderByFolderId.set(folderId, order + 1);
        endpointsPlaced++;
      }

      return { foldersCreated, endpointsPlaced };
    },

    async createEnvironment(environment: Omit<EnvironmentDoc, "_id">): Promise<EnvironmentDoc> {
      const db = await getDb();
      const result = await db.collection(COLLECTIONS.environments).insertOne(environment);
      return { ...environment, _id: result.insertedId.toString() };
    },

    async listEnvironments(): Promise<EnvironmentDoc[]> {
      const db = await getDb();
      const raws = await db.collection(COLLECTIONS.environments).find({}).sort({ createdAt: 1 }).toArray();
      return raws.map((raw) => fromMongo<EnvironmentDoc>(raw));
    },

    async updateEnvironment(environmentId, patch): Promise<EnvironmentDoc | null> {
      const db = await getDb();
      const savedRaw = await db
        .collection(COLLECTIONS.environments)
        .findOneAndUpdate(
          { _id: toObjectId(environmentId) },
          { $set: { ...patch, updatedAt: new Date().toISOString() } },
          { returnDocument: "after" },
        );
      return savedRaw ? fromMongo<EnvironmentDoc>(savedRaw) : null;
    },

    async deleteEnvironment(environmentId: string): Promise<void> {
      const db = await getDb();
      await db.collection(COLLECTIONS.environments).deleteOne({ _id: toObjectId(environmentId) });
    },

    async pinExample(example): Promise<ExampleDoc> {
      const db = await getDb();
      const doc: Omit<ExampleDoc, "_id"> = { ...example, pinned: true };
      const result = await db.collection(COLLECTIONS.examples).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    },

    // Returns EVERY example for this endpoint — both the rolling-window
    // captures appendExample writes and anything pinExample pinned. Every
    // caller either wants the mixed list directly (the UI's
    // mostRecentOrPinned prefers a pinned one, falling back to the most
    // recent capture) or filters down to `.pinned` itself (the Postman
    // export in both @vayo/server and @vayo/cli) — never pre-filter here.
    async listExamples(vayoId: string): Promise<ExampleDoc[]> {
      const db = await getDb();
      const raws = await db
        .collection(COLLECTIONS.examples)
        .find({ vayoId })
        .sort({ capturedAt: -1 })
        .toArray();
      return raws.map((raw) => fromMongo<ExampleDoc>(raw));
    },

    async deleteExample(exampleId: string): Promise<void> {
      const db = await getDb();
      await db.collection(COLLECTIONS.examples).deleteOne({ _id: toObjectId(exampleId) });
    },

    async getTestScript(vayoId: string): Promise<TestScriptDoc | null> {
      const db = await getDb();
      const raw = await db.collection(COLLECTIONS.testScripts).findOne({ vayoId });
      return raw ? fromMongo<TestScriptDoc>(raw) : null;
    },

    async upsertTestScript(vayoId, scripts, updatedBy): Promise<TestScriptDoc> {
      const db = await getDb();
      const now = new Date().toISOString();
      const savedRaw = await db.collection(COLLECTIONS.testScripts).findOneAndUpdate(
        { vayoId },
        { $set: { vayoId, ...scripts, updatedBy, updatedAt: now }, $setOnInsert: { lastRun: null } },
        { upsert: true, returnDocument: "after" },
      );
      return fromMongo<TestScriptDoc>(savedRaw!);
    },

    async recordTestRun(vayoId: string, run: TestRunResult): Promise<TestScriptDoc | null> {
      const db = await getDb();
      const savedRaw = await db
        .collection(COLLECTIONS.testScripts)
        .findOneAndUpdate({ vayoId }, { $set: { lastRun: run } }, { returnDocument: "after" });
      return savedRaw ? fromMongo<TestScriptDoc>(savedRaw) : null;
    },

    async createFlow(flow: Omit<FlowDoc, "_id">): Promise<FlowDoc> {
      const db = await getDb();
      const result = await db.collection(COLLECTIONS.flows).insertOne(flow);
      return { ...flow, _id: result.insertedId.toString() };
    },

    async listFlows(version: string): Promise<FlowDoc[]> {
      const db = await getDb();
      const raws = await db.collection(COLLECTIONS.flows).find({ version }).sort({ createdAt: 1 }).toArray();
      return raws.map((raw) => fromMongo<FlowDoc>(raw));
    },

    async updateFlow(flowId, patch): Promise<FlowDoc | null> {
      const db = await getDb();
      const savedRaw = await db
        .collection(COLLECTIONS.flows)
        .findOneAndUpdate(
          { _id: toObjectId(flowId) },
          { $set: { ...patch, updatedAt: new Date().toISOString() } },
          { returnDocument: "after" },
        );
      return savedRaw ? fromMongo<FlowDoc>(savedRaw) : null;
    },

    async deleteFlow(flowId: string): Promise<void> {
      const db = await getDb();
      await db.collection(COLLECTIONS.flows).deleteOne({ _id: toObjectId(flowId) });
    },

    async createApiVersion(apiVersion: Omit<ApiVersionDoc, "_id">): Promise<ApiVersionDoc> {
      const db = await getDb();
      const result = await db.collection(COLLECTIONS.apiVersions).insertOne(apiVersion);
      return { ...apiVersion, _id: result.insertedId.toString() };
    },

    async listApiVersions(): Promise<ApiVersionDoc[]> {
      const db = await getDb();
      const raws = await db.collection(COLLECTIONS.apiVersions).find({}).sort({ version: 1 }).toArray();
      return raws.map((raw) => fromMongo<ApiVersionDoc>(raw));
    },

    async updateApiVersion(version, patch): Promise<ApiVersionDoc | null> {
      const db = await getDb();
      const savedRaw = await db
        .collection(COLLECTIONS.apiVersions)
        .findOneAndUpdate({ version }, { $set: patch }, { returnDocument: "after" });
      return savedRaw ? fromMongo<ApiVersionDoc>(savedRaw) : null;
    },

    async createNotification(notification: Omit<NotificationDoc, "_id">): Promise<NotificationDoc> {
      const db = await getDb();
      const result = await db.collection(COLLECTIONS.notifications).insertOne(notification);
      return { ...notification, _id: result.insertedId.toString() };
    },

    async listNotifications(limit: number): Promise<NotificationDoc[]> {
      const db = await getDb();
      const raws = await db.collection(COLLECTIONS.notifications).find({}).sort({ createdAt: -1 }).limit(limit).toArray();
      return raws.map((raw) => fromMongo<NotificationDoc>(raw));
    },

    async markNotificationsSeen(memberId: string, at: string): Promise<void> {
      const db = await getDb();
      await db.collection(COLLECTIONS.teamMembers).updateOne({ _id: toObjectId(memberId) }, { $set: { lastSeenNotificationsAt: at } });
    },
  };
}
