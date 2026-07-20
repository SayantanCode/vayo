// Socket.IO gateway tests (docs/06-realtime-collaboration.md). Uses a real
// listening HTTP server + real socket.io-client connections — Socket.IO's
// handshake/room behavior isn't meaningfully testable through mocks.
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./index.js";
import { createFakeDb, seedMemberWithSession } from "./test-helpers/fakeDb.js";

const SESSION_SECRET = "test-session-secret";
// No mountPath given below → defaults to "/vayo" → Socket.IO's own default
// path is "/vayo/socket.io" (docs/06-realtime-collaboration.md), not
// Engine.IO's bare "/socket.io" — the client below has to match it.
const SOCKET_PATH = "/vayo/socket.io";
const db = createFakeDb();
const { httpServer } = createServer({ db, sessionSecret: SESSION_SECRET });

let baseUrl: string;
const openSockets: ClientSocket[] = [];

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://localhost:${port}`;
});

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.disconnect();
});

afterAll(() => {
  httpServer.close();
});

function connect(token?: string): Promise<ClientSocket> {
  const socket = ioClient(baseUrl, {
    path: SOCKET_PATH,
    auth: token ? { token } : {},
    reconnection: false,
    forceNew: true,
    transports: ["websocket"],
  });
  openSockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (err) => reject(err));
  });
}

function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

describe("Socket.IO handshake auth", () => {
  it("rejects a connection with no token at all", async () => {
    const socket = ioClient(baseUrl, { path: SOCKET_PATH, reconnection: false, forceNew: true, transports: ["websocket"] });
    openSockets.push(socket);
    const err = await new Promise<Error>((resolve) => socket.on("connect_error", resolve));
    expect(err.message).toMatch(/unauthorized/i);
  });

  it("rejects a connection with a bogus token", async () => {
    const socket = ioClient(baseUrl, {
      path: SOCKET_PATH,
      auth: { token: "not-a-real-token" },
      reconnection: false,
      forceNew: true,
      transports: ["websocket"],
    });
    openSockets.push(socket);
    const err = await new Promise<Error>((resolve) => socket.on("connect_error", resolve));
    expect(err.message).toMatch(/unauthorized/i);
  });

  it("accepts a connection with a valid session token", async () => {
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const socket = await connect(token);
    expect(socket.connected).toBe(true);
  });
});

describe("presence", () => {
  it("broadcasts presence:join/leave to other sockets already in the same endpoint room", async () => {
    const { token: tokenA } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const { token: tokenB } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const a = await connect(tokenA);
    const b = await connect(tokenB);

    // B joins first and consumes its own self-broadcast (io.to(room) reaches
    // everyone already in the room, including the sender) before we listen
    // for the event this test actually cares about: A's join.
    const bOwnJoin = waitFor(b, "presence:join");
    b.emit("presence:join", { vayoId: "ep_1" });
    await bOwnJoin;

    const joinSeenByB = waitFor<{ vayoId: string; memberId: string }>(b, "presence:join");
    a.emit("presence:join", { vayoId: "ep_1" });
    const joinPayload = await joinSeenByB;
    expect(joinPayload.vayoId).toBe("ep_1");

    const leaveSeenByB = waitFor<{ vayoId: string; memberId: string }>(b, "presence:leave");
    a.emit("presence:leave", { vayoId: "ep_1" });
    const leavePayload = await leaveSeenByB;
    expect(leavePayload.memberId).toBe(joinPayload.memberId);
  });
});

