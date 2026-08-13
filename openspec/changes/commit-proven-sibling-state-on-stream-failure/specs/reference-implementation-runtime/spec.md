## MODIFIED Requirements

### Requirement: Runtime SHALL maintain checkpointed streaming integrity
The reference runtime SHALL stream records to the resource server in batches, flush a stream before staging that stream's `STATE`, and commit staged state only after terminal validation succeeds and state persistence is enabled. The reference runtime SHALL NOT commit staged state when a run is cancelled. A failed run SHALL commit no staged state unless its valid terminal `DONE error.code="stream_collection_failed"` is paired with at least one in-scope `SKIP_RESULT reason="stream_collection_failed"` that names every stream excluded from commit; in that certified case, the runtime SHALL commit only staged state streams that do not cover a named failed stream and SHALL keep the run failed. When a record-batch ingest is rejected as `not_found` for a stream that is present in the run's START scope, the reference runtime SHALL treat it as a transient per-stream gap rather than a terminal run failure: it SHALL NOT stage or commit that stream's cursor, it SHALL record a transient known gap and a stream-skipped timeline event for that stream, and it SHALL continue collecting and committing the run's other in-scope streams.

#### Scenario: Successful persistent run
- **WHEN** a connector emits scoped records, scoped state, and `DONE status="succeeded"` with a matching `records_emitted` count and compatible exit code
- **THEN** the reference runtime SHALL flush buffered records
- **AND** it SHALL persist staged state for each staged stream
- **AND** it SHALL report a checkpoint summary with `commit_status: "committed"`

#### Scenario: Certified stream-scoped failure
- **WHEN** a connector emits staged state for completed streams, emits one or more in-scope `SKIP_RESULT reason="stream_collection_failed"` messages, and emits a valid `DONE status="failed"` with `error.code="stream_collection_failed"`
- **THEN** the reference runtime SHALL persist only staged state streams that do not cover a named failed stream
- **AND** it SHALL keep the run failed with the failed streams retryable and unproven
- **AND** its terminal event SHALL report the actual staged and committed state counts and a partial checkpoint status when they differ

#### Scenario: Failed stream uses a parent state stream
- **WHEN** a named failed data stream maps to a different checkpoint stream through manifest or run-time detail-coverage evidence
- **THEN** the reference runtime SHALL exclude that checkpoint stream from commit

#### Scenario: Uncertified failed run
- **WHEN** a connector reports failure without both matching terminal and stream-scoped evidence, exits without valid `DONE`, or fails terminal validation
- **THEN** the reference runtime SHALL NOT commit staged state

#### Scenario: State persistence is disabled
- **WHEN** a connector run starts with `persistState` disabled
- **THEN** the reference runtime SHALL send `START.state` as null
- **AND** it SHALL NOT persist staged state
- **AND** it SHALL report a checkpoint summary with `commit_status: "disabled"`

#### Scenario: Checkpoint commit partially fails
- **WHEN** record ingest succeeds but committing one or more eligible staged stream states fails after terminal validation
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

