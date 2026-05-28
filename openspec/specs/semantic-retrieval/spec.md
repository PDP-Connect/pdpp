# semantic-retrieval Specification

## Purpose
Define PDPP's experimental optional semantic retrieval extension: a discoverable, grant-safe, text-query meaning-match surface at `GET /v1/search/semantic` with explicit instability, server-declared model metadata, and no portable vector or reranking controls.
## Requirements
### Requirement: Semantic retrieval is an experimental, optional, advertised, named extension

PDPP SHALL define a named optional extension `semantic-retrieval` that implementations MAY expose. The extension SHALL be explicitly marked as **experimental** and **unstable** in its capability advertisement: clients that depend on it MUST accept that breaking revisions are acceptable while the extension carries experimental status. The extension SHALL NOT be assumed by clients to exist on any server unless the server explicitly advertises it via the resource-server metadata surface defined below. Core PDPP SHALL NOT require this extension. The extension SHALL NOT be exposed silently as ambient reference behavior, and SHALL NOT be delivered through the lexical retrieval surface `GET /v1/search` or through any reference-only surface such as `/_ref/search`.

#### Scenario: A client encounters a server that does not advertise the extension
- **WHEN** a client reads resource-server metadata and `capabilities.semantic_retrieval.supported` is absent or `false`
- **THEN** the client SHALL NOT assume `GET /v1/search/semantic` is available
- **AND** the server MAY return `404` or `not_found_error` if the endpoint is requested

#### Scenario: A client encounters a server that advertises the extension
- **WHEN** resource-server metadata reports `capabilities.semantic_retrieval.supported: true` with `stability: "experimental"`
- **THEN** the client MAY rely on `GET /v1/search/semantic` being available at the advertised `endpoint` path
- **AND** the client SHALL treat the contract as unstable and SHALL NOT assume it will remain compatible across revisions
- **AND** the client MAY rely on the `cross_stream`, `query_input`, `snippets`, `lexical_blending`, `model`, `dimensions`, `distance_metric`, `default_limit`, `max_limit`, and `index_state` fields when shaping requests

#### Scenario: The extension is not silently delivered through another search surface
- **WHEN** an implementation chooses to expose this extension
- **THEN** the public surface SHALL be the advertised `/v1/search/semantic` endpoint
- **AND** the implementation SHALL NOT advertise `/v1/search` (lexical retrieval), `/_ref/search`, or any other surface as the public semantic retrieval endpoint
- **AND** `/v1/search` SHALL continue to operate as the lexical retrieval surface defined by the `lexical-retrieval` extension, unmodified by this extension

#### Scenario: Lexical retrieval is unaffected by this extension
- **WHEN** a server advertises both `capabilities.lexical_retrieval` and `capabilities.semantic_retrieval`
- **THEN** the behavior, shape, and guarantees of `GET /v1/search` SHALL be identical to those defined by the `lexical-retrieval` extension
- **AND** the presence of semantic retrieval SHALL NOT imply any change to the lexical retrieval contract
- **AND** clients MAY choose to call either surface, both, or neither

### Requirement: The extension SHALL expose `GET /v1/search/semantic` with a text-query-only constrained surface

When advertised, the extension SHALL be reachable as `GET /v1/search/semantic`. The endpoint SHALL accept a required `q` parameter (a text query string) and the optional parameters `limit`, `cursor`, repeated `streams[]`, and stream-scoped `filter[...]` parameters. In this tranche, any request that includes `filter[...]` SHALL include exactly one `streams[]` value. It SHALL NOT accept raw vector input, client-supplied embeddings, model-selector parameters, ranking-knob parameters, connector-specific parameters, field-projection parameters, expansion parameters, sort parameters, generic predicate DSL parameters, or arbitrary field filters outside the stream-scoped filter rules below.

