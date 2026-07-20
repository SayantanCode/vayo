// @vayo/ui — synthesizes a plausible example value from a JSON Schema.
// A UI-local counterpart to the server's `examplePayloadFromSchema`
// (packages/server/src/postman-export.ts) — deliberately not imported
// from there, since @vayo/ui only ever talks to @vayo/server's REST API,
// never its internals (docs/08-packages-and-repo-structure.md). Used only
// as a fallback in the Details tab's code/response sample panels when no
// real captured example exists yet for an endpoint.

import type { JSONSchema } from "@vayo/types";

export function exampleFromSchema(schema: JSONSchema | undefined | null): unknown {
  if (!schema) return null;

  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case "string":
      return typeof schema.format === "string" ? schema.format : "string";
    case "number":
      return 0;
    case "integer":
      return 0;
    case "boolean":
      return true;
    case "array": {
      const items = schema.items as JSONSchema | undefined;
      return items ? [exampleFromSchema(items)] : [];
    }
    case "object":
    default: {
      const properties = schema.properties as Record<string, JSONSchema> | undefined;
      if (!properties) return {};
      const out: Record<string, unknown> = {};
      for (const [key, childSchema] of Object.entries(properties)) {
        out[key] = exampleFromSchema(childSchema);
      }
      return out;
    }
  }
}
