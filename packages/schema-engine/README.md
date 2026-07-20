# @vayo/schema-engine

Framework-agnostic schema inference and merge logic for
[Vayo](https://www.npmjs.com/package/@vayo/cli) — no Express import, no
MongoDB import, pure functions only.

This is where a captured request/response sample and a static-scan result
get folded into one `EndpointDoc`, and where manual overrides get
re-applied on top at read time — never written back destructively, so a
re-scan or new traffic can never silently erase a manual edit. Key exports:

- `mergeCapturedSample(existing, sample)` — fold one observed
  request/response into an endpoint's inferred schema.
- `mergeStaticResult(existing, route, version)` — fold in
  [`@vayo/ast`](https://www.npmjs.com/package/@vayo/ast)'s static scan result.
- `resolveEndpoint(endpoint, overrides)` — apply `vayo_overrides` on top of
  a stored `EndpointDoc`, non-destructively.
- `resolveVersion`, `stableHash`, `resolveAuthRequired`, `detectSchemaChange`.

Consumed internally by [`@vayo/db-mongo`](https://www.npmjs.com/package/@vayo/db-mongo)
(which calls these merge functions on every capture/scan) — most people
won't import this directly. Start with
[`@vayo/cli`](https://www.npmjs.com/package/@vayo/cli).

## License

MIT
