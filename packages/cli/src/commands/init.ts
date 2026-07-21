// @vayo/cli — vayo init: one-time project setup. Never edits the user's
// existing source files — only creates new ones (.env entries,
// vayo.config.js, a starter AST-entry file) and prints a wiring snippet for
// the one thing it genuinely can't do safely: mounting capture() into code
// it doesn't own.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import prompts from "prompts";
import { runMigrations } from "@vayo/db-mongo";
import { DEFAULT_CONFIG_PATH } from "../config.js";

/** Whether the CONSUMER's project is set up for ESM `.js` files
 * (package.json `"type": "module"`) or CommonJS (the default when that
 * field is absent — still how most real Express apps are written). Every
 * file this command generates, and the snippet it prints, must match
 * whichever one the target project actually uses — `vayo.config.js`
 * hard-coded to `export default` was a real, discovered bug: it crashed
 * `vayo scan` outright (`Unexpected token 'export'`) the moment it ran
 * against a plain CommonJS project, which is the more common case, not an
 * edge case. */
function isEsmProject(): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8")) as { type?: string };
    return pkg.type === "module";
  } catch {
    return false; // no package.json readable — CommonJS is the safe default
  }
}

function mergeEnvFile(envPath: string, entries: Record<string, string>): void {
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const existingKeys = new Set(
    existing
      .split("\n")
      .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
      .filter((key): key is string => Boolean(key)),
  );
  const linesToAdd = Object.entries(entries)
    .filter(([key]) => !existingKeys.has(key))
    .map(([key, value]) => `${key}=${value}`);
  if (linesToAdd.length === 0) return;
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(envPath, existing + separator + linesToAdd.join("\n") + "\n");
}

export interface InitOptions {
  force?: boolean;
  /** Non-interactive escape hatch (CI, Docker builds, or just piping
   * answers) — when both are passed, the interactive prompts are skipped
   * entirely. Discovered as a real need while verifying this command:
   * `prompts`'s readline-style editing doesn't handle piped stdin the way
   * a plain question/answer prompt would. */
  mongoUri?: string;
  appEntryPath?: string;
}

