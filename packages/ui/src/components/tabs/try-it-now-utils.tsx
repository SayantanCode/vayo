// @vayo/ui — pure request/response helpers + small presentational pieces
// for TryItNowTab, extracted out of that file specifically because none of
// this needs the main component's state: response format detection/
// pretty-printing, path/URL matching, and the two response-view renderers
// (table view, search-match highlighting) are all pure functions of their
// own arguments. Tested directly (TryItNowTab.test.ts) against this module.
import type { ExampleDoc } from "@vayo/types";

export type BodyMode = "none" | "raw" | "form-data" | "urlencoded";
export type AuthMode = "none" | "bearer" | "basic" | "apiKey";

export const BODY_MODE_LABELS: Record<BodyMode, string> = {
  none: "None",
  raw: "Raw JSON",
  "form-data": "Form Data",
  urlencoded: "URL Encoded",
};

/** fetch() throws if a body is set for these methods — a hard browser
 * restriction, not a product choice. */
export const FETCH_BODYLESS_METHODS = new Set(["GET", "HEAD"]);
/** Just used to pick a sane default body mode — DELETE *can* carry a
 * body over HTTP, it just usually doesn't. */
export const COMMONLY_BODYLESS_METHODS = new Set(["GET", "DELETE"]);

export function authModeFromDetected(authType: string | null | undefined): AuthMode {
  if (authType === "bearer") return "bearer";
  if (authType === "basic") return "basic";
  if (authType === "apiKey") return "apiKey";
  return "none";
}

/** `{param}` segments in a captured path match any literal value in the
 * same position — same convention as `resolvedPath`'s own substitution. */
export function pathSegmentsMatch(actual: string, pattern: string): boolean {
  const a = actual.split("/").filter(Boolean);
  const p = pattern.split("/").filter(Boolean);
  if (a.length !== p.length) return false;
  return p.every((seg, i) => seg.startsWith("{") || seg.toLowerCase() === a[i]!.toLowerCase());
}

/** Best-effort path extraction from a URL bar value that may or may not
 * have a real scheme+host yet (e.g. mid-typing, or a bare relative path) —
 * used only for the "does this look like a known endpoint" check, not for
 * the actual request, so a rough fallback is fine. */
export function extractPathname(text: string): string {
  try {
    return new URL(text).pathname;
  } catch {
    const idx = text.indexOf("/");
    return idx === -1 ? text : text.slice(idx);
  }
}

/** Above this, skip JSON.parse/pretty-print/table-building by default —
 * those are the expensive synchronous passes, not rendering a big string
 * itself — and fall back to Raw with an opt-in to force the full pass. */
export const LARGE_RESPONSE_THRESHOLD = 400_000;

export function mostRecentOrPinned(examples: ExampleDoc[]): ExampleDoc | null {
  if (examples.length === 0) return null;
  const pinned = examples.find((e) => e.pinned);
  if (pinned) return pinned;
  const sorted = [...examples].sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
  return sorted[0] ?? null;
}

/** Response body view modes, matching Postman's own naming: Pretty
 * (formatted), Raw (verbatim), Table (JSON only), Preview (HTML/image/
 * downloadable binary). Each is only enabled when it actually applies —
 * matching the "can't shift to web view if the data isn't HTML" rule the
 * previous JSON/Table/Web version already had, just generalized. */
export type ResponseViewMode = "pretty" | "raw" | "table" | "preview";

/** What the body actually *is*, detected once and used to pick a mode,
 * label it honestly (not everything is "JSON"), and decide eligibility.
 * Content-Type is trusted first since it's the API's own declaration;
 * sniffing the body is only a fallback for APIs that omit it (common with
 * hand-rolled Express error handlers, which is exactly who this product is
 * for). */
export type ResponseFormat = "json" | "xml" | "html" | "image" | "binary" | "text" | "empty";

const TEXT_LIKE_CONTENT_TYPE = /^(text\/|application\/(json|.*\+json|xml|.*\+xml|javascript|x-www-form-urlencoded))/i;

export function isBinaryContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (TEXT_LIKE_CONTENT_TYPE.test(type)) return false;
  return /^(image|audio|video)\//.test(type) || type === "application/pdf" || type === "application/octet-stream" || /zip|gzip|tar|msword|ms-excel|ms-powerpoint|vnd\.openxmlformats|vnd\.rar|x-7z/.test(type);
}

