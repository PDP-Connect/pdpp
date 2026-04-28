## 1. Evidence Gathering

- [x] 1.1 Audit SQLite-specific obligations across records, grants/auth, tokens, pending consent, connector state, blobs, disclosure spine, lexical search, semantic search, and `_ref` control-plane reads.
- [x] 1.2 Audit existing tests and identify which obligations already have regression coverage and which need new semantic tests before extraction.
- [x] 1.3 Produce a Postgres feasibility memo covering JSON field filters, `changes_since`, cursor ordering, expand, aggregates, transactions, FTS, vector search, and index-state identity.
- [x] 1.4 Audit current sandbox API and dashboard paths for independently implemented AS/RS behavior that must be replaced by operation mounts.

## 2. Architecture Refinement

- [x] 2.1 Revise `design.md` using the worker audit reports, especially where current SQLite behavior contradicts proposed contracts.
- [ ] 2.2 Draft a candidate operation capsule shape for `rs.streams.list` with request, response, auth, error, trace, and dependency obligations.
- [ ] 2.3 Draft candidate capability-specific contracts for `ConsentStore`, `OwnerDeviceAuthStore`, `ConnectorStateStore`, `SchedulerStore`, and the minimal stream-summary `RecordStore` surface.
- [ ] 2.4 Decide whether generated OpenAPI clients should be a prerequisite, parallel task, or follow-up to operation extraction.
- [ ] 2.5 Decide whether `record_json_bytes` should be removed from operator summaries or relabeled as adapter-native storage bytes.

## 3. Proof Slice Planning

- [ ] 3.1 Define storage-only security proof: `ConsentStore` + `OwnerDeviceAuthStore` with SQLite and memory adapters.
- [ ] 3.2 Define Postgres-oriented storage proof: `ConnectorStateStore` + `SchedulerStore` with SQLite and a non-default Postgres adapter spike.
- [ ] 3.3 Define sandbox operation proof: `rs.streams.list` mounted through Fastify and Next sandbox, with `buildLiveStreamsList` deleted.
- [ ] 3.4 Define import-boundary checks or grep-based gates that prevent operations from importing concrete SQLite/Fastify/Next/process dependencies.
- [ ] 3.5 Define conformance/equivalence tests that must pass against the existing local server and the candidate sandbox/test host.
- [ ] 3.6 Identify rollback criteria and stop conditions for each proof slice.

## 4. Records/Search Feasibility Gate

- [ ] 4.1 Audit `records.list`, `records.get`, `changes_since`, range filters, field projection, ordering, cursors, and `expand[]` for SQLite-specific obligations and credible Postgres mappings.
- [ ] 4.2 Audit record ingestion, record version allocation, `record_changes`, disclosure-spine writes, timeline listing, and spine correlation aggregates for atomicity and cursor semantics.
- [ ] 4.3 Audit lexical retrieval for filter semantics, tokenizer/backend identity, score direction, snippet semantics, ordering stability, and credible Postgres full-text/trigram mapping.
- [ ] 4.4 Audit semantic and hybrid retrieval for index state, model/profile identity, distance semantics, filtered retrieval, backfill/resume semantics, and credible `pgvector` mapping.
- [ ] 4.5 Update this design with a go/no-go recommendation: viable as specified, viable only with contract changes, or not viable without weakening PDPP.

## 4. Validation

- [x] 5.1 Run `openspec validate define-reference-operation-environments --strict`.
- [x] 5.2 Run `openspec validate --all --strict`.
- [x] 5.3 Run `pnpm workstreams:status -- --no-fail` and reconcile any active worker reports before declaring this design ready for implementation.
