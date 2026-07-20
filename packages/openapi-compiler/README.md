# @vayo/openapi-compiler

Compiles Vayo's resolved endpoints into a valid OpenAPI 3.1 document — the
backbone of `vayo export` and the docs UI's `/api/spec` endpoint.

Vayo-specific data (which folder an endpoint lives in, whether its schema
is confirmed or inferred, its detected auth requirements, ...) is carried
entirely in `x-vayo-*` extension fields — the document itself always
validates as plain OpenAPI 3.1, so it works with any tool that already
speaks that format.

```ts
import { compile, validate } from "@vayo/openapi-compiler";

const doc = await compile(resolvedEndpoints, "v1"); // throws if the result wouldn't validate
```

Also exports `diffSpecs(specA, specB)` — the structural diff behind `vayo
diff` (added/removed operations, added/removed *required* fields, type
changes, enum changes).

Most people use this via
[`vayo export`](https://www.npmjs.com/package/@vayo/cli), not directly.

## License

MIT
