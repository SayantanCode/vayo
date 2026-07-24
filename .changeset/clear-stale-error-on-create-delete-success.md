---
"@vayo/ui": patch
---

Extended the previous stale-error-banner fix to the two other places
`DocsApp` sets the same global error banner: `handleCreateEndpoint` and
`handleDeleteEndpoint` now clear it on success too, not just on failure.
Previously, a failed create/delete (e.g. a duplicate-path conflict) left
its error banner on screen indefinitely, surviving even an unrelated,
fully successful action afterward.
