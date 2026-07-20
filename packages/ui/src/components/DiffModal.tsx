// @vayo/ui — compares two API versions (docs/07-api-versioning.md), via
// `@vayo/server`'s /api/diff (a custom TypeScript diff over Vayo's own
// compiled OpenAPI documents — not oasdiff, see that doc's notes on why).

import { useState } from "react";
import type { ApiVersionDoc } from "@vayo/types";
import type { SpecDiff } from "@vayo/openapi-compiler";
import { api, ApiError } from "../api.js";
import { Modal } from "./Modal.js";
import { useConfig } from "../contexts/ConfigContext.js";

interface DiffModalProps {
  versions: ApiVersionDoc[];
  onClose: () => void;
}

export function DiffModal({ versions, onClose }: DiffModalProps): JSX.Element {
  const config = useConfig();
  const [from, setFrom] = useState(versions[0]?.version ?? "");
  const [to, setTo] = useState(versions[1]?.version ?? versions[0]?.version ?? "");
  const [diff, setDiff] = useState<SpecDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runDiff() {
    setLoading(true);
    setError(null);
    setDiff(null);
    try {
      setDiff(await api.diffVersions(config, from, to));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to compute diff");
    } finally {
      setLoading(false);
    }
  }

  const hasResults = diff && (diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0);
  const hasNoDiff = diff && diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;

  return (
    <Modal onClose={onClose} className="diff-modal">
      <h3>Compare versions</h3>
        <div className="diff-modal__pickers">
          <label className="field">
            <span>From</span>
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  {v.version}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>To</span>
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  {v.version}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="button button--primary" onClick={runDiff} disabled={loading || !from || !to}>
            {loading ? "Comparing…" : "Compare"}
          </button>
        </div>

        {error && <div className="banner banner--error">{error}</div>}

        {hasResults && (
          <div className="diff-modal__results">
            <div className="tag-row">
              {diff.added.length > 0 && <span className="badge badge--resolved">{diff.added.length} added</span>}
              {diff.removed.length > 0 && <span className="badge badge--required">{diff.removed.length} removed</span>}
              {diff.changed.length > 0 && <span className="badge">{diff.changed.length} changed</span>}
            </div>

            {diff.added.map((op) => (
              <div key={`added-${op.method}-${op.path}`} className="diff-modal__row">
                <span className={`method-badge method-badge--${op.method.toLowerCase()}`}>{op.method}</span>
                <span>{op.path}</span>
                <span className="badge badge--resolved">added</span>
              </div>
            ))}
            {diff.removed.map((op) => (
              <div key={`removed-${op.method}-${op.path}`} className="diff-modal__row">
                <span className={`method-badge method-badge--${op.method.toLowerCase()}`}>{op.method}</span>
                <span>{op.path}</span>
                <span className="badge badge--required">removed</span>
              </div>
            ))}
            {diff.changed.map((c) => (
              <div key={`changed-${c.operation.method}-${c.operation.path}`} className="diff-modal__changed">
                <div className="diff-modal__row">
                  <span className={`method-badge method-badge--${c.operation.method.toLowerCase()}`}>{c.operation.method}</span>
                  <span>{c.operation.path}</span>
                </div>
                <ul className="diff-modal__change-list">
                  {c.changes.map((change, i) => (
                    <li key={i}>{change}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {hasNoDiff && <p className="muted">No structural differences between these two versions.</p>}

        <div className="modal__actions">
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </div>
    </Modal>
  );
}
