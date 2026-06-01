## ADDED Requirements

### Requirement: `GET /v1/schema` SHALL offer an additive compact view

The reference implementation SHALL expose an additive, opt-in compact projection
of the `rs.schema.get` response on `GET /v1/schema`, selected by `view=compact`,
optionally scoped to a single stream by `stream=<name>`. The compact view SHALL
materially reduce the response size while preserving the identity an owner-agent
REST client needs to continue the `list_streams -> schema(stream) ->
query_records` discovery path. The full body SHALL remain the default. The
compact view SHALL NOT be the default in this capability and SHALL NOT alter
grant evaluation, visibility, connection identity, or the deprecated
`connector_instance_id` alias.

#### Scenario: Omitted view preserves the full body

- **WHEN** a caller requests `GET /v1/schema` without a `view` parameter
- **THEN** the response SHALL be the exhaustive `rs.schema.get` body, byte-for-byte equivalent to the prior behavior, including the raw per-stream and per-field JSON Schema
- **AND** the response SHALL NOT carry a `detail: "compact"` marker

#### Scenario: Compact view returns a smaller identity-preserving projection

- **WHEN** a caller requests `GET /v1/schema?view=compact`
- **THEN** the response SHALL preserve the envelope shape (`object: "schema"`, `bearer`, `connectors[]`) and carry a top-level `detail: "compact"` marker
- **AND** each stream SHALL preserve its stream identity (`name`)
- **AND** the per-connection identity (`granted_connections[].{connection_id, display_name}`, and the deprecated `connector_instance_id` alias where exposed) for every granted connection SHALL remain resolvable for each stream, whether carried at the connector level or as a per-stream override (see the connection de-duplication scenario)
- **AND** each field of `field_capabilities` SHALL be projected to a single terse capability-flag string carrying its declared type, non-default grant flag, and usable filter/search/aggregation flags
- **AND** the response SHALL NOT include the raw per-stream JSON Schema or the raw per-field JSON Schema
- **AND** the response MAY omit route-unneeded telemetry such as per-stream object markers and freshness timestamps when that telemetry is available from list or health surfaces
- **AND** the projected body SHALL be materially smaller than the full body for a schema document carrying verbose per-field JSON Schema

#### Scenario: Connection identity is de-duplicated to the connector level

The native `rs.schema.get` body attaches the same `granted_connections` array to
every stream of a connector. Repeating that array per stream caused a real
owner grant with many connections to exceed the compact byte budget (a
19-connection grant repeated its connection list once per stream). The compact
view SHALL de-duplicate it without losing per-stream connection truth.

- **WHEN** the compact view projects a connector whose streams share an identical `granted_connections` set
- **THEN** the shared set SHALL be emitted once as the connector-level `granted_connections`, and the per-stream `granted_connections` SHALL be omitted on streams that carry the shared set
- **AND** a stream whose `granted_connections` diverges from the shared set (e.g. a grant pinning a connection subset for that stream) SHALL retain its own `granted_connections`
- **AND** the connection set an agent resolves for any stream SHALL equal the stream's own `granted_connections` when present, otherwise the connector-level `granted_connections`
- **AND** the compact all-stream and single-stream views SHALL stay under their documented byte budgets for a grant with at least 19 connections across multiple streams

#### Scenario: Compact field flags omit default-positive noise

The compact view is meant for agent discovery under tight token budgets. It
SHALL NOT repeat verbose positive defaults for every field when a shorter form
preserves the same information.

- **WHEN** the compact view projects a granted field
- **THEN** the field flag string SHALL carry the declared type using the compact `t=<type>` spelling
- **AND** `granted=true` SHALL be implicit and omitted
- **AND** an ungranted field SHALL instead carry an explicit `g=false` flag
- **AND** usable capabilities SHALL use compact spellings for exact, range, lexical, semantic, and aggregation capability bits

#### Scenario: Compact view scoped to a single stream

- **WHEN** a caller requests `GET /v1/schema?view=compact&stream=<name>`
- **THEN** the response SHALL include only connectors that contribute the named stream, and within each such connector only the named stream
- **AND** each surviving connector's `stream_count` SHALL equal the number of streams it contributes after scoping
- **AND** the per-field capability flags SHALL remain present on the scoped stream

#### Scenario: Unknown stream scope is empty, not an error

- **WHEN** a caller requests `GET /v1/schema?view=compact&stream=<name>` for a stream no granted connector exposes
- **THEN** the response SHALL be a successful compact schema body with an empty `connectors` array
- **AND** the response SHALL NOT be an error

#### Scenario: Compact projection is a route-level down-projection

- **WHEN** the compact view is produced
- **THEN** it SHALL be a pure transform applied to the response the canonical `rs.schema.get` operation already produced, after the operation runs and before envelope finalization
- **AND** it SHALL NOT recompute visibility, grant scope, or disclosure totals
- **AND** it SHALL NOT change the `@pdpp/reference-contract` request/response schemas, the OpenAPI document, or generated contract artifacts
