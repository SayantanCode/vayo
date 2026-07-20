import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCommand } from "./init.js";

const runMigrations = vi.fn().mockResolvedValue(undefined);
vi.mock("@vayo/db-mongo", () => ({ runMigrations: (...args: unknown[]) => runMigrations(...args) }));

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(path.join(tmpdir(), "vayo-cli-init-"));
  process.chdir(tmpDir);
  runMigrations.mockClear();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("initCommand", () => {
  it("writes .env, vayo.config.js, an ast-entry placeholder, and runs migrations, non-interactively", async () => {
    await initCommand({ mongoUri: "mongodb://localhost:27017/vayo", appEntryPath: "./vayo.ast-entry.js" });

    const envContent = readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(envContent).toContain("VAYO_MONGO_URI=mongodb://localhost:27017/vayo");
    expect(envContent).toContain("VAYO_SESSION_SECRET=");
    expect(envContent).toContain("VAYO_SERVER_PORT=4100");

    const configContent = readFileSync(path.join(tmpDir, "vayo.config.js"), "utf-8");
    expect(configContent).toContain(`appEntryPath: "./vayo.ast-entry.js"`);

    expect(existsSync(path.join(tmpDir, "vayo.ast-entry.js"))).toBe(true);
    expect(runMigrations).toHaveBeenCalledWith("mongodb://localhost:27017/vayo");
  });

  it("refuses to overwrite an existing vayo.config.js without --force", async () => {
    writeFileSync(path.join(tmpDir, "vayo.config.js"), "export default { appEntryPath: './x.js' };");

    await expect(
      initCommand({ mongoUri: "mongodb://localhost:27017/vayo", appEntryPath: "./vayo.ast-entry.js" }),
    ).rejects.toThrow(/already exists/i);
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it("overwrites vayo.config.js when --force is passed", async () => {
    writeFileSync(path.join(tmpDir, "vayo.config.js"), "export default { appEntryPath: './old.js' };");

    await initCommand({
      force: true,
      mongoUri: "mongodb://localhost:27017/vayo",
      appEntryPath: "./vayo.ast-entry.js",
    });

    const configContent = readFileSync(path.join(tmpDir, "vayo.config.js"), "utf-8");
    expect(configContent).toContain(`appEntryPath: "./vayo.ast-entry.js"`);
  });

  it("never overwrites an existing appEntryPath file — only creates it when missing", async () => {
    writeFileSync(path.join(tmpDir, "vayo.ast-entry.js"), "export default myRealApp;");

    await initCommand({ mongoUri: "mongodb://localhost:27017/vayo", appEntryPath: "./vayo.ast-entry.js" });

    const entryContent = readFileSync(path.join(tmpDir, "vayo.ast-entry.js"), "utf-8");
    expect(entryContent).toBe("export default myRealApp;"); // untouched
  });

  it("merges .env additively — never overwrites a value the user already set", async () => {
    writeFileSync(path.join(tmpDir, ".env"), "VAYO_MONGO_URI=mongodb://localhost:27017/already-set\nMY_OWN_VAR=keep-me\n");

    await initCommand({ mongoUri: "mongodb://localhost:27017/vayo", appEntryPath: "./vayo.ast-entry.js" });

    const envContent = readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(envContent).toContain("VAYO_MONGO_URI=mongodb://localhost:27017/already-set"); // untouched
    expect(envContent).toContain("MY_OWN_VAR=keep-me"); // untouched
    expect(envContent).toContain("VAYO_SESSION_SECRET="); // newly added
    expect(envContent).toContain("VAYO_SERVER_PORT=4100"); // newly added
  });

  // Real bug this guards against: vayo.config.js was always generated with
  // `export default`, which crashes `vayo scan` outright
  // (`Unexpected token 'export'`) the moment it runs against a plain
  // CommonJS consumer project — the more common case, not an edge case —
  // because Node treats a plain .js file as CommonJS unless the nearest
  // package.json says `"type": "module"`.
  describe("generated file syntax matches the consumer project's module type", () => {
    it("uses module.exports when the consumer has no package.json at all", async () => {
      await initCommand({ mongoUri: "mongodb://localhost:27017/vayo", appEntryPath: "./vayo.ast-entry.js" });

      const configContent = readFileSync(path.join(tmpDir, "vayo.config.js"), "utf-8");
      expect(configContent).toContain("module.exports = {");
      expect(configContent).not.toContain("export default {");

      const entryContent = readFileSync(path.join(tmpDir, "vayo.ast-entry.js"), "utf-8");
      expect(entryContent).toContain("module.exports = undefined;");
    });

    it("uses module.exports when the consumer's package.json omits \"type\" (CommonJS default)", async () => {
      writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "consumer-app" }));

      await initCommand({ mongoUri: "mongodb://localhost:27017/vayo", appEntryPath: "./vayo.ast-entry.js" });

      const configContent = readFileSync(path.join(tmpDir, "vayo.config.js"), "utf-8");
      expect(configContent).toContain("module.exports = {");
    });

    it("uses export default when the consumer's package.json declares \"type\": \"module\"", async () => {
      writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "consumer-app", type: "module" }));

      await initCommand({ mongoUri: "mongodb://localhost:27017/vayo", appEntryPath: "./vayo.ast-entry.js" });

      const configContent = readFileSync(path.join(tmpDir, "vayo.config.js"), "utf-8");
      expect(configContent).toContain("export default {");
      expect(configContent).not.toContain("module.exports");

      const entryContent = readFileSync(path.join(tmpDir, "vayo.ast-entry.js"), "utf-8");
      expect(entryContent).toContain("export default undefined;");
    });

    it("prints a require()-based wiring snippet for CommonJS, matching the generated files", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await initCommand({ mongoUri: "mongodb://localhost:27017/vayo", appEntryPath: "./vayo.ast-entry.js" });

      const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(printed).toContain('const { capture } = require("@vayo/capture-express");');
      expect(printed).not.toContain('import { capture } from "@vayo/capture-express";');
      logSpy.mockRestore();
    });

    it("prints an import-based wiring snippet for an ESM consumer project", async () => {
      writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "consumer-app", type: "module" }));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await initCommand({ mongoUri: "mongodb://localhost:27017/vayo", appEntryPath: "./vayo.ast-entry.js" });

      const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(printed).toContain('import { capture } from "@vayo/capture-express";');
      logSpy.mockRestore();
    });
  });
});
