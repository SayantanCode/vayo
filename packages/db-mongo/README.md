# @vayo/db-mongo

The MongoDB implementation of Vayo's storage layer — the BYODB
(bring-your-own-database) piece. Vayo never hosts your data; this package
is what actually talks to *your* MongoDB, using the native driver (not
Mongoose).

```ts
import { createAdapter, runMigrations } from "@vayo/db-mongo";

await runMigrations(process.env.VAYO_MONGO_URI); // once, via `vayo init` — sets up indexes
const db = createAdapter(process.env.VAYO_MONGO_URI);
```

`createAdapter` returns a `VayoDbAdapter` (from
[`@vayo/types`](https://www.npmjs.com/package/@vayo/types)) — the same
interface [`@vayo/capture-express`](https://www.npmjs.com/package/@vayo/capture-express)
and [`@vayo/server`](https://www.npmjs.com/package/@vayo/server) both
consume. Every collection is prefixed `vayo_` to avoid colliding with your
own collections in a shared database.

Most people never call this directly — it's wired up automatically by
`vayo init`/`vayo scan`/`vayo serve` in
[`@vayo/cli`](https://www.npmjs.com/package/@vayo/cli).

## License

MIT
