# @vayo/capture-express

## 0.1.1-beta.1

### Patch Changes

- 04879f9: Renamed the npm scope from `@vayo` to `@vayo-hq` — the `@vayo` organization
  name was already taken on npmjs.com by an unrelated party, discovered while
  setting up npm Trusted Publishing ahead of the first real publish. No
  package was ever actually published under the old scope (every `@vayo/*`
  name still 404s on the registry), so this is a pure rename with zero real
  consumers to break: `npm install @vayo-hq/types`, `npm install
@vayo-hq/server`, etc. The bare `vayo` CLI package (no scope) is unaffected
  either way.
- Updated dependencies [c8cd29c]
- Updated dependencies [04879f9]
- Updated dependencies [4a677a6]
  - @vayo-hq/types@0.1.1-beta.1
  - @vayo-hq/schema-engine@0.1.1-beta.1

## 0.1.1-beta.0

### Patch Changes

- Updated dependencies [16a1997]
- Updated dependencies [14df68c]
- Updated dependencies [4644dd6]
- Updated dependencies [b0b30d1]
- Updated dependencies [bf59bc7]
  - @vayo/types@0.1.1-beta.0
  - @vayo/schema-engine@0.1.1-beta.0
