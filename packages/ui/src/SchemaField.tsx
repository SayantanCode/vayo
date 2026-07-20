// @vayo/ui — SchemaField: the one recursive primitive that renders any
// JSON Schema shape. No per-endpoint JSX — the Details tab, the response
// viewer, and (indirectly) the Try It form's field list all reuse this.
//
// Field descriptions are editable in place, same override mechanism as
// EndpointNotes (`${vayoId}.${schemaPath}.description`, saved via the
// already-generic `POST /api/overrides` — no dedicated backend route).
// `schemaPath`/`vayoId`/`config` are all optional so a caller without them
// (or without edit rights) gets a purely read-only tree, same as before.

import { useEffect, useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import type { JSONSchema } from "@vayo/types";
import type { ApiConfig } from "./api.js";
import { api } from "./api.js";

export interface SchemaFieldProps {
  schema: JSONSchema;
  name: string;
  depth?: number;
  required?: boolean;
  /** JSON-Schema-relative path to *this* node from the endpoint's schema
   * root, e.g. `"requestSchema"` at the root or
   * `"requestSchema.properties.email"` for a child — this is what an edited
   * description gets saved under (`${vayoId}.${schemaPath}.description`).
   * Omitted entirely for a read-only tree. */
  schemaPath?: string;
  vayoId?: string;
  config?: ApiConfig;
  canEdit?: boolean;
}

function typeLabel(schema: JSONSchema): string {
  const t = schema.type;
  if (Array.isArray(t)) return t.join(" | ");
  if (typeof t === "string") return t;
  if (schema.anyOf) return "any of";
  if (schema.properties) return "object";
  return "unknown";
}

export function SchemaField({
  schema,
  name,
  depth = 0,
  required = false,
  schemaPath,
  vayoId,
  config,
  canEdit = false,
}: SchemaFieldProps): JSX.Element {
  const type = typeLabel(schema);
  const properties = schema.properties as Record<string, JSONSchema> | undefined;
  const requiredList = (schema.required as string[] | undefined) ?? [];
  const items = schema.items as JSONSchema | undefined;
  const schemaDescription = typeof schema.description === "string" ? schema.description : null;
  const format = typeof schema.format === "string" ? schema.format : null;
  // Only rendered when a human actually set it (static JSDoc/Zod `.describe()`,
  // or an override) — same rule as `description`, never fabricated from the
  // field name or inferred shape.
  const title = typeof schema.title === "string" ? schema.title : null;
  const enumValues = Array.isArray(schema.enum) ? (schema.enum as unknown[]) : null;

  const canEditDescription = Boolean(canEdit && schemaPath && vayoId && config);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(schemaDescription ?? "");
  const [savedDescription, setSavedDescription] = useState(schemaDescription);
  const [saving, setSaving] = useState(false);

  // Re-sync whenever this is a genuinely different node (a different
  // endpoint, a different response-status tab, ...) — not on every render,
  // so an in-progress edit on one field survives a sibling's re-render.
  useEffect(() => {
    setSavedDescription(schemaDescription);
    setDraft(schemaDescription ?? "");
    setEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaPath, schemaDescription]);

  async function handleSave() {
    if (!schemaPath || !vayoId || !config) return;
    setSaving(true);
    try {
      const trimmed = draft.trim();
      await api.postOverride(config, `${vayoId}.${schemaPath}.description`, trimmed || null, null);
      setSavedDescription(trimmed || null);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setDraft(savedDescription ?? "");
    setEditing(false);
  }

  return (
    <div className="schema-field">
      <div className="schema-field__row">
        <span className="schema-field__name">{name}</span>
        <span className="schema-field__type">
          {type}
          {format && <span className="schema-field__format">&lt;{format}&gt;</span>}
        </span>
        {required && <span className="badge badge--required">required</span>}
        {enumValues && <span className="schema-field__enum">enum: {enumValues.map((v) => JSON.stringify(v)).join(" | ")}</span>}
        {canEditDescription && !editing && (
          <button
            type="button"
            className="icon-button schema-field__edit-description"
            title={savedDescription ? "Edit description" : "Add description"}
            onClick={() => setEditing(true)}
          >
            <Pencil size={12} />
          </button>
        )}
      </div>
      {editing ? (
        <div className="schema-field__description-editor">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Describe this field…"
            disabled={saving}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSave();
              if (e.key === "Escape") handleCancel();
            }}
          />
          <button type="button" className="icon-button" title="Save" disabled={saving} onClick={handleSave}>
            <Check size={13} />
          </button>
          <button type="button" className="icon-button" title="Cancel" disabled={saving} onClick={handleCancel}>
            <X size={13} />
          </button>
        </div>
      ) : (
        savedDescription && <div className="schema-field__description">{savedDescription}</div>
      )}
      {type === "object" && properties && (
        <div className="schema-field__children">
          {title && <div className="schema-field__group-title">{title}</div>}
          {Object.entries(properties).map(([key, childSchema]) => (
            <SchemaField
              key={key}
              name={key}
              schema={childSchema}
              depth={depth + 1}
              required={requiredList.includes(key)}
              schemaPath={schemaPath ? `${schemaPath}.properties.${key}` : undefined}
              vayoId={vayoId}
              config={config}
              canEdit={canEdit}
            />
          ))}
        </div>
      )}
      {type === "array" && items && (
        <div className="schema-field__children">
          <SchemaField
            name="[item]"
            schema={items}
            depth={depth + 1}
            schemaPath={schemaPath ? `${schemaPath}.items` : undefined}
            vayoId={vayoId}
            config={config}
            canEdit={canEdit}
          />
        </div>
      )}
    </div>
  );
}