`filter[field]=value` SHALL use the same exact-filter semantics as record listing for the named stream: the field SHALL be an authorized top-level scalar schema field for the caller and stream. `filter[field][gte|gt|lte|lt]=value` SHALL use the same declared range-filter semantics as record listing: the field and operator SHALL be declared in the stream metadata's `query.range_filters`. Filters SHALL constrain the candidate records that may contribute semantic matches, lexical blending, ranking, matched fields, and snippets.

#### Scenario: A request omits `q`
- **WHEN** a client calls `GET /v1/search/semantic` without `q`
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the response SHALL NOT include any candidate results

#### Scenario: A request includes only allowed unfiltered parameters
- **WHEN** a client calls `GET /v1/search/semantic?q=bank%20fees&limit=10&streams[]=messages`
- **THEN** the server SHALL accept the request

#### Scenario: A request includes an allowed single-stream filter
- **WHEN** a client calls `GET /v1/search/semantic?q=invoice&streams[]=messages&filter[received_at][gte]=2026-04-01T00:00:00Z`
- **AND** stream `messages` declares `query.range_filters.received_at` with operator `gte`
- **AND** the caller is authorized to read `received_at`
- **THEN** the server SHALL accept the request
- **AND** every returned result SHALL identify a record whose visible `received_at` satisfies the filter

#### Scenario: A filtered request omits streams
- **WHEN** a client calls `GET /v1/search/semantic?q=invoice&filter[received_at][gte]=2026-04-01T00:00:00Z`
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the server SHALL NOT search every stream and apply the filter opportunistically

#### Scenario: A filtered request names multiple streams
- **WHEN** a client calls `GET /v1/search/semantic?q=invoice&streams[]=messages&streams[]=attachments&filter[received_at][gte]=2026-04-01T00:00:00Z`
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the server SHALL NOT silently apply the filter to only one of the streams

#### Scenario: A request includes an undeclared range filter
- **WHEN** a client calls `GET /v1/search/semantic?q=invoice&streams[]=messages&filter[size_bytes][gte]=1000`
- **AND** stream `messages` does not declare `query.range_filters.size_bytes.gte`
- **THEN** the server SHALL return an `invalid_request_error` or `permission_error` consistent with record-list filter validation
- **AND** the response SHALL NOT include partial results

#### Scenario: A request includes a raw vector or client-supplied embedding
- **WHEN** a client calls `GET /v1/search/semantic?q=foo&vector=...` or `GET /v1/search/semantic?q=foo&embedding=...`
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the server SHALL NOT silently ignore the rejected parameter
- **AND** the server SHALL NOT treat the rejected parameter as a lexical hint

#### Scenario: A request includes a model-selector parameter
- **WHEN** a client calls `GET /v1/search/semantic?q=foo&model=some-model` or passes `model_id`, `model_family`, or any other model selector
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the configured model SHALL be determined solely by the server and declared in capability metadata

#### Scenario: A request includes a ranking knob
- **WHEN** a client calls `GET /v1/search/semantic?q=foo&rank=...`, `boost=...`, `weights=...`, or `blend=...`
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the server SHALL NOT silently honor the rejected parameter

#### Scenario: A request includes a connector-specific parameter
- **WHEN** a client passes any parameter whose meaning branches on connector identity to `GET /v1/search/semantic`
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the public semantic retrieval surface SHALL NOT branch its behavior on connector identity

#### Scenario: Cross-stream search when the server does not support it
- **WHEN** a client calls `GET /v1/search/semantic?q=foo` (no `streams[]`) on a server whose advertisement reports `cross_stream: false`
- **THEN** the server SHALL return an `invalid_request_error` requiring at least one `streams[]` value

#### Scenario: A client-token request names a stream the caller is not authorized to read
- **WHEN** a client-token caller calls `GET /v1/search/semantic?q=foo&streams[]=private_journal` and the grant does not include `private_journal`
- **THEN** the server SHALL return a `permission_error` with code `grant_stream_not_allowed`
- **AND** the unauthorized stream SHALL NOT contribute hits to any other request shape

### Requirement: The extension SHALL return candidate references, not hydrated records, with an explicit experimental `retrieval_mode` field

