import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, requireMongoUri } from "./config.js";

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(path.join(tmpdir(), "vayo-cli-config-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("throws a clear error when the config file doesn't exist", async () => {
    await expect(loadConfig("vayo.config.js")).rejects.toThrow(/config file not found/i);
  });

  it("throws when the config has no default export at all", async () => {
    writeFileSync(path.join(tmpDir, "vayo.config.js"), `export const notDefault = {};`);
    await expect(loadConfig("vayo.config.js")).rejects.toThrow(/must export a default object/i);
  });

  it("throws when appEntryPath is missing from the default export", async () => {
    writeFileSync(path.join(tmpDir, "vayo.config.js"), `export default { redact: [] };`);
    await expect(loadConfig("vayo.config.js")).rejects.toThrow(/must export a default object/i);
  });

  it("throws when appEntryPath points at a file that doesn't exist", async () => {
    writeFileSync(path.join(tmpDir, "vayo.config.js"), `export default { appEntryPath: "./missing-entry.js" };`);
    await expect(loadConfig("vayo.config.js")).rejects.toThrow(/does not exist/i);
  });

  it("loads a valid plain-JS config and resolves appEntryPath relative to cwd", async () => {
    writeFileSync(path.join(tmpDir, "app-entry.js"), `export default undefined;`);
    writeFileSync(
      path.join(tmpDir, "vayo.config.js"),
      `export default { appEntryPath: "./app-entry.js", redact: ["creditCard"] };`,
    );
    const config = await loadConfig("vayo.config.js");
    expect(config.appEntryPath).toBe("./app-entry.js");
    expect(config.redact).toEqual(["creditCard"]);
  });
});

describe("requireMongoUri", () => {
  const original = process.env.VAYO_MONGO_URI;
  afterEach(() => {
    if (original === undefined) delete process.env.VAYO_MONGO_URI;
    else process.env.VAYO_MONGO_URI = original;
  });

  it("throws when VAYO_MONGO_URI isn't set", () => {
    delete process.env.VAYO_MONGO_URI;
    expect(() => requireMongoUri()).toThrow(/VAYO_MONGO_URI is not set/i);
  });

  it("returns the configured URI", () => {
    process.env.VAYO_MONGO_URI = "mongodb://localhost:27017/vayo";
    expect(requireMongoUri()).toBe("mongodb://localhost:27017/vayo");
  });
});
