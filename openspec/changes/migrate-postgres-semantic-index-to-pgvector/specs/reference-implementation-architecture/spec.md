## ADDED Requirements

### Requirement: The Postgres backend SHALL store semantic embeddings as pgvector vectors and score them in the database

The reference SHALL, on a Postgres-backed deployment where the `vector`
(pgvector) extension is available, persist semantic-index embeddings in
`semantic_search_blob.embedding` as pgvector `vector` values rather than JSONB
float arrays, and SHALL answer semantic index queries with the database's
cosine-distance operator (`embedding <=> query ORDER BY … LIMIT k`) supported
by an HNSW index over the production embedding dimensionality, rather than
fetching candidate embeddings and computing distances in process.

The change SHALL be storage plumbing only: the retrieval contract semantics
SHALL NOT change. Hits SHALL keep the same shape and the same score semantics
(`distance` is the cosine distance, `1 − cosine similarity`), the same
grant-safe scoping (`connector_instance_id`, `scope_key`, optional
`record_key` candidate narrowing), and the same deterministic total order
(distance, then connector, instance, scope key, record key). The public
`GET /v1/search/semantic` surface and the SQLite-path behavior SHALL NOT
change.

Existing deployments with the legacy JSONB column SHALL be migrated by an
idempotent boot migration that backfills the vector column in bounded batches,
swaps the columns atomically, and builds the HNSW index, logging progress
through the startup logger. The migration SHALL be safe to interrupt and
resume: an interrupted backfill SHALL continue from the rows not yet converted
on the next boot, and a completed-but-unindexed state SHALL only re-attempt
index creation.

When the `vector` extension is not available, the reference SHALL keep the
JSONB representation and in-process scoring as the fallback; pgvector SHALL
remain optional for the Postgres backend, and the fallback SHALL NOT silently
change result semantics.

#### Scenario: A legacy JSONB deployment boots on a pgvector-capable database

- **WHEN** the reference boots against a Postgres database whose
  `semantic_search_blob.embedding` column is JSONB and the `vector` extension
  is available
- **THEN** the boot migration SHALL convert the column to the pgvector
  `vector` type in bounded batches, preserving every convertible row's
  embedding values
- **AND** SHALL build the HNSW cosine index before completing bootstrap
- **AND** SHALL log migration progress through the startup logger

#### Scenario: The boot migration is interrupted

- **WHEN** the process is stopped partway through the embedding backfill
- **THEN** the next boot SHALL resume converting only the rows not yet
  backfilled
- **AND** SHALL NOT duplicate, drop, or corrupt already-converted rows

#### Scenario: Query results keep brute-force semantics

- **WHEN** a semantic index query runs on the pgvector path
- **THEN** the returned hits SHALL be ordered by cosine distance with the same
  deterministic tie-break order as the in-process scoring path
- **AND** each hit's `distance` SHALL be numerically equivalent to the
  in-process cosine distance for the same vectors
- **AND** scoping by `connector_instance_id`, `scope_key`, and candidate
  `record_key` sets SHALL filter identically to the in-process path

#### Scenario: The vector extension is unavailable

- **WHEN** the reference boots against a Postgres database where the `vector`
  extension cannot be installed
- **THEN** the semantic index SHALL keep the JSONB representation and
  in-process cosine scoring
- **AND** semantic retrieval SHALL keep working with unchanged semantics