`GET /v1/search/semantic` SHALL return a list envelope whose `data[]` entries are `search_result` objects. Each `search_result` SHALL identify a candidate record by `stream`, `record_key`, and `connector_id`. Each `search_result` SHALL include `emitted_at`, `matched_fields`, and `retrieval_mode`. Each `search_result` SHALL NOT include the full record payload. A portable numeric relevance score SHALL NOT be exposed in v1. The `record_url` and `snippet` fields are OPTIONAL: implementations MAY include either and MAY omit either without changing the rest of the response shape. The shape SHALL NOT expose debug/trace fields (`_debug`, `_explain`, `_vector_distance`, or equivalents) on the public surface.

`connector_id` is the identifier of the connector whose records contributed the hit. It is required on every result so that callers can hydrate each candidate against the correct per-connector scope, mirroring the lexical retrieval contract.

`retrieval_mode` is the one publicly experimental field on the result shape. Its allowed values in v1 are `"semantic"` (pure vector/embedding match) and `"hybrid"` (semantic blended with lexical signal). Any other value is not permitted in v1.

#### Scenario: A successful search returns candidate references
- **WHEN** the server returns matching results for a semantic search query
- **THEN** each entry in `data[]` SHALL have `object: "search_result"`
- **AND** each entry SHALL include `stream`, `record_key`, `connector_id`, `emitted_at`, `matched_fields`, and `retrieval_mode`
- **AND** no entry SHALL include a portable numeric relevance score field
- **AND** no entry SHALL include a debug/trace field such as `_debug`, `_explain`, or `_vector_distance`

#### Scenario: `retrieval_mode` is restricted to the v1 vocabulary
- **WHEN** a server returns results on `GET /v1/search/semantic`
- **THEN** every result's `retrieval_mode` value SHALL be exactly one of `"semantic"` or `"hybrid"`
- **AND** a server that does not blend lexical signal SHALL emit `retrieval_mode: "semantic"` on every result

#### Scenario: `record_url` is optional
- **WHEN** an implementation chooses not to emit `record_url` on a result
- **THEN** the result SHALL still be valid as long as `stream`, `record_key`, `connector_id`, `emitted_at`, `matched_fields`, and `retrieval_mode` are present
- **AND** the client SHALL be able to reconstruct the canonical single-record read URL from `stream`, `record_key`, and (for owner-token callers on a per-connector RS) `connector_id` using the existing record-listing convention

#### Scenario: `record_url`, when present, points to the canonical single-record read endpoint
- **WHEN** an implementation emits `record_url` on a result
- **THEN** that URL SHALL resolve to the canonical `GET /v1/streams/{stream}/records/{record_key}` endpoint for the same `stream` and `record_key`
- **AND** when the caller is an owner-token caller and the resource server scopes owner record reads per connector, the URL SHALL include the canonical owner-mode `connector_id` query parameter for that connector
- **AND** the URL SHALL NOT point to a different retrieval surface, and in particular SHALL NOT point to the lexical `/v1/search` surface

#### Scenario: Matched fields list which declared semantic fields the server attributes the hit to
- **WHEN** a result is returned for a stream whose declared `semantic_fields` are `["text", "body"]` and the caller's grant authorizes both
- **THEN** the result's `matched_fields` SHALL be a subset of `["text", "body"]`
- **AND** `matched_fields` SHALL NOT include any field outside the declared `semantic_fields` set
- **AND** `matched_fields` SHALL NOT include any field outside the caller's grant projection

#### Scenario: Matched fields MAY be empty when the server cannot honestly attribute the hit
- **WHEN** a server cannot honestly attribute a semantic hit to any specific declared field
- **THEN** the server SHALL return `matched_fields: []` rather than inventing an attribution

### Requirement: The extension SHALL enforce grant safety on every search path

The extension SHALL match only over `(stream, field)` pairs where the stream is in the caller's grant, the field is readable under the grant's effective field projection for that stream, AND the stream has declared the field in `query.search.semantic_fields`. Fields outside that intersection SHALL NOT be embedded for query matching, SHALL NOT contribute to ranking, and SHALL NOT contribute text to snippets. Implementations SHALL NOT embed over unauthorized or undeclared fields and filter results afterward ("embed everything, filter later" is prohibited).

