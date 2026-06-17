## 1. Postgres Search Indexing

- [x] Create `btree_gin` during Postgres bootstrap when available.
- [x] Ensure a scoped lexical GIN index for `(connector_instance_id, stream, document)`.
- [x] Keep the existing global document index for compatibility.

## 2. Runtime Query Safety

- [x] Run Postgres lexical queries with transaction-local `max_parallel_workers_per_gather = 0`.
- [x] Add a shared bounded fan-out helper for Postgres search work.
- [x] Apply bounded fan-out to lexical owner search snapshot building.
- [x] Apply bounded fan-out to semantic owner search snapshot building.

## 3. Tests

- [x] Add unit coverage for fan-out concurrency and ordering.
- [x] Add/extend Postgres lexical tests to cover scoped index bootstrap and lexical query success.
- [x] Run targeted search tests.
- [x] Run reference TypeScript.
- [x] Validate OpenSpec strict/all.

## 4. Live Verification

- [ ] Build/deploy in a live-stack window.
- [ ] Verify `/v1/search?q=the&limit=5` no longer fails with shared-memory errors.
- [ ] Verify API benchmark deltas for lexical, semantic, and hybrid search.
- [ ] Record residual performance gaps for the next loop.
