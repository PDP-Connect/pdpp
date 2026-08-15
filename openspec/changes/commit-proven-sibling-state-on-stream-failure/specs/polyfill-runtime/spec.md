## ADDED Requirements

### Requirement: Stream-scoped failures SHALL preserve only proven sibling checkpoints

A connector that cannot complete one independent stream but completes other streams in the same run SHALL identify each failed stream with an in-scope `SKIP_RESULT` whose `reason` is `stream_collection_failed`, then emit failed `DONE` with `error.code` set to `stream_collection_failed`. This pair of messages certifies only which streams failed; it does not turn the run into a success or prove coverage for a failed stream.

#### Scenario: One stream fails after siblings complete
- **WHEN** a connector emits staged state for completed streams, emits an in-scope `SKIP_RESULT reason="stream_collection_failed"` for a different stream, and terminates with `DONE status="failed"` and `error.code="stream_collection_failed"`
- **THEN** the runtime SHALL keep the run failed and the named stream unproven
- **AND** the runtime MAY persist staged state streams, but only when they do not cover any named failed stream

#### Scenario: Failure evidence is incomplete or ambiguous
- **WHEN** failed `DONE` omits the matching error code, no matching stream-scoped `SKIP_RESULT` exists, a named stream is out of scope, or the connector exits without a valid terminal `DONE`
- **THEN** the runtime SHALL NOT persist staged state from that run

#### Scenario: Failed data stream shares a parent checkpoint
- **WHEN** a failed data stream is covered by another stream's checkpoint through the manifest `state_stream` declaration or runtime detail-coverage evidence
- **THEN** the runtime SHALL treat that parent checkpoint as failed for commit purposes
- **AND** it SHALL NOT advance the parent checkpoint from the failed run

#### Scenario: Run is cancelled
- **WHEN** the owner or runtime cancels a run
- **THEN** the runtime SHALL NOT use stream-failure evidence to persist staged state
