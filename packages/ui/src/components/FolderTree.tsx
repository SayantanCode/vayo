// @vayo/ui — the sidebar's drag-and-drop folder tree (docs/03-data-model.md
// "Manual endpoints & folders"). dnd-kit's sortable preset operates on a
// flat list, so nesting is expressed via each row's `depth`/`parentId`
// (see `flattenTree` in ../types.ts), not by nesting DndContexts.
//
// Drop behavior, matching Postman:
//  - Drop on the MIDDLE of a folder row -> moves the dragged item INTO that
//    folder (appended after its existing same-kind children), auto-expanding
//    it. Position is judged from the actual pointer Y vs. the hovered row's
//    rect (see computeDropPosition/currentPointerY) — dnd-kit's over.id only
//    tells you *which* row is hovered, not where within it, and its own
//    dragged-element rect isn't a safe substitute for the pointer (see
//    currentPointerY's comment for why).
//  - Drop near the TOP or BOTTOM edge of any row (folder or endpoint) ->
//    inserts the dragged item as a SIBLING before/after that row, within
//    that row's own parent — this is what lets a folder be repositioned next
//    to another folder (or pulled back out of one) instead of always
//    nesting inside the nearest folder.
//  - Either case moves AND positions in one step when the target parent
//    differs from the dragged item's current one (not reorder-only) — a
//    single onReorderSiblings call handles both, since placement's folderId
//    and order are set together for every id in the list.
// Folders and endpoints are independently ordered within a parent (folders
// always render above endpoints — see buildTree), so reordering only ever
// touches same-kind siblings.

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS, getEventCoordinates } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, FilePlus, Folder, FolderPlus, FoldVertical, Sparkles, Tag, UnfoldVertical } from "lucide-react";
import type { FolderDoc } from "@vayo/types";
import type { FlatTreeRow, TreeNode } from "../types.js";
import { flattenTree } from "../types.js";
import { ConfirmModal } from "./ConfirmModal.js";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu.js";
import { MoveToFolderModal } from "./MoveToFolderModal.js";

interface FolderTreeProps {
  tree: TreeNode[];
  allFolders: FolderDoc[];
  selectedVayoId: string | null;
  /** Viewer-role sessions get a read-only tree — creation/rename/delete/
   * drag/move affordances aren't just disabled, they're not rendered at
   * all. The server independently enforces the same role check on every
   * one of these routes (docs/05-security.md §4); this is a UX nicety
   * layered on top of that, same principle as the rest of the app. */
  canEdit: boolean;
  /** True while DocsApp's Full Docs view is open — expands every folder
   * once on the transition into this mode (a good default for a page that
   * shows everything at once anyway, not a permanent lock: the user can
   * still collapse individual folders afterward same as always). */
  fullDocMode: boolean;
  onSelectEndpoint: (vayoId: string) => void;
  onCreateFolder: (parentId: string | null) => void;
  onCreateEndpoint: (parentId: string | null) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onRenameEndpoint: (vayoId: string, summary: string | null) => void;
  onDeleteFolder: (folderId: string) => void;
  /** Only ever called for a "manual" endpoint — the context menu doesn't
   * even offer this action for a captured one, see openEndpointMenu. */
  onDeleteEndpoint: (vayoId: string) => void;
  onReorderSiblings: (kind: "folder" | "endpoint", parentId: string | null, orderedIds: string[]) => void;
  onMoveToFolder: (kind: "folder" | "endpoint", id: string, targetFolderId: string | null) => void;
  onAutoOrganize: () => void;
  /** Called instead of a move when `isBlockedGroupMove` refuses one — the
   * host app surfaces this through its existing error banner (same channel
   * any other failed action already uses), rather than the drag silently
   * doing nothing with no explanation. */
  onBlockedMove: (message: string) => void;
}