#### Scenario: A field is declared semantic-searchable but not authorized
- **WHEN** stream `messages` declares `semantic_fields: ["text", "body"]` and the caller's grant authorizes only `text`
- **THEN** matching SHALL be limited to the `text` field
- **AND** snippets SHALL NOT include text drawn from `body`
- **AND** `matched_fields` SHALL NOT include `body`

#### Scenario: A field is authorized but not declared semantic-searchable
- **WHEN** stream `messages` declares `semantic_fields: ["text"]` and the grant authorizes both `text` and `body`
- **THEN** the search SHALL NOT embed or match the `body` field
- **AND** `matched_fields` SHALL NOT include `body`

#### Scenario: A stream contributes no searchable+authorized semantic fields
- **WHEN** a stream is in the grant but has zero `semantic_fields` declared, OR all declared `semantic_fields` are outside the grant projection
- **THEN** that stream SHALL contribute zero hits
- **AND** the response SHALL NOT signal a per-stream error for this case

#### Scenario: Filter-later enforcement is prohibited
- **WHEN** an implementation cannot compute matches without first embedding or matching against fields outside the searchable+authorized intersection
- **THEN** the implementation SHALL restructure its index/query path so unauthorized or undeclared fields are never embedded or scored for the caller
- **AND** the implementation SHALL NOT post-filter unauthorized hits out of the result list as its enforcement strategy

### Requirement: Snippets SHALL be verbatim grant-safe substrings, never model-generated text

When a server includes a `snippet` on a result, the snippet SHALL reference one entry from `matched_fields`, and the snippet text SHALL contain only verbatim substrings drawn from fields the caller is authorized to read AND that the stream has declared in `query.search.semantic_fields`. The server MAY omit the `snippet` for any individual result without changing the rest of the response shape.

#### Scenario: Snippets are verbatim substrings of authorized declared fields
- **WHEN** a server emits a `snippet` on a result
- **THEN** the snippet's `field` SHALL be an entry in `matched_fields`
- **AND** the snippet's `text` SHALL be a verbatim substring of the content of that field for that record
- **AND** the snippet's `text` SHALL NOT be a model-generated summary, paraphrase, translation, or synthesized text

#### Scenario: Snippets drawn from unauthorized or undeclared fields are forbidden
- **WHEN** a server computes a candidate snippet whose text would be drawn from a field outside the caller's grant, or from a field not declared in `query.search.semantic_fields`
- **THEN** the server SHALL omit the snippet from that result
- **AND** the server SHALL NOT substitute a paraphrase derived from that field

### Requirement: Owner-token callers SHALL search across all owner-visible connectors with no public connector-scope parameter

When the caller is an owner-token caller, `GET /v1/search/semantic` SHALL search across every connector the owner can read on this resource server. The endpoint SHALL NOT expose a public `connector_id` query parameter for owner callers in v1; the request shape is identical for owner-token and client-token callers. Each `search_result` SHALL identify the originating connector via `connector_id` so that callers can hydrate each hit against the correct per-connector owner read scope.

The grant-safety, declared-semantic-field, and snippet-safety invariants apply identically: for each owner-visible connector, the server SHALL match only over `(stream, field)` pairs the owner can read AND that the connector's stream has declared in `query.search.semantic_fields`. Connectors with zero declared `semantic_fields` contribute zero hits.

#### Scenario: Owner-token caller searches without naming a connector
- **WHEN** an owner-token caller calls `GET /v1/search/semantic?q=bank%20fees` without `streams[]`
- **THEN** the server SHALL search across every connector the owner can read on this resource server
- **AND** SHALL NOT require a `connector_id` query parameter

