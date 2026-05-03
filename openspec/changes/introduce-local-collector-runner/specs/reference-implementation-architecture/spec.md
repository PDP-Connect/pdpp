## ADDED Requirements

### Requirement: Local collector execution remains reference-control-plane behavior

The reference implementation SHALL treat local collector execution as a reference/control-plane collection path, not as PDPP Core Resource Server behavior. Collector enrollment, heartbeat, run execution, upload, diagnostics, and revocation SHALL remain outside the Resource Server read/query surface unless a future Collection Profile explicitly standardizes them.

#### Scenario: A connector requires local execution

- **WHEN** a connector requires a browser, local filesystem, local device state, or owner-assisted runtime capability that the provider/control-plane runtime does not advertise
- **THEN** the reference SHALL NOT run that connector inside the Resource Server
- **AND** it SHALL place the connector in an eligible local collector runtime or fail before spawn with an actionable runtime capability diagnostic

#### Scenario: A clean API connector is eligible for provider execution

- **WHEN** a connector's declared requirements are satisfied by the provider/control-plane runtime
- **THEN** the reference MAY run the connector in that provider/control-plane runtime without requiring a local collector
- **AND** Resource Server reads SHALL continue to operate only over records already accepted into storage

#### Scenario: Collection Profile semantics are not frozen

- **WHEN** the reference exposes collector enrollment, heartbeat, upload, or diagnostics before Collection Profile normativity is settled
- **THEN** the reference SHALL label those surfaces as reference/control-plane behavior
- **AND** it SHALL NOT describe them as PDPP Core requirements

### Requirement: Runtime capability advertisement gates connector spawn

The reference implementation SHALL compare connector runtime requirements against runtime-advertised capabilities before spawning connector code. Missing required capabilities SHALL produce typed diagnostics before connector execution starts.

#### Scenario: A required binding is absent

- **WHEN** a connector declares a required runtime binding and the selected runtime does not advertise that binding
- **THEN** the reference SHALL fail the run before spawn
- **AND** it SHALL record a diagnostic that names the missing capability without exposing credentials or owner data

#### Scenario: Placement is derived from existing semantics

- **WHEN** the reference decides whether a connector can run in the provider/control-plane runtime or local collector runtime
- **THEN** it SHALL derive that decision from connector requirements and runtime capabilities
- **AND** it SHALL NOT require a broad, manually-maintained runtime-mode taxonomy unless existing primitives prove insufficient

### Requirement: Local collector credentials are device-scoped

The reference implementation SHALL reuse the device-scoped credential boundary for local collector upload and heartbeat. Collector credentials SHALL NOT substitute for owner tokens or client grant tokens.

#### Scenario: A collector uploads data

- **WHEN** a local collector submits records, blobs, run events, diagnostics, or heartbeat data
- **THEN** the reference SHALL authenticate it with a device-scoped credential
- **AND** that credential SHALL NOT authorize record reads, consent approval, grant issuance, owner-token minting, or mutation of unrelated devices

