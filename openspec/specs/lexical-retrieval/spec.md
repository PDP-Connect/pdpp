# lexical-retrieval Specification

## Purpose
Define PDPP's optional lexical retrieval extension: a discoverable, grant-safe, text-query search surface at `GET /v1/search` with stream-declared searchable fields and portable result-shape guarantees.
## Requirements
### Requirement: Lexical retrieval is an optional, advertised, named extension

PDPP SHALL define a named optional extension `lexical-retrieval` that implementations MAY expose. The extension SHALL NOT be assumed by clients to exist on any server unless the server explicitly advertises it via the resource-server metadata surface defined below. Core PDPP SHALL NOT require this extension. The extension SHALL NOT be exposed silently as ambient reference behavior.

#### Scenario: A client encounters a server that does not advertise the extension
- **WHEN** a client reads resource-server metadata and `capabilities.lexical_retrieval.supported` is absent or `false`
- **THEN** the client SHALL NOT assume `GET /v1/search` is available
- **AND** the server MAY return `404` or `not_found_error` if the endpoint is requested

#### Scenario: A client encounters a server that advertises the extension
- **WHEN** resource-server metadata reports `capabilities.lexical_retrieval.supported: true`
- **THEN** the client MAY rely on `GET /v1/search` being available at the advertised `endpoint` path
- **AND** the client MAY rely on the `cross_stream`, `snippets`, `default_limit`, and `max_limit` fields when shaping requests

#### Scenario: The extension is not silently delivered through `/_ref/search`
- **WHEN** an implementation chooses to expose this extension
- **THEN** the public surface SHALL be the advertised `/v1/search` endpoint
- **AND** the implementation SHALL NOT advertise `/_ref/search` (or any other reference-only surface) as the public lexical retrieval endpoint
- **AND** `/_ref/search` SHALL remain reference-only artifact/id-jump behavior with no public interoperability claim

### Requirement: The extension SHALL expose `GET /v1/search` with a constrained query surface

`GET /v1/search` SHALL remain the lexical retrieval endpoint even when a server also advertises hybrid retrieval. Hybrid retrieval SHALL NOT silently alter lexical result ranking, filtering, scoring, or response shape.

#### Scenario: Hybrid retrieval is also available

- **WHEN** a server advertises both lexical retrieval and hybrid retrieval
- **THEN** `GET /v1/search` SHALL continue to behave as lexical retrieval
- **AND** clients that want blended recall SHALL call the advertised hybrid endpoint.

### Requirement: The extension SHALL return candidate references, not hydrated records

`GET /v1/search` SHALL return a list envelope whose `data[]` entries are `search_result` objects. Each `search_result` SHALL identify a candidate record by `stream`, `record_key`, and the originating connector via `connector_id`. Each `search_result` SHALL NOT include the full record payload. A portable numeric relevance score SHALL NOT be exposed in v1. The `record_url` field is OPTIONAL: implementations MAY include it to give clients a ready-made canonical single-record read URL, and MAY omit it without changing the rest of the response shape.

`connector_id` is the identifier of the connector whose records contributed the hit. It is required on every result so that callers can hydrate each candidate against the correct per-connector scope. For client-token callers, `connector_id` mirrors the connector identity already encoded in the caller's grant for that stream. For owner-token callers, `connector_id` identifies which owner-visible connector the hit came from, since owner reads of records and stream metadata are scoped per connector on the resource server.

#### Scenario: A successful search returns candidate references
- **WHEN** the server returns matching results for a search query
- **THEN** each entry in `data[]` SHALL have `object: "search_result"`
- **AND** each entry SHALL include `stream`, `record_key`, `emitted_at`, and `connector_id`
- **AND** no entry SHALL include a portable numeric relevance score field

#### Scenario: `record_url` is optional
- **WHEN** an implementation chooses not to emit `record_url` on a result
- **THEN** the result SHALL still be valid as long as `stream`, `record_key`, `emitted_at`, and `connector_id` are present
- **AND** the client SHALL be able to reconstruct the canonical single-record read URL from `stream`, `record_key`, and (for owner-token callers) `connector_id` using the existing record-listing convention

#### Scenario: `record_url`, when present, points to the canonical single-record read endpoint
- **WHEN** an implementation emits `record_url` on a result
- **THEN** that URL SHALL resolve to the canonical `GET /v1/streams/{stream}/records/{record_key}` endpoint for the same stream and `record_key`
- **AND** when the caller is an owner-token caller and the resource server scopes owner record reads per connector, the URL SHALL include the canonical owner-mode `connector_id` query parameter for that connector
- **AND** the URL SHALL NOT point to a different retrieval surface

