import { useState, type FormEvent } from "react";
import { Modal } from "./Modal.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export interface ManualEndpointInput {
  method: string;
  pathTemplate: string;
  group: string;
  summary: string | null;
}

interface CreateEndpointModalProps {
  onCancel: () => void;
  onCreate: (input: ManualEndpointInput) => void;
}

/** A manually-created endpoint entry (docs/03-data-model.md "Manual
 * endpoints") — a deliberate escape hatch alongside, not instead of,
 * zero-annotation auto-discovery. If real traffic ever hits this exact
 * route, it merges in naturally, same vayoId either way. */
export function CreateEndpointModal({ onCancel, onCreate }: CreateEndpointModalProps): JSX.Element {
  const [method, setMethod] = useState("GET");
  const [pathTemplate, setPathTemplate] = useState("/api/");
  const [group, setGroup] = useState("General");
  const [summary, setSummary] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!pathTemplate.trim()) return;
    onCreate({
      method,
      pathTemplate: pathTemplate.trim(),
      group: group.trim() || "General",
      summary: summary.trim() || null,
    });
  }

  return (
    <Modal onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <h3>New endpoint</h3>
        <div className="banner banner--warning">
          This isn't verified against your backend code — Vayo can't confirm a route like this actually exists there.
          Add it if you're sure (documenting a third-party API, or a route landing soon), but if you meant one of
          your own endpoints, double-check the path first. Real traffic hitting this exact path later merges into
          this same entry automatically either way.
        </div>
        <label className="field">
          <span>Method</span>
          <select name="method" value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Path</span>
          <input
            name="pathTemplate"
            value={pathTemplate}
            onChange={(e) => setPathTemplate(e.target.value)}
            placeholder="/api/users/:id"
          />
        </label>
        <label className="field">
          <span>Group</span>
          <input name="group" value={group} onChange={(e) => setGroup(e.target.value)} />
        </label>
        <label className="field">
          <span>Summary (optional)</span>
          <input name="summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
        </label>
        <div className="modal__actions">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={!pathTemplate.trim()}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
