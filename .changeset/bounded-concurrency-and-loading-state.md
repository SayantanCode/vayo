---
"@vayo-hq/schema-engine": patch
"@vayo-hq/cli": patch
"@vayo-hq/server": patch
"@vayo-hq/ui": patch
---

Fixed two real issues found while running `vayo scan`/`vayo export`/the docs
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