#### Scenario: Owner-token caller narrows by stream
- **WHEN** an owner-token caller calls `GET /v1/search/semantic?q=bank%20fees&streams[]=transactions`
- **THEN** the server SHALL search the `transactions` stream of every owner-visible connector that exposes that stream and declares semantic-searchable fields on it
- **AND** SHALL NOT silently scope the search to a single connector

#### Scenario: Owner-token semantic search results identify the originating connector
- **WHEN** an owner-token caller receives a `search_result` for a hit from connector `C` and stream `S`
- **THEN** the `search_result` SHALL include `connector_id: "C"` and `stream: "S"`
- **AND** the caller SHALL be able to use that `connector_id` to hydrate the record through the owner-mode single-record read endpoint

#### Scenario: A `connector_id` query parameter is rejected on the public surface
- **WHEN** any caller passes `connector_id=...` to `GET /v1/search/semantic` in v1
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the parameter SHALL NOT be silently honored

### Requirement: Streams that participate in semantic retrieval SHALL declare `semantic_fields` in their stream metadata

A stream that participates in semantic retrieval SHALL declare its semantic-searchable fields under `query.search.semantic_fields` in its existing per-stream metadata. The declaration SHALL accept only top-level scalar string fields defined by the stream's schema in v1. Nested paths, arrays, blob content, and connector-specific search semantics SHALL NOT be expressible through `semantic_fields` in v1. A stream that does not participate in semantic retrieval SHALL omit `query.search.semantic_fields`. The `semantic_fields` declaration SHALL be independent of `lexical_fields`: neither declaration implies the other, and a field MAY be declared in one, both, or neither.

#### Scenario: A participating stream emits the declaration
- **WHEN** a client reads `GET /v1/streams/messages` for a stream that participates in semantic retrieval
- **THEN** the response SHALL include `query.search.semantic_fields`
- **AND** every entry in that array SHALL refer to a top-level scalar string field present in the stream's schema

#### Scenario: A non-participating stream omits the declaration
- **WHEN** a stream does not participate in semantic retrieval
- **THEN** the stream's metadata SHALL omit `query.search.semantic_fields`
- **AND** semantic searches that include this stream SHALL contribute zero hits from it
- **AND** the stream MAY still declare `query.search.lexical_fields` and participate in lexical retrieval

#### Scenario: A stream declares both lexical and semantic fields independently
- **WHEN** a stream declares `query.search.lexical_fields: ["text", "subject"]` and `query.search.semantic_fields: ["text", "body"]`
- **THEN** lexical searches SHALL match only over `["text", "subject"]`
- **AND** semantic searches SHALL match only over `["text", "body"]`
- **AND** the presence of a field in one declaration SHALL NOT cause it to be considered for the other

#### Scenario: A stream attempts to declare an unsupported semantic_field shape
- **WHEN** an implementation would otherwise expose `query.search.semantic_fields` containing a nested path, an array field, a blob reference, a non-string scalar, or a name not present in the stream's schema
- **THEN** the implementation SHALL omit that entry from the declaration in v1
- **AND** SHALL NOT attempt to embed or match against that field from the public extension surface

### Requirement: The resource server SHALL advertise the extension through its existing metadata document, with explicit experimental stability

Implementations that expose this extension SHALL publish the advertisement as a `capabilities.semantic_retrieval` object inside the existing resource-server metadata document (the same document already used by the resource server to publish OAuth-shaped metadata and, when present, the `capabilities.lexical_retrieval` advertisement). The advertisement SHALL describe only global facts about the extension. The advertisement SHALL include, when `supported: true`, the keys `supported`, `stability`, `endpoint`, `cross_stream`, `query_input`, `snippets`, `lexical_blending`, `model`, `dimensions`, `distance_metric`, `default_limit`, `max_limit`, and `index_state`. The advertisement SHALL NOT enumerate per-stream `semantic_fields`. It SHALL NOT grow into a generalized capability-statement document.

The advertised `index_state` SHALL be computed against the active storage backend that holds the operational semantic index. An implementation that supports multiple storage backends SHALL NOT report `index_state` based on inactive-backend metadata or progress rows.

