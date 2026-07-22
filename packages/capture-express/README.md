# @vayo/capture-express

Express middleware that captures real request/response traffic and turns
it into Vayo's inferred schemas — the "zero manual annotation" half of the
pipeline (the other half is
[`@vayo/ast`](https://www.npmjs.com/package/@vayo/ast)'s static pass).

```js
const { capture } = require("@vayo/capture-express"); // or `import` for ESM
const { createAdapter } = require("@vayo/db-mongo");

const db = createAdapter(process.env.VAYO_MONGO_URI);
app.use(capture({ db }));
```

Mount it once, alongside your other middleware, and every request that
flows through your app afterward gets folded into that endpoint's
request/response schema — no annotations, no comments, no decorators.
Sensitive-looking fields (passwords, tokens, credit-card-shaped values) are
redacted by key-name pattern before anything is written to your database;
pass your own patterns via `redact`.

**Requires Express 4.x** (`peerDependencies: { express: "^4.19.0" }`) — v1
targets Express 4 only; logs a clear warning at startup if it detects a
different major version installed, rather than silently producing wrong
route paths.

The only Vayo package allowed to import Express types — everything
downstream of it is framework-agnostic.

Typically installed and wired via `vayo init`'s printed snippet — see
[`vayo`](https://www.npmjs.com/package/vayo).

## License

MIT
