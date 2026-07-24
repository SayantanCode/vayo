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

## Optional JSDoc tags

A route's leading comment can carry explicit tags — recognized only inside
a comment that also has a bare `@vayo` sentinel line, so an unrelated TODO
or workaround comment is never misread as a declaration:

```js
/**
 * Fetch a single order by ID.
 * @vayo
 * @group Orders
 * @deprecated
 * @response 200 OrderSchema
 * @example 404 {"message": "Order not found"}
 * @description
 * Longer, multi-line explanation of this endpoint — the counterpart to
 * the one-line summary above.
 */
router.get("/orders/:id", getOrder);
```

- **`@group <name>`** (nested: `@group Admin/Users`) wins over both the
  folder-layout guess and the URL-segment fallback, and locks the
  endpoint's folder placement against being dragged elsewhere in the UI.
- **`@deprecated`** marks the endpoint deprecated independent of its API
  version's own lifecycle, and locks it against being un-deprecated in
  the UI.
- **`@response <status> <SchemaName>`** points at an existing Zod schema
  to use for that status code's response shape.
- **`@example <status> <JSON>`** provides a literal example response
  value for a status code.
- **`@description`** fills in a longer, multi-line description separate
  from the one-line `summary` every route already gets for free.

Most people never call this directly —
[`vayo`](https://www.npmjs.com/package/vayo)'s `vayo scan` command
is the intended entry point. This package exists standalone for anyone
building custom tooling around the same static pass.

## License

MIT
