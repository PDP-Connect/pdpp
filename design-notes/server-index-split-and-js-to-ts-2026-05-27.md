# Reference Server `index.js` Split + JS→TS Migration

Status: captured
Owner: project owner
Created: 2026-05-27
Updated: 2026-05-27
Related: `openspec/changes/complete-reference-operation-refactor`, `tmp/workstreams/code-quality-deep-audit-report.md` (Findings #2, #5)

## Question

What is the safe, owner-reviewable shape and order for:

1. decomposing `reference-implementation/server/index.js` (currently ~9,316 LOC, 111 route handlers) into per-route-family modules;
2. moving those modules from `.js` (no Biome, no `tsc --noEmit`) to `.ts` so the load-bearing server code participates in the same construction-quality gates the rest of the workspace already enforces?

Both findings are downstream of the now-completed `complete-reference-operation-refactor` (31/31 tasks). With protocol/business/storage semantics already lifted into `operations/*`, `index.js`'s remaining role is HTTP wiring, owner-auth, request-id, trace, response writing, instrumentation, and concrete capability binding. That is the work that should split cleanly along route families.

## Context

- Operation boundary is established: `complete-reference-operation-refactor` requires that "route-specific code SHALL be limited to HTTP wiring, authentication or owner-session checks, request/header adaptation, request id and trace id setup, instrumentation dispatch, response writing, and concrete capability wiring."
- Route taxonomy is observable: AS OAuth/device/PAR/consent/DCR/introspection, `_ref` diagnostics (timeline, deployment, clients, dataset summary), RS public reads (streams, schema, records, search, blobs), RS record mutations (delete, ingest), RS connector state, `__pdpp` runtime, web-push, agent-connect, neko/stream surfaces, content-negotiated root.
- Biome `includes` filter in `reference-implementation/biome.jsonc` explicitly enumerates `.ts` glob patterns; `.js` is excluded by construction, not by accident — every migrated file gets visibility automatically.
- `tsconfig.json`: `checkJs: false`, `allowJs: true`. JS files compile-link but aren't type-checked.
- Existing tests cover the route surface (`reference-implementation/test/**`), which is why the operations refactor was safe to land.
- Audit finding text recommends `routes/oauth.ts`, `routes/agent-connect.ts`, `routes/device.ts`, `routes/_ref.ts`, `routes/connectors.ts`, `routes/v1.ts`, `routes/discovery.ts`, `routes/web-push.ts` — a reasonable initial split.

## Stakes

- The reference implementation is the protocol's source of truth for runtime behavior. A bad split (lost middleware order, dropped header wiring, broken owner-auth posture, regressed error envelopes) is a behavior regression even with no protocol-level intent change.
- 48,850 LOC of `.js` is currently un-linted and un-typechecked. Every commit silently widens this gap. The audit calls this "the single biggest CI gap for the reference implementation."
- The two tasks are coupled: an `.ts` rewrite of `index.js` in place is unsafe and unreviewable; a `.js` split alone leaves the new modules un-gated; the sensible order is **split → migrate per split file**.
- A wrong split granularity (one route per file, vs. one family per file) makes the tree harder to navigate than the monolith.

## Current Leaning

Promote to a single OpenSpec change `split-reference-server-by-route-family` with the following shape:

1. **Define the split taxonomy** (8 route families + a thin `index.{js,ts}` composition root). Pin it in a design.md table.
2. **Acceptance bar** per migrated file: ≤ 800 LOC; no function exceeding Biome's default cognitive-complexity budget of 20; Biome `includes` filter updated to cover the new `.ts` file; existing tests stay green.
3. **Per-family worker lane**: one bounded worker per file, validated independently (`pnpm --dir reference-implementation run verify` + targeted tests). Mechanical move-and-migrate in one commit per family, not interleaved.
4. **Sequencing constraint**: do `_ref/*` and `discovery/*` first (smallest, lowest behavioral risk, exercise content negotiation and owner-auth wiring without storage mutations). Defer `auth.js`-touching families (OAuth, device, consent, DCR) until later — `server/auth.js` (3,937 LOC) is the second-largest legacy file and shares state with those routes.
5. **No-op behavior contract**: each migration tranche is required to preserve middleware order, error envelopes, header shaping, request-id propagation, and spine event emission. Pinned by the existing route-behavior tests, plus one new "byte-identity" test per migrated family that compares response shapes from the migrated mount against fixtures.

## Promotion Trigger

Promote into OpenSpec as soon as the project owner approves the split taxonomy. The note is captured-only until then.

Specifically, promotion is justified because:

- this is a multi-step implementation tranche (≥ 8 dispatchable worker lanes);
- it changes an architecture boundary (per-route-family modules become a durable shape);
- it widens the construction-quality gate (Biome `includes` filter expands as each family lands);
- it intersects with the in-flight `split-public-site-and-operator-console` (which already content-negotiates the root handler in `index.js`).

Pre-promotion blockers to resolve in the proposal:

- Whether to put route families under `reference-implementation/server/routes/<family>.ts` or `reference-implementation/routes/<family>.ts`. The operations layer is at `reference-implementation/operations/*`; route adapters arguably belong at a sibling level rather than nested inside `server/`.
- Whether the migration to `.ts` happens in the same commit as the extraction, or as a follow-up tranche per family. The audit's recommendation ("migrate to TS as each is extracted") collapses to one commit per family; that is simpler to review but larger per diff.
- Whether the `@ts-check` interim path (audit Tranche 5 alt 1) is worth pursuing for `auth.js` (3,937 LOC) and `records.js` (3,386 LOC), which are NOT route files and therefore don't participate in the family split. Without `@ts-check`, those two stay un-typechecked even after the index.js split lands.

## Non-Goals

- This note does NOT propose introducing a new architectural abstraction (router, controller layer, service objects, repository, DDD aggregate). The operations boundary already exists and is the right Hickey-flavored seam — see `design-notes/broad-storage-abstraction-2026-04-24.md`. The split is mechanical: same wiring, different file.
- This note does NOT propose a `.js → .ts` sweep of the 73 untyped JS files in a single change. That is exactly the kind of "broad rewrite" the playbook's anti-patterns list warns against.
- This note does NOT touch the `isPostgresStorageBackend()` branches (Audit Finding #3). Those have their own design-deferred path (`broad-storage-abstraction-2026-04-24.md` → `complete-postgres-runtime-boundary`).
- This note does NOT propose changing the public route surface, error envelopes, or any protocol-observable behavior.

## Decision Log

- 2026-05-27: Captured. Audit identified findings #2 and #5 as P0/P1 construction-quality gaps; the operations refactor is now complete so the next step is wiring-only file split. Owner approval required before promoting to OpenSpec.
