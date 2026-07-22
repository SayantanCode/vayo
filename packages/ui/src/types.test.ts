import { describe, expect, it } from "vitest";
import type { FolderDoc } from "@vayo/types";
import {
  buildTree,
  flattenSpec,
  flattenTree,
  groupBy,
  interpolate,
  resolveOrigin,
  type EndpointSummary,
  type OpenApiDoc,
  type OpenApiOperation,
} from "./types.js";

function op(overrides: Partial<OpenApiOperation> = {}): OpenApiOperation {
  return {
    operationId: "op_1",
    responses: { "200": { description: "OK" } },
    "x-vayo-id": "ep_1",
    "x-vayo-group": "Widgets",
    "x-vayo-group-source": "inferred",
    "x-vayo-scopes": [],
    "x-vayo-middleware-chain": [],
    "x-vayo-auth-required": false,
    "x-vayo-auth-type": null,
    "x-vayo-source": "runtime",
    ...overrides,
  };
}

describe("flattenSpec", () => {
  it("flattens paths x methods into one row each, uppercasing the method", () => {
    const doc: OpenApiDoc = {
      openapi: "3.1.0",
      info: { title: "t", version: "v1" },
      paths: {
        "/api/v1/widgets": {
          get: op({ "x-vayo-id": "ep_get" }),
          post: op({ "x-vayo-id": "ep_post" }),
        },
      },
    };
    const rows = flattenSpec(doc);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.method).sort()).toEqual(["GET", "POST"]);
    expect(rows.every((r) => r.path === "/api/v1/widgets")).toBe(true);
  });
});

describe("interpolate", () => {
  it("replaces every {{key}} occurrence with its variable value", () => {
    expect(interpolate("{{baseUrl}}/api/v1/cart", { baseUrl: "http://localhost:4000" })).toBe(
      "http://localhost:4000/api/v1/cart",
    );
  });

  it("leaves an unmatched token as-is rather than turning it into an empty string", () => {
    expect(interpolate("{{unknownVar}}/x", {})).toBe("{{unknownVar}}/x");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(interpolate("{{ baseUrl }}", { baseUrl: "http://x" })).toBe("http://x");
  });

  it("replaces multiple distinct tokens in one pass", () => {
    expect(interpolate("{{a}}-{{b}}", { a: "1", b: "2" })).toBe("1-2");
  });
});

describe("resolveOrigin", () => {
  it("resolves fully when every token has a value", () => {
    expect(resolveOrigin("{{baseUrl}}", { baseUrl: "http://localhost:4000" })).toBe("http://localhost:4000");
  });

  it("returns empty string when a token remains unresolved (never shows raw {{...}} to a reader)", () => {
    expect(resolveOrigin("{{baseUrl}}", {})).toBe("");
  });

  it("returns empty string for an empty template", () => {
    expect(resolveOrigin("", { baseUrl: "http://x" })).toBe("");
  });
});

describe("groupBy", () => {
  it("groups items by key and sorts the groups alphabetically", () => {
    const result = groupBy(["banana", "apple", "avocado", "blueberry"], (s) => s[0]!);
    expect(result.map(([key]) => key)).toEqual(["a", "b"]);
    expect(result[0]![1]).toEqual(["apple", "avocado"]);
    expect(result[1]![1]).toEqual(["banana", "blueberry"]);
  });

  it("preserves each group's original relative order", () => {
    const result = groupBy([1, 2, 3, 4], (n) => (n % 2 === 0 ? "even" : "odd"));
    const odd = result.find(([key]) => key === "odd")![1];
    expect(odd).toEqual([1, 3]);
  });
});

describe("buildTree / flattenTree", () => {
  function folder(overrides: Partial<FolderDoc>): FolderDoc {
    return {
      _id: "f_1",
      name: "Folder",
      parentId: null,
      version: "v1",
      order: 0,
      createdBy: "m",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }
  function endpoint(overrides: Partial<EndpointSummary> = {}): EndpointSummary {
    return {
      vayoId: "ep_1",
      method: "GET",
      path: "/api/v1/widgets",
      group: "Widgets",
      operation: op(),
      ...overrides,
    };
  }

  it("places an endpoint with no folder placement at the root", () => {
    const tree = buildTree([], [endpoint()]);
    expect(tree).toEqual([{ type: "endpoint", endpoint: endpoint() }]);
  });

  it("nests a folder's endpoints and sub-folders under it, sorted by order", () => {
    const root = folder({ _id: "f_root", parentId: null, order: 0 });
    const child = folder({ _id: "f_child", parentId: "f_root", order: 0 });
    const second = endpoint({ vayoId: "ep_2", operation: op({ "x-vayo-id": "ep_2", "x-vayo-folder-id": "f_root", "x-vayo-order": 1 }) });
    const first = endpoint({ vayoId: "ep_1", operation: op({ "x-vayo-id": "ep_1", "x-vayo-folder-id": "f_root", "x-vayo-order": 0 }) });

    const tree = buildTree([root, child], [second, first]);
    expect(tree).toHaveLength(1);
    const rootNode = tree[0]!;
    expect(rootNode.type).toBe("folder");
    if (rootNode.type !== "folder") throw new Error("unreachable");
    // sub-folder first, then endpoints in x-vayo-order (not insertion order)
    expect(rootNode.children[0]).toMatchObject({ type: "folder", folder: { _id: "f_child" } });
    expect(rootNode.children[1]).toMatchObject({ type: "endpoint", endpoint: { vayoId: "ep_1" } });
    expect(rootNode.children[2]).toMatchObject({ type: "endpoint", endpoint: { vayoId: "ep_2" } });
  });

  it("flattenTree only descends into expanded folders", () => {
    const root = folder({ _id: "f_root", parentId: null });
    const placed = endpoint({ vayoId: "ep_1", operation: op({ "x-vayo-id": "ep_1", "x-vayo-folder-id": "f_root" }) });
    const tree = buildTree([root], [placed]);

    const collapsed = flattenTree(tree, new Set());
    expect(collapsed).toHaveLength(1); // just the folder row itself
    expect(collapsed[0]!.id).toBe("folder:f_root");

    const expanded = flattenTree(tree, new Set(["f_root"]));
    expect(expanded).toHaveLength(2);
    expect(expanded[1]!.depth).toBe(1);
    expect(expanded[1]!.parentId).toBe("f_root");
  });
});
