---
"@vayo/ast": patch
---

Fixed `@response <status> <SchemaName>` failing to resolve a schema
declared inside a `createApp()`-style wrapping function — the extremely
common real-world shape (this project's own demo app and CLI-generated
scaffold both use it) — because the by-name lookup only ever searched
top-level declarations of the file. Found via a real end-to-end npm-tarball
verification, not caught by unit tests, since every existing test fixture
happened to declare its schema at the top level. Now searches the whole
file regardless of nesting.
