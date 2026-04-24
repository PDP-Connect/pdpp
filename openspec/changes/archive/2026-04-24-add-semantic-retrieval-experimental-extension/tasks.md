## 1. Decide and document the extension status

- [x] 1.1 Confirm the surface-status classification: `semantic-retrieval` ships at the **optional extension** rung, with an explicit **experimental / unstable** modifier, per `design-notes/semantic-retrieval-status-options-2026-04-23.md` and `design-notes/semantic-retrieval-experimental-extension-2026-04-23.md`.
- [x] 1.2 Confirm core PDPP is unchanged by this tranche; no requirement is added to `reference-implementation-architecture` or `reference-implementation-governance`.
- [x] 1.3 Confirm the approved lexical retrieval contract (`add-lexical-retrieval-extension`) is unchanged by this tranche — no edits to its proposal, design, tasks, or spec delta.
- [x] 1.4 Confirm in writing (in `proposal.md` "Deferred / Follow-ups") that promotion to a stabilized extension, promotion to core, raw vector query input, client-supplied embedding input, multi-model advertisements, portable numeric relevance score, canonical embedding self-export, and cross-connector entity resolution are NOT in this change.

## 2. Lock the public contract shape

- [x] 2.1 Endpoint: `GET /v1/search/semantic`, dedicated and cross-stream-capable. Do NOT mutate `GET /v1/search`. Do NOT overload `/_ref/search`.
- [x] 2.2 Query parameters allowed in v1: `q` (required), `limit`, `cursor`, `streams[]` (repeated, optional).
- [x] 2.3 Reject every parameter not on that allowlist (explicitly: `vector=`, `embedding=`, `model=`, `model_id=`, `model_family=`, `rank=`, `boost=`, `weights=`, `blend=`, `connector_id=`, `filter[...]`, `fields`, `expand[...]`, `expand_limit[...]`, `order=`, connector-specific params, DSL-shaped params) with `invalid_request_error`.
- [x] 2.4 Reuse existing `Authorization`, `PDPP-Version`, and `Request-Id` conventions from `spec-data-query-api.md`. No new auth scheme. No capability-specific auth.

## 3. Lock the result shape

- [x] 3.1 List envelope reuses `object: "list"`, `has_more`, `next_cursor`, `data[]`.
- [x] 3.2 Each result is `object: "search_result"` (shared with lexical retrieval) with required `stream`, `record_key`, `connector_id`, `emitted_at`, `matched_fields`, and `retrieval_mode`. `record_url` and `snippet` are explicitly OPTIONAL.
- [x] 3.3 `retrieval_mode` values in v1 are exactly `"semantic"` and `"hybrid"`. Any other value is not permitted in v1.
- [x] 3.4 No portable numeric relevance score in v1. Verify the spec delta states this explicitly and rejects `score`, `cosine`, `bm25`, `blend` as result fields.
- [x] 3.5 No debug/trace fields (`_debug`, `_explain`, `_vector_distance`) on the public result shape. Reference-only surfaces MAY expose them elsewhere.
- [x] 3.6 Confirm `matched_fields` is constrained to be a subset of (declared `semantic_fields`) ∩ (grant-readable fields), and that implementations unable to honestly attribute MUST return `matched_fields: []`.

## 4. Lock the grant-safety invariants

- [x] 4.1 Streams outside the grant contribute zero hits.
- [x] 4.2 Fields outside the grant projection are never embedded for query matching, never ranked, never contributing to snippets — even if declared in `semantic_fields`.
- [x] 4.3 Fields not declared in `semantic_fields` are never embedded for query matching, even if grant-readable.
- [x] 4.4 Snippets MUST be verbatim substrings of authorized + declared `semantic_fields`. No model-generated summaries, no paraphrases.
- [x] 4.5 "Embed everything, filter later" is explicitly prohibited. The spec delta SHALL name and reject that implementation pattern.
- [x] 4.6 Unauthorized `streams[]` values for client tokens produce a hard `permission_error` with code `grant_stream_not_allowed`, not silent omission.
- [x] 4.7 For owner-token callers, `streams[]` is a soft cross-connector filter; naming a stream no owner-visible connector exposes simply yields zero hits.
- [x] 4.8 No public `connector_id` query parameter on `GET /v1/search/semantic` in v1. Reject `connector_id=...` as `invalid_request_error`.

## 5. Lock the semantic-searchable field declaration

- [x] 5.1 Declaration lives at `query.search.semantic_fields` inside per-stream metadata, not in a global registry and not coupled to `lexical_fields`.
- [x] 5.2 v1 accepts only top-level scalar **string** fields present in the stream's schema.
- [x] 5.3 Nested paths, arrays, blob references, and connector-specific semantics are NOT expressible through `semantic_fields` in v1.
- [x] 5.4 Streams that omit `query.search.semantic_fields` are treated as not participating in semantic retrieval (they MAY still participate in lexical retrieval via `lexical_fields`; the two are independent).

## 6. Lock the capability advertisement

