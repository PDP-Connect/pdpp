## Why

The archived `fix-rs-query-memory-pressure` change fixed the read paths that
were proven to trigger a V8 scavenger crash under dashboard load. A later
operator run reproduced the same failure class through a different path:
reference spine timeline rendering could still materialize every event for a
long-running correlation before responding.

This change closes that specific regression and adds a durable wrapper/registry
foundation so new database reads are harder to author unsafely. Owner review
found that the first draft overclaimed a total migration of every historical
`db.prepare(...)` call site. This proposal is intentionally narrower: it makes
the implemented guarantees explicit and records the remaining broad migration
as follow-up work rather than implied truth.

## What Changes

- Add a typed SQL wrapper at `reference-implementation/lib/db.ts` with explicit
  primitives for single-row reads, bounded page reads, iterators, mutations,
  transactions, and acknowledged small-enumeration scans.
- Extend the query registry under `reference-implementation/server/queries/` so
  static SQL artifacts declare their terminator and, for multi-row reads, either
  a `LIMIT ?` placeholder or a `small_enumeration_table` bound.
- Migrate the reference spine timeline endpoints to SQL-paginated reads with
  caller-visible `limit`, `cursor`, `truncated`, and `next_cursor` fields.
- Bound correlation summary hydration and use SQL aggregate values for
  `first_at`, `last_at`, and `event_count` so capped hydration does not
  underreport the full correlation extent.
- Add a staged-file pre-commit gate that blocks newly introduced direct
  `db.prepare(...)` / `getDb().prepare(...)` calls outside the wrapper,
  registry, and database engine internals.
- Leave remaining grandfathered direct-prepare and dynamic-SQL call sites
  auditable but not yet fully eliminated. Those are tracked as follow-ups.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: narrows the memory-pressure
  invariant to the implemented spine timeline pagination and wrapper foundation,
  adds the staged-file direct-prepare prevention requirement, and documents the
  correlation-summary aggregate extent guarantee.

### Added Capabilities

None.

### Removed Capabilities

None.

## Impact

- `reference-implementation/lib/db.ts` — new wrapper and cursor/error helpers.
- `reference-implementation/server/queries/**` — registered SQL artifacts and
  loader validation.
- `reference-implementation/lib/spine.ts` — paginated event reads, bounded
  summary hydration, aggregate extent preservation.
- `reference-implementation/server/index.js` and control-plane helpers —
  `_ref` timeline and summary consumers use the paginated/wrapper path.
- `apps/web/src/app/dashboard/**` — dashboard consumers understand additive
  pagination metadata.
- `lefthook.yml` — new staged-file guard against newly introduced direct
  prepares.
- `openspec/changes/bound-spine-and-record-read-paths/design-notes/` — durable
  memory-regression and DB-call-site audit notes.
