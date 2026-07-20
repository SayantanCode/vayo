import { useState } from "react";

export function CopyField({ label, value }: { label: string; value: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable (e.g. insecure context) — silently no-op
    }
  }

  return (
    <div className="copy-field">
      <div className="copy-field__label">{label}</div>
      <div className="copy-field__row">
        <code className="copy-field__value">{value}</code>
        <button type="button" className="copy-field__button" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
