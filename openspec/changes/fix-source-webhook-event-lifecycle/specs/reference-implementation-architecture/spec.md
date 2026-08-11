## MODIFIED Requirements

### Requirement: Source webhook ingress prevents replay before mutation

The reference implementation SHALL authenticate and fully validate the deterministic source-webhook payload shape before acquiring event execution state. It SHALL persist source-webhook execution state keyed by `(source_id, event_id)` and bind that state to the authenticated body hash. The persistence layer SHALL make acquisition and every processing-to-terminal or processing-to-retryable transition atomic on both supported storage backends.

An event execution record SHALL distinguish at least `processing`, `completed`, and retryable failed work. Processing ownership SHALL be bounded by a durable lease or equivalent fencing token. An expired processing record and a failed record with the same body hash SHALL be reacquirable; a completed record with the same body hash SHALL remain a non-mutating duplicate. A callback that reuses `(source_id, event_id)` with a different authenticated body hash SHALL fail with `409 event_id_payload_conflict` and SHALL NOT invoke ingest, scheduling, or a controller run.

The reference SHALL not claim exactly-once execution across durable webhook state and connector-run dispatch. Before a failed or expired `schedule_run` event is retried, the controller boundary SHALL durably deduplicate the source event and return the same dispatch result for a replay.

#### Scenario: A new event is received
- **WHEN** an authenticated, fully valid source webhook event has no prior execution record
- **THEN** the reference SHALL atomically create processing ownership before the action begins
- **AND** only the owner SHALL invoke ingest or run dispatch

#### Scenario: A deterministic invalid payload is rejected
- **WHEN** an authenticated source webhook payload has an unsupported action, no non-empty ingest stream, or non-array ingest records
- **THEN** the reference SHALL return `400 invalid_payload`
- **AND** it SHALL NOT create or consume source-webhook execution state

#### Scenario: A duplicate source event is received
- **WHEN** an authenticated source webhook event has a completed record with the same `(source_id, event_id, body_hash)`
- **THEN** the reference SHALL return HTTP 202 with `{ "accepted": true, "duplicate": true, "source_id": "...", "event_id": "..." }`
- **AND** it SHALL NOT reapply record mutations or run dispatch

#### Scenario: An event ID is reused for a different body
- **WHEN** an authenticated source webhook callback uses an existing `(source_id, event_id)` with a different body hash
- **THEN** the reference SHALL return HTTP 409 with error code `event_id_payload_conflict`
- **AND** it SHALL NOT report the request as a duplicate

#### Scenario: Ingest fails after acquisition
- **WHEN** a processing `ingest_records` event fails before its completion transition
- **THEN** the reference SHALL persist a retryable outcome without deleting the event record
- **AND** a later same-body delivery SHALL reacquire the event and re-enter the existing record-ingest path

#### Scenario: Processing ownership expires
- **WHEN** a same-body source webhook delivery observes a processing record whose lease has expired
- **THEN** exactly one concurrent delivery SHALL atomically acquire the next processing ownership
- **AND** a terminal transition from the expired owner SHALL NOT overwrite the newer ownership

#### Scenario: A schedule-run delivery has an uncertain dispatch outcome
- **WHEN** a `schedule_run` event's controller dispatch cannot be confirmed as completed or absent
- **THEN** the reference SHALL retain processing state until a durable controller source-event receipt resolves the outcome
- **AND** it SHALL NOT create a second controller run merely because the webhook lease expired

#### Scenario: Controller replays a source-event dispatch receipt
- **WHEN** the controller receives the same authenticated `(source_id, event_id, body_hash)` and resolved owner, connector, connector-instance, and action identity after an earlier durable admission
- **THEN** it SHALL return the original run and trace handle
- **AND** it SHALL NOT create a second durable active-run admission, including after the original active-run row was cleared at terminal cleanup
- **AND** it SHALL reject a same-key request whose body hash or resolved dispatch identity differs
