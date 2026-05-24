## ADDED Requirements

### Requirement: Public read operations SHALL expose canonical connection identity

The reference implementation SHALL expose `connection_id` and an owner-meaningful `display_name` on grant-authorized read responses, and SHALL accept an optional `connection_id` filter on grant-authorized read inputs, so that multi-connection deployments are disambiguatable through the public read contract using the canonical public noun. `connection` is the canonical public/operator/LLM-facing noun for an owner-configured concrete data source account/device/profile.

#### Scenario: `rs.streams.list` returns per-connection entries

- **WHEN** a grant-authorized client calls `rs.streams.list` against a deployment that has more than one active connection contributing to a stream under the caller's grant
- **THEN** the response SHALL include one entry per (stream, connection_id) pair
- **AND** each entry SHALL include `connection_id` and an owner-meaningful `display_name`
- **AND** single-connection deployments SHALL preserve their current entry shape with `connection_id` and `display_name` populated from the sole active connection.

#### Scenario: Read operations accept an optional connection filter

- **WHEN** a grant-authorized client calls `rs.records.list`, `rs.streams.detail`, `rs.records.detail`, `rs.search.lexical`, `rs.search.semantic`, `rs.search.hybrid`, or `rs.blobs.read` with a `connection_id` argument
- **THEN** the operation SHALL restrict its scan or lookup to records, streams, hits, or blobs from that connection
- **AND** the response SHALL carry `connection_id` on each result item so callers can attribute the data.

#### Scenario: Existing single-connection consumers are not broken

- **WHEN** a previously-deployed grant-authorized client that does not know about `connection_id` calls any read operation against a single-connection deployment
- **THEN** the operation SHALL succeed with current semantics
- **AND** the new fields on the response SHALL be additive rather than reshape existing fields.

#### Scenario: Exactly-one matching connection is auto-selected

- **WHEN** a grant-authorized client omits `connection_id` on any read operation
- **AND** the caller's grant authorizes exactly one matching connection for the addressed stream or identifier
- **THEN** the operation SHALL implicitly select that connection
- **AND** the operation SHALL NOT raise an ambiguity error.

### Requirement: Multi-connection list and search reads SHALL fan in by default

Omitting `connection_id` on a fan-in-capable read SHALL NOT raise an ambiguity error. The reference implementation SHALL return the union of records, streams, or hits across the connections the caller's grant authorizes for the addressed stream. Fan-in-capable operations are `rs.streams.list`, `rs.records.list`, `rs.streams.detail`, `rs.search.lexical`, `rs.search.semantic`, and `rs.search.hybrid`.

#### Scenario: Unfiltered records list fans in across granted connections

- **WHEN** a grant-authorized client calls `rs.records.list` for a stream that resolves to more than one connection under the caller's grant
- **AND** the client omits `connection_id`
- **THEN** the operation SHALL return the union of records across the granted connections for that stream
- **AND** each record item in the response SHALL carry `connection_id` so the caller can attribute it
- **AND** the operation SHALL NOT raise the typed `ambiguous_connection` error from connection multiplicity alone.

#### Scenario: Unfiltered search fans in across granted connections

- **WHEN** a grant-authorized client calls `rs.search.lexical`, `rs.search.semantic`, or `rs.search.hybrid` against a stream that resolves to more than one connection under the caller's grant
- **AND** the client omits `connection_id`
- **THEN** the operation SHALL return the union of hits across the granted connections for that stream
- **AND** each hit SHALL carry `connection_id`
- **AND** the operation SHALL NOT raise the typed `ambiguous_connection` error from connection multiplicity alone.

#### Scenario: Stream detail fans in across granted connections

- **WHEN** a grant-authorized client calls `rs.streams.detail` for a stream that resolves to more than one connection under the caller's grant
- **AND** the client omits `connection_id`
- **THEN** the operation SHALL return a stream view that aggregates across the granted connections
- **AND** the response SHALL identify the constituent connections via `available_connections: [{ connection_id, display_name }]`.

### Requirement: Identifier-ambiguous reads SHALL emit a typed ambiguous-connection error

The reference implementation SHALL emit a typed `ambiguous_connection` error from `rs.records.detail` and `rs.blobs.read` when the addressed record or blob identifier resolves to more than one connection under the caller's grant and the client did not pass `connection_id`. The error envelope SHALL list the candidate connections so the client can recover without an extra round trip.

#### Scenario: Record identifier resolves to multiple connections

- **WHEN** a grant-authorized client calls `rs.records.detail` for an identifier that resolves to more than one connection under the caller's grant
- **AND** the client did not pass `connection_id`
- **THEN** the operation SHALL fail with a typed `ambiguous_connection` error
- **AND** the error envelope SHALL include `available_connections: [{ connection_id, display_name }]` covering exactly the candidate connections within the caller's grant
- **AND** the error envelope SHALL carry human-readable guidance instructing the caller to retry with `connection_id`.

#### Scenario: Blob identifier resolves to multiple connections

- **WHEN** a grant-authorized client calls `rs.blobs.read` for a blob identifier that resolves to more than one connection under the caller's grant
- **AND** the client did not pass `connection_id`
- **THEN** the operation SHALL fail with a typed `ambiguous_connection` error
- **AND** the error envelope SHALL include `available_connections: [{ connection_id, display_name }]`
- **AND** the error envelope SHALL carry human-readable guidance instructing the caller to retry with `connection_id`.

#### Scenario: Read-path error is distinct from scheduler-side error

