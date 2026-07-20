// @vayo/ui — create versions + manage their lifecycle
// (docs/07-api-versioning.md: active -> deprecated -> sunset, with
// deprecated -> active un-deprecation allowed; sunset is terminal — no
// delete, versions are never removed, same non-destructive philosophy as
// everything else).

import { useState } from "react";
import type { ApiVersionDoc, ApiVersionStatus } from "@vayo/types";
import { Modal } from "./Modal.js";

interface VersionsModalProps {
  versions: ApiVersionDoc[];
  canEdit: boolean;
  onCreate: (version: string, basePathPattern: string) => Promise<void>;
  onUpdateStatus: (version: string, status: ApiVersionStatus) => Promise<void>;
  onClose: () => void;
}

export function VersionsModal({ versions, canEdit, onCreate, onUpdateStatus, onClose }: VersionsModalProps): JSX.Element {
  const [selectedVersion, setSelectedVersion] = useState<string | "new">(versions[0]?.version ?? "new");
  const [versionInput, setVersionInput] = useState("");
  const [basePathPatternInput, setBasePathPatternInput] = useState("");

  const selected = selectedVersion !== "new" ? (versions.find((v) => v.version === selectedVersion) ?? null) : null;

  function select(v: string | "new") {
    setSelectedVersion(v);
    const found = v !== "new" ? (versions.find((x) => x.version === v) ?? null) : null;
    setVersionInput(found?.version ?? "");
    setBasePathPatternInput(found?.basePathPattern ?? "");
  }

  async function handleCreate() {
    if (!versionInput.trim() || !basePathPatternInput.trim()) return;
    await onCreate(versionInput.trim(), basePathPatternInput.trim());
    setVersionInput("");
    setBasePathPatternInput("");
  }

  return (
    <Modal onClose={onClose} className="env-modal">
      <h3>API Versions</h3>
        <div className="env-modal__body">
          <div className="env-modal__list modal__list">
            {versions.map((v) => (
              <button
                key={v.version}
                type="button"
                className={`modal__option ${selectedVersion === v.version ? "modal__option--current" : ""}`}
                onClick={() => select(v.version)}
              >
                {v.version} <span className="muted">({v.status})</span>
              </button>
            ))}
            {canEdit && (
              <button
                type="button"
                className={`modal__option ${selectedVersion === "new" ? "modal__option--current" : ""}`}
                onClick={() => select("new")}
              >
                + New version
              </button>
            )}
          </div>

          <div className="env-modal__editor">
            {selected ? (
              <>
                <p>
                  <strong>{selected.version}</strong> — <code>{selected.basePathPattern}</code>
                </p>
                <p className="muted">Status: {selected.status}</p>
                {canEdit && (
                  <div className="tag-row">
                    {selected.status === "active" && (
                      <button
                        type="button"
                        className="button"
                        onClick={() => onUpdateStatus(selected.version, "deprecated")}
                      >
                        Mark deprecated
                      </button>
                    )}
                    {selected.status === "deprecated" && (
                      <>
                        <button type="button" className="button" onClick={() => onUpdateStatus(selected.version, "active")}>
                          Reactivate
                        </button>
                        <button type="button" className="button" onClick={() => onUpdateStatus(selected.version, "sunset")}>
                          Mark sunset
                        </button>
                      </>
                    )}
                    {selected.status === "sunset" && (
                      <p className="muted">Sunset is terminal — this version's docs stay readable, but its lifecycle is final.</p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <label className="field">
                  <span>Version</span>
                  <input name="version" value={versionInput} onChange={(e) => setVersionInput(e.target.value)} placeholder="v2" />
                </label>
                <label className="field">
                  <span>Base path pattern</span>
                  <input
                    name="basePathPattern"
                    value={basePathPatternInput}
                    onChange={(e) => setBasePathPatternInput(e.target.value)}
                    placeholder="/api/v2"
                  />
                </label>
              </>
            )}
          </div>
        </div>
        <div className="modal__actions">
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
          {!selected && canEdit && (
            <button type="button" className="button button--primary" onClick={handleCreate}>
              Create
            </button>
          )}
        </div>
    </Modal>
  );
}