#### Scenario: Matched fields list which declared searchable fields matched
- **WHEN** a result is returned for a stream whose declared `lexical_fields` are `["text", "subject"]` and the caller's grant authorizes both
- **THEN** the result's `matched_fields` SHALL be a non-empty subset of `["text", "subject"]`
- **AND** `matched_fields` SHALL NOT include any field outside the declared searchable set

#### Scenario: Snippets are optional and grant-safe
- **WHEN** a server includes a `snippet` on a result
- **THEN** the snippet SHALL reference one entry from `matched_fields`
- **AND** the snippet text SHALL contain only substrings drawn from fields the caller is authorized to read AND that the stream has declared searchable
- **AND** the server MAY omit the `snippet` for any individual result without changing the rest of the response shape

### Requirement: The extension SHALL enforce grant safety on every search

The extension SHALL search only over (stream, field) pairs where the stream is in the caller's grant, the field is readable under the grant's effective field projection for that stream, and the stream has declared the field in `query.search.lexical_fields`. Fields outside that intersection SHALL NOT contribute to matching, ranking, or snippets. Implementations SHALL NOT search over unauthorized fields and filter results afterward.

#### Scenario: A field is searchable but not authorized
- **WHEN** stream `messages` declares `lexical_fields: ["text", "subject"]` and the caller's grant authorizes only `text`
- **THEN** matches SHALL be limited to the `text` field
- **AND** snippets SHALL NOT include text drawn from `subject`
- **AND** `matched_fields` SHALL NOT include `subject`

#### Scenario: A field is authorized but not declared searchable
- **WHEN** stream `messages` declares `lexical_fields: ["text"]` and the grant authorizes both `text` and `subject`
- **THEN** the search SHALL NOT match the `subject` field
- **AND** `matched_fields` SHALL NOT include `subject`

#### Scenario: A stream contributes no searchable+authorized fields
- **WHEN** a stream is in the grant but has zero `lexical_fields` declared, OR all declared `lexical_fields` are outside the grant projection
- **THEN** that stream SHALL contribute zero hits
- **AND** the response SHALL NOT signal a per-stream error for this case

#### Scenario: Filter-later enforcement is prohibited
- **WHEN** an implementation cannot compute matches without first matching against fields outside the searchable+authorized intersection
- **THEN** the implementation SHALL restructure its search path so unauthorized fields are not considered
- **AND** the implementation SHALL NOT post-filter unauthorized hits out of the result list as its enforcement strategy

### Requirement: Owner-token callers SHALL search across all owner-visible connectors with no public connector-scope parameter

When the caller is an owner-token caller (the resource owner performing self-export rather than a grant-bound third-party client), `GET /v1/search` SHALL search across every connector the owner can read on this resource server. The endpoint SHALL NOT expose a public `connector_id` query parameter for owner callers in v1; the search request shape is identical for owner-token and client-token callers. Each `search_result` SHALL identify the originating connector via `connector_id` so that callers can hydrate each hit against the correct per-connector owner read scope.

The grant-safety, declared-searchable-field, and snippet-safety invariants apply identically: for each owner-visible connector, the server SHALL search only over `(stream, field)` pairs the owner can read AND that the connector's stream has declared in `query.search.lexical_fields`. Connectors with zero searchable streams contribute zero hits.

#### Scenario: Owner-token caller searches without naming a connector
- **WHEN** an owner-token caller calls `GET /v1/search?q=overdraft` without `streams[]`
- **THEN** the server SHALL search across every connector the owner can read on this resource server
- **AND** SHALL NOT require a `connector_id` query parameter

#### Scenario: Owner-token caller narrows by stream
- **WHEN** an owner-token caller calls `GET /v1/search?q=overdraft&streams[]=transactions`
- **THEN** the server SHALL search the `transactions` stream of every owner-visible connector that exposes that stream and declares searchable fields on it
- **AND** SHALL NOT silently scope the search to a single connector

#### Scenario: Owner-token search results identify the originating connector
- **WHEN** an owner-token caller receives a `search_result` for a hit from connector `C` and stream `S`
- **THEN** the `search_result` SHALL include `connector_id: "C"` and `stream: "S"`
- **AND** the caller SHALL be able to use that `connector_id` to hydrate the record through the owner-mode single-record read endpoint

#### Scenario: A `connector_id` query parameter is rejected on the public surface
- **WHEN** any caller passes `connector_id=...` to `GET /v1/search` in v1
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the parameter SHALL NOT be silently honored

