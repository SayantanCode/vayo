// @vayo/ui — Flows: ordered, related-endpoint sequences (Postman's
// Collection Runner equivalent). Since `FlowStep` only stores `vayoId` +
// `extractVariables` (no per-step body/auth override in the data model),
// each step's request body is built the same way CodeSamplePanel builds
// one — a real captured example if available, else a schema-derived
// fallback — and auth is a simple, stated convention: an auth-required
// endpoint sends `Authorization: Bearer {{authToken}}`, relying on an
// earlier step (or the active environment) having populated `authToken`.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import type { EnvironmentDoc, ExampleDoc, FlowDoc, FlowStep } from "@vayo/types";
import { api } from "../api.js";
import { interpolate, type EndpointSummary } from "../types.js";
import { exampleFromSchema } from "../example-from-schema.js";
import { resolveDotPath } from "../dot-path.js";
import { runScriptInWorker, type ScriptTestResult } from "../script-runner-client.js";
import { Modal } from "./Modal.js";
import { useConfig } from "../contexts/ConfigContext.js";

interface FlowsModalProps {
  version: string;
  apiOrigin: string;
  environment: EnvironmentDoc | null;
  endpoints: EndpointSummary[];
  canEdit: boolean;
  /** Jumps straight to editing this flow once it loads (e.g. Flowmap's
   * "Open in Flows" link) instead of always defaulting to "new". Applied
   * once per mount — this modal is only ever mounted fresh on open
   * (DocsApp renders it behind `{flowsModalOpen && ...}`), so there's no
   * risk of it clobbering the user's own in-modal navigation later. */
  initialFlowId?: string;
  onClose: () => void;
}

interface EditableExtract {
  key: string;
  path: string;
}

interface EditableStep {
  vayoId: string;
  extracts: EditableExtract[];
}

interface StepRunResult {
  vayoId: string;
  status: number;
  timeMs: number;
  extracted: Record<string, unknown>;
  testResults: ScriptTestResult[];
  error?: string;
}

function toEditableSteps(steps: FlowStep[]): EditableStep[] {
  return steps.map((s) => ({
    vayoId: s.vayoId,
    extracts: Object.entries(s.extractVariables ?? {}).map(([key, path]) => ({ key, path })),
  }));
}

function toFlowSteps(steps: EditableStep[]): FlowStep[] {
  return steps.map((s) => {
    const extractVariables: Record<string, string> = {};
    for (const e of s.extracts) {
      if (e.key.trim()) extractVariables[e.key.trim()] = e.path;
    }
    return { vayoId: s.vayoId, extractVariables: Object.keys(extractVariables).length > 0 ? extractVariables : undefined };
  });
}

function mostRecentOrPinnedExample(examples: ExampleDoc[]): ExampleDoc | null {
  const successOnly = examples.filter((e) => e.statusCode >= 200 && e.statusCode < 300);
  const pool = successOnly.length > 0 ? successOnly : examples;
  if (pool.length === 0) return null;
  const pinned = pool.find((e) => e.pinned);
  if (pinned) return pinned;
  const sorted = [...pool].sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
  return sorted[0] ?? null;
}

