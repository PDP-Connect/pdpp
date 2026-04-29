## Context

The current refactor deliberately chose a slower but safer sequence:

1. mount canonical operation capsules;
2. add operation-boundary gates;
3. extract conformance harnesses from SQLite behavior;
4. prove those harnesses against at least one conforming non-SQLite or fixture adapter;
5. only then promote production storage/search interfaces.

Steps 1-3 are substantially underway. Step 4 is incomplete for record-read, record-mutation, and disclosure-spine. Without those second adapters, a production storage abstraction would still be speculative.

## Batch Strategy

This change is intentionally a larger batch. Three workers can implement disjoint adapters in parallel, and the owner reviews once against a shared invariant checklist.

### Lane 1: record-read memory + Postgres proof

Record-read is the highest-value storage boundary because it touches cursor ordering, `changes_since`, projection, declared filters, missing/null cursor buckets, and future Postgres feasibility.

The lane should add:

- `memory-record-read-driver.js`
- `record-read-conformance-memory.test.js`
- `postgres-record-read-driver.js`
- `record-read-conformance-postgres.test.js`

The Postgres test must be env-gated by `PDPP_TEST_POSTGRES_URL` and use the existing profile-gated Compose service. It must not add runtime Postgres configuration.

### Lane 2: record-mutation memory proof

Record mutation owns per-stream version allocation, no-op re-ingest, delete semantics, rollback behavior, and contiguous `record_changes`. A memory driver is enough for the next proof because the hard production question is not SQL syntax yet; it is whether the harness expresses semantics independent of SQLite.

The lane should add:

- `memory-record-mutation-driver.js`
- `record-mutation-conformance-memory.test.js`

### Lane 3: disclosure-spine memory proof

Disclosure spine owns append/list ordering, timeline pagination, terminal/latest event lookup, rejected-vs-served visibility, and summary extent. A memory driver proves these are semantic obligations rather than `spine_events` SQL shape.

The lane should add:

- `memory-disclosure-spine-driver.js`
- `disclosure-spine-conformance-memory.test.js`

## Owner Review Checklist

The consolidated owner review must verify:

- no production runtime code changed unless a worker provides a narrow, compelling test-only-export rationale;
- no `RecordStore`, `DisclosureSpineStore`, `LexicalIndex`, or `SemanticIndex` production interface was introduced;
- no Kysely or runtime Postgres dependency was added;
- each driver implements the existing harness rather than weakening scenarios;
- each lane includes a self-falsification note showing a deliberate bug fails at least one relevant scenario;
- default test runs remain green without Postgres, with Postgres tests skipped honestly when `PDPP_TEST_POSTGRES_URL` is unset;
- Postgres record-read passes against the Compose proof service when the env var is set.

## Out Of Scope

- Production storage/search abstraction extraction.
- Runtime `PDPP_STORAGE_BACKEND` or `PDPP_DATABASE_URL`.
- Search adapters, lexical/semantic/vector portability, and Kysely adoption.
- `expand[]` conformance expansion.
- Dashboard, sandbox, AS/RS operation route rewiring.

## Stop Conditions

- A worker needs to alter production code to make a second adapter pass.
- A memory driver grows into a large copy of production runtime behavior rather than an adapter over harness semantics.
- A Postgres driver requires changing public cursor/token semantics rather than treating cursors as adapter-owned opaque tokens.
- Any lane tries to merge OpenSpec task edits in parallel with another lane.

