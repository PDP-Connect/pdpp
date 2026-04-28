## 1. Evidence Gathering

- [ ] 1.1 Audit SQLite-specific obligations across records, grants/auth, tokens, pending consent, connector state, blobs, disclosure spine, lexical search, semantic search, and `_ref` control-plane reads.
- [ ] 1.2 Audit existing tests and identify which obligations already have regression coverage and which need new semantic tests before extraction.
- [ ] 1.3 Produce a Postgres feasibility memo covering JSON field filters, `changes_since`, cursor ordering, expand, aggregates, transactions, FTS, vector search, and index-state identity.
- [ ] 1.4 Audit current sandbox API and dashboard paths for independently implemented AS/RS behavior that must be replaced by operation mounts.

## 2. Architecture Refinement

- [ ] 2.1 Revise `design.md` using the worker audit reports, especially where current SQLite behavior contradicts proposed contracts.
- [ ] 2.2 Draft a candidate operation capsule shape for one low-risk family (`rs.schema.get` or `rs.streams.list`) with request, response, auth, error, trace, and dependency obligations.
- [ ] 2.3 Draft candidate capability-specific contracts needed by that operation family, avoiding generic repository/query-builder abstractions.
- [ ] 2.4 Decide whether generated OpenAPI clients should be a prerequisite, parallel task, or follow-up to operation extraction.

## 3. Proof Slice Planning

- [ ] 3.1 Define the first proof slice: operation family, files to extract, adapters involved, tests required, and explicit out-of-scope areas.
- [ ] 3.2 Define import-boundary checks or grep-based gates that prevent operations from importing concrete SQLite/Fastify/Next/process dependencies.
- [ ] 3.3 Define conformance/equivalence tests that must pass against the existing local server and the candidate sandbox/test host.
- [ ] 3.4 Identify rollback criteria and stop conditions for the proof slice.

## 4. Validation

- [ ] 4.1 Run `openspec validate define-reference-operation-environments --strict`.
- [ ] 4.2 Run `openspec validate --all --strict`.
- [ ] 4.3 Run `pnpm workstreams:status -- --no-fail` and reconcile any active worker reports before declaring this design ready for implementation.
