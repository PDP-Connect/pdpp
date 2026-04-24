## MODIFIED Requirements

### Requirement: The extension SHALL expose `GET /v1/search` with a constrained query surface

When advertised, the extension SHALL be reachable as `GET /v1/search`. The endpoint SHALL accept a required `q` parameter and the optional parameters `limit`, `cursor`, repeated `streams[]`, and stream-scoped `filter[...]` parameters. In this tranche, any request that includes `filter[...]` SHALL include exactly one `streams[]` value. The endpoint SHALL NOT accept expansion parameters, sort parameters, semantic/vector parameters, ranking parameters, connector-specific parameters, generic predicate DSL parameters, or arbitrary field filters outside the stream-scoped filter rules below.

`filter[field]=value` SHALL use the same exact-filter semantics as record listing for the named stream: the field SHALL be an authorized top-level scalar schema field for the caller and stream. `filter[field][gte|gt|lte|lt]=value` SHALL use the same declared range-filter semantics as record listing: the field and operator SHALL be declared in the stream metadata's `query.range_filters`. Filters SHALL constrain the candidate records that may contribute lexical matches, ranking, matched fields, and snippets.

#### Scenario: A request omits `q`
- **WHEN** a client calls `GET /v1/search` without `q`
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the response SHALL NOT include any candidate results

#### Scenario: A request includes only allowed unfiltered parameters
- **WHEN** a client calls `GET /v1/search?q=overdraft&limit=10&streams[]=messages`
- **THEN** the server SHALL accept the request

#### Scenario: A request includes an allowed single-stream filter
- **WHEN** a client calls `GET /v1/search?q=invoice&streams[]=messages&filter[received_at][gte]=2026-04-01T00:00:00Z`
- **AND** stream `messages` declares `query.range_filters.received_at` with operator `gte`
- **AND** the caller is authorized to read `received_at`
- **THEN** the server SHALL accept the request
- **AND** every returned result SHALL identify a record whose visible `received_at` satisfies the filter

#### Scenario: A filtered request omits streams
- **WHEN** a client calls `GET /v1/search?q=invoice&filter[received_at][gte]=2026-04-01T00:00:00Z`
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the server SHALL NOT search every stream and apply the filter opportunistically

#### Scenario: A filtered request names multiple streams
- **WHEN** a client calls `GET /v1/search?q=invoice&streams[]=messages&streams[]=attachments&filter[received_at][gte]=2026-04-01T00:00:00Z`
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the server SHALL NOT silently apply the filter to only one of the streams

#### Scenario: A request includes an undeclared range filter
- **WHEN** a client calls `GET /v1/search?q=invoice&streams[]=messages&filter[size_bytes][gte]=1000`
- **AND** stream `messages` does not declare `query.range_filters.size_bytes.gte`
- **THEN** the server SHALL return an `invalid_request_error` or `permission_error` consistent with record-list filter validation
- **AND** the response SHALL NOT include partial results

#### Scenario: A request includes a disallowed v1 parameter
- **WHEN** a client calls `GET /v1/search?q=overdraft&rank=recency`
- **THEN** the server SHALL return an `invalid_request_error`
- **AND** the error SHALL identify the rejected parameter

#### Scenario: A client-token request names a stream the caller is not authorized to read
- **WHEN** a client-token caller calls `GET /v1/search?q=overdraft&streams[]=private_journal` and the grant does not include `private_journal`
- **THEN** the server SHALL return a `permission_error` with code `grant_stream_not_allowed`
- **AND** the unauthorized stream SHALL NOT contribute hits to any other request shape

#### Scenario: Cross-stream search when the server does not support it
- **WHEN** a client calls `GET /v1/search?q=overdraft` (no `streams[]`) on a server whose advertisement reports `cross_stream: false`
- **THEN** the server SHALL return an `invalid_request_error` requiring at least one `streams[]` value
