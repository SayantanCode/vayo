# @vayo/ast

Vayo's static analysis pass — the part of `vayo scan` that reads your
Express app's source without needing any traffic first.

Given a bootstrapped Express app (`export default app` or `export const
app`), `scanProject(rootDir, config)` uses `express-list-endpoints` +
`ts-morph` to recover, per route: the middleware chain, an auth-required
guess (configurable middleware-name patterns), scopes (configurable
scope-check function names), a folder/group guess from your route file
layout, and — when your project uses Zod or a plain Mongoose model — a
best-effort request body schema, all without executing a single request.

```ts
import { scanProject, type VayoConfig } from "@vayo/ast";

const config: VayoConfig = { appEntryPath: "./src/app.js" };
const { routes } = await scanProject(process.cwd(), config);
```

Most people never call this directly —
[`@vayo/cli`](https://www.npmjs.com/package/@vayo/cli)'s `vayo scan` command
is the intended entry point. This package exists standalone for anyone
building custom tooling around the same static pass.

## License

MIT
