import { useState, type FormEvent } from "react";
import { Modal } from "./Modal.js";

interface CreateFolderModalProps {
  onCancel: () => void;
  onCreate: (name: string) => void;
}

export function CreateFolderModal({ onCancel, onCreate }: CreateFolderModalProps): JSX.Element {
  const [name, setName] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed) onCreate(trimmed);
  }

  return (
    <Modal onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <h3>New folder</h3>
        <input
          name="folderName"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Folder name"
        />
        <div className="modal__actions">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={!name.trim()}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
