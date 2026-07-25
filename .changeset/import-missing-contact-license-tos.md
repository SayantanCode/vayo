---
"@vayo/openapi-compiler": patch
"vayo": patch
---

Fixed `vayo import` silently dropping `info.contact`/`info.license`/
`info.termsOfService` from the imported spec. `planOpenApiImport` only
ever extracted `title`/`description`, predating this session's earlier
addition of the rest of OpenAPI's standard `info` object to Project
Settings — found while verifying the import feature end-to-end: title
and description updated correctly, but contact/license/termsOfService
silently stayed untouched even though `vayo import`'s own CLI command
already writes those exact `SettingsDoc` fields. `planOpenApiImport` now
extracts all three (dropping an incomplete license with no name, same as
`compile()` itself already does), and `vayo import` passes them through.
