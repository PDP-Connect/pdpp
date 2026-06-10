## Context

The reference architecture plan says storage/search abstractions are only acceptable after current SQLite obligations are captured as executable conformance. The write side now has that shape. The read side is broader and riskier: cursor ordering, missing/null bucket behavior, `changes_since`, field projection, range filters, and `expand[]` can all leak SQLite JSON/collation assumptions if an interface is invented first.

This change is a test-only bridge. It should make the read obligations explicit without moving production code.

## Goals / Non-Goals

**Goals:**

- Define a narrow test-only driver for record read/list semantics.
- Run reusable read scenarios against the current SQLite implementation.
- Prove the harness is falsifiable with a deliberately broken fixture or targeted negative proof.
- Cover the highest-risk read semantics first: stable pagination/cursors, missing/null ordering, `changes_since=beginning` and cursor round trip, field projection, exact/range filters, and safe parent-child expansion if a compact fixture can cover it.

**Non-Goals:**

- Do not create or export production `RecordStore`.
- Do not add Postgres, memory runtime profile, operation capsules, or route refactors.
- Do not attempt to cover lexical, semantic, hybrid, disclosure spine, blob content, or connector runtime behavior.
- Do not duplicate every route-level assertion if a smaller semantic scenario provides the same evidence.

## Decisions

### 1. Driver is test-only and semantic

The driver should provide setup/teardown, fixture seeding, read/list calls, and simple grant/projection setup if needed. It should not expose raw SQL, query builders, route objects, or generic repository methods.

### 2. SQLite driver should exercise public read helpers or HTTP routes where needed

If the current read behavior is only exposed through HTTP route handlers, the SQLite driver may start the reference test server or use existing helper patterns from nearby tests. Prefer the smallest route-realistic path that proves behavior without broad runtime edits.

### 3. Falsifiability is mandatory

The harness must demonstrate failure against at least one intentionally wrong behavior, such as:

- cursor page repeats/skips rows
- null/missing bucket ordering is wrong
- `changes_since` cursor returns stale rows
- projection leaks ungranted fields

The broken fixture must remain under tests only.

### 4. Scope can be staged inside the change

If `expand[]` requires too much fixture setup, the worker should document it as a follow-up rather than building a mini-runtime. The minimum acceptable slice is pagination/cursor, `changes_since`, projection, and filters.

## Risks / Trade-offs

- Harness becomes route-shaped instead of semantic -> keep driver methods named after behavior, not HTTP internals.
- Harness misses important semantics -> require a falsifiability proof and link uncovered read behaviors in tasks.
- Worker changes runtime to make tests pass -> reject; this is a test-only conformance lane unless a real existing bug is found and reported separately.
- Fixture setup becomes too large -> stop at the smallest meaningful coverage and document what remains.

## Migration Plan

1. Inventory existing record read tests and pick reusable scenarios.
2. Add the test-only harness and SQLite driver.
3. Add a broken fixture/negative proof.
4. Run targeted read tests and OpenSpec validation.
5. Leave production extraction to a later change.
