---
"@vayo-hq/ui": patch
---

Fixed three more real issues found while using the docs UI against a real
production API:

- **The active version could get permanently stuck on "Unversioned."** The
  very first endpoint ever captured resolves to a default version key
  (schema-engine's `resolveVersion` fallback — usually "v1") before anyone
  has explicitly created that version via "Manage versions…" — real data
  exists under it, but no `ApiVersionDoc` does yet, so it never appeared as
  a selectable option in the version switcher. Once a user switched to
  "Unversioned" (always listed, unconditionally), there was no way back
  short of manually creating a version with that exact name.
  `VersionSwitcher` now always surfaces the app's default version key as a
  selectable option when it isn't a real stored version yet.
- **Switching versions could leave the previous version's tree/content on
  screen** for however long the new version's spec/folders fetch took —
  genuinely indistinguishable from the switch having silently failed,
  especially on a large real API where that fetch can take several real
  seconds. The loading state added previously only covered the very first
  load; it's now also cleared and re-armed on every version switch.
- **The Environments modal allowed duplicate names and double-submission.**
  Nothing disabled the Save button while a create/update request was in
  flight, so a double-click read the same identical form state twice and
  created two duplicate environments; the form also never reset after a
  successful creation. Added a `saving` state that disables Save/Delete/
  Close and shows "Saving…" during the request, resets the form after a
  successful creation, and added a duplicate-name check that surfaces a
  clear inline error instead of silently allowing it.
