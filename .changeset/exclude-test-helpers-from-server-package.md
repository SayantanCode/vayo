---
"@vayo-hq/server": patch
---

Found while dry-run verifying the first real publish: `@vayo-hq/server`'s
`files` field excluded `*.test.js`/`*.test.d.ts` but not
`test-helpers/fakeDb.js` — a ~24KB in-memory fake DB adapter that exists
solely for this package's own tests, not something any real consumer
needs. Excluded it explicitly; every other package's `files` field was
checked and none has an equivalent test-support directory.
