import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanCommand } from "./scan.js";

const scanProject = vi.fn();
const listApiVersions = vi.fn();
const upsertStaticResult = vi.fn();
const flagEndpointsNotInScan = vi.fn();
const autoOrganizeFolders = vi.fn();
const loadConfig = vi.fn();

vi.mock("@vayo/ast", () => ({ scanProject: (...args: unknown[]) => scanProject(...args) }));
vi.mock("@vayo/db-mongo", () => ({
  createAdapter: () => ({
    listApiVersions,
    upsertStaticResult,
    flagEndpointsNotInScan,
    autoOrganizeFolders,
  }),
}));
vi.mock("../config.js", () => ({
  loadConfig: (...args: unknown[]) => loadConfig(...args),
  requireMongoUri: () => "mongodb://localhost:27017/vayo",
}));

beforeEach(() => {
  vi.clearAllMocks();
  listApiVersions.mockResolvedValue([]);
  loadConfig.mockResolvedValue({ appEntryPath: "./entry.js" });
  upsertStaticResult.mockImplementation((route: { method: string; pathTemplate: string }, version: string) =>
    Promise.resolve({ vayoId: `${route.method}:${route.pathTemplate}:${version}` }),
  );
  flagEndpointsNotInScan.mockResolvedValue(0);
  autoOrganizeFolders.mockResolvedValue({ foldersCreated: 0, endpointsPlaced: 0 });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scanCommand", () => {
  it("upserts every route the static scan found and exits 0", async () => {
    const routeA = { method: "GET", pathTemplate: "/api/v1/widgets", group: "Widgets", middlewareChain: [], authRequiredGuess: false, scopes: [], summary: null };
    const routeB = { method: "POST", pathTemplate: "/api/v1/widgets", group: "Widgets", middlewareChain: ["requireAuth"], authRequiredGuess: true, scopes: [], summary: null };
    scanProject.mockResolvedValue({ routes: [routeA, routeB] });

    await scanCommand({});

    expect(upsertStaticResult).toHaveBeenCalledTimes(2);
    expect(upsertStaticResult).toHaveBeenNthCalledWith(1, routeA, "v1");
    expect(upsertStaticResult).toHaveBeenNthCalledWith(2, routeB, "v1");
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("auto-organizes folders once per distinct version touched, not once per route", async () => {
    scanProject.mockResolvedValue({
      routes: [
        { method: "GET", pathTemplate: "/api/v1/widgets", group: "Widgets", middlewareChain: [], authRequiredGuess: false, scopes: [], summary: null },
        { method: "GET", pathTemplate: "/api/v1/gadgets", group: "Gadgets", middlewareChain: [], authRequiredGuess: false, scopes: [], summary: null },
        { method: "GET", pathTemplate: "/api/v2/widgets", group: "Widgets", middlewareChain: [], authRequiredGuess: false, scopes: [], summary: null },
      ],
    });

    await scanCommand({ config: "custom.config.js" });

    expect(loadConfig).toHaveBeenCalledWith("custom.config.js");
    expect(autoOrganizeFolders).toHaveBeenCalledTimes(2); // v1 and v2, not 3
    expect(autoOrganizeFolders).toHaveBeenCalledWith("v1", "system:cli-scan");
    expect(autoOrganizeFolders).toHaveBeenCalledWith("v2", "system:cli-scan");
  });

  it("resolves each route's version against configured basePathPatterns rather than always defaulting to v1", async () => {
    listApiVersions.mockResolvedValue([{ version: "internal", basePathPattern: "/api/internal", status: "active" }]);
    scanProject.mockResolvedValue({
      routes: [
        { method: "GET", pathTemplate: "/api/internal/health", group: "Internal", middlewareChain: [], authRequiredGuess: false, scopes: [], summary: null },
      ],
    });

    await scanCommand({});

    expect(upsertStaticResult).toHaveBeenCalledWith(expect.anything(), "internal");
  });

  it("flags endpoints not re-found by the scan, once per distinct version, with the confirmed vayoIds for that version", async () => {
    scanProject.mockResolvedValue({
      routes: [
        { method: "GET", pathTemplate: "/api/v1/widgets", group: "Widgets", middlewareChain: [], authRequiredGuess: false, scopes: [], summary: null },
        { method: "GET", pathTemplate: "/api/v2/widgets", group: "Widgets", middlewareChain: [], authRequiredGuess: false, scopes: [], summary: null },
      ],
    });

    await scanCommand({});

    expect(flagEndpointsNotInScan).toHaveBeenCalledTimes(2);
    expect(flagEndpointsNotInScan).toHaveBeenCalledWith("v1", ["GET:/api/v1/widgets:v1"], expect.any(String));
    expect(flagEndpointsNotInScan).toHaveBeenCalledWith("v2", ["GET:/api/v2/widgets:v2"], expect.any(String));
  });

  it("passes an empty confirmed-id list for a version with routes only if none survived, without throwing", async () => {
    scanProject.mockResolvedValue({ routes: [] });

    await scanCommand({});

    expect(flagEndpointsNotInScan).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
