---
"@vayo/server": patch
"@vayo/ui": patch
---

Fixed two bugs found during an end-to-end UI sweep against a real deployment:

- **Try It Now was silently broken by the docs server's own CSP.** The
  `helmet` config set `connectSrc: ["'self'"]`, which makes the browser
  refuse to even attempt a cross-origin `fetch()` — the docs UI and the
  actual API being documented are almost always different origins (a
  different port in dev, a different subdomain in prod). The Try It Now
  tab's own error hint blamed this on CORS or an unreachable server, since
  nobody had connected it back to the docs server's own CSP header. `connect-src`
  is now unrestricted, since the primary anti-exfiltration defense
  (`script-src`) is unaffected and there's no way to allow-list in advance
  the arbitrary base URLs a team adds to their own Environments.
- **A stale "unauthorized" error banner survived a successful login.**
  If the browser's stored session token was invalid (e.g. expired, or a
  session-secret rotation) when the app first loaded, the initial spec/folders
  fetch would fail and set a persistent error banner — which then never
  cleared even after the user signed back in and every subsequent fetch
  succeeded, since nothing reset it on success.
