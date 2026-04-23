## 1. Decide and document the extension status

- [ ] 1.1 Confirm the surface-status classification: `lexical-retrieval` ships at the **optional extension** rung per `design-notes/lexical-retrieval-status-options-2026-04-23.md` and `design-notes/surface-status-ladder-2026-04-23.md`.
- [ ] 1.2 Confirm core PDPP is unchanged by this tranche; no requirement is added to `reference-implementation-architecture` or `reference-implementation-governance`.
- [ ] 1.3 Confirm in writing (in `proposal.md` "Deferred / Follow-ups") that promotion to core, semantic retrieval, body-DSL `POST /v1/search`, and portable numeric relevance score are NOT in this change.

## 2. Lock the public contract shape

- [ ] 2.1 Endpoint: `GET /v1/search`, dedicated and cross-stream-capable.
- [ ] 2.2 Query parameters allowed in v1: `q` (required), `limit`, `cursor`, `streams[]` (repeated, optional).
- [ ] 2.3 Reject every parameter not on that allowlist (`filter[...]`, `fields`, `expand[]`, `expand_limit[...]`, `order=`, `rank=`, `boost=`, semantic/vector params, connector-specific params) with `invalid_request_error`.
- [ ] 2.4 Reuse existing `Authorization`, `PDPP-Version`, and `Request-Id` conventions from `spec-data-query-api.md`. No new auth scheme.

## 3. Lock the result shape

- [ ] 3.1 List envelope reuses `object: "list"`, `has_more`, `next_cursor`, `data[]`.
- [ ] 3.2 Each result is `object: "search_result"` with `stream`, `record_key`, `record_url` (when easily computable), `emitted_at`, `matched_fields`, optional `snippet`.
- [ ] 3.3 No portable numeric relevance score in v1. Verify the spec delta states this explicitly.
- [ ] 3.4 Confirm `matched_fields` is constrained to be a subset of (declared `lexical_fields`) ∩ (grant-readable fields).

## 4. Lock the grant-safety invariants

- [ ] 4.1 Streams outside the grant contribute zero hits.
- [ ] 4.2 Fields outside the grant projection are never searched, even if the stream declared them as `lexical_fields`.
- [ ] 4.3 Snippets MUST contain only substrings drawn from authorized + declared-searchable fields.
- [ ] 4.4 No "search unauthorized fields and post-filter" implementation pattern is acceptable; reject it explicitly in the spec delta and the design.
- [ ] 4.5 Unauthorized `streams[]` values produce a hard `permission_error` with code `grant_stream_not_allowed`, not silent omission.

## 5. Lock the searchable-field declaration shape

- [ ] 5.1 Declaration lives at `query.search.lexical_fields` inside per-stream metadata, not in a global registry.
- [ ] 5.2 v1 accepts only top-level scalar string fields present in the stream's schema.
- [ ] 5.3 Nested paths, arrays, blob references, and connector-specific search semantics are NOT expressible through `lexical_fields` in v1.
- [ ] 5.4 Streams that omit `query.search` are treated as not participating in lexical retrieval.

## 6. Lock the server-level capability surface

- [ ] 6.1 Define the advertisement shape: `capabilities.lexical_retrieval = { supported, endpoint, cross_stream, snippets, default_limit, max_limit }`.
- [ ] 6.2 Confirm the advertisement does NOT enumerate per-stream fields.
- [ ] 6.3 Confirm the advertisement does NOT grow into a generalized capability-statement document. (Cross-link `design-notes/capability-discovery-options-2026-04-22.md`.)
- [ ] 6.4 Choose the carrier (RS metadata vs AS metadata vs new `/v1/capabilities`) during implementation tranche; document the choice as a follow-up, not as a contract gap. Out of scope for this design tranche.

## 7. Lock pagination semantics

- [ ] 7.1 Search cursors are opaque, distinct from record-list cursors, and distinct from `changes_since`.
- [ ] 7.2 No promise of monotonic timestamps, durability across restart, or stability across grant changes / index rebuilds.
- [ ] 7.3 Stale cursors MAY return `invalid_cursor`; the client recovers by issuing a fresh search.

## 8. Define ranking promises (and non-promises)

- [ ] 8.1 Promise: lexical match over authorized + declared-searchable fields.
- [ ] 8.2 Promise: relevance-oriented ordering, higher generally more relevant.
- [ ] 8.3 Non-promise: BM25 / numeric scores / semantic reranking / recency blending / per-connector weighting as portable contract.

