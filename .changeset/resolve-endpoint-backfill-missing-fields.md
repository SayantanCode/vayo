---
"@vayo/schema-engine": patch
---

Fixed a crash in `resolveEndpoint` for any `EndpointDoc` written before
`declaredResponseStatuses`, `declaredExamples`, or `description` existed as
fields and never since touched by a rescan or fresh runtime capture (both of
which already backfill these themselves). MongoDB doesn't retroactively add
fields to existing documents, so an upgraded install could hit an endpoint
missing these entirely — not merely `null` — and `openapi-compiler`'s
`buildResponses` would throw `Cannot convert undefined or null to object`
calling `Object.keys` on the missing `declaredExamples`, breaking `/api/spec`
outright for that version. `resolveEndpoint` now backfills sane defaults
(`[]`, `{}`, `null`) for these three fields, since it's the one gateway every
consumer — `compile()`, every `@vayo/server` route, the CLI's
export/diff/import commands — reads an endpoint through.
