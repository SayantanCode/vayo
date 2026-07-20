// @vayo/ui — a small "are you sure?" dialog for a destructive action
// triggered from somewhere that can't host an inline confirm step itself
// (a right-click context menu closes on any click, unlike a modal's own
// stable detail panel — see TeamModal's inline "Remove from team" flow for
// the alternative, used where a stable panel already exists). Generic
// rather than one-off per caller, since both folder deletion and manual
// endpoint deletion need the identical shape.
import type { ReactNode } from "react";
import { Modal } from "./Modal.js";

interface ConfirmModalProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

export function ConfirmModal({ title, message, confirmLabel, onConfirm, onCancel, busy }: ConfirmModalProps): JSX.Element {
  return (
    <Modal onClose={onCancel}>
      <h3>{title}</h3>
      <p className="muted">{message}</p>
      <div className="modal__actions">
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button button--danger" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
