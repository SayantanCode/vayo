// @vayo/ui — Details tab's sticky right-column response reference:
// status-code tabs + an Example/Schema toggle (the "Show Schema" control
// from the Redoc/Scalar reference layouts). The Schema view reuses the
// existing SchemaField tree — this toggle is just two views of data Vayo
// already has, no new schema logic.

import { useState } from "react";
import type { ExampleDoc } from "@vayo/types";
import type { EndpointSummary } from "../types.js";
import type { ApiConfig } from "../api.js";
import { exampleFromSchema } from "../example-from-schema.js";
import { SchemaField } from "../SchemaField.js";

interface ResponseSamplePanelProps {
  endpoint: EndpointSummary;
  examples: ExampleDoc[];
  config: ApiConfig;
  canEdit: boolean;
}

type ViewMode = "example" | "schema";

function mostRecentOrPinned(examples: ExampleDoc[]): ExampleDoc | null {
  if (examples.length === 0) return null;
  const pinned = examples.find((e) => e.pinned);
  if (pinned) return pinned;
  const sorted = [...examples].sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
  return sorted[0] ?? null;
}

export function ResponseSamplePanel({ endpoint, examples, config, canEdit }: ResponseSamplePanelProps): JSX.Element | null {
  const responseEntries = Object.entries(endpoint.operation.responses ?? {});
  const [status, setStatus] = useState(responseEntries[0]?.[0] ?? "");
  const [mode, setMode] = useState<ViewMode>("example");

  if (responseEntries.length === 0) return null;

  const active = responseEntries.find(([s]) => s === status) ?? responseEntries[0]!;
  const [activeStatus, activeResponse] = active;
  const schema = activeResponse.content?.["application/json"]?.schema;
  const matchingExample = mostRecentOrPinned(examples.filter((e) => String(e.statusCode) === activeStatus));

  return (
    <div className="response-sample-panel">
      <div className="response-sample-panel__toolbar">
        <div className="try-it__subtabs response-sample-panel__tabs">
          {responseEntries.map(([s]) => (
            <button
              key={s}
              type="button"
              className={`try-it__subtab ${s === activeStatus ? "try-it__subtab--active" : ""}`}
              onClick={() => setStatus(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="response-sample-panel__mode-toggle">
          <button
            type="button"
            className={`response-sample-panel__mode-btn ${mode === "example" ? "response-sample-panel__mode-btn--active" : ""}`}
            onClick={() => setMode("example")}
          >
            Example
          </button>
          <button
            type="button"
            className={`response-sample-panel__mode-btn ${mode === "schema" ? "response-sample-panel__mode-btn--active" : ""}`}
            onClick={() => setMode("schema")}
          >
            Schema
          </button>
        </div>
      </div>
      <p className="muted response-sample-panel__description">{activeResponse.description}</p>
      {mode === "example" ? (
        <pre className="code-sample-panel__code">{JSON.stringify(matchingExample?.responseBody ?? exampleFromSchema(schema), null, 2)}</pre>
      ) : schema ? (
        <SchemaField
          name="response"
          schema={schema}
          schemaPath={`responseSchemas.${activeStatus}`}
          vayoId={endpoint.vayoId}
          config={config}
          canEdit={canEdit}
        />
      ) : (
        <p className="muted">No schema captured yet for this status.</p>
      )}
    </div>
  );
}