describe("global presence — online/offline (distinct from the per-endpoint presence above)", () => {
  it("tells a freshly-connected socket which members are already online via presence:online-list", async () => {
    const { token: tokenB, member: memberB } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const b = await connect(tokenB);

    // The listener has to be attached before the handshake even starts —
    // presence:online-list is emitted the instant the connection handler
    // runs, with no explicit trigger from this test to hang a `waitFor`
    // off of, unlike every other event here.
    const { token: tokenA } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const socketA = ioClient(baseUrl, {
      path: SOCKET_PATH,
      auth: { token: tokenA },
      reconnection: false,
      forceNew: true,
      transports: ["websocket"],
    });
    openSockets.push(socketA);
    const onlineList = new Promise<{ memberIds: string[] }>((resolve) => socketA.once("presence:online-list", resolve));
    await new Promise<void>((resolve, reject) => {
      socketA.on("connect", () => resolve());
      socketA.on("connect_error", reject);
    });

    const payload = await onlineList;
    expect(payload.memberIds).toContain(memberB._id);
    expect(b.connected).toBe(true);
  });

  it("broadcasts presence:online to already-connected sockets when a new member connects", async () => {
    const { token: tokenA } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const { token: tokenB, member: memberB } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const a = await connect(tokenA);

    const onlineSeenByA = waitFor<{ memberId: string }>(a, "presence:online");
    const b = await connect(tokenB);
    const payload = await onlineSeenByA;
    expect(payload.memberId).toBe(memberB._id);
    expect(b.connected).toBe(true);
  });

  it("broadcasts presence:offline with a lastSeenAt and persists it once the member's last socket disconnects", async () => {
    const { token: tokenA } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const { token: tokenB, member: memberB } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const a = await connect(tokenA);
    const b = await connect(tokenB);

    const before = await db.getTeamMember(memberB._id);
    expect(before?.lastSeenAt).toBeNull();

    const offlineSeenByA = waitFor<{ memberId: string; lastSeenAt: string }>(a, "presence:offline");
    b.disconnect();
    const payload = await offlineSeenByA;
    expect(payload.memberId).toBe(memberB._id);
    expect(payload.lastSeenAt).toBeTruthy();

    // touchTeamMemberLastSeen is fire-and-forget from the disconnect handler
    // — give it a tick to land before asserting on the DB.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await db.getTeamMember(memberB._id);
    expect(after?.lastSeenAt).toBe(payload.lastSeenAt);
  });

  it("does NOT go offline while a second tab for the same member is still connected", async () => {
    const { token: tokenA } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const { token: tokenB } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const a = await connect(tokenA);
    const bTab1 = await connect(tokenB);
    const bTab2 = await connect(tokenB);

    let sawOffline = false;
    a.on("presence:offline", () => {
      sawOffline = true;
    });

    bTab1.disconnect();
    // Give any (wrongly-fired) event a moment to arrive before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sawOffline).toBe(false);
    expect(bTab2.connected).toBe(true);
  });

  it("re-sends a fresh presence:online-list on request — not just once at raw connection time", async () => {
    // Simulates the real gap this closes: a UI piece (the Team modal) that
    // starts caring about presence well after its socket first connected,
    // long after the one-time connection-time broadcast already fired (and,
    // for exactly that reason, isn't waited on here — by the time this test
    // continuation runs it may already have been sent to no listener and be
    // gone for good, same as the real component this models).
    const { token: tokenA, member: memberA } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const a = await connect(tokenA);

    const { token: tokenB, member: memberB } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    await connect(tokenB);

    const freshList = waitFor<{ memberIds: string[] }>(a, "presence:online-list");
    a.emit("presence:request-online-list");
    const payload = await freshList;
    expect(payload.memberIds).toEqual(expect.arrayContaining([memberA._id, memberB._id]));
  });
});

