## ADDED Requirements

### Requirement: Public read operations SHALL expose connector instance identity

The reference implementation SHALL expose `connector_instance_id` and an owner-meaningful `display_name` on grant-authorized read responses, and SHALL accept an optional `connector_instance_id` filter on grant-authorized read inputs, so that multi-instance connector deployments are disambiguatable through the public read contract without requiring access to operator-only `ref/*` surfaces.

#### Scenario: `rs.streams.list` returns per-instance entries

- **WHEN** a grant-authorized client calls `rs.streams.list` against a deployment that has more than one active connector instance contributing to a stream under the caller's grant
- **THEN** the response SHALL include one entry per (stream, connector_instance_id) pair
- **AND** each entry SHALL include `connector_instance_id` and an owner-meaningful `display_name`
- **AND** single-instance deployments SHALL preserve their current entry shape with `connector_instance_id` and `display_name` populated from the sole active instance.

#### Scenario: Read operations accept an optional instance filter

- **WHEN** a grant-authorized client calls `rs.records.list`, `rs.streams.detail`, `rs.records.detail`, `rs.search.lexical`, `rs.search.semantic`, `rs.search.hybrid`, or `rs.blobs.read` with a `connector_instance_id` argument
- **THEN** the operation SHALL restrict its scan or lookup to records, streams, or blobs from that connector instance
- **AND** omitting `connector_instance_id` against a stream that resolves to a single active instance under the caller's grant SHALL preserve current behavior.

#### Scenario: Existing single-instance consumers are not broken

- **WHEN** a previously-deployed grant-authorized client that does not know about `connector_instance_id` calls any read operation against a single-instance deployment
- **THEN** the operation SHALL succeed with current semantics
- **AND** the new fields on the response SHALL be additive rather than reshape existing fields.

### Requirement: Read operations SHALL emit a typed ambiguous-instance error

The reference implementation SHALL emit a typed `ambiguous_connector_instance` error from the read path when a grant-authorized client targets a stream that resolves to more than one active connector instance under the caller's grant and the client did not pass `connector_instance_id`. The error envelope SHALL carry the list of candidate instances so the client can recover without an extra round trip.

#### Scenario: Unconstrained multi-instance read

- **WHEN** a grant-authorized client calls `rs.records.list`, `rs.search.lexical`, `rs.search.semantic`, `rs.search.hybrid`, `rs.records.detail`, or `rs.blobs.read` against a stream that resolves to more than one active connector instance under the caller's grant
- **AND** the client did not pass `connector_instance_id`
- **THEN** the operation SHALL fail with a typed `ambiguous_connector_instance` read-path error
- **AND** the error envelope SHALL include `available_instances: [{ connector_instance_id, display_name }]` covering exactly the candidate instances within the caller's grant.

#### Scenario: Read-path error is distinct from scheduler-side error

- **WHEN** a grant-authorized client triggers the new read-path `ambiguous_connector_instance` error
- **THEN** the error SHALL be emitted by the read operation
- **AND** the reference SHALL NOT alter the existing scheduler-side `ambiguous_connector_instance` behavior at `reference-implementation/runtime/controller.ts` that fires when an owner schedules a run.

#### Scenario: Grant restricts to a single instance

- **WHEN** a grant scope entry for a stream restricts to exactly one `connector_instance_id`
- **THEN** an unconstrained read against that stream SHALL succeed against that instance without raising the typed ambiguous error
- **AND** the read SHALL NOT expose records, streams, or blobs from any other instance.

### Requirement: Grant scope SHALL accept an optional connector-instance constraint

Grant scope shapes used by grant-authorized read operations SHALL accept an optional `connector_instance_id` per stream entry. Grants without the field SHALL preserve current cross-instance read semantics; grants with the field SHALL constrain disclosure to records from the named instance.

#### Scenario: Grant without instance constraint

- **WHEN** a grant scope entry for a stream omits `connector_instance_id`
- **THEN** read operations SHALL preserve current cross-instance read semantics for that stream under that grant
- **AND** previously-issued grants SHALL continue to function without re-issuance.

#### Scenario: Grant with instance constraint

- **WHEN** a grant scope entry for a stream includes a `connector_instance_id`
- **THEN** read operations under that grant SHALL only return records, streams, or blobs from the named instance for that stream
- **AND** the consent surface used to issue the grant SHALL have shown that per-instance constraint to the owner before issuance.

### Requirement: Owner-meaningful display name SHALL be owner-editable

The reference implementation SHALL provide an owner-authenticated mutation for `connector_instance.display_name` so that the protocol-surfaced label can be edited by the owner. The mutation SHALL live on the same operator surface as the existing `ref-connectors-list` reader and SHALL NOT be reachable by grant-authorized clients.

#### Scenario: Owner renames an instance

- **WHEN** an authenticated owner submits a new `display_name` for one of their connector instances
- **THEN** the reference SHALL persist the new label
- **AND** subsequent `rs.streams.list` responses SHALL surface the updated `display_name`
- **AND** subsequent typed `ambiguous_connector_instance` read-path errors SHALL list the updated `display_name` in `available_instances`.

#### Scenario: Grant-authorized client attempts to write

- **WHEN** a request bearing a grant-authorized client token attempts to invoke the `display_name` mutation
- **THEN** the reference SHALL reject the request
- **AND** the mutation SHALL NOT be advertised on grant-authorized surfaces.

#### Scenario: No user-visible legacy fallback

- **WHEN** the reference renders `display_name` on any user-visible surface (consent card, dashboard, read response)
- **THEN** inherited `"legacy"`/`"default_account"` strings SHALL NOT appear as the rendered label
- **AND** a connector instance that has never been renamed by the owner SHALL render an owner-meaningful default derived from connector type plus a stable disambiguator rather than the pre-instance legacy string.
