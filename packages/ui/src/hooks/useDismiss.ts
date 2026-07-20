import { useEffect, type RefObject } from "react";

/** Just the Escape-key half of `useDismiss`, below — for a panel that should
 * close on Escape but must NOT close on an outside click (a persistent side
 * drawer the user may want open while clicking around the main content
 * behind it, unlike a modal or dropdown). */
export function useEscapeKey(onEscape: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onEscape();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onEscape, enabled]);
}

/** Calls `onDismiss` when the user clicks/taps outside `ref`'s element, or
 * presses Escape — the "close this popover/menu/modal" gesture every
 * dropdown, context menu, and modal in this app needs. Previously
 * reimplemented independently in half a dozen components (ContextMenu,
 * CommandPalette's group filter, TeamChatTab's message context menu and
 * date-jump popover, each header dropdown); this is the one shared version.
 *
 * `enabled` lets a caller skip attaching listeners entirely while the
 * thing being dismissed isn't even open, rather than attaching them
 * unconditionally and no-op'ing inside. */
export function useDismiss(ref: RefObject<HTMLElement>, onDismiss: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    function handlePointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onDismiss();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [ref, onDismiss, enabled]);
}
