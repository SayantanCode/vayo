# @vayo/ui

Vayo's schema-driven React docs UI — five tabs per endpoint (Details,
Flowmap, History, Team Chat, Try It Now), plus Team management,
Notifications, Coverage (which endpoints are undocumented/unconfirmed),
Flows (saved, ordered multi-endpoint sequences), a cross-endpoint Chat
drawer, per-project Settings (title/description shown in the exported
spec), OpenAPI/Postman export, and API version diffing.

You won't import this package's code directly.
[`@vayo/server`](https://www.npmjs.com/package/@vayo/server) locates its
built static bundle (`dist-app/`) at runtime and serves it at whatever
`mountPath` you configured — installing `@vayo/server` alongside this
package is all that's needed for the docs UI to appear.

Renders entirely off the compiled OpenAPI 3.1 document
([`@vayo/openapi-compiler`](https://www.npmjs.com/package/@vayo/openapi-compiler)'s
output, including its `x-vayo-*` extensions) plus a small REST API of its
own for team/collaboration features — no separate annotation format to
learn.

## License

MIT
