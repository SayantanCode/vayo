---
"@vayo/ui": patch
---

Fixed the header toolbar getting crushed on anything narrower than a very
wide desktop. `.docs-app__search-trigger` was the only flexible element
(`flex: 1; min-width: 0`) sharing a non-wrapping row with a growing list of
fixed-width buttons (Full Docs, Flows, Coverage, Team, Chat, Settings, the
theme toggle, notifications, the user menu) — as those accumulated over
this session, the search box got squeezed down to showing just "Ctrl" with
its own label cut off. The header now wraps onto a second line once it
runs out of room, and the search box has a 140px floor so it never shrinks
past legibility.
