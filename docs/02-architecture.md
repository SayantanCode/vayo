# 02 — Architecture

## System diagram

```mermaid
flowchart LR
    subgraph UserApp["User's Express App"]
        R[Routes] --- MW["@vayo/capture-express\n(middleware)"]
    end

    subgraph Static["Build-time / CLI"]
        AST["@vayo/ast\n(ts-morph static scan)"]
    end

    subgraph Core["@vayo/schema-engine + @vayo/openapi-compiler"]
        MERGE[Merge captured + static + overrides]
        COMPILE[Compile to OpenAPI 3.1 + x-vayo-*]
    end

    subgraph Store["User's MongoDB (BYODB)"]
        DB[(endpoints, overrides,\nexamples, comments,\nteam_members, api_versions)]
    end

    subgraph Serve["@vayo/server (self-hosted)"]
        API[REST + resolver]
        WS[Socket.IO gateway]
    end

    subgraph Client["@vayo/ui (React)"]
        UI[Schema-driven docs UI]
    end

    MW -->|captured request/response| MERGE
    AST -->|route + type metadata| MERGE
    MERGE --> DB
    COMPILE <--> DB
    DB --> API
    API --> UI
    WS <--> UI
    WS <--> API
    API -->|export| SPEC[/openapi.json — valid 3.1, portable to\nPostman, Redoc, codegen/]
```

## Two flows, explained separately

### Flow A — Build-time (how a spec comes to exist)

```mermaid
sequenceDiagram
    participant Req as Real HTTP request
    participant MW as capture-express middleware
    participant SE as schema-engine (genson-js)
    participant DB as MongoDB
    participant AST as ast (ts-morph, CLI-triggered)
    participant OC as openapi-compiler

    Req->>MW: hits an existing route, untouched
    MW->>MW: wrap res.json/res.send, snapshot req+res
    MW->>MW: normalize path (":id" not raw ObjectId)
    MW->>MW: redact denylisted fields (05-security.md §2)
    MW->>SE: raw sample (method, path, req body, res body, status)
    SE->>SE: mergeSchemas() against existing schema for this endpoint+status
    SE->>DB: upsert endpoints doc, append example (capped)
    Note over AST,DB: separate, less frequent pass
    AST->>AST: walk route files, resolve Zod/TS types if present
    AST->>AST: read middleware names (express-list-endpoints)
    AST->>DB: merge group + type + auth-hint metadata (never overwrites runtime data, only fills gaps)
    OC->>DB: read endpoints + overrides + team + version docs
    OC->>OC: compile → OpenAPI 3.1, validate against 3.1 meta-schema
    OC->>DB: write resolved spec cache (optional, for fast reads)
```

### Flow B — Runtime (how a person actually uses it)

```mermaid
sequenceDiagram
    participant Dev as Teammate (browser)
    participant UI as @vayo/ui
    participant API as @vayo/server REST
    participant WS as @vayo/server Socket.IO
    participant DB as MongoDB

    Dev->>UI: opens /vayo
    UI->>API: GET /api/spec?version=v1 (with session token)
    API->>API: verify session, resolve role
    API->>DB: read resolved spec + team + comments
    API-->>UI: merged spec JSON
    UI->>WS: connect, join room(endpointId)
    Dev->>UI: adds a comment / overrides a description
    UI->>API: POST /api/overrides (role-checked server-side)
    API->>DB: write override (diff-layer, see 03-data-model.md)
    API->>WS: broadcast override:updated to room
    WS-->>UI: other viewers see the change live, no refresh
```

## Why the compiler and UI must stay framework-agnostic

`schema-engine`, `openapi-compiler`, `db-mongo`, `server`, and `ui` never import
anything from `capture-express`. They only ever consume the **generic capture
format** defined in `03-data-model.md`. This is the one architectural rule that
makes "MERN only for v1, other stacks later via community contribution" actually
true rather than aspirational — a future `capture-fastify` package only needs to
emit the same generic format; it never touches the compiler or UI.

## Deployment shape (v1)

Single Node.js process runs `@vayo/server`, which:

- serves the REST API,
- serves the built React UI as static assets,
- hosts the Socket.IO gateway,
- connects to the user's MongoDB URI.

This is the same process the user's own API can run in-process — mounted
directly into their own already-running Express app and `http.Server` via
`ServerOptions.httpServer`, the same one-liner ergonomics as
`app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec))` — or as a
separate process pointed at the same database (`vayo serve`); both are
supported, and neither requires a second port for the in-process case. See
`08-packages-and-repo-structure.md` for the `@vayo/server` contract covering
both modes, and `06-realtime-collaboration.md` for how the Socket.IO gateway
avoids colliding with a host app's own WebSocket server when the two share
one `http.Server`.
