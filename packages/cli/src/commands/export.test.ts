import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportCommand } from "./export.js";

const listEndpoints = vi.fn();
const listOverrides = vi.fn();
const listFolders = vi.fn();
const getTestScript = vi.fn();
const listExamples = vi.fn();
const resolveEndpoint = vi.fn();
const compile = vi.fn();
const compilePostmanCollection = vi.fn();

vi.mock("@vayo/db-mongo", () => ({
  createAdapter: () => ({ listEndpoints, listOverrides, listFolders, getTestScript, listExamples }),
}));
vi.mock("@vayo/schema-engine", () => ({ resolveEndpoint: (...args: unknown[]) => resolveEndpoint(...args) }));
vi.mock("@vayo/openapi-compiler", () => ({ compile: (...args: unknown[]) => compile(...args) }));
vi.mock("@vayo/server", () => ({ compilePostmanCollection: (...args: unknown[]) => compilePostmanCollection(...args) }));
vi.mock("../config.js", () => ({ requireMongoUri: () => "mongodb://localhost:27017/vayo" }));

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(path.join(tmpdir(), "vayo-cli-export-"));
  process.chdir(tmpDir);
  vi.clearAllMocks();
  resolveEndpoint.mockImplementation((endpoint: unknown) => endpoint);
  listOverrides.mockResolvedValue([]);
  listFolders.mockResolvedValue([]);
  getTestScript.mockResolvedValue(null);
  listExamples.mockResolvedValue([]);
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("exportCommand — openapi format", () => {
  it("compiles the resolved endpoints and writes openapi.json by default", async () => {
    listEndpoints.mockResolvedValue([{ vayoId: "ep_1" }]);
    compile.mockResolvedValue({ paths: { "/api/v1/widgets": {} } });

    await exportCommand({ version: "v1", format: "openapi" });

    expect(compile).toHaveBeenCalledWith([{ vayoId: "ep_1" }], "v1");
    const written = JSON.parse(readFileSync(path.join(tmpDir, "openapi.json"), "utf-8"));
    expect(written.paths).toEqual({ "/api/v1/widgets": {} });
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("writes to a custom --out path when given", async () => {
    listEndpoints.mockResolvedValue([]);
    compile.mockResolvedValue({ paths: {} });

    await exportCommand({ version: "v1", format: "openapi", out: "custom-spec.json" });

    expect(readFileSync(path.join(tmpDir, "custom-spec.json"), "utf-8")).toContain('"paths"');
  });
});

describe("exportCommand — postman format", () => {
  it("gathers folders, test scripts, and pinned examples before compiling the collection", async () => {
    listEndpoints.mockResolvedValue([{ vayoId: "ep_1", folderId: "folder_1" }]);
    listFolders.mockResolvedValue([{ _id: "folder_1", name: "Widgets" }]);
    getTestScript.mockResolvedValue({ vayoId: "ep_1", preRequestScript: "", testScript: "" });
    listExamples.mockResolvedValue([
      { vayoId: "ep_1", pinned: true, statusCode: 200 },
      { vayoId: "ep_1", pinned: false, statusCode: 500 }, // not pinned — must be filtered out
    ]);
    compilePostmanCollection.mockReturnValue({ item: [{ name: "Widgets" }] });

    await exportCommand({ version: "v1", format: "postman" });

    const [name, resolved, folders, placements, testScripts, pinnedExamples] = compilePostmanCollection.mock.calls[0]!;
    expect(name).toBe("Vayo API (v1)");
    expect(resolved).toEqual([{ vayoId: "ep_1", folderId: "folder_1" }]);
    expect(folders).toEqual([{ _id: "folder_1", name: "Widgets" }]);
    expect(placements.get("ep_1")).toBe("folder_1");
    expect(testScripts.get("ep_1")).toEqual({ vayoId: "ep_1", preRequestScript: "", testScript: "" });
    expect(pinnedExamples.get("ep_1")).toEqual([{ vayoId: "ep_1", pinned: true, statusCode: 200 }]);

    const written = JSON.parse(readFileSync(path.join(tmpDir, "postman-collection.v1.json"), "utf-8"));
    expect(written.item).toEqual([{ name: "Widgets" }]);
  });
});
