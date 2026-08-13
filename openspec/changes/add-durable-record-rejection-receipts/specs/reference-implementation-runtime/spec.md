## MODIFIED Requirements

### Requirement: Runtime SHALL maintain checkpointed streaming integrity
The reference runtime SHALL stream records to the resource server in batches, flush a stream before staging that stream's `STATE`, and commit staged state only after terminal validation succeeds and state persistence is enabled. A hosted batch SHALL be progress-complete only when every submitted record is durably accepted or has a complete durable rejection receipt from the admitted destination. The runtime SHALL validate balanced attempted, accepted, and rejected counts and exactly one unique in-range input-index entry per rejected record before clearing the batch or staging later state; duplicate exact inputs MAY share a receipt id. The reference runtime SHALL NOT commit staged state when a run is cancelled. When a record-batch ingest is rejected as `not_found` for a stream that is present in the run's START scope, the reference runtime SHALL treat it as a transient per-stream gap rather than a terminal run failure: it SHALL NOT stage or commit that stream's cursor, it SHALL record a transient known gap and a stream-skipped timeline event for that stream, and it SHALL continue collecting and committing the run's other in-scope streams.

#### Scenario: Successful persistent run
- **WHEN** a connector emits scoped records, scoped state, and `DONE status="succeeded"` with a matching `records_emitted` count and compatible exit code
- **AND** every submitted record is durably accepted or represented by a complete durable rejection receipt
- **THEN** the reference runtime SHALL flush buffered records
- **AND** it SHALL persist staged state for each staged stream
- **AND** it SHALL report a checkpoint summary with `commit_status: "committed"`

#### Scenario: State persistence is disabled
- **WHEN** a connector run starts with `persistState` disabled
- **THEN** the reference runtime SHALL send `START.state` as null
- **AND** it SHALL NOT persist staged state
- **AND** it SHALL report a checkpoint summary with `commit_status: "disabled"`

#### Scenario: Checkpoint commit partially fails
- **WHEN** record ingest succeeds but committing one or more staged stream states fails after terminal success
- **THEN** the reference runtime SHALL fail the run as a runtime error
- **AND** it SHALL report how many state streams were staged and committed
- **AND** it SHALL include a known gap for the partial or missing checkpoint commit

#### Scenario: Terminal validation fails
- **WHEN** terminal exit code or `DONE.records_emitted` validation fails
- **THEN** the reference runtime SHALL fail the run as a connector protocol violation
- **AND** it SHALL report observed and reported record counts when they differ
- **AND** it SHALL NOT commit staged state

#### Scenario: Run is cancelled before terminal success
- **WHEN** a run is cancelled and its connector child exits without emitting `DONE status="succeeded"`
- **THEN** the reference runtime SHALL preserve records already flushed to the resource server
- **AND** it SHALL NOT commit staged cursor state for that run

#### Scenario: Permanent rejection receipts are complete
- **WHEN** a hosted batch response balances every attempted record as accepted or rejected and provides one valid durable receipt for each rejected input index
- **THEN** the runtime MAY clear that batch and stage later state
- **AND** it SHALL count rejected records separately from accepted records

#### Scenario: Permanent rejection receipts are incomplete or malformed
- **WHEN** a hosted batch response has unbalanced counts, a missing or duplicate input-index entry, an out-of-range input index, or a receipt-entry count different from `records_rejected`
- **THEN** the runtime SHALL fail the run as an invalid ingest response
- **AND** it SHALL NOT clear the batch, stage that stream's later state, or commit that stream's cursor

#### Scenario: Ingest is rejected as not_found for a stream in the run's START scope
- **WHEN** a record-batch ingest returns HTTP 404 `not_found` for a stream that is present in the run's START scope
- **THEN** the reference runtime SHALL NOT fail the run for that rejection
- **AND** it SHALL drop that stream's buffered batch without treating it as flushed
- **AND** it SHALL NOT stage or commit that stream's cursor, so a later run re-collects it
- **AND** it SHALL record a transient known gap and a `run.stream_skipped` timeline event for that stream
- **AND** it SHALL continue to collect, flush, and commit the run's other in-scope streams

#### Scenario: Ingest is rejected for a reason other than a scope-stream not_found
- **WHEN** a record-batch ingest is rejected with any status other than a 404 `not_found`, or with a `not_found` for a stream not present in the run's START scope
- **THEN** the reference runtime SHALL fail the run as it does today
- **AND** it SHALL NOT reclassify the rejection as a transient per-stream gap

#### Scenario: Device-exporter batch uses the existing contract
- **WHEN** a local device-exporter ingest encounters a per-record defect in this tranche
- **THEN** it SHALL retain its current all-or-retry and checkpoint-blocking behavior
- **AND** it SHALL NOT infer hosted rejection-receipt semantics from this reference-only hosted contract

### Requirement: Runtime SHALL account for hosted ingest outcomes honestly
Runtime progress, batch timeline events, terminal events, and run history SHALL distinguish connector-emitted records, ingest attempts, acceptances confirmed by complete successful responses, durable permanent rejections confirmed by receipts, and epistemically unresolved retryable records. A submitted or permanently rejected record SHALL NOT be labeled flushed or accepted. Attempted SHALL equal confirmed accepted plus receipt-backed permanently rejected plus unresolved retryable records at each terminal boundary. When transport fails before a complete response, the runtime SHALL conservatively count that batch as unresolved even if the server may already have committed prefix effects.

#### Scenario: Successful run contains permanent rejections
- **WHEN** a run commits progress after one or more records receive durable rejection receipts
- **THEN** its terminal evidence SHALL report those records as permanently rejected and recoverable from quarantine
- **AND** accepted-record totals SHALL exclude them

#### Scenario: Batch fails after partial durable effects
- **WHEN** a hosted ingest attempt durably accepts or quarantines some records and then returns a retryable systemic failure
- **THEN** runtime evidence SHALL classify the batch as epistemically unresolved unless a complete successful response confirmed individual outcomes
- **AND** server-side quarantine evidence SHALL remain independently inspectable for any committed rejection receipts
- **AND** the runtime SHALL NOT commit the stream cursor for that failed run
