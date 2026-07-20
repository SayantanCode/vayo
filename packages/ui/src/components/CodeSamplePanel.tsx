// @vayo/ui — Details tab's sticky right-column code sample block
// (Redoc/Scalar/Stripe three-pane convention). Read-only: the "Try it →"
// button switches to the existing Try It Now tab rather than sending a
// live request itself, so exactly one place owns request-sending logic.

import { useState } from "react";
import { ArrowRight, Check, Copy } from "lucide-react";
import type { ExampleDoc } from "@vayo/types";
import type { EndpointSummary } from "../types.js";
import { exampleFromSchema } from "../example-from-schema.js";
import { SNIPPET_LANGUAGES } from "../request-snippets.js";

interface CodeSamplePanelProps {
  endpoint: EndpointSummary;
  apiOrigin: string;
  examples: ExampleDoc[];
  onTryIt: () => void;
}

const BODY_LESS_METHODS = new Set(["GET", "DELETE"]);

function mostRecentOrPinned(examples: ExampleDoc[]): ExampleDoc | null {
  if (examples.length === 0) return null;
  const pinned = examples.find((e) => e.pinned);
  if (pinned) return pinned;
  const sorted = [...examples].sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
  return sorted[0] ?? null;
}

const DEFAULT_LANGUAGE = SNIPPET_LANGUAGES[0]!;

export function CodeSamplePanel({ endpoint, apiOrigin, examples, onTryIt }: CodeSamplePanelProps): JSX.Element {
  const [languageId, setLanguageId] = useState(DEFAULT_LANGUAGE.id);
  const [copied, setCopied] = useState(false);
  const op = endpoint.operation;
  const hasBody = Boolean(op.requestBody) && !BODY_LESS_METHODS.has(endpoint.method);
  const requestSchema = op.requestBody?.content["application/json"].schema;

  const successExample = mostRecentOrPinned(examples.filter((e) => e.statusCode >= 200 && e.statusCode < 300));
  const bodyValue = hasBody ? JSON.stringify(successExample?.requestBody ?? exampleFromSchema(requestSchema), null, 2) : undefined;

  const queryParams = (op.parameters ?? []).filter((p) => p.in === "query");
  const queryString = queryParams.map((p) => `${p.name}={${p.name}}`).join("&");
  const url = `${apiOrigin || "https://api.example.com"}${endpoint.path}${queryString ? `?${queryString}` : ""}`;
  const headers: Record<string, string> = {};
  if (hasBody) headers["Content-Type"] = "application/json";
  if (op["x-vayo-auth-required"]) headers.Authorization = "Bearer YOUR_TOKEN";

  const language = SNIPPET_LANGUAGES.find((l) => l.id === languageId) ?? DEFAULT_LANGUAGE;
  const snippet = language.build(endpoint.method, url, headers, bodyValue);

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable (e.g. insecure context) — silently no-op
    }
  }

  return (
    <div className="code-sample-panel">
      <div className="code-sample-panel__header">
        <span className={`method-badge method-badge--${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
        <span className="code-sample-panel__path">{endpoint.path}</span>
      </div>
      <div className="try-it__subtabs code-sample-panel__tabs">
        {SNIPPET_LANGUAGES.map((lang) => (
          <button
            key={lang.id}
            type="button"
            className={`try-it__subtab ${lang.id === languageId ? "try-it__subtab--active" : ""}`}
            onClick={() => {
              setLanguageId(lang.id);
              setCopied(false);
            }}
          >
            {lang.label}
          </button>
        ))}
      </div>
      <div className="code-sample-panel__code-wrap">
        <pre className="code-sample-panel__code">{snippet}</pre>
        <button
          type="button"
          className={`code-sample-panel__copy ${copied ? "code-sample-panel__copy--copied" : ""}`}
          onClick={copySnippet}
        >
          {copied ? (
            <>
              <Check size={12} /> Copied
            </>
          ) : (
            <>
              <Copy size={12} /> Copy
            </>
          )}
        </button>
      </div>
      <button type="button" className="code-sample-panel__try-it" onClick={onTryIt}>
        Send a real request in the Try It Now tab <ArrowRight size={14} />
      </button>
    </div>
  );
}
