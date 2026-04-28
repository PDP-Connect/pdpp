## MODIFIED Requirements

### Requirement: Native and polyfill realizations stay honest
The reference implementation SHALL support both native-provider and polyfill realizations over one engine substrate while keeping their public source identity honest. Public artifacts SHALL identify the data source with a single discriminated **source object** of shape `{ kind: 'connector' | 'provider_native', id: string }` rather than with parallel top-level `connector_id` and `provider_id` scalars. The kind discriminator names the realization; the `id` field carries the kind-keyed identifier (a registered connector id when `kind = 'connector'`, a registered native provider id when `kind = 'provider_native'`).

#### Scenario: A native provider request is staged
- **WHEN** a client requests data from a native provider realization
- **THEN** the public request and public artifacts SHALL identify that source with a source object whose `kind` is `provider_native` and whose `id` is the configured native provider id
- **AND** the public artifacts SHALL NOT carry a top-level `provider_id` scalar or a top-level `connector_id` scalar alongside the source object

#### Scenario: A polyfill request is staged
- **WHEN** a client requests data from a connector-based or collected realization
- **THEN** the public request and public artifacts SHALL identify that source with a source object whose `kind` is `connector` and whose `id` is the registered connector identifier
- **AND** the public artifacts SHALL NOT carry a top-level `provider_id` scalar or a top-level `connector_id` scalar alongside the source object

#### Scenario: Source object rejects mixed shapes
- **WHEN** a public request body, grant, or spine event payload presents both a top-level `connector_id` scalar and a top-level `provider_id` scalar, or presents either of those scalars alongside a source object
- **THEN** the reference SHALL reject the artifact with an `invalid_request` (for staged requests) or `grant_invalid` (for grants) error whose message names the canonical source-object shape

#### Scenario: Internal storage remains connector-shaped
- **WHEN** the implementation needs connector-shaped or storage-specific internal identifiers
- **THEN** those identifiers MAY remain internal implementation details, but they SHALL not leak into native-provider public artifacts unless explicitly documented as reference-only internals

#### Scenario: Native mode is configured
- **WHEN** the reference implementation starts in native-provider mode
- **THEN** the native manifest SHALL include explicit native provider identity and structured `storage_binding`
- **AND** startup SHALL derive the public source-object identity (`kind = 'provider_native'`, `id = <native provider id>`) and the internal storage binding from that manifest rather than from separate native override flags

#### Scenario: Reference-only event-spine rows expose the source object
- **WHEN** a reference-only spine reader returns spine event rows
- **THEN** each row SHALL carry the source object as `source_kind` and `source_id` columns whose values match the source object inside the row's payload
- **AND** the legacy top-level `provider_id` column SHALL NOT appear in the row shape

### Requirement: The public query surface SHALL expose a minimal connector discovery floor

The reference Resource Server SHALL expose `GET /v1/connectors` as a bearer-authenticated public query endpoint for discovering source boundaries visible under the caller's token. The endpoint SHALL return a list envelope whose items identify each visible source by a source object of shape `{ kind, id }` and include stream summaries plus coarse capability hints. Polyfill-source items MAY additionally carry the legacy `connector_id` field as a kind-keyed alias of `source.id` for migration ergonomics, but SHALL always carry the canonical source object. The endpoint SHALL NOT inline full stream schemas; callers SHALL use `GET /v1/streams/{stream}` for full source-level stream metadata.

#### Scenario: Owner discovers polyfill connectors
- **WHEN** an owner-token caller in polyfill mode requests `GET /v1/connectors`
- **THEN** the response SHALL include connector-backed sources visible to that owner token without requiring a `connector_id` query parameter
- **AND** each connector-backed item SHALL include a source object whose `kind` is `connector` and whose `id` is the connector identifier
- **AND** declared streams with no stored records SHALL remain discoverable with zero record count and unknown freshness

#### Scenario: Client discovers its granted source
- **WHEN** a client-token caller requests `GET /v1/connectors`
- **THEN** the response SHALL include only the source bound to that active grant, identified by the canonical source object
- **AND** the response SHALL include only grant-authorized stream names for that source
- **AND** the response SHALL NOT expose unrelated registered sources or streams outside the grant

#### Scenario: Discovery does not leak grant internals
- **WHEN** a client-token caller's grant narrows fields, resources, or time range
- **THEN** `GET /v1/connectors` SHALL NOT expose the grant's field list, resource list, time range, client claims, or grant identifier in the response body
- **AND** record counts and freshness SHALL remain computed under existing grant enforcement rules

#### Scenario: Discovery points to existing metadata authority
- **WHEN** a caller needs a stream schema, primary key, cursor field, relationships, views, or field-level query declarations
- **THEN** `GET /v1/connectors` SHALL provide enough source identity and capability hints for the caller to request existing per-stream metadata
- **AND** the full metadata authority SHALL remain `GET /v1/streams/{stream}` rather than the connector discovery response

#### Scenario: Native discovery names the provider source
- **WHEN** an owner-token or client-token caller queries `GET /v1/connectors` against a resource server configured with a native manifest
- **THEN** the response item for the native source SHALL carry a source object whose `kind` is `provider_native` and whose `id` is the configured native provider id
- **AND** the response SHALL NOT carry a top-level `connector_id` field for that item
