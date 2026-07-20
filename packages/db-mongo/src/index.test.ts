// Integration tests against a real MongoDB instance — no mocking layer over
// the driver, matching this project's own testing philosophy for the BYODB
// layer (docs/09-roadmap.md M1: "against a real local MongoDB"). Defaults to
// the same local instance the rest of the repo's manual verification uses,
// pointed at a dedicated database so it never collides with real captured
// data (e.g. apps/demo-app's own `vayo_demo`). Override with
// VAYO_TEST_MONGO_URI to point at a different instance (e.g. in CI).
import { MongoClient } from "mongodb";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CapturedSample } from "@vayo/types";
import { ATTACHMENTS_BUCKET, COLLECTIONS, createAdapter, runMigrations } from "./index.js";

const TEST_MONGO_URI = process.env.VAYO_TEST_MONGO_URI ?? "mongodb://localhost:27017/vayo_test_dbmongo";

const client = new MongoClient(TEST_MONGO_URI);
const adapter = createAdapter(TEST_MONGO_URI);

async function clearAllCollections(): Promise<void> {
  const db = client.db();
  await Promise.all([
    ...Object.values(COLLECTIONS).map((name) => db.collection(name).deleteMany({})),
    // GridFS bucket collections — not in COLLECTIONS since it's two
    // physical collections, not one (see ATTACHMENTS_BUCKET's own comment).
    db.collection(`${ATTACHMENTS_BUCKET}.files`).deleteMany({}),
    db.collection(`${ATTACHMENTS_BUCKET}.chunks`).deleteMany({}),
  ]);
}

beforeEach(async () => {
  await client.connect();
  await clearAllCollections();
});

afterAll(async () => {
  await client.db().dropDatabase();
  await client.close();
});

function sample(overrides: Partial<CapturedSample> = {}): CapturedSample {
  return {
    method: "GET",
    pathTemplate: "/api/v1/widgets/:id",
    version: "v1",
    requestHeaders: {},
    requestParams: { id: "abc123" },
    requestQuery: {},
    requestBody: null,
    responseStatus: 200,
    responseBody: { id: "abc123", name: "Widget" },
    middlewareNames: ["authenticate"],
    capturedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("runMigrations", () => {
  it("creates every vayo_ collection's indexes without error, idempotently", async () => {
    await runMigrations(TEST_MONGO_URI);
    await runMigrations(TEST_MONGO_URI); // must not throw on a second run

    const indexNames = await client.db().collection(COLLECTIONS.endpoints).indexes();
    expect(indexNames.some((idx) => idx.key && "vayoId" in idx.key)).toBe(true);
  });
});

describe("createAdapter — upsertEndpoint", () => {
  it("creates a new EndpointDoc on first sample, and merges a second sample into the same doc", async () => {
    const first = await adapter.upsertEndpoint(sample());
    expect(first.sampleCount).toBe(1);
    expect(first.source).toBe("runtime");

    const second = await adapter.upsertEndpoint(
      sample({ requestParams: { id: "def456" }, capturedAt: "2026-07-02T00:00:00.000Z" }),
    );
    expect(second.vayoId).toBe(first.vayoId);
    expect(second.sampleCount).toBe(2);

    const all = await client.db().collection(COLLECTIONS.endpoints).find({}).toArray();
    expect(all).toHaveLength(1); // collapsed into one doc, not two
  });

  it("writes a schema_change audit-log entry when the inferred schema widens", async () => {
    const created = await adapter.upsertEndpoint(sample({ responseBody: { id: "abc123", name: "Widget" } }));
    // Creation itself is a "change" (no schema -> some schema) and is logged.
    expect(await adapter.listAuditLog(created.vayoId)).toHaveLength(1);

    const widened = await adapter.upsertEndpoint(
      sample({
        responseBody: { id: "abc123", name: "Widget", price: 9.99 },
        capturedAt: "2026-07-02T00:00:00.000Z",
      }),
    );

    const log = await adapter.listAuditLog(widened.vayoId);
    expect(log).toHaveLength(2);
    expect(log.every((entry) => entry.action === "schema_change" && entry.actorType === "system")).toBe(true);
  });

  it("does not write a second audit-log entry when a later sample doesn't change the schema", async () => {
    const doc = await adapter.upsertEndpoint(sample());
    expect(await adapter.listAuditLog(doc.vayoId)).toHaveLength(1); // the initial creation

    await adapter.upsertEndpoint(sample({ requestParams: { id: "different-id-same-shape" } }));

    const log = await adapter.listAuditLog(doc.vayoId);
    expect(log).toHaveLength(1); // unchanged — same shape as before
  });

  it("does NOT create a notification for a brand-new endpoint's first sample — only for a real change to a known one", async () => {
    const first = await adapter.upsertEndpoint(sample());
    expect(await adapter.listNotifications(50)).toHaveLength(0);

    await adapter.upsertEndpoint(
      sample({ responseBody: { id: "abc123", name: "Widget", price: 9.99 }, capturedAt: "2026-07-02T00:00:00.000Z" }),
    );

    const notifications = await adapter.listNotifications(50);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ type: "schema_change", vayoId: first.vayoId, actorId: null });
    expect(notifications[0]!.message).toContain("GET");
  });
});

