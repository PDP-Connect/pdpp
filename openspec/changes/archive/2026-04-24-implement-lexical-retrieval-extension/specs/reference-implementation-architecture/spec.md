## ADDED Requirements

### Requirement: The reference SHALL realize the lexical-retrieval extension over a single internal enforcement path

The reference implementation SHALL realize the public `lexical-retrieval` extension defined in the `lexical-retrieval` capability through one internal helper that performs grant resolution, plan construction, and grant-safe snippet generation in the same code path. The public `GET /v1/search` route handler SHALL delegate to that helper. Reference-internal callers (including the website dashboard) SHALL reach lexical retrieval through the same public route over HTTP, not through a parallel direct-database path. The reference SHALL NOT define a second lexical retrieval contract.

#### Scenario: The dashboard searches owner records
- **WHEN** the website dashboard search page renders results for an owner
- **THEN** it SHALL obtain those results by calling the public `GET /v1/search` endpoint of the resource server with the dashboard's owner-bound bearer token
- **AND** it SHALL NOT compute results by fanning out per-stream record-list calls and substring-matching their JSON payloads in application code

#### Scenario: A second internal callsite is proposed
- **WHEN** any reference-side caller (CLI, dashboard, future operator surface) needs lexical retrieval over authorized records
- **THEN** that caller SHALL go through `GET /v1/search` (or, in-process, the single internal helper that the route delegates to)
- **AND** SHALL NOT reach into the FTS5 index, manifest validator, or grant resolver to assemble its own lexical retrieval contract

### Requirement: The reference's manifest validator SHALL enforce the v1 `lexical_fields` shape

When a connector manifest declares `query.search.lexical_fields` on any stream, the reference's manifest validator SHALL enforce the v1 shape constraints. The validator SHALL reject manifests whose declarations would let the public extension search anything other than top-level scalar string fields named in the stream's schema.

#### Scenario: A manifest declares a nested path as a lexical field
- **WHEN** a manifest declares `query.search.lexical_fields: ["data.body"]` (a nested path) on a stream
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares an array-typed schema field as a lexical field
- **WHEN** a manifest declares `query.search.lexical_fields: ["tags"]` and the stream's schema lists `tags` as `type: "array"`
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares a non-existent field as a lexical field
- **WHEN** a manifest declares `query.search.lexical_fields: ["nonexistent"]` and `nonexistent` is not in `schema.properties`
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares an empty lexical_fields array
- **WHEN** a manifest declares `query.search.lexical_fields: []`
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

### Requirement: The reference SHALL publish the `capabilities.lexical_retrieval` advertisement on its existing protected-resource metadata document

When the reference exposes the lexical-retrieval extension, the existing RFC 9728 protected-resource metadata document the reference already serves SHALL include a `capabilities.lexical_retrieval` object carrying all six required keys. The reference SHALL NOT introduce a new metadata document for this advertisement, and SHALL NOT publish the advertisement on the authorization-server metadata document.

#### Scenario: The advertisement is co-located with existing RS metadata
- **WHEN** a client retrieves the reference's protected-resource metadata document
- **THEN** the response SHALL include `capabilities.lexical_retrieval` with `supported`, `endpoint`, `cross_stream`, `snippets`, `default_limit`, and `max_limit`
- **AND** the reference SHALL NOT serve the advertisement from a separately discoverable metadata document

#### Scenario: A reference fork wishes to publish the extension as unsupported
- **WHEN** a reference fork or test harness configures the reference to omit the extension
- **THEN** the protected-resource metadata document SHALL either omit `capabilities.lexical_retrieval` entirely or include it with `supported: false`

### Requirement: The reference's lexical retrieval index SHALL index only declared `lexical_fields`

The reference's local search backing (a SQLite FTS5 virtual table) SHALL contain entries only for `(stream, record_key, field)` tuples where `field` appears in the corresponding stream's `query.search.lexical_fields` declaration. Records of streams that do not declare `lexical_fields` SHALL NOT contribute index rows. Non-declared fields of records of streams that do declare `lexical_fields` SHALL NOT contribute index rows.

#### Scenario: A non-participating stream has new records
- **WHEN** new records arrive for a stream whose manifest does not declare `query.search.lexical_fields`
- **THEN** the FTS5 lexical search index SHALL NOT receive new rows for that stream

