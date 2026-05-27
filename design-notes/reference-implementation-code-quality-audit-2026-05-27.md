# Reference Implementation Code Quality Audit

Status: decided-promote
Owner: reference implementation owner
Created: 2026-05-27
Updated: 2026-05-27
Related: openspec/changes/complete-reference-operation-refactor, openspec/changes/complete-postgres-runtime-boundary, openspec/changes/split-public-site-and-operator-console, openspec/changes/add-schema-validation-coverage, tmp/workstreams/code-quality-deep-audit-report.md

## Question

What structural code-quality gaps keep the reference implementation below the 95% SLVP bar, and which changes should be promoted into OpenSpec work rather than treated as local cleanup?

## Context

A read-only audit was run against the reference implementation with emphasis on DRY, proper abstractions, separation of concerns, modular design, Ultracite/Biome/static-analysis coverage, TypeScript coverage, and Hickey-style essential complexity. The full worker report remains at `tmp/workstreams/code-quality-deep-audit-report.md`; this note preserves the durable conclusions.

The audit found several strong primitives already in place: framework-agnostic `operations/*`, bounded SQLite query files through `lib/db.ts`, conformance harnesses, zod-backed connector record validators, strict TypeScript in migrated packages, and Ultracite-backed Biome configs.

## Stakes

This is not cosmetic cleanup. The current weak points make correctness harder to prove and increase the chance that new features bypass the good construction boundaries already built. The risk is accreting feature code around legacy seams instead of migrating the reference implementation onto its intended architecture.

## Current Leaning

The repository is not yet at the 95% SLVP code-quality bar. The most important gaps are construction gaps:

- Runtime contract validation is not wired. The reference contract package has validators, and many routes carry operation IDs, but the transport currently disables Fastify validation and the referenced `contractValidation()` middleware does not exist.
- `reference-implementation/server/index.js` is a 9k-line composition/god file that concentrates routing, context setup, error mapping, and business logic.
- SQLite and Postgres storage paths are complected by many `isPostgresStorageBackend()` branches instead of being hidden behind a storage interface.
- `apps/console` and `apps/web` remain forked enough that dashboard/operator UI code must be updated in lockstep until `packages/operator-ui` is extracted.
- Large load-bearing JavaScript files are outside TypeScript and Biome coverage.
- The pnpm build-script allowlist had drifted into an obsolete location; this was fixed immediately in `fix(workspace): restore pnpm build allowlist`.

The next promoted work should be small construction tranches, not a broad rewrite:

- Wire contract validation at the route boundary and delete the stale phantom-middleware claim.
- Extract the shared operator UI package before continuing public-site/operator-console divergence.
- Introduce a storage backend interface, starting with retained-size/read-model paths, then records, then auth.
- Split `server/index.js` by route family as files migrate to TypeScript.
- Add reference-implementation CI on PRs.
- Archive completed OpenSpec changes to reduce active-change noise.

## Promotion Trigger

Promote each construction tranche before implementation because each changes durable architecture boundaries, validation behavior, storage shape, CI gates, or public operator-console package structure.

## Decision Log

- 2026-05-27: Captured audit outcome. The immediate pnpm allowlist drift was fixed as a small hygiene commit because it restored a declared package-manager security gate and did not require a new contract.
- 2026-05-27: Attempted to promote `reference-implementation run verify` directly into CI. Local validation showed the current Ultracite baseline still fails with hundreds of diagnostics in already-migrated TypeScript files, so the immediate CI gate was narrowed to typecheck plus tests. Ultracite enforcement remains a promoted cleanup tranche rather than a silently failing gate.
- 2026-05-27: Attempted to promote the entire `reference-implementation run test` suite into CI. The suite is not yet a stable gate: native-provider CLI/integration tests for owner/client reads without public `connector_id` currently fail with `No active connection is available` / 404. The immediate CI gate therefore covers typecheck plus the stable contract surfaces changed by recent work: client event subscriptions, protected-resource metadata, query capability truth, granted connections, fan-in reads, query contracts, and operation boundaries. Full-suite stabilization remains follow-up quality work rather than a fake-green gate.
