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

### 4. Build a mock-owner dashboard mode instead of a forked sandbox shell

The primary sandbox experience should be the reference dashboard running against a mock owner data source. `/sandbox` should behave like a "log in as mock owner" entrypoint: after entry, the visitor sees the same dashboard information architecture, feature components, and core copy as the live owner dashboard, with only a persistent and subtle "demo mode / fictional data" affordance. Educational material belongs in `/sandbox/api-examples`, `/sandbox/walkthrough`, help links, or secondary panels, not in the primary dashboard chrome.

This still must not weaken `/dashboard/**`. The live dashboard remains owner-gated and bound to live AS/RS clients. The mock-owner dashboard binds the same feature layer to deterministic sandbox data through an explicit data-source seam and route prefix.

Alternative considered: keep a sandbox-specific shell that resembles the dashboard. That is safer in the short term, but it creates the wrong product abstraction: a parallel tutorial app rather than the real reference dashboard with mocked dependencies. Owner review rejected that direction.

Alternative considered: expose a demo-mode flag on `/dashboard/**`. That would make public demo routing and owner-auth behavior easier to confuse. Keeping `/sandbox/**` as the route family while sharing the dashboard shell and feature components preserves a hard route boundary without forking the product experience.

### 5. Make API discoverability part of the product surface

The sandbox should show endpoint examples and copyable curl snippets against `/sandbox/v1/**` and `/sandbox/_ref/**`. Agents should not have to infer paths from REST conventions. This directly addresses prior confusion around schema, blob, changes_since, and search endpoints.

## Risks / Trade-offs

- **Risk: Demo API drifts from live reference behavior** -> Keep the first slice small, use typed response builders, and add tests that exercise both UI/client functions and route handlers.
- **Risk: Visitors mistake demo data for a hosted owner instance** -> Use a persistent but secondary "Mock owner / fictional data" banner, seeded names, and the `/sandbox` URL prefix.
- **Risk: Reusing dashboard code weakens owner auth** -> Do not route `/dashboard/**` through demo mode. Keep the live data source separate from the sandbox data source and add static guard tests proving live dashboard code does not import sandbox data.
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

## Owner Audit: The First Slice Is Not Yet The Intended Sandbox

After implementation, owner review found a product-architecture mismatch. The first slice created a useful public demo portal with callable mock APIs, but it did not create the stronger experience originally intended: the real reference dashboard experience with its AS/RS dependencies swapped for deterministic mock AS/RS behavior.

That distinction matters. A reviewer should feel like they are using PDPP's reference implementation in a safe sandbox environment, not a parallel tutorial app that resembles the reference. The current implementation is useful scaffolding, but it should be treated as an intermediate state until the dashboard is factored behind a live/mock data-source seam.

### Prior-art findings

- Stripe's sandbox model is an isolated environment that can be used from the Dashboard, CLI, and API. The core experience remains Stripe; the environment changes from live to simulated and isolated.
- Stripe test mode similarly uses API keys to create and retrieve simulated data, while dashboard state and integration flows remain familiar.
- Plaid Sandbox supplies rich test data and special sandbox-only endpoints for scenario setup, but consumers still exercise the same Link/API integration shape.
- Twilio test credentials are used the same way as live credentials; inputs are validated as if real, but no charging, state mutation, or carrier/real-world connection happens.
- Storybook/MSW's network-mocking pattern reinforces the same principle at UI scale: components keep making real network-shaped requests while the network layer supplies mocked responses.

### Current implementation audit

What is good:

- The seeded data is deterministic, fictional, and safe to expose publicly.
- `/sandbox/v1/**`, `/sandbox/_ref/**`, and `/sandbox/.well-known/**` are callable and share builders with the sandbox UI.
- The public site can demonstrate API shapes without Docker, `.env.local`, SQLite, credentials, or a running reference server.
- The live `/dashboard/**` owner boundary was not weakened.

What is wrong for the intended product:

- `/sandbox/**` is implemented as a forked route family with bespoke pages and a sandbox shell rather than the live dashboard bound to a mock data source.
- Many sandbox pages call response builders directly. They do not prove that the dashboard data-access layer can run against a mock AS/RS.
- The UI copy and navigation still feel pedagogical. The primary surface should feel like a working demo instance, with explanatory material demoted to banners, empty states, help panels, API examples, and `/sandbox/walkthrough`.
- The implementation cannot catch regressions in the real dashboard's records/search/grants/runs/traces experience because those pages are not what the visitor is using.

### Corrective decision

The intended architecture is a two-source dashboard:

- `live` source: current `/dashboard/**` owner-authenticated clients that talk to the configured AS/RS.
- `sandbox` source: deterministic mock AS/RS source backed by the seeded dataset and demo route handlers.

The reusable unit should be dashboard feature components and data contracts, not cloned pages. `/dashboard/**` binds the feature components to the live source and owner gate. `/sandbox/**` binds the same feature components to the sandbox source, shows persistent demo labeling, and never mints owner tokens or calls the live AS/RS.

For Next.js server components, this does not require browser-only MSW. The seam can be a typed server-side data-source interface plus route handlers that expose the same seeded state over `/sandbox/v1/**` and `/sandbox/_ref/**`. MSW remains useful for client-side/story-level tests, but the public deployed sandbox should not depend on a service worker.

The current mock API routes and seeded dataset should be retained. The corrective tranche should replace forked dashboard-like pages with shared dashboard feature components wherever practical, leaving only sandbox-specific chrome, demo labels, and API-example/walkthrough pages as bespoke sandbox UI.

### Owner correction: primary sandbox is mock-owner dashboard mode

Owner review on 2026-04-26 clarified that the acceptable product target is not "sandbox pages that use some shared dashboard views." The target is "log in as a mock owner, then use the real dashboard experience against mock AS/RS data." The implementation should therefore prefer:

- a sandbox launcher that explicitly enters mock-owner mode;
- shared dashboard shell/chrome/navigation for the primary experience;
- shared dashboard feature components and live-shaped data contracts;
- minimal persistent demo labeling rather than tutorial copy in the dashboard path;
- API examples and walkthroughs as secondary surfaces.

Any remaining divergence from the live dashboard experience must be deliberate, safety-driven, and documented.