export function FlowsModal({
  version,
  apiOrigin,
  environment,
  endpoints,
  canEdit,
  initialFlowId,
  onClose,
}: FlowsModalProps): JSX.Element {
  const config = useConfig();
  const [flows, setFlows] = useState<FlowDoc[]>([]);
  const [selectedId, setSelectedId] = useState<string | "new">("new");
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<EditableStep[]>([]);
  const [endpointFilter, setEndpointFilter] = useState("");
  const [running, setRunning] = useState(false);
  const [runResults, setRunResults] = useState<StepRunResult[] | null>(null);
  const didApplyInitialFlowId = useRef(false);

  useEffect(() => {
    api.listFlows(config, version).then(setFlows).catch(() => setFlows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  function select(id: string | "new") {
    setSelectedId(id);
    setRunResults(null);
    const flow = id !== "new" ? flows.find((f) => f._id === id) : null;
    setName(flow?.name ?? "");
    setSteps(flow ? toEditableSteps(flow.steps) : []);
  }

  useEffect(() => {
    if (didApplyInitialFlowId.current || !initialFlowId) return;
    const flow = flows.find((f) => f._id === initialFlowId);
    if (flow) {
      didApplyInitialFlowId.current = true;
      select(initialFlowId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flows, initialFlowId]);

  const selected = selectedId !== "new" ? (flows.find((f) => f._id === selectedId) ?? null) : null;

  async function refetchFlows() {
    const list = await api.listFlows(config, version);
    setFlows(list);
    return list;
  }

  async function saveFlow() {
    const flowSteps = toFlowSteps(steps);
    if (selectedId === "new") {
      const created = await api.createFlow(config, name.trim() || "New flow", version, flowSteps);
      await refetchFlows();
      setSelectedId(created._id);
    } else if (selected) {
      await api.updateFlow(config, selected._id, { name: name.trim() || selected.name, steps: flowSteps });
      await refetchFlows();
    }
  }

  async function deleteFlow(id: string) {
    await api.deleteFlow(config, id);
    await refetchFlows();
    select("new");
  }

  function addStep(vayoId: string) {
    setSteps((prev) => [...prev, { vayoId, extracts: [] }]);
    setEndpointFilter("");
  }

  function removeStep(index: number) {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }

  function moveStep(index: number, direction: -1 | 1) {
    setSteps((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  }

  function updateExtracts(stepIndex: number, extracts: EditableExtract[]) {
    setSteps((prev) => prev.map((s, i) => (i === stepIndex ? { ...s, extracts } : s)));
  }

  async function runFlow() {
    setRunning(true);
    setRunResults(null);
    const results: StepRunResult[] = [];
    let variables = { ...(environment?.variables ?? {}) };

    for (const step of steps) {
      const endpoint = endpoints.find((e) => e.vayoId === step.vayoId);
      if (!endpoint) {
        results.push({ vayoId: step.vayoId, status: 0, timeMs: 0, extracted: {}, testResults: [], error: "Endpoint no longer exists" });
        continue;
      }

      const op = endpoint.operation;
      const hasBody = Boolean(op.requestBody) && !["GET", "HEAD", "DELETE"].includes(endpoint.method);
      let bodyText: string | undefined;
      if (hasBody) {
        try {
          const examples = await api.listExamples(config, endpoint.vayoId);
          const example = mostRecentOrPinnedExample(examples);
          const requestSchema = op.requestBody?.content["application/json"].schema;
          bodyText = JSON.stringify(example?.requestBody ?? exampleFromSchema(requestSchema));
        } catch {
          bodyText = "{}";
        }
      }

      const headers: Record<string, string> = {};
      if (hasBody) headers["Content-Type"] = "application/json";
      if (op["x-vayo-auth-required"] && variables.authToken) {
        headers.Authorization = `Bearer ${interpolate(variables.authToken, variables)}`;
      }

      const url = `${interpolate(apiOrigin, variables)}${endpoint.path}`;
      const startedAt = performance.now();
      let status = 0;
      let responseBody: unknown = null;
      let responseHeaders: Record<string, string> = {};
      let requestError: string | undefined;

      try {
        const res = await fetch(url, {
          method: endpoint.method,
          headers,
          body: hasBody && bodyText ? interpolate(bodyText, variables) : undefined,
        });
        status = res.status;
        const text = await res.text();
        responseHeaders = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        try {
          responseBody = JSON.parse(text);
        } catch {
          responseBody = text;
        }
      } catch (err) {
        requestError = err instanceof Error ? err.message : "Network error";
      }

      const timeMs = Math.round(performance.now() - startedAt);
      const requestForContext = { method: endpoint.method, url, headers, body: bodyText ?? null };
      const responseForContext = requestError ? null : { status, headers: responseHeaders, body: responseBody };

      const extracted: Record<string, unknown> = {};
      if (!requestError) {
        for (const e of step.extracts) {
          if (!e.key.trim()) continue;
          const value = resolveDotPath({ request: requestForContext, response: responseForContext }, e.path);
          extracted[e.key.trim()] = value;
          variables = { ...variables, [e.key.trim()]: String(value ?? "") };
        }
      }

      let testResults: ScriptTestResult[] = [];
      if (!requestError) {
        try {
          const scriptDoc = await api.getTestScript(config, endpoint.vayoId);
          if (scriptDoc.testScript.trim()) {
            const testRun = await runScriptInWorker(scriptDoc.testScript, {
              request: requestForContext,
              response: responseForContext,
              variables,
            });
            testResults = testRun.results;
            variables = { ...variables, ...testRun.variables };
          }
        } catch {
          // no saved test script or it failed to load — not fatal to the flow run
        }
      }

      results.push({ vayoId: step.vayoId, status, timeMs, extracted, testResults, error: requestError });
    }

    setRunResults(results);
    setRunning(false);
  }

  const filteredEndpoints = endpointFilter.trim()
    ? endpoints.filter(
        (e) =>
          e.path.toLowerCase().includes(endpointFilter.toLowerCase()) ||
          (e.summary ?? "").toLowerCase().includes(endpointFilter.toLowerCase()),
      )
    : endpoints;

  return (
    <Modal onClose={onClose} className="flows-modal">
      <h3>Flows</h3>
        <div className="flows-modal__body">
          <div className="flows-modal__list modal__list">
            {flows.map((flow) => (
              <button
                key={flow._id}
                type="button"
                className={`modal__option ${selectedId === flow._id ? "modal__option--current" : ""}`}
                onClick={() => select(flow._id)}
              >
                {flow.name}
              </button>
            ))}
            <button
              type="button"
              className={`modal__option ${selectedId === "new" ? "modal__option--current" : ""}`}
              onClick={() => select("new")}
            >
              + New flow
            </button>
          </div>

          <div className="flows-modal__editor">
            <label className="field">
              <span>Name</span>
              <input
                name="flowName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Signup then fetch profile"
                disabled={!canEdit}
              />
            </label>

            <div className="flows-modal__steps">
              <span className="flows-modal__steps-label">Steps</span>
              {steps.length === 0 && <p className="muted">No steps yet — add an endpoint below.</p>}
              {steps.map((step, i) => {
                const endpoint = endpoints.find((e) => e.vayoId === step.vayoId);
                const stepResult = runResults?.[i];
                return (
                  <div key={i} className="flows-modal__step">
                    <div className="flows-modal__step-row">
                      <span className={`method-badge method-badge--${(endpoint?.method ?? "get").toLowerCase()}`}>
                        {endpoint?.method ?? "?"}
                      </span>
                      <span className="flows-modal__step-path">{endpoint?.path ?? step.vayoId}</span>
                      {canEdit && (
                        <>
                          <button type="button" className="icon-button" onClick={() => moveStep(i, -1)}>
                            <ChevronUp size={14} />
                          </button>
                          <button type="button" className="icon-button" onClick={() => moveStep(i, 1)}>
                            <ChevronDown size={14} />
                          </button>
                          <button type="button" className="icon-button" onClick={() => removeStep(i)}>
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>

                    <div className="flows-modal__extracts">
                      {step.extracts.map((extract, ei) => (
                        <div className="try-it__row" key={ei}>
                          <input
                            placeholder="variable name"
                            value={extract.key}
                            disabled={!canEdit}
                            onChange={(e) =>
                              updateExtracts(
                                i,
                                step.extracts.map((ex, idx) => (idx === ei ? { ...ex, key: e.target.value } : ex)),
                              )
                            }
                          />
                          <input
                            placeholder="response.body.token"
                            value={extract.path}
                            disabled={!canEdit}
                            onChange={(e) =>
                              updateExtracts(
                                i,
                                step.extracts.map((ex, idx) => (idx === ei ? { ...ex, path: e.target.value } : ex)),
                              )
                            }
                          />
                          {canEdit && (
                            <button
                              type="button"
                              className="icon-button"
                              onClick={() => updateExtracts(i, step.extracts.filter((_, idx) => idx !== ei))}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      ))}
                      {canEdit && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => updateExtracts(i, [...step.extracts, { key: "", path: "" }])}
                        >
                          + Extract a variable
                        </button>
                      )}
                    </div>

                    {stepResult && (
                      <div className="flows-modal__step-result">
                        {stepResult.error ? (
                          <span className="try-it__status-badge error">{stepResult.error}</span>
                        ) : (
                          <>
                            <span className={`try-it__status-badge ${stepResult.status < 300 ? "ok" : "error"}`}>{stepResult.status}</span>
                            <span className="muted">{stepResult.timeMs} ms</span>
                            {stepResult.testResults.length > 0 && (
                              <span className="muted">
                                {stepResult.testResults.filter((r) => r.passed).length}/{stepResult.testResults.length} tests passed
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {canEdit && (
              <div className="flows-modal__add-step">
                <input
                  placeholder="Filter endpoints to add…"
                  value={endpointFilter}
                  onChange={(e) => setEndpointFilter(e.target.value)}
                />
                <div className="flows-modal__endpoint-picker">
                  {filteredEndpoints.slice(0, 8).map((e) => (
                    <button key={e.vayoId} type="button" className="modal__option" onClick={() => addStep(e.vayoId)}>
                      <span className={`method-badge method-badge--${e.method.toLowerCase()}`}>{e.method}</span> {e.path}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="modal__actions">
          {selected && canEdit && (
            <button type="button" className="button" onClick={() => deleteFlow(selected._id)}>
              Delete
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
          {canEdit && (
            <button type="button" className="button" onClick={saveFlow}>
              Save Flow
            </button>
          )}
          <button type="button" className="button button--primary" onClick={runFlow} disabled={running || steps.length === 0}>
            {running ? "Running…" : "Run Flow"}
          </button>
        </div>
    </Modal>
  );
}