- **WHEN** a grant-authorized client triggers the new read-path `ambiguous_connection` error
- **THEN** the error SHALL be emitted by the read operation under the canonical `connection` noun
- **AND** the reference SHALL NOT alter the existing scheduler-side `ambiguous_connector_instance` behavior at `reference-implementation/runtime/controller.ts` that fires when an owner schedules a run.

### Requirement: Grant scope SHALL accept an optional connection constraint

Grant scope shapes used by grant-authorized read operations SHALL accept an optional `connection_id` per stream entry. Grants without the field SHALL preserve current cross-connection (fan-in) read semantics; grants with the field SHALL constrain disclosure to records, hits, or blobs from the named connection.

#### Scenario: Grant without connection constraint

- **WHEN** a grant scope entry for a stream omits `connection_id`
- **THEN** read operations SHALL fan in across the connections that the grant authorizes for that stream
- **AND** previously-issued grants SHALL continue to function without re-issuance.

#### Scenario: Grant with connection constraint

- **WHEN** a grant scope entry for a stream includes a `connection_id`
- **THEN** read operations under that grant SHALL only return records, hits, or blobs from the named connection for that stream
- **AND** the consent surface used to issue the grant SHALL have shown that per-connection constraint to the owner before issuance.

### Requirement: Owner-meaningful display name SHALL be owner-editable

The reference implementation SHALL provide an owner-authenticated mutation for `connection.display_name` so that the protocol-surfaced label can be edited by the owner. The mutation SHALL live on the same operator surface as the existing `ref-connectors-list` reader and SHALL NOT be reachable by grant-authorized clients.

#### Scenario: Owner renames a connection

- **WHEN** an authenticated owner submits a new `display_name` for one of their connections
- **THEN** the reference SHALL persist the new label
- **AND** subsequent `rs.streams.list` responses SHALL surface the updated `display_name`
- **AND** subsequent typed `ambiguous_connection` read-path errors SHALL list the updated `display_name` in `available_connections`.

#### Scenario: Grant-authorized client attempts to write

- **WHEN** a request bearing a grant-authorized client token attempts to invoke the `display_name` mutation
- **THEN** the reference SHALL reject the request
- **AND** the mutation SHALL NOT be advertised on grant-authorized surfaces.

### Requirement: Consent surfaces SHALL show per-connection labels and SHALL NOT leak implementation placeholders

Consent surfaces (consent card, grant request flow, and any dashboard or MCP rendering that names a connection to the owner) SHALL render each granted connection with a per-connection label sourced from `display_name`. They SHALL NOT render `legacy`, `default_account`, or any raw storage-layer placeholder as the primary label.

#### Scenario: Multi-connection grant renders distinct per-connection labels

- **WHEN** a consent card is rendered for a grant that authorizes more than one connection of the same connector type
- **THEN** the card SHALL render one scope row per connection
- **AND** each row SHALL use that connection's `display_name` as the primary label
- **AND** the rendered labels SHALL be visibly distinct from each other.

#### Scenario: Never-renamed connection renders an owner-meaningful default

- **WHEN** the reference renders `display_name` for a connection that the owner has never renamed
- **THEN** the rendered label SHALL be derived from connector type plus a stable disambiguator (for example `Gmail · account 2`)
- **AND** the rendered label SHALL NOT be `"legacy"`, `"legacy (pre-header)"`, `"default_account"`, or any raw storage-layer placeholder.

#### Scenario: No user-visible legacy or default-account text

- **WHEN** the reference renders any user-visible connection label on the consent card, the dashboard, or a grant-authorized read response
- **THEN** inherited `"legacy"`/`"legacy (pre-header)"`/`"default_account"` strings SHALL NOT appear as the rendered primary label
- **AND** the previously-shipped string at `apps/web/src/app/dashboard/components/views/deployment-diagnostics-view.tsx:94` SHALL be removed or replaced with an owner-meaningful label.

### Requirement: `connector_instance_id` SHALL be supported as a compatibility alias only

The public contract noun is `connection_id`. The reference implementation MAY accept `connector_instance_id` as a request-time alias for `connection_id` during a deprecation window, and MAY emit `connector_instance_id` alongside `connection_id` on response envelopes during the same window, so that downstream consumers can migrate without breakage. `connector_instance_id` SHALL NOT be advertised as the canonical public field name.

#### Scenario: Request supplies `connector_instance_id` only

- **WHEN** a grant-authorized client passes `connector_instance_id` (and not `connection_id`) on a read operation
- **AND** the alias is still within the deprecation window
- **THEN** the reference SHALL treat the value as if `connection_id` had been supplied with the same opaque value
- **AND** the operation SHALL succeed exactly as it would have under `connection_id`.

#### Scenario: Request supplies both fields with different values

- **WHEN** a grant-authorized client passes both `connection_id` and `connector_instance_id` on a read operation
- **AND** the two values refer to different connections
- **THEN** the reference SHALL reject the request with a typed `invalid_argument` error citing the conflicting fields.

#### Scenario: Response carries both fields during deprecation window

- **WHEN** the reference returns a read response within the `connector_instance_id` deprecation window
- **THEN** each response item SHALL carry `connection_id` as the canonical field
- **AND** each response item MAY additionally carry `connector_instance_id` with the same opaque value
- **AND** the contract documentation SHALL mark `connector_instance_id` as deprecated.

#### Scenario: Internal storage retains `connector_instance_id`

- **WHEN** the reference reads or writes connection identity in storage (`reference-implementation/server/postgres-*.js`, `connector-instance-store.js`) or in runtime/orchestrator code (`runtime/controller.ts`)
- **THEN** the storage layer and runtime MAY continue to use the column and identifier name `connector_instance_id`
- **AND** the rename to `connection_id` SHALL apply at the public contract surface only.
