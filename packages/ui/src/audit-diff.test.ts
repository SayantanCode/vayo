import { describe, expect, it } from "vitest";
import { describeAuditEntry, diffLeaves } from "./audit-diff.js";

describe("diffLeaves", () => {
  it("returns nothing when two objects are identical", () => {
    expect(diffLeaves({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toEqual([]);
  });

  it("finds a single nested leaf that changed, with a dotted path", () => {
    expect(diffLeaves({ requestSchema: { type: "object" } }, { requestSchema: { type: "array" } })).toEqual([
      { path: "requestSchema.type", before: "object", after: "array" },
    ]);
  });

  it("reports a key that only exists in after as a change from undefined", () => {
    expect(diffLeaves({}, { name: "widget" })).toEqual([{ path: "name", before: undefined, after: "widget" }]);
  });

  it("reports a key that only exists in before as a change to undefined", () => {
    expect(diffLeaves({ name: "widget" }, {})).toEqual([{ path: "name", before: "widget", after: undefined }]);
  });

  it("treats arrays as opaque values rather than diffing per-index", () => {
    expect(diffLeaves({ tags: ["a", "b"] }, { tags: ["a", "c"] })).toEqual([
      { path: "tags", before: ["a", "b"], after: ["a", "c"] },
    ]);
  });

  it("finds every changed leaf across multiple nested fields", () => {
    const before = { requestSchema: { type: "object" }, querySchema: { type: "object" } };
    const after = { requestSchema: { type: "array" }, querySchema: { type: "object" } };
    expect(diffLeaves(before, after)).toEqual([{ path: "requestSchema.type", before: "object", after: "array" }]);
  });

  it("diffs top-level scalars with a placeholder path when there's no object to walk", () => {
    expect(diffLeaves("owner", "editor")).toEqual([{ path: "(value)", before: "owner", after: "editor" }]);
  });
});

describe("describeAuditEntry", () => {
  it("names the actual field for an override, not just 'a field'", () => {
    const result = describeAuditEntry({ action: "override", fieldPath: "notes", diff: { before: null, after: "Call this first" } });
    expect(result.summary).toBe("Set notes");
    expect(result.changes).toEqual([{ path: "notes", before: null, after: "Call this first" }]);
  });

  it("falls back to 'a field' if an override somehow has no fieldPath", () => {
    const result = describeAuditEntry({ action: "override", fieldPath: null, diff: { before: null, after: "x" } });
    expect(result.summary).toBe("Set a field");
  });

  it("summarizes a role change with before/after roles", () => {
    const result = describeAuditEntry({ action: "role_change", fieldPath: "role", diff: { before: "viewer", after: "editor" } });
    expect(result.summary).toBe("Role changed");
    expect(result.changes).toEqual([{ path: "role", before: "viewer", after: "editor" }]);
  });

  it("counts the number of fields that actually changed for a schema_change", () => {
    const result = describeAuditEntry({
      action: "schema_change",
      fieldPath: null,
      diff: {
        before: { requestSchema: { type: "object" }, responseSchemas: {}, paramsSchema: null, querySchema: null },
        after: { requestSchema: { type: "array" }, responseSchemas: {}, paramsSchema: null, querySchema: null },
      },
    });
    expect(result.summary).toBe("Schema changed — 1 field");
    expect(result.changes).toEqual([{ path: "requestSchema.type", before: "object", after: "array" }]);
  });

  it("uses singular 'field' for exactly one change and plural otherwise", () => {
    const zeroChanges = describeAuditEntry({ action: "schema_change", fieldPath: null, diff: { before: {}, after: {} } });
    expect(zeroChanges.summary).toBe("Schema changed — 0 fields");
  });

  it("shows the comment body as the summary", () => {
    const result = describeAuditEntry({ action: "comment", fieldPath: null, diff: { before: null, after: "Does this need auth?" } });
    expect(result.summary).toBe("Does this need auth?");
    expect(result.changes).toEqual([]);
  });

  it("summarizes an invite with the invitee's email and role", () => {
    const result = describeAuditEntry({
      action: "invite",
      fieldPath: null,
      diff: { before: null, after: { email: "alice@example.com", role: "editor" } },
    });
    expect(result.summary).toBe("Invited alice@example.com as editor");
  });

  it("summarizes endpoint_created with method and path", () => {
    const result = describeAuditEntry({
      action: "endpoint_created",
      fieldPath: null,
      diff: { before: null, after: { method: "POST", pathTemplate: "/api/v1/widgets" } },
    });
    expect(result.summary).toBe("Discovered POST /api/v1/widgets");
  });

  it("summarizes endpoint_deleted with the deleted endpoint's method and path", () => {
    const result = describeAuditEntry({
      action: "endpoint_deleted",
      fieldPath: null,
      diff: { before: { method: "POST", pathTemplate: "/api/v1/widgets" }, after: null },
    });
    expect(result.summary).toBe("Deleted POST /api/v1/widgets");
  });
});
