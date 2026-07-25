---
"@vayo-hq/cli": patch
---

Renamed the CLI package from the bare `vayo` to `@vayo-hq/cli` — the
first real `npm publish` of all 9 packages succeeded for the other 8, but
npm rejected `vayo` as a first-time publish for looking "too similar to
existing packages" (`yo`, `vant`, `vary`, `vaul`, `nano`, `pako`), an
anti-typosquatting check that only applies to unscoped names. The actual
CLI command stays exactly `vayo <command>` either way — the `bin` field
(`"vayo": "dist/index.js"`) is unaffected by the package's own name.
Install as `npm install -g @vayo-hq/cli`.
