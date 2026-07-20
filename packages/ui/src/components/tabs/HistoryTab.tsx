import { useEffect, useMemo, useState } from "react";
import { FilePlus, FileX, MailX, MessageSquare, Pencil, Shield, Sparkles, UserMinus, UserPlus } from "lucide-react";
import type { AuditAction, AuditLogDoc } from "@vayo/types";
import { api } from "../../api.js";
import { AUDIT_ACTION_LABELS, describeAuditEntry, type FieldChange } from "../../audit-diff.js";
import { useConfig } from "../../contexts/ConfigContext.js";

interface HistoryTabProps {
  vayoId: string;
  memberNames: Record<string, string>;
}

// Reuses the same icon a given concept already wears elsewhere in the app
// (Pencil = manual field edit in SchemaField, FilePlus = new endpoint in
// FolderTree, Sparkles = auto-detected in FolderTree's "organize" action) so
// History doesn't invent a second visual vocabulary for the same ideas.
const ACTION_ICONS: Record<AuditAction, typeof Pencil> = {
  override: Pencil,
  comment: MessageSquare,
  invite: UserPlus,
  role_change: Shield,
  schema_change: Sparkles,
  endpoint_created: FilePlus,
  endpoint_deleted: FileX,
  member_removed: UserMinus,
  invite_revoked: MailX,
};

type HistoryFilter = "all" | "changes" | "team";

const CHANGE_ACTIONS = new Set<AuditAction>(["override", "schema_change", "endpoint_created", "endpoint_deleted"]);
const TEAM_ACTIONS = new Set<AuditAction>(["comment", "invite", "role_change", "member_removed", "invite_revoked"]);

function matchesFilter(action: AuditAction, filter: HistoryFilter): boolean {
  if (filter === "all") return true;
  return filter === "changes" ? CHANGE_ACTIONS.has(action) : TEAM_ACTIONS.has(action);
}

function formatDiffValue(value: unknown): string {
  if (value === undefined) return "(none)";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function FieldChangeRow({ change }: { change: FieldChange }): JSX.Element {
  return (
    <div className="history-item__change">
      <code className="history-item__change-path">{change.path}</code>
      <span className="history-item__change-before">{formatDiffValue(change.before)}</span>
      <span className="muted">→</span>
      <span className="history-item__change-after">{formatDiffValue(change.after)}</span>
    </div>
  );
}

// A schema_change touching a dozen fields shouldn't force everyone else to
// scroll past a wall of diffs to see the next entry — show a few inline and
// let the rest be opened deliberately.
const INLINE_CHANGE_LIMIT = 3;

function HistoryEntry({ entry, actorName }: { entry: AuditLogDoc; actorName: string }): JSX.Element {
  const { summary, changes } = describeAuditEntry(entry);
  const Icon = ACTION_ICONS[entry.action];
  const [expanded, setExpanded] = useState(false);
  const visibleChanges = expanded ? changes : changes.slice(0, INLINE_CHANGE_LIMIT);
  const hiddenCount = changes.length - visibleChanges.length;

  return (
    <li className="history-item">
      <div className="history-item__meta">
        <span className="badge history-item__action-badge">
          <Icon size={12} />
          {AUDIT_ACTION_LABELS[entry.action]}
        </span>
        <span className="muted">{new Date(entry.at).toLocaleString()}</span>
        <span className="muted">{entry.actorType === "system" ? "system" : actorName}</span>
      </div>
      {summary && <p className="history-item__summary">{summary}</p>}
      {visibleChanges.length > 0 && (
        <div className="history-item__diff">
          {visibleChanges.map((change, i) => (
            <FieldChangeRow key={`${change.path}-${i}`} change={change} />
          ))}
        </div>
      )}
      {hiddenCount > 0 && (
        <button type="button" className="link-button" onClick={() => setExpanded(true)}>
          + {hiddenCount} more field{hiddenCount === 1 ? "" : "s"}
        </button>
      )}
    </li>
  );
}

export function HistoryTab({ vayoId, memberNames }: HistoryTabProps): JSX.Element {
  const config = useConfig();
  const [entries, setEntries] = useState<AuditLogDoc[] | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>("all");

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setFilter("all");
    api
      .listHistory(config, vayoId)
      .then((result) => {
        if (!cancelled) setEntries(result);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.baseUrl, config.token, vayoId]);

  const filtered = useMemo(() => (entries ?? []).filter((e) => matchesFilter(e.action, filter)), [entries, filter]);

  if (entries === null) {
    return (
      <div className="tab-panel">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="tab-panel">
        <p className="muted">
          No history yet for this endpoint — schema changes are recorded automatically the first time traffic shifts its
          shape.
        </p>
      </div>
    );
  }

  return (
    <div className="tab-panel">
      <div className="history-filter">
        {(
          [
            ["all", "All"],
            ["changes", "Changes"],
            ["team", "Team activity"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`history-filter__option ${filter === value ? "history-filter__option--active" : ""}`}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <p className="muted">Nothing in this category yet.</p>
      ) : (
        <ul className="history-list">
          {filtered.map((entry) => (
            <HistoryEntry key={entry._id} entry={entry} actorName={memberNames[entry.actorId] ?? "Former member"} />
          ))}
        </ul>
      )}
    </div>
  );
}
