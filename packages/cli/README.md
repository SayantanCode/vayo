# vayo

The `vayo` command — self-hosted, auto-generating API documentation for
Node/Express APIs. Zero manual annotation. Bring-your-own-database: Vayo
never hosts your data or phones home.

## Install

**Requires Node 20+, your own MongoDB instance, and Express 4.x** (peer
dependency — v1 targets Express 4 only; a bare `npm install express` today
resolves to Express 5, which this rejects — install `express@^4.19.0`
explicitly).

```bash
npm install vayo @vayo/capture-express @vayo/db-mongo express@^4.19.0
```

## Quickstart

### 1. Initialize

```bash
npx vayo init
```

Prompts for your MongoDB URI and the path to a file exporting your
bootstrapped Express app. Writes `.env`, `vayo.config.js`, and a
placeholder AST-entry file — matching your project's CommonJS/ESM style
automatically. Never touches your existing source files.

### 2. Wire capture into your real app

`vayo init` prints this exact snippet — mount it wherever you currently
call `app.listen()`:

```js
const { capture } = require("@vayo/capture-express"); // or `import` for ESM
const { createAdapter } = require("@vayo/db-mongo");
const db = createAdapter(process.env.VAYO_MONGO_URI);
app.use(capture({ db }));
```

### 3. Scan and capture real traffic

```bash
npx vayo scan   # static pass — routes + middleware chains, no traffic needed
```

Then hit your app's endpoints normally — `capture()` merges what real
traffic reveals with what the static scan found.

### 4. Create your first login

```bash
npx vayo create-owner --email you@example.com --name "Your Name" --password "..."
```

Skip this if you're using delegated auth (validating your own app's
session instead — see [`@vayo/server`](https://www.npmjs.com/package/@vayo/server)).

### 5. Serve your docs

```bash
npx vayo serve --port 4100
```

Browse to `http://localhost:4100/vayo`, sign in, and see every endpoint
`vayo scan` found — inferred schemas, working examples, and a live request
client.

## Commands

| Command | What it does |
|---|---|
| `vayo init` | One-time setup: `.env`, `vayo.config.js`, AST-entry file, DB migrations |
| `vayo scan` | Static AST pass — routes, middleware, auth guesses, request schemas (Zod- or Mongoose-derived) |
| `vayo export` | Compile and write the resolved OpenAPI 3.1 (or Postman) spec for a version |
| `vayo create-owner` | Create the first team member (owner role) — the only way in for standalone auth |
| `vayo serve` | Run the REST API + Socket.IO gateway + docs UI standalone |
| `vayo diff <from> <to>` | Structural diff between two API versions — `--fail-on-breaking` for CI |

## What you get

Every endpoint gets a resolved request/response schema — confidence-tagged
so a guess is never shown with the same weight as something confirmed:
**declared** when traced from a Zod schema your code already enforces,
**inferred** when traced from a Mongoose model's storage shape, **observed**
once real traffic has actually confirmed it. Plus auth requirements, a
working code sample in six languages, and a live "Try It Now" request
client — organized into a sidebar you can freely reorganize into folders,
with every manual edit layered on non-destructively so the next `vayo scan`
or the next request never silently erases it.

## License

MIT