### Requirement: Streams that participate in lexical retrieval SHALL declare searchable fields in their stream metadata

A stream that participates in lexical retrieval SHALL declare its searchable fields under `query.search.lexical_fields` in its existing per-stream metadata. The declaration SHALL accept only top-level scalar string fields defined by the stream's schema in v1. Nested paths, arrays, blob content, and connector-specific search semantics SHALL NOT be expressible through `lexical_fields` in v1. A stream that does not participate in lexical retrieval SHALL omit `query.search` entirely.

#### Scenario: A participating stream emits the declaration
- **WHEN** a client reads `GET /v1/streams/messages` for a stream that participates in lexical retrieval
- **THEN** the response SHALL include `query.search.lexical_fields`
- **AND** every entry in that array SHALL refer to a top-level scalar string field present in the stream's schema

#### Scenario: A non-participating stream omits the declaration
- **WHEN** a stream does not participate in lexical retrieval
- **THEN** the stream's metadata SHALL omit the `query.search` object
- **AND** searches that include this stream SHALL contribute zero hits from it

#### Scenario: A stream attempts to declare an unsupported lexical_field shape
- **WHEN** an implementation would otherwise expose `query.search.lexical_fields` containing a nested path, an array field, a blob reference, or a name not present in the stream's schema
- **THEN** the implementation SHALL omit that entry from the declaration in v1
- **AND** SHALL NOT attempt to match against that field from the public extension surface

### Requirement: The resource server SHALL advertise the extension through its existing metadata document

Implementations that expose this extension SHALL publish the advertisement as a `capabilities.lexical_retrieval` object inside the existing resource-server metadata document (the same document already used by the resource server to publish OAuth-shaped metadata). The advertisement SHALL describe only global facts about the extension. The advertisement SHALL include the keys `supported`, `endpoint`, `cross_stream`, `snippets`, `default_limit`, and `max_limit`. The advertisement SHALL NOT enumerate per-stream `lexical_fields`. It SHALL NOT grow into a generalized capability-statement document.

#### Scenario: A server that exposes the extension publishes the advertisement
- **WHEN** an implementation exposes the extension on a resource server
- **THEN** that resource server's metadata document SHALL include a `capabilities.lexical_retrieval` object
- **AND** the object SHALL include the keys `supported` (set to `true`), `endpoint`, `cross_stream`, `snippets`, `default_limit`, and `max_limit`
- **AND** `endpoint` SHALL be a path resolvable on the same resource server, and SHALL be `/v1/search` unless the resource server is mounted under a path prefix, in which case the prefix SHALL be reflected

#### Scenario: A server that does not expose the extension does not publish a positive advertisement
- **WHEN** a server does not implement the extension
- **THEN** the server SHALL either omit `capabilities.lexical_retrieval` from its resource-server metadata, OR include it with `supported: false`
- **AND** in either case clients SHALL treat the extension as unavailable on that server

#### Scenario: The advertisement does not duplicate per-stream declarations
- **WHEN** a server advertises the extension
- **THEN** the advertisement SHALL NOT enumerate per-stream `lexical_fields`
- **AND** clients SHALL discover per-stream searchable fields through existing per-stream metadata at `GET /v1/streams/{stream}`

#### Scenario: The advertisement is discoverable without a grant
- **WHEN** an unauthenticated client requests the resource-server metadata document
- **THEN** the `capabilities.lexical_retrieval` advertisement, if present, SHALL be returned without requiring a bearer token
- **AND** the advertisement SHALL NOT include grant-bound or caller-specific fields

### Requirement: Search results SHALL paginate via opaque cursors that are independent of record-list and changes_since cursors

Pagination on `GET /v1/search` SHALL use an opaque `next_cursor` that clients pass back verbatim as `cursor`. Search cursors SHALL NOT be reused as record-list cursors and SHALL NOT be reused as `changes_since` values. Within a single search session (same `q`, same `streams[]`, same grant), pagination SHALL progress stably enough to avoid obvious duplication and infinite loops, but SHALL NOT promise monotonic timestamp ordering, durability across server restarts, or stability across grant changes or index rebuilds.

#### Scenario: A client paginates a search
- **WHEN** a `GET /v1/search` response includes `has_more: true` and a `next_cursor`
- **THEN** the client SHALL pass `next_cursor` back as `cursor` to retrieve the next page
- **AND** the server SHALL treat the cursor as opaque

#### Scenario: A client tries to reuse a search cursor as a record-list cursor
- **WHEN** a client passes a `next_cursor` from `/v1/search` to `GET /v1/streams/{stream}/records?cursor=...`
- **THEN** the record-list endpoint SHALL be free to reject it as `invalid_cursor`
- **AND** the search and record-list pagination grammars SHALL NOT be interchangeable

