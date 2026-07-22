---
"@vayo/types": patch
"@vayo/ast": patch
"@vayo/schema-engine": patch
"@vayo/db-mongo": patch
"@vayo/openapi-compiler": patch
"@vayo/server": patch
"@vayo/ui": patch
"vayo": patch
---

Added a Swagger/swagger-jsdoc-style explicit `@deprecated` tag: a route's
leading comment can now mark it deprecated independent of its API
version's own lifecycle, emitted as OpenAPI's own standard `deprecated`
field. A human can still flag any not-code-declared endpoint deprecated
through the UI, but once the code says `@deprecated`, the UI can't
un-deprecate it — enforced server-side in a new `PATCH
/api/endpoints/:vayoId/deprecated` route, not just hidden in the UI.

Also fixed a gap in the `@group` declared-folder lock added previously:
`PATCH /api/endpoints/:vayoId/placement` now enforces it server-side too
(a direct API call previously bypassed the sidebar's own refusal
entirely), and the lock no longer incorrectly blocks the very first
placement of a "declared" endpoint that hasn't been organized into a
folder yet.
