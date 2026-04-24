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

When advertised, the extension SHALL be reachable as `GET /v1/search`. The endpoint SHALL accept a required `q` parameter and the optional parameters `limit`, `cursor`, and repeated `streams[]`. It SHALL NOT accept arbitrary field filters, expansion parameters, sort parameters, semantic/vector parameters, ranking parameters, or connector-specific parameters in v1.

#### Scenario: A request omits `q`
- **WHEN** a client calls `GET /v1/search` without `q`
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the response SHALL NOT include any candidate results

#### Scenario: A request includes only allowed parameters
- **WHEN** a client calls `GET /v1/search?q=overdraft&limit=10&streams[]=messages`
- **THEN** the server SHALL accept the request

#### Scenario: A request includes a disallowed v1 parameter
- **WHEN** a client calls `GET /v1/search?q=overdraft&filter[recipient]=alice`
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the error SHALL identify the rejected parameter

#### Scenario: A client-token request names a stream the caller is not authorized to read
- **WHEN** a client-token caller calls `GET /v1/search?q=overdraft&streams[]=private_journal` and the grant does not include `private_journal`
- **THEN** the server SHALL return a `permission_error` with code `grant_stream_not_allowed`
- **AND** the unauthorized stream SHALL NOT contribute hits to any other request shape

(Owner-token `streams[]` semantics are defined separately below: an owner-token caller's `streams[]` is a soft filter across all owner-visible connectors, not a hard authorization check.)

#### Scenario: Cross-stream search when the server does not support it
- **WHEN** a client calls `GET /v1/search?q=overdraft` (no `streams[]`) on a server whose advertisement reports `cross_stream: false`
- **THEN** the server SHALL return an `invalid_request_error` requiring at least one `streams[]` value

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
