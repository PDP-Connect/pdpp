## Context

The current `/sandbox` now demonstrates one PDPP story with client-side state and inspectable JSON. That is useful as pedagogy, but it is not the experience the owner is asking for. The missing experience is closer to a Stripe test-mode account or an OAuth playground: a hosted, credential-free reference instance where the dashboard and callable APIs behave like the real reference stack, but all state is deterministic and fictional.

There are three artifact boundaries to preserve:

- `/dashboard/**` remains the live local/self-hosted operator control plane and stays owner-gated when owner auth is configured.
- `/sandbox/**` becomes the public demo route family for fictional state. It may reuse dashboard UI patterns, but it must never call the live AS/RS or ask for credentials.
- `/docs/**` remains protocol/reference documentation, not a running demo.

## Goals / Non-Goals

**Goals:**

- Make `/sandbox` feel like a real PDPP reference instance, not a static explainer.
- Provide a dashboard-like demo surface backed by shared mock AS/RS state.
- Expose callable demo APIs under `/sandbox/v1/**` and `/sandbox/_ref/**` so humans, agents, and examples can interact with the same seeded state the UI renders.
- Include enough seeded data to demonstrate records, streams, schema discovery, search, grants, runs, traces, capabilities, revocation/refusal evidence, and reference-only timelines.
- Keep all seeded data obviously fictional and safe to expose publicly.
- Keep the demo deployable on Vercel without a long-running reference server, SQLite file, Docker, `.env.local`, connector runtime, or credentials.

**Non-Goals:**

- Do not expose the real `/dashboard/**` publicly as the sandbox.
- Do not stand up a hosted live owner reference server with personal data.
- Do not implement real OAuth, connector runs, browser automation, semantic indexing, or mutable server-side session storage.
- Do not claim protocol conformance beyond the specific demo APIs and flows implemented.
- Do not introduce a second source of truth for production reference behavior; the demo is a derived educational surface.

## Decisions

### 1. Use `/sandbox` for the demo instance and move the static story under `/sandbox/walkthrough`

The primary `/sandbox` route should become the demo reference instance entry point. The existing static walkthrough can remain as `/sandbox/walkthrough` or an embedded "guided story" panel, but it should no longer be the whole sandbox.

Alternative considered: keep `/sandbox` as the walkthrough and add `/demo`. That avoids moving code but preserves the user-facing mismatch. The product expectation attached to "sandbox" is a runnable playground; `/sandbox` should satisfy it directly.

### 2. Prefix demo APIs with `/sandbox`

Expose mock AS/RS routes as:

- `/sandbox/.well-known/oauth-authorization-server`
- `/sandbox/.well-known/oauth-protected-resource`
- `/sandbox/v1/schema`
- `/sandbox/v1/streams`
- `/sandbox/v1/streams/:stream`
- `/sandbox/v1/streams/:stream/records`
- `/sandbox/v1/streams/:stream/records/:id`
- `/sandbox/v1/search`
- `/sandbox/_ref/traces`, `/sandbox/_ref/traces/:traceId`
- `/sandbox/_ref/grants`, `/sandbox/_ref/grants/:grantId/timeline`
- `/sandbox/_ref/runs`, `/sandbox/_ref/runs/:runId/timeline`
- `/sandbox/_ref/dataset/summary`

The prefix keeps the public demo from masquerading as the production AS/RS root while preserving familiar path shapes for developers and agents.

Alternative considered: serve demo APIs from root `/v1/**` on `pdpp.dev`. That would be convenient for copy-paste, but it would blur protocol documentation, production reference expectations, and the demo. The first public version should be explicit.

### 3. Keep demo state deterministic and module-backed

Seeded state should live in a typed module shared by the demo UI and demo route handlers. The route handlers should call response-builder functions rather than duplicating JSON inline. The UI should consume the demo API/client layer wherever practical so API and UI drift is visible.

Alternative considered: per-visitor server sessions. That creates persistence, reset, abuse, and deployment questions for no first-slice benefit. Deterministic module state is enough to demonstrate the reference contract and is much easier to verify.

### 4. Build a sandbox-specific dashboard shell instead of weakening `/dashboard`

The worker may reuse dashboard primitives, timeline views, status badges, cards, and layout patterns. It should not import live dashboard clients that mint owner tokens or require owner sessions. Create sandbox-specific clients/components as needed.

Alternative considered: add a "demo mode" flag to the existing `/dashboard/**` route. That would risk weakening owner gating and make every live operator page reason about two data sources. A sandbox route family is safer.

### 5. Make API discoverability part of the product surface

The sandbox should show endpoint examples and copyable curl snippets against `/sandbox/v1/**` and `/sandbox/_ref/**`. Agents should not have to infer paths from REST conventions. This directly addresses prior confusion around schema, blob, changes_since, and search endpoints.

## Risks / Trade-offs

- **Risk: Demo API drifts from live reference behavior** -> Keep the first slice small, use typed response builders, and add tests that exercise both UI/client functions and route handlers.
- **Risk: Visitors mistake demo data for a hosted owner instance** -> Use persistent "Demo instance / fictional data" chrome, seeded names, and `/sandbox` URL prefix.
- **Risk: Reusing dashboard code weakens owner auth** -> Do not route `/dashboard/**` through demo mode. Keep sandbox clients separate from owner-token clients.
- **Risk: Scope balloons into a full fake reference server** -> Deliver one coherent vertical slice with records/search/schema/grants/runs/traces/deployment rather than every route and mutation.
- **Risk: Static module state cannot demonstrate mutation** -> For this tranche, represent revocation and failures as seeded traces/grants/runs. Add per-visitor mutable state only in a later explicit change if needed.

## Migration Plan

1. Move or preserve the existing static walkthrough as `/sandbox/walkthrough`.
2. Add a typed sandbox demo dataset and response builders.
3. Add demo API route handlers under `/sandbox/v1/**`, `/sandbox/_ref/**`, and `/sandbox/.well-known/**`.
4. Add sandbox dashboard pages that consume the demo clients and expose the same high-level operator sections as the real dashboard.
5. Update `/reference`, `/reference/coverage`, and sandbox copy so the demo instance is presented as mock AS/RS-backed evidence.
6. Validate with OpenSpec, web typecheck/check/build, route-handler tests, and smoke requests against the built app if practical.

## Open Questions

None blocking for the first slice. Future work may decide whether demo state should support per-visitor mutations, shareable sessions, or a separate subdomain. Those are intentionally deferred until the deterministic demo proves useful.
