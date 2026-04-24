## Context

The query/API readiness audit found that the reference server can already execute exact record filters and declared range filters on record-listing endpoints, but retrieval endpoints reject all filter parameters. That leaves assistants with two unsafe options: perform broad searches and filter client-side, or bypass retrieval and enumerate records directly.

The current lexical and semantic specs intentionally disallow arbitrary field filters, ranking knobs, expansion, and connector-specific DSLs. This change keeps that guardrail and adds only a small, stream-scoped bridge from the existing record-filter contract into retrieval.

## Goals / Non-Goals

Goals:

- Let clients combine text retrieval with one stream's existing exact/range filter semantics.
- Preserve grant safety: unauthorized fields must not affect matching, ranking, snippets, or semantic retrieval.
- Keep filter behavior discoverable through existing stream metadata, especially `query.range_filters`.
- Make the reference implementation test the behavior through public endpoints.

Non-goals:

- No cross-stream filtered search in this tranche.
- No generic predicate DSL, boolean algebra, sort, aggregation, geospatial predicates, or connector-specific search syntax.
- No public ranking controls, semantic score fields, reranking knobs, or caller-selected hybrid weights.
- No `expand[]` on retrieval endpoints.
- No attachment byte hydration or blob fetch changes.

## Decisions

### 1. Require exactly one `streams[]` value when filters are present

Field names and range-filter declarations are stream-local. Requiring a single stream avoids ambiguous behavior when a field exists on one stream but not another, or when the same field name has different order semantics across streams.

Owner-token callers still search every owner-visible connector that exposes that stream. The filter is validated and applied independently for each connector's stream metadata. Connectors whose stream metadata cannot validate the filter do not silently contribute results; the reference should reject the request if the named stream/filter pair is invalid for the target scope.

Cross-stream filtered search remains a design note because it needs explicit semantics for partial stream support, field aliases such as `received_at` versus `sent_at`, and result merging across heterogeneous ranges.

### 2. Reuse record-list filter rules rather than inventing retrieval filters

The accepted syntax is the existing record-list shape:

- `filter[field]=value` for exact matches on authorized top-level scalar fields.
- `filter[field][gte|gt|lte|lt]=value` for range matches only where `stream.query.range_filters[field]` declares the operator.

Unsupported fields, unauthorized fields, undeclared range fields, unsupported operators, or malformed values should fail the request with the same class of errors used by record listing. Retrieval endpoints must not accept broader predicates than record listing.

### 3. Filters are candidate constraints, not post-hoc client hints

The server must constrain the candidate set before retrieval results are returned. It may implement this by pre-filtering candidate record IDs, pushing filters into SQL alongside search constraints, intersecting a grant-safe filtered record set with index results, or another equivalent strategy. It must not match or embed unauthorized/undeclared fields and then filter late as its safety mechanism.

Semantic retrieval already has stored vectors for declared semantic fields. This change does not require re-embedding because filters constrain records, not vector text. Implementations should avoid exposing internal scores while applying filters.

### 4. Hybrid and score/reranking remain separate changes

The semantic retrieval spec already allows the server to report `retrieval_mode: "hybrid"` when server-owned lexical blending is active, but it does not expose scores or weights. User-facing requests for hybrid lexical+semantic ranking, semantic score display, and reranking are real but should not be hidden inside filter work. They need a separate design because they affect result shape, ranking honesty, evaluation, and possibly capability metadata.

## Acceptance Checks

- Lexical search accepts `filter[received_at][gte]=...` when the request names a single stream whose metadata declares that range filter, and all returned results hydrate to records satisfying the filter.
- Semantic search accepts the same filter shape on a declared semantic stream and returns only matching records.
- Both search endpoints reject filters unless exactly one `streams[]` value is present.
- Both search endpoints reject unauthorized filter fields, undeclared range fields, unsupported operators, and malformed range values without returning partial results.
- Search result snippets and matched fields remain grant-safe and are computed only from declared retrieval fields.
- No response exposes portable numeric relevance scores, ranking debug fields, caller-selected model data, or caller-supplied ranking controls.

## Open Questions Deferred

- Cross-stream filtered search semantics for heterogeneous field names and partial stream support.
- Whether to define semantic score/reranking output, and if so whether it is stable enough for public clients.
- Whether a future hybrid endpoint should merge lexical and semantic retrieval behind one surface or keep explicit endpoint separation.