#### Scenario: A search cursor expires
- **WHEN** a client returns to a stale search cursor across server restart, index rebuild, grant change, or vendor-defined cursor expiry
- **THEN** the server MAY return `invalid_cursor`
- **AND** the client SHALL recover by issuing a fresh search

### Requirement: Ranking SHALL be relevance-oriented but free of portable numeric score commitments

Search results SHALL be returned in relevance-oriented order. Higher-ranked results SHOULD generally be more relevant than lower-ranked results. The extension SHALL NOT define a portable numeric score (BM25 or otherwise) in v1, SHALL NOT define semantic reranking, and SHALL NOT define recency blending or per-connector custom weighting as portable contract.

#### Scenario: A client expects relevance-ordered results
- **WHEN** a client receives `data[]` from `/v1/search`
- **THEN** higher-positioned results SHALL be intended to be at least as relevant to `q` as lower-positioned results
- **AND** no entry SHALL include a portable numeric relevance score

#### Scenario: A client tries to influence ranking via a parameter
- **WHEN** a client passes a `rank=...`, `boost=...`, or similar ranking parameter to `/v1/search` in v1
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the parameter SHALL NOT be silently honored

### Requirement: The extension SHALL be lexical-only in v1 and SHALL NOT widen into semantic retrieval, generic predicate DSL, or connector-specific search

In v1 the extension SHALL match only by lexical means over declared searchable text fields. It SHALL NOT accept embedding parameters, vector queries, semantic similarity parameters, generic boolean/predicate query algebra, or connector-specific search semantics. Implementations that wish to offer richer retrieval SHALL do so as a separate, explicitly named extension or a future change to this one — not by silently broadening `GET /v1/search`.

#### Scenario: A request includes a semantic/vector parameter
- **WHEN** a client passes `embedding=...`, `vector=...`, `semantic=...`, or any vector/semantic-shaped parameter
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the parameter SHALL NOT be silently mapped to lexical behavior

#### Scenario: A request attempts a connector-specific search semantic
- **WHEN** a client passes a parameter that only makes sense for a specific connector (for example, a vendor-specific search operator name) to `/v1/search`
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the public lexical retrieval surface SHALL NOT branch its behavior on connector identity

#### Scenario: A future richer surface is added
- **WHEN** an implementation later wants to offer body-DSL or semantic retrieval
- **THEN** that surface SHALL be introduced as a separately-named extension or a separately-versioned future revision of this one
- **AND** the v1 `GET /v1/search` contract SHALL remain unbroken

### Requirement: Lexical retrieval SHALL advertise score support before emitting scores
If the reference implementation emits lexical search scores, it SHALL advertise score support in `capabilities.lexical_retrieval` before clients query `/v1/search`. The advertisement SHALL identify the score kind and whether higher or lower values sort better.

#### Scenario: Server emits lexical scores
- **WHEN** protected-resource metadata advertises lexical score support
- **AND** a client queries `/v1/search`
- **THEN** each lexical hit SHALL include a typed score object
- **AND** the score object SHALL identify the score kind and ordering direction

#### Scenario: Server does not advertise lexical scores
- **WHEN** protected-resource metadata omits lexical score support
- **THEN** clients SHALL NOT assume `/v1/search` responses include score fields

### Requirement: Lexical scores SHALL be grant-safe and implementation-relative
Lexical scores SHALL be computed only from fields visible under the active grant and SHALL be documented as implementation-relative unless a later change defines portable score calibration.

#### Scenario: Hidden fields are outside score computation
- **WHEN** a record contains a lexical-search field outside the caller's grant projection
- **THEN** the returned lexical score SHALL NOT include contribution from that hidden field
- **AND** no score explanation SHALL disclose that hidden field

### Requirement: Lexical search responses SHALL disclose count accuracy and recall scope

`GET /v1/search` responses SHALL include a `meta` object with response-level recall metadata. The metadata SHALL include `count`, `count_accuracy`, and `recall`.

`meta.count_accuracy` SHALL be one of `exact`, `lower_bound`, `estimated`, or `not_counted`. When `count_accuracy` is `not_counted`, `meta.count` SHALL be `null`. When `count_accuracy` is `exact`, `lower_bound`, or `estimated`, `meta.count` SHALL be a non-negative integer whose interpretation is defined by `count_accuracy`.