#### Scenario: A server that exposes the extension publishes the advertisement with experimental stability
- **WHEN** an implementation exposes the extension on a resource server
- **THEN** that resource server's metadata document SHALL include a `capabilities.semantic_retrieval` object
- **AND** the object SHALL include `supported: true`, `stability: "experimental"`, `endpoint`, `cross_stream`, `query_input`, `snippets`, `lexical_blending`, `model`, `dimensions`, `distance_metric`, `default_limit`, `max_limit`, and `index_state`
- **AND** `endpoint` SHALL be a path resolvable on the same resource server, and SHALL be `/v1/search/semantic` unless the resource server is mounted under a path prefix, in which case the prefix SHALL be reflected

#### Scenario: `query_input` is text-only in v1
- **WHEN** an implementation publishes the advertisement in v1
- **THEN** `query_input` SHALL be exactly the string `"text"`
- **AND** other values (such as `"vector"` or `"hybrid"`) SHALL NOT appear in v1 advertisements

#### Scenario: `stability` cannot be silently omitted or upgraded in v1
- **WHEN** an implementation publishes the advertisement in v1
- **THEN** `stability` SHALL be exactly the string `"experimental"`
- **AND** a v1 implementation SHALL NOT publish `stability: "stable"` on this extension
- **AND** the field SHALL NOT be silently omitted when the extension is advertised as supported

#### Scenario: `index_state` honestly reports the current readiness of the extension
- **WHEN** an implementation publishes the advertisement
- **THEN** `index_state` SHALL be exactly one of `"built"`, `"building"`, or `"stale"`
- **AND** the implementation SHALL report `"stale"` when the configured `model` has changed or when `semantic_fields` have changed in a way that invalidates existing index coverage, until a rebuild restores coverage
- **AND** the implementation SHALL NOT report `"built"` while the advertised `model` disagrees with the content of the operational index

#### Scenario: `index_state` is computed against the active storage backend
- **WHEN** an implementation supports more than one semantic-index storage backend (for example a local embedded store and an external database)
- **AND** the implementation has selected one of those backends as the active operational backend for the current process
- **THEN** the advertised `index_state` SHALL be derived solely from the active backend's semantic meta and backfill-progress state
- **AND** the implementation SHALL NOT report `"stale"` solely because inactive-backend storage contains orphaned progress or meta rows left from an earlier configuration
- **AND** the implementation SHALL still report `"stale"` when the active backend's meta identity disagrees with the live embedding backend identity (`model`, `dimensions`, `distance_metric`)
- **AND** the implementation SHALL still report `"building"` while an in-process backfill is active, regardless of which storage backend is active

#### Scenario: The semantic surface SHALL NOT silently substitute a non-semantic fallback
- **WHEN** `index_state` is `"building"` or `"stale"`, or when the server is otherwise unable to produce semantic results honoring the declared `model`
- **THEN** the server MAY return an empty or partial result set
- **AND** the server SHALL NOT substitute lexical-only matching (or any other non-semantic fallback) behind `GET /v1/search/semantic` while continuing to emit `retrieval_mode: "semantic"` or `retrieval_mode: "hybrid"` on results
- **AND** a server that cannot honestly produce semantic or hybrid results SHALL either return zero results or SHALL NOT advertise `capabilities.semantic_retrieval.supported: true`

#### Scenario: `lexical_blending` governs whether hybrid results are permitted
- **WHEN** an advertisement reports `lexical_blending: false`
- **THEN** every result on `GET /v1/search/semantic` SHALL carry `retrieval_mode: "semantic"`
- **AND** no result SHALL carry `retrieval_mode: "hybrid"`

- **WHEN** an advertisement reports `lexical_blending: true`
- **THEN** individual results MAY carry `retrieval_mode: "hybrid"` or `retrieval_mode: "semantic"` at the server's discretion

#### Scenario: Optional `language_bias` is published when materially known
- **WHEN** the configured `model` has materially known language or locale bias
- **THEN** the advertisement SHOULD include a `language_bias` object with at minimum a `primary` BCP-47 language tag and a free-form `note`
- **AND** the client MAY use that information to choose between semantic and lexical retrieval, or to reject the extension for its use case

