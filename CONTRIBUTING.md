# Contributing to Vayo

Vayo is a pnpm + TypeScript-project-references monorepo. The docs in `docs/`
are the source of truth for *why* things are built the way they are — read
the relevant doc before changing a package, not just the code.

## Setup

```bash
pnpm install
cp .env.example .env      # your own MongoDB URI — Vayo never hosts this data
pnpm build
pnpm test                 # from the repo root — see "Running tests" below
pnpm dev:demo              # apps/demo-app on http://localhost:4000
```

Requires Node 20+ and pnpm 9+ (`corepack enable` if you don't have pnpm yet).
Several packages' tests (`db-mongo`, `server`) exercise a real MongoDB
instance rather than mocking the driver — set `VAYO_MONGO_URI` (or accept the
default `mongodb://localhost:27017/vayo_test_dbmongo`) and have Mongo
reachable before running the suite.

## Running tests

```bash
pnpm test        # from the repo root — do NOT use `pnpm --filter <pkg> test`
```

The root `vitest.config.ts`'s `include` glob is root-relative
(`packages/*/src/**/*.test.ts`), so invoking vitest from inside a package
directory via `--filter` finds zero files. Always run `pnpm test` from the
repo root; `vitest run packages/<pkg>/src/index.test.ts` from the root also
works for iterating on one file.

## The non-negotiable constraints

These are in `docs/00-README.md` — repeated here because they get
re-litigated by accident otherwise. A PR that violates one of these needs a
very good reason, stated explicitly in the PR description:

1. **BYODB is absolute.** Captured data goes only to the database connection
   the user configured. No telemetry, no phone-home, ever — see
   `docs/05-security.md` §8.
2. **The exported spec is always valid OpenAPI 3.1.** Vayo-specific data
   lives only in `x-vayo-*` extension fields.
3. **Overrides are additive, never destructive.** Re-running capture or the
   AST scanner must never silently erase a manual edit.
4. **Every role check happens server-side**, in `@vayo/server` itself —
   `docs/05-security.md` §4. A hidden UI button is not a security control.
5. **Framework-agnostic boundary.** `schema-engine`, `openapi-compiler`,
   `db-mongo`, and `ui` must never import Express (or any other
   web-framework) types — only `capture-express` (and the CLI's
   app-bootstrapping adapter) may touch the *user's* framework. `@vayo/server`
   is exempt: it's Vayo's own REST API server, built on Express as its own
   implementation choice, which is a different thing from the user's captured
   app potentially being on a different stack — see
   `docs/08-packages-and-repo-structure.md`'s closing section. Enforced two
   ways, both run in CI: `pnpm lint` (a real ESLint `no-restricted-imports`
   rule, `.eslintrc.cjs`) and `pnpm check:boundaries` (a cheap,
   dependency-free grep-based guard checking the identical rule) — run
   either locally before opening a PR that touches any of those four
   packages.

## Adding a new capture-`<stack>` package (e.g. `capture-fastify`)

This is the concrete worked example these docs are written to support — if
you can do this using only the two docs below and this file, the docs are
doing their job:

1. Read `docs/04-capture-engine.md` (Step 1, the middleware contract) and
   `docs/08-packages-and-repo-structure.md`'s `@vayo/capture-express` section.
2. Your package emits exactly `@vayo/types`'s `CapturedSample` shape and
   nothing else — `@vayo/schema-engine` only ever consumes that generic,
   stack-agnostic shape, never anything Fastify-specific. Copy
   `packages/capture-express/src/index.ts`'s structure: path normalization →
   redaction → version resolution → `db.upsertEndpoint(sample)` →
   `db.appendExample(...)`.
3. Never talk to MongoDB directly — only through the `VayoDbAdapter`
   interface (`@vayo/types`), passed in via your own `CaptureOptions`. This is
   what keeps the middleware unit-testable without a real database and
   swappable across `@vayo/db-mongo` vs. a future `@vayo/db-postgres`.
4. Redaction: reuse `DEFAULT_REDACT_PATTERNS` and the deny-list convention
   from `docs/05-security.md` §2 — don't invent a new redaction scheme per
   stack.
5. Auth-requirement detection is a documentation aid, not a security
   control (`docs/05-security.md` §3) — your static pass (if you build one)
   should follow the same "OR-merge, tilt toward false positives" rule
   `schema-engine`'s `resolveAuthRequired` already implements; don't
   reimplement the merge logic itself, call it.
6. Write the same class of tests `packages/capture-express/src/index.test.ts`
   has: path-template normalization edge cases, redaction (with and without
   the optional `state` tracking param), and the full middleware wired
   against a fake `VayoDbAdapter` (see
   `packages/server/src/test-helpers/fakeDb.ts` for the established pattern
   of a full in-memory adapter, or a narrower one scoped to just the methods
   your middleware calls).
7. Add `packages/capture-fastify/` to the workspace following
   `packages/capture-express/package.json`'s shape (same dependency set
   minus `express`, plus `fastify`), and add it to the table in
   `docs/08-packages-and-repo-structure.md`.

## Code style

- No comments that restate what the code does — only ones that explain a
  non-obvious *why* (a hidden constraint, a workaround, a subtle invariant).
  Skim any existing file in this repo for the tone; it's deliberate.
- Don't add abstractions, config knobs, or error handling for scenarios that
  can't happen. Trust internal code and framework guarantees; validate only
  at real system boundaries (user input, external APIs).
- Prefer editing an existing file over creating a new one.

## Opening a PR

- Run `pnpm build && pnpm lint && pnpm test` and make sure all three are clean.
- If you touched `schema-engine`, `openapi-compiler`, `db-mongo`, `server`,
  or `ui`, also run `pnpm check:boundaries` (`pnpm lint` already covers the
  same rule, but the standalone script is a useful quick check while iterating).
- If you changed a shape in `@vayo/types`, update the matching section of
  `docs/03-data-model.md` in the same commit — they must never drift apart.
- Describe *why*, not just *what*, in the PR description — especially for
  anything that touches `docs/05-security.md`'s non-negotiables.
- If the change affects consumers of any published package (a bug fix, a new
  feature, a behavior change — not internal refactors or test-only changes),
  run `pnpm changeset` and answer its prompts; commit the generated
  `.changeset/*.md` file alongside your code change. All 9 packages version
  together (fixed versioning — see `.changeset/config.json`), so you won't be
  asked to pick per-package bump levels individually. CI maintains a running
  "Version Packages" PR from whatever changesets have accumulated on `main`;
  `npm publish` itself stays a separate, manual `pnpm release` run locally,
  never automatic.
