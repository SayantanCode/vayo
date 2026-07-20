# Vayo — Technical Build Documentation

This is the engineering reference for Vayo: a self-hosted, auto-generating API
documentation system for MERN/Express APIs, with real-time team collaboration and
zero hosting cost to the maintainer (bring-your-own-database).

These documents are the source of truth for implementation — written for you
and for any future contributor picking this up.

## How to navigate these docs

Each document below is scoped to one concern. When you (or a contributor) want to
build or modify a specific package, start with:

1. `08-packages-and-repo-structure.md` — for the package's exact location, exports, and contracts
2. The one or two concern-specific docs relevant to that package (e.g. building the capture middleware → read `04-capture-engine.md` + `03-data-model.md`)
3. `05-security.md` — always include this; every package touches either captured data, auth, or both

## Document index

| Doc | Covers |
|---|---|
| [01-vision-and-market.md](01-vision-and-market.md) | Why this exists, who it's for, competitive landscape as of mid-2026 |
| [02-architecture.md](02-architecture.md) | System diagram, build-time flow, runtime flow |
| [03-data-model.md](03-data-model.md) | Every MongoDB collection, field, and index |
| [04-capture-engine.md](04-capture-engine.md) | How auto-discovery actually works — algorithm + libraries |
| [05-security.md](05-security.md) | Threat model, redaction rules, auth, RBAC enforcement |
| [06-realtime-collaboration.md](06-realtime-collaboration.md) | Socket.IO architecture for presence + live comments |
| [07-api-versioning.md](07-api-versioning.md) | How versions coexist and diff against each other |
| [08-packages-and-repo-structure.md](08-packages-and-repo-structure.md) | Monorepo layout, every package's public contract |
| [09-roadmap.md](09-roadmap.md) | Build order, milestones, definition of done for each |

## Non-negotiable design constraints

These are decided and should not be re-litigated per-package. If a future design
doc contradicts one of these, the future doc is wrong, not this list.

1. **BYODB is absolute.** Vayo never stores a user's data on infrastructure we
   operate. Every package that persists anything writes to the database
   connection the user configured.
2. **The exported spec is always valid OpenAPI 3.1.** Vayo-specific data lives
   in `x-vayo-*` extension fields or is referenced by ID from the DB — never by
   inventing new top-level OpenAPI keys.
3. **Overrides are additive, never destructive.** Re-running capture or the AST
   scanner must never silently erase a manual edit. See `03-data-model.md`.
4. **Every role check happens server-side.** The React UI hiding a button is a UX
   nicety, not a security control. See `05-security.md` §4.
5. **v1 targets Node.js + Express only.** Any code that assumes a specific web
   framework belongs in `packages/capture-express`, never in
   `packages/schema-engine`, `packages/openapi-compiler`, or `packages/ui` — those
   three must stay framework-agnostic so a future `capture-fastify` or
   `capture-nestjs` package can reuse them untouched.

## Stack decisions locked for v1

- **Language:** TypeScript across the whole monorepo.
- **Package manager / workspace:** pnpm workspaces (`pnpm-workspace.yaml`), plain
  TypeScript project references for build ordering. No Turborepo/Nx yet — the
  project is one person deep and that tooling earns its keep once build times or
  contributor count justify it, not before.
- **Primary database:** MongoDB (native driver, not Mongoose — see
  `03-data-model.md` for why).
- **UI:** fully custom React, schema-driven, no third-party renderer dependency.
- **Realtime:** Socket.IO, embedded in `@vayo/server`, single process for v1.
