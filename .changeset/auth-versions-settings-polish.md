---
"@vayo/types": patch
"@vayo/db-mongo": patch
"@vayo/openapi-compiler": patch
"@vayo/server": patch
"@vayo/ui": patch
---

Several launch-readiness improvements, requested together:

- **Sign-out now confirms first.** A single click used to sign out
  immediately; it now opens the same confirm dialog other destructive
  actions (delete endpoint/folder) already use.
- **"Remember this device" on login.** Unchecked, the session token is
  kept in `sessionStorage` (cleared when the tab/browser closes) instead of
  `localStorage`, and the server issues a shorter-lived session (24h vs
  30 days) to match.
- **Creating a duplicate API version name failed silently.** `POST
  /api/versions` had a unique index but no pre-check, so a second `v1`
  threw an uncaught, unhandled 500 with zero UI feedback. Now returns a
  clean 409 ("API version \"v1\" already exists.") shown in the same
  global error banner every other create/delete failure already uses, and
  the form's input is preserved instead of vanishing.
- **A saved project description was never shown anywhere in the docs UI**
  — only in the exported spec's JSON. It's now rendered at the top of
  Full Docs mode, the same "info block above the operation list" every
  third-party OpenAPI renderer (Redoc, Swagger UI) already does.
- **Project settings gained contact/license/termsOfService** — the rest of
  OpenAPI's standard `info` object, filling out what was previously just
  title/description.
- **Fixed a real bug found while testing the above**: OpenAPI 3.1's
  License Object requires `url` (or an SPDX `identifier`) alongside
  `name` — a license name entered with no URL made the *entire* compiled
  spec fail its own validation, breaking `/api/spec` and the whole docs UI
  outright. `compile()` now silently omits an incomplete license instead
  of ever producing an invalid document.
