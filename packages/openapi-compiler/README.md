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

// Optional third argument fills in info.title/description and servers[] —
// mirrors swagger-jsdoc's options.definition.info/servers. Left out
// entirely, compile() falls back to "Vayo API", no description, no servers.
await compile(resolvedEndpoints, "v1", {
  title: "Acme API",
  description: "Internal order-management API.",
  servers: [{ url: "https://api.acme.com", description: "Production" }],
});
```

Other exports:

- `diffSpecs(specA, specB)` — the structural diff behind `vayo diff`
  (added/removed operations, added/removed *required* fields, type changes,
  enum changes).
- `planOpenApiImport(spec, existingEndpoints, existingEnvironments)` — pure
  planning function behind `vayo import`: reads an existing OpenAPI 3.0.x/3.1
  document and matches its operations/examples/servers against endpoints
  Vayo already knows about, returning a plan of description/example
  overrides and new environment candidates to write — no I/O itself. Throws
  if the input looks like a Postman Collection export instead (a distinct,
  not-yet-built import path).

Most people use this via
[`vayo export`](https://www.npmjs.com/package/vayo) /
`vayo import`, not directly.

## License

MIT
