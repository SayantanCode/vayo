// @vayo/ui — header dropdown for picking the active environment. The
// active environment's variables feed Try It Now's {{var}} interpolation
// (docs/03-data-model.md "Environments & variables").

import { useRef, useState } from "react";
import { ChevronDown, Globe, Settings } from "lucide-react";
import type { EnvironmentDoc } from "@vayo/types";
import { useDismiss } from "../hooks/useDismiss.js";

interface EnvironmentSwitcherProps {
  environments: EnvironmentDoc[];
  activeEnvironmentId: string | null;
  onSelect: (id: string | null) => void;
  onManage: () => void;
}

export function EnvironmentSwitcher({
  environments,
  activeEnvironmentId,
  onSelect,
  onManage,
}: EnvironmentSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, () => setOpen(false), open);
  const active = environments.find((e) => e._id === activeEnvironmentId) ?? null;

  return (
    <div className="env-switcher" ref={ref}>
      <button type="button" className="env-switcher__trigger" onClick={() => setOpen((o) => !o)}>
        <Globe size={14} />
        <span>{active ? active.name : "No environment"}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="env-switcher__menu">
          <button
            type="button"
            className={`env-switcher__option ${activeEnvironmentId === null ? "env-switcher__option--active" : ""}`}
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
          >
            No environment
          </button>
          {environments.map((env) => (
            <button
              key={env._id}
              type="button"
              className={`env-switcher__option ${activeEnvironmentId === env._id ? "env-switcher__option--active" : ""}`}
              onClick={() => {
                onSelect(env._id);
                setOpen(false);
              }}
            >
              {env.name}
              {env.isDefault && <span className="muted"> (default)</span>}
            </button>
          ))}
          <div className="env-switcher__divider" />
          <button
            type="button"
            className="env-switcher__option"
            onClick={() => {
              onManage();
              setOpen(false);
            }}
          >
            <Settings size={13} /> Manage environments…
          </button>
        </div>
      )}
    </div>
  );
}
