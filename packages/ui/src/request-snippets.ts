// @vayo/ui — pure code-snippet generators shared between Try It Now's
// "Copy as curl" and the Details tab's read-only code sample panel. A
// small, data-driven list (`SNIPPET_LANGUAGES`) so adding a third
// language later is a one-line addition, not a redesign.

export function buildCurl(method: string, url: string, headers: Record<string, string>, body: string | undefined): string {
  const parts = [`curl -X ${method}`, `'${url}'`];
  for (const [key, value] of Object.entries(headers)) {
    parts.push(`-H '${key}: ${value}'`);
  }
  if (body) parts.push(`-d '${body.replace(/'/g, "'\\''")}'`);
  return parts.join(" \\\n  ");
}

export function buildFetchSnippet(method: string, url: string, headers: Record<string, string>, body: string | undefined): string {
  const headerEntries = Object.entries(headers);
  const lines = [`fetch('${url}', {`, `  method: '${method}',`];
  if (headerEntries.length > 0) {
    lines.push(`  headers: {`);
    for (const [key, value] of headerEntries) {
      lines.push(`    '${key}': '${value}',`);
    }
    lines.push(`  },`);
  }
  if (body) lines.push(`  body: JSON.stringify(${body}),`);
  lines.push(`});`);
  return lines.join("\n");
}

export function buildPythonRequestsSnippet(method: string, url: string, headers: Record<string, string>, body: string | undefined): string {
  const headerEntries = Object.entries(headers);
  const lines = ["import requests", "", `url = '${url}'`, ""];
  const args = ["url"];
  if (headerEntries.length > 0) {
    lines.push("headers = {");
    for (const [key, value] of headerEntries) lines.push(`    '${key}': '${value}',`);
    lines.push("}", "");
    args.push("headers=headers");
  }
  if (body) {
    lines.push(`payload = '''${body}'''`, "");
    args.push("data=payload");
  }
  lines.push(`response = requests.request('${method}', ${args.join(", ")})`, "", "print(response.text)");
  return lines.join("\n");
}

export function buildAxiosSnippet(method: string, url: string, headers: Record<string, string>, body: string | undefined): string {
  const headerEntries = Object.entries(headers);
  const lines = ["const axios = require('axios');", "", "const response = await axios({", `  method: '${method}',`, `  url: '${url}',`];
  if (headerEntries.length > 0) {
    lines.push("  headers: {");
    for (const [key, value] of headerEntries) lines.push(`    '${key}': '${value}',`);
    lines.push("  },");
  }
  if (body) lines.push(`  data: ${body},`);
  lines.push("});", "", "console.log(response.data);");
  return lines.join("\n");
}

export function buildPhpCurlSnippet(method: string, url: string, headers: Record<string, string>, body: string | undefined): string {
  const headerEntries = Object.entries(headers);
  const lines = [
    "<?php",
    "$curl = curl_init();",
    "",
    "curl_setopt_array($curl, array(",
    `  CURLOPT_URL => '${url}',`,
    "  CURLOPT_RETURNTRANSFER => true,",
    `  CURLOPT_CUSTOMREQUEST => '${method}',`,
  ];
  if (body) lines.push(`  CURLOPT_POSTFIELDS => '${body.replace(/'/g, "\\'")}',`);
  if (headerEntries.length > 0) {
    lines.push("  CURLOPT_HTTPHEADER => array(");
    for (const [key, value] of headerEntries) lines.push(`    '${key}: ${value}',`);
    lines.push("  ),");
  }
  lines.push("));", "", "$response = curl_exec($curl);", "curl_close($curl);", "echo $response;");
  return lines.join("\n");
}

export function buildGoSnippet(method: string, url: string, headers: Record<string, string>, body: string | undefined): string {
  const headerEntries = Object.entries(headers);
  const lines = ["package main", "", "import (", '\t"fmt"', '\t"io"', '\t"net/http"'];
  if (body) lines.push('\t"strings"');
  lines.push(")", "", "func main() {", `\turl := "${url}"`);
  if (body) {
    lines.push(`\tpayload := strings.NewReader(\`${body}\`)`, "", `\treq, _ := http.NewRequest("${method}", url, payload)`);
  } else {
    lines.push("", `\treq, _ := http.NewRequest("${method}", url, nil)`);
  }
  if (headerEntries.length > 0) {
    lines.push("");
    for (const [key, value] of headerEntries) lines.push(`\treq.Header.Add("${key}", "${value}")`);
  }
  lines.push(
    "",
    "\tres, _ := http.DefaultClient.Do(req)",
    "\tdefer res.Body.Close()",
    "\tbody, _ := io.ReadAll(res.Body)",
    "\tfmt.Println(string(body))",
    "}",
  );
  return lines.join("\n");
}

export interface CurlFormField {
  key: string;
  value: string;
  isFile: boolean;
}

/** curl -F syntax for multipart/form-data — file fields use the `@filename`
 * form. Used only by Try It Now's "Copy as curl" (form-data mode); the
 * Details tab's code sample panel never needs this since Vayo's capture
 * engine only ever records JSON request bodies. */
export function buildCurlFormData(method: string, url: string, headers: Record<string, string>, fields: CurlFormField[]): string {
  const parts = [`curl -X ${method}`, `'${url}'`];
  for (const [key, value] of Object.entries(headers)) {
    parts.push(`-H '${key}: ${value}'`);
  }
  for (const field of fields) {
    const value = field.isFile ? `@${field.value}` : field.value;
    parts.push(`-F '${field.key}=${value}'`);
  }
  return parts.join(" \\\n  ");
}

export function buildCurlUrlEncoded(
  method: string,
  url: string,
  headers: Record<string, string>,
  fields: Array<{ key: string; value: string }>,
): string {
  const parts = [`curl -X ${method}`, `'${url}'`];
  for (const [key, value] of Object.entries(headers)) {
    parts.push(`-H '${key}: ${value}'`);
  }
  for (const field of fields) {
    parts.push(`--data-urlencode '${field.key}=${field.value}'`);
  }
  return parts.join(" \\\n  ");
}

export interface SnippetLanguage {
  id: string;
  label: string;
  build: (method: string, url: string, headers: Record<string, string>, body: string | undefined) => string;
}

export const SNIPPET_LANGUAGES: SnippetLanguage[] = [
  { id: "curl", label: "cURL", build: buildCurl },
  { id: "fetch", label: "JS fetch", build: buildFetchSnippet },
  { id: "python", label: "Python", build: buildPythonRequestsSnippet },
  { id: "node-axios", label: "Node (axios)", build: buildAxiosSnippet },
  { id: "php", label: "PHP", build: buildPhpCurlSnippet },
  { id: "go", label: "Go", build: buildGoSnippet },
];