#### Scenario: A participating stream has new records
- **WHEN** new records arrive for a stream whose manifest declares `lexical_fields: ["a", "b"]`
- **THEN** the FTS5 lexical search index SHALL receive exactly two rows for each record (one per declared field)
- **AND** SHALL NOT receive rows for any other field of that record

#### Scenario: The index drifts from the records table
- **WHEN** the reference starts and detects a mismatch between the records table and the FTS5 index for one or more participating streams
- **THEN** the reference SHALL rebuild the index from the records table for the affected streams

### Requirement: The reference SHALL realize owner-token lexical retrieval through cross-connector fan-out

The reference scopes owner reads of records and stream metadata per connector. The reference SHALL realize owner-token lexical retrieval by fanning out across every owner-visible connector internally and merging results, so that the public `GET /v1/search` request shape stays identical for owner-token and client-token callers (no public `connector_id` query parameter). Each `search_result` returned to an owner-token caller SHALL carry the originating connector via `connector_id` so the caller can hydrate the record under the correct per-connector owner read scope. The reference SHALL emit a `record_url` that includes the canonical owner-mode `connector_id` query parameter for owner-token callers.

#### Scenario: An owner searches across two connectors that both expose the same stream name
- **WHEN** an owner-token caller invokes `GET /v1/search?q=alpha` on a reference instance with two owner-visible connectors `C1` and `C2`, both of which expose a `messages` stream that declares `lexical_fields: ["text"]` and both of which contain a record matching `alpha`
- **THEN** the response SHALL include hits from BOTH connectors
- **AND** each hit SHALL carry its originating `connector_id` (`"C1"` for hits from `C1`, `"C2"` for hits from `C2`)
- **AND** the response SHALL NOT silently scope to a single connector

#### Scenario: An owner request includes `connector_id`
- **WHEN** an owner-token caller invokes `GET /v1/search?q=alpha&connector_id=C1`
- **THEN** the reference SHALL reject the request with `invalid_request_error` identifying `connector_id` as the rejected parameter
- **AND** SHALL NOT silently use `connector_id` to scope the search

#### Scenario: An owner-mode `record_url` is hydrated
- **WHEN** an owner-token caller takes the `record_url` from a `/v1/search` hit and issues a GET against it under the same owner token
- **THEN** the reference SHALL return the canonical record envelope at `GET /v1/streams/{stream}/records/{record_key}` for the connector identified by the URL's `connector_id` query parameter

### Requirement: The reference's lexical retrieval index SHALL include connector identity in every row

Because the reference's owner reads are per-connector, the lexical retrieval index SHALL include the originating `connector_id` on every indexed row so that owner-mode hits can be attributed to a connector for hydration. Insert/update/delete maintenance for a record SHALL include that record's `connector_id`. Reference search results SHALL carry the indexed `connector_id` through to the `search_result.connector_id` field of the public response.

#### Scenario: Records for two connectors are indexed
- **WHEN** records arrive for stream `messages` from connectors `C1` and `C2`, both of which declare `lexical_fields: ["text"]`
- **THEN** the FTS5 lexical search index SHALL contain rows attributed to `C1` for `C1`'s records and rows attributed to `C2` for `C2`'s records
- **AND** SHALL NOT silently merge rows under a single shared connector identity

#### Scenario: A search result is attributed to its originating connector
- **WHEN** the reference returns a `search_result` to a caller
- **THEN** that result's `connector_id` SHALL be the `connector_id` recorded on the matching index row at insert time
- **AND** the reference SHALL NOT fabricate `connector_id` from configuration or from the caller's identity

### Requirement: The reference SHALL keep `/_ref/search` distinct from `/v1/search`

The reference SHALL NOT alias `/_ref/search` to `/v1/search`, SHALL NOT serve the public lexical retrieval contract from `/_ref/search`, and SHALL NOT advertise `/_ref/search` as the public lexical retrieval endpoint. The reference's source code SHALL note `/_ref/search`'s reference-only status near its handler so future readers cannot mistake it for the public surface.

#### Scenario: A client requests `/_ref/search`
- **WHEN** a client calls `/_ref/search?q=...`
- **THEN** the response SHALL be the existing reference-only spine artifact-and-id-jump shape
- **AND** the response SHALL NOT match the public `search_result` list envelope returned by `/v1/search`

#### Scenario: A reader inspects the reference source
- **WHEN** a reader reads the source for `/_ref/search` in `reference-implementation/server/index.js`
- **THEN** an inline comment SHALL identify the route as reference-only and SHALL point readers to `GET /v1/search` for the public lexical retrieval surface
