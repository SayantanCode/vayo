// @vayo/ui — header dropdown for picking the active API version
// (docs/07-api-versioning.md). Includes a permanent "Unversioned" entry —
// captured traffic that matched no configured basePathPattern lands there,
// and it should stay reachable even when empty, same as any other version.

import { useRef, useState } from "react";
import { ChevronDown, GitBranch, GitCompare, Settings } from "lucide-react";
import type { ApiVersionDoc } from "@vayo/types";
import { useDismiss } from "../hooks/useDismiss.js";

interface VersionSwitcherProps {
  versions: ApiVersionDoc[];
  activeVersion: string;
  onSelect: (version: string) => void;
  onManage: () => void;
  onCompare: () => void;
}

export function VersionSwitcher({ versions, activeVersion, onSelect, onManage, onCompare }: VersionSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, () => setOpen(false), open);
  const active = versions.find((v) => v.version === activeVersion) ?? null;

  return (
    <div className="env-switcher" ref={ref}>
      <button type="button" className="env-switcher__trigger" onClick={() => setOpen((o) => !o)}>
        <GitBranch size={14} />
        <span>{activeVersion}</span>
        {active && active.status !== "active" && <span className="badge">{active.status}</span>}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="env-switcher__menu">
          {versions.map((v) => (
            <button
              key={v.version}
              type="button"
              className={`env-switcher__option ${activeVersion === v.version ? "env-switcher__option--active" : ""}`}
              onClick={() => {
                onSelect(v.version);
                setOpen(false);
              }}
            >
              {v.version}
              {v.status !== "active" && <span className="muted"> ({v.status})</span>}
            </button>
          ))}
          <button
            type="button"
            className={`env-switcher__option ${activeVersion === "unversioned" ? "env-switcher__option--active" : ""}`}
            onClick={() => {
              onSelect("unversioned");
              setOpen(false);
            }}
          >
            Unversioned
          </button>
          <div className="env-switcher__divider" />
          <button
            type="button"
            className="env-switcher__option"
            onClick={() => {
              onCompare();
              setOpen(false);
            }}
          >
            <GitCompare size={13} /> Compare versions…
          </button>
          <button
            type="button"
            className="env-switcher__option"
            onClick={() => {
              onManage();
              setOpen(false);
            }}
          >
            <Settings size={13} /> Manage versions…
          </button>
        </div>
      )}
    </div>
  );
}
