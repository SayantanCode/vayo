---
"@vayo-hq/types": patch
"@vayo-hq/ast": patch
"@vayo-hq/schema-engine": patch
"@vayo-hq/openapi-compiler": patch
"@vayo-hq/db-mongo": patch
"@vayo-hq/capture-express": patch
"@vayo-hq/server": patch
"@vayo-hq/ui": patch
"vayo": patch
---

Renamed the npm scope from `@vayo` to `@vayo-hq` — the `@vayo` organization
name was already taken on npmjs.com by an unrelated party, discovered while
setting up npm Trusted Publishing ahead of the first real publish. No
package was ever actually published under the old scope (every `@vayo/*`
name still 404s on the registry), so this is a pure rename with zero real
consumers to break: `npm install @vayo-hq/types`, `npm install
@vayo-hq/server`, etc. The bare `vayo` CLI package (no scope) is unaffected
either way.
