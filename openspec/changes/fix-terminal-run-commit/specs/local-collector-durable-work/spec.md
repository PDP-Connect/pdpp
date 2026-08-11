## MODIFIED Requirements

### Requirement: Local collector checkpoints are destination-confirmed

The reference implementation SHALL advance local collector checkpoints only after the server durably accepts the records and gap metadata that justify the checkpoint. Source-observed cursors and connector-emitted `STATE` messages SHALL be treated as staged progress until destination acknowledgement completes. When a successful terminal run has per-stream terminal facts, the checkpoint vector and those facts SHALL be submitted as one durable terminal run commit; the checkpoint vector SHALL NOT become committed independently of that run commit.

#### Scenario: Records are accepted and checkpoint state is pending

- **WHEN** a local collector emits records, terminal facts, and a checkpoint vector for the same source-instance run
- **AND** the server acknowledges the records and any gap metadata that justify that run
- **THEN** the reference implementation MAY commit the checkpoint vector only through the terminal run commit
- **AND** it SHALL keep the terminal run commit retryable until the reference acknowledges it.

#### Scenario: Records are not accepted

- **WHEN** a local collector emits records and checkpoint state but the server does not acknowledge the records or gap metadata that justify that checkpoint
- **THEN** the reference implementation SHALL NOT advance the committed checkpoint past those unacknowledged effects
- **AND** a later execution SHALL be able to replay or repair that boundary.

#### Scenario: Terminal acknowledgement is lost

- **WHEN** the reference may have committed a terminal run commit but the collector does not receive its acknowledgement
- **THEN** the collector SHALL retry the durable commit with its original idempotency identity
- **AND** it SHALL NOT re-scan solely to recreate terminal facts.
