---
"@vayo/types": patch
"@vayo/schema-engine": patch
"@vayo/db-mongo": patch
"@vayo/openapi-compiler": patch
"@vayo/server": patch
"@vayo/ui": patch
"vayo": patch
---

`vayo scan` now flags endpoints it no longer finds in a static/merged
source as possibly removed (`EndpointDoc.possiblyRemovedSince`), surfaced
in the compiled spec as `x-vayo-possibly-removed-since`. The docs UI shows
a banner and unlocks deletion for a flagged endpoint — previously, a
non-manual endpoint could never be removed from the docs at all, even
after its real route was deleted from the backend. The flag clears
automatically the moment a later scan re-finds the route or real traffic
hits it again.
