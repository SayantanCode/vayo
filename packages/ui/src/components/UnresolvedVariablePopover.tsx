// @vayo/ui — Postman-style "Unresolved Variable" popover: shown while
// hovering a red (invalid) `{{variable}}` token inside a VariableField.
// Vayo only has one kind of variable (environment-scoped — no separate
// collection/global scope the way Postman has), so the add-variable form
// is just name + value, no scope picker.

import { useState } from "react";
import { AlertTriangle } from "lucide-react";

interface UnresolvedVariablePopoverProps {
  name: string;
  anchorRect: DOMRect;
  environmentName: string | null;
  onAddVariable: ((name: string, value: string) => Promise<void>) | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function UnresolvedVariablePopover({
  name,
  anchorRect,
  environmentName,
  onAddVariable,
  onMouseEnter,
  onMouseLeave,
}: UnresolvedVariablePopoverProps): JSX.Element {
  const [mode, setMode] = useState<"message" | "form">("message");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const style = { top: anchorRect.bottom + 6, left: anchorRect.left };

  async function submit() {
    if (!onAddVariable) return;
    setSaving(true);
    try {
      await onAddVariable(name, value);
    } finally {
      setSaving(false);
    }
  }

  if (mode === "form") {
    return (
      <div className="var-popover" style={style} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
        <div className="var-popover__header">Set as new variable</div>
        <label className="field var-popover__field">
          <span>Name</span>
          <input value={name} disabled />
        </label>
        <label className="field var-popover__field">
          <span>Value</span>
          <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus placeholder="Variable value" />
        </label>
        <button type="button" className="button button--primary var-popover__submit" onClick={submit} disabled={saving}>
          {saving ? "Saving…" : "Set Variable"}
        </button>
      </div>
    );
  }

  return (
    <div className="var-popover" style={style} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="var-popover__header">
        <AlertTriangle size={14} />
        Unresolved Variable
      </div>
      {environmentName ? (
        <>
          <p className="var-popover__text">
            <code>{`{{${name}}}`}</code> isn't defined in the active environment (<strong>{environmentName}</strong>).
          </p>
          {onAddVariable && (
            <button type="button" className="button var-popover__add" onClick={() => setMode("form")}>
              Add new variable
            </button>
          )}
        </>
      ) : (
        <p className="var-popover__text">
          No environment is active. Select or create one from the header, then add <code>{name}</code> to it.
        </p>
      )}
    </div>
  );
}
