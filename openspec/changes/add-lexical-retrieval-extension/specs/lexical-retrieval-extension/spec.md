## ADDED Requirements

### Requirement: Lexical retrieval is an optional, advertised, named extension

PDPP SHALL define a named optional extension `lexical-retrieval` that implementations MAY expose. The extension SHALL NOT be assumed by clients to exist on any server unless the server explicitly advertises it via the server-level capability surface defined below. Core PDPP SHALL NOT require this extension. The extension SHALL NOT be exposed silently as ambient reference behavior.

#### Scenario: A client encounters a server that does not advertise the extension
- **WHEN** a client reads server-level capability metadata and `capabilities.lexical_retrieval.supported` is absent or `false`
- **THEN** the client SHALL NOT assume `GET /v1/search` is available
- **AND** the server MAY return `404` or `not_found_error` if the endpoint is requested

#### Scenario: A client encounters a server that advertises the extension
- **WHEN** server-level capability metadata reports `capabilities.lexical_retrieval.supported: true`
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

#### Scenario: A request names a stream the caller is not authorized to read
- **WHEN** a client calls `GET /v1/search?q=overdraft&streams[]=private_journal` and the grant does not include `private_journal`
- **THEN** the server SHALL return a `permission_error` with code `grant_stream_not_allowed`
- **AND** the unauthorized stream SHALL NOT contribute hits to any other request shape

#### Scenario: Cross-stream search when the server does not support it
- **WHEN** a client calls `GET /v1/search?q=overdraft` (no `streams[]`) on a server whose advertisement reports `cross_stream: false`
- **THEN** the server SHALL return an `invalid_request_error` requiring at least one `streams[]` value

### Requirement: The extension SHALL return candidate references, not hydrated records

`GET /v1/search` SHALL return a list envelope whose `data[]` entries are `search_result` objects. Each `search_result` SHALL identify a candidate record by stream and `record_key` and SHALL NOT include the full record payload. A portable numeric relevance score SHALL NOT be exposed in v1.

#### Scenario: A successful search returns candidate references
- **WHEN** the server returns matching results for a search query
- **THEN** each entry in `data[]` SHALL have `object: "search_result"`
- **AND** each entry SHALL include `stream`, `record_key`, and `emitted_at`
- **AND** each entry SHALL include `record_url` referencing the canonical single-record read endpoint when easily computable
- **AND** no entry SHALL include a portable numeric relevance score field

#### Scenario: Matched fields list which declared searchable fields matched
- **WHEN** a result is returned for a stream whose declared `lexical_fields` are `["text", "subject"]` and the caller's grant authorizes both
- **THEN** the result's `matched_fields` SHALL be a subset of `["text", "subject"]`
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

### Requirement: Streams SHALL declare searchable fields in their stream metadata

A stream that participates in lexical retrieval SHALL declare its searchable fields under `query.search.lexical_fields` in its existing per-stream metadata. v1 SHALL accept only top-level scalar string fields defined by the stream's schema. Nested paths, arrays, blob content, and connector-specific search semantics SHALL NOT be expressible through `lexical_fields` in v1.

#### Scenario: A stream declares searchable fields
- **WHEN** a client reads `GET /v1/streams/messages`
- **THEN** the response MAY include `query.search.lexical_fields: [...]`
- **AND** every entry in that array SHALL refer to a top-level scalar string field present in the stream's schema

#### Scenario: A stream omits the declaration
- **WHEN** a stream's metadata does not include `query.search`
- **THEN** the stream SHALL be treated as not participating in lexical retrieval
- **AND** searches that include this stream SHALL contribute zero hits from it

#### Scenario: A stream attempts to declare an unsupported lexical_field shape
- **WHEN** an implementation would otherwise expose `query.search.lexical_fields` containing a nested path, an array field, a blob reference, or a name not present in the stream's schema
- **THEN** the implementation SHALL omit that entry from the declaration in v1
- **AND** SHALL NOT attempt to match against that field from the public extension surface

### Requirement: The server SHALL advertise the extension through a small global capability surface

Implementations that expose this extension SHALL publish a server-level advertisement describing only global facts about the extension. The advertisement SHALL identify support, endpoint location, whether cross-stream search is supported, whether snippets are emitted, and global limit defaults. The advertisement SHALL NOT enumerate per-stream `lexical_fields`. It SHALL NOT grow into a generalized capability-statement document.

#### Scenario: A server advertises the extension
- **WHEN** a client reads server-level capability metadata
- **THEN** the metadata MAY include a `capabilities.lexical_retrieval` object
- **AND** when present, that object SHALL include `supported`, `endpoint`, `cross_stream`, `snippets`, `default_limit`, and `max_limit` fields

#### Scenario: A server does not expose the extension
- **WHEN** a server does not implement the extension
- **THEN** the server SHALL omit `capabilities.lexical_retrieval` from its capability metadata, OR report `supported: false`

#### Scenario: The advertisement does not duplicate per-stream declarations
- **WHEN** a server advertises the extension
- **THEN** the advertisement SHALL NOT enumerate per-stream `lexical_fields`
- **AND** clients SHALL discover per-stream searchable fields through existing per-stream metadata at `GET /v1/streams/{stream}`

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
