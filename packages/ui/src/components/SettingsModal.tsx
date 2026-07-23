// @vayo/ui — project-wide title/description shown in the exported spec's
// info object (the equivalent of swagger-jsdoc's options.definition.info),
// editable through the docs UI instead of only ever hardcoded in a config
// file. Follows the existing .modal/.field conventions from EnvironmentsModal.

import { useState } from "react";
import type { SettingsDoc } from "@vayo/types";
import { Modal } from "./Modal.js";

interface SettingsModalProps {
  settings: SettingsDoc;
  canEdit: boolean;
  onSave: (patch: { title: string; description: string | null }) => Promise<void>;
  onClose: () => void;
}

export function SettingsModal({ settings, canEdit, onSave, onClose }: SettingsModalProps): JSX.Element {
  const [title, setTitle] = useState(settings.title);
  const [description, setDescription] = useState(settings.description ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await onSave({ title: title.trim() || "Vayo API", description: description.trim() || null });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} className="settings-modal">
      <h3>Project settings</h3>
      <p className="muted">
        Shown as <code>info.title</code>/<code>info.description</code> in your exported OpenAPI spec, plus in this
        docs UI's own header — the same fields swagger-jsdoc's <code>options.definition</code> sets in code, just
        editable here instead.
      </p>
      <label className="field">
        <span>Title</span>
        <input
          name="settingsTitle"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Vayo API"
          disabled={!canEdit}
        />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea
          name="settingsDescription"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="A short description of your API."
          rows={4}
          disabled={!canEdit}
        />
      </label>
      <div className="modal__actions">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
        {canEdit && (
          <button type="button" className="button button--primary" onClick={save} disabled={saving}>
            Save
          </button>
        )}
      </div>
    </Modal>
  );
}
