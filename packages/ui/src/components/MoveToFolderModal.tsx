import { Modal } from "./Modal.js";

interface MoveToFolderModalProps {
  folders: Array<{ _id: string; name: string }>;
  currentParentId: string | null;
  onCancel: () => void;
  onConfirm: (folderId: string | null) => void;
}

export function MoveToFolderModal({ folders, currentParentId, onCancel, onConfirm }: MoveToFolderModalProps): JSX.Element {
  return (
    <Modal onClose={onCancel}>
      <h3>Move to folder</h3>
      <div className="modal__list">
        <button
          type="button"
          className={`modal__option ${currentParentId === null ? "modal__option--current" : ""}`}
          onClick={() => onConfirm(null)}
        >
          Root
        </button>
        {folders.map((folder) => (
          <button
            key={folder._id}
            type="button"
            className={`modal__option ${currentParentId === folder._id ? "modal__option--current" : ""}`}
            onClick={() => onConfirm(folder._id)}
          >
            {folder.name}
          </button>
        ))}
      </div>
      <div className="modal__actions">
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
