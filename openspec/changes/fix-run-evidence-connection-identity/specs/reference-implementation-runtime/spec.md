## MODIFIED Requirements

### Requirement: Runtime run evidence SHALL carry connection identity when known

Runtime-authored run events SHALL preserve the public source object as `{ kind: "connector", id: <connector_id> }`. When a run is launched for a concrete connector instance, runtime-authored run events SHALL also carry the resolved connection identity as `connection_id` and `connector_instance_id` in event data so reference read models can correlate the run to the addressed connection without changing public source semantics.

#### Scenario: Connection-scoped run emits attributable evidence

- **WHEN** the controller launches a run for connector `github` and connection `cin_personal`
- **THEN** runtime-authored run lifecycle evidence SHALL include `source: { kind: "connector", id: "github" }`
- **AND** it SHALL include `connection_id: "cin_personal"` and `connector_instance_id: "cin_personal"`.

#### Scenario: Connector-wide legacy run remains connector-scoped

- **WHEN** a run is emitted without a concrete connector instance
- **THEN** the runtime MAY omit `connection_id` and `connector_instance_id`
- **AND** the public source object SHALL remain connector-scoped.
