---
"@vayo-hq/server": patch
---

Fixed a real permission gap found during a full viewer-role audit:
`POST /api/examples/:vayoId/pin` was gated at `requireRole("viewer")`,
letting a read-only team member permanently pin an example that then
compiles into the exported OpenAPI spec — a genuine content mutation
(`docs/05-security.md`'s "editor owns every content mutation" model),
not a read-only or self-service action, and inconsistent with this same
route's own `DELETE /api/examples/:id` (already `requireRole("editor")`).
The docs UI already hides the "pin" action from a viewer, but that was
only ever the courtesy layer — the route itself accepted it from any
authenticated viewer hitting the API directly. Now requires `editor`,
matching its sibling delete route.
