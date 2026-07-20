// @vayo/ui — Flowmap: this endpoint's middleware chain (unchanged from v1 —
// docs/04-capture-engine.md §4) PLUS which saved Flows (FlowsModal.tsx) it
// participates in. Cross-endpoint journeys were deliberately deferred past
// v1 as a from-scratch feature — but Flows already model exactly that
// ("signup, then fetch profile") for the Try It Now runner, so this reuses
// that data instead of inventing a second, inference-based notion of "these
// endpoints are related."

import type { FlowDoc } from "@vayo/types";
import type { EndpointSummary } from "../../types.js";

interface FlowmapTabProps {
  vayoId: string;
  middlewareChain: string[];
  flows: FlowDoc[];
  endpoints: EndpointSummary[];
  canEdit: boolean;
  onOpenFlow: (flowId: string) => void;
  onOpenFlowsPanel: () => void;
}

function endpointLabel(stepVayoId: string, endpoints: EndpointSummary[]): { method: string; path: string } {
  const found = endpoints.find((e) => e.vayoId === stepVayoId);
  return { method: found?.method ?? "?", path: found?.path ?? stepVayoId };
}

function FlowSequence({
  flow,
  currentVayoId,
  endpoints,
  onOpen,
}: {
  flow: FlowDoc;
  currentVayoId: string;
  endpoints: EndpointSummary[];
  onOpen: () => void;
}): JSX.Element {
  return (
    <div className="flowmap__flow">
      <div className="flowmap__flow-header">
        <span className="flowmap__flow-name">{flow.name}</span>
        <button type="button" className="link-button" onClick={onOpen}>
          Open in Flows →
        </button>
      </div>
      <div className="flowmap">
        {flow.steps.map((step, index) => {
          const { method, path } = endpointLabel(step.vayoId, endpoints);
          const isCurrent = step.vayoId === currentVayoId;
          return (
            <div key={`${step.vayoId}-${index}`} className="flowmap__step-wrapper">
              <div className={`flowmap__step flowmap__step--flow ${isCurrent ? "flowmap__step--current" : ""}`}>
                <span className={`method-badge method-badge--${method.toLowerCase()}`}>{method}</span> {path}
              </div>
              {index < flow.steps.length - 1 && <div className="flowmap__arrow">→</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function FlowmapTab({
  vayoId,
  middlewareChain,
  flows,
  endpoints,
  canEdit,
  onOpenFlow,
  onOpenFlowsPanel,
}: FlowmapTabProps): JSX.Element {
  const memberFlows = flows.filter((flow) => flow.steps.some((step) => step.vayoId === vayoId));
  const steps = ["Client request", ...middlewareChain, "Handler", "Response"];

  return (
    <div className="tab-panel">
      <div>
        <h3 className="flowmap__section-heading">Middleware chain</h3>
        <div className="flowmap">
          {steps.map((step, index) => (
            <div key={`${step}-${index}`} className="flowmap__step-wrapper">
              <div className={`flowmap__step ${index === 0 || index === steps.length - 1 ? "flowmap__step--endpoint" : ""}`}>
                {step}
              </div>
              {index < steps.length - 1 && <div className="flowmap__arrow">→</div>}
            </div>
          ))}
        </div>
        {middlewareChain.length === 0 && (
          <p className="muted">No middleware detected for this route yet — runtime capture and the AST scan both feed this.</p>
        )}
      </div>

      <div>
        <h3 className="flowmap__section-heading">Part of these flows</h3>
        {memberFlows.length === 0 ? (
          <p className="muted">
            This endpoint isn't in any saved Flow yet — Flows are ordered, multi-endpoint sequences (e.g. "sign up, then
            fetch profile") you build in the Flows panel.
            {canEdit && (
              <>
                {" "}
                <button type="button" className="link-button" onClick={onOpenFlowsPanel}>
                  Add it to one →
                </button>
              </>
            )}
          </p>
        ) : (
          <div className="flowmap__flows">
            {memberFlows.map((flow) => (
              <FlowSequence
                key={flow._id}
                flow={flow}
                currentVayoId={vayoId}
                endpoints={endpoints}
                onOpen={() => onOpenFlow(flow._id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