- [x] 6.1 Advertisement shape (required keys when `supported: true`): `supported`, `stability`, `endpoint`, `cross_stream`, `query_input`, `snippets`, `lexical_blending`, `model`, `dimensions`, `distance_metric`, `default_limit`, `max_limit`, `index_state`.
- [x] 6.2 `stability` MUST be the literal string `"experimental"` in v1.
- [x] 6.3 `query_input` MUST be the literal string `"text"` in v1. Other values (`"vector"`, `"hybrid"`) are reserved for future tranches and MUST NOT appear in v1.
- [x] 6.4 `index_state` MUST be one of `"built"`, `"building"`, `"stale"`.
- [x] 6.5 Optional key `language_bias` MAY be published when the configured model has materially known locale/language bias; shape at minimum `{ primary, note }`.
- [x] 6.6 Lock the carrier: the advertisement is published inside the existing **resource-server metadata document**, sibling to `capabilities.lexical_retrieval`. No AS metadata. No new discovery document.
- [x] 6.7 Confirm the advertisement does NOT enumerate per-stream `semantic_fields`.
- [x] 6.8 Confirm the advertisement does NOT grow into a generalized capability-statement document.
- [x] 6.9 Confirm the advertisement is reachable without a grant.
- [x] 6.10 Confirm that `capabilities.lexical_retrieval` and `capabilities.semantic_retrieval` are independent: neither implies the other.

## 7. Lock pagination semantics

- [x] 7.1 Search cursors are opaque, distinct from record-list cursors, `changes_since` cursors, AND lexical-search cursors.
- [x] 7.2 No promise of monotonic timestamps, durability across restart, or stability across grant changes / index rebuilds / model changes.
- [x] 7.3 Stale cursors MAY return `invalid_cursor`; the client recovers by issuing a fresh search.

## 8. Define ranking promises (and non-promises)

- [x] 8.1 Promise: semantic (or hybrid) match over authorized + declared-`semantic_fields` content, using the server's declared model.
- [x] 8.2 Promise: relevance-oriented ordering, higher generally more relevant.
- [x] 8.3 Non-promise: BM25 / cosine / L2 / normalized scores as portable numeric contract, any specific embedding model, any specific tokenizer, any specific distance metric implementation, any specific lexical-blending formula, any specific reranker, any specific ANN strategy, recency blending, per-connector weighting, ranking stability across model upgrades or index rebuilds.

## 9. Document what is implementation-defined

- [x] 9.1 Embedding backend, vector/index backend, ANN strategy, tokenizer, reranker, lexical-blending formula, batch/rebuild mechanics, per-owner/per-deployment localized model selection are implementation-defined.
- [x] 9.2 Whether embeddings are content-addressed, per-record, frozen, or ephemeral is implementation-defined (none of options V1–V4 in `add-polyfill-connector-system/design-notes/semantic-retrieval-surface-open-question.md` is normatively required).
- [x] 9.3 Index storage topology is implementation-defined.

## 10. Document non-goals explicitly

- [x] 10.1 Not core PDPP.
- [x] 10.2 Not cross-server comparable.
- [x] 10.3 No portable numeric relevance score contract.
- [x] 10.4 No canonical embedding self-export contract (self-export treatment of derived artifacts is a separate decision; see `owner-self-export-open-question.md` and `authored-artifacts-vs-activity-open-question.md`).
- [x] 10.5 No cross-connector entity resolution.
- [x] 10.6 No generalized vector/ANN API.
- [x] 10.7 Not a replacement for lexical retrieval; lexical retrieval remains the stable public retrieval floor.
- [x] 10.8 No raw vector query input.
- [x] 10.9 No client-supplied embeddings.
- [x] 10.10 No connector-specific semantic semantics on the public surface.
- [x] 10.11 No mutation of `GET /v1/search`. No overloading of `/_ref/search`.
- [x] 10.12 No `POST /v1/search/semantic` body-DSL in v1.
- [x] 10.13 No nested paths, arrays, or blob indexing in `semantic_fields` v1.

## 11. Reference implementation plan (non-normative; informs a later implementation tranche)

- [x] 11.1 Choose a locally-hostable vector index for the reference (candidate: `sqlite-vec` co-located with the existing SQLite store). Do NOT make the choice normative.
- [x] 11.2 Choose a server-configured embedding backend (candidate: local default for offline runs; hosted provider behind explicit operator opt-in). Do NOT make the choice normative. MUST be reflected honestly in `capabilities.semantic_retrieval.model`.
- [x] 11.3 Index only fields declared in `query.search.semantic_fields`; never embed undeclared fields just because the stream stores them.
- [x] 11.4 Maintain the index in JS at record write/update/delete call sites (same pattern as lexical retrieval), with a startup rebuild safeguard for drift recovery.
- [x] 11.5 Compute `index_state` honestly. When `semantic_fields` or `model` changes, report `stale` until rebuild completes.
- [x] 11.6 Treat the index as a derived artifact: rebuildable from records; deletion/retention flows through records first.
- [x] 11.7 Keep any `/_ref/*` semantic experiments (debug score dumps, model output inspection) reference-only. They MAY share infrastructure with `/v1/search/semantic`; they MUST NOT share public contract.
- [x] 11.8 Do NOT add pgvector, external vector DB, or a mandatory managed service as normative requirements for this extension.

