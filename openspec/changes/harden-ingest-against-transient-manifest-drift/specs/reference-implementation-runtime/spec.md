## MODIFIED Requirements

### Requirement: Runtime SHALL maintain checkpointed streaming integrity
The reference runtime SHALL stream records to the resource server in batches, flush a stream before staging that stream's `STATE`, and commit staged state only after terminal validation succeeds and state persistence is enabled. The reference runtime SHALL NOT commit staged state when a run is cancelled. When a record-batch ingest is rejected as `not_found` for a stream that is present in the run's START scope, the reference runtime SHALL treat it as a transient per-stream gap rather than a terminal run failure: it SHALL NOT stage or commit that stream's cursor, it SHALL record a transient known gap and a stream-skipped timeline event for that stream, and it SHALL continue collecting and committing the run's other in-scope streams.

#### Scenario: Successful persistent run
- **WHEN** a connector emits scoped records, scoped state, and `DONE status="succeeded"` with a matching `records_emitted` count and compatible exit code
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
