# @vayo-hq/db-mongo

The MongoDB implementation of Vayo's storage layer — the BYODB
(bring-your-own-database) piece. Vayo never hosts your data; this package
is what actually talks to *your* MongoDB, using the native driver (not
Mongoose).

```ts
import { createAdapter, runMigrations } from "@vayo-hq/db-mongo";

await runMigrations(process.env.VAYO_MONGO_URI); // once, via `vayo init` — sets up indexes
const db = createAdapter(process.env.VAYO_MONGO_URI);
```

`createAdapter` returns a `VayoDbAdapter` (from
[`@vayo-hq/types`](https://www.npmjs.com/package/@vayo-hq/types)) — the same
interface [`@vayo-hq/capture-express`](https://www.npmjs.com/package/@vayo-hq/capture-express)
and [`@vayo-hq/server`](https://www.npmjs.com/package/@vayo-hq/server) both
consume. Every collection is prefixed `vayo_` to avoid colliding with your
own collections in a shared database.

You'll typically call `createAdapter`/`runMigrations` directly in your own
entry point — it's the exact snippet `vayo init` prints, and one of the
packages installed alongside [`@vayo-hq/cli`](https://www.npmjs.com/package/@vayo-hq/cli)
in the standard quickstart: `npm install @vayo-hq/db-mongo@beta`.

## License

MIT