describe("createAdapter — overrides", () => {
  it("upserts by targetId (one override doc per field, not one per write)", async () => {
    await adapter.upsertOverride({
      targetId: "ep_1.summary",
      value: "Fetch a widget",
      updatedBy: "member_1",
      updatedAt: "2026-07-01T00:00:00.000Z",
      reason: null,
    });
    await adapter.upsertOverride({
      targetId: "ep_1.summary",
      value: "Fetch one widget by id",
      updatedBy: "member_2",
      updatedAt: "2026-07-02T00:00:00.000Z",
      reason: "clarify",
    });

    const found = await adapter.getOverride("ep_1.summary");
    expect(found?.value).toBe("Fetch one widget by id");
    expect(found?.updatedBy).toBe("member_2");

    const count = await client.db().collection(COLLECTIONS.overrides).countDocuments({ targetId: "ep_1.summary" });
    expect(count).toBe(1);
  });

  it("listOverrides only returns overrides scoped to the given vayoId, not a prefix collision", async () => {
    await adapter.upsertOverride({
      targetId: "ep_1.summary",
      value: "A",
      updatedBy: "m",
      updatedAt: "2026-07-01T00:00:00.000Z",
      reason: null,
    });
    await adapter.upsertOverride({
      targetId: "ep_10.summary", // shares the "ep_1" prefix but is a different endpoint
      value: "B",
      updatedBy: "m",
      updatedAt: "2026-07-01T00:00:00.000Z",
      reason: null,
    });

    const forEp1 = await adapter.listOverrides("ep_1");
    expect(forEp1).toHaveLength(1);
    expect(forEp1[0]!.targetId).toBe("ep_1.summary");
  });
});

