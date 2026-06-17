# pg_search / BM25 SLVP prior art — 2026-06-17

Status: working note  
Owner: Codex RI-owner session  
Scope: restoring lexical retrieval quality beyond bounded candidate windows

## Question

What is the SLVP-ideal direction for PDPP's Postgres lexical search after the
bounded candidate-window disclosure work made the current implementation honest
but not quality-ideal?

## Sources

- ParadeDB documentation, introduction: https://docs.paradedb.com/welcome/introduction
- ParadeDB documentation, top-k sorting: https://docs.paradedb.com/documentation/sorting/topk
- ParadeDB documentation, index creation: https://docs.paradedb.com/documentation/indexing/create-index
- ParadeDB documentation, self-hosted extension install: https://docs.paradedb.com/deploy/self-hosted/extension
- ParadeDB documentation, pre-installed extensions in the ParadeDB image: https://docs.paradedb.com/deploy/third-party-extensions
- ParadeDB GitHub repository / license: https://github.com/paradedb/paradedb
- Neon documentation, `pg_search` extension: https://neon.com/docs/extensions/pg_search
- PostgreSQL documentation, preferred full-text-search index types: https://www.postgresql.org/docs/current/textsearch-indexes.html
- PostgreSQL documentation, `btree_gin`: https://www.postgresql.org/docs/current/btree-gin.html

## Findings

The current shipped bounded-candidate lexical path is honest after
`meta.count_accuracy` and `meta.recall` disclosure, but it is not the retrieval
quality ideal. A bounded candidate window can miss a better match outside the
window and must therefore keep reporting `ranking_scope: "candidate_window"` for
broad queries.

Postgres built-in FTS with `GIN(tsvector)` is the right baseline substrate for
the reference and is already documented/implemented. The recent scoped GIN work
matches Postgres's own guidance for text-search indexes and `btree_gin`
composite equality+FTS predicates, but built-in `ts_rank_cd` still ranks after a
candidate set has been found. It does not by itself provide a Lucene-style global
top-k BM25 retrieval primitive.

ParadeDB's `pg_search` is the relevant prior-art direction for Postgres-native
BM25. Its documented model is an extension-backed BM25 index with top-k query
support inside Postgres, which matches the desired property: obtain the best
ranked hits without PDPP first selecting an arbitrary candidate window.

The deployment posture is non-trivial. ParadeDB documents `CREATE EXTENSION
pg_search` for self-hosted Postgres and also ships a Docker image with
`pg_search` pre-installed. Neon documents `pg_search` availability for some
hosted Postgres regions. Upstream ParadeDB Community is AGPL-3.0, so the
reference implementation must not silently vendor or require it without an
explicit owner/operator licensing and image decision.

## RI-owner position

The shipped recall vocabulary is the correct interim contract. It should stay
even after BM25 lands because it gives clients a durable way to distinguish
exact, lower-bound, estimated, and uncounted retrieval envelopes.

The BM25/`pg_search` work should be a separate OpenSpec change, not an edit to
the already-completed `accelerate-rs-search-postgres` change. The completed
change optimized and disclosed the bounded implementation; the next change
changes the retrieval substrate/quality profile and has deployment implications.

## Design constraints

- `pg_search` must be optional at first. The reference supports SQLite and
  Postgres deployments that may not have the extension installed.
- The fallback path must remain the current scoped Postgres FTS implementation
  with honest `candidate_window` recall disclosure.
- Docker/package defaults must stay legally and operationally honest. If the
  reference offers a ParadeDB image profile, it should be explicit and separate
  from the baseline Postgres profile unless legal review decides otherwise.
- Metadata must advertise the actual backend capability. If `pg_search` is not
  active, the server must not claim global BM25/top-k behavior.
- SQLite parity means API contract parity, not identical internals. SQLite FTS5
  can keep using its native `bm25()` path; Postgres can use `pg_search` when
  available; both must expose score kind/order/value semantics honestly.
- The implementation needs measured live proof on broad terms that currently
  produce lower-bound candidate-window responses, plus regression proof that
  grant scoping and source identity remain intact.

## Recommended next artifact

OpenSpec change: `restore-postgres-bm25-topk-search`.

The change should decide:

- extension install/deploy posture for the reference Docker image;
- bootstrap behavior when `pg_search` is unavailable;
- query planner and index shape for `(connector_instance_id, stream, record_key)`
  scoped BM25 retrieval;
- capability metadata and recall envelope semantics for `pg_search` vs fallback;
- migration/backfill cost and rollback safety.
