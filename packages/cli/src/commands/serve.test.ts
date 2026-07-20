import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveCommand } from "./serve.js";

const createServer = vi.fn();
const listen = vi.fn((_port: number, cb?: () => void) => cb?.());

vi.mock("@vayo/server", () => ({ createServer: (...args: unknown[]) => createServer(...args) }));
vi.mock("@vayo/db-mongo", () => ({ createAdapter: (uri: string) => ({ __mongoUri: uri }) }));
vi.mock("../config.js", () => ({ requireMongoUri: () => "mongodb://localhost:27017/vayo" }));

const originalSecret = process.env.VAYO_SESSION_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
  createServer.mockReturnValue({ httpServer: { listen } });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.VAYO_SESSION_SECRET;
  else process.env.VAYO_SESSION_SECRET = originalSecret;
  vi.restoreAllMocks();
});

describe("serveCommand", () => {
  it("refuses to start without VAYO_SESSION_SECRET set (standalone auth mode needs it)", async () => {
    delete process.env.VAYO_SESSION_SECRET;
    await expect(serveCommand({ port: "4100", mount: "/vayo" })).rejects.toThrow(/VAYO_SESSION_SECRET is not set/i);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("wires the db adapter and mount path into createServer, and listens on the given port", async () => {
    process.env.VAYO_SESSION_SECRET = "test-secret";
    await serveCommand({ port: "4100", mount: "/vayo" });

    expect(createServer).toHaveBeenCalledWith({ db: { __mongoUri: "mongodb://localhost:27017/vayo" }, mountPath: "/vayo" });
    expect(listen).toHaveBeenCalledWith(4100, expect.any(Function));
  });
});
