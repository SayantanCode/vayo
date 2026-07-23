# @vayo/openapi-compiler

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
- Updated dependencies [b0b30d1]
- Updated dependencies [bf59bc7]
  - @vayo/types@0.1.1-beta.0
  - @vayo/schema-engine@0.1.1-beta.0
