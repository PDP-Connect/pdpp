# Records/Search/Postgres Success Plan

Status: decided-promote
Owner: owner-agent
Created: 2026-04-28
Updated: 2026-04-28
Related: openspec/changes/define-reference-operation-environments

## Question

How should PDPP set itself up to support future Postgres-capable reference environments without weakening the reference implementation's record, search, disclosure, and sandbox semantics?

## Context

The first architecture plan intentionally deferred records/search implementation until simpler proof slices existed. The owner correctly challenged that: if records/search cannot be addressed with high confidence, Postgres feasibility and the environment-abstraction plan collapse.

Four focused feasibility audits were run after that challenge:

- record reads, `changes_since`, cursors, filters, projection, and `expand[]`
- record writes, version allocation, `record_changes`, disclosure spine writes/listing/aggregates
- lexical retrieval and FTS portability
- semantic/hybrid retrieval and vector portability

The result is not "easy." The result is "viable only with contract corrections." This plan turns that finding into an execution sequence with confidence ratings and stop gates.

## Confidence Scale

- `95-100`: already proven or mechanically obvious.
- `85-94`: high confidence; still requires implementation validation.
- `70-84`: plausible and well-scoped; needs proof before broad migration.
- `55-69`: useful direction, but not implementation-ready.
- `<55`: do not commit to this direction yet.

## Executive Plan

### Phase 0 — Keep SQLite As The Reference Baseline

Confidence: `95`

Decision: do not start by adding Postgres. First make the current SQLite semantics executable and stricter.

Why: SQLite is not the problem. Hidden semantics are the problem. Postgres should be an adapter proof against clarified PDPP semantics, not the thing that defines those semantics.

Exit criteria:

- Current SQLite behavior is documented as either normative or accidental.
- Every later phase has a conformance test target.
- No operation code is allowed to claim "portable" until the conformance target exists.

### Phase 1 — Harden Record Ingest Atomicity In SQLite

Confidence: `90`

This should happen even if PDPP never ships Postgres. The audits found a real correctness issue: per-stream version allocation is currently read-then-write and not protected by an explicit ingest transaction.

Scope:

- Make current-state read, no-op detection, version allocation, record upsert/delete, `record_changes` append, and `version_counter` advance one atomic writer-serialized unit.
- Keep search indexing out of that transaction.
- Keep disclosure spine writes out of that transaction.
- Treat index/spine follow-up as separate operation-layer effects with explicit recovery/diagnostic behavior.

Required tests:

- Parallel writes to the same `(connector_id, stream)` produce unique contiguous versions.
- Crash/fault between record write and version-counter advance cannot create a colliding next version.
- Identical re-ingest does not bump version.
- Re-delete does not bump version.
- `changes_since` sees contiguous versions under concurrent writes.

Risks:

- SQLite write contention increases if the transaction is too broad.
- A bad implementation could turn `RecordStore` into a god layer.

Owner gate:

- The transaction must cover only durable record mutation.
- If search index or spine writes need to be in the same transaction, the design is wrong and must stop.

### Phase 2 — Build The Conformance Harness Before Store Extraction

Confidence: `86`

The conformance harness is the real product of this tranche. Interfaces should be derived from tests, not invented and then justified.

Harnesses:

- `RecordStore` read conformance: cursor ordering, missing/null placement, `changes_since`, projection equality, field projection, range filters, `expand[]`, cursor invalidation.
- `RecordStore` write conformance: atomic ingest, version monotonicity, no-op/delete behavior, crash boundaries.
- `DisclosureSpineStore` conformance: explicit event sequence, terminal-event lookup, correlation summary ordering, stable aggregate cursors.
- `LexicalIndex` conformance: backend identity, tokenizer/score disclosure, grant-safe field planning, snippet field-safety, snapshot cursor invalidation.
- `SemanticIndex` conformance: model/profile/dtype/dimensions/metric identity, recall determinism, index-state transitions, backfill resume, tie ordering.
- Hybrid conformance: round-robin fusion, dedup/provenance, separate score metadata, no cursor until snapshot fusion is proven.

Exit criteria:

