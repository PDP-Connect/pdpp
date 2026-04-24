## ADDED Requirements

### Requirement: The public query surface SHALL expose a minimal connector discovery floor

The reference Resource Server SHALL expose `GET /v1/connectors` as a bearer-authenticated public query endpoint for discovering connector or source boundaries visible under the caller's token. The endpoint SHALL return a list envelope whose items identify visible connector-backed sources by `connector_id` and include stream summaries plus coarse capability hints. The endpoint SHALL NOT inline full stream schemas; callers SHALL use `GET /v1/streams/{stream}` for full source-level stream metadata.

#### Scenario: Owner discovers polyfill connectors

- **WHEN** an owner-token caller in polyfill mode requests `GET /v1/connectors`
- **THEN** the response SHALL include connector-backed sources visible to that owner token without requiring a `connector_id` query parameter
- **AND** each connector-backed item SHALL include its `connector_id`
- **AND** declared streams with no stored records SHALL remain discoverable with zero record count and unknown freshness

#### Scenario: Client discovers its granted connector

- **WHEN** a client-token caller requests `GET /v1/connectors`
- **THEN** the response SHALL include only the source bound to that active grant
- **AND** the response SHALL include only grant-authorized stream names for that source
- **AND** the response SHALL NOT expose unrelated registered connectors or streams outside the grant

#### Scenario: Discovery does not leak grant internals

- **WHEN** a client-token caller's grant narrows fields, resources, or time range
- **THEN** `GET /v1/connectors` SHALL NOT expose the grant's field list, resource list, time range, client claims, or grant identifier in the response body
- **AND** record counts and freshness SHALL remain computed under existing grant enforcement rules

#### Scenario: Discovery points to existing metadata authority

- **WHEN** a caller needs a stream schema, primary key, cursor field, relationships, views, or field-level query declarations
- **THEN** `GET /v1/connectors` SHALL provide enough stream identity and capability hints for the caller to request existing per-stream metadata
- **AND** the full metadata authority SHALL remain `GET /v1/streams/{stream}` rather than the connector discovery response
