---
"@vayo/types": patch
"@vayo/ast": patch
"@vayo/schema-engine": patch
"@vayo/db-mongo": patch
"@vayo/openapi-compiler": patch
"@vayo/server": patch
"@vayo/ui": patch
"vayo": patch
---

Added three more Swagger/swagger-jsdoc-style leading-comment tags:
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