export function getHeaderValue(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  return Object.entries(headers).find(([k]) => k.toLowerCase() === lower)?.[1] ?? null;
}

export function detectFormat(body: string, headers: Record<string, string>, isBinary: boolean, contentType: string | null): ResponseFormat {
  if (isBinary) return contentType?.toLowerCase().startsWith("image/") ? "image" : "binary";

  const ct = (contentType ?? "").toLowerCase();
  const trimmed = body.trim();
  if (!trimmed) return "empty";
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("xml")) return "xml";

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // not actually JSON — fall through to markup sniffing
    }
  }
  if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return "html";
  if (trimmed.startsWith("<?xml")) return "xml";
  if (trimmed.startsWith("<") && /<\/?[a-z][\s\S]*>/i.test(trimmed)) {
    return /<(head|body|div|span|table|script|meta)[\s>]/i.test(trimmed) ? "html" : "xml";
  }
  return "text";
}

export const FORMAT_LABELS: Record<ResponseFormat, string> = {
  json: "JSON",
  xml: "XML",
  html: "HTML",
  image: "Image",
  binary: "Binary",
  text: "Text",
  empty: "Empty",
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function prettyPrintXml(xml: string): string {
  const withBreaks = xml.replace(/>\s*</g, "><").trim().replace(/(>)(<)(\/*)/g, "$1\n$2$3");
  let pad = 0;
  const lines = withBreaks.split("\n").map((node) => {
    let indentDelta = 0;
    if (/^<\/\w/.test(node)) {
      pad = Math.max(pad - 1, 0);
    } else if (/^<\w[^>]*[^/]>.*$/.test(node) && !/^<\?/.test(node) && !/<\/\w[^>]*>\s*$/.test(node)) {
      indentDelta = 1;
    }
    const line = "  ".repeat(pad) + node;
    pad += indentDelta;
    return line;
  });
  return lines.join("\n");
}

export function prettyPrintBody(body: string, format: ResponseFormat): string {
  if (format === "json") {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  if (format === "xml") {
    try {
      return prettyPrintXml(body);
    } catch {
      return body;
    }
  }
  return body;
}

export function parseForTable(body: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    if (parsed !== null && typeof parsed === "object") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function ResponseTableView({ data }: { data: unknown }): JSX.Element {
  if (Array.isArray(data)) {
    const isObjectArray = data.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
    if (isObjectArray) {
      const columns = [...new Set(data.flatMap((item) => Object.keys(item as object)))];
      return (
        <div className="try-it__table-wrap">
          <table className="try-it__response-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((item, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c}>{formatCell((item as Record<string, unknown>)[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return (
      <div className="try-it__table-wrap">
        <table className="try-it__response-table">
          <thead>
            <tr>
              <th>#</th>
              <th>value</th>
            </tr>
          </thead>
          <tbody>
            {data.map((item, i) => (
              <tr key={i}>
                <td>{i}</td>
                <td>{formatCell(item)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const entries = Object.entries(data as Record<string, unknown>);
  return (
    <div className="try-it__table-wrap">
      <table className="try-it__response-table">
        <thead>
          <tr>
            <th>key</th>
            <th>value</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{formatCell(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function findMatches(text: string, query: string): number[] {
  if (!query.trim()) return [];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const matches: number[] = [];
  let idx = lower.indexOf(needle);
  while (idx !== -1) {
    matches.push(idx);
    idx = lower.indexOf(needle, idx + needle.length);
  }
  return matches;
}

interface HighlightedTextProps {
  text: string;
  matches: number[];
  queryLength: number;
  activeIndex: number;
  activeMatchRef: (node: HTMLElement | null) => void;
}

export function HighlightedText({ text, matches, queryLength, activeIndex, activeMatchRef }: HighlightedTextProps): JSX.Element {
  if (matches.length === 0) return <>{text}</>;
  const parts: JSX.Element[] = [];
  let cursor = 0;
  matches.forEach((start, i) => {
    parts.push(<span key={`t${start}`}>{text.slice(cursor, start)}</span>);
    const isActive = i === activeIndex;
    parts.push(
      <mark
        key={`m${start}`}
        ref={isActive ? activeMatchRef : undefined}
        className={`try-it__search-match ${isActive ? "try-it__search-match--active" : ""}`}
      >
        {text.slice(start, start + queryLength)}
      </mark>,
    );
    cursor = start + queryLength;
  });
  parts.push(<span key="tail">{text.slice(cursor)}</span>);
  return <>{parts}</>;
}