describe("comment:new / comment:resolved over sockets", () => {
  it("broadcasts a new comment to everyone in the endpoint room, including via the DB", async () => {
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const socket = await connect(token);
    socket.emit("presence:join", { vayoId: "ep_2" });
    await waitFor(socket, "presence:join");

    const received = waitFor<{ vayoId: string; body: string }>(socket, "comment:new");
    socket.emit("comment:new", { vayoId: "ep_2", body: "Looks good to me" });
    const payload = await received;
    expect(payload.body).toBe("Looks good to me");

    const stored = await db.listComments("ep_2");
    expect(stored).toHaveLength(1);
  });

  it("also broadcasts a cross-cutting comment to the shared 'project' room, reaching a socket that never joined either endpoint's own room", async () => {
    const { token: senderToken } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const sender = await connect(senderToken);
    sender.emit("presence:join", { vayoId: "ep_10" });
    await waitFor(sender, "presence:join");

    // This socket represents the cross-endpoint chat drawer — it never
    // joins any specific "endpoint:*" room, only the shared "project" one
    // every connection gets by default, so receiving comment:new here can
    // only be explained by the cross-cutting broadcast, not endpoint-room
    // membership.
    const { token: watcherToken } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const watcher = await connect(watcherToken);

    const received = waitFor<{ vayoIds: string[]; body: string }>(watcher, "comment:new");
    sender.emit("comment:new", { vayoId: "ep_10", body: "relates to #[/x](ep_11)" });
    const payload = await received;
    expect(payload.vayoIds).toEqual(["ep_10", "ep_11"]);
  });

  it("does NOT broadcast an ordinary single-endpoint comment to the shared 'project' room", async () => {
    const { token: senderToken } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const sender = await connect(senderToken);
    sender.emit("presence:join", { vayoId: "ep_12" });
    await waitFor(sender, "presence:join");

    const { token: watcherToken } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const watcher = await connect(watcherToken);
    let sawCommentNew = false;
    watcher.on("comment:new", () => {
      sawCommentNew = true;
    });

    const receivedOnSender = waitFor(sender, "comment:new");
    sender.emit("comment:new", { vayoId: "ep_12", body: "just about this one endpoint" });
    await receivedOnSender; // sender is in the ep_12 room, so it always sees its own comment

    expect(sawCommentNew).toBe(false);
  });

  it("lets an editor resolve a comment over the socket", async () => {
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const socket = await connect(token);
    socket.emit("presence:join", { vayoId: "ep_3" });
    await waitFor(socket, "presence:join");
    const comment = await db.createComment({
      vayoIds: ["ep_3"],
      authorId: "someone",
      body: "fix this",
      replyToId: null,
      flagged: true,
      resolved: false,
      createdAt: new Date().toISOString(),
    });

    const resolved = waitFor<{ commentId: string }>(socket, "comment:resolved");
    socket.emit("comment:resolved", { commentId: comment._id });
    const payload = await resolved;
    expect(payload.commentId).toBe(comment._id);
  });

  it("blocks a viewer from resolving a comment — emits vayo:error instead", async () => {
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const socket = await connect(token);
    const comment = await db.createComment({
      vayoIds: ["ep_4"],
      authorId: "someone",
      body: "fix this",
      replyToId: null,
      flagged: true,
      resolved: false,
      createdAt: new Date().toISOString(),
    });

    const errorEvent = waitFor<{ event: string; error: string }>(socket, "vayo:error");
    socket.emit("comment:resolved", { commentId: comment._id });
    const payload = await errorEvent;
    expect(payload.error).toBe("forbidden");

    const stillUnresolved = await db.listComments("ep_4");
    expect(stillUnresolved[0]!.resolved).toBe(false);
  });
});