#### Scenario: A server that does not expose the extension does not publish a positive advertisement
- **WHEN** a server does not implement the extension
- **THEN** the server SHALL either omit `capabilities.semantic_retrieval` from its resource-server metadata, OR include it with `supported: false`
- **AND** in either case clients SHALL treat the extension as unavailable on that server

#### Scenario: The advertisement does not duplicate per-stream declarations
- **WHEN** a server advertises the extension
- **THEN** the advertisement SHALL NOT enumerate per-stream `semantic_fields`
- **AND** clients SHALL discover per-stream semantic-searchable fields through existing per-stream metadata at `GET /v1/streams/{stream}`

#### Scenario: The advertisement is discoverable without a grant
- **WHEN** an unauthenticated client requests the resource-server metadata document
- **THEN** the `capabilities.semantic_retrieval` advertisement, if present, SHALL be returned without requiring a bearer token
- **AND** the advertisement SHALL NOT include grant-bound or caller-specific fields

#### Scenario: The advertisement is independent of the lexical retrieval advertisement
- **WHEN** a server publishes resource-server metadata
- **THEN** the presence or absence of `capabilities.semantic_retrieval` SHALL NOT be inferred from `capabilities.lexical_retrieval`
- **AND** the presence or absence of `capabilities.lexical_retrieval` SHALL NOT be inferred from `capabilities.semantic_retrieval`

### Requirement: Search results SHALL paginate via opaque cursors that are independent of record-list, changes_since, and lexical-search cursors

Pagination on `GET /v1/search/semantic` SHALL use an opaque `next_cursor` that clients pass back verbatim as `cursor`. Semantic-search cursors SHALL NOT be reused as record-list cursors, SHALL NOT be reused as `changes_since` values, and SHALL NOT be reused as lexical-search cursors on `GET /v1/search`. Within a single semantic-search session (same `q`, same `streams[]`, same grant), pagination SHALL progress stably enough to avoid obvious duplication and infinite loops, but SHALL NOT promise monotonic timestamp ordering, durability across server restarts, or stability across grant changes, index rebuilds, or model changes.

#### Scenario: A client paginates a semantic search
- **WHEN** a `GET /v1/search/semantic` response includes `has_more: true` and a `next_cursor`
- **THEN** the client SHALL pass `next_cursor` back as `cursor` to retrieve the next page
- **AND** the server SHALL treat the cursor as opaque

#### Scenario: A client tries to reuse a semantic-search cursor on another surface
- **WHEN** a client passes a `next_cursor` from `/v1/search/semantic` to `GET /v1/streams/{stream}/records?cursor=...`, to a `changes_since` parameter, or to `GET /v1/search?cursor=...`
- **THEN** the receiving endpoint SHALL be free to reject it as `invalid_cursor`
- **AND** the semantic-search pagination grammar SHALL NOT be interchangeable with any other pagination grammar

#### Scenario: A semantic-search cursor expires
- **WHEN** a client returns to a stale semantic-search cursor across server restart, index rebuild, model change, grant change, or vendor-defined cursor expiry
- **THEN** the server MAY return `invalid_cursor`
- **AND** the client SHALL recover by issuing a fresh search

### Requirement: Ranking SHALL be relevance-oriented but free of portable numeric score commitments

Results SHALL be returned in relevance-oriented order. Higher-ranked results SHOULD generally be more relevant than lower-ranked results. The extension SHALL NOT define a portable numeric score (cosine, L2, dot product, BM25, blend, or otherwise) in v1, SHALL NOT define a specific reranker, SHALL NOT define recency blending, and SHALL NOT define per-connector custom weighting as portable contract. The extension SHALL NOT promise cross-server comparable results.

#### Scenario: A client expects relevance-ordered results
- **WHEN** a client receives `data[]` from `/v1/search/semantic`
- **THEN** higher-positioned results SHALL be intended to be at least as relevant to `q` as lower-positioned results
- **AND** no entry SHALL include a portable numeric relevance score

