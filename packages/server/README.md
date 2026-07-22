# @vayo/server

The REST API + Socket.IO realtime gateway + static docs-UI host for Vayo.
This is what `vayo serve` runs standalone — but you can also mount it
directly inside your own Express app.

```ts
import { createServer } from "@vayo/server";
import { createAdapter } from "@vayo/db-mongo";

const db = createAdapter(process.env.VAYO_MONGO_URI);
const { httpServer } = createServer({ db, mountPath: "/vayo" });
httpServer.listen(4100);
```

Two auth modes:

- **Standalone** (default) — Vayo manages its own team members, invites,
  and sessions. `vayo create-owner` creates the first login; everyone
  after that is invited in-app.
- **Delegated** — pass `authMiddleware` to validate your own app's
  existing session/JWT instead; Vayo never sees a second set of passwords.

Every mutating route re-reads the caller's current role from your database
on every request and is role-checked server-side — a hidden UI button is
never the only thing standing between a `viewer` and an edit.

Serves the built [`@vayo/ui`](https://www.npmjs.com/package/@vayo/ui) React
app at `mountPath` automatically once it's installed alongside this
package.

Pass your own `httpServer` to mount Vayo into the same process/port as
your real API, instead of running it as a separate standalone server:

```ts
const { app: vayoApp, httpServer } = createServer({ db, mountPath: "/docs", httpServer: myHttpServer });
myExpressApp.use(vayoApp);
```

Most people run this via `vayo serve` — see
[`vayo`](https://www.npmjs.com/package/vayo).

## License

MIT