describe("override:updated over sockets — the one event a viewer must never trigger", () => {
  it("blocks a viewer-role socket and emits vayo:error, without writing anything", async () => {
    const { token } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const socket = await connect(token);

    const errorEvent = waitFor<{ event: string; error: string }>(socket, "vayo:error");
    socket.emit("override:updated", { vayoId: "ep_5", fieldPath: "summary", value: "Sneaky edit" });
    const payload = await errorEvent;
    expect(payload.event).toBe("override:updated");
    expect(payload.error).toBe("forbidden");

    expect(await db.getOverride("ep_5.summary")).toBeNull();
  });

  it("lets an editor apply an override, broadcasts it with updatedBy, and persists it", async () => {
    const { token, member } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const socket = await connect(token);
    socket.emit("presence:join", { vayoId: "ep_6" });
    await waitFor(socket, "presence:join");

    const broadcast = waitFor<{ vayoId: string; fieldPath: string; value: unknown; updatedBy: string }>(socket, "override:updated");
    socket.emit("override:updated", { vayoId: "ep_6", fieldPath: "summary", value: "Fetches a widget" });
    const payload = await broadcast;

    expect(payload.value).toBe("Fetches a widget");
    expect(payload.updatedBy).toBe(member._id);

    const stored = await db.getOverride("ep_6.summary");
    expect(stored?.value).toBe("Fetches a widget");
  });
});

describe("notification:new — broadcast to the global project room", () => {
  it("fires for every socket connected, not just ones viewing that endpoint", async () => {
    const { token: editorToken } = await seedMemberWithSession(db, SESSION_SECRET, "editor");
    const { token: viewerToken } = await seedMemberWithSession(db, SESSION_SECRET, "viewer");
    const editor = await connect(editorToken);
    const viewer = await connect(viewerToken);
    // Viewer never joins "endpoint:ep_7" — notification:new is a "project"
    // room broadcast (docs/06-realtime-collaboration.md), so it must still arrive.

    const received = waitFor<{ type: string; vayoId: string | null }>(viewer, "notification:new");
    editor.emit("override:updated", { vayoId: "ep_7", fieldPath: "summary", value: "hi" });
    const payload = await received;

    expect(payload).toEqual({ type: "override", vayoId: "ep_7" });
  });
});

describe("mounting into a host's own Express app + httpServer (the swagger-ui-express-style pattern)", () => {
  it("REST and Socket.IO both work through the host's own server, on the host's own port, with no separate httpServer.listen() of Vayo's own", async () => {
    // Stands in for a real host app: its own Express app, its own
    // http.Server, its own single .listen() call — Vayo never creates a
    // second server or a second port in this mode.
    const hostApp = express();
    const hostHttpServer = createHttpServer(hostApp);

    const hostDb = createFakeDb();
    const { app: vayoApp, io: vayoIo } = createServer({
      db: hostDb,
      sessionSecret: SESSION_SECRET,
      mountPath: "/docs",
      httpServer: hostHttpServer,
    });
    // No path argument: vayoApp already only answers under /docs internally
    // (its own mountPath-prefixed routes), same as any other middleware.
    hostApp.use(vayoApp);

    await new Promise<void>((resolve) => hostHttpServer.listen(0, resolve));
    const { port } = hostHttpServer.address() as AddressInfo;
    const hostBaseUrl = `http://localhost:${port}`;

    try {
      const { member, token } = await seedMemberWithSession(hostDb, SESSION_SECRET, "viewer");

      // REST, reachable at the host's own port under /docs.
      const restRes = await fetch(`${hostBaseUrl}/docs/api/team`, { headers: { Authorization: `Bearer ${token}` } });
      expect(restRes.status).toBe(200);
      const team = (await restRes.json()) as Array<{ _id: string }>;
      expect(team.some((m) => m._id === member._id)).toBe(true);

      // Socket.IO, reachable at the SAME host port, at the mountPath-derived
      // path — not a second server, not Engine.IO's bare default path.
      expect(vayoIo.path()).toBe("/docs/socket.io");
      const socket = ioClient(hostBaseUrl, {
        path: "/docs/socket.io",
        auth: { token },
        reconnection: false,
        forceNew: true,
        transports: ["websocket"],
      });
      try {
        await new Promise<void>((resolve, reject) => {
          socket.on("connect", () => resolve());
          socket.on("connect_error", reject);
        });
        expect(socket.connected).toBe(true);
      } finally {
        socket.disconnect();
      }
    } finally {
      hostHttpServer.close();
    }
  });
});
