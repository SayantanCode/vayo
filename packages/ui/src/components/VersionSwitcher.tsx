// @vayo-hq/ui — header dropdown for picking the active API version
// (docs/07-api-versioning.md). Includes a permanent "Unversioned" entry —
// captured traffic that matched no configured basePathPattern lands there,
// and it should stay reachable even when empty, same as any other version —
// and, when it hasn't been explicitly created as a real version yet, the
// app's own default version key (see `defaultVersion` below), for the same
// reason.

import { useRef, useState } from "react";
import { ChevronDown, GitBranch, GitCompare, Settings } from "lucide-react";
import type { ApiVersionDoc } from "@vayo-hq/types";
import { useDismiss } from "../hooks/useDismiss.js";

interface VersionSwitcherProps {
  versions: ApiVersionDoc[];
  activeVersion: string;
  /** The version key `DocsApp` was originally loaded with (the whole app's
   * `version` prop, fixed at mount) — real endpoint data can exist under
   * this key (schema-engine's `resolveVersion` fallback resolves everything
   * to it, usually "v1", until an ApiVersionDoc is explicitly created)
   * before it's ever a "real" stored version. Kept separate from
   * `activeVersion` (which changes as the user navigates) specifically so
   * this stays reachable even after switching away to "Unversioned" or
   * anywhere else — otherwise it's a one-way trip, since nothing but
   * manually creating a version with this exact name would restore it. */
  defaultVersion: string;
  onSelect: (version: string) => void;
  onManage: () => void;
  onCompare: () => void;
}

/** True when `defaultVersion` needs to be synthesized as a selectable
 * option because no real `ApiVersionDoc` exists for it yet — "unversioned"
 * is never phantom, since it's already unconditionally rendered below.
 * Exported for direct unit testing (see VersionSwitcher.test.ts), same
 * reasoning as FolderTree's `isBlockedGroupMove`. */
export function isDefaultVersionPhantom(defaultVersion: string, versions: ApiVersionDoc[]): boolean {
  return defaultVersion !== "unversioned" && !versions.some((v) => v.version === defaultVersion);
}

export function VersionSwitcher({
  versions,
  activeVersion,
  defaultVersion,
  onSelect,
  onManage,
  onCompare,
}: VersionSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, () => setOpen(false), open);
  const active = versions.find((v) => v.version === activeVersion) ?? null;
  const defaultVersionIsPhantom = isDefaultVersionPhantom(defaultVersion, versions);

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
          {defaultVersionIsPhantom && (
            <button
              type="button"
              className={`env-switcher__option ${activeVersion === defaultVersion ? "env-switcher__option--active" : ""}`}
              onClick={() => {
                onSelect(defaultVersion);
                setOpen(false);
              }}
            >
              {defaultVersion}
            </button>
          )}
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
