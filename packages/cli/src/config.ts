// vayo — loads the user's vayo.config.js. Plain JS/ESM, not .ts: the
// CLI ships as compiled JS with no TS loader bundled, and a bare import() of
// a .js file needs none — the same mechanism @vayo/ast's scanProject
// already uses successfully for the user's own app entry.

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { VayoConfig } from "@vayo/ast";

export const DEFAULT_CONFIG_PATH = "vayo.config.js";

export async function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Promise<VayoConfig> {
  const absConfigPath = path.resolve(process.cwd(), configPath);
  if (!existsSync(absConfigPath)) {
    throw new Error(`vayo: config file not found at ${absConfigPath} — run "vayo init" first.`);
  }

  const mod = (await import(pathToFileURL(absConfigPath).href)) as { default?: unknown };
  const config = mod.default as VayoConfig | undefined;
  if (!config || typeof config.appEntryPath !== "string") {
    throw new Error(`vayo: ${absConfigPath} must export a default object with at least { appEntryPath }.`);
  }

  const entryAbsPath = path.resolve(process.cwd(), config.appEntryPath);
  if (!existsSync(entryAbsPath)) {
    throw new Error(
      `vayo: appEntryPath "${config.appEntryPath}" (resolved to ${entryAbsPath}) does not exist — check vayo.config.js.`,
    );
  }

  return config;
}

export function requireMongoUri(): string {
  const mongoUri = process.env.VAYO_MONGO_URI;
  if (!mongoUri) {
    throw new Error('vayo: VAYO_MONGO_URI is not set — run "vayo init" or set it in your .env.');
  }
  return mongoUri;
}
