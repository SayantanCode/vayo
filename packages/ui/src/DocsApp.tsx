// @vayo/ui — DocsApp: the top-level shell. Five tabs per endpoint — Details,
// Flowmap, History, Team Chat, Try It Now — per
// docs/08-packages-and-repo-structure.md. Talks only to @vayo/server's REST
// API and Socket.IO gateway — never touches MongoDB or any package below
// @vayo/server directly.

import { useEffect, useMemo, useState, type ComponentType } from "react";
import "./theme.css";
import type { ApiVersionDoc, ApiVersionStatus, EnvironmentDoc, FlowDoc, FolderDoc, NotificationType, SettingsDoc } from "@vayo/types";
import { api, ApiError, type ApiConfig } from "./api.js";
import { useVayoSocket } from "./hooks/useVayoSocket.js";
import { ConfigProvider } from "./contexts/ConfigContext.js";
import { SocketProvider } from "./contexts/SocketContext.js";
import { buildTree, flattenSpec, type CurrentMember, type EndpointSummary, type OpenApiDoc, type TabId } from "./types.js";
import { Avatar } from "./components/Avatar.js";
import { LoginScreen } from "./components/LoginScreen.js";
import { AcceptInviteScreen } from "./components/AcceptInviteScreen.js";
import { TeamModal } from "./components/TeamModal.js";
import { FolderTree } from "./components/FolderTree.js";
import { FullDocView } from "./components/FullDocView.js";
import { FolderBreadcrumb } from "./components/FolderBreadcrumb.js";
import { EnvironmentSwitcher } from "./components/EnvironmentSwitcher.js";
import { EnvironmentsModal } from "./components/EnvironmentsModal.js";
import { ExportMenu } from "./components/ExportMenu.js";
import { FlowsModal } from "./components/FlowsModal.js";
import { VersionSwitcher } from "./components/VersionSwitcher.js";
import { VersionsModal } from "./components/VersionsModal.js";
import { DiffModal } from "./components/DiffModal.js";
import { CoverageModal } from "./components/CoverageModal.js";
import { GlobalChatDrawer } from "./components/GlobalChatDrawer.js";
import { ThemeToggle, applyStoredTheme, currentTheme, type ThemeMode } from "./components/ThemeToggle.js";
import { BookOpen, ListChecks, MessagesSquare, Settings as SettingsIcon, Users, Workflow, X } from "lucide-react";
import { CommandPalette } from "./components/CommandPalette.js";
import { CreateFolderModal } from "./components/CreateFolderModal.js";
import { CreateEndpointModal, type ManualEndpointInput } from "./components/CreateEndpointModal.js";
import { EndpointHeader } from "./components/EndpointHeader.js";
import { NotificationBell } from "./components/NotificationBell.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { TabBar } from "./components/TabBar.js";
import { DetailsTab } from "./components/tabs/DetailsTab.js";
import { FlowmapTab } from "./components/tabs/FlowmapTab.js";
import { HistoryTab } from "./components/tabs/HistoryTab.js";
import { TeamChatTab } from "./components/tabs/TeamChatTab.js";
import { TryItNowTab } from "./components/tabs/TryItNowTab.js";

const TOKEN_STORAGE_KEY = "vayo:token";
const API_ORIGIN_STORAGE_KEY = "vayo:apiOrigin";
const ACTIVE_ENV_STORAGE_KEY = "vayo:activeEnvironmentId";

// Applied as soon as this module evaluates (before first paint), not inside
// a component effect — avoids a flash of the wrong theme on load.
applyStoredTheme();

/** Used to disable folder-tree mutations for viewer-role sessions — the UI
 * hiding these actions is a UX nicety only; the server independently
 * enforces the same role check on every one of these routes
 * (docs/05-security.md §4), same as every other mutating action in the app. */
function noop(): void {}

/** `apiBaseUrl`'s own path segment — mountPath, in server terms. Usually a
 * full absolute URL (`main.tsx` builds it as `${origin}${mountPath}`), but a
 * host app embedding `<DocsApp>` directly could pass a bare path like
 * "/vayo" instead; `new URL()` throws on that, so it's treated as already
 * being the path. */
function derivePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export interface DocsAppProps {
  apiBaseUrl: string; // where @vayo/server's REST API lives
  socketUrl: string;
  version?: string; // default "v1"
  renderTryItPanel?: ComponentType<{ vayoId: string }>;
  renderAuthBadge?: ComponentType<{ authRequired: boolean; scopes: string[] }>;
  renderFlowmap?: ComponentType<{
    vayoId: string;
    middlewareChain: string[];
    flows: FlowDoc[];
    endpoints: EndpointSummary[];
    canEdit: boolean;
    onOpenFlow: (flowId: string) => void;
    onOpenFlowsPanel: () => void;
  }>;
  renderHistory?: ComponentType<{ vayoId: string }>;
}

export function DocsApp({
  apiBaseUrl,
  socketUrl,
  version = "v1",
  renderFlowmap: CustomFlowmap,
  renderHistory: CustomHistory,
}: DocsAppProps): JSX.Element {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_STORAGE_KEY));
  const [me, setMe] = useState<CurrentMember | null>(null);
  const [doc, setDoc] = useState<OpenApiDoc | null>(null);
  const [folders, setFolders] = useState<FolderDoc[]>([]);
  const [selectedVayoId, setSelectedVayoId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("details");
  // "endpoint" = today's one-at-a-time workspace (Details/Flowmap/History/
  // Team Chat/Try It Now tabs). "fulldoc" = the whole active version as one
  // scrollable reference page (FullDocView) — an alternative browsing mode,
  // not a replacement; switching back returns to whichever endpoint/tab was
  // already selected.
  const [viewMode, setViewMode] = useState<"endpoint" | "fulldoc">("endpoint");
  // Set right before switching to "chat" from a notification click — Team
  // Chat scrolls to and briefly highlights this message, then clears it
  // (via onHighlighted) so revisiting the tab normally doesn't re-trigger.
  const [highlightCommentId, setHighlightCommentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Defaults to the {{baseUrl}} convention so a fresh session resolves
  // against whatever environment is active with zero typing — matching
  // the "smart," environment-driven base URL Details tab now shows,
  // instead of requiring the user to discover and type this themselves.
  // Read once — Try It Now's URL bar is fully self-contained and freely
  // editable per endpoint now, so this only ever seeds a fresh view.
  const apiOrigin = localStorage.getItem(API_ORIGIN_STORAGE_KEY) ?? "{{baseUrl}}";
  const [teamMembers, setTeamMembers] = useState<Awaited<ReturnType<typeof api.listTeam>>>([]);
  // Derived, not its own state: depends on BOTH the roster's real names AND
  // the current member's own private nickname book, so it has to recompute
  // whenever either changes (setting a new nickname updates `me` alone, and
  // this stays in sync without needing an extra roster refetch just for that).
  const memberNames = useMemo(() => {
    const nicknames = me?.nicknames ?? {};
    return Object.fromEntries(teamMembers.map((m) => [m._id, nicknames[m._id] ?? m.name] as const));
  }, [teamMembers, me]);
  // null = closed. Open, `initialMemberId` says which roster row the Team
  // modal should land on: null for the "Team" header button (today's
  // roster-overview default), or the caller's own id for clicking your own
  // name/avatar in the header — straight to your own profile, not the
  // invite panel you'd otherwise have to click past.
  const [teamModalOpen, setTeamModalOpen] = useState<{ initialMemberId: string | null } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [creatingFolderParentId, setCreatingFolderParentId] = useState<string | null | "none">("none");
  const [creatingEndpointParentId, setCreatingEndpointParentId] = useState<string | null | "none">("none");
  const [environments, setEnvironments] = useState<EnvironmentDoc[]>([]);
  const [settings, setSettings] = useState<SettingsDoc | null>(null);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [activeEnvironmentId, setActiveEnvironmentIdState] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_ENV_STORAGE_KEY),
  );
  const [environmentsModalOpen, setEnvironmentsModalOpen] = useState(false);
  const [flowsModalOpen, setFlowsModalOpen] = useState(false);
  // Set right before opening the Flows panel from Flowmap's "Open in Flows"
  // link, so the modal jumps straight to that flow instead of always
  // defaulting to "new" — cleared on close so the header's own "Flows"
  // button (with no specific flow in mind) still opens fresh next time.
  const [flowsModalInitialFlowId, setFlowsModalInitialFlowId] = useState<string | undefined>(undefined);
  const [flows, setFlows] = useState<FlowDoc[]>([]);
  const [coverageModalOpen, setCoverageModalOpen] = useState(false);
  const [globalChatOpen, setGlobalChatOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => currentTheme());
  const [activeVersion, setActiveVersion] = useState(version);
  const [apiVersions, setApiVersions] = useState<ApiVersionDoc[]>([]);
  const [versionsModalOpen, setVersionsModalOpen] = useState(false);
  const [diffModalOpen, setDiffModalOpen] = useState(false);
  // Who else's socket currently has `presence:join`ed each endpoint —
  // keyed by vayoId, values are memberIds (docs/06-realtime-collaboration.md
  // "Presence UI data"). Purely a live view of the server's in-memory Map;
  // never persisted, never read from anywhere but this event stream.
  const [presenceByEndpoint, setPresenceByEndpoint] = useState<Record<string, string[]>>({});
  const [overrideToast, setOverrideToast] = useState<{ vayoId: string; memberId: string } | null>(null);

  const config: ApiConfig = useMemo(() => ({ baseUrl: apiBaseUrl, token }), [apiBaseUrl, token]);
  // @vayo/server's Socket.IO path defaults to `${mountPath}/socket.io`, not
  // Engine.IO's bare `/socket.io` (docs/06-realtime-collaboration.md) — and
  // apiBaseUrl already IS `${origin}${mountPath}` (main.tsx), so its own
  // pathname is exactly that mountPath. Deriving from it here means no
  // separate socketPath prop for a host app embedding <DocsApp> to keep in
  // sync by hand.
  const socketPath = useMemo(() => `${derivePathname(apiBaseUrl).replace(/\/$/, "")}/socket.io`, [apiBaseUrl]);
  const socket = useVayoSocket(socketUrl, token, socketPath);
  const canEdit = me ? me.role !== "viewer" : false;

  function setActiveEnvironmentId(id: string | null) {
    setActiveEnvironmentIdState(id);
    if (id) localStorage.setItem(ACTIVE_ENV_STORAGE_KEY, id);
    else localStorage.removeItem(ACTIVE_ENV_STORAGE_KEY);
  }

  async function refetchEnvironments() {
    setEnvironments(await api.listEnvironments(config));
  }

  async function refetchSettings() {
    setSettings(await api.getSettings(config));
  }

  async function handleUpdateSettings(patch: { title: string; description: string | null }) {
    setSettings(await api.updateSettings(config, patch));
  }

  async function handleCreateEnvironment(name: string, variables: Record<string, string>) {
    const created = await api.createEnvironment(config, name, variables);
    await refetchEnvironments();
    setActiveEnvironmentId(created._id);
  }

  async function handleUpdateEnvironment(id: string, patch: Partial<{ name: string; variables: Record<string, string> }>) {
    await api.updateEnvironment(config, id, patch);
    await refetchEnvironments();
  }

  async function handleAddEnvironmentVariable(name: string, value: string) {
    if (!activeEnvironment) return;
    await handleUpdateEnvironment(activeEnvironment._id, { variables: { ...activeEnvironment.variables, [name]: value } });
  }

  async function handleDeleteEnvironment(id: string) {
    await api.deleteEnvironment(config, id);
    if (activeEnvironmentId === id) setActiveEnvironmentId(null);
    await refetchEnvironments();
  }

  async function refetchSpecAndFolders() {
    const [specResult, foldersResult] = await Promise.all([
      api.getSpec(config, activeVersion),
      api.listFolders(config, activeVersion),
    ]);
    setDoc(specResult);
    setFolders(foldersResult);
  }

  async function refetchApiVersions() {
    setApiVersions(await api.listApiVersions(config));
  }

  async function refetchFlows() {
    setFlows(await api.listFlows(config, activeVersion));
  }

  function openFlowInFlowsPanel(flowId: string) {
    setFlowsModalInitialFlowId(flowId);
    setFlowsModalOpen(true);
  }

  function openFlowsPanel() {
    setFlowsModalInitialFlowId(undefined);
    setFlowsModalOpen(true);
  }

  async function handleCreateApiVersion(newVersion: string, basePathPattern: string) {
    await api.createApiVersion(config, newVersion, basePathPattern);
    await refetchApiVersions();
  }

  async function handleUpdateApiVersionStatus(targetVersion: string, status: ApiVersionStatus) {
    await api.updateApiVersion(config, targetVersion, { status });
    await refetchApiVersions();
  }

  useEffect(() => {
    if (!token) return;
    api
      .me(config)
      .then(setMe)
      .catch(() => {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        setToken(null);
      });
  }, [config, token]);

  function refetchTeam() {
    return api
      .listTeam(config)
      .then((members) => {
        setTeamMembers(members);
      })
      .catch(() => {});
  }

  useEffect(() => {
    if (!token) return;
    refetchTeam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, token]);

  useEffect(() => {
    if (!token) return;
    refetchSpecAndFolders().catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load spec"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, token, activeVersion]);

  useEffect(() => {
    if (!token) return;
    refetchEnvironments().catch(() => {});
    refetchSettings().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, token]);

  useEffect(() => {
    if (!token) return;
    refetchApiVersions().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, token]);

  useEffect(() => {
    if (!token) return;
    refetchFlows().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, token, activeVersion]);

  useEffect(() => {
    if (!socket || !selectedVayoId) return;
    socket.emit("presence:join", { vayoId: selectedVayoId });
    return () => {
      socket.emit("presence:leave", { vayoId: selectedVayoId });
    };
  }, [socket, selectedVayoId]);

  // The three server-broadcast events every connected socket already
  // receives (docs/06-realtime-collaboration.md) — presence and
  // override-sync previously had no client-side listener at all, so a
  // second browser session's edits/viewers were invisible until a manual
  // reload. Comments (TeamChatTab) already had their own listener.
  useEffect(() => {
    if (!socket) return;

    function handlePresenceJoin({ vayoId, memberId }: { vayoId: string; memberId: string }) {
      setPresenceByEndpoint((prev) => {
        const existing = prev[vayoId] ?? [];
        if (existing.includes(memberId)) return prev;
        return { ...prev, [vayoId]: [...existing, memberId] };
      });
    }

    function handlePresenceLeave({ vayoId, memberId }: { vayoId: string; memberId: string }) {
      setPresenceByEndpoint((prev) => {
        const existing = prev[vayoId] ?? [];
        if (!existing.includes(memberId)) return prev;
        return { ...prev, [vayoId]: existing.filter((id) => id !== memberId) };
      });
    }

    // Not a source of truth in itself (docs/06-realtime-collaboration.md:
    // "Socket.IO is a transport, not a source of truth") — refetching the
    // resolved spec is what actually applies the change everyone sees;
    // this event is only the live cue to go do that, plus the non-blocking
    // "someone just changed this" notice the same doc calls for instead of
    // silently overwriting anything the current user might be mid-editing.
    function handleOverrideUpdated({ vayoId, updatedBy }: { vayoId: string; fieldPath: string; value: unknown; updatedBy: string }) {
      refetchSpecAndFolders().catch(() => {});
      setOverrideToast({ vayoId, memberId: updatedBy });
    }

    socket.on("presence:join", handlePresenceJoin);
    socket.on("presence:leave", handlePresenceLeave);
    socket.on("override:updated", handleOverrideUpdated);
    return () => {
      socket.off("presence:join", handlePresenceJoin);
      socket.off("presence:leave", handlePresenceLeave);
      socket.off("override:updated", handleOverrideUpdated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  useEffect(() => {
    if (!overrideToast) return;
    const timer = setTimeout(() => setOverrideToast(null), 5000);
    return () => clearTimeout(timer);
  }, [overrideToast]);

  // Cmd/Ctrl+K opens the command palette from anywhere in the app.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  function handleLogin(newToken: string, member: CurrentMember) {
    localStorage.setItem(TOKEN_STORAGE_KEY, newToken);
    setToken(newToken);
    setMe(member);
  }

  function handleLogout() {
    api.logout(config).catch(() => {});
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken(null);
    setMe(null);
    setDoc(null);
    setSelectedVayoId(null);
  }

  function selectEndpoint(vayoId: string) {
    setSelectedVayoId(vayoId);
    setActiveTab("details");
    setPaletteOpen(false);
  }

  /** The sidebar's click handler while Full Docs is open — it's this view's
   * own "jump to" nav (FullDocView's own top comment), so clicking an
   * endpoint scrolls its already-rendered section into view instead of
   * switching which single endpoint is selected. Still updates
   * `selectedVayoId` too, purely so the sidebar's own highlight stays in
   * sync with whichever section the user just jumped to. */
  function selectEndpointOrScrollTo(vayoId: string) {
    if (viewMode !== "fulldoc") {
      selectEndpoint(vayoId);
      return;
    }
    setSelectedVayoId(vayoId);
    document.getElementById(vayoId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** "Try it" from inside Full Docs can't send a real request in place — it
   * leaves the read-only reference page for the normal interactive
   * workspace, landing straight on Try It Now for that one endpoint. */
  function tryItFromFullDoc(vayoId: string) {
    setSelectedVayoId(vayoId);
    setActiveTab("tryit");
    setViewMode("endpoint");
  }

  /** Jumping to a different endpoint from *inside* Try It Now (its URL bar
   * suggestion dropdown) shouldn't yank the user over to Details — they're
   * mid-test, not browsing docs, so stay put on Try It Now. */
  function selectEndpointKeepTab(vayoId: string) {
    setSelectedVayoId(vayoId);
    setPaletteOpen(false);
  }

  /** Clicking a notification should land on whichever tab actually shows
   * what changed, not just wherever the user happened to be — a "comment"
   * notification is useless if it leaves you staring at Try It Now. Team
   * Chat additionally gets a specific message to scroll to and briefly
   * highlight (`highlightCommentId`), reusing the exact same jump-to-quote
   * mechanism already built for reply references — "side by side context"
   * for what was being discussed when something happened is the whole
   * point of clicking through in the first place. */
  function selectEndpointForNotification(vayoId: string, type: NotificationType, targetId: string | null) {
    setSelectedVayoId(vayoId);
    setPaletteOpen(false);
    if (type === "comment") {
      setActiveTab("chat");
      setHighlightCommentId(targetId);
    } else if (type === "override") {
      setActiveTab("details");
    } else if (type === "schema_change") {
      setActiveTab("history");
    }
  }

  /** Clicking an inline #tag in a chat message, or an "also about" chip —
   * same as any other "jump to this endpoint" action, plus closing the
   * cross-endpoint drawer if that's where the click came from (harmless
   * no-op otherwise) so the destination is actually visible. */
  function jumpToEndpointFromChat(vayoId: string) {
    selectEndpoint(vayoId);
    setGlobalChatOpen(false);
  }

  async function handleCreateFolder(name: string) {
    const parentId = creatingFolderParentId === "none" ? null : creatingFolderParentId;
    await api.createFolder(config, name, parentId, activeVersion);
    setCreatingFolderParentId("none");
    await refetchSpecAndFolders();
  }

  async function handleCreateEndpoint(input: ManualEndpointInput) {
    const parentId = creatingEndpointParentId === "none" ? null : creatingEndpointParentId;
    try {
      const created = await api.createManualEndpoint(config, { ...input, version: activeVersion });
      if (parentId !== null) {
        const siblingCount = endpoints.filter((e) => (e.operation["x-vayo-folder-id"] ?? null) === parentId).length;
        await api.setPlacement(config, created.vayoId, parentId, siblingCount);
      }
      setCreatingEndpointParentId("none");
      await refetchSpecAndFolders();
      selectEndpoint(created.vayoId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create endpoint");
    }
  }

  async function handleRenameFolder(folderId: string, name: string) {
    await api.renameFolder(config, folderId, name);
    await refetchSpecAndFolders();
  }

  async function handleRenameEndpoint(vayoId: string, summary: string | null) {
    await api.postOverride(config, `${vayoId}.summary`, summary, null);
    await refetchSpecAndFolders();
  }

  async function handleAutoOrganize() {
    await api.autoOrganizeFolders(config, activeVersion);
    await refetchSpecAndFolders();
  }

  async function handleDeleteFolder(folderId: string) {
    await api.deleteFolder(config, folderId);
    await refetchSpecAndFolders();
  }

  // The sidebar only ever offers this for a "manual" endpoint in the first
  // place (FolderTree's own context-menu check) — the try/catch here is
  // just defense against the rare race where real traffic merges the
  // endpoint from "manual" to "merged" in the moment between opening the
  // menu and confirming, which the server would then correctly 400.
  async function handleDeleteEndpoint(vayoId: string) {
    try {
      await api.deleteEndpoint(config, vayoId);
      await refetchSpecAndFolders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete endpoint");
    }
  }

  async function handleReorderSiblings(kind: "folder" | "endpoint", parentId: string | null, orderedIds: string[]) {
    if (kind === "folder") {
      await Promise.all(orderedIds.map((id, index) => api.moveFolder(config, id, parentId, index)));
    } else {
      await Promise.all(orderedIds.map((id, index) => api.setPlacement(config, id, parentId, index)));
    }
    await refetchSpecAndFolders();
  }

  async function handleMoveToFolder(kind: "folder" | "endpoint", id: string, targetFolderId: string | null) {
    if (kind === "folder") {
      const siblingCount = folders.filter((f) => f.parentId === targetFolderId).length;
      await api.moveFolder(config, id, targetFolderId, siblingCount);
    } else {
      const siblingCount = endpoints.filter((e) => (e.operation["x-vayo-folder-id"] ?? null) === targetFolderId).length;
      await api.setPlacement(config, id, targetFolderId, siblingCount);
    }
    await refetchSpecAndFolders();
  }

  // Checked before the logged-in gate below, deliberately — an invite link
  // is addressed to whoever holds it, not to whoever this browser happens
  // to already be signed in as (e.g. the inviter previewing their own link,
  // or a second tab in the same browser profile as another account).
  const inviteToken = new URLSearchParams(window.location.search).get("invite");
  if (inviteToken) {
    return (
      <AcceptInviteScreen
        baseUrl={apiBaseUrl}
        token={inviteToken}
        onDone={() => {
          // Drop ?invite=... from the URL so refreshing after signing in
          // doesn't re-show this screen — the invite is already consumed.
          window.history.replaceState(null, "", window.location.pathname);
          window.location.reload();
        }}
      />
    );
  }

  if (!token || !me) {
    return <LoginScreen baseUrl={apiBaseUrl} onLogin={handleLogin} />;
  }

  const endpoints = doc ? flattenSpec(doc) : [];
  const tree = buildTree(folders, endpoints);
  const selected = endpoints.find((e) => e.vayoId === selectedVayoId) ?? endpoints[0] ?? null;
  const activeEnvironment = environments.find((e) => e._id === activeEnvironmentId) ?? null;

  return (
    <ConfigProvider config={config}>
    <SocketProvider socket={socket}>
    <div className="docs-app">
      <header className="docs-app__header">
        <div className="docs-app__title">
          <span className="docs-app__logo">{settings?.title || "Vayo API"}</span>
        </div>
        <button type="button" className="docs-app__search-trigger" onClick={() => setPaletteOpen(true)}>
          <span>Search endpoints…</span>
          <kbd>{navigator.platform.includes("Mac") ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <VersionSwitcher
          versions={apiVersions}
          activeVersion={activeVersion}
          onSelect={setActiveVersion}
          onManage={() => setVersionsModalOpen(true)}
          onCompare={() => setDiffModalOpen(true)}
        />
        <EnvironmentSwitcher
          environments={environments}
          activeEnvironmentId={activeEnvironmentId}
          onSelect={setActiveEnvironmentId}
          onManage={() => setEnvironmentsModalOpen(true)}
        />
        <ExportMenu version={activeVersion} activeEnvironmentId={activeEnvironmentId} />
        <button
          type="button"
          className={`env-switcher__trigger ${viewMode === "fulldoc" ? "env-switcher__trigger--active" : ""}`}
          onClick={() => setViewMode((prev) => (prev === "fulldoc" ? "endpoint" : "fulldoc"))}
          title="Read every endpoint on one scrollable page — the sidebar becomes a jump-to nav instead of switching endpoints"
        >
          <BookOpen size={14} />
          <span>Full Docs</span>
        </button>
        <button type="button" className="env-switcher__trigger" onClick={openFlowsPanel}>
          <Workflow size={14} />
          <span>Flows</span>
        </button>
        <button type="button" className="env-switcher__trigger" onClick={() => setCoverageModalOpen(true)}>
          <ListChecks size={14} />
          <span>Coverage</span>
        </button>
        <button
          type="button"
          className="env-switcher__trigger"
          onClick={() => setTeamModalOpen({ initialMemberId: null })}
        >
          <Users size={14} />
          <span>Team</span>
        </button>
        <button
          type="button"
          className="env-switcher__trigger"
          onClick={() => setGlobalChatOpen(true)}
          title="Questions that span multiple endpoints"
        >
          <MessagesSquare size={14} />
          <span>Chat</span>
        </button>
        <button
          type="button"
          className="env-switcher__trigger"
          onClick={() => setSettingsModalOpen(true)}
          title="Set the title/description shown in your exported spec"
        >
          <SettingsIcon size={14} />
          <span>Settings</span>
        </button>
        <ThemeToggle value={themeMode} onChange={setThemeMode} />
        <NotificationBell
          endpoints={endpoints}
          memberNames={memberNames}
          currentMemberId={me.id}
          onNavigate={selectEndpointForNotification}
        />
        <div className="docs-app__user">
          <button
            type="button"
            className="docs-app__user-profile-trigger"
            onClick={() => setTeamModalOpen({ initialMemberId: me.id })}
            title="View or edit your profile"
          >
            <Avatar name={me.name} avatarUrl={me.avatarUrl} size={26} />
            <span className="docs-app__user-name" title={me.name}>
              {me.name}
            </span>
            <span className={`role-badge role-badge--${me.role}`}>{me.role}</span>
          </button>
          <button type="button" className="button" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>
      <div className="docs-app__body">
        <FolderTree
          tree={tree}
          allFolders={folders}
          canEdit={canEdit}
          fullDocMode={viewMode === "fulldoc"}
          selectedVayoId={selected?.vayoId ?? null}
          onSelectEndpoint={selectEndpointOrScrollTo}
          onCreateFolder={canEdit ? (parentId) => setCreatingFolderParentId(parentId) : noop}
          onCreateEndpoint={canEdit ? (parentId) => setCreatingEndpointParentId(parentId) : noop}
          onRenameFolder={canEdit ? handleRenameFolder : noop}
          onRenameEndpoint={canEdit ? handleRenameEndpoint : noop}
          onDeleteFolder={canEdit ? handleDeleteFolder : noop}
          onDeleteEndpoint={canEdit ? handleDeleteEndpoint : noop}
          onReorderSiblings={canEdit ? handleReorderSiblings : noop}
          onMoveToFolder={canEdit ? handleMoveToFolder : noop}
          onAutoOrganize={canEdit ? handleAutoOrganize : noop}
          onBlockedMove={setError}
        />
        <main className="docs-app__main">
          {error && <div className="banner banner--error">{error}</div>}
          {(() => {
            const activeVersionDoc = apiVersions.find((v) => v.version === activeVersion);
            if (!activeVersionDoc || activeVersionDoc.status === "active") return null;
            return (
              <div className="banner">
                This version is <strong>{activeVersionDoc.status}</strong>
                {activeVersionDoc.status === "deprecated" ? " — consider migrating consumers to a newer version." : "."}
              </div>
            );
          })()}
          {viewMode === "fulldoc" && (
            <FullDocView
              tree={tree}
              allFolders={folders}
              apiOrigin={apiOrigin}
              environment={activeEnvironment}
              environments={environments}
              activeEnvironmentId={activeEnvironmentId}
              onSelectEnvironment={setActiveEnvironmentId}
              onManageEnvironments={() => setEnvironmentsModalOpen(true)}
              canEdit={canEdit}
              onTryIt={tryItFromFullDoc}
              onSectionInView={setSelectedVayoId}
            />
          )}
          {viewMode === "endpoint" && !selected && (
            <div className="empty-state">
              No endpoints captured yet — hit some routes on your API, or create one manually, and they&apos;ll show up
              here.
            </div>
          )}
          {viewMode === "endpoint" && selected && (
            <>
              <FolderBreadcrumb folders={folders} folderId={selected.operation["x-vayo-folder-id"] ?? null} />
              <EndpointHeader
                endpoint={selected}
                viewerNames={(presenceByEndpoint[selected.vayoId] ?? [])
                  .filter((memberId) => memberId !== me.id)
                  .map((memberId) => memberNames[memberId] ?? "Someone")}
              />
              <TabBar active={activeTab} onChange={setActiveTab} />
              {activeTab === "details" && (
                <DetailsTab
                  endpoint={selected}
                  apiOrigin={apiOrigin}
                  environment={activeEnvironment}
                  environments={environments}
                  activeEnvironmentId={activeEnvironmentId}
                  onSelectEnvironment={setActiveEnvironmentId}
                  onManageEnvironments={() => setEnvironmentsModalOpen(true)}
                  onTryIt={() => setActiveTab("tryit")}
                  canEdit={canEdit}
                />
              )}
              {activeTab === "flowmap" &&
                (CustomFlowmap ? (
                  <CustomFlowmap
                    vayoId={selected.vayoId}
                    middlewareChain={selected.operation["x-vayo-middleware-chain"]}
                    flows={flows}
                    endpoints={endpoints}
                    canEdit={canEdit}
                    onOpenFlow={openFlowInFlowsPanel}
                    onOpenFlowsPanel={openFlowsPanel}
                  />
                ) : (
                  <FlowmapTab
                    vayoId={selected.vayoId}
                    middlewareChain={selected.operation["x-vayo-middleware-chain"]}
                    flows={flows}
                    endpoints={endpoints}
                    canEdit={canEdit}
                    onOpenFlow={openFlowInFlowsPanel}
                    onOpenFlowsPanel={openFlowsPanel}
                  />
                ))}
              {activeTab === "history" &&
                (CustomHistory ? (
                  <CustomHistory vayoId={selected.vayoId} />
                ) : (
                  <HistoryTab vayoId={selected.vayoId} memberNames={memberNames} />
                ))}
              {activeTab === "chat" && (
                <TeamChatTab
                  vayoId={selected.vayoId}
                  currentMemberId={me.id}
                  canResolve={me.role !== "viewer"}
                  memberNames={memberNames}
                  endpoints={endpoints}
                  onJumpToEndpoint={jumpToEndpointFromChat}
                  highlightCommentId={highlightCommentId}
                  onHighlighted={() => setHighlightCommentId(null)}
                />
              )}
              {activeTab === "tryit" && (
                <TryItNowTab
                  endpoint={selected}
                  apiOrigin={apiOrigin}
                  environment={activeEnvironment}
                  onAddEnvironmentVariable={handleAddEnvironmentVariable}
                  allEndpoints={endpoints}
                  onNavigateToEndpoint={selectEndpointKeepTab}
                  canEdit={canEdit}
                />
              )}
            </>
          )}
        </main>
      </div>

      {paletteOpen && <CommandPalette endpoints={endpoints} onSelect={selectEndpoint} onClose={() => setPaletteOpen(false)} />}

      {creatingFolderParentId !== "none" && (
        <CreateFolderModal onCancel={() => setCreatingFolderParentId("none")} onCreate={handleCreateFolder} />
      )}

      {creatingEndpointParentId !== "none" && (
        <CreateEndpointModal onCancel={() => setCreatingEndpointParentId("none")} onCreate={handleCreateEndpoint} />
      )}

      {environmentsModalOpen && (
        <EnvironmentsModal
          environments={environments}
          onCreate={handleCreateEnvironment}
          onUpdate={handleUpdateEnvironment}
          onDelete={handleDeleteEnvironment}
          onClose={() => setEnvironmentsModalOpen(false)}
        />
      )}

      {settingsModalOpen && settings && (
        <SettingsModal
          settings={settings}
          canEdit={canEdit}
          onSave={handleUpdateSettings}
          onClose={() => setSettingsModalOpen(false)}
        />
      )}

      {flowsModalOpen && (
        <FlowsModal
          version={activeVersion}
          apiOrigin={apiOrigin}
          environment={activeEnvironment}
          endpoints={endpoints}
          canEdit={canEdit}
          initialFlowId={flowsModalInitialFlowId}
          onClose={() => {
            setFlowsModalOpen(false);
            setFlowsModalInitialFlowId(undefined);
            refetchFlows().catch(() => {});
          }}
        />
      )}

      {versionsModalOpen && (
        <VersionsModal
          versions={apiVersions}
          canEdit={canEdit}
          onCreate={handleCreateApiVersion}
          onUpdateStatus={handleUpdateApiVersionStatus}
          onClose={() => setVersionsModalOpen(false)}
        />
      )}

      {diffModalOpen && <DiffModal versions={apiVersions} onClose={() => setDiffModalOpen(false)} />}

      {coverageModalOpen && (
        <CoverageModal
          version={activeVersion}
          onSelectEndpoint={selectEndpoint}
          onClose={() => setCoverageModalOpen(false)}
        />
      )}

      {globalChatOpen && (
        <GlobalChatDrawer
          endpoints={endpoints}
          memberNames={memberNames}
          currentMemberId={me.id}
          currentVayoId={selected?.vayoId ?? null}
          onJumpToEndpoint={jumpToEndpointFromChat}
          onClose={() => setGlobalChatOpen(false)}
        />
      )}

      {teamModalOpen && (
        <TeamModal
          members={teamMembers}
          currentMemberId={me.id}
          isOwner={me.role === "owner"}
          myNicknames={me.nicknames}
          initialMemberId={teamModalOpen.initialMemberId}
          onMembersChanged={refetchTeam}
          onMyNameChanged={(name) => setMe((prev) => (prev ? { ...prev, name } : prev))}
          onMyAvatarChanged={(avatarUrl) => setMe((prev) => (prev ? { ...prev, avatarUrl } : prev))}
          onNicknamesChanged={(nicknames) => setMe((prev) => (prev ? { ...prev, nicknames } : prev))}
          onClose={() => setTeamModalOpen(null)}
        />
      )}

      {overrideToast && overrideToast.memberId !== me.id && (
        <div className="override-toast">
          <span>
            <strong>{memberNames[overrideToast.memberId] ?? "A teammate"}</strong> just updated{" "}
            {endpoints.find((e) => e.vayoId === overrideToast.vayoId)?.path ?? "an endpoint"}
          </span>
          <button type="button" className="icon-button" onClick={() => setOverrideToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
    </SocketProvider>
    </ConfigProvider>
  );
}
