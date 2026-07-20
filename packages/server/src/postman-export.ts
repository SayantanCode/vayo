// @vayo/server — Postman Collection v2.1 + Environment export. A small,
// single-consumer transform colocated here rather than its own package —
// nothing else in the system depends on Postman's format the way things
// depend on @vayo/openapi-compiler's OpenAPI output. Folders nest exactly
// like Vayo's own sidebar tree, since both are backed by the same
// vayo_folders + endpoint-placement-override data.

import type { EnvironmentDoc, ExampleDoc, FolderDoc, ResolvedEndpoint, TestScriptDoc } from "@vayo/types";

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Entity",
  500: "Internal Server Error",
};

interface PostmanUrl {
  raw: string;
  host: string[];
  path: string[];
  variable?: Array<{ key: string; value: string }>;
  query?: Array<{ key: string; value: string; disabled?: boolean; description?: string }>;
}

type PostmanAuth = { type: "noauth" } | { type: "bearer"; bearer: Array<{ key: string; value: string; type: string }> };

interface PostmanEvent {
  listen: "prerequest" | "test";
  script: { type: "text/javascript"; exec: string[] };
}

interface PostmanSavedResponse {
  name: string;
  originalRequest: PostmanRequestItem["request"];
  status: string;
  code: number;
  header: Array<{ key: string; value: string }>;
  body: string;
}

interface PostmanRequestItem {
  name: string;
  request: {
    method: string;
    header: Array<{ key: string; value: string }>;
    url: PostmanUrl;
    body?: { mode: "raw"; raw: string; options: { raw: { language: "json" } } };
    auth?: PostmanAuth;
    description?: string;
  };
  event?: PostmanEvent[];
  response: PostmanSavedResponse[];
}

interface PostmanFolderItem {
  name: string;
  item: PostmanItem[];
}

type PostmanItem = PostmanRequestItem | PostmanFolderItem;

function toPostmanUrl(pathTemplate: string, querySchema: Record<string, unknown> | null): PostmanUrl {
  const segments = pathTemplate.split("/").filter(Boolean);
  const variables: Array<{ key: string; value: string }> = [];
  const pathParts = segments.map((segment) => {
    if (segment.startsWith("{") && segment.endsWith("}")) {
      const name = segment.slice(1, -1);
      variables.push({ key: name, value: "" });
      return `:${name}`;
    }
    return segment;
  });

  const queryProperties = (querySchema?.properties as Record<string, unknown> | undefined) ?? {};
  const queryKeys = Object.keys(queryProperties);
  const query = queryKeys.map((key) => ({ key, value: "", disabled: true }));
  const rawQuery = queryKeys.length > 0 ? `?${queryKeys.map((k) => `${k}=`).join("&")}` : "";

  return {
    raw: `{{baseUrl}}/${pathParts.join("/")}${rawQuery}`,
    host: ["{{baseUrl}}"],
    path: pathParts,
    ...(variables.length > 0 ? { variable: variables } : {}),
    ...(query.length > 0 ? { query } : {}),
  };
}

/** Builds a minimal, plausible example JSON payload from a JSON Schema
 * shape — good enough for Postman's request-body placeholder, not a full
 * schema-to-example generator. */
function examplePayloadFromSchema(schema: Record<string, unknown>): unknown {
  const type = schema.type;
  if (type === "object" || schema.properties) {
    const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    const out: Record<string, unknown> = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      out[key] = examplePayloadFromSchema(propSchema);
    }
    return out;
  }
  if (type === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    return items ? [examplePayloadFromSchema(items)] : [];
  }
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  return "";
}

