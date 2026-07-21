import { useEffect, useState } from "react";
import type { EnvironmentDoc, ExampleDoc } from "@vayo/types";
import { SchemaField } from "../../SchemaField.js";
import { CopyField } from "../CopyField.js";
import { CodeSamplePanel } from "../CodeSamplePanel.js";
import { ResponseSamplePanel } from "../ResponseSamplePanel.js";
import { EndpointNotes } from "../EndpointNotes.js";
import { EnvironmentSwitcher } from "../EnvironmentSwitcher.js";
import { resolveOrigin, type EndpointSummary } from "../../types.js";
import { api } from "../../api.js";
import { useConfig } from "../../contexts/ConfigContext.js";

interface DetailsTabProps {
  endpoint: EndpointSummary;
  apiOrigin: string;
  environment: EnvironmentDoc | null;
  environments: EnvironmentDoc[];
  activeEnvironmentId: string | null;
  onSelectEnvironment: (id: string | null) => void;
  onManageEnvironments: () => void;
  onTryIt: () => void;
  canEdit: boolean;
}

export function DetailsTab({
  endpoint,
  apiOrigin,
  environment,
  environments,
  activeEnvironmentId,
  onSelectEnvironment,
  onManageEnvironments,
  onTryIt,
  canEdit,
}: DetailsTabProps): JSX.Element {
  const config = useConfig();
  const op = endpoint.operation;
  const scopes = op["x-vayo-scopes"] ?? [];
  const middlewareChain = op["x-vayo-middleware-chain"] ?? [];
  const params = op.parameters ?? [];
  const requestSchema = op.requestBody?.content["application/json"].schema;
  const resolvedOrigin = resolveOrigin(apiOrigin, environment?.variables ?? {});

  const [examples, setExamples] = useState<ExampleDoc[]>([]);

  useEffect(() => {
    api
      .listExamples(config, endpoint.vayoId)
      .then(setExamples)
      .catch(() => setExamples([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint.vayoId]);

  return (
    <div className="details-layout">
      <div className="details-layout__content">
        {op["x-vayo-possibly-removed-since"] && (
          <div className="banner banner--warning">
            The most recent scan of your API didn't find this route anymore (as of{" "}
            {new Date(op["x-vayo-possibly-removed-since"]).toLocaleString()}). If it's genuinely gone, you can now
            delete it from the sidebar — right-click it and choose Delete. If it's still there, re-run{" "}
            <code>vayo scan</code> to clear this.
          </div>
        )}
        <CopyField label="RELATIVE PATH" value={endpoint.path} />

        <div className="field details-full-path__header">
          <span>FULL PATH — resolved from the active environment, like Swagger's server picker</span>
          <EnvironmentSwitcher
            environments={environments}
            activeEnvironmentId={activeEnvironmentId}
            onSelect={onSelectEnvironment}
            onManage={onManageEnvironments}
          />
        </div>
        {resolvedOrigin ? (
          <CopyField label=" " value={`${resolvedOrigin}${endpoint.path}`} />
        ) : (
          <div className="details-full-path__empty">
            <p className="muted">
              {environment
                ? `The "${environment.name}" environment doesn't define a baseUrl variable yet.`
                : "No environment selected, so there's no base URL to resolve against."}
            </p>
            <button type="button" className="link-button" onClick={onManageEnvironments}>
              {environment ? "Add baseUrl to this environment →" : "Create or choose an environment →"}
            </button>
          </div>
        )}

        <EndpointNotes vayoId={endpoint.vayoId} notes={op["x-vayo-notes"] ?? null} config={config} canEdit={canEdit} />

        {(op["x-vayo-auth-required"] || scopes.length > 0) && (
          <section className="detail-section">
            <h3>Scopes</h3>
            {scopes.length > 0 ? (
              <div className="tag-row">
                {scopes.map((scope) => (
                  <span key={scope} className="scope-tag">
                    {scope.toUpperCase()}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted">Requires authentication — no specific scopes detected yet.</p>
            )}
          </section>
        )}

        {middlewareChain.length > 0 && (
          <section className="detail-section">
            <h3>Middleware</h3>
            <div className="tag-row">
              {middlewareChain.map((name) => (
                <span key={name} className="middleware-tag">
                  {name}
                </span>
              ))}
            </div>
          </section>
        )}

        {params.length > 0 && (
          <section className="detail-section">
            <h3>Parameters</h3>
            <div className="param-list">
              {params.map((param) => (
                <div key={param.name} className="param-row">
                  <span className="param-row__name">{param.name}</span>
                  <span className="param-row__in">{param.in}</span>
                  <span className="param-row__type">{(param.schema?.type as string) ?? "string"}</span>
                  {param.required && <span className="badge badge--required">required</span>}
                </div>
              ))}
            </div>
          </section>
        )}

        {requestSchema && (
          <section className="detail-section">
            <h3>
              Request Body
              {op["x-vayo-request-schema-source"] === "inferred" && (
                <span
                  className="badge badge--inferred"
                  title="Guessed from a Mongoose model's stored-document shape, not yet confirmed against real request traffic — may include fields this route doesn't actually require, or miss ones it does."
                >
                  Inferred, unconfirmed
                </span>
              )}
            </h3>
            <SchemaField
              name="body"
              schema={requestSchema}
              schemaPath="requestSchema"
              vayoId={endpoint.vayoId}
              config={config}
              canEdit={canEdit}
            />
          </section>
        )}
      </div>

      <aside className="details-layout__side">
        <CodeSamplePanel endpoint={endpoint} apiOrigin={resolvedOrigin} examples={examples} onTryIt={onTryIt} />
        <ResponseSamplePanel endpoint={endpoint} examples={examples} config={config} canEdit={canEdit} />
      </aside>
    </div>
  );
}
