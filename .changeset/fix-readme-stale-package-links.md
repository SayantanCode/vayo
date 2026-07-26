---
"@vayo-hq/types": patch
"@vayo-hq/ast": patch
"@vayo-hq/schema-engine": patch
"@vayo-hq/openapi-compiler": patch
"@vayo-hq/db-mongo": patch
"@vayo-hq/capture-express": patch
"@vayo-hq/server": patch
"@vayo-hq/cli": patch
---

Fixed every package README still linking to the old, never-actually-published
bare `vayo` npm package name (npm rejected it as a first-publish
typosquat — see the CLI rename changeset) instead of the real
`@vayo-hq/cli`. Also fixed `@vayo-hq/db-mongo`'s README claiming "most people
never call this directly," which contradicted the `createAdapter`/
`runMigrations` wiring snippet every other doc (and `vayo init`'s own printed
next steps) shows being called directly in a real project. Root README's
"Using Vayo" section no longer describes the pre-publish tarball workflow —
all 9 packages are live on npm now, so it gives the real, verified
`npm install ...@beta` command instead. Every install example across the
repo now explicit about the `@beta` tag rather than relying on `latest`,
since `latest` only moves when explicitly re-tagged during this prerelease
period (discovered live: the very first publish grabbed `latest`
automatically and every subsequent `--tag beta` publish left it pointing at
an old, broken version).
