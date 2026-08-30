## Why

PostgreSQL bootstrap still awaits the optional semantic HNSW graph build after
the pgvector column migration. On a large semantic corpus this derived index
can take hours, so a healthy database remains unavailable even though vector
reads are correct without the graph.

## What Changes

- Keep required schema and pgvector representation migration synchronous.
- Record one durable HNSW build job and run its bounded, single-owner builder
  after AS/RS listeners bind.
- Retry interrupted or failed builds on a later post-listen attempt, while
  exposing durable failure state and preserving exact vector-read fallback.

## Capabilities

### Modified

- `reference-implementation-architecture`

### Added

None.

### Removed

None.

## Impact

PostgreSQL startup ordering, semantic index maintenance, and dedicated Postgres
tests. SQLite behavior and semantic result semantics are unchanged.
