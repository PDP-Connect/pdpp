## ADDED Requirements

### Requirement: Local collector runs replay prior connector state through START

The reference implementation SHALL load any prior persisted state for a local collector run before spawning the connector child, and SHALL pass it through the existing `StartMessage.state` field. State load SHALL use the device-scoped credential, scoped by `(deviceId, sourceInstanceId)`.

#### Scenario: A local collector starts with prior state

- **WHEN** the local collector runner spawns a connector child for a device-scoped source instance that has previously persisted state
- **THEN** the runner SHALL fetch that state with its device-scoped credential
- **AND** it SHALL set `StartMessage.state` to the fetched state map before writing `START` to the child
- **AND** the child SHALL NOT need to read state from any other surface

#### Scenario: A local collector starts with no prior state

- **WHEN** the local collector runner spawns a connector child for a source instance with no persisted state
- **THEN** the server SHALL respond to the state read with an empty map
- **AND** the runner SHALL omit `state` from the `START` message
- **AND** the child SHALL behave as if this is a first run

#### Scenario: State read fails

- **WHEN** the local collector runner cannot read prior state because of a network, credential, or server error
- **THEN** the runner SHALL NOT spawn the connector child
- **AND** it SHALL emit a heartbeat with `status: "blocked"` indicating a state-read failure
- **AND** it SHALL exit non-zero

### Requirement: Local collectors persist emitted STATE after records are durably accepted

The reference implementation SHALL persist emitted `STATE` messages from a local collector child only after the records that justify that state are durably accepted by the server.

#### Scenario: All record batches are accepted in a pass

- **WHEN** a local collector child emits `RECORD` messages and one or more `STATE` messages, and all enqueued record batches drain successfully via the existing device ingest path
- **THEN** the collector runner SHALL flush the accumulated `STATE` map to the device-scoped state endpoint once
- **AND** the persisted state SHALL be the per-stream last-wins projection of the emitted `STATE` messages during that pass

#### Scenario: Some record batches fail to drain in a pass

- **WHEN** a local collector child emits `RECORD` and `STATE` messages but the queue still contains unsent record batches at end-of-pass
- **THEN** the runner SHALL NOT advance persisted state for any stream in that pass
- **AND** the previously persisted state SHALL remain authoritative

#### Scenario: A STATE write fails after records were accepted

- **WHEN** record batches drain successfully but the state `PUT` fails
- **THEN** the runner SHALL surface that failure in its heartbeat
- **AND** the next run SHALL re-emit records that the previous pass already considered consumed
- **AND** ingest idempotency SHALL absorb the duplicates without doubling records in storage

#### Scenario: STATE arrives for an out-of-scope stream

- **WHEN** a local collector child emits `STATE` for a stream that was not in `START.scope.streams`
- **THEN** the runner SHALL drop that `STATE` message
- **AND** it SHALL emit a runtime warning identifying the offending stream

### Requirement: Local collector state is device-scoped, source-instance-isolated, and reference-only

The reference implementation SHALL expose local collector state read and write through the device-exporter authority, scoped by `(deviceId, sourceInstanceId)`. Owner-token and client-token routes SHALL NOT accept device credentials, and the device-scoped state route SHALL NOT accept owner or client credentials.

#### Scenario: A device reads or writes its own source-instance state

- **WHEN** a local collector presents a valid device-scoped credential to `GET /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state` or `PUT /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state`, with a path `deviceId` matching the credential and a registered `sourceInstanceId`
- **THEN** the reference implementation SHALL serve or persist the state map keyed under the same internal storage connector id used for device record ingest for that source instance
- **AND** that state SHALL NOT collide with state persisted under the public connector id for owner-authenticated runs of the same connector

#### Scenario: Cross-device or cross-credential request

- **WHEN** a caller presents a device-scoped credential to a state route for a different device's id, an unknown source instance, or presents an owner or client bearer token to the device-scoped state route
- **THEN** the reference implementation SHALL reject the request without revealing state

#### Scenario: Owner-authenticated state route is unaffected

- **WHEN** an owner or client interacts with the existing `GET /v1/state/:connectorId` route or `PUT /v1/state/:connectorId` route
- **THEN** that route SHALL continue to operate keyed by `(connectorId, grantId)` with owner authentication
- **AND** it SHALL NOT serve or accept device-scoped state rows