function toRequestItem(
  endpoint: ResolvedEndpoint,
  testScript: TestScriptDoc | undefined,
  pinnedExamples: ExampleDoc[],
  collectionHasAuth: boolean,
): PostmanRequestItem {
  const header: Array<{ key: string; value: string }> = [];

  const item: PostmanRequestItem = {
    name: endpoint.summary || `${endpoint.method} ${endpoint.pathTemplate}`,
    request: {
      method: endpoint.method,
      header,
      url: toPostmanUrl(endpoint.pathTemplate.replace(/:([A-Za-z0-9_]+)/g, "{$1}"), endpoint.querySchema),
      ...(endpoint.notes ? { description: endpoint.notes } : {}),
    },
    response: [],
  };

  // Native auth + collection-level inheritance, rather than a manually-set
  // header: Postman resolves auth top-down, so a request with no `auth` of
  // its own inherits the collection's. A public endpoint opts out with an
  // explicit "noauth", exactly like clicking "No Auth" in the Postman UI
  // would — only needed at all when *something* in the collection requires
  // auth in the first place.
  if (collectionHasAuth && !endpoint.authRequired) {
    item.request.auth = { type: "noauth" };
  }

  const properties = endpoint.requestSchema?.properties as Record<string, unknown> | undefined;
  if (properties && Object.keys(properties).length > 0) {
    item.request.header.push({ key: "Content-Type", value: "application/json" });
    item.request.body = {
      mode: "raw",
      raw: JSON.stringify(examplePayloadFromSchema(endpoint.requestSchema!), null, 2),
      options: { raw: { language: "json" } },
    };
  }

  const events: PostmanEvent[] = [];
  if (testScript?.preRequestScript.trim()) {
    events.push({ listen: "prerequest", script: { type: "text/javascript", exec: testScript.preRequestScript.split("\n") } });
  }
  if (testScript?.testScript.trim()) {
    events.push({ listen: "test", script: { type: "text/javascript", exec: testScript.testScript.split("\n") } });
  }
  if (events.length > 0) item.event = events;

  if (pinnedExamples.length > 0) {
    item.response = pinnedExamples.map((example) => ({
      name: example.label || `${example.statusCode} example`,
      originalRequest: item.request,
      status: STATUS_TEXT[example.statusCode] ?? "Response",
      code: example.statusCode,
      header: [{ key: "Content-Type", value: "application/json" }],
      body: JSON.stringify(example.responseBody, null, 2),
    }));
  }

  return item;
}

export interface PostmanCollection {
  info: { name: string; schema: string };
  item: PostmanItem[];
  auth?: PostmanAuth;
}

/**
 * Compiles resolved endpoints + the folder tree into a Postman Collection
 * v2.1 document. `placements` maps vayoId -> folderId (or null for root) —
 * the same folderId/order data the UI's sidebar reads off each resolved
 * endpoint's override-applied fields. `testScripts` and `pinnedExamples`
 * (pinned-only — auto-captured, non-pinned examples are too numerous/
 * uncurated to be "the" saved response for a request) are keyed by vayoId,
 * same as `placements`.
 */
export function compilePostmanCollection(
  collectionName: string,
  endpoints: ResolvedEndpoint[],
  folders: FolderDoc[],
  placements: Map<string, string | null>,
  testScripts: Map<string, TestScriptDoc>,
  pinnedExamples: Map<string, ExampleDoc[]>,
): PostmanCollection {
  const childFolders = new Map<string | null, FolderDoc[]>();
  for (const folder of folders) {
    const key = folder.parentId;
    if (!childFolders.has(key)) childFolders.set(key, []);
    childFolders.get(key)!.push(folder);
  }
  for (const list of childFolders.values()) list.sort((a, b) => a.order - b.order);

  const endpointsByFolder = new Map<string | null, ResolvedEndpoint[]>();
  for (const endpoint of endpoints) {
    const folderId = placements.get(endpoint.vayoId) ?? null;
    if (!endpointsByFolder.has(folderId)) endpointsByFolder.set(folderId, []);
    endpointsByFolder.get(folderId)!.push(endpoint);
  }

  const collectionHasAuth = endpoints.some((e) => e.authRequired);

  function buildItems(parentId: string | null): PostmanItem[] {
    const items: PostmanItem[] = [];
    for (const folder of childFolders.get(parentId) ?? []) {
      items.push({ name: folder.name, item: buildItems(folder._id) });
    }
    for (const endpoint of endpointsByFolder.get(parentId) ?? []) {
      items.push(
        toRequestItem(endpoint, testScripts.get(endpoint.vayoId), pinnedExamples.get(endpoint.vayoId) ?? [], collectionHasAuth),
      );
    }
    return items;
  }

  return {
    info: { name: collectionName, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: buildItems(null),
    ...(collectionHasAuth ? { auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}", type: "string" }] } } : {}),
  };
}

export interface PostmanEnvironment {
  name: string;
  values: Array<{ key: string; value: string; enabled: boolean }>;
  _postman_variable_scope: "environment";
}

export function compilePostmanEnvironment(environment: EnvironmentDoc): PostmanEnvironment {
  return {
    name: environment.name,
    values: Object.entries(environment.variables).map(([key, value]) => ({ key, value, enabled: true })),
    _postman_variable_scope: "environment",
  };
}
