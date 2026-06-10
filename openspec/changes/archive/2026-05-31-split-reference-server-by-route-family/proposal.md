## Why

`reference-implementation/server/index.js` is a 9,316-line module that registers 111 HTTP route handlers across at least nine distinct route families (root/discovery, `_ref/*` ops, RS reads, RS mutations, OAuth/consent/device, run interaction, web-push, remote surface, source webhooks). The operations refactor (`complete-reference-operation-refactor`) already lifted protocol/storage semantics into framework-agnostic `operations/*` modules; the remaining role of `index.js` is HTTP wiring — request-id propagation, owner/client auth, content negotiation, response writing, and concrete capability binding. That residual wiring is the work that should split cleanly along route families.

This module is also outside Biome and `tsc --noEmit` coverage by construction: `biome.jsonc` `includes` matches only `.ts`, and `tsconfig.json` sets `checkJs: false`. Every route extracted as `.ts` immediately joins both gates.

The deep code-quality audit (`tmp/workstreams/code-quality-deep-audit-report.md`, findings #2 and #5) named the route-family split as a P0 construction-quality gap. The captured design note `design-notes/server-index-split-and-js-to-ts-2026-05-27.md` pinned the taxonomy and acceptance bar. This change promotes that note into a durable proposal.

## What Changes

- Extract per-route-family HTTP adapter modules from `reference-implementation/server/index.js` into TypeScript files under `reference-implementation/server/routes/<family>.ts`.
- Land each family as its own behaviour-preserving move: same middleware order, same owner/client auth posture, same request-id and trace propagation, same headers, same response envelopes, same status codes, same spine event emission.
- Keep `server/index.js` as the composition root: it continues to own `buildAsApp`/`buildRsApp`, capability wiring, controller construction, store factories, and the `app.use(...)` global middleware. The composition root shrinks as each family lands.
- Use the existing operations boundary (`reference-implementation/operations/*`) without introducing a new router/controller/repository abstraction. Route adapters import operations and stores the same way `index.js` does today.
- Migrate each extracted family directly to `.ts` rather than landing `.js` first; do not create new untyped server modules.
- Update `reference-implementation/biome.jsonc` only if Biome `includes` does not already cover `server/routes/**/*.ts` (today it covers `server/**/*.ts`, which is sufficient — no config edit expected).
- Order tranches by behavioural risk: lowest first (`root-and-discovery`, `ref-operations`), then RS reads, then RS mutations and `run-interaction` external surfaces, with `as-oauth` deferred behind owner approval because the underlying `server/auth.js` (3,937 LOC) is heavily shared across OAuth routes.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: pin that the reference server's HTTP layer SHALL be decomposed into per-route-family adapter modules under `server/routes/<family>.ts`, that the composition root SHALL keep capability wiring and `app.use(...)` global middleware, and that extraction tranches SHALL be behaviour-preserving (middleware order, auth posture, headers, response envelopes, status codes, spine emission).

### Added Capabilities

- None.

### Removed Capabilities

- None.

## Impact

- Affected files: `reference-implementation/server/index.js`, new `reference-implementation/server/routes/*.ts` adapter modules, optionally `reference-implementation/biome.jsonc` only if `includes` needs broadening.
- No protocol-observable behaviour changes. No public route surface change. No error envelope change. No header change. No grant/manifest/schema change. No new external runtime dependency.
- Extracted routes immediately gain Biome and `tsc --noEmit` coverage, narrowing the un-linted JS footprint inside the reference implementation by ≈9k LOC across the full tranche.
- Existing tests (`reference-implementation/test/**`) cover route behaviour; targeted route-regression tests SHALL be added where current tests do not exercise a moved family directly.
- Stop-and-report triggers: any move that would change middleware order, auth posture, response envelope shape, or status codes; any unrelated dirty file; any family extraction that would exceed ~800 LOC in a single file.