export async function initCommand(options: InitOptions): Promise<void> {
  const configPath = path.resolve(process.cwd(), DEFAULT_CONFIG_PATH);
  if (existsSync(configPath) && !options.force) {
    throw new Error(`vayo: ${configPath} already exists — pass --force to overwrite.`);
  }

  let mongoUri = options.mongoUri;
  let appEntryPath = options.appEntryPath;
  if (!mongoUri || !appEntryPath) {
    const answers = await prompts([
      {
        type: "text",
        name: "mongoUri",
        message: "MongoDB connection string (your own database — Vayo never hosts this data)",
        initial: "mongodb://localhost:27017/vayo",
      },
      {
        type: "text",
        name: "appEntryPath",
        message: "Where should the AST-entry file (the one Vayo statically scans) live?",
        initial: "./vayo.ast-entry.js",
      },
    ]);
    mongoUri ??= answers.mongoUri;
    appEntryPath ??= answers.appEntryPath;
  }
  if (!mongoUri || !appEntryPath) {
    console.log("vayo: init cancelled.");
    return;
  }

  const envPath = path.resolve(process.cwd(), ".env");
  mergeEnvFile(envPath, {
    VAYO_MONGO_URI: mongoUri,
    VAYO_SESSION_SECRET: randomBytes(32).toString("hex"),
    VAYO_SERVER_PORT: "4100",
  });
  console.log(`vayo: wrote ${envPath}`);

  const esm = isEsmProject();

  writeFileSync(
    configPath,
    esm
      ? `/** @type {import('@vayo/ast').VayoConfig} */
export default {
  appEntryPath: ${JSON.stringify(appEntryPath)},
  // authMiddlewarePatterns: ["verifyJWT"],  // add your own auth middleware's function name(s)
  // scopeCheckPatterns: ["hasPermission"],  // add your own scope-check function name(s)
  // redact: [/creditCard/i],                // additional field-name patterns to redact
};
`
      : `/** @type {import('@vayo/ast').VayoConfig} */
module.exports = {
  appEntryPath: ${JSON.stringify(appEntryPath)},
  // authMiddlewarePatterns: ["verifyJWT"],  // add your own auth middleware's function name(s)
  // scopeCheckPatterns: ["hasPermission"],  // add your own scope-check function name(s)
  // redact: [/creditCard/i],                // additional field-name patterns to redact
};
`,
  );
  console.log(`vayo: wrote ${configPath}`);

  const entryAbsPath = path.resolve(process.cwd(), appEntryPath);
  if (existsSync(entryAbsPath)) {
    console.log(`vayo: ${entryAbsPath} already exists — left it alone.`);
  } else {
    writeFileSync(
      entryAbsPath,
      esm
        ? `// Vayo reads this file to statically analyze your routes — no live
// traffic needed. Export your app WITHOUT Vayo's own capture() middleware
// mounted (see the capture() wiring step "vayo init" printed below);
// express-list-endpoints must see only your own routes/middleware.

// import { createApp } from "./path/to/your-app-factory.js";
// export default createApp();

export default undefined; // <- replace with your bootstrapped Express app
`
        : `// Vayo reads this file to statically analyze your routes — no live
// traffic needed. Export your app WITHOUT Vayo's own capture() middleware
// mounted (see the capture() wiring step "vayo init" printed below);
// express-list-endpoints must see only your own routes/middleware.

// const createApp = require("./path/to/your-app-factory.js");
// module.exports = createApp();

module.exports = undefined; // <- replace with your bootstrapped Express app
`,
    );
    console.log(`vayo: wrote ${entryAbsPath} (placeholder — see the comments inside)`);
  }

  await runMigrations(mongoUri);
  console.log("vayo: ran migrations — vayo_* collections are ready.");

  const wiringSnippet = esm
    ? `       import { capture } from "@vayo/capture-express";
       import { createAdapter } from "@vayo/db-mongo";
       const db = createAdapter(process.env.VAYO_MONGO_URI);
       app.use(capture({ db }));`
    : `       const { capture } = require("@vayo/capture-express");
       const { createAdapter } = require("@vayo/db-mongo");
       const db = createAdapter(process.env.VAYO_MONGO_URI);
       app.use(capture({ db }));`;

  const embedSnippet = esm
    ? `       import { createServer } from "@vayo/server";
       const { app: vayoApp } = createServer({ db, mountPath: "/docs", httpServer: server });
       app.use(vayoApp); // docs now live at http://localhost:<your-port>/docs`
    : `       const { createServer } = require("@vayo/server");
       const { app: vayoApp } = createServer({ db, mountPath: "/docs", httpServer: server });
       app.use(vayoApp); // docs now live at http://localhost:<your-port>/docs`;

  console.log(`
Next steps:

  1. Edit ${appEntryPath} to export your real, already-configured
     Express app (see the comments inside).

  2. Wherever you currently call app.listen(), mount Vayo's capture
     middleware on your real app (not the file above) — and make sure
     VAYO_MONGO_URI is actually loaded into process.env there too (e.g.
     require("dotenv").config(), or your own env-loading setup):

${wiringSnippet}

  3. Run "vayo scan" once your app is wired, then generate some real traffic.

  4. If you're using standalone auth (no authMiddleware of your own), create
     your first login with "vayo create-owner" — there's no other way in.

  5. Browse your docs. Two ways to do this — pick whichever fits your setup:

     a) Standalone, on their own port — no code changes, run this whenever
        you want the docs up:

           vayo serve

     b) Embedded in your own app's existing port, alongside your real API
        (needs your app to already be listening on an http.Server you have
        a reference to, called \`server\` below — the same one \`app.listen()\`
        returns):

${embedSnippet}
`);
}