## 9. Document non-goals explicitly

- [ ] 9.1 Semantic / vector retrieval — out of scope.
- [ ] 9.2 Embeddings, embedding versioning — out of scope.
- [ ] 9.3 Cross-connector entity resolution — out of scope.
- [ ] 9.4 Generic boolean/predicate DSL — out of scope.
- [ ] 9.5 Connector-specific search APIs — out of scope.
- [ ] 9.6 Mandatory-core promotion — out of scope.
- [ ] 9.7 New dashboard-only ad hoc retrieval surface — out of scope; dashboard adopts the extension once it ships.
- [ ] 9.8 `POST /v1/search` body-DSL — reserved as a possible future change, NOT in this tranche.

## 10. Reference implementation plan (non-normative; informs a later implementation tranche)

- [ ] 10.1 Backing store: SQLite FTS5 in the reference. Do NOT make SQLite normative in the spec delta.
- [ ] 10.2 Index only fields declared in `query.search.lexical_fields`; do not index undeclared fields just because the stream stores them.
- [ ] 10.3 Maintain the index via SQLite triggers with a startup rebuild safeguard, mirroring the existing `_ref/search` FTS5 experiment's maintenance model.
- [ ] 10.4 Treat the index as a derived artifact: rebuildable from records; deletion/retention flows through records first.
- [ ] 10.5 Do NOT introduce sqlite-vec, pgvector, an external search service, or embeddings in this tranche.

## 11. Truthfulness cleanup of existing search drift

- [ ] 11.1 In `apps/web/content/docs/spec-data-query-api.md`, rewrite the existing "richer cross-stream search could be added later via `POST /v1/search`" wording to point public lexical retrieval at this extension at `GET /v1/search`. Reserve `POST /v1/search` only as a possible future DSL-bearing surface, marked as not-yet-spec'd.
- [ ] 11.2 Audit any docs that describe `/_ref/search` as a public retrieval surface; restate it as a reference-only artifact/id-jump helper.
- [ ] 11.3 Audit any docs / UI copy that describe the dashboard's brute-force fan-out as a public search capability; restate it as a temporary reference-only fallback that will be replaced by `/v1/search` consumption once the extension ships.
- [ ] 11.4 Add or extend an `apps/web` doc page that describes `GET /v1/search`, `query.search.lexical_fields`, and the server-level `capabilities.lexical_retrieval` advertisement.

## 12. Implementation tranche prerequisites (not in this change)

These belong to a later, explicitly separate change. Listed here so the implementation tranche does not reinvent them.

- [ ] 12.1 Build `GET /v1/search` in the reference, backed by SQLite FTS5, honoring the contract above.
- [ ] 12.2 Wire the server-level advertisement into the chosen capability carrier.
- [ ] 12.3 Replace the dashboard's brute-force text fan-out with calls to `/v1/search` (or an internal helper that goes through the same enforcement path).
- [ ] 12.4 Keep `/_ref/search` separate from `/v1/search`. They MAY share index infrastructure; they MUST NOT share contract.
- [ ] 12.5 Add tests that prove the grant-safety invariants (stream gating, field gating, snippet gating, hard-error on unauthorized `streams[]`).
- [ ] 12.6 Add tests that prove parameter rejection for every disallowed v1 parameter.

## 13. Validation

- [ ] 13.1 `openspec validate add-lexical-retrieval-extension --strict` passes.
- [ ] 13.2 `proposal.md`, `design.md`, `tasks.md`, and the spec delta agree on:
  - extension status (optional extension, not core)
  - public surface (`GET /v1/search`)
  - lexical-only scope
  - layered server + stream discovery model
  - grant-safe snippets
- [ ] 13.3 No file references SQLite as normative protocol behavior; SQLite appears only in the reference-implementation plan in `design.md` and in the implementation-tranche section of this `tasks.md`.
- [ ] 13.4 Re-read every file created or edited to confirm consistency before reporting done.

## 14. Stop conditions for any future worker on this change

If a future worker concludes any of the following while applying this change, they MUST stop and re-open the design rather than widening the contract:

- [ ] 14.1 Semantic / vector retrieval becomes necessary.
- [ ] 14.2 A broader new discovery document seems required.
- [ ] 14.3 Connector-specific search semantics seem required.
- [ ] 14.4 Searching unauthorized fields and "filter later" seems necessary.
- [ ] 14.5 Safe snippets appear impossible under the current model.
- [ ] 14.6 The conclusion is that lexical retrieval must be core in this same tranche.
