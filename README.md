# Vayo

Self-hosted, auto-generating API documentation for MERN/Express APIs.
Zero manual annotation. Bring-your-own-database. Free real-time team
collaboration, because Vayo never hosts your data itself.

**Start here:** [`docs/00-README.md`](docs/00-README.md) — the full technical
plan. Contributing? See [`CONTRIBUTING.md`](CONTRIBUTING.md). Licensed under
[MIT](LICENSE).

## Status

M1–M6 built and tested: capture (Express middleware + static AST pass,
including static Zod request-schema extraction), schema inference and
merge, the OpenAPI 3.1 compiler with overrides, the REST API with full
RBAC and both auth modes, the Socket.IO realtime gateway, the complete
five-tab React UI (Details, Flowmap, History, Team Chat, Try It Now — the
latter a full Postman-parity request client), API versioning + spec
diffing, an in-app notification center, and the `vayo` CLI
(`init`/`scan`/`export`/`create-owner`/`serve`/`diff`).

502 tests across all 9 packages (`pnpm test` from the repo root).
`docs/09-roadmap.md` tracks the full build sequence and each milestone's
"done when" bar; M7 (this launch-readiness pass) is in progress — the
packages stay `"private": true` in each `package.json` until npm publish is
made as an explicit, separate decision. Everything below has been verified
by installing packed tarballs into a real, separate project via plain
`npm install` — not just run inside this workspace.

## Using Vayo in your own project

This is what actually happens once you point Vayo at a real Express app.
Nothing here is simulated — it's the exact sequence used to verify this
release, replayed against a throwaway Express app outside this repo.

**Prerequisites:** Node 20+, your own MongoDB instance (Vayo never hosts
data — BYODB is absolute, see `docs/00-README.md`), and **Express 4.x**.
`@vayo/capture-express` pins `peerDependencies: { express: "^4.19.0" }` —
v1 targets Express 4 only. A bare `npm install express` in a fresh project
resolves to Express 5 today, which this range rejects; install
`express@^4.19.0` explicitly. If something upstream of `capture()` ends up
pulling in Express 5 anyway (`--force`/`--legacy-peer-deps`), `capture()`
itself checks the actually-installed version at startup and logs a clear
`console.warn` rather than failing silently with wrong route paths.

Until these packages are published to npm, build the tarballs yourself from
a checkout of this repo and install them into your own project by path:

```bash
# inside this repo
pnpm install && pnpm build
for pkg in types ast schema-engine openapi-compiler db-mongo capture-express server ui cli; do
  pnpm --filter @vayo/$pkg pack --pack-destination /some/tarball/dir
done
```

```bash
# inside YOUR project
npm install /some/tarball/dir/vayo-*.tgz express@^4.19.0
```

Once published, this collapses to `npm install @vayo/capture-express
@vayo/db-mongo @vayo/cli express@^4`.

### 1. Initialize

```bash
npx vayo init
```

Prompts for your MongoDB URI and the path to a file that will export your
bootstrapped Express app for static analysis. Writes `.env`
(`VAYO_MONGO_URI`, a generated `VAYO_SESSION_SECRET`, `VAYO_SERVER_PORT`),
`vayo.config.js`, and a placeholder AST-entry file — matching your
project's own CommonJS/ESM style automatically. It never touches your
existing source files.

### 2. Wire capture into your real app

`vayo init` prints this exact snippet — mount it wherever you currently
call `app.listen()`:

```js
const { capture } = require("@vayo/capture-express"); // or `import` for ESM
const { createAdapter } = require("@vayo/db-mongo");
const db = createAdapter(process.env.VAYO_MONGO_URI);
app.use(capture({ db }));
```

Make sure `.env` is actually loaded into `process.env` here too (e.g.
`require("dotenv").config()`). This middleware only ever writes to *your*
MongoDB — see `docs/05-security.md` for exactly what it redacts by default
(passwords, tokens, credit card–shaped fields) before anything is stored.

### 3. Scan and capture real traffic

```bash
npx vayo scan   # static AST pass — finds every route + middleware chain, no traffic needed
```

Then hit your app's endpoints normally (curl, your test suite, real
traffic) — `capture()` merges runtime request/response shapes with what
the static scan found.

### 4. Create your first login

