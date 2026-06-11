## ADDED Requirements

### Requirement: Stream definitions SHALL be reusable across acquisition paths without weakening connection identity

The reference implementation SHALL allow multiple connector types, setup methods, or acquisition paths to emit records for the same normalized stream definition when the stream semantics and record shape match. Record storage, runtime state, schedules, diagnostics, and grant-safe read attribution SHALL remain scoped to `connection_id` / `connector_instance_id`, not to the acquisition path alone.

Multiple acquisition paths MAY populate the same logical connection only when an explicit source-identity rule proves they represent the same owner source or account. Without that proof, the paths SHALL remain separate connections that may share stream definitions.

Acquisition-path metadata SHALL be treated as provenance in source binding, run, coverage, or record metadata. It SHALL NOT replace `connection_id` as the public read-surface source identity and SHALL NOT require clients to use a path selector for normal reads.

#### Scenario: API and import paths share a stream definition

- **WHEN** an API-backed connector and an import connector both emit a normalized stream with the same semantics and record shape
- **THEN** the reference SHALL allow both connections to advertise and collect that stream definition
- **AND** records from each path SHALL remain separated by their own `connection_id` unless an explicit source-identity rule links them.

#### Scenario: Path identity is not proven

- **WHEN** one acquisition path is based on an owner-provided export file and another path is based on provider OAuth
- **THEN** the reference SHALL NOT silently merge those paths into one connection
- **AND** owner and read surfaces SHALL continue to attribute records to the connection that collected or imported them.

#### Scenario: Path identity is proven later

- **WHEN** a later accepted change defines and implements a source-identity rule proving two acquisition paths represent the same owner source
- **THEN** those paths MAY write through one logical connection
- **AND** run and coverage metadata SHALL still preserve which acquisition path produced each batch or known gap.

#### Scenario: Client reads shared stream names

- **WHEN** a grant-authorized client reads or searches a stream name that appears under multiple connections
- **THEN** the response SHALL expose grant-safe connection attribution
- **AND** the client SHALL be able to disambiguate by `connection_id` without knowing acquisition-path internals.
