// @vayo/ui — project-wide title/description/contact/license/termsOfService
// shown in the exported spec's info object (the equivalent of
// swagger-jsdoc's options.definition.info), editable through the docs UI
// instead of only ever hardcoded in a config file. Follows the existing
// .modal/.field conventions from EnvironmentsModal.

import { useState } from "react";
import type { SettingsDoc } from "@vayo/types";
import { Modal } from "./Modal.js";

export interface SettingsPatch {
  title: string;
  description: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactUrl: string | null;
  licenseName: string | null;
  licenseUrl: string | null;
  termsOfService: string | null;
}

interface SettingsModalProps {
  settings: SettingsDoc;
  canEdit: boolean;
  onSave: (patch: SettingsPatch) => Promise<void>;
  onClose: () => void;
}

export function SettingsModal({ settings, canEdit, onSave, onClose }: SettingsModalProps): JSX.Element {
  const [title, setTitle] = useState(settings.title);
  const [description, setDescription] = useState(settings.description ?? "");
  const [contactName, setContactName] = useState(settings.contactName ?? "");
  const [contactEmail, setContactEmail] = useState(settings.contactEmail ?? "");
  const [contactUrl, setContactUrl] = useState(settings.contactUrl ?? "");
  const [licenseName, setLicenseName] = useState(settings.licenseName ?? "");
  const [licenseUrl, setLicenseUrl] = useState(settings.licenseUrl ?? "");
  const [termsOfService, setTermsOfService] = useState(settings.termsOfService ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await onSave({
        title: title.trim() || "Vayo API",
        description: description.trim() || null,
        contactName: contactName.trim() || null,
        contactEmail: contactEmail.trim() || null,
        contactUrl: contactUrl.trim() || null,
        licenseName: licenseName.trim() || null,
        licenseUrl: licenseUrl.trim() || null,
        termsOfService: termsOfService.trim() || null,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} className="settings-modal">
      <h3>Project settings</h3>
      <p className="muted">
        Populates <code>info</code> in your exported OpenAPI spec — the same fields swagger-jsdoc's{" "}
        <code>options.definition</code> sets in code, just editable here instead. The title and description are also
        the only place a description is ever shown inside this docs UI itself, at the top of Full Docs mode.
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

      <h4 className="settings-modal__section">Contact</h4>
      <label className="field">
        <span>Name</span>
        <input
          name="settingsContactName"
          value={contactName}
          onChange={(e) => setContactName(e.target.value)}
          placeholder="API Team"
          disabled={!canEdit}
        />
      </label>
      <label className="field">
        <span>Email</span>
        <input
          name="settingsContactEmail"
          type="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          placeholder="api@example.com"
          disabled={!canEdit}
        />
      </label>
      <label className="field">
        <span>URL</span>
        <input
          name="settingsContactUrl"
          type="url"
          value={contactUrl}
          onChange={(e) => setContactUrl(e.target.value)}
          placeholder="https://example.com/support"
          disabled={!canEdit}
        />
      </label>

      <h4 className="settings-modal__section">License</h4>
      <label className="field">
        <span>Name</span>
        <input
          name="settingsLicenseName"
          value={licenseName}
          onChange={(e) => setLicenseName(e.target.value)}
          placeholder="MIT"
          disabled={!canEdit}
        />
      </label>
      <label className="field">
        <span>URL</span>
        <span className="field__hint">Required for the license to appear in the exported spec — OpenAPI 3.1 doesn't allow a name on its own.</span>
        <input
          name="settingsLicenseUrl"
          type="url"
          value={licenseUrl}
          onChange={(e) => setLicenseUrl(e.target.value)}
          placeholder="https://opensource.org/licenses/MIT"
          disabled={!canEdit}
        />
      </label>

      <label className="field">
        <span>Terms of Service URL</span>
        <input
          name="settingsTermsOfService"
          type="url"
          value={termsOfService}
          onChange={(e) => setTermsOfService(e.target.value)}
          placeholder="https://example.com/terms"
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
