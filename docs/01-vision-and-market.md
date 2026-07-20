# 01 — Vision & Market

## The problem, precisely stated

Swagger/OpenAPI tooling requires a developer to hand-author documentation that
duplicates what the code already expresses. Postman solves collaboration but
requires the team's data to live on Postman's servers, and its pricing has
tightened materially (as of March 2026, Postman's free plan dropped to a single
seat; shared team workspaces start at $19/user/month). Neither problem is solved
by the other's tool.

## Moto

**Your endpoints already know their shape. Vayo just writes it down.**

## Target audience, in priority order for v1

1. **MERN-stack solo/OSS maintainers** — no documentation budget, want real docs
   without a second job.
2. **Small backend teams (2–15 engineers)** on Node/Express — want to comment,
   override, and review docs together without a per-seat bill.
3. **Teams already priced out of Postman** or uncomfortable sending traffic
   samples to a third party's cloud.

## Competitive landscape (researched mid-2026, re-verified July 2026 — re-verify again before major roadmap decisions)

| Tool | What it actually is | Where Vayo differs |
| --- | --- | --- |
| **Swagger UI / swagger-jsdoc** | Manual-annotation renderer, the original. Still the most widely integrated, but requires hand-written comments that drift from code. | Vayo needs zero annotations; schema is inferred from real traffic + AST. |
| **Redoc / Scalar** | Pure OpenAPI *renderers* (MIT-licensed, excellent). They render a spec you already have — they do not generate one. Scalar in particular (14k★) is the best-in-class renderer as of 2026 and is what most new Swagger-UI replacements reach for. | Vayo's differentiated layer is upstream of rendering: it produces the spec. Rendering is commodity; discovery is not. |
| **Optic** | The closest prior art. A proxy that captured traffic and generated/diffed OpenAPI specs automatically — almost exactly Vayo's core mechanic. Acquired by Atlassian in 2024, **archived January 2026**, no community fork emerged. | Confirms the idea is right and the gap is currently open. Also a cautionary tale: VC-funded OSS with a hosted-cloud layer is fragile. Vayo's BYODB model means there is no hosted service to shut down — the worst case if development stops is "it still runs, forever, on infrastructure the user already owns." |
| **Treblle** | Auto-generates OpenAPI-backed docs directly from live traffic + SDK instrumentation — the same core mechanic as Vayo, actively shipping in 2026 (not archived like Optic). | Cloud-first: captured traffic flows through Treblle's own analytics pipeline. Directly incompatible with BYODB — there is no self-hosted mode where Vayo's "never sent anywhere but your own DB" claim would even apply to Treblle. |
| **Levo.ai** | Generates OpenAPI/Postman specs from live traffic via eBPF-based instrumentation, with drift detection — but positioned as an **API security platform** (schema drift + security test generation), priced per endpoint secured. Docs generation is one feature among several, not the product. | Not competing for the same buyer — a team evaluating Levo.ai is buying security tooling with docs as a side effect, not a free, self-hosted docs tool. Worth re-checking if it ever repositions toward docs-first. |
| **Apidog** | All-in-one platform explicitly marketed as a Postman/Swagger/Stoplight replacement — real-time team collaboration, and a genuine self-hosting option (deploy on your own servers, own auth). Closer to Vayo's collaboration + self-hosted pillars than anything else on this list. | Spec/design-first, not traffic-derived — still requires a human to author or import the spec. Doesn't touch the zero-annotation problem at all, which stays Vayo's actual differentiator against it. |
| **Postman** | Full API platform: client, docs, mocks, monitors, team workspaces. Cloud-mandatory since 2023 (Scratch Pad/offline mode removed), pricing tightened further in 2026. | Vayo doesn't compete on breadth (mocks, monitors) — it competes on "auto-generated + free team collaboration + self-hosted," which Postman structurally cannot offer while it depends on seat revenue. |
| **Bruno** | Git-native, fully local, MIT, no cloud — the strongest "own your data" precedent in the market (40k+★, exploded after Postman's 2026 pricing change). Its own documentation is explicit that "collaboration" means *use Git*: no live comments, no presence, nothing for a non-engineer teammate. | Vayo keeps Bruno's self-hosted, no-cloud principle but adds real-time comments/presence a PM or QA person can use without touching Git. |
| **oasdiff / SpecShield** | Spec-to-spec diffing tools for CI (breaking-change detection between two OpenAPI documents). Actively maintained, Apache 2.0. | Turned out not to be usable as a dependency after all — `oasdiff` is Go-only (binaries/Docker/Homebrew, no npm/WASM distribution), so `07-api-versioning.md`'s diff feature ended up a small purpose-built TypeScript diff instead, scoped to exactly the "what counts as changed" rules that doc already specifies. See that doc for the full reasoning. |

## What "better than Swagger and Postman" concretely means

- **vs. Swagger:** zero manual annotation, docs cannot silently drift from code
  because they're compiled from observed behavior, not prose.
- **vs. Postman:** team collaboration (comments, presence, roles, review) is free
  because it runs against infrastructure the user already pays for — there is no
  seat count for Vayo to bill against.

## Honest scope boundary for v1

Building for one stack (Node/Express, MongoDB) on purpose. The discovery format
(`03-data-model.md`) and the compiler (`04-capture-engine.md` → OpenAPI 3.1) are
kept framework-agnostic specifically so that a `capture-fastify`,
`capture-django`, or `capture-go` package can be contributed later without
touching the compiler, the database layer, or the UI. See `08-packages-and-repo-structure.md`
for where that boundary is enforced in code.

## Segments this honestly doesn't serve yet, and what's actually true for each

A pre-launch review (2026-07) asked, for each: "is this a real gap, or something
Vayo already does but hasn't said out loud?"

- **Polyglot backends** (a team with Node *and* Go *and* Python services wanting
  one shared doc set) — a real gap, not a documentation problem. v1 is
  Node/Express only (constraint #5, `00-README.md`) on purpose; nothing here
  changes that mid-stream. What's already true: the format a capture adapter
  emits (`03-data-model.md`) and the compiler consuming it are both
  framework-agnostic by construction (per the scope boundary above), so a
  future `capture-fastify`/`capture-django`/`capture-go` is additive, community
  contributable work, not a rearchitecture — the door is deliberately left
  open, just not walked through yet.
- **Postgres-only teams unwilling to add MongoDB** — also a real gap (there is
  only one adapter today, `@vayo/db-mongo`), but a narrower one than it looks:
  `VayoDbAdapter` (`@vayo/types`) was audited end-to-end and contains **zero**
  Mongo-specific types anywhere in its ~30 methods — every id is a plain
  `string`, the one binary-stream method (`downloadAttachment`) is typed
  `unknown` specifically so no adapter's concrete stream type leaks into the
  shared interface. A `@vayo/db-postgres` implementing this same interface is
  genuinely viable future work, not a redesign — deliberately not attempted in
  this pass, since a rushed implementation of the data layer everything else
  depends on is a worse outcome than an honest "not built yet."
- **Teams wanting a zero-ops hosted dashboard** — not a gap, a deliberate
  non-goal. This is the one item on this list Vayo isn't trying to fix,
  because fixing it would mean abandoning the thing that makes it different
  from Treblle/ReadMe/Mintlify/Postman in the first place (BYODB, no
  telemetry, "the worst case if development stops is it still runs forever on
  infrastructure you already own" — see the Optic/Treblle rows above). A team
  that wants zero-ops hosting is better served by one of those tools directly.
- **Enterprises needing SSO / SOC2 / audit logs** — partially already true,
  partially a real gap. SSO: delegated auth mode (`05-security.md` §5) already
  lets any host app that terminates its own SSO handshake (Okta, Azure AD,
  any SAML/OIDC provider) hand Vayo an already-authenticated identity with no
  extra code — this was true before this review, just not said out loud
  anywhere a prospective enterprise buyer would find it. Audit trail: `GET
  /api/audit-log/export` (owner-only, JSON or CSV) now gives a full,
  project-wide export of every override/comment/invite/role-change/removal —
  real, new capability a compliance review can actually use. What's still
  genuinely missing: SOC2 itself is an organizational certification (external
  audit, documented processes, a paper trail over time) — no code change
  grants that, and pretending otherwise here would be dishonest.
