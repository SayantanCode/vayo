// @vayo/ui — export menu: OpenAPI spec + Postman collection/environment
// downloads. Deliberately a plain client-side blob download rather than the
// official "Run in Postman" embed button — that button needs a publicly
// reachable, unauthenticated collection URL, which doesn't fit a
// self-hosted, bearer-auth-gated Vayo deployment (see the Postman-parity
// redesign plan). Downloading the JSON and importing it into Postman
// manually gets the same result with none of that fragility.

import { useRef, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { api } from "../api.js";
import { useDismiss } from "../hooks/useDismiss.js";
import { useConfig } from "../contexts/ConfigContext.js";

interface ExportMenuProps {
  version: string;
  activeEnvironmentId: string | null;
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportMenu({ version, activeEnvironmentId }: ExportMenuProps): JSX.Element {
  const config = useConfig();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, () => setOpen(false), open);

  async function exportOpenApi() {
    const spec = await api.getSpec(config, version);
    downloadJson(`vayo-${version}.openapi.json`, spec);
    setOpen(false);
  }

  async function exportCollection() {
    const collection = await api.exportPostmanCollection(config, version);
    downloadJson(`vayo-${version}.postman_collection.json`, collection);
    setOpen(false);
  }

  async function exportEnvironment() {
    if (!activeEnvironmentId) return;
    const env = await api.exportPostmanEnvironment(config, activeEnvironmentId);
    downloadJson(`vayo.postman_environment.json`, env);
    setOpen(false);
  }

  return (
    <div className="env-switcher" ref={ref}>
      <button type="button" className="env-switcher__trigger" onClick={() => setOpen((o) => !o)}>
        <Download size={14} />
        <span>Export</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="env-switcher__menu">
          <button type="button" className="env-switcher__option" onClick={exportOpenApi}>
            Download OpenAPI JSON
          </button>
          <button type="button" className="env-switcher__option" onClick={exportCollection}>
            Download Postman Collection
          </button>
          <button
            type="button"
            className="env-switcher__option"
            onClick={exportEnvironment}
            disabled={!activeEnvironmentId}
            title={activeEnvironmentId ? "Downloads the active environment" : "Select an environment first"}
          >
            Download Postman Environment
          </button>
        </div>
      )}
    </div>
  );
}
