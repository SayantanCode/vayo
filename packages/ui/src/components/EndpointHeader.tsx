import { Eye } from "lucide-react";
import type { EndpointSummary } from "../types.js";

interface EndpointHeaderProps {
  endpoint: EndpointSummary;
  /** Other team members currently viewing this same endpoint (already
   * excludes the current user) — docs/06-realtime-collaboration.md's
   * presence feature, rendered per-endpoint rather than only as a sidebar
   * global count. Empty/omitted renders nothing, same as before. */
  viewerNames?: string[];
}

export function EndpointHeader({ endpoint, viewerNames = [] }: EndpointHeaderProps): JSX.Element {
  return (
    <div className="endpoint-header">
      <div className="endpoint-header__title-row">
        <h1 className="endpoint-header__title">{endpoint.summary || endpoint.path}</h1>
        <span className={`method-badge method-badge--lg method-badge--${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
        {viewerNames.length > 0 && (
          <span
            className="endpoint-header__presence"
            title={`${viewerNames.join(", ")} ${viewerNames.length === 1 ? "is" : "are"} also viewing this endpoint`}
          >
            <Eye size={13} />
            {viewerNames.length}
          </span>
        )}
      </div>
      {endpoint.summary && <div className="endpoint-header__path muted">{endpoint.path}</div>}
    </div>
  );
}
