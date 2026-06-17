## Context

The reference implementation currently supports SQLite lexical retrieval through
FTS5 `bm25()` and Postgres lexical retrieval through a derived
`lexical_search_index` table with generated `tsvector` and `ts_rank_cd`.
Recent Postgres acceleration work made broad search reliable by adding scoped
GIN indexing, bounded fan-out, and bounded lexical candidate windows. Recent
recall-disclosure work made that compromise honest by returning
`meta.count_accuracy` and `meta.recall`.

That is still not the SLVP-ideal retrieval quality. A bounded candidate window
can miss a better lexical match outside the window. ParadeDB's `pg_search`
extension is the relevant Postgres-native prior art for BM25 top-k search:
it puts a Tantivy/BM25 search index inside Postgres rather than requiring a
separate Elasticsearch/OpenSearch service.

The implementation cannot simply swap the SQL. `pg_search` is not part of
standard Postgres, has deployment/image implications, and upstream ParadeDB
Community is AGPL-3.0. The reference therefore needs an optional backend path
with explicit operator posture and a strong fallback to current native Postgres
FTS.

Research inputs:

- `docs/research/pg-search-bm25-slvp-prior-art-2026-06-17.md`
- `tmp/workstreams/pg-search-bm25-feasibility-worker-report.md`
- `openspec/changes/accelerate-rs-search-postgres/design.md`
- `openspec/changes/archive/2026-06-17-disclose-lexical-recall-windows/design.md`

## Goals / Non-Goals

**Goals:**

- Provide an optional Postgres BM25 top-k lexical backend using `pg_search`
  when explicitly enabled and available.
- Preserve the current native Postgres FTS implementation as the default and
  as the runtime fallback.
- Keep SQLite behavior and tests unchanged.
- Preserve the public lexical retrieval response shape, grant enforcement,
  cursor snapshot semantics, source identity, and MCP recall mirroring.
- Report exact recall only when the active backend proves scoped top-k retrieval
  without a pre-ranking candidate cap.
- Surface extension/backend state in diagnostics and capability metadata so
  operators can understand whether the instance is using BM25 or native FTS.

**Non-Goals:**

- Do not make `pg_search` mandatory for Postgres runtime storage.
- Do not silently replace the published reference database image with a
  ParadeDB image.
- Do not add Elasticsearch/OpenSearch or any external search service.
- Do not remove existing candidate-window recall metadata; it remains the
  correct fallback envelope.
- Do not promise byte-identical rank/snippet behavior between SQLite FTS5,
  native Postgres FTS, and `pg_search`.

## Decisions

### 1. Make `pg_search` opt-in and probed

The reference SHALL not create or use `pg_search` unless an explicit
configuration flag enables the backend. Startup/bootstrap shall detect:

- disabled by configuration;
- extension unavailable;
- extension available but not enabled;
- extension enabled and index ready;
- fallback active after a runtime error.

Rationale: the extension changes operator deployment and licensing posture. A
forkable reference cannot surprise operators with an AGPL extension dependency
or a different Postgres distribution.

### 2. Keep the current lexical index table as the ingestion source of truth

The existing `lexical_search_index` table should remain the derived lexical
side table used by backfill, deletes, meta fingerprints, and fallback native
Postgres FTS. The optional BM25 index should be built from that table rather
than changing record-ingest semantics.

`pg_search` examples use a single `key_field`, while PDPP's current lexical
identity is composite: `(connector_instance_id, stream, record_key, field)`.
The implementation should add a stable surrogate lexical row id if the
extension requires one, without changing the public record identity.

### 3. Split Postgres lexical search internally, not at the route layer

`postgresLexicalSearch(...)` remains the exported seam. Internally it may choose
between:

- native Postgres FTS (`tsvector` / `plainto_tsquery` / `ts_rank_cd`);
- optional `pg_search` BM25;
- native fallback after an unavailable or failed BM25 path.

The route and operation layers keep the same output contract:
`connector_id`, `stream`, `record_key`, `field`, `record_json`, `emitted_at`,
`score`, `snippet_text`, and recall metadata.

### 4. Exact recall is backend-proven, not assumed

The response may report `meta.count_accuracy: "exact"` and
`meta.recall.ranking_scope: "all_matches"` only when tests prove the active
backend ranked the full authorized match set before pagination. If the BM25 path
still applies any candidate window, approximate prefilter, or unproven
restriction, it must continue reporting `candidate_window` or `unknown`.

This preserves the honesty work already shipped and prevents a faster query
from being mislabeled as complete.

### 5. Deployment posture stays explicit

The first implementation tranche should not publish a new default database
image. It should add probe/fallback/diagnostic support and, if practical, an
optional proof profile for Postgres with `pg_search`. A later tranche may add a
documented ParadeDB/Postgres image profile after owner/legal review.

## Risks / Trade-offs

- `pg_search` licensing/image posture is not acceptable for the default
  reference image. → Keep it opt-in and keep native Postgres FTS as the default.
- `pg_search` query syntax or index DDL changes across versions. → Version-gate
  the probe, make tests exercise a real extension profile, and fail closed to
  native FTS.
- The BM25 path could bypass grant/source filters. → Keep grant plan
  construction above the backend seam; tests must prove connector, stream,
  field, record-key, and deleted-record constraints on both paths.
- Snippet/tokenization differences may surprise callers. → Keep score values
  implementation-relative and document backend identity in diagnostics; do not
  promise identical snippets across backends.
- BM25 index build may be expensive on live multi-million-row stores. → Use an
  explicit migration/backfill phase, live-stack window, and rollback to native
  FTS if the index is unavailable or stale.

## Migration Plan

1. Add backend-probe and diagnostic plumbing without using `pg_search` for
   queries.
2. Add optional `pg_search` DDL behind an explicit env/config flag, with
   idempotent bootstrap and native fallback.
3. Add a BM25 query implementation behind the existing `postgresLexicalSearch`
   seam and keep the response shape unchanged.
4. Add an optional real-Postgres+`pg_search` test profile. Default CI remains
   green without the extension.
5. Run a live proof only after local tests pass and a live-stack window is
   declared.
6. Decide separately whether the published reference image should offer a
   ParadeDB profile. That decision is not required for the initial optional
   backend path.

## Open Questions

- Which exact `pg_search` version should the optional proof profile target?
- Does the chosen version require a single `key_field`, and if so should PDPP
  use a generated lexical-row surrogate id or a stable encoded composite key?
- Should BM25 readiness be advertised in protected-resource metadata, reference
  deployment diagnostics, or both?
- Is the upstream AGPL-3.0 posture acceptable for a documented optional image
  profile, or must the reference only support externally supplied Postgres
  instances that already provide `pg_search`?