function nodeIdentity(node: TreeNode): { kind: "folder" | "endpoint"; id: string; label: string; method?: string } {
  return node.type === "folder"
    ? { kind: "folder", id: node.folder._id, label: node.folder.name }
    : { kind: "endpoint", id: node.endpoint.vayoId, label: node.endpoint.summary || node.endpoint.path, method: node.endpoint.method };
}

/** True if `targetId` is `startId` itself or a descendant of it — used to
 * refuse dropping a folder into itself or one of its own sub-folders. */
function isFolderOrDescendant(startId: string, targetId: string, allFolders: FolderDoc[]): boolean {
  if (startId === targetId) return true;
  return allFolders.filter((f) => f.parentId === startId).some((child) => isFolderOrDescendant(child._id, targetId, allFolders));
}

/** True if a drag-and-drop move should be refused because the dragged
 * endpoint's group came from an explicit `@group` declaration in code
 * (docs/04-capture-engine.md Step 2 #4) rather than a guess — the human
 * override philosophy every other field in this app follows (drag/rename/
 * overrides always win) is deliberately NOT applied to a "declared" group's
 * folder: the code is treated as the more authoritative source, since a
 * silent sidebar drag could otherwise leave the docs saying something the
 * codebase itself disagrees with. Such an endpoint can still be reordered
 * among its CURRENT folder's own siblings (`targetFolderId === currentFolderId`)
 * — only a move to a genuinely different folder is blocked. Exported for
 * direct unit testing (see FolderTree.test.ts) — the drag machinery itself
 * isn't practically unit-testable, but this decision is pure and small
 * enough to verify in isolation. */
export function isBlockedGroupMove(
  groupSource: "declared" | "inferred",
  currentFolderId: string | null,
  targetFolderId: string | null,
): boolean {
  return groupSource === "declared" && targetFolderId !== currentFolderId;
}

type DropPosition = "before" | "after" | "inside";

/** Where the pointer currently sits relative to the hovered row's own rect
 * — over.id only tells you *which* row, not where within it. Deliberately
 * uses the actual pointer Y (see currentPointerY in FolderTree), not the
 * dragged element's translated rect center: a row is only ~30px tall, and
 * dnd-kit translates the WHOLE dragged element by the pointer's delta, so
 * the element's center only equals the pointer position if the user
 * happened to grab the row exactly at its vertical center. Grab it near the
 * top or bottom instead (just as likely with a ~30px row) and the rect
 * center drifts up to half a row-height away from where the mouse actually
 * is — silently corrupting this calculation with no visible symptom other
 * than "it drops in the wrong place." Endpoint rows have no "inside" (you
 * can't nest into an endpoint), so they only ever split before/after at the
 * row's midpoint. Folder rows get a generous 40% top/bottom for
 * before/after — reordering next to a folder (or pulling one back out) is
 * the far more common gesture — and need a deliberate drop within the
 * middle 20% to nest inside. */
function computeDropPosition(pointerY: number, overRect: { top: number; height: number }, isFolderTarget: boolean): DropPosition {
  const relative = (pointerY - overRect.top) / overRect.height;
  if (isFolderTarget) {
    if (relative < 0.4) return "before";
    if (relative > 0.6) return "after";
    return "inside";
  }
  return relative < 0.5 ? "before" : "after";
}

/** Which row counts as "hovered" during a drag. dnd-kit's default
 * `closestCenter` picks the droppable whose rect-center is nearest the
 * DRAGGED ELEMENT's rect-center — and that element's rect suffers the exact
 * same grab-offset problem computeDropPosition's comment describes: grab a
 * ~30px row anywhere but its dead center and the element's rect (and so its
 * center) drifts away from the actual pointer. That drift doesn't just
 * skew *where within* a row a drop lands (fixed above) — it can pick the
 * WRONG ROW ENTIRELY, e.g. a folder one level up whose center happens to be
 * closer to the drifted rect than the row actually under the cursor.
 * `pointerWithin` sidesteps this by testing which droppable's rect the raw
 * pointer coordinates actually fall inside — no dragged-rect math involved.
 * It has no fallback for when the pointer isn't over any droppable (a
 * keyboard-driven drag has no pointer at all, and the very top/bottom of
 * the list has no row below/above it), so `closestCenter` covers those. */
const collisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

/** Every folder id on the path from the root down to `vayoId`'s endpoint —
 * used to highlight a collapsed ancestor so a selected endpoint is never
 * simply "lost" once its folder (or a folder above that) is collapsed. */
function findAncestorFolderIds(nodes: TreeNode[], vayoId: string, path: string[] = []): string[] | null {
  for (const node of nodes) {
    if (node.type === "endpoint") {
      if (node.endpoint.vayoId === vayoId) return path;
    } else {
      const found = findAncestorFolderIds(node.children, vayoId, [...path, node.folder._id]);
      if (found) return found;
    }
  }
  return null;
}

export function FolderTree(props: FolderTreeProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renamingEndpointId, setRenamingEndpointId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [moveTarget, setMoveTarget] = useState<{
    kind: "folder" | "endpoint";
    id: string;
    currentParentId: string | null;
  } | null>(null);
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<{ id: string; name: string } | null>(null);
  const [confirmDeleteEndpoint, setConfirmDeleteEndpoint] = useState<{
    vayoId: string;
    label: string;
    reason: "manual" | "possibly-removed";
  } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ id: string; position: DropPosition } | null>(null);
  // The pointer's Y at pickup (a ref, not state — read inside the drag
  // handlers below, never needs to trigger a render). null for a
  // keyboard-driven drag (space bar), which has no pointer position at all;
  // computeDropPosition then falls back to the OVER row's own rect center,
  // which is fine for keyboard nav since there's no human grab-offset to
  // correct for.
  const dragStartClientYRef = useRef<number | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  const rows = useMemo(() => flattenTree(props.tree, expanded), [props.tree, expanded]);
  const activeRow = rows.find((r) => r.id === activeId) ?? null;
  // A fully-expanded flatten, independent of the user's actual expand/
  // collapse state — sibling-list computation in handleDragEnd must see a
  // folder's real children even while it's collapsed, or dropping into a
  // collapsed folder loses track of what's already in it (duplicate
  // `order` values). `rows` (above) stays collapse-aware since it drives
  // what's actually rendered/sortable-registered.
  const allFolderIds = useMemo(() => new Set(props.allFolders.map((f) => f._id)), [props.allFolders]);
  const fullRows = useMemo(() => flattenTree(props.tree, allFolderIds), [props.tree, allFolderIds]);
  const selectedAncestorFolderIds = useMemo(
    () => new Set(props.selectedVayoId ? (findAncestorFolderIds(props.tree, props.selectedVayoId) ?? []) : []),
    [props.tree, props.selectedVayoId],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // useSortable's default ARIA description tells screen-reader users to
    // "press the space bar" to pick up a row — that promise is only true if
    // a keyboard sensor is actually registered, so it is.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Fires once on the transition INTO Full Docs (not continuously while
  // it's on, and not on the way back out) — a good default starting point
  // for a page that shows every endpoint at once anyway, not a forced
  // state: the user can still collapse individual folders afterward same
  // as any other time.
  useEffect(() => {
    if (props.fullDocMode) setExpanded(new Set(allFolderIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fullDocMode]);

  // Keeps the sidebar's own highlighted row in view as `selectedVayoId`
  // changes for ANY reason — a click here (already scrolled into view by
  // definition), a click on the header's search palette, or, the case this
  // specifically closes the loop on, Full Docs's scroll-spy updating it
  // continuously as the user free-scrolls the main pane. `"nearest"` is
  // deliberate — it's a no-op if the row's already visible, rather than
  // re-centering the sidebar on every single change while scrolling.
  useEffect(() => {
    if (!props.selectedVayoId) return;
    const row = sidebarRef.current?.querySelector(`[data-vayo-id="${window.CSS.escape(props.selectedVayoId)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [props.selectedVayoId]);

  function toggle(folderId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function expandAll() {
    setExpanded(new Set(allFolderIds));
  }

  function collapseAll() {
    setExpanded(new Set());
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
    // null for a keyboard-driven pickup (space bar) — there's no pointer
    // position to capture, and computeDropPosition's caller falls back to
    // the hovered row's own center in that case.
    dragStartClientYRef.current = getEventCoordinates(event.activatorEvent)?.y ?? null;
  }

  /** The pointer's current Y, reconstructed from where it was at pickup
   * (captured above) plus dnd-kit's cumulative delta — DragOverEvent/
   * DragEndEvent don't expose live pointer coordinates directly. Falls back
   * to the hovered row's own vertical center for a keyboard-driven drag. */
  function currentPointerY(deltaY: number, overRect: { top: number; height: number }): number {
    return dragStartClientYRef.current === null ? overRect.top + overRect.height / 2 : dragStartClientYRef.current + deltaY;
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over, delta } = event;
    if (!over || over.id === active.id) {
      setDropIndicator(null);
      return;
    }
    const overRow = rows.find((r) => r.id === over.id);
    if (!overRow) {
      setDropIndicator(null);
      return;
    }
    const pointerY = currentPointerY(delta.y, over.rect);
    const position = computeDropPosition(pointerY, over.rect, overRow.node.type === "folder");
    setDropIndicator({ id: String(over.id), position });
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    setDropIndicator(null);
    const { active, over, delta } = event;
    if (!over || active.id === over.id) return;
    const draggedRow = rows.find((r) => r.id === active.id);
    const overRow = rows.find((r) => r.id === over.id);
    if (!draggedRow || !overRow) return;

    const draggedIdentity = nodeIdentity(draggedRow.node);
    // A "declared" group (explicit `@group` tag, docs/04-capture-engine.md
    // Step 2 #4) locks the endpoint to its current folder — undefined for a
    // folder row, where this never applies at all.
    const lockedToFolderId =
      draggedRow.node.type === "endpoint" && draggedRow.node.endpoint.operation["x-vayo-group-source"] === "declared"
        ? (draggedRow.node.endpoint.operation["x-vayo-folder-id"] ?? null)
        : undefined;
    // Uses fullRows (not the collapse-aware `rows`) so a target folder's
    // real existing children are seen even while it's collapsed.
    const sameKindSiblings = (parentId: string | null) =>
      fullRows
        .filter((r) => r.parentId === parentId && r.id !== active.id && r.node.type === draggedRow.node.type)
        .map((r) => nodeIdentity(r.node).id);

    const pointerY = currentPointerY(delta.y, over.rect);
    const position = computeDropPosition(pointerY, over.rect, overRow.node.type === "folder");

    // Dropped on the MIDDLE of a folder row -> move INTO that folder.
    if (overRow.node.type === "folder" && position === "inside") {
      const targetFolderId = overRow.node.folder._id;
      if (draggedIdentity.kind === "folder" && isFolderOrDescendant(draggedIdentity.id, targetFolderId, props.allFolders)) {
        return; // can't drop a folder into itself or its own descendant
      }
      if (lockedToFolderId !== undefined && isBlockedGroupMove("declared", lockedToFolderId, targetFolderId)) {
        props.onBlockedMove(`"${draggedIdentity.label}" is grouped in code via @group — move it there instead of in the sidebar.`);
        return;
      }
      props.onReorderSiblings(draggedIdentity.kind, targetFolderId, [...sameKindSiblings(targetFolderId), draggedIdentity.id]);
      setExpanded((prev) => new Set(prev).add(targetFolderId));
      return;
    }

    // Dropped near the top/bottom edge of a row (folder or endpoint) ->
    // insert as a SIBLING before/after it, within THAT row's own parent
    // (which may differ from the dragged item's current parent — a
    // cross-folder move and a precise reorder happen in one step). This is
    // what lets a folder be repositioned next to another folder, or pulled
    // back out of one, instead of always nesting inside the nearest folder.
    const targetParentId = overRow.parentId;
    if (draggedIdentity.kind === "folder" && targetParentId !== null && isFolderOrDescendant(draggedIdentity.id, targetParentId, props.allFolders)) {
      return; // would nest the folder inside itself or its own descendant
    }
    if (lockedToFolderId !== undefined && isBlockedGroupMove("declared", lockedToFolderId, targetParentId)) {
      props.onBlockedMove(`"${draggedIdentity.label}" is grouped in code via @group — move it there instead of in the sidebar.`);
      return;
    }
    if (draggedRow.node.type !== overRow.node.type) {
      // Mismatched kind (e.g. a folder dropped near an endpoint's row) — no
      // precise position is implied, so append at the end instead.
      props.onReorderSiblings(draggedIdentity.kind, targetParentId, [...sameKindSiblings(targetParentId), draggedIdentity.id]);
      return;
    }

    const siblings = sameKindSiblings(targetParentId);
    const overIndex = siblings.indexOf(nodeIdentity(overRow.node).id);
    const baseIndex = overIndex === -1 ? siblings.length : overIndex;
    const insertIndex = position === "after" ? baseIndex + 1 : baseIndex;
    const newIds = [...siblings];
    newIds.splice(insertIndex, 0, draggedIdentity.id);
    props.onReorderSiblings(draggedIdentity.kind, targetParentId, newIds);
  }

  function openFolderMenu(e: ReactMouseEvent, folderId: string, folderName: string, parentId: string | null) {
    if (!props.canEdit) return;
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "New folder", onClick: () => props.onCreateFolder(folderId) },
        { label: "New endpoint", onClick: () => props.onCreateEndpoint(folderId) },
        {
          label: "Rename",
          onClick: () => {
            setRenamingFolderId(folderId);
            setRenameValue(folderName);
          },
        },
        { label: "Move to…", onClick: () => setMoveTarget({ kind: "folder", id: folderId, currentParentId: parentId }) },
        { label: "Delete", onClick: () => setConfirmDeleteFolder({ id: folderId, name: folderName }), danger: true },
      ],
    });
  }

  function openEndpointMenu(
    e: ReactMouseEvent,
    vayoId: string,
    folderId: string | null,
    currentSummary: string,
    deletable: "manual" | "possibly-removed" | null,
    label: string,
    groupLocked: boolean,
  ) {
    if (!props.canEdit) return;
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Rename",
          onClick: () => {
            setRenamingEndpointId(vayoId);
            setRenameValue(currentSummary);
          },
        },
        // Omitted entirely for a "declared"-group endpoint (an explicit
        // @group tag in code) — same "don't even offer an action that'll
        // just get refused" pattern as Delete below. Reordering within the
        // current folder still works via drag-and-drop.
        ...(groupLocked
          ? []
          : [{ label: "Move to…", onClick: () => setMoveTarget({ kind: "endpoint", id: vayoId, currentParentId: folderId }) }]),
        // A manual (never-captured) placeholder, or one the most recent
        // scan didn't re-find, gets this option — deleting any other
        // captured endpoint would just have it reappear on the next scan
        // or the next request (see the delete route's own comment).
        ...(deletable
          ? [{ label: "Delete", onClick: () => setConfirmDeleteEndpoint({ vayoId, label, reason: deletable }), danger: true }]
          : []),
      ],
    });
  }

  function commitRename() {
    if (renamingFolderId) props.onRenameFolder(renamingFolderId, renameValue.trim() || "Untitled");
    if (renamingEndpointId) props.onRenameEndpoint(renamingEndpointId, renameValue.trim() || null);
    setRenamingFolderId(null);
    setRenamingEndpointId(null);
  }

  return (
    <nav className="sidebar" ref={sidebarRef}>
      <div className="sidebar__heading-row">
        <span className="sidebar__heading">Endpoints</span>
        <button type="button" className="icon-button" title="Expand all folders" onClick={expandAll}>
          <UnfoldVertical size={14} />
        </button>
        <button type="button" className="icon-button" title="Collapse all folders" onClick={collapseAll}>
          <FoldVertical size={14} />
        </button>
        {props.canEdit && (
          <>
            <button
              type="button"
              className="icon-button"
              title="Organize by detected groups — creates folders for any group with none yet, places only endpoints that have never been placed anywhere"
              onClick={props.onAutoOrganize}
            >
              <Sparkles size={14} />
            </button>
            <button type="button" className="icon-button" title="New folder" onClick={() => props.onCreateFolder(null)}>
              <FolderPlus size={14} />
            </button>
          </>
        )}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={props.canEdit ? handleDragStart : undefined}
        onDragOver={props.canEdit ? handleDragOver : undefined}
        onDragEnd={props.canEdit ? handleDragEnd : undefined}
      >
        <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
          {rows.map((row) => (
            <TreeRow
              key={row.id}
              row={row}
              canEdit={props.canEdit}
              dropPosition={dropIndicator && dropIndicator.id === row.id && activeId !== row.id ? dropIndicator.position : null}
              expanded={expanded}
              onToggle={toggle}
              selectedVayoId={props.selectedVayoId}
              containsSelected={row.node.type === "folder" && selectedAncestorFolderIds.has(row.node.folder._id)}
              onSelectEndpoint={props.onSelectEndpoint}
              renamingFolderId={renamingFolderId}
              renamingEndpointId={renamingEndpointId}
              renameValue={renameValue}
              onRenameValueChange={setRenameValue}
              onStartRename={(id, name) => {
                setRenamingFolderId(id);
                setRenameValue(name);
              }}
              onStartRenameEndpoint={(id, name) => {
                setRenamingEndpointId(id);
                setRenameValue(name);
              }}
              onCommitRename={commitRename}
              onFolderContextMenu={openFolderMenu}
              onEndpointContextMenu={openEndpointMenu}
            />
          ))}
        </SortableContext>

        <DragOverlay>
          {activeRow && (
            <div className="tree-row tree-row--overlay">
              {activeRow.node.type === "folder" ? (
                <>
                  <Folder size={14} className="tree-row__icon" />
                  <span className="tree-row__label">{activeRow.node.folder.name}</span>
                </>
              ) : (
                <>
                  <span className="tree-row__label">{activeRow.node.endpoint.summary || activeRow.node.endpoint.path}</span>
                  <span className={`method-badge method-badge--${activeRow.node.endpoint.method.toLowerCase()}`}>
                    {activeRow.node.endpoint.method}
                  </span>
                </>
              )}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {rows.length === 0 && <p className="sidebar__empty muted">No endpoints yet.</p>}

      {props.canEdit && (
        <button type="button" className="sidebar__new-endpoint" onClick={() => props.onCreateEndpoint(null)}>
          <FilePlus size={14} /> New endpoint
        </button>
      )}

      {contextMenu && (
        <ContextMenu items={contextMenu.items} anchorX={contextMenu.x} anchorY={contextMenu.y} onClose={() => setContextMenu(null)} />
      )}

      {moveTarget && (
        <MoveToFolderModal
          folders={props.allFolders.filter((f) => f._id !== moveTarget.id)}
          currentParentId={moveTarget.currentParentId}
          onCancel={() => setMoveTarget(null)}
          onConfirm={(targetFolderId) => {
            props.onMoveToFolder(moveTarget.kind, moveTarget.id, targetFolderId);
            setMoveTarget(null);
          }}
        />
      )}

      {confirmDeleteFolder && (
        <ConfirmModal
          title={`Delete "${confirmDeleteFolder.name}"?`}
          message="Its endpoints and sub-folders move up to its own parent — nothing inside it is deleted, just un-grouped."
          confirmLabel="Delete folder"
          onCancel={() => setConfirmDeleteFolder(null)}
          onConfirm={() => {
            props.onDeleteFolder(confirmDeleteFolder.id);
            setConfirmDeleteFolder(null);
          }}
        />
      )}

      {confirmDeleteEndpoint && (
        <ConfirmModal
          title={`Delete "${confirmDeleteEndpoint.label}"?`}
          message={
            confirmDeleteEndpoint.reason === "manual"
              ? "This is a manually-created endpoint — it isn't backed by a real route in your API, so nothing will reappear on the next scan. This can't be undone."
              : "The most recent scan didn't find this route in your API anymore. If it's actually still there, run \"vayo scan\" again first — this will otherwise reappear. This can't be undone."
          }
          confirmLabel="Delete endpoint"
          onCancel={() => setConfirmDeleteEndpoint(null)}
          onConfirm={() => {
            props.onDeleteEndpoint(confirmDeleteEndpoint.vayoId);
            setConfirmDeleteEndpoint(null);
          }}
        />
      )}
    </nav>
  );
}

interface TreeRowProps {
  row: FlatTreeRow;
  canEdit: boolean;
  dropPosition: DropPosition | null;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  selectedVayoId: string | null;
  /** True for a folder that's currently collapsed and has the selected
   * endpoint somewhere inside it — irrelevant once expanded, since the
   * endpoint's own `tree-row--active` highlight is directly visible then. */
  containsSelected: boolean;
  onSelectEndpoint: (vayoId: string) => void;
  renamingFolderId: string | null;
  renamingEndpointId: string | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onStartRename: (id: string, name: string) => void;
  onStartRenameEndpoint: (vayoId: string, summary: string) => void;
  onCommitRename: () => void;
  onFolderContextMenu: (e: ReactMouseEvent, folderId: string, folderName: string, parentId: string | null) => void;
  onEndpointContextMenu: (
    e: ReactMouseEvent,
    vayoId: string,
    folderId: string | null,
    currentSummary: string,
    deletable: "manual" | "possibly-removed" | null,
    label: string,
    groupLocked: boolean,
  ) => void;
}

/** One vertical guide line per ancestor level, each aligned under that
 * ancestor's chevron column (`8 + i*16` mirrors the padding-left formula
 * used for row indentation) — the depth cue deep nesting is otherwise
 * missing, per docs/09-roadmap.md Postman-parity redesign notes. */
function TreeGuides({ depth }: { depth: number }): JSX.Element | null {
  if (depth === 0) return null;
  return (
    <span className="tree-row__guides" aria-hidden="true">
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="tree-row__guide" style={{ left: 8 + i * 16 + 7 }} />
      ))}
    </span>
  );
}

function TreeRow({ row, ...props }: TreeRowProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.id,
    disabled: !props.canEdit,
  });
  const dragProps = props.canEdit ? { ...attributes, ...listeners } : {};
  // Endpoint (leaf) rows get an extra +20 on top of the per-depth step —
  // see .tree-row__leaf-spacer's comment for why: without it, a folder's
  // own chevron+icon prefix makes its label sit further right than its
  // child endpoint's label, so nesting reads backwards.
  const baseIndent = 8 + row.depth * 20;
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    paddingLeft: row.node.type === "endpoint" ? baseIndent + 20 : baseIndent,
    cursor: props.canEdit ? undefined : "default",
  };

  if (row.node.type === "folder") {
    const folder = row.node.folder;
    const isExpanded = props.expanded.has(folder._id);
    const isRenaming = props.renamingFolderId === folder._id;
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={`tree-row tree-row--folder ${props.dropPosition === "inside" ? "tree-row--drop-into" : ""} ${
          props.dropPosition === "before" ? "tree-row--drop-before" : ""
        } ${props.dropPosition === "after" ? "tree-row--drop-after" : ""} ${
          !isExpanded && props.containsSelected ? "tree-row--contains-selected" : ""
        }`}
        {...dragProps}
        onClick={() => {
          if (!isRenaming) props.onToggle(folder._id);
        }}
        onContextMenu={(e) => props.onFolderContextMenu(e, folder._id, folder.name, folder.parentId)}
      >
        <TreeGuides depth={row.depth} />
        <button
          type="button"
          className="tree-row__chevron"
          title={isExpanded ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.stopPropagation();
            props.onToggle(folder._id);
          }}
        >
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <Folder size={14} className="tree-row__icon" />
        {isRenaming ? (
          <input
            name="renameFolder"
            className="tree-row__rename-input"
            value={props.renameValue}
            autoFocus
            onChange={(e) => props.onRenameValueChange(e.target.value)}
            onBlur={props.onCommitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") props.onCommitRename();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="tree-row__label"
            onDoubleClick={
              props.canEdit
                ? (e) => {
                    e.stopPropagation();
                    props.onStartRename(folder._id, folder.name);
                  }
                : undefined
            }
          >
            {folder.name}
          </span>
        )}
      </div>
    );
  }

  const endpoint = row.node.endpoint;
  const folderId = endpoint.operation["x-vayo-folder-id"] ?? null;
  const isRenaming = props.renamingEndpointId === endpoint.vayoId;
  return (
    <div
      ref={setNodeRef}
      data-vayo-id={endpoint.vayoId}
      style={style}
      role="button"
      tabIndex={0}
      className={`tree-row tree-row--endpoint ${endpoint.vayoId === props.selectedVayoId ? "tree-row--active" : ""} ${
        props.dropPosition === "before" ? "tree-row--drop-before" : ""
      } ${props.dropPosition === "after" ? "tree-row--drop-after" : ""}`}
      {...dragProps}
      onClick={() => {
        if (!isRenaming) props.onSelectEndpoint(endpoint.vayoId);
      }}
      onKeyDown={(e) => {
        if (!isRenaming && (e.key === "Enter" || e.key === " ")) props.onSelectEndpoint(endpoint.vayoId);
      }}
      onContextMenu={(e) =>
        props.onEndpointContextMenu(
          e,
          endpoint.vayoId,
          folderId,
          endpoint.summary ?? "",
          endpoint.operation["x-vayo-source"] === "manual"
            ? "manual"
            : endpoint.operation["x-vayo-possibly-removed-since"]
              ? "possibly-removed"
              : null,
          endpoint.summary || endpoint.path,
          endpoint.operation["x-vayo-group-source"] === "declared",
        )
      }
    >
      <TreeGuides depth={row.depth} />
      {isRenaming ? (
        <input
          name="renameEndpoint"
          className="tree-row__rename-input"
          value={props.renameValue}
          autoFocus
          onChange={(e) => props.onRenameValueChange(e.target.value)}
          onBlur={props.onCommitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") props.onCommitRename();
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="tree-row__label"
          onDoubleClick={
            props.canEdit
              ? (e) => {
                  e.stopPropagation();
                  props.onStartRenameEndpoint(endpoint.vayoId, endpoint.summary ?? "");
                }
              : undefined
          }
        >
          {endpoint.summary || endpoint.path}
        </span>
      )}
      {endpoint.operation["x-vayo-group-source"] === "declared" && (
        <span
          className="tree-row__tag-icon"
          title="Grouped in code via @group — reorder it here, but move it between folders by editing that tag instead."
        >
          <Tag size={12} />
        </span>
      )}
      {endpoint.operation["x-vayo-possibly-removed-since"] && (
        <span
          className="tree-row__flag"
          title="The most recent scan didn't find this route in your API anymore — it may have been removed."
        >
          ⚠
        </span>
      )}
      <span className={`method-badge method-badge--${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
    </div>
  );
}
