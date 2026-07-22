// @vayo/ui — "Try It Now": a proper request/response REST client panel
// (Postman-parity redesign). Talks to two different backends: the
// *target* API being documented (`apiOrigin`, plain `fetch`, no auth of
// ours involved) and Vayo's own server (`config`, via `api.ts`) for
// saved/pinned responses and test scripts. Pre-request/test scripts run
// automatically on every Send, matching real Postman behavior — see
// `script-runner-client.ts` for the sandboxed execution itself.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Copy, Search, Trash2, X } from "lucide-react";
import type { EnvironmentDoc, ExampleDoc } from "@vayo/types";
import { api } from "../../api.js";
import { interpolate, type EndpointSummary } from "../../types.js";
import { runScriptInWorker, type ScriptTestResult } from "../../script-runner-client.js";
import { ScriptsPanel } from "../ScriptsPanel.js";
import { VariableField, type FieldSuggestion, type FieldValidity } from "../VariableField.js";
import { exampleFromSchema } from "../../example-from-schema.js";
import { useConfig } from "../../contexts/ConfigContext.js";
import {
  authModeFromDetected,
  BODY_MODE_LABELS,
  COMMONLY_BODYLESS_METHODS,
  detectFormat,
  extractPathname,
  FETCH_BODYLESS_METHODS,
  findMatches,
  FORMAT_LABELS,
  formatBytes,
  HighlightedText,
  isBinaryContentType,
  LARGE_RESPONSE_THRESHOLD,
  mostRecentOrPinned,
  parseForTable,
  pathSegmentsMatch,
  prettyPrintBody,
  ResponseTableView,
  type AuthMode,
  type BodyMode,
  type ResponseViewMode,
} from "./try-it-now-utils.js";

interface TryItNowTabProps {
  endpoint: EndpointSummary;
  apiOrigin: string;
  environment: EnvironmentDoc | null;
  onAddEnvironmentVariable?: (name: string, value: string) => Promise<void>;
  /** Every endpoint in the workspace (not just this one) — powers the URL
   * bar's "does this path exist" check and its endpoint-suggestion
   * dropdown, both of which need to see the full captured API surface. */
  allEndpoints: EndpointSummary[];
  /** Jumps to a different endpoint (from a URL-bar suggestion) while
   * staying on this tab — unlike normal sidebar navigation, which lands on
   * Details, picking a suggestion *from* Try It Now should keep testing. */
  onNavigateToEndpoint: (vayoId: string) => void;
  canEdit: boolean;
}

interface HeaderRow {
  key: string;
  value: string;
}

interface FormDataRow {
  key: string;
  type: "text" | "file";
  value: string;
  file: File | null;
  enabled: boolean;
}

interface UrlEncodedRow {
  key: string;
  value: string;
  enabled: boolean;
}

interface RequestResult {
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string>;
  timeMs: number;
  sizeBytes: number;
  /** True for binary bodies (images, PDFs, archives, ...) — `body` is empty
   * and `blobUrl` holds the data instead. fetch() has no "give me raw bytes
   * only if binary" mode, so we branch on Content-Type before choosing
   * res.text() vs res.blob(), matching what Postman's desktop client does
   * with full HTTP access (a browser tab can't peek at bytes without
   * committing to one or the other). */
  isBinary: boolean;
  contentType: string | null;
  blobUrl: string | null;
}

type SubTab = "params" | "headers" | "body" | "auth" | "scripts";
type ResponseSubTab = "body" | "headers";

