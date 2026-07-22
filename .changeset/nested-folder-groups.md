---
"@vayo/types": patch
"@vayo/ast": patch
"@vayo/schema-engine": patch
"@vayo/openapi-compiler": patch
"@vayo/db-mongo": patch
"@vayo/server": patch
"@vayo/ui": patch
"@vayo/cli": patch
---

Added Swagger-style explicit route grouping: an `@group <name>` tag in a
route's leading comment (`@group Admin/Users` for nesting) now declares its
sidebar folder directly in code, taking priority over the `routes/` file
convention and the URL-segment guess. That same nested `routes/<a>/<b>/`
file layout now also produces real nested sidebar folders automatically,
instead of flattening everything to one level.

A "declared" group (from an explicit `@group` tag) is treated as
authoritative for folder placement: the endpoint can still be reordered
within its current folder via drag-and-drop, but the sidebar now refuses to
relocate it to a different folder, since that would silently diverge from
what the code itself says. This is a deliberate, narrow exception to this
app's usual "manual override always wins" rule, scoped only to folder
placement for explicitly-tagged endpoints — every other field, and every
merely-inferred group, keeps working exactly as before.
