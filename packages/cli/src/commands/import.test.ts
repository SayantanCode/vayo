import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importCommand } from "./import.js";

const listEndpoints = vi.fn();
const listEnvironments = vi.fn();
const createEnvironment = vi.fn();
const updateSettings = vi.fn();
const getOverride = vi.fn();
const upsertOverride = vi.fn();
const appendAuditLog = vi.fn();
const listExamples = vi.fn();
const pinExample = vi.fn();

vi.mock("@vayo/db-mongo", () => ({
  createAdapter: () => ({
    listEndpoints,
    listEnvironments,
    createEnvironment,
    updateSettings,
    getOverride,
    upsertOverride,
    appendAuditLog,
    listExamples,
    pinExample,
  }),
}));
vi.mock("../config.js", () => ({ requireMongoUri: () => "mongodb://localhost:27017/vayo" }));

let tmpDir: string;
let originalCwd: string;

function writeSpec(spec: unknown): string {
  const file = path.join(tmpDir, "spec.json");
  writeFileSync(file, JSON.stringify(spec));
  return "spec.json";
}

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(path.join(tmpdir(), "vayo-cli-import-"));
  process.chdir(tmpDir);
  vi.clearAllMocks();
  listEndpoints.mockResolvedValue([]);
  listEnvironments.mockResolvedValue([]);
  getOverride.mockResolvedValue(null);
  listExamples.mockResolvedValue([]);
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("importCommand", () => {
  it("updates project settings from info.title/description", async () => {
    const file = writeSpec({ info: { title: "My Company API", description: "Internal API." }, paths: {} });
    await importCommand({ format: "openapi", file, version: "v1" });
    expect(updateSettings).toHaveBeenCalledWith(
      { title: "My Company API", description: "Internal API." },
      "system:cli-import",
    );
  });

  it("creates an environment per new server, skipping one whose baseUrl already exists", async () => {
    listEnvironments.mockResolvedValue([{ variables: { baseUrl: "https://already-there.example.com" } }]);
    const file = writeSpec({
      paths: {},
      servers: [{ url: "https://api.example.com", description: "Production" }, { url: "https://already-there.example.com" }],
    });
    await importCommand({ format: "openapi", file, version: "v1" });
    expect(createEnvironment).toHaveBeenCalledTimes(1);
    expect(createEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Production", variables: { baseUrl: "https://api.example.com" } }),
    );
  });

  it("applies matched overrides via upsertOverride + appendAuditLog, not the notification-creating applyOverride path", async () => {
    listEndpoints.mockResolvedValue([
      { vayoId: "ep_1", method: "GET", pathTemplate: "/api/v1/users/:id", requestSchema: null, responseSchemas: {} },
    ]);
    const file = writeSpec({
      paths: { "/api/v1/users/{id}": { get: { summary: "Fetch a user" } } },
    });

    await importCommand({ format: "openapi", file, version: "v1" });

    expect(upsertOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "ep_1.summary",
        value: "Fetch a user",
        updatedBy: "system:cli-import",
        reason: "Imported from OpenAPI spec",
      }),
    );
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "system:cli-import", actorType: "system", targetId: "ep_1", fieldPath: "summary" }),
    );
  });

  it("skips a field that already has an override, unless --overwrite is passed", async () => {
    listEndpoints.mockResolvedValue([
      { vayoId: "ep_1", method: "GET", pathTemplate: "/api/v1/users/:id", requestSchema: null, responseSchemas: {} },
    ]);
    getOverride.mockResolvedValue({ _id: "1", targetId: "ep_1.summary", value: "Human-written summary", updatedBy: "m1", updatedAt: "now", reason: null });
    const file = writeSpec({ paths: { "/api/v1/users/{id}": { get: { summary: "Imported summary" } } } });

    await importCommand({ format: "openapi", file, version: "v1" });
    expect(upsertOverride).not.toHaveBeenCalled();

    vi.clearAllMocks();
    listEndpoints.mockResolvedValue([
      { vayoId: "ep_1", method: "GET", pathTemplate: "/api/v1/users/:id", requestSchema: null, responseSchemas: {} },
    ]);
    getOverride.mockResolvedValue({ _id: "1", targetId: "ep_1.summary", value: "Human-written summary", updatedBy: "m1", updatedAt: "now", reason: null });
    listExamples.mockResolvedValue([]);

    await importCommand({ format: "openapi", file, version: "v1", overwrite: true });
    expect(upsertOverride).toHaveBeenCalledWith(expect.objectContaining({ targetId: "ep_1.summary", value: "Imported summary" }));
  });

  it("pins examples, deduping against an already-pinned one with the same status+label", async () => {
    listEndpoints.mockResolvedValue([
      { vayoId: "ep_1", method: "GET", pathTemplate: "/api/v1/users/:id", requestSchema: null, responseSchemas: {} },
    ]);
    listExamples.mockResolvedValue([
      { _id: "ex1", vayoId: "ep_1", statusCode: 200, requestBody: null, responseBody: { id: "old" }, capturedAt: "t", redacted: false, pinned: true, label: "success" },
    ]);
    const file = writeSpec({
      paths: {
        "/api/v1/users/{id}": {
          get: {
            responses: {
              "200": { content: { "application/json": { examples: { success: { value: { id: "abc" } } } } } },
              "404": { content: { "application/json": { example: { message: "not found" } } } },
            },
          },
        },
      },
    });

    await importCommand({ format: "openapi", file, version: "v1" });

    expect(pinExample).toHaveBeenCalledTimes(1);
    expect(pinExample).toHaveBeenCalledWith(
      expect.objectContaining({ vayoId: "ep_1", statusCode: 404, responseBody: { message: "not found" }, label: null }),
    );
  });

  it("reports unmatched spec operations without creating anything for them", async () => {
    listEndpoints.mockResolvedValue([]);
    const file = writeSpec({ paths: { "/api/v1/ghost": { get: { summary: "No matching endpoint" } } } });

    await importCommand({ format: "openapi", file, version: "v1" });

    expect(upsertOverride).not.toHaveBeenCalled();
    expect(pinExample).not.toHaveBeenCalled();
  });

  it("rejects a Postman Collection export with a clear error instead of silently importing nothing, without hanging", async () => {
    const file = writeSpec({
      info: { name: "My Company API", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [{ name: "Get widget", request: { method: "GET", url: { raw: "{{baseUrl}}/api/v1/widgets" } } }],
    });

    await importCommand({ format: "openapi", file, version: "v1" });

    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/Postman Collection export/));
    expect(process.exitCode).toBe(1);
    expect(process.exit).toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(upsertOverride).not.toHaveBeenCalled();
    process.exitCode = undefined;
  });
});