describe("createAdapter — appendExample rolling cap", () => {
  it("keeps only the 5 most recent non-pinned examples per (vayoId, statusCode)", async () => {
    for (let i = 0; i < 7; i++) {
      await adapter.appendExample({
        vayoId: "ep_1",
        statusCode: 200,
        requestBody: null,
        responseBody: { i },
        capturedAt: new Date(2026, 0, i + 1).toISOString(),
        redacted: false,
        pinned: false,
        label: null,
      });
    }
    const remaining = await client.db().collection(COLLECTIONS.examples).find({ vayoId: "ep_1" }).toArray();
    expect(remaining).toHaveLength(5);
    // the most recent 5 (i = 2..6) survive; the oldest two (i = 0, 1) are pruned
    const survivingIs = remaining.map((doc) => (doc.responseBody as { i: number }).i).sort((a, b) => a - b);
    expect(survivingIs).toEqual([2, 3, 4, 5, 6]);
  });

  it("never prunes a pinned example even past the cap", async () => {
    await adapter.pinExample({
      vayoId: "ep_1",
      statusCode: 200,
      requestBody: null,
      responseBody: { pinned: true },
      capturedAt: "2026-01-01T00:00:00.000Z",
      redacted: false,
      label: "Golden path",
    });
    for (let i = 0; i < 6; i++) {
      await adapter.appendExample({
        vayoId: "ep_1",
        statusCode: 200,
        requestBody: null,
        responseBody: { i },
        capturedAt: new Date(2026, 1, i + 1).toISOString(),
        redacted: false,
        pinned: false,
        label: null,
      });
    }
    const pinned = await client.db().collection(COLLECTIONS.examples).find({ vayoId: "ep_1", pinned: true }).toArray();
    expect(pinned).toHaveLength(1);
  });

  it("listExamples returns the full mixed list (rolling-window + pinned), most recent first — every caller relies on this, not a pinned-only filter", async () => {
    await adapter.appendExample({
      vayoId: "ep_1",
      statusCode: 200,
      requestBody: null,
      responseBody: { kind: "recent-capture" },
      capturedAt: "2026-03-01T00:00:00.000Z",
      redacted: false,
      pinned: false,
      label: null,
    });
    await adapter.pinExample({
      vayoId: "ep_1",
      statusCode: 200,
      requestBody: null,
      responseBody: { kind: "pinned" },
      capturedAt: "2026-01-01T00:00:00.000Z", // older, but pinned
      redacted: false,
      label: "Golden path",
    });

    const all = await adapter.listExamples("ep_1");
    expect(all).toHaveLength(2);
    expect(all.some((e) => e.pinned)).toBe(true);
    expect(all.some((e) => !e.pinned)).toBe(true);
  });
});

describe("createAdapter — invites", () => {
  it("markInviteUsed only succeeds once — a second redemption of the same token is rejected", async () => {
    await adapter.createInvite({
      tokenHash: "hash_1",
      email: "new@corp.com",
      role: "editor",
      createdBy: "owner_1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      usedAt: null,
    });

    const firstRedemption = await adapter.markInviteUsed("hash_1", "2026-07-01T00:00:00.000Z");
    expect(firstRedemption?.usedAt).toBe("2026-07-01T00:00:00.000Z");

    const secondRedemption = await adapter.markInviteUsed("hash_1", "2026-07-02T00:00:00.000Z");
    expect(secondRedemption).toBeNull();

    const stored = await adapter.getInviteByTokenHash("hash_1");
    expect(stored?.usedAt).toBe("2026-07-01T00:00:00.000Z"); // unchanged by the rejected second attempt
  });

  it("listPendingInvites returns only invites not yet redeemed", async () => {
    await adapter.createInvite({
      tokenHash: "hash_pending",
      email: "pending@corp.com",
      role: "viewer",
      createdBy: "owner_1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      usedAt: null,
    });
    await adapter.createInvite({
      tokenHash: "hash_used",
      email: "used@corp.com",
      role: "viewer",
      createdBy: "owner_1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      usedAt: "2026-01-01T00:00:00.000Z",
    });

    const pending = await adapter.listPendingInvites();
    expect(pending.map((i) => i.email)).toEqual(["pending@corp.com"]);
  });

  it("revokeInvite deletes a not-yet-used invite so its token can never be redeemed", async () => {
    const invite = await adapter.createInvite({
      tokenHash: "hash_revoke_me",
      email: "wrong@corp.com",
      role: "viewer",
      createdBy: "owner_1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      usedAt: null,
    });

    const revoked = await adapter.revokeInvite(invite._id);
    expect(revoked?.email).toBe("wrong@corp.com");

    expect(await adapter.getInviteByTokenHash("hash_revoke_me")).toBeNull();
    expect(await adapter.markInviteUsed("hash_revoke_me", new Date().toISOString())).toBeNull();
  });

  it("revokeInvite refuses to delete an invite that was already redeemed", async () => {
    const invite = await adapter.createInvite({
      tokenHash: "hash_already_used",
      email: "already@corp.com",
      role: "viewer",
      createdBy: "owner_1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      usedAt: "2026-01-01T00:00:00.000Z",
    });

    const revoked = await adapter.revokeInvite(invite._id);
    expect(revoked).toBeNull();
    expect(await adapter.getInviteByTokenHash("hash_already_used")).not.toBeNull();
  });
});

