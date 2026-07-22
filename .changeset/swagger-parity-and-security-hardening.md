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

A focused review pass over the two most recent additions (`@group`,
`@deprecated`) found and fixed several real gaps:

- **Disambiguation**: `@group`/`@deprecated` now require a bare `@vayo`
  sentinel line anywhere in the comment before being parsed at all — same
  role `@swagger`/`@openapi` play in swagger-jsdoc. Without it, an
  unrelated comment ("the `@deprecated` flag was removed from the old
  validator") can no longer be misread as a real declaration. The
  plain-text summary itself is unaffected — still zero-annotation-required.
- **Security hardening**: both the folder-placement lock and the
  deprecation lock were only checked in their own dedicated REST routes —
  the generic `POST /api/overrides` route and the Socket.IO
  `override:updated` event both accepted the exact same writes completely
  unchecked, bypassing both locks entirely. Fixed with one shared
  `checkOverrideAllowed` check enforced at every write path.
- **Bug fix**: a "declared" endpoint whose `@group` tag's *value* changed
  after it was already placed had no way to ever move again — the lock
  actively refused it, and nothing re-synced it. `autoOrganizeFolders` now
  self-heals a "declared" endpoint's placement when its current folder no
  longer matches its current group, leaving everything untouched when it
  already matches.
- **Swagger/OpenAPI interop**: the exported spec now emits OpenAPI's own
  standard `tags` array (per-operation and top-level), not just
  `x-vayo-group`. Previously a real third-party Swagger UI, Postman
  import, or Redoc would show every operation in one flat, ungrouped list
  despite Vayo's own sidebar being organized by group the whole time.