#### Scenario: A client tries to influence ranking via a parameter
- **WHEN** a client passes `rank=...`, `boost=...`, `weights=...`, `blend=...`, or a similar ranking parameter to `/v1/search/semantic` in v1
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the parameter SHALL NOT be silently honored

### Requirement: The extension SHALL be text-query-only in v1 and SHALL NOT widen into raw vector queries, client-supplied embeddings, or generalized vector APIs

In v1 the extension SHALL accept only text queries over declared semantic-searchable fields, against a server-declared embedding model. It SHALL NOT accept raw vector input, client-supplied embeddings, model-selector parameters, embedding-export requests, or a generalized vector/ANN API. Implementations that wish to offer raw vector queries, embedding export, or richer retrieval SHALL do so as a separate, explicitly named extension or a future change to this one — not by silently broadening `GET /v1/search/semantic`.

#### Scenario: A request attempts a raw vector or embedding-export operation
- **WHEN** a client passes `vector=...`, `embedding=...`, `embed=...`, or any vector-input or embedding-export-shaped parameter
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the parameter SHALL NOT be silently mapped to text-query behavior

#### Scenario: A future richer surface is added
- **WHEN** an implementation later wants to offer body-DSL, raw vector queries, or client-supplied embeddings
- **THEN** that surface SHALL be introduced as a separately-named extension or a separately-versioned future revision of this one
- **AND** the v1 `GET /v1/search/semantic` contract SHALL remain unbroken

### Requirement: The extension SHALL NOT pre-empt canonical embedding self-export, entity resolution, or cross-server portability

The extension SHALL NOT imply that embeddings are part of canonical owner self-export. The extension SHALL NOT imply any cross-connector entity resolution contract. The extension SHALL NOT imply that results from one server are comparable to results from another server. These are separate decisions deliberately not resolved by this change.

#### Scenario: A client assumes embeddings are owner-exportable because semantic retrieval is advertised
- **WHEN** a server advertises `capabilities.semantic_retrieval.supported: true`
- **THEN** the client SHALL NOT assume that owner self-export includes embeddings as canonical content
- **AND** any owner self-export treatment of embeddings SHALL be governed by the separate self-export contract, not by this extension

#### Scenario: A client assumes cross-server comparability
- **WHEN** a client receives results from two servers both advertising `capabilities.semantic_retrieval.supported: true`
- **THEN** the client SHALL NOT assume the results are directly comparable
- **AND** the client SHALL treat differences in declared `model`, `dimensions`, `distance_metric`, and corpus as reasons results are not cross-server comparable

### Requirement: Semantic retrieval SHALL advertise score support before emitting scores
If the reference implementation emits semantic retrieval scores, it SHALL advertise score support in `capabilities.semantic_retrieval` before clients query `/v1/search/semantic`. The advertisement SHALL identify the score kind, ordering direction, model identity, and whether values are distances or similarities.

#### Scenario: Server emits semantic scores
- **WHEN** semantic retrieval capability metadata advertises score support
- **AND** a client queries `/v1/search/semantic`
- **THEN** each semantic hit SHALL include a typed score object
- **AND** the score object SHALL identify the score kind and ordering direction

#### Scenario: Model changes
- **WHEN** the active semantic model, dimensions, dtype, or distance metric changes
- **THEN** clients SHALL NOT treat scores from the old and new identity as comparable

### Requirement: Semantic scores SHALL be grant-safe and avoid vector leakage
Semantic scores SHALL be computed only from fields visible under the active grant. Semantic responses SHALL NOT expose embeddings, raw vector distances beyond the typed score, candidate pool sizes, or hidden matched fields.

#### Scenario: Hidden semantic field exists
- **WHEN** a stream declares semantic fields that are outside the caller's grant projection
- **THEN** those hidden fields SHALL NOT contribute to the returned score
- **AND** the response SHALL NOT disclose hidden-field matches or snippets
