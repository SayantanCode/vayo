// @vayo/ui — create/edit/delete environments + their key-value variables.
// Follows the existing .modal/.modal__list conventions from
// CreateFolderModal/MoveToFolderModal.

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { EnvironmentDoc } from "@vayo/types";
import { Modal } from "./Modal.js";

interface EnvironmentsModalProps {
  environments: EnvironmentDoc[];
  onCreate: (name: string, variables: Record<string, string>) => Promise<void>;
  onUpdate: (id: string, patch: Partial<{ name: string; variables: Record<string, string> }>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}

interface VarRow {
  key: string;
  value: string;
}

function toRows(vars: Record<string, string>): VarRow[] {
  const rows = Object.entries(vars).map(([key, value]) => ({ key, value }));
  return rows.length > 0 ? rows : [{ key: "", value: "" }];
}

function toVariables(rows: VarRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row.key.trim()) out[row.key.trim()] = row.value;
  }
  return out;
}

export function EnvironmentsModal({ environments, onCreate, onUpdate, onDelete, onClose }: EnvironmentsModalProps): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | "new">(environments[0]?._id ?? "new");
  const selected = selectedId !== "new" ? (environments.find((e) => e._id === selectedId) ?? null) : null;

  const [name, setName] = useState(selected?.name ?? "");
  const [rows, setRows] = useState<VarRow[]>(toRows(selected?.variables ?? {}));

  function select(id: string | "new") {
    setSelectedId(id);
    const env = id !== "new" ? (environments.find((e) => e._id === id) ?? null) : null;
    setName(env?.name ?? "");
    setRows(toRows(env?.variables ?? {}));
  }

  async function save() {
    const variables = toVariables(rows);
    if (selectedId === "new") {
      await onCreate(name.trim() || "New environment", variables);
    } else if (selected) {
      await onUpdate(selected._id, { name: name.trim() || selected.name, variables });
    }
  }

  return (
    <Modal onClose={onClose} className="env-modal">
      <h3>Environments</h3>
        <div className="env-modal__body">
          <div className="env-modal__list modal__list">
            {environments.map((env) => (
              <button
                key={env._id}
                type="button"
                className={`modal__option ${selectedId === env._id ? "modal__option--current" : ""}`}
                onClick={() => select(env._id)}
              >
                {env.name}
              </button>
            ))}
            <button
              type="button"
              className={`modal__option ${selectedId === "new" ? "modal__option--current" : ""}`}
              onClick={() => select("new")}
            >
              + New environment
            </button>
          </div>
          <div className="env-modal__editor">
            <label className="field">
              <span>Name</span>
              <input name="envName" value={name} onChange={(e) => setName(e.target.value)} placeholder="Development" />
            </label>
            <div className="field">
              <span>Variables</span>
              <div className="env-modal__vars">
                {rows.map((row, i) => (
                  <div className="env-modal__var-row" key={i}>
                    <input
                      name={`envVarKey${i}`}
                      placeholder="key (e.g. baseUrl)"
                      value={row.key}
                      onChange={(e) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, key: e.target.value } : r)))}
                    />
                    <input
                      name={`envVarValue${i}`}
                      placeholder="value"
                      value={row.value}
                      onChange={(e) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, value: e.target.value } : r)))}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      title="Remove"
                      onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="button env-modal__add-var"
                  onClick={() => setRows((prev) => [...prev, { key: "", value: "" }])}
                >
                  <Plus size={12} /> Add variable
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="modal__actions">
          {selected && (
            <button
              type="button"
              className="button"
              onClick={() => {
                onDelete(selected._id);
                select("new");
              }}
            >
              Delete
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
          <button type="button" className="button button--primary" onClick={save}>
            Save
          </button>
        </div>
    </Modal>
  );
}
