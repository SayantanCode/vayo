#!/usr/bin/env node
// Cheap CI/pre-PR guard for the framework-agnostic boundary
// (docs/08-packages-and-repo-structure.md's closing section): fails if
// schema-engine, openapi-compiler, db-mongo, or ui import "express" or
// "@vayo/capture-express". @vayo/server is deliberately exempt — it's
// Vayo's own REST API server, built on Express as its own implementation
// choice, not a place where the *user's* app framework could leak in.
//
// Plain recursive fs walk rather than fs.globSync — that API needs Node 22+,
// and this repo targets Node 20+ (package.json engines).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const GUARDED_PACKAGES = ["schema-engine", "openapi-compiler", "db-mongo", "ui"];
const FORBIDDEN_IMPORT_PATTERN = /from\s+["'](express|@vayo\/capture-express)["']/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const violations = [];

for (const pkg of GUARDED_PACKAGES) {
  const srcDir = join(process.cwd(), "packages", pkg, "src");
  for (const file of walk(srcDir)) {
    const content = readFileSync(file, "utf-8");
    const match = content.match(FORBIDDEN_IMPORT_PATTERN);
    if (match) violations.push(`${file}: imports "${match[1]}"`);
  }
}

if (violations.length > 0) {
  console.error("Framework-agnostic boundary violated (docs/08-packages-and-repo-structure.md):\n");
  for (const v of violations) console.error(`  ${v}`);
  console.error(`\n${GUARDED_PACKAGES.join(", ")} must never import express or @vayo/capture-express.`);
  process.exit(1);
}

console.log(`check:boundaries — clean (${GUARDED_PACKAGES.join(", ")} stay framework-agnostic).`);