describe("createAdapter — team members", () => {
  it("updateTeamMemberName changes the stored name and nothing else", async () => {
    const member = await adapter.createTeamMember({
      email: "rename-me@corp.com",
      name: "Original Name",
      role: "editor",
      passwordHash: null,
      status: "active",
      invitedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenNotificationsAt: null,
      avatarUrl: null,
      lastSeenAt: null,
      nicknames: {},
    });

    const updated = await adapter.updateTeamMemberName(member._id, "New Name");
    expect(updated?.name).toBe("New Name");
    expect(updated?.role).toBe("editor");
  });

  it("updateTeamMemberAvatar sets and clears avatarUrl", async () => {
    const member = await adapter.createTeamMember({
      email: "avatar-me@corp.com",
      name: "Avatar Tester",
      role: "editor",
      passwordHash: null,
      status: "active",
      invitedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenNotificationsAt: null,
      avatarUrl: null,
      lastSeenAt: null,
      nicknames: {},
    });

    const withAvatar = await adapter.updateTeamMemberAvatar(member._id, "data:image/png;base64,Zm9v");
    expect(withAvatar?.avatarUrl).toBe("data:image/png;base64,Zm9v");

    const cleared = await adapter.updateTeamMemberAvatar(member._id, null);
    expect(cleared?.avatarUrl).toBeNull();
  });

  it("touchTeamMemberLastSeen stamps lastSeenAt", async () => {
    const member = await adapter.createTeamMember({
      email: "lastseen-me@corp.com",
      name: "Last Seen Tester",
      role: "viewer",
      passwordHash: null,
      status: "active",
      invitedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenNotificationsAt: null,
      avatarUrl: null,
      lastSeenAt: null,
      nicknames: {},
    });
    expect((await adapter.getTeamMember(member._id))?.lastSeenAt).toBeNull();

    await adapter.touchTeamMemberLastSeen(member._id, "2026-01-02T00:00:00.000Z");
    expect((await adapter.getTeamMember(member._id))?.lastSeenAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("setNicknameForMember sets/clears one entry in the CALLER's own nicknames map without touching the target's doc", async () => {
    const caller = await adapter.createTeamMember({
      email: "caller@corp.com",
      name: "Caller",
      role: "editor",
      passwordHash: null,
      status: "active",
      invitedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenNotificationsAt: null,
      avatarUrl: null,
      lastSeenAt: null,
      nicknames: {},
    });
    const target = await adapter.createTeamMember({
      email: "target@corp.com",
      name: "Sayantan",
      role: "editor",
      passwordHash: null,
      status: "active",
      invitedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenNotificationsAt: null,
      avatarUrl: null,
      lastSeenAt: null,
      nicknames: {},
    });

    const withNickname = await adapter.setNicknameForMember(caller._id, target._id, "SC sir");
    expect(withNickname?.nicknames[target._id]).toBe("SC sir");
    // The target's own doc — and their own nickname book, if they have one
    // for someone else — is completely untouched by the caller's edit.
    expect((await adapter.getTeamMember(target._id))?.name).toBe("Sayantan");

    const cleared = await adapter.setNicknameForMember(caller._id, target._id, null);
    expect(cleared?.nicknames[target._id]).toBeUndefined();
  });

  it("deleteTeamMember removes the member and returns true", async () => {
    const member = await adapter.createTeamMember({
      email: "remove-me@corp.com",
      name: "Wrong Invitee",
      role: "viewer",
      passwordHash: null,
      status: "active",
      invitedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenNotificationsAt: null,
      avatarUrl: null,
      lastSeenAt: null,
      nicknames: {},
    });

    expect(await adapter.deleteTeamMember(member._id)).toBe(true);
    expect(await adapter.getTeamMember(member._id)).toBeNull();
  });

  it("deleteTeamMember returns false for a member that doesn't exist", async () => {
    expect(await adapter.deleteTeamMember("000000000000000000000000")).toBe(false);
  });
});

describe("createAdapter — sessions", () => {
  it("deleteSessionsByMemberId removes every session for that member, leaving others untouched", async () => {
    await adapter.createSession({ memberId: "member_a", tokenHash: "tok_a1", expiresAt: "2099-01-01T00:00:00.000Z" });
    await adapter.createSession({ memberId: "member_a", tokenHash: "tok_a2", expiresAt: "2099-01-01T00:00:00.000Z" });
    await adapter.createSession({ memberId: "member_b", tokenHash: "tok_b1", expiresAt: "2099-01-01T00:00:00.000Z" });

    await adapter.deleteSessionsByMemberId("member_a");

    expect(await adapter.getSessionByTokenHash("tok_a1")).toBeNull();
    expect(await adapter.getSessionByTokenHash("tok_a2")).toBeNull();
    expect(await adapter.getSessionByTokenHash("tok_b1")).not.toBeNull();
  });
});

describe("createAdapter — createManualEndpoint", () => {
  it("refuses to create a duplicate for the same (method, path, version)", async () => {
    await adapter.createManualEndpoint({
      method: "post",
      pathTemplate: "/api/v1/widgets",
      version: "v1",
      group: "Widgets",
      summary: "Create a widget",
    });

    await expect(
      adapter.createManualEndpoint({
        method: "post",
        pathTemplate: "/api/v1/widgets",
        version: "v1",
        group: "Widgets",
        summary: "Duplicate",
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("uses the same vayoId real traffic would use, so later capture merges instead of duplicating", async () => {
    const manual = await adapter.createManualEndpoint({
      method: "post",
      pathTemplate: "/api/v1/widgets",
      version: "v1",
      group: "Widgets",
      summary: "Create a widget",
    });
    expect(manual.source).toBe("manual");

    const merged = await adapter.upsertEndpoint(
      sample({ method: "POST", pathTemplate: "/api/v1/widgets", responseStatus: 201, responseBody: { id: "w1" } }),
    );
    expect(merged.vayoId).toBe(manual.vayoId);
    expect(merged.source).toBe("merged"); // manual -> merged, never demoted back to "runtime"
    expect(merged.summary).toBe("Create a widget"); // the human-provided summary survived
  });
});

describe("createAdapter — deleteEndpoint", () => {
  it("removes the endpoint doc and returns true", async () => {
    const manual = await adapter.createManualEndpoint({
      method: "post",
      pathTemplate: "/api/v1/scratch",
      version: "v1",
      group: "Scratch",
      summary: "A stub",
    });

    expect(await adapter.deleteEndpoint(manual.vayoId)).toBe(true);
    expect(await adapter.getEndpoint(manual.vayoId)).toBeNull();
  });

  it("returns false for a vayoId that doesn't exist", async () => {
    expect(await adapter.deleteEndpoint("no-such-vayo-id")).toBe(false);
  });
});

describe("createAdapter — folders", () => {
  it("reparents direct children to the deleted folder's own parent rather than cascading or orphaning", async () => {
    const grandparent = await adapter.createFolder({
      name: "API",
      parentId: null,
      version: "v1",
      order: 0,
      createdBy: "m",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const parent = await adapter.createFolder({
      name: "Widgets",
      parentId: grandparent._id,
      version: "v1",
      order: 0,
      createdBy: "m",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const child = await adapter.createFolder({
      name: "Legacy widgets",
      parentId: parent._id,
      version: "v1",
      order: 0,
      createdBy: "m",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });

    await adapter.deleteFolder(parent._id);

    const reparentedChild = await adapter.getFolder(child._id);
    expect(reparentedChild?.parentId).toBe(grandparent._id);
    expect(await adapter.getFolder(parent._id)).toBeNull();
  });

  it("autoOrganizeFolders only places endpoints that have never had any folder placement, including an explicit root (null) placement", async () => {
    const unplaced = await adapter.upsertEndpoint(sample({ pathTemplate: "/api/v1/widgets/:id" }));
    const explicitlyAtRoot = await adapter.upsertEndpoint(
      sample({ pathTemplate: "/api/v1/gadgets/:id", method: "GET" }),
    );
    // A human explicitly placed this one at root — a deliberate placement, not "unplaced".
    await adapter.upsertOverride({
      targetId: `${explicitlyAtRoot.vayoId}.folderId`,
      value: null,
      updatedBy: "owner_1",
      updatedAt: "2026-07-01T00:00:00.000Z",
      reason: null,
    });

    const result = await adapter.autoOrganizeFolders("v1", "owner_1");
    expect(result.endpointsPlaced).toBe(1);
    expect(result.foldersCreated).toBe(1);

    const placementForUnplaced = await adapter.getOverride(`${unplaced.vayoId}.folderId`);
    expect(placementForUnplaced?.value).toBeTruthy();

    const placementForExplicit = await adapter.getOverride(`${explicitlyAtRoot.vayoId}.folderId`);
    expect(placementForExplicit?.value).toBeNull(); // left exactly as the human set it
  });
});

describe("createAdapter — comment flagging", () => {
  it("toggles flagged independently of resolved", async () => {
    const comment = await adapter.createComment({
      vayoIds: ["ep_1"],
      authorId: "m1",
      body: "does this need auth?",
      replyToId: null,
      flagged: false,
      resolved: false,
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    const flagged = await adapter.setCommentFlagged(comment._id, true);
    expect(flagged?.flagged).toBe(true);
    expect(flagged?.resolved).toBe(false);

    const unflagged = await adapter.setCommentFlagged(comment._id, false);
    expect(unflagged?.flagged).toBe(false);
  });

  it("returns null for an unknown comment id", async () => {
    const result = await adapter.setCommentFlagged("64f1a2b3c4d5e6f7a8b9c0d1", true);
    expect(result).toBeNull();
  });
});

describe("createAdapter — cross-cutting comments", () => {
  it("listComments matches a comment whose vayoIds includes the given endpoint, even when it's not the only one", async () => {
    await adapter.createComment({
      vayoIds: ["ep_a", "ep_b"],
      authorId: "m1",
      body: "does #[/b](ep_b) relate to this?",
      replyToId: null,
      flagged: false,
      resolved: false,
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(await adapter.listComments("ep_a")).toHaveLength(1);
    expect(await adapter.listComments("ep_b")).toHaveLength(1);
    expect(await adapter.listComments("ep_c")).toHaveLength(0);
  });

  it("listCrossCuttingComments returns only comments tagging 2+ endpoints, newest first", async () => {
    await adapter.createComment({
      vayoIds: ["ep_1"],
      authorId: "m1",
      body: "single-endpoint message",
      replyToId: null,
      flagged: false,
      resolved: false,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    await adapter.createComment({
      vayoIds: ["ep_1", "ep_2"],
      authorId: "m1",
      body: "older cross-cutting message",
      replyToId: null,
      flagged: false,
      resolved: false,
      createdAt: "2026-07-02T00:00:00.000Z",
    });
    await adapter.createComment({
      vayoIds: ["ep_1", "ep_2", "ep_3"],
      authorId: "m1",
      body: "newer cross-cutting message",
      replyToId: null,
      flagged: false,
      resolved: false,
      createdAt: "2026-07-03T00:00:00.000Z",
    });

    const crossCutting = await adapter.listCrossCuttingComments(50);
    expect(crossCutting.map((c) => c.body)).toEqual(["newer cross-cutting message", "older cross-cutting message"]);
  });

  it("listCrossCuttingComments respects the limit", async () => {
    for (let i = 0; i < 3; i++) {
      await adapter.createComment({
        vayoIds: ["ep_1", "ep_2"],
        authorId: "m1",
        body: `message ${i}`,
        replyToId: null,
        flagged: false,
        resolved: false,
        createdAt: new Date(2026, 0, i + 1).toISOString(),
      });
    }

    expect(await adapter.listCrossCuttingComments(2)).toHaveLength(2);
  });
});

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("createAdapter — attachments (GridFS)", () => {
  it("uploads a file and stores it unclaimed (commentId null)", async () => {
    const attachment = await adapter.uploadAttachment({
      vayoId: "ep_1",
      filename: "screenshot.png",
      mimeType: "image/png",
      kind: "file",
      uploadedBy: "m1",
      data: Buffer.from("fake-png-bytes"),
    });

    expect(attachment.commentId).toBeNull();
    expect(attachment.vayoId).toBe("ep_1");
    expect(attachment.filename).toBe("screenshot.png");
    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.kind).toBe("file");
    expect(attachment.uploadedBy).toBe("m1");
    expect(attachment.sizeBytes).toBe(Buffer.from("fake-png-bytes").length);
  });

  it("round-trips the exact bytes uploaded through downloadAttachment", async () => {
    const data = Buffer.from("the real content of this file, byte for byte");
    const attachment = await adapter.uploadAttachment({
      vayoId: "ep_1",
      filename: "log.txt",
      mimeType: "text/plain",
      kind: "file",
      uploadedBy: "m1",
      data,
    });

    const result = await adapter.downloadAttachment(attachment._id);
    expect(result).not.toBeNull();
    expect(result!.attachment.filename).toBe("log.txt");
    const downloaded = await readStream(result!.stream as NodeJS.ReadableStream);
    expect(downloaded.equals(data)).toBe(true);
  });

  it("returns null from downloadAttachment/getAttachment for an unknown id", async () => {
    expect(await adapter.downloadAttachment("64f1a2b3c4d5e6f7a8b9c0d1")).toBeNull();
    expect(await adapter.getAttachment("64f1a2b3c4d5e6f7a8b9c0d1")).toBeNull();
  });

  it("lists every attachment for a conversation, not other endpoints' attachments", async () => {
    await adapter.uploadAttachment({ vayoId: "ep_1", filename: "a.png", mimeType: "image/png", kind: "file", uploadedBy: "m1", data: Buffer.from("a") });
    await adapter.uploadAttachment({ vayoId: "ep_1", filename: "b.png", mimeType: "image/png", kind: "file", uploadedBy: "m1", data: Buffer.from("b") });
    await adapter.uploadAttachment({ vayoId: "ep_2", filename: "c.png", mimeType: "image/png", kind: "file", uploadedBy: "m1", data: Buffer.from("c") });

    const forEp1 = await adapter.listAttachments("ep_1");
    expect(forEp1.map((a) => a.filename).sort()).toEqual(["a.png", "b.png"]);
  });

  it("claims unclaimed attachments uploaded by the same actor once a comment is created", async () => {
    const a1 = await adapter.uploadAttachment({ vayoId: "ep_1", filename: "a.png", mimeType: "image/png", kind: "file", uploadedBy: "m1", data: Buffer.from("a") });
    const a2 = await adapter.uploadAttachment({ vayoId: "ep_1", filename: "b.png", mimeType: "image/png", kind: "screen-recording", uploadedBy: "m1", data: Buffer.from("b") });

    await adapter.claimAttachments("comment_1", [a1._id, a2._id], "m1");

    const claimed1 = await adapter.getAttachment(a1._id);
    const claimed2 = await adapter.getAttachment(a2._id);
    expect(claimed1?.commentId).toBe("comment_1");
    expect(claimed2?.commentId).toBe("comment_1");
  });

  it("does not claim an attachment uploaded by a different member (can't steal someone else's upload)", async () => {
    const a1 = await adapter.uploadAttachment({ vayoId: "ep_1", filename: "a.png", mimeType: "image/png", kind: "file", uploadedBy: "m1", data: Buffer.from("a") });

    await adapter.claimAttachments("comment_1", [a1._id], "m2");

    const stillUnclaimed = await adapter.getAttachment(a1._id);
    expect(stillUnclaimed?.commentId).toBeNull();
  });

  it("does not re-claim an attachment that's already claimed by an earlier comment", async () => {
    const a1 = await adapter.uploadAttachment({ vayoId: "ep_1", filename: "a.png", mimeType: "image/png", kind: "file", uploadedBy: "m1", data: Buffer.from("a") });
    await adapter.claimAttachments("comment_1", [a1._id], "m1");

    await adapter.claimAttachments("comment_2", [a1._id], "m1");

    const stillOnFirstComment = await adapter.getAttachment(a1._id);
    expect(stillOnFirstComment?.commentId).toBe("comment_1");
  });

  it("deletes an unclaimed attachment uploaded by the same actor (removing a pending chip)", async () => {
    const a1 = await adapter.uploadAttachment({ vayoId: "ep_1", filename: "a.png", mimeType: "image/png", kind: "file", uploadedBy: "m1", data: Buffer.from("a") });

    const deleted = await adapter.deleteUnclaimedAttachment(a1._id, "m1");
    expect(deleted).toBe(true);
    expect(await adapter.getAttachment(a1._id)).toBeNull();
  });

  it("refuses to delete an attachment uploaded by a different member", async () => {
    const a1 = await adapter.uploadAttachment({ vayoId: "ep_1", filename: "a.png", mimeType: "image/png", kind: "file", uploadedBy: "m1", data: Buffer.from("a") });

    const deleted = await adapter.deleteUnclaimedAttachment(a1._id, "m2");
    expect(deleted).toBe(false);
    expect(await adapter.getAttachment(a1._id)).not.toBeNull();
  });

  it("refuses to delete an attachment that's already claimed by a comment", async () => {
    const a1 = await adapter.uploadAttachment({ vayoId: "ep_1", filename: "a.png", mimeType: "image/png", kind: "file", uploadedBy: "m1", data: Buffer.from("a") });
    await adapter.claimAttachments("comment_1", [a1._id], "m1");

    const deleted = await adapter.deleteUnclaimedAttachment(a1._id, "m1");
    expect(deleted).toBe(false);
    expect(await adapter.getAttachment(a1._id)).not.toBeNull();
  });
});

describe("createAdapter — notifications", () => {
  it("creates and lists notifications newest-first, respecting the limit", async () => {
    for (let i = 0; i < 3; i++) {
      await adapter.createNotification({
        type: "comment",
        vayoId: "ep_1",
        actorId: "m1",
        message: `message ${i}`,
        mentionedMemberIds: [],
        targetId: null,
        createdAt: new Date(2026, 0, i + 1).toISOString(),
      });
    }
    const all = await adapter.listNotifications(50);
    expect(all.map((n) => n.message)).toEqual(["message 2", "message 1", "message 0"]);

    const capped = await adapter.listNotifications(2);
    expect(capped).toHaveLength(2);
  });

  it("markNotificationsSeen stamps the member's lastSeenNotificationsAt", async () => {
    const member = await adapter.createTeamMember({
      email: "seen@corp.test",
      name: "Seen Tester",
      role: "viewer",
      passwordHash: null,
      status: "active",
      invitedBy: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastSeenNotificationsAt: null,
      avatarUrl: null,
      lastSeenAt: null,
      nicknames: {},
    });
    expect(member.lastSeenNotificationsAt).toBeNull();

    await adapter.markNotificationsSeen(member._id, "2026-07-02T00:00:00.000Z");

    const updated = await adapter.getTeamMember(member._id);
    expect(updated?.lastSeenNotificationsAt).toBe("2026-07-02T00:00:00.000Z");
  });
});