- Tests fail against an intentionally wrong fixture.
- Tests pass against the current SQLite implementation after Phase 1.
- At least one small second implementation, memory or fixture-backed, passes the low-risk subset.

Stop gates:

- If memory/fixture `RecordStore` duplicates most of `records.js`, the proposed boundary is too coarse.
- If tests require asserting SQLite collation or FTS tokenizer behavior as universal truth, the contract is leaking.
- If spine aggregate behavior cannot be tested without dynamic SQL knowledge, the spine contract is underspecified.

### Phase 3 — Draft Capability Contracts From The Harness

Confidence: `84`

Only after conformance tests exist should the project write formal store/index contracts.

Contracts:

- `RecordStore`
- `DisclosureSpineStore`
- `LexicalIndex`
- `SemanticIndex`
- optional `SearchSnapshotStore`
- existing lower-risk stores: `ConsentStore`, `OwnerDeviceAuthStore`, `ConnectorStateStore`, `SchedulerStore`

Required design constraints:

- No generic `Repository<T>`.
- No cross-capability mega-transaction.
- No ORM/query-builder objects above adapter level.
- No hidden `rowid` contract.
- No hidden lexical score/tokenizer identity.
- No hidden vector recall behavior.
- No stable claim for native storage byte counts.

Confidence by contract:

- `ConsentStore`: `94`
- `OwnerDeviceAuthStore`: `94`
- `ConnectorStateStore`: `88`
- `SchedulerStore`: `86`
- `RecordStore` reads: `80`
- `RecordStore` writes after Phase 1: `88`
- `DisclosureSpineStore`: `78`
- `LexicalIndex`: `82`
- `SemanticIndex`: `75`
- Hybrid operation contract: `85`

### Phase 4 — Prove The Low-Risk Architecture Shape First

Confidence: `88`

Before records/search migration, prove that operation capsules and environment profiles work on less dangerous surfaces.

Proof slices:

1. `ConsentStore` + `OwnerDeviceAuthStore` with SQLite and memory adapters.
2. `ConnectorStateStore` + `SchedulerStore` with SQLite and a non-default adapter spike.
3. `rs.streams.list` mounted through Fastify and Next sandbox over the same operation implementation.
4. `rs.schema.get` after manifest-store shape is settled.

Why this still matters after records/search feasibility:

- It validates import boundaries.
- It validates operation capsules.
- It validates sandbox-as-host rather than sandbox-as-fork.
- It lets the team debug architecture mechanics away from the hardest data paths.

Stop gates:

- Operation capsules import Fastify, Next, SQLite, or process env directly.
- Next sandbox still needs separate AS/RS builders for the same operation.
- Generated/reference contract artifacts drift from runtime behavior.

### Phase 5 — Records/Search Adapter-Readiness Proof

Confidence: `72` now, `84` after Phases 1-4

This is the first point where records/search should be extracted behind contracts.

Scope:

- Extract the smallest `RecordStore` subset needed for one or two operations.
- Use current SQLite adapter plus a memory/fixture adapter first.
- Do not add Postgres yet.
- Keep operation outputs byte-identical against the current local server for supported scenarios.

Candidate first operations:

- `records.get`
- `records.list` for one stream with one cursor field
- `changes_since=beginning` for one stream

Defer:

- full cross-connector records browsing
- all expand relation families
- lexical/semantic/hybrid adapter swaps
- Postgres

Stop gates:

- Byte-identical output cannot be preserved for the supported subset.
- Cursor semantics require exposing adapter internals.
- The memory adapter becomes a duplicate implementation of the whole runtime.

### Phase 6 — Postgres Spike, Explicitly Non-Product

Confidence: `62` now, `78` after Phase 5

The first Postgres work should be a spike, not a product feature. Its purpose is to test whether the contracts are honest, not to support operators.

Scope:

- Postgres adapter for a narrow `RecordStore` read/write subset.
- Postgres mapping for `version_counter` via `INSERT ... ON CONFLICT ... RETURNING` or `SELECT ... FOR UPDATE`.
- `jsonb` mappings for typed cursor/range comparisons.
- optional lexical experiment with `tsvector('simple')` or `pg_trgm`, advertised with distinct backend identity.
- optional semantic experiment with `pgvector`, advertised with explicit recall kind and vector identity.