```bash
npx vayo create-owner --email you@example.com --name "Your Name" --password "..."
```

Standalone auth mode manages its own team members — there's no signup
screen (a hidden signup form would be a way for a stranger with network
access to your docs UI to grant themselves access), so this one-time
command is how the *first* account gets created. Everyone after that is
added via the in-app "Team" invite flow (`owner`-role only). Skip this
entirely if you're using **delegated auth** instead — validating your
existing app's session/JWT via a supplied `authMiddleware` function, so
Vayo never sees a second set of passwords (`docs/05-security.md` §5).

### 5. Serve your docs

```bash
npx vayo serve --port 4100
```

Browse to `http://localhost:4100/vayo`, sign in, and you'll see every
endpoint `vayo scan` found — inferred request/response schemas, working
example values, and a live request client, with zero annotations written
by hand.

### What you actually get, tab by tab

- **Details** — the resolved OpenAPI schema per endpoint (request/response,
  auth requirements, path/query params), with manual overrides layered on
  top of what capture inferred — overrides are additive and survive
  re-scanning, never silently erased.
- **Try It Now** — a full Postman-parity request client: pick an
  environment, fill params, send a real request, inspect the response.
- **History** — every observed request/response sample for that endpoint,
  newest first, so you can see real shapes instead of guessing from code.
- **Flowmap** — a visual map of how endpoints relate, generated from
  captured call patterns.
- **Team Chat** — per-endpoint discussion threads. Any message can be
  flagged as needing a decision; only flagged messages show a
  resolve/resolved state, so a normal back-and-forth doesn't get cluttered
  with resolution bookkeeping it doesn't need.
- **Notifications** (bell icon, header) — an in-app feed of overrides,
  schema changes, comments, and version-status changes across every
  endpoint, so a team notices when someone else's change affects an API
  they depend on.
- **Team** (header button) — every member and role; owners can invite
  people (shareable link, not email-dependent) and change roles. Every
  role check is enforced server-side — a `viewer` cannot edit even by
  calling the API directly, not just because the button is hidden.
- **Versions / Diff** — `vayo export`/`vayo diff` (or the UI's Versions
  panel) compare two API versions and flag added/removed/changed
  operations — wire `--fail-on-breaking` into CI to gate on breaking changes.

### Known limitations, stated plainly

- **Express 4 only** in v1 (see Prerequisites above) — not a bug, a stated
  scope boundary (`docs/00-README.md` constraint 5), because
  `express-list-endpoints` (the static AST pass's route-enumeration
  dependency) has never been verified against Express 5's rewritten router
  internals. `capture()` warns at startup if it detects anything else
  installed (see Prerequisites), so this fails loudly, not silently.
- `pnpm audit`/`npm audit` on this repo's own dev toolchain (`vitest`/`vite`)
  reports a handful of findings — none of that is a `dependency` of any
  published package, so it never reaches a real install of
  `@vayo/capture-express`/`@vayo/db-mongo`/etc. (`devDependencies` aren't
  installed for a package being consumed, only for the project at the root
  of an install). Worth a routine `vitest` version bump, not a launch blocker.

## Contributing to Vayo itself

```bash
pnpm install
cp .env.example .env   # fill in your own MongoDB URI — Vayo never hosts this
pnpm build
pnpm test               # from the repo root — see CONTRIBUTING.md
pnpm dev:demo           # runs apps/demo-app on http://localhost:4000
```

Requires Node 20+ and pnpm 9+ (`corepack enable` if you don't have pnpm yet).

## Repo layout

```text
docs/                  the full technical plan — read this, not just the code
packages/
  types/                shared TypeScript contracts, no runtime code
  capture-express/       Express middleware (the only package that imports express)
  ast/                   static analysis (ts-morph + express-list-endpoints)
  schema-engine/         framework-agnostic schema inference + override merge
  openapi-compiler/      compiles to valid OpenAPI 3.1 + x-vayo-* extensions
  db-mongo/              MongoDB adapter (native driver) — the BYODB layer
  server/                REST API + Socket.IO gateway + serves the UI
  ui/                    schema-driven React docs UI
  cli/                   `vayo init` / `scan` / `export` / `serve` / `diff`
apps/
  demo-app/              sample Express app used to prove the M1 capture pipeline
```