export function TryItNowTab({
  endpoint,
  apiOrigin,
  environment,
  onAddEnvironmentVariable,
  allEndpoints,
  onNavigateToEndpoint,
  canEdit,
}: TryItNowTabProps): JSX.Element {
  const config = useConfig();
  const op = endpoint.operation;
  const params = op.parameters ?? [];
  const hasCapturedBodySchema = Boolean(op.requestBody);

  const [subTab, setSubTab] = useState<SubTab>(params.length > 0 ? "params" : hasCapturedBodySchema ? "body" : "auth");
  // The whole request line — origin *and* path, together, fully editable
  // (not split into an editable origin + a fixed path) — matching a real
  // request-builder URL bar. Reset to a fresh `${apiOrigin}${endpoint.path}`
  // whenever the endpoint changes; free-typed after that.
  const [urlText, setUrlText] = useState(() => `${apiOrigin}${endpoint.path}`);

  const [bodyMode, setBodyMode] = useState<BodyMode>(
    hasCapturedBodySchema && !COMMONLY_BODYLESS_METHODS.has(endpoint.method) ? "raw" : "none",
  );
  const [bodyText, setBodyText] = useState("{}");
  const [formDataRows, setFormDataRows] = useState<FormDataRow[]>([{ key: "", type: "text", value: "", file: null, enabled: true }]);
  const [urlEncodedRows, setUrlEncodedRows] = useState<UrlEncodedRow[]>([{ key: "", value: "", enabled: true }]);

  const [authMode, setAuthMode] = useState<AuthMode>(() => authModeFromDetected(op["x-vayo-auth-type"]));
  const [bearerToken, setBearerToken] = useState("");
  const [basicUsername, setBasicUsername] = useState("");
  const [basicPassword, setBasicPassword] = useState("");
  const [apiKeyName, setApiKeyName] = useState("X-API-Key");
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [apiKeyLocation, setApiKeyLocation] = useState<"header" | "query">("header");

  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([{ key: "", value: "" }]);
  const [result, setResult] = useState<RequestResult | null>(null);
  const [responseSubTab, setResponseSubTab] = useState<ResponseSubTab>("body");
  const [responseViewMode, setResponseViewMode] = useState<ResponseViewMode>("pretty");
  const [forceFullRender, setForceFullRender] = useState(false);
  const [responseBodyCopied, setResponseBodyCopied] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const activeMatchRef = useRef<HTMLElement | null>(null);
  const previousBlobUrlRef = useRef<string | null>(null);
  const [urlCopied, setUrlCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [saveLabel, setSaveLabel] = useState("");
  const [savedExamples, setSavedExamples] = useState<ExampleDoc[]>([]);
  const [viewingExample, setViewingExample] = useState<ExampleDoc | null>(null);

  const [preRequestScript, setPreRequestScript] = useState("");
  const [testScript, setTestScript] = useState("");
  const [testResults, setTestResults] = useState<ScriptTestResult[] | null>(null);
  const [runtimeOverlay, setRuntimeOverlay] = useState<Record<string, string>>({});

  const variables = { ...(environment?.variables ?? {}), ...runtimeOverlay };
  const environmentName = environment?.name ?? null;
  const onAddVariable = onAddEnvironmentVariable ?? null;

  useEffect(() => {
    setResult(null);
    setViewingExample(null);
    setResponseViewMode("pretty");
    setForceFullRender(false);
    setUrlText(`${apiOrigin}${endpoint.path}`);
    setSearchOpen(false);
    setSearchQuery("");

    // Prefill test data up front, schema-derived — matches Swagger UI's
    // "Try it out" always having *something* to send. Upgraded to a real
    // captured/pinned example below once fetched, if one exists.
    const requestSchema = op.requestBody?.content["application/json"]?.schema;
    if (hasCapturedBodySchema) {
      setBodyText(JSON.stringify(exampleFromSchema(requestSchema), null, 2));
    }
    const paramDefaults: Record<string, string> = {};
    for (const param of params) {
      const example = exampleFromSchema(param.schema);
      if (example !== null && example !== undefined) paramDefaults[param.name] = String(example);
    }
    setParamValues(paramDefaults);

    api
      .listExamples(config, endpoint.vayoId)
      .then((examples) => {
        const pinned = examples.filter((e) => e.pinned);
        setSavedExamples(pinned);
        if (hasCapturedBodySchema) {
          const successExample = mostRecentOrPinned(pinned.filter((e) => e.statusCode >= 200 && e.statusCode < 300));
          if (successExample) setBodyText(JSON.stringify(successExample.requestBody, null, 2));
        }
      })
      .catch(() => setSavedExamples([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint.vayoId]);

  // Object URLs for binary responses aren't garbage-collected on their own —
  // release the last one when this panel goes away entirely (per-request
  // replacement is handled inline in send() itself, right before the new
  // one is created).
  useEffect(() => {
    return () => {
      if (previousBlobUrlRef.current) URL.revokeObjectURL(previousBlobUrlRef.current);
    };
  }, []);

  useEffect(() => {
    activeMatchRef.current?.scrollIntoView({ block: "nearest" });
  }, [searchActiveIndex, searchQuery]);

  useEffect(() => {
    setRuntimeOverlay({});
    setTestResults(null);
    api
      .getTestScript(config, endpoint.vayoId)
      .then((doc) => {
        setPreRequestScript(doc.preRequestScript);
        setTestScript(doc.testScript);
      })
      .catch(() => {
        setPreRequestScript("");
        setTestScript("");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint.vayoId]);

  /** Substitutes `{param}` placeholders wherever they appear in the
   * freely-edited `urlText` (not just in the endpoint's originally captured
   * path — the user may have rewritten the whole thing), then resolves
   * any `{{variable}}` tokens. This *is* the origin+path base, together. */
  function resolvedUrlBase(vars: Record<string, string>): string {
    let text = urlText;
    for (const param of params) {
      if (param.in !== "path") continue;
      const raw = paramValues[param.name] ?? `{${param.name}}`;
      text = text.replace(`{${param.name}}`, encodeURIComponent(interpolate(raw, vars)));
    }
    return interpolate(text, vars);
  }

  /** Query params are optional by nature (unlike path params, which are
   * always substituted) — only ones the user actually filled in get sent,
   * so an empty "page" field doesn't turn into a literal `?page=` on the
   * request. */
  function resolvedParamQueryString(vars: Record<string, string>): URLSearchParams {
    const search = new URLSearchParams();
    for (const param of params) {
      if (param.in !== "query") continue;
      const raw = paramValues[param.name];
      if (!raw) continue;
      search.set(param.name, interpolate(raw, vars));
    }
    return search;
  }

  function resolvedAuth(vars: Record<string, string>): { header: [string, string] | null; queryParam: [string, string] | null } {
    switch (authMode) {
      case "none":
        return { header: null, queryParam: null };
      case "bearer":
        return bearerToken
          ? { header: ["Authorization", `Bearer ${interpolate(bearerToken, vars)}`], queryParam: null }
          : { header: null, queryParam: null };
      case "basic":
        return basicUsername || basicPassword
          ? {
              header: ["Authorization", `Basic ${btoa(`${interpolate(basicUsername, vars)}:${interpolate(basicPassword, vars)}`)}`],
              queryParam: null,
            }
          : { header: null, queryParam: null };
      case "apiKey": {
        if (!apiKeyValue) return { header: null, queryParam: null };
        const name = apiKeyName.trim() || "X-API-Key";
        const value = interpolate(apiKeyValue, vars);
        return apiKeyLocation === "header" ? { header: [name, value], queryParam: null } : { header: null, queryParam: [name, value] };
      }
    }
  }

  function resolvedUrl(vars: Record<string, string>): string {
    const base = resolvedUrlBase(vars);
    const search = resolvedParamQueryString(vars);
    const { queryParam } = resolvedAuth(vars);
    if (queryParam) search.set(queryParam[0], queryParam[1]);
    const qs = search.toString();
    return qs ? `${base}?${qs}` : base;
  }

  /** A one-click copy of the full resolved URL — handy generally, and
   * doubles as a reliable way to grab the whole thing when you just want
   * to paste it somewhere, since drag-selecting inside a CodeMirror field
   * can behave oddly right at its edges. */
  async function copyResolvedUrl() {
    try {
      await navigator.clipboard.writeText(resolvedUrl(variables));
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 1500);
    } catch {
      // clipboard API unavailable — silently no-op
    }
  }

  function resolvedContentType(): string | null {
    switch (bodyMode) {
      case "none":
        return null;
      case "raw":
        return "application/json";
      case "form-data":
        return null; // the browser computes the multipart boundary itself — never set this manually
      case "urlencoded":
        return "application/x-www-form-urlencoded";
    }
  }

  function resolvedBody(vars: Record<string, string>): BodyInit | undefined {
    switch (bodyMode) {
      case "none":
        return undefined;
      case "raw":
        return interpolate(bodyText, vars);
      case "form-data": {
        const formData = new FormData();
        for (const row of formDataRows) {
          if (!row.enabled || !row.key.trim()) continue;
          if (row.type === "file") {
            if (row.file) formData.append(row.key, row.file, row.file.name);
          } else {
            formData.append(row.key, interpolate(row.value, vars));
          }
        }
        return formData;
      }
      case "urlencoded": {
        const search = new URLSearchParams();
        for (const row of urlEncodedRows) {
          if (!row.enabled || !row.key.trim()) continue;
          search.append(row.key, interpolate(row.value, vars));
        }
        return search;
      }
    }
  }

  function computeAutoHeaders(vars: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {};
    const contentType = resolvedContentType();
    if (contentType) headers["Content-Type"] = contentType;
    const { header } = resolvedAuth(vars);
    if (header) headers[header[0]] = header[1];
    return headers;
  }

  function resolvedHeaders(vars: Record<string, string>): Record<string, string> {
    const headers = computeAutoHeaders(vars);
    for (const row of headerRows) {
      if (row.key.trim()) headers[row.key.trim()] = interpolate(row.value, vars);
    }
    return headers;
  }

  function updateFormDataRow(index: number, patch: Partial<FormDataRow>) {
    setFormDataRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function updateUrlEncodedRow(index: number, patch: Partial<UrlEncodedRow>) {
    setUrlEncodedRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function saveScripts() {
    await api.saveTestScript(config, endpoint.vayoId, preRequestScript, testScript);
  }

  async function send() {
    setSending(true);
    setResult(null);
    setViewingExample(null);
    setTestResults(null);
    try {
      let effectiveVariables = variables;
      const allResults: ScriptTestResult[] = [];

      if (preRequestScript.trim()) {
        try {
          const preRun = await runScriptInWorker(preRequestScript, {
            request: {
              method: endpoint.method,
              url: resolvedUrl(effectiveVariables),
              headers: resolvedHeaders(effectiveVariables),
              body: bodyMode === "raw" ? interpolate(bodyText, effectiveVariables) : null,
            },
            response: null,
            variables: effectiveVariables,
          });
          effectiveVariables = { ...effectiveVariables, ...preRun.variables };
          setRuntimeOverlay((prev) => ({ ...prev, ...preRun.variables }));
          allResults.push(...preRun.results);
        } catch (err) {
          allResults.push({ name: "Pre-request script", passed: false, error: err instanceof Error ? err.message : "Script failed" });
        }
      }

      const url = resolvedUrl(effectiveVariables);
      const headers = resolvedHeaders(effectiveVariables);
      const body = FETCH_BODYLESS_METHODS.has(endpoint.method) ? undefined : resolvedBody(effectiveVariables);
      const startedAt = performance.now();
      let requestResult: RequestResult;
      try {
        const res = await fetch(url, { method: endpoint.method, headers, body });
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        const contentType = res.headers.get("content-type");
        const binary = isBinaryContentType(contentType);
        if (binary) {
          const blob = await res.blob();
          if (previousBlobUrlRef.current) URL.revokeObjectURL(previousBlobUrlRef.current);
          const blobUrl = URL.createObjectURL(blob);
          previousBlobUrlRef.current = blobUrl;
          requestResult = {
            status: res.status,
            statusText: res.statusText,
            body: "",
            headers: responseHeaders,
            timeMs: Math.round(performance.now() - startedAt),
            sizeBytes: blob.size,
            isBinary: true,
            contentType,
            blobUrl,
          };
        } else {
          const text = await res.text();
          requestResult = {
            status: res.status,
            statusText: res.statusText,
            body: text,
            headers: responseHeaders,
            timeMs: Math.round(performance.now() - startedAt),
            sizeBytes: new TextEncoder().encode(text).length,
            isBinary: false,
            contentType,
            blobUrl: null,
          };
        }
      } catch (err) {
        requestResult = {
          status: 0,
          statusText: "Network error",
          body: err instanceof Error ? err.message : "Request failed",
          headers: {},
          timeMs: Math.round(performance.now() - startedAt),
          sizeBytes: 0,
          isBinary: false,
          contentType: null,
          blobUrl: null,
        };
      }
      setResult(requestResult);
      setForceFullRender(false);
      setSearchOpen(false);
      setSearchQuery("");
      const format = detectFormat(requestResult.body, requestResult.headers, requestResult.isBinary, requestResult.contentType);
      setResponseViewMode(format === "html" || format === "image" || format === "binary" ? "preview" : "pretty");

      if (testScript.trim()) {
        let parsedResponseBody: unknown = requestResult.body;
        try {
          parsedResponseBody = JSON.parse(requestResult.body);
        } catch {
          // keep raw text
        }
        try {
          const testRun = await runScriptInWorker(testScript, {
            request: { method: endpoint.method, url, headers, body: bodyMode === "raw" ? interpolate(bodyText, effectiveVariables) : null },
            response: { status: requestResult.status, headers: requestResult.headers, body: parsedResponseBody },
            variables: effectiveVariables,
          });
          setRuntimeOverlay((prev) => ({ ...prev, ...testRun.variables }));
          allResults.push(...testRun.results);
          const overallStatus: "pass" | "fail" = testRun.results.every((r) => r.passed) ? "pass" : "fail";
          api.recordTestRun(config, endpoint.vayoId, { status: overallStatus, results: testRun.results, at: new Date().toISOString() }).catch(() => {});
        } catch (err) {
          allResults.push({ name: "Test script", passed: false, error: err instanceof Error ? err.message : "Script failed" });
        }
      }

      setTestResults(allResults.length > 0 ? allResults : null);
    } finally {
      setSending(false);
    }
  }

  async function saveResponse() {
    if (!result) return;
    let requestBody: unknown = null;
    if (bodyMode === "raw") {
      try {
        requestBody = JSON.parse(interpolate(bodyText, variables));
      } catch {
        requestBody = interpolate(bodyText, variables);
      }
    } else if (bodyMode === "form-data") {
      const obj: Record<string, unknown> = {};
      for (const row of formDataRows) {
        if (!row.enabled || !row.key.trim()) continue;
        obj[row.key] = row.type === "file" ? `[file: ${row.file?.name ?? "unnamed"}]` : interpolate(row.value, variables);
      }
      requestBody = obj;
    } else if (bodyMode === "urlencoded") {
      const obj: Record<string, unknown> = {};
      for (const row of urlEncodedRows) {
        if (!row.enabled || !row.key.trim()) continue;
        obj[row.key] = interpolate(row.value, variables);
      }
      requestBody = obj;
    }
    let responseBody: unknown = null;
    try {
      responseBody = JSON.parse(result.body);
    } catch {
      responseBody = result.body;
    }
    await api.pinExample(config, endpoint.vayoId, {
      statusCode: result.status,
      requestBody,
      responseBody,
      label: saveLabel.trim() || null,
    });
    setSaveLabel("");
    const examples = await api.listExamples(config, endpoint.vayoId);
    setSavedExamples(examples.filter((e) => e.pinned));
  }

  function viewExample(example: ExampleDoc) {
    setViewingExample(example);
    setForceFullRender(false);
    setSearchOpen(false);
    setSearchQuery("");
    const body = typeof example.responseBody === "string" ? example.responseBody : JSON.stringify(example.responseBody, null, 2);
    const format = detectFormat(body, {}, false, null);
    setResponseViewMode(format === "html" ? "preview" : "pretty");
  }

  async function deleteSaved(id: string) {
    await api.deleteExample(config, id);
    setSavedExamples((prev) => prev.filter((e) => e._id !== id));
    if (viewingExample?._id === id) setViewingExample(null);
  }

  const displayedResult = viewingExample
    ? {
        status: viewingExample.statusCode,
        statusText: "",
        // A saved response's body is a raw string only when it wasn't valid
        // JSON at save time (see saveResponse below) — e.g. an HTML page.
        // Re-stringifying that string would just JSON-escape it, mangling
        // the very HTML the Web view needs to render.
        body:
          typeof viewingExample.responseBody === "string"
            ? viewingExample.responseBody
            : JSON.stringify(viewingExample.responseBody, null, 2),
        headers: {},
        timeMs: 0,
        sizeBytes: 0,
        isBinary: false,
        contentType: null,
        blobUrl: null,
      }
    : result;

  const autoHeaders = computeAutoHeaders(variables);
  const autoHeaderCount = Object.keys(autoHeaders).length;
  const customHeaderCount = headerRows.filter((r) => r.key.trim()).length;
  const totalHeaderCount = autoHeaderCount + customHeaderCount;
  const hasScripts = Boolean(preRequestScript.trim() || testScript.trim());

  const typedPathname = extractPathname(interpolate(urlText, variables));
  const pathExists = allEndpoints.some((e) => pathSegmentsMatch(typedPathname, e.path));
  const urlValidity: FieldValidity | null = typedPathname.length > 0
    ? {
        valid: pathExists,
        warning:
          "No captured endpoint matches this path — you can still send it (e.g. testing a third-party API), just double-check for typos if you meant one of yours.",
      }
    : null;

  const urlSuggestions: FieldSuggestion[] = allEndpoints
    .filter((e) => e.vayoId !== endpoint.vayoId)
    .filter((e) => typedPathname.length === 0 || e.path.toLowerCase().includes(typedPathname.toLowerCase()))
    .slice(0, 8)
    .map((e) => ({
      key: e.vayoId,
      label: (
        <>
          <span className={`method-badge method-badge--${e.method.toLowerCase()}`}>{e.method}</span>
          <span className="variable-field__suggestion-path">{e.path}</span>
        </>
      ),
      onSelect: () => onNavigateToEndpoint(e.vayoId),
    }));

  return (
    <div className="try-it">
      <div className="try-it__url-bar">
        <span className={`method-badge method-badge--lg method-badge--${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
        <VariableField
          name="url"
          value={urlText}
          onChange={setUrlText}
          variables={variables}
          environmentName={environmentName}
          onAddVariable={onAddVariable}
          validity={urlValidity}
          suggestions={urlSuggestions}
          placeholder="https://api.example.com/path"
        />
        <button
          type="button"
          className={`icon-button try-it__url-copy ${urlCopied ? "try-it__url-copy--copied" : ""}`}
          title="Copy resolved URL"
          onClick={copyResolvedUrl}
        >
          {urlCopied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button type="button" className="button button--primary" onClick={send} disabled={sending || !urlText.trim()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>

      <div className="try-it__subtabs">
        <button
          type="button"
          className={`try-it__subtab ${subTab === "params" ? "try-it__subtab--active" : ""}`}
          onClick={() => setSubTab("params")}
        >
          Params{params.length > 0 ? ` (${params.length})` : ""}
        </button>
        <button
          type="button"
          className={`try-it__subtab ${subTab === "headers" ? "try-it__subtab--active" : ""}`}
          onClick={() => setSubTab("headers")}
        >
          Headers{totalHeaderCount > 0 ? ` (${totalHeaderCount})` : ""}
        </button>
        <button
          type="button"
          className={`try-it__subtab ${subTab === "body" ? "try-it__subtab--active" : ""}`}
          onClick={() => setSubTab("body")}
        >
          Body {bodyMode !== "none" && <span className="try-it__subtab-dot" />}
        </button>
        <button
          type="button"
          className={`try-it__subtab ${subTab === "auth" ? "try-it__subtab--active" : ""}`}
          onClick={() => setSubTab("auth")}
        >
          Auth
        </button>
        <button
          type="button"
          className={`try-it__subtab ${subTab === "scripts" ? "try-it__subtab--active" : ""}`}
          onClick={() => setSubTab("scripts")}
        >
          Scripts {hasScripts && <span className="try-it__subtab-dot" />}
        </button>
      </div>

      <div className="try-it__subtab-panel">
        {subTab === "params" &&
          (params.length > 0 ? (
            <div className="try-it__rows">
              {params.map((param) => (
                <div className="try-it__row" key={param.name}>
                  <span className="try-it__row-key">
                    {param.name} <span className="param-row__in">{param.in}</span>
                  </span>
                  <VariableField
                    name={param.name}
                    value={paramValues[param.name] ?? ""}
                    onChange={(v) => setParamValues((prev) => ({ ...prev, [param.name]: v }))}
                    variables={variables}
                    environmentName={environmentName}
                    onAddVariable={onAddVariable}
                    placeholder={param.required ? "required" : "optional"}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No path or query parameters.</p>
          ))}

        {subTab === "headers" && (
          <div className="try-it__rows">
            {Object.entries(autoHeaders).map(([key, value]) => (
              <div className="try-it__row try-it__header-auto-row" key={`auto-${key}`}>
                <span className="try-it__row-key">{key}</span>
                <span className="muted">{value}</span>
                <span className="badge">auto</span>
              </div>
            ))}
            {headerRows.map((row, i) => (
              <div className="try-it__row" key={i}>
                <input
                  name={`headerKey${i}`}
                  placeholder="Header name"
                  value={row.key}
                  onChange={(e) => setHeaderRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, key: e.target.value } : r)))}
                />
                <VariableField
                  name={`headerValue${i}`}
                  placeholder="Value — supports {{variables}}"
                  value={row.value}
                  onChange={(v) => setHeaderRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, value: v } : r)))}
                  variables={variables}
                  environmentName={environmentName}
                  onAddVariable={onAddVariable}
                />
                <button type="button" className="icon-button" onClick={() => setHeaderRows((prev) => prev.filter((_, idx) => idx !== i))}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button type="button" className="button" onClick={() => setHeaderRows((prev) => [...prev, { key: "", value: "" }])}>
              Add header
            </button>
          </div>
        )}

        {subTab === "body" && (
          <div className="try-it__body-panel">
            <div className="try-it__body-mode-row">
              {(Object.keys(BODY_MODE_LABELS) as BodyMode[]).map((mode) => (
                <label key={mode} className="try-it__radio-label">
                  <input type="radio" name="bodyMode" checked={bodyMode === mode} onChange={() => setBodyMode(mode)} />
                  {BODY_MODE_LABELS[mode]}
                </label>
              ))}
            </div>

            {bodyMode === "raw" && (
              <VariableField
                multiline
                name="body"
                className="try-it__body-editor"
                value={bodyText}
                onChange={setBodyText}
                variables={variables}
                environmentName={environmentName}
                onAddVariable={onAddVariable}
                height="220px"
              />
            )}

            {bodyMode === "form-data" && (
              <div className="try-it__rows try-it__form-data-table">
                {formDataRows.map((row, i) => (
                  <div className="try-it__row try-it__form-data-row" key={i}>
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={(e) => updateFormDataRow(i, { enabled: e.target.checked })}
                    />
                    <input
                      name={`formDataKey${i}`}
                      placeholder="Key"
                      value={row.key}
                      onChange={(e) => updateFormDataRow(i, { key: e.target.value })}
                    />
                    <select value={row.type} onChange={(e) => updateFormDataRow(i, { type: e.target.value as "text" | "file" })}>
                      <option value="text">Text</option>
                      <option value="file">File</option>
                    </select>
                    {row.type === "text" ? (
                      <VariableField
                        name={`formDataValue${i}`}
                        placeholder="Value — supports {{variables}}"
                        value={row.value}
                        onChange={(v) => updateFormDataRow(i, { value: v })}
                        variables={variables}
                        environmentName={environmentName}
                        onAddVariable={onAddVariable}
                      />
                    ) : (
                      <input type="file" onChange={(e) => updateFormDataRow(i, { file: e.target.files?.[0] ?? null })} />
                    )}
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => setFormDataRows((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="button"
                  onClick={() => setFormDataRows((prev) => [...prev, { key: "", type: "text", value: "", file: null, enabled: true }])}
                >
                  Add field
                </button>
              </div>
            )}

            {bodyMode === "urlencoded" && (
              <div className="try-it__rows">
                {urlEncodedRows.map((row, i) => (
                  <div className="try-it__row" key={i}>
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={(e) => updateUrlEncodedRow(i, { enabled: e.target.checked })}
                    />
                    <input
                      name={`urlKey${i}`}
                      placeholder="Key"
                      value={row.key}
                      onChange={(e) => updateUrlEncodedRow(i, { key: e.target.value })}
                    />
                    <VariableField
                      name={`urlValue${i}`}
                      placeholder="Value — supports {{variables}}"
                      value={row.value}
                      onChange={(v) => updateUrlEncodedRow(i, { value: v })}
                      variables={variables}
                      environmentName={environmentName}
                      onAddVariable={onAddVariable}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => setUrlEncodedRows((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button type="button" className="button" onClick={() => setUrlEncodedRows((prev) => [...prev, { key: "", value: "", enabled: true }])}>
                  Add field
                </button>
              </div>
            )}

            {bodyMode === "none" && <p className="muted">This request has no body.</p>}
          </div>
        )}

        {subTab === "auth" && (
          <div className="try-it__auth-panel">
            <label className="field">
              <span>Auth Type</span>
              <select className="try-it__auth-type-select" value={authMode} onChange={(e) => setAuthMode(e.target.value as AuthMode)}>
                <option value="none">No Auth</option>
                <option value="bearer">Bearer Token</option>
                <option value="basic">Basic Auth</option>
                <option value="apiKey">API Key</option>
              </select>
            </label>

            {authMode === "bearer" && (
              <label className="field">
                <span>Token (optional — try without one too, to see the 401)</span>
                <VariableField
                  name="token"
                  value={bearerToken}
                  onChange={setBearerToken}
                  variables={variables}
                  environmentName={environmentName}
                  onAddVariable={onAddVariable}
                  placeholder="Token value or {{authToken}}"
                />
              </label>
            )}

            {authMode === "basic" && (
              <>
                <label className="field">
                  <span>Username</span>
                  <VariableField
                    name="basicUsername"
                    value={basicUsername}
                    onChange={setBasicUsername}
                    variables={variables}
                    environmentName={environmentName}
                    onAddVariable={onAddVariable}
                  />
                </label>
                <label className="field">
                  <span>Password</span>
                  <VariableField
                    name="basicPassword"
                    type="password"
                    value={basicPassword}
                    onChange={setBasicPassword}
                    variables={variables}
                    environmentName={environmentName}
                    onAddVariable={onAddVariable}
                  />
                </label>
              </>
            )}

            {authMode === "apiKey" && (
              <>
                <label className="field">
                  <span>Key name</span>
                  <input name="apiKeyName" value={apiKeyName} onChange={(e) => setApiKeyName(e.target.value)} placeholder="X-API-Key" />
                </label>
                <label className="field">
                  <span>Value</span>
                  <VariableField
                    name="apiKeyValue"
                    value={apiKeyValue}
                    onChange={setApiKeyValue}
                    variables={variables}
                    environmentName={environmentName}
                    onAddVariable={onAddVariable}
                    placeholder="{{apiKey}}"
                  />
                </label>
                <div className="try-it__body-mode-row">
                  <label className="try-it__radio-label">
                    <input
                      type="radio"
                      name="apiKeyLocation"
                      checked={apiKeyLocation === "header"}
                      onChange={() => setApiKeyLocation("header")}
                    />
                    Header
                  </label>
                  <label className="try-it__radio-label">
                    <input
                      type="radio"
                      name="apiKeyLocation"
                      checked={apiKeyLocation === "query"}
                      onChange={() => setApiKeyLocation("query")}
                    />
                    Query Param
                  </label>
                </div>
              </>
            )}

            {authMode === "none" && <p className="muted">No authorization will be sent with this request.</p>}
          </div>
        )}

        {subTab === "scripts" && (
          <ScriptsPanel
            preRequestScript={preRequestScript}
            testScript={testScript}
            onPreRequestScriptChange={setPreRequestScript}
            onTestScriptChange={setTestScript}
            onSave={saveScripts}
            canEdit={canEdit}
          />
        )}
      </div>

      {displayedResult && (
        <div className="try-it__response">
          <div className="try-it__response-meta">
            <span className={`try-it__status-badge ${displayedResult.status >= 200 && displayedResult.status < 300 ? "ok" : "error"}`}>
              {displayedResult.status || "network error"} {displayedResult.statusText}
            </span>
            {!viewingExample && (
              <>
                <span className="muted">{displayedResult.timeMs} ms</span>
                <span className="muted">{displayedResult.sizeBytes} B</span>
              </>
            )}
            {viewingExample && <span className="muted">Saved response — {viewingExample.label || "Untitled"}</span>}
          </div>

          {displayedResult.status === 0 && !viewingExample && (
            <div className="banner banner--warning">
              <strong>No response came back at all.</strong> Browsers deliberately hide the
              real reason a cross-origin request failed, but the two most common causes are:
              the server isn't reachable at this URL (wrong host/port, not running), or{" "}
              <strong>CORS</strong> — the server needs to explicitly allow requests from this
              exact origin. This request just ran from <code>{window.location.origin}</code>.
              Postman/curl aren't subject to CORS at all, so if this same request works there
              (or here) but fails from your own frontend app, compare that app's real origin
              against what the server's <code>Access-Control-Allow-Origin</code> config
              actually allows — a mismatch there is the most common reason for "works
              everywhere except my app."
            </div>
          )}

          {testResults && (
            <div className="try-it__test-results">
              {testResults.map((r, i) => (
                <div key={i} className={`try-it__test-result ${r.passed ? "ok" : "error"}`}>
                  <span>{r.passed ? "✓" : "✗"}</span>
                  <span>{r.name}</span>
                  {!r.passed && r.error && <span className="muted try-it__test-result-error">{r.error}</span>}
                </div>
              ))}
            </div>
          )}

          <div className="try-it__response-subtabs">
            <button
              type="button"
              className={`try-it__subtab ${responseSubTab === "body" ? "try-it__subtab--active" : ""}`}
              onClick={() => setResponseSubTab("body")}
            >
              Body
            </button>
            <button
              type="button"
              className={`try-it__subtab ${responseSubTab === "headers" ? "try-it__subtab--active" : ""}`}
              onClick={() => setResponseSubTab("headers")}
            >
              Headers
            </button>
          </div>

          {responseSubTab === "body" &&
            (() => {
              const format = detectFormat(displayedResult.body, displayedResult.headers, displayedResult.isBinary, displayedResult.contentType);
              const isLarge = !displayedResult.isBinary && displayedResult.body.length > LARGE_RESPONSE_THRESHOLD;
              const skipHeavyWork = isLarge && !forceFullRender;

              const tableData = displayedResult.isBinary || skipHeavyWork ? null : parseForTable(displayedResult.body);
              const tableEligible = tableData !== null;
              const previewEligible = format === "html" || format === "image" || (displayedResult.isBinary && Boolean(displayedResult.blobUrl));

              const effectiveMode: ResponseViewMode = displayedResult.isBinary
                ? "preview"
                : skipHeavyWork && (responseViewMode === "pretty" || responseViewMode === "table")
                  ? "raw"
                  : responseViewMode === "table" && !tableEligible
                    ? "pretty"
                    : responseViewMode === "preview" && !previewEligible
                      ? "pretty"
                      : responseViewMode;

              const bodyForDisplay =
                effectiveMode === "raw" || skipHeavyWork ? displayedResult.body : prettyPrintBody(displayedResult.body, format);
              const searchBarVisible = searchOpen && (effectiveMode === "pretty" || effectiveMode === "raw");
              const matches = searchBarVisible && searchQuery.trim() ? findMatches(bodyForDisplay, searchQuery) : [];
              const clampedActiveIndex = matches.length > 0 ? ((searchActiveIndex % matches.length) + matches.length) % matches.length : 0;

              async function copyResponseBody() {
                try {
                  await navigator.clipboard.writeText(displayedResult!.body);
                  setResponseBodyCopied(true);
                  setTimeout(() => setResponseBodyCopied(false), 1500);
                } catch {
                  // clipboard API unavailable — silently no-op
                }
              }

              function goToMatch(delta: 1 | -1) {
                if (matches.length === 0) return;
                setSearchActiveIndex((i) => (i + delta + matches.length) % matches.length);
              }

              return (
                <>
                  <div className="try-it__body-toolbar">
                    <div className="response-sample-panel__mode-toggle try-it__view-mode-toggle">
                      <button
                        type="button"
                        disabled={displayedResult.isBinary}
                        className={`response-sample-panel__mode-btn ${effectiveMode === "pretty" ? "response-sample-panel__mode-btn--active" : ""}`}
                        onClick={() => setResponseViewMode("pretty")}
                      >
                        Pretty
                      </button>
                      <button
                        type="button"
                        disabled={displayedResult.isBinary}
                        className={`response-sample-panel__mode-btn ${effectiveMode === "raw" ? "response-sample-panel__mode-btn--active" : ""}`}
                        onClick={() => setResponseViewMode("raw")}
                      >
                        Raw
                      </button>
                      <button
                        type="button"
                        disabled={!tableEligible}
                        title={tableEligible ? undefined : "Response body isn't tabular data"}
                        className={`response-sample-panel__mode-btn ${effectiveMode === "table" ? "response-sample-panel__mode-btn--active" : ""}`}
                        onClick={() => setResponseViewMode("table")}
                      >
                        Table
                      </button>
                      <button
                        type="button"
                        disabled={!previewEligible}
                        title={previewEligible ? undefined : "Nothing to preview — not HTML, an image, or a downloadable file"}
                        className={`response-sample-panel__mode-btn ${effectiveMode === "preview" ? "response-sample-panel__mode-btn--active" : ""}`}
                        onClick={() => setResponseViewMode("preview")}
                      >
                        Preview
                      </button>
                    </div>
                    <span className="badge try-it__format-badge">{FORMAT_LABELS[format]}</span>
                    <div className="try-it__body-toolbar-actions">
                      {!displayedResult.isBinary && format !== "empty" && (
                        <button
                          type="button"
                          className={`icon-button ${searchOpen ? "icon-button--active" : ""}`}
                          title="Search in response"
                          onClick={() => setSearchOpen((o) => !o)}
                        >
                          <Search size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        className={`icon-button ${responseBodyCopied ? "icon-button--active" : ""}`}
                        title="Copy response body"
                        disabled={displayedResult.isBinary}
                        onClick={copyResponseBody}
                      >
                        {responseBodyCopied ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                    </div>
                  </div>

                  {searchBarVisible && (
                    <div className="try-it__search-bar">
                      <Search size={13} className="muted" />
                      <input
                        autoFocus
                        value={searchQuery}
                        onChange={(e) => {
                          setSearchQuery(e.target.value);
                          setSearchActiveIndex(0);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") goToMatch(e.shiftKey ? -1 : 1);
                          if (e.key === "Escape") setSearchOpen(false);
                        }}
                        placeholder="Find in response…"
                      />
                      <span className="muted try-it__search-count">
                        {matches.length > 0 ? `${clampedActiveIndex + 1} of ${matches.length}` : "0 results"}
                      </span>
                      <button type="button" className="icon-button" disabled={matches.length === 0} onClick={() => goToMatch(-1)}>
                        <ChevronUp size={14} />
                      </button>
                      <button type="button" className="icon-button" disabled={matches.length === 0} onClick={() => goToMatch(1)}>
                        <ChevronDown size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => {
                          setSearchOpen(false);
                          setSearchQuery("");
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}

                  {skipHeavyWork && (effectiveMode === "raw" || responseViewMode !== "raw") && (
                    <div className="try-it__large-response">
                      <p className="muted">
                        This response is large ({formatBytes(displayedResult.body.length)}) — showing Raw only to keep things fast.
                      </p>
                      <button type="button" className="link-button" onClick={() => setForceFullRender(true)}>
                        Load full {responseViewMode === "table" ? "Table" : "Pretty"} view anyway →
                      </button>
                    </div>
                  )}

                  {format === "empty" ? (
                    <p className="muted try-it__empty-body">No response body.</p>
                  ) : effectiveMode === "pretty" || effectiveMode === "raw" ? (
                    <pre className="try-it-result__body">
                      <HighlightedText
                        text={bodyForDisplay}
                        matches={matches}
                        queryLength={searchQuery.length}
                        activeIndex={clampedActiveIndex}
                        activeMatchRef={(node) => {
                          activeMatchRef.current = node;
                        }}
                      />
                    </pre>
                  ) : effectiveMode === "table" ? (
                    tableData !== null && <ResponseTableView data={tableData} />
                  ) : displayedResult.isBinary ? (
                    format === "image" && displayedResult.blobUrl ? (
                      <img src={displayedResult.blobUrl} alt="Response preview" className="try-it__image-preview" />
                    ) : (
                      <div className="try-it__binary-preview">
                        <p className="muted">
                          Binary response ({formatBytes(displayedResult.sizeBytes)}
                          {displayedResult.contentType ? `, ${displayedResult.contentType}` : ""}) — can't display this as text.
                        </p>
                        {displayedResult.blobUrl && (
                          <a href={displayedResult.blobUrl} download className="button">
                            Download
                          </a>
                        )}
                      </div>
                    )
                  ) : (
                    <iframe className="try-it__web-view" sandbox="" srcDoc={displayedResult.body} title="Response preview" />
                  )}
                </>
              );
            })()}
          {responseSubTab === "headers" && (
            <div className="try-it__rows">
              {Object.entries(displayedResult.headers).map(([key, value]) => (
                <div className="try-it__row" key={key}>
                  <span className="try-it__row-key">{key}</span>
                  <span>{value}</span>
                </div>
              ))}
              {Object.keys(displayedResult.headers).length === 0 && <p className="muted">No response headers captured.</p>}
            </div>
          )}

          {!viewingExample && result && (
            <div className="try-it__save-row">
              <input
                name="saveLabel"
                value={saveLabel}
                onChange={(e) => setSaveLabel(e.target.value)}
                placeholder="Label this response (optional)"
              />
              <button type="button" className="button" onClick={saveResponse}>
                Save response
              </button>
            </div>
          )}
        </div>
      )}

      <div className="detail-section try-it__saved-list">
        <h3>Saved responses</h3>
        {savedExamples.length === 0 && <p className="muted">No saved responses yet — send a request and save it above.</p>}
        {savedExamples.map((example) => (
          <div className="try-it__saved-item" key={example._id}>
            <span className={`try-it__status-badge ${example.statusCode < 300 ? "ok" : "error"}`}>{example.statusCode}</span>
            <span className="try-it__saved-item-label">{example.label || "Untitled"}</span>
            <button type="button" className="link-button" onClick={() => viewExample(example)}>
              View
            </button>
            {canEdit && (
              <button type="button" className="icon-button" onClick={() => deleteSaved(example._id)}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
