## Context

The ideal reference architecture plan identifies `DisclosureSpineStore` as a future capability-specific contract, but it also warns that spine behavior must be tested before extraction. The recent memory-regression work bounded timeline reads; this change turns core spine semantics into reusable conformance evidence without moving production code.

## Goals / Non-Goals

**Goals:**

- Define a narrow test-only driver for disclosure-spine semantics.
- Run reusable scenarios against the current SQLite-backed spine implementation.
- Prove the harness is falsifiable with a deliberately broken fixture or targeted negative proof.
- Cover append order, correlation timeline ordering/cursors, terminal event lookup, rejected vs served event visibility, and correlation summary aggregate extent where compact.

**Non-Goals:**

- Do not create or export production `DisclosureSpineStore`.
- Do not add Postgres, memory runtime profile, operation capsules, or route refactors.
- Do not cover record read/mutation, lexical, semantic, hybrid, blob, or connector runtime behavior.
- Do not rewrite the existing `_ref` timeline routes.

## Decisions

### 1. Driver shape is semantic, not SQL-shaped

The driver should expose behavior such as append event, list timeline, list summaries, and get terminal/latest event. It should not expose raw SQL, query builders, framework routes, or a generic repository surface.

### 2. SQLite driver should reuse production spine helpers

The current SQLite-backed driver should call existing spine helper functions where possible. Direct DB reads are acceptable only for test-only setup/verification when no helper exists.

### 3. Falsifiability is required

The harness must demonstrate failure against at least one deliberately wrong behavior, such as unstable timeline ordering, missing terminal event, or aggregate summary extent derived only from a truncated page.

### 4. Scope can be staged inside the change

If a full `_ref` route-equivalence harness would require too much setup, keep this to helper-level semantics and document route parity as follow-up. The minimum acceptable slice is append/list ordering, terminal lookup, and summary extent.

## Risks / Trade-offs

- Harness duplicates route-level tests -> keep assertions semantic and route-independent.
- Spine helper APIs are too implementation-shaped -> keep the driver as a boundary layer so future adapters can implement the same scenarios differently.
- Aggregate extent is hard to prove compactly -> include a small capped-hydration scenario or explicitly defer it with rationale.
- Worker changes runtime to expose helpers -> reject unless it is a minimal test-only export with owner-readable rationale.

## Migration Plan

1. Inventory existing spine tests and helper functions.
2. Add the test-only harness and SQLite driver.
3. Add a broken fixture/negative proof.
4. Run targeted spine tests and OpenSpec validation.
5. Leave production extraction to a later change.
