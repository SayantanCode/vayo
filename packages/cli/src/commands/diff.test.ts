import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diffCommand } from "./diff.js";

const listApiVersions = vi.fn();
const listEndpoints = vi.fn();
const listOverrides = vi.fn();
const resolveEndpoint = vi.fn();
const compile = vi.fn();
const diffSpecs = vi.fn();

vi.mock("@vayo/db-mongo", () => ({
  createAdapter: () => ({ listApiVersions, listEndpoints, listOverrides }),
}));
vi.mock("@vayo/schema-engine", () => ({ resolveEndpoint: (...args: unknown[]) => resolveEndpoint(...args) }));
vi.mock("@vayo/openapi-compiler", () => ({
  compile: (...args: unknown[]) => compile(...args),
  diffSpecs: (...args: unknown[]) => diffSpecs(...args),
}));
vi.mock("../config.js", () => ({ requireMongoUri: () => "mongodb://localhost:27017/vayo" }));

beforeEach(() => {
  vi.clearAllMocks();
  resolveEndpoint.mockImplementation((endpoint: unknown) => endpoint);
  listApiVersions.mockResolvedValue([
    { version: "v1", basePathPattern: "/api/v1" },
    { version: "v2", basePathPattern: "/api/v2" },
  ]);
  listEndpoints.mockResolvedValue([]);
  listOverrides.mockResolvedValue([]);
  compile.mockResolvedValue({ paths: {} });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("diffCommand", () => {
  it("compiles both versions with their basePathPattern stripped, and exits without setting exitCode when nothing breaking changed", async () => {
    diffSpecs.mockReturnValue({ added: [], removed: [], changed: [] });

    await diffCommand("v1", "v2", {});

    expect(diffSpecs).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      stripPrefixA: "/api/v1",
      stripPrefixB: "/api/v2",
    });
    expect(process.exitCode).toBeUndefined();
    expect(process.exit).toHaveBeenCalledWith();
  });

  it("does not set exitCode=1 for a removed/changed operation when --fail-on-breaking wasn't passed", async () => {
    diffSpecs.mockReturnValue({ added: [], removed: [{ method: "DELETE", path: "/widgets" }], changed: [] });

    await diffCommand("v1", "v2", {});

    expect(process.exitCode).toBeUndefined();
  });

  it("sets exitCode=1 when --fail-on-breaking is passed and something was removed", async () => {
    diffSpecs.mockReturnValue({ added: [], removed: [{ method: "DELETE", path: "/widgets" }], changed: [] });

    await diffCommand("v1", "v2", { failOnBreaking: true });

    expect(process.exitCode).toBe(1);
  });

  it("sets exitCode=1 when --fail-on-breaking is passed and something changed, even with nothing removed", async () => {
    diffSpecs.mockReturnValue({
      added: [],
      removed: [],
      changed: [{ operation: { method: "PATCH", path: "/widgets/{id}" }, changes: ["response 200 gained a field"] }],
    });

    await diffCommand("v1", "v2", { failOnBreaking: true });

    expect(process.exitCode).toBe(1);
  });

  it("does not fail on purely additive changes even with --fail-on-breaking", async () => {
    diffSpecs.mockReturnValue({ added: [{ method: "POST", path: "/widgets" }], removed: [], changed: [] });

    await diffCommand("v1", "v2", { failOnBreaking: true });

    expect(process.exitCode).toBeUndefined();
  });
});
