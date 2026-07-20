// @vayo/ui — turns a raw AuditLogDoc (docs/03-data-model.md) into what the
// History tab actually renders: a human-readable summary line plus a
// leaf-level list of what changed. Pulled out as pure functions (no React,
// no fetch) so the logic is unit-testable on its own, same pattern as
// dot-path.ts/example-from-schema.ts in this package.

import type { AuditAction, AuditLogDoc } from "@vayo/types";

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  override: "Manual edit",
  comment: "Comment",
  invite: "Invited",
  role_change: "Role changed",
  schema_change: "Schema changed",
  endpoint_created: "Endpoint discovered",
  endpoint_deleted: "Endpoint deleted",
  member_removed: "Member removed",
  invite_revoked: "Invite revoked",
};

export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Recursively walks two values and returns only the leaf paths that
 * actually differ. Used for `schema_change`, whose diff is a whole nested
 * JSON Schema object — this is what turns "here are two 40-line schema
 * blobs, spot the difference" into "requestSchema.properties.email:
 * added". Arrays are compared as opaque values (order/identity make a
 * per-index diff more confusing than useful, not less). */
export function diffLeaves(before: unknown, after: unknown, path = ""): FieldChange[] {
  if (before === after) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changes: FieldChange[] = [];
    for (const key of keys) {
      changes.push(...diffLeaves(before[key], after[key], path ? `${path}.${key}` : key));
    }
    return changes;
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [{ path: path || "(value)", before, after }];
}

export interface AuditEntrySummary {
  summary: string;
  changes: FieldChange[];
}

/** The one place that decides what an audit-log entry actually means in
 * plain language — the History tab renders this instead of the raw
 * action/diff fields directly, so every entry reads as a sentence, not a
 * technical record. */
export function describeAuditEntry(entry: Pick<AuditLogDoc, "action" | "fieldPath" | "diff">): AuditEntrySummary {
  switch (entry.action) {
    case "override": {
      const field = entry.fieldPath ?? "a field";
      return {
        summary: `Set ${field}`,
        changes: [{ path: field, before: entry.diff?.before ?? null, after: entry.diff?.after ?? null }],
      };
    }
    case "role_change":
      return {
        summary: "Role changed",
        changes: [{ path: "role", before: entry.diff?.before ?? null, after: entry.diff?.after ?? null }],
      };
    case "schema_change": {
      const changes = diffLeaves(entry.diff?.before ?? null, entry.diff?.after ?? null);
      return { summary: `Schema changed — ${changes.length} field${changes.length === 1 ? "" : "s"}`, changes };
    }
    case "comment": {
      const body = typeof entry.diff?.after === "string" ? entry.diff.after : "";
      return { summary: body, changes: [] };
    }
    case "invite": {
      const after = entry.diff?.after as { email?: string; role?: string } | null | undefined;
      return { summary: `Invited ${after?.email ?? "someone"} as ${after?.role ?? "a member"}`, changes: [] };
    }
    case "endpoint_created": {
      const after = entry.diff?.after as { method?: string; pathTemplate?: string } | null | undefined;
      return { summary: `Discovered ${after?.method ?? ""} ${after?.pathTemplate ?? ""}`.trim(), changes: [] };
    }
    case "endpoint_deleted": {
      const before = entry.diff?.before as { method?: string; pathTemplate?: string } | null | undefined;
      return { summary: `Deleted ${before?.method ?? ""} ${before?.pathTemplate ?? ""}`.trim(), changes: [] };
    }
    case "member_removed": {
      const before = entry.diff?.before as { email?: string; name?: string } | null | undefined;
      return { summary: `Removed ${before?.name ?? "a member"} (${before?.email ?? "unknown email"}) from the team`, changes: [] };
    }
    case "invite_revoked": {
      const before = entry.diff?.before as { email?: string } | null | undefined;
      return { summary: `Revoked the invite for ${before?.email ?? "an address"}`, changes: [] };
    }
  }
}
