#!/usr/bin/env node
// vayo — vayo init / scan / export / serve / diff.
// docs/08-packages-and-repo-structure.md.

import { config as loadDotenv } from "dotenv";
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { scanCommand } from "./commands/scan.js";
import { exportCommand } from "./commands/export.js";
import { serveCommand } from "./commands/serve.js";
import { diffCommand } from "./commands/diff.js";
import { createOwnerCommand } from "./commands/create-owner.js";

loadDotenv();

const program = new Command();
program.name("vayo").description("Self-hosted, auto-generating API docs for Node/Express (docs/00-README.md).");

program
  .command("init")
  .description("Set up a new Vayo project: .env, vayo.config.js, an AST-entry starter file, and DB migrations")
  .option("--force", "overwrite an existing vayo.config.js")
  .option("--mongo-uri <uri>", "skip the interactive prompt (also needs --app-entry-path)")
  .option("--app-entry-path <path>", "skip the interactive prompt (also needs --mongo-uri)")
  .action((opts) =>
    initCommand({ force: opts.force, mongoUri: opts.mongoUri, appEntryPath: opts.appEntryPath }),
  );

program
  .command("scan")
  .description("Run the static AST pass and merge results into vayo_endpoints")
  .option("--config <path>", "path to vayo.config.js")
  .action((opts) => scanCommand({ config: opts.config }));

program
  .command("export")
  .description("Compile and write the resolved spec for a version")
  .option("--version <version>", "API version to export", "v1")
  .option("--format <format>", "openapi or postman", "openapi")
  .option("--out <path>", "output file path (defaults to openapi.json / postman-collection.<version>.json)")
  .action((opts) => exportCommand({ version: opts.version, format: opts.format, out: opts.out }));

program
  .command("create-owner")
  .description("Create the first team member account (owner role) — needed once before standalone auth mode has anyone who can log in")
  .option("--email <email>", "skip the interactive prompt (also needs --name and --password)")
  .option("--name <name>", "skip the interactive prompt (also needs --email and --password)")
  .option("--password <password>", "skip the interactive prompt (also needs --email and --name)")
  .action((opts) => createOwnerCommand({ email: opts.email, name: opts.name, password: opts.password }));

program
  .command("serve")
  .description("Run @vayo/server standalone against your MongoDB (standalone auth mode only)")
  .option("--port <port>", "port to listen on", "4100")
  .option("--mount <path>", "mount path", "/vayo")
  .action((opts) => serveCommand({ port: opts.port, mount: opts.mount }));

program
  .command("diff <from> <to>")
  .description("Diff two API versions — added/removed/changed operations")
  .option("--fail-on-breaking", "exit 1 if there are any removed or changed operations")
  .action((from, to, opts) => diffCommand(from, to, { failOnBreaking: opts.failOnBreaking }));

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