Non-goals:

- no production migration guide
- no dual-write
- no operator-facing Postgres support claim
- no attempt to normalize scores across lexical/semantic backends

Required comparison:

- SQLite and Postgres run the same conformance suite.
- Selected record-list pages are byte-identical where the contract requires byte identity.
- Search outputs are contract-equivalent, not falsely identical, where backend identity permits differences.

Stop gates:

- Postgres cannot preserve per-stream version monotonicity.
- Postgres cannot reproduce record cursor pages for supported typed cursor fields.
- pgvector filtering needs overscan so large it invalidates the advertised recall/resource model.
- lexical backend identity is rejected as too noisy for public capability metadata.

### Phase 7 — Sandbox Becomes A Real Host Of Reference Operations

Confidence: `80`

The current sandbox should not remain a parallel AS/RS implementation. It can keep fixture data and educational UI, but AS/RS behavior should come from the same operations as the real reference host.

Sequence:

1. Mount `rs.streams.list` through Fastify and Next sandbox from the same operation.
2. Delete the corresponding hand-built sandbox builder.
3. Repeat for schema, records, search, well-known metadata, and selected `_ref` reads.
4. Add import-boundary tests that prevent new sandbox AS/RS behavior from appearing in `apps/web` without operation backing.

Confidence:

- operation reuse model: `86`
- complete sandbox parity migration: `74`
- Vercel-compatible mock reference host: `78`

Stop gates:

- Next route handlers need to reimplement auth/data semantics instead of adapting operation dependencies.
- Fixture environment cannot express grant/owner/source descriptors without forking behavior.
- The public sandbox UI needs behavior that the real reference operation cannot represent.

## Confidence Summary

| Area | Confidence | Meaning |
| --- | ---: | --- |
| Keep SQLite as semantic baseline | 95 | Correct and low-risk. |
| Atomic record ingest is directionally right | 92 | Needed regardless of Postgres. |
| Atomic record ingest implementation | 90 | Straightforward if scoped narrowly. |
| Capability-specific contracts over generic repository | 90 | Strong architectural fit. |
| Operation capsules as AS/RS truth | 88 | Strong, but needs proof via `rs.streams.list`. |
| Record read portability | 80 | Credible; depends on explicit cursor/collation tests. |
| Record write portability after atomicity fix | 88 | Credible; current bug must be fixed first. |
| Disclosure spine portability | 78 | Credible; needs `event_seq` and aggregate contract tests. |
| Lexical portability | 82 | Credible if backend/tokenizer/score identity is public. |
| Semantic portability | 75 | Credible if recall kind and vector identity are public. |
| Hybrid portability | 85 | Credible because it remains operation-level fusion. |
| Kysely as adapter-internal tool | 80 | Helpful below the contract, dangerous above it. |
| First Postgres spike today | 62 | Too early for product, OK as later proof. |
| Production Postgres support | 45 | Not enough evidence yet. |
| Production Postgres after Phases 1-6 pass | 75 | Plausible but still requires workload/perf evidence. |

## Owner Recommendation

Proceed, but with a stricter interpretation than the first draft:

1. Fix SQLite record ingest atomicity before any abstraction implementation.
2. Build conformance harnesses before extracting records/search.
3. Prove operation/environment shape on low-risk surfaces.
4. Extract records/search only behind tests.
5. Treat Postgres as a spike until it passes the harness.

This path is the highest-confidence way to preserve PDPP's purpose: a protocol and reference implementation whose behavior is inspectable, falsifiable, and honest across environments.

## Decision Log

- 2026-04-28: Owner challenged the idea that records/search could be deferred without undermining Postgres feasibility.
- 2026-04-28: Four focused audits found no hard impossibility, but identified required contract corrections around atomic record ingest, cursor semantics, spine event sequence, lexical backend identity, and semantic recall identity.
- 2026-04-28: Plan recorded as "viable only with contract corrections"; Postgres remains a future spike, not a current product commitment.
