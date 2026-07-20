// apps/demo-app/src/verify-realtime.ts — one-off script proving
// docs/09-roadmap.md M4 done-when against @vayo/server's real Socket.IO
// gateway: two sessions (editor + viewer) see each other's live events, and
// the viewer-role socket's attempted override:updated is rejected
// server-side, not just hidden client-side.

import { io as ioClient } from "socket.io-client";

const BASE_HTTP = "http://localhost:4100/vayo";
const BASE_WS = "http://localhost:4100";

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_HTTP}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function main() {
  const editorToken = await login("editor@demo.local", "editor-pass-123");
  const viewerToken = await login("viewer@demo.local", "viewer-pass-123");

  const editorSocket = ioClient(BASE_WS, { path: "/socket.io", auth: { token: editorToken } });
  const viewerSocket = ioClient(BASE_WS, { path: "/socket.io", auth: { token: viewerToken } });

  await Promise.all([
    new Promise<void>((resolve, reject) => {
      editorSocket.on("connect", () => resolve());
      editorSocket.on("connect_error", reject);
    }),
    new Promise<void>((resolve, reject) => {
      viewerSocket.on("connect", () => resolve());
      viewerSocket.on("connect_error", reject);
    }),
  ]);
  console.log("both sockets connected and authenticated");

  const vayoId = "realtime_test_ep";
  editorSocket.emit("presence:join", { vayoId });
  viewerSocket.emit("presence:join", { vayoId });
  await new Promise((r) => setTimeout(r, 200));

  // 1. Editor posts a comment; viewer should see it live.
  const commentSeen = new Promise((resolve) => viewerSocket.once("comment:new", resolve));
  editorSocket.emit("comment:new", { vayoId, body: "hello from editor" });
  const comment = await commentSeen;
  console.log("PASS: viewer received comment:new ->", (comment as { body: string }).body);

  // 2. Viewer attempts override:updated -> must be rejected server-side.
  const viewerRejected = new Promise((resolve) => viewerSocket.once("vayo:error", resolve));
  const editorSawViewerOverride = new Promise((resolve, reject) => {
    const t = setTimeout(resolve, 500); // no broadcast expected
    editorSocket.once("override:updated", () => {
      clearTimeout(t);
      reject(new Error("editor received an override broadcast that a viewer should never have been able to trigger"));
    });
  });
  viewerSocket.emit("override:updated", { vayoId, fieldPath: "summary", value: "viewer should not be able to do this" });
  const rejection = await viewerRejected;
  await editorSawViewerOverride;
  console.log("PASS: viewer's override:updated was rejected server-side ->", rejection);

  // 3. Editor performs the same override -> should succeed and broadcast.
  const overrideSeen = new Promise((resolve) => viewerSocket.once("override:updated", resolve));
  editorSocket.emit("override:updated", { vayoId, fieldPath: "summary", value: "editor override via socket" });
  const override = await overrideSeen;
  console.log("PASS: viewer received editor's override:updated ->", override);

  editorSocket.disconnect();
  viewerSocket.disconnect();
  console.log("ALL CHECKS PASSED");
}

main()
  .then(() => setTimeout(() => process.exit(0), 100))
  .catch((err) => {
    console.error("verify-realtime FAILED:", err);
    process.exit(1);
  });