`meta.recall` SHALL include `complete`, `ranking_scope`, and `truncated`. `ranking_scope` SHALL be one of `all_matches`, `candidate_window`, or `unknown`. `complete: true` SHALL mean the implementation ranked all known caller-visible matches for the query before pagination. `complete: false` SHALL mean additional caller-visible matches may exist outside the ranked set. `truncated: true` SHALL mean an implementation-applied candidate or source window prevented the ranked set from representing every caller-visible match.

#### Scenario: Exact complete lexical search
- **WHEN** a server can rank all caller-visible lexical matches and compute their count exactly
- **THEN** the `/v1/search` response SHALL include `meta.count_accuracy: "exact"`
- **AND** `meta.count` SHALL equal the exact number of caller-visible matches
- **AND** `meta.recall.complete` SHALL be `true`
- **AND** `meta.recall.ranking_scope` SHALL be `"all_matches"`
- **AND** `meta.recall.truncated` SHALL be `false`

#### Scenario: Bounded candidate window lexical search
- **WHEN** a server ranks only a bounded subset of caller-visible lexical candidates
- **THEN** the `/v1/search` response SHALL include `meta.recall.complete: false`
- **AND** `meta.recall.ranking_scope` SHALL be `"candidate_window"`
- **AND** `meta.recall.truncated` SHALL be `true`
- **AND** `meta.count_accuracy` SHALL NOT be `"exact"` unless the server separately proves the exact caller-visible match count
- **AND** the response SHALL include compact window facts under `meta.recall` when the implementation knows them

#### Scenario: Count is not computed
- **WHEN** a server cannot compute a useful caller-visible count without violating latency or implementation constraints
- **THEN** the `/v1/search` response SHALL include `meta.count_accuracy: "not_counted"`
- **AND** `meta.count` SHALL be `null`
- **AND** the server SHALL still disclose `meta.recall.complete`, `meta.recall.ranking_scope`, and `meta.recall.truncated` as honestly as possible

#### Scenario: Pagination is distinct from recall completeness
- **WHEN** a `/v1/search` response has `has_more: false`
- **AND** the search ranked only a bounded candidate window
- **THEN** `meta.recall.complete` SHALL remain `false`
- **AND** `meta.recall.truncated` SHALL remain `true`
- **AND** clients SHALL NOT infer global recall completeness from `has_more`

#### Scenario: Metadata remains grant-safe
- **WHEN** a caller's grant excludes a stream, field, connector, or record
- **THEN** excluded data SHALL NOT contribute to `meta.count`
- **AND** excluded data SHALL NOT contribute to `meta.recall` window facts
- **AND** the metadata SHALL NOT enumerate unavailable connectors, streams, fields, or records

### Requirement: Candidate-window facts SHALL be compact and implementation-honest

When an implementation uses a bounded candidate window and knows compact aggregate facts about that window, it SHALL expose those facts under `meta.recall` without dumping per-source internals. Allowed compact facts include `ranked_candidate_count`, `candidate_window_limit`, `sources_searched_count`, and `truncated_source_count`. Implementations MAY omit any fact they cannot prove cheaply and SHALL NOT fabricate a fact to make the response appear more complete.

#### Scenario: Server knows candidate-window facts
- **WHEN** a server ranks 200 caller-visible candidates from a configured candidate window and knows that at least one searched source was truncated
- **THEN** `meta.recall.ranked_candidate_count` SHALL be `200`
- **AND** `meta.recall.truncated_source_count` SHALL be a positive integer
- **AND** `meta.recall.ranking_scope` SHALL be `"candidate_window"`

#### Scenario: Server cannot prove a candidate-window fact
- **WHEN** a server cannot prove `truncated_source_count` for a windowed search
- **THEN** the server SHALL omit `meta.recall.truncated_source_count`
- **AND** SHALL NOT emit `0` as a guess

### Requirement: MCP lexical search SHALL mirror recall metadata

An MCP adapter that exposes PDPP lexical search SHALL preserve the RS response's recall metadata in structured output and SHALL summarize non-complete recall in its text output. The adapter SHALL NOT infer recall completeness from `has_more`, page size, or the number of hits returned.

#### Scenario: MCP mirrors complete recall
- **WHEN** `/v1/search` returns `meta.recall.complete: true`
- **THEN** the MCP search tool's structured output SHALL include the same recall metadata
- **AND** the text summary MAY omit an extra recall warning

#### Scenario: MCP warns on candidate-window recall
- **WHEN** `/v1/search` returns `meta.recall.ranking_scope: "candidate_window"`
- **THEN** the MCP search tool's structured output SHALL include the same recall metadata
- **AND** the text summary SHALL indicate that results were ranked over a bounded candidate window
