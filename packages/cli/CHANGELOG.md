# vayo

## 0.1.1-beta.3

### Patch Changes

- 54d83dd: Fixed two real issues found while running `vayo scan`/`vayo export`/the docs
  UI against a real, large production API (600+ endpoints):

  - `vayo scan`'s route-merge loop and `vayo export`/`vayo diff`'s per-endpoint
    override/example/test-script lookups (and the identical logic in
    `@vayo-hq/server`'s `GET /api/spec`/`GET /api/diff`) ran one DB round-trip
    at a time in a sequential `for...of` loop — safe, but measured taking
    minutes against a real remote MongoDB cluster at this scale, easily
    mistaken for a hang. Added `mapWithConcurrency` to `@vayo-hq/schema-engine`
    (bounded-concurrency `Promise.all`, 20 at a time — fast without firing
    hundreds of simultaneous connections at the database) and switched every
    one of these call sites to it.
  - The docs UI's sidebar and main pane rendered "No endpoints yet"/"No
    endpoints captured yet" immediately on load, before the first spec/folders
    fetch had actually resolved — indistinguishable from a project with
    nothing captured. A large real API can take several real seconds to
    answer (see above), so this was a visible false-empty flash every time.
    `DocsApp` now tracks whether the initial fetch is still pending and shows
    "Loading endpoints…" instead, in the sidebar (`FolderTree`), the main pane,
    and Full Docs mode (`FullDocView`).

- Updated dependencies [54d83dd]
  - @vayo-hq/schema-engine@0.1.1-beta.3
  - @vayo-hq/server@0.1.1-beta.3
  - @vayo-hq/db-mongo@0.1.1-beta.3
  - @vayo-hq/openapi-compiler@0.1.1-beta.3
  - @vayo-hq/types@0.1.1-beta.3
  - @vayo-hq/ast@0.1.1-beta.3

## 0.1.1-beta.2

### Patch Changes

- 5ad2159: Fixed every package README still linking to the old, never-actually-published
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
- Updated dependencies [5ad2159]
  - @vayo-hq/types@0.1.1-beta.2
  - @vayo-hq/ast@0.1.1-beta.2
  - @vayo-hq/schema-engine@0.1.1-beta.2
  - @vayo-hq/openapi-compiler@0.1.1-beta.2
  - @vayo-hq/db-mongo@0.1.1-beta.2
  - @vayo-hq/server@0.1.1-beta.2

## 0.1.1-beta.1

### Patch Changes

- a9282c3: Fixed `vayo import` silently dropping `info.contact`/`info.license`/
  `info.termsOfService` from the imported spec. `planOpenApiImport` only
  ever extracted `title`/`description`, predating this session's earlier
  addition of the rest of OpenAPI's standard `info` object to Project
  Settings — found while verifying the import feature end-to-end: title
  and description updated correctly, but contact/license/termsOfService
  silently stayed untouched even though `vayo import`'s own CLI command
  already writes those exact `SettingsDoc` fields. `planOpenApiImport` now
  extracts all three (dropping an incomplete license with no name, same as
  `compile()` itself already does), and `vayo import` passes them through.
- ae623af: Renamed the CLI package from the bare `vayo` to `@vayo-hq/cli` — the
  first real `npm publish` of all 9 packages succeeded for the other 8, but
  npm rejected `vayo` as a first-time publish for looking "too similar to
  existing packages" (`yo`, `vant`, `vary`, `vaul`, `nano`, `pako`), an
  anti-typosquatting check that only applies to unscoped names. The actual
  CLI command stays exactly `vayo <command>` either way — the `bin` field
  (`"vayo": "dist/index.js"`) is unaffected by the package's own name.
  Install as `npm install -g @vayo-hq/cli`.
- 04879f9: Renamed the npm scope from `@vayo` to `@vayo-hq` — the `@vayo` organization
  name was already taken on npmjs.com by an unrelated party, discovered while
  setting up npm Trusted Publishing ahead of the first real publish. No
  package was ever actually published under the old scope (every `@vayo/*`
  name still 404s on the registry), so this is a pure rename with zero real
  consumers to break: `npm install @vayo-hq/types`, `npm install
@vayo-hq/server`, etc. The bare `vayo` CLI package (no scope) is unaffected
  either way.
- 130aa3e: Updated READMEs to document capabilities that had landed in code but never
  made it into the package docs: `@vayo-hq/ast`'s optional JSDoc tags
  (`@group`/`@deprecated`/`@response`/`@example`/`@description`),
  `@vayo-hq/openapi-compiler`'s `compile()` `title`/`description`/`servers`
  options and `planOpenApiImport`, `@vayo-hq/ui`'s Coverage/Flows/Settings/Chat/
  Export surfaces, and the `vayo` CLI's `vayo import` command.
- Updated dependencies [c8cd29c]
- Updated dependencies [13800e0]
- Updated dependencies [8082701]
- Updated dependencies [a9282c3]
- Updated dependencies [d87f5ae]
- Updated dependencies [04879f9]
- Updated dependencies [4a677a6]
- Updated dependencies [130aa3e]
  - @vayo-hq/types@0.1.1-beta.1
  - @vayo-hq/db-mongo@0.1.1-beta.1
  - @vayo-hq/openapi-compiler@0.1.1-beta.1
  - @vayo-hq/server@0.1.1-beta.1
  - @vayo-hq/ast@0.1.1-beta.1
  - @vayo-hq/schema-engine@0.1.1-beta.1

## 0.1.1-beta.0

### Patch Changes

- 16a1997: Added a Swagger/swagger-jsdoc-style explicit `@deprecated` tag: a route's
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

- 14df68c: Added Swagger-style explicit route grouping: an `@group <name>` tag in a
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

- 4644dd6: Added three more Swagger/swagger-jsdoc-style leading-comment tags:
  `@response <status> <SchemaName>` and `@example <status> <JSON>` declare
  a response's schema/literal example per status code (resolving the named
  Zod schema the same way a validation-middleware argument already is —
  same-file `const`, ESM import, or CommonJS destructured `require`);
  `@description` is the multi-line counterpart to the existing
  zero-annotation `summary`, mirroring OpenAPI's own `summary`/`description`
  split. All three are gated behind the same `@vayo` sentinel `@group`/
  `@deprecated` already require.

  Added project-wide settings (title/description, the equivalent of
  swagger-jsdoc's `options.definition.info`) editable via a new Settings
  button in the docs UI, plus `servers` compiled from existing Environments
  — no new UI needed for that part. The exported OpenAPI spec's `examples`
  field now also includes real pinned/saved responses (`vayo_examples`),
  not just code-declared ones, matching what the Postman export already
  did.

  Fixed a real data-loss bug found while reviewing this work: a rescan was
  silently discarding response-schema fields real traffic had already
  taught a `@response`-declared status, since nothing validates outgoing
  responses the way Zod validates incoming requests. Also fixed file
  uploads being labeled `application/json` instead of `multipart/form-data`
  in the exported spec.

- a96b3c4: Added `vayo import <file>`: enriches endpoints Vayo has already discovered
  via capture/`vayo scan` with content from an existing OpenAPI spec — a
  migration/onboarding aid, not a parallel authoring path, so it never
  invents an endpoint from a spec alone. Backfills `summary`/`description`,
  per-field request/response schema descriptions (only for a field the
  endpoint's own captured/declared schema already has), and response
  examples (as new pinned examples), plus project-wide settings/environments
  from the spec's own `info`/`servers`. Every enriched field goes through
  the ordinary overrides mechanism — skipped when one already exists unless
  `--overwrite` is passed; a spec operation with no matching endpoint is
  reported unmatched, never created.

  Rejects a Postman Collection export with a clear error instead of
  silently importing nothing (Postman's shape has no `paths` at all — it
  would otherwise report "0 matched" with no indication anything was
  wrong), and no longer hangs forever on any thrown error during import
  (the process previously never force-exited past an open MongoDB
  connection).

- b976be0: `vayo init`'s printed next steps now show same-port embedding
  (`createServer({ httpServer })`) as clearly as the standalone `vayo serve`
  path, with a ready-to-paste snippet matching the project's module format.
- b0b30d1: `vayo scan` now flags endpoints it no longer finds in a static/merged
  source as possibly removed (`EndpointDoc.possiblyRemovedSince`), surfaced
  in the compiled spec as `x-vayo-possibly-removed-since`. The docs UI shows
  a banner and unlocks deletion for a flagged endpoint — previously, a
  non-manual endpoint could never be removed from the docs at all, even
  after its real route was deleted from the backend. The flag clears
  automatically the moment a later scan re-finds the route or real traffic
  hits it again.
- bf59bc7: A focused review pass over the two most recent additions (`@group`,
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
  - **Bug fix**: a "declared" endpoint whose `@group` tag's _value_ changed
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

- Updated dependencies [16a1997]
- Updated dependencies [14df68c]
- Updated dependencies [4644dd6]
- Updated dependencies [a96b3c4]
- Updated dependencies [0157416]
- Updated dependencies [b0b30d1]
- Updated dependencies [bf59bc7]
  - @vayo/types@0.1.1-beta.0
  - @vayo/ast@0.1.1-beta.0
  - @vayo/schema-engine@0.1.1-beta.0
  - @vayo/db-mongo@0.1.1-beta.0
  - @vayo/openapi-compiler@0.1.1-beta.0
  - @vayo/server@0.1.1-beta.0
