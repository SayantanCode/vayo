---
"@vayo/openapi-compiler": patch
"vayo": patch
---

Added `vayo import <file>`: enriches endpoints Vayo has already discovered
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
