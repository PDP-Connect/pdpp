## ADDED Requirements

### Requirement: Query capability discovery is self-service

The reference RS SHALL expose a public schema/capability discovery surface that lets a bearer enumerate the queryable sources and streams visible to that bearer without relying on out-of-band connector IDs or prior stream knowledge.

#### Scenario: Owner token discovers polyfill schemas

- **WHEN** an owner-token caller requests the schema/capability discovery endpoint in polyfill mode
- **THEN** the response SHALL include the owner-visible connectors and their streams
- **AND** each stream entry SHALL include schema, query declarations, field capabilities, expansion capabilities, and freshness metadata where available
- **AND** the caller SHALL NOT need to provide a `connector_id` to discover the connector IDs.

#### Scenario: Client token discovers only grant scope

- **WHEN** a client-token caller requests the schema/capability discovery endpoint
- **THEN** the response SHALL include only the source and streams authorized by the grant
- **AND** field capabilities SHALL mark unavailable operations consistently with the per-stream metadata endpoint.

#### Scenario: Discovery uses the existing capability model

- **WHEN** the discovery endpoint reports stream field or expansion capabilities
- **THEN** those values SHALL be derived from the same manifest, grant, and metadata rules used by `GET /v1/streams/:stream`
- **AND** the implementation SHALL NOT maintain a second independent field-capability source of truth.

### Requirement: Query affordance documentation is copy-pasteable

The reference documentation SHALL provide working examples for the currently supported query affordances, including stream-scoped search filters, range-filtered record listing, aggregation calls, first `changes_since` sync, `expand[]`, and `blob_ref.fetch_url`.

#### Scenario: A caller uses the wrong search filter spelling

- **WHEN** a caller needs to filter search results to a stream
- **THEN** the documentation SHALL show the supported `streams[]` request shape
- **AND** it SHALL NOT imply that `filter[stream]` or `filter[connector_id]` are valid search filters.

#### Scenario: A caller needs attachment bytes

- **WHEN** a record includes a visible `data.blob_ref.fetch_url`
- **THEN** the documentation SHALL describe that URL as the supported byte-fetch path
- **AND** it SHALL NOT imply that attachment-specific content endpoints exist unless they are implemented and tested.
