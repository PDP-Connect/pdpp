## ADDED Requirements

### Requirement: Runtime SHALL enforce the `resources` filter on every RECORD
The polyfill runtime SHALL reject any RECORD whose key is not in the grant's declared `resources` set for that stream, if the set is non-empty.

#### Scenario: Connector emits a record outside the declared resources set
- **WHEN** a connector emits a RECORD whose `key` is not present in `START.scope.streams[].resources`
- **THEN** the runtime SHALL raise a protocol violation and terminate the run
- **AND** the error SHALL name the offending stream and key

#### Scenario: Empty resources set is a no-op
- **WHEN** `START.scope.streams[].resources` is absent or empty
- **THEN** the runtime SHALL NOT filter records by key for that stream

### Requirement: Runtime SHALL expose a `filesystem` binding for local-file connectors
The polyfill runtime SHALL include a `filesystem` binding in `buildAvailableBindings` so connectors that parse local files (e.g. Claude Code sessions, Codex rollouts, iMessage sqlite, WhatsApp exports) satisfy their `runtime_requirements.bindings.filesystem.required: true` declaration.

#### Scenario: File-based connector starts successfully
- **WHEN** a manifest declares `runtime_requirements.bindings.filesystem.required: true` and the runtime spawns the connector
- **THEN** the runtime SHALL treat `filesystem` as available
- **AND** the connector SHALL NOT fail with "Runtime cannot satisfy required binding: filesystem"

### Requirement: Connectors SHALL emit tombstones for mutable_state streams that expose deletion
When a source platform exposes a "deleted" signal on a stream whose `semantics` is `mutable_state`, the connector SHALL emit a RECORD with `op: "delete"` for the tombstoned key.

#### Scenario: Mutable-state deletion
- **WHEN** the upstream reports that a record has been deleted (e.g. YNAB `deleted: true`, Notion archived page, Pocket `status: 2`, Gmail EXPUNGE)
- **THEN** the connector SHALL emit `{type: "RECORD", stream, key, op: "delete"}`
- **AND** the runtime SHALL persist the tombstone so downstream consumers can observe the deletion

#### Scenario: Append-only streams
- **WHEN** a stream's `semantics` is `append_only`
- **THEN** the connector SHALL NOT emit tombstones (there is no deletion on append-only data)

### Requirement: Connectors SHALL request credentials via INTERACTION when missing
When a connector starts and required credentials are absent from its environment, the connector SHALL emit `INTERACTION kind: "missing_credentials"` rather than failing silently.

#### Scenario: Missing credentials with interactive binding
- **WHEN** a connector is spawned with `interactive: {}` in its bindings and its required credentials env vars are unset
- **THEN** the connector SHALL emit an INTERACTION with `kind: "missing_credentials"` and a human-readable `message` explaining which env vars are needed
- **AND** the runtime SHALL park the run until the interaction is answered or the grant expires

#### Scenario: Missing credentials without interactive binding
- **WHEN** a connector is spawned without `interactive: {}` and credentials are missing
- **THEN** the connector SHALL emit DONE with status `failed` and an error message naming the missing credentials
- **AND** the run SHALL NOT hang waiting for an unavailable interaction channel

### Requirement: Connectors SHALL drain stdout before exiting
Connectors SHALL call a `flushAndExit(code)` helper (or equivalent) that waits for the Node stdout `drain` event before invoking `process.exit`, with a bounded safety timeout.

#### Scenario: Final DONE message on a pipe
- **WHEN** a connector emits its terminal DONE and then exits
- **THEN** the stdout pipe to the runtime SHALL NOT be closed before the final newline-delimited message is flushed
- **AND** the runtime SHALL observe a well-formed DONE (no truncation, no "Unterminated string in JSON" parser error)

#### Scenario: Safety timeout
- **WHEN** the stdout drain never fires (e.g. consumer died)
- **THEN** the connector SHALL exit after a bounded timeout (≤ 3 seconds) rather than hanging indefinitely