## 12. Truthfulness cleanup of existing surfaces

- [x] 12.1 If the lexical retrieval tranche's rewrite of `apps/web/content/docs/spec-data-query-api.md` has landed, add a short experimental pointer to `GET /v1/search/semantic` there, clearly marked as experimental/unstable. Do NOT describe `/v1/search` and `/v1/search/semantic` as interchangeable.
- [x] 12.2 Add or extend an `apps/web` doc page describing `GET /v1/search/semantic`, `query.search.semantic_fields`, and `capabilities.semantic_retrieval`, with the **experimental / unstable** marker surfaced prominently in that doc.
- [x] 12.3 Audit any docs or UI copy that already describe "semantic search" ambiently. Restate them as either (a) referring to the experimental extension with the appropriate stability marker, or (b) reference-only behavior distinct from the public extension.
- [x] 12.4 Confirm the lexical retrieval doc/spec is not modified by this tranche.
- [x] 12.5 Confirm `/_ref/search` is not widened by this tranche and is not aliased to `/v1/search/semantic`.

## 13. Implementation tranche prerequisites (not in this change)

These belong to a later, explicitly separate change. Listed here so the implementation tranche does not reinvent them.

- [x] 13.1 Build `GET /v1/search/semantic` in the reference honoring the contract above, using the chosen backend.
- [x] 13.2 Wire the `capabilities.semantic_retrieval` advertisement into the existing resource-server metadata document, next to (but independent from) `capabilities.lexical_retrieval`.
- [x] 13.3 Implement grant-safe snippet generation that returns verbatim substrings of authorized + declared fields.
- [x] 13.4 Implement `index_state` drift detection and honest reporting.
- [x] 13.5 Add tests that prove the grant-safety invariants (stream gating, field gating, snippet gating, declared-field gating, hard-error on unauthorized `streams[]`, rejection of `connector_id=`).
- [x] 13.6 Add tests that prove parameter rejection for every disallowed v1 parameter (`vector`, `embedding`, `model`, `rank`, `boost`, `weights`, `blend`, `filter[...]`, `fields`, `expand[...]`, `expand_limit[...]`, `order`, `connector_id`).
- [x] 13.7 Add tests that prove the advertisement is grant-free, carries `stability: "experimental"`, and reports `index_state` honestly after `semantic_fields` or `model` changes.
- [x] 13.8 Confirm that lexical retrieval tests still pass unmodified (no shared regressions from the new surface).

## 14. Validation

- [x] 14.1 `openspec validate add-semantic-retrieval-experimental-extension --strict` passes.
- [x] 14.2 `proposal.md`, `design.md`, `tasks.md`, and the spec delta all agree on:
  - extension status (experimental optional extension; not core; lexical retrieval remains the stable floor)
  - public surface (`GET /v1/search/semantic`)
  - text-query-only scope (no raw vector, no client-supplied embedding, no model selector)
  - declared field model (`query.search.semantic_fields`)
  - layered server + stream discovery with `stability: "experimental"` on the server-level advertisement
  - grant-safe snippets (verbatim substrings only)
  - no portable numeric relevance score
- [x] 14.3 No file in this change references a specific embedding model, vector backend, or ANN library as normative protocol behavior. Specific choices appear only in the reference-implementation plan in `design.md` §13 and in the implementation-tranche section of this `tasks.md`.
- [x] 14.4 No file in this change modifies `add-lexical-retrieval-extension`'s proposal, design, tasks, or spec delta.
- [x] 14.5 Re-read every file created or edited to confirm consistency before reporting done. Grep the change directory for accidental references to "lexical" where "semantic" is meant, for `GET /v1/search` where `GET /v1/search/semantic` is meant, and for stability language that might imply this extension is stable.

## 15. Stop conditions for any future worker on this change

If a future worker concludes any of the following while applying this change, they MUST stop and re-open the design rather than widening the contract:

- [x] 15.1 Raw vector query input (`vector=...`) seems necessary for the first public shape.
- [x] 15.2 Client-supplied embedding input (`embedding=...`) seems necessary.
- [x] 15.3 Semantic retrieval can only work by mutating `GET /v1/search`.
- [x] 15.4 A broader new capability-statement document appears required.
- [x] 15.5 Grant-safe snippets appear impossible under the current model.
- [x] 15.6 The metadata vocabulary cannot be made truthful enough for public exposure.
- [x] 15.7 The conclusion is that semantic retrieval must be core, or must be a stabilized (non-experimental) extension, in this same tranche.
- [x] 15.8 A portable numeric relevance score appears necessary for minimal client usefulness.
- [x] 15.9 Multiple concurrent embedding models need to be advertised on one resource server in one public contract.
- [x] 15.10 Connector-specific semantic parameters appear necessary on the public surface.
