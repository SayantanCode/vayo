import { describe, expect, it } from "vitest";
import type { JSONSchema } from "@vayo/types";
import { exampleFromSchema } from "./example-from-schema.js";

describe("exampleFromSchema", () => {
  it("returns null for a missing schema", () => {
    expect(exampleFromSchema(null)).toBeNull();
    expect(exampleFromSchema(undefined)).toBeNull();
  });

  it("prefers the first enum value over the base type", () => {
    expect(exampleFromSchema({ type: "string", enum: ["active", "inactive"] })).toBe("active");
  });

  it("uses the format string for a formatted string field", () => {
    expect(exampleFromSchema({ type: "string", format: "email" })).toBe("email");
  });

  it("falls back to the literal word 'string' with no format", () => {
    expect(exampleFromSchema({ type: "string" })).toBe("string");
  });

  it("returns 0 for number and integer, true for boolean", () => {
    expect(exampleFromSchema({ type: "number" })).toBe(0);
    expect(exampleFromSchema({ type: "integer" })).toBe(0);
    expect(exampleFromSchema({ type: "boolean" })).toBe(true);
  });

  it("builds a one-element array from the items schema", () => {
    expect(exampleFromSchema({ type: "array", items: { type: "string" } })).toEqual(["string"]);
  });

  it("returns an empty array when an array schema has no items", () => {
    expect(exampleFromSchema({ type: "array" })).toEqual([]);
  });

  it("recursively builds an object from its properties", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        quantity: { type: "integer" },
        active: { type: "boolean" },
      },
    };
    expect(exampleFromSchema(schema)).toEqual({ id: "string", quantity: 0, active: true });
  });

  it("returns an empty object when an object schema has no properties", () => {
    expect(exampleFromSchema({ type: "object" })).toEqual({});
  });

  it("handles a nested array-of-objects schema", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { sku: { type: "string" }, qty: { type: "number" } },
          },
        },
      },
    };
    expect(exampleFromSchema(schema)).toEqual({ items: [{ sku: "string", qty: 0 }] });
  });

  it("treats an unrecognized/missing type as an object (the default branch)", () => {
    expect(exampleFromSchema({ properties: { name: { type: "string" } } })).toEqual({ name: "string" });
  });

  it("uses the first entry when type is an array of types", () => {
    expect(exampleFromSchema({ type: ["string", "null"] })).toBe("string");
  });
});
