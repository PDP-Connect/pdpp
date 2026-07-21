## ADDED Requirements

### Requirement: Active-run storage conformance SHALL reject overwrite-on-conflict

The reference implementation SHALL keep reusable conformance coverage for the
active-run registry so a candidate driver cannot silently replace an incumbent
live row during duplicate admission.

#### Scenario: Duplicate admission does not win by upsert

- **WHEN** a candidate active-run persistence driver is evaluated
- **THEN** a second insert for the same `connector_instance_id` SHALL either
  fail or no-op
- **AND** it SHALL NOT replace the incumbent row as the durable active run
- **AND** the original live row SHALL remain intact
