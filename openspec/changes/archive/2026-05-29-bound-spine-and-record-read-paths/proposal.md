## Why

The archived `fix-rs-query-memory-pressure` change fixed the read paths that
were proven to trigger a V8 scavenger crash under dashboard load. A later
operator run reproduced the same failure class through a different path:
reference spine timeline rendering could still materialize every event for a
long-running correlation before responding.

This change closes that specific regression and adds a durable wrapper/registry
foundation so database reads are harder to author unsafely. Owner review
turned the original broad migration goal into explicit invariants: static
application SQL goes through registered artifacts, dynamic SQL uses acknowledged
wrapper helpers, and production direct `db.prepare(...)` usage is confined to
the engine/wrapper/registry allowlist.

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
- Migrate the remaining production application-level direct-prepare sites to
  registered artifacts, bounded wrappers, or explicitly acknowledged dynamic
  helpers.

## Capabilities

### Added Capabilities

- `reference-implementation-architecture`: adds four new reference-only
  requirements that the prior `fix-rs-query-memory-pressure` change did not
  cover — SQL-paginated per-correlation spine timeline endpoints
  (`/_ref/{runs,grants,traces}/:id/timeline`), a typed bounded-read SQL wrapper
  with a startup-validated query registry, a staged-file direct-prepare
  prevention gate, and a correlation-summary aggregate-extent guarantee. These
  read paths and primitives are distinct from the enumerated-route invariant
  already canonicalized at `### Requirement: The RS read-path for enumerated
  routes SHALL not materialize unbounded result arrays`, which is explicitly
  scoped to its own change's read paths.

### Modified Capabilities

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
