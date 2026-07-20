// @vayo/ui — Coverage: what's still auto-only vs. human-confirmed for this
// version. Not a blocker or a validation gate — a review queue. Tells a doc
// author where a human pass is still needed, and tells a frontend consumer
// which error shapes are genuinely unknown rather than documented-as-absent.

import { useEffect, useState } from "react";
import type { CoverageReport, CoverageRef } from "../types.js";
import { api } from "../api.js";
import { Modal } from "./Modal.js";
import { useConfig } from "../contexts/ConfigContext.js";

interface CoverageModalProps {
  version: string;
  onSelectEndpoint: (vayoId: string) => void;
  onClose: () => void;
}

function CoverageSection({
  title,
  items,
  emptyText,
  onJump,
}: {
  title: string;
  items: CoverageRef[];
  emptyText: string;
  onJump: (vayoId: string) => void;
}): JSX.Element {
  return (
    <div className="coverage-modal__section">
      <h4>
        {title} <span className="badge">{items.length}</span>
      </h4>
      {items.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <div className="coverage-modal__list">
          {items.map((ref) => (
            <button
              key={`${ref.method}-${ref.pathTemplate}`}
              type="button"
              className="coverage-modal__row"
              onClick={() => onJump(ref.vayoId)}
            >
              <span className={`method-badge method-badge--${ref.method.toLowerCase()}`}>{ref.method}</span>
              <span>{ref.pathTemplate}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CoverageModal({ version, onSelectEndpoint, onClose }: CoverageModalProps): JSX.Element {
  const config = useConfig();
  const [report, setReport] = useState<CoverageReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .getCoverage(config, version)
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  function jump(vayoId: string) {
    onSelectEndpoint(vayoId);
    onClose();
  }

  return (
    <Modal onClose={onClose} className="coverage-modal">
      <h3>Coverage</h3>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : report ? (
          <>
            <div className="coverage-modal__summary">
              <div className="coverage-modal__percent">{report.fullyDocumentedPercent}%</div>
              <p className="muted">
                fully documented across {report.totalEndpoints} endpoint{report.totalEndpoints === 1 ? "" : "s"} in {version}.
              </p>
            </div>
            <CoverageSection
              title="Never confirmed by real traffic"
              items={report.neverConfirmedByTraffic}
              emptyText="Every endpoint has been merged with at least one real captured request."
              onJump={jump}
            />
            <p className="muted coverage-modal__section-note">
              Found by static analysis only — the shapes shown are inferred from code, not observed. Hit these once to confirm the docs match reality.
            </p>
            <CoverageSection
              title="Only ever seen success responses"
              items={report.onlySuccessStatus}
              emptyText="Every endpoint has at least one non-2xx response documented."
              onJump={jump}
            />
            <CoverageSection
              title="No summary yet"
              items={report.missingSummary}
              emptyText="Every endpoint has a human-written title."
              onJump={jump}
            />
            <CoverageSection
              title="No notes yet"
              items={report.missingNotes}
              emptyText="Every endpoint has frontend-workflow notes written."
              onJump={jump}
            />
          </>
        ) : (
          <p className="muted">Couldn't load coverage.</p>
        )}
        <div className="modal__actions">
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </div>
    </Modal>
  );
}
