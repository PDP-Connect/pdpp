## ADDED Requirements

### Requirement: Checkpoint-dependency eligibility SHALL have portable conformance coverage

The reference implementation SHALL provide conformance coverage for checkpoint-dependency eligibility (the certified stream-scoped failure exception and multi-parent `DETAIL_COVERAGE`) that asserts only on wire-observable outcomes — connector JSONL input and HTTP-observable checkpoint/state/timeline output — rather than on internal function names, mocks, or RI-private state. This coverage SHALL include cancellation racing a certified stream-scoped failure, a partial checkpoint-store failure mid-commit across multiple staged checkpoints, and SQLite/Postgres parity for the commit path, none of which had prior coverage.

#### Scenario: Cancellation racing a certified stream-scoped failure

- **WHEN** the runtime has recorded an owner-initiated cancellation for a run before its connector's terminal `DONE` is processed
- **AND** that `DONE` would otherwise structurally certify a stream-scoped failure (`status="failed"`, `error.code="stream_collection_failed"`, matching in-scope `SKIP_RESULT`)
- **THEN** the run resolves as `cancelled`
- **AND** no staged state commits, including state for streams unrelated to the named failure

#### Scenario: Partial checkpoint-store failure across multiple eligible checkpoints

- **WHEN** a certified stream-scoped failure (or a fully successful run) has more than one staged checkpoint stream eligible for commit
- **AND** persisting one eligible checkpoint's `STATE` fails after at least one other eligible checkpoint already committed
- **THEN** the run fails as a runtime error
- **AND** the terminal result's checkpoint summary reports the exact number of staged and committed checkpoint streams
- **AND** the identity of the checkpoint stream whose persistence failed is recoverable (for example, from the rejected error's diagnostic message or a dedicated commit-failure event)
- **AND** the identity of each checkpoint stream that committed before the failure is recoverable (for example, from a per-stream commit event or by reading back durable state)
- **AND** the already-committed checkpoint(s) remain committed; the failed-to-persist checkpoint remains eligible for retry

#### Scenario: A stream declaring both state_stream and parent_streams is rejected directly

- **WHEN** a manifest stream declares both `state_stream` and `parent_streams`
- **THEN** manifest validation SHALL reject the manifest via an explicit, direct check for this combination
- **AND** this rejection SHALL NOT depend solely on `state_stream` and `parent_streams` being gated to mutually exclusive `coverage_strategy` values as an incidental side effect

#### Scenario: SQLite/Postgres parity for checkpoint-dependency commit

- **WHEN** the same certified stream-scoped failure and multi-parent `DETAIL_COVERAGE` scenarios run against both the SQLite-backed reference store and a Postgres-backed store
- **THEN** both backends commit the identical set of eligible checkpoint streams and withhold the identical set of ineligible checkpoint streams
- **AND** the Postgres variant of this coverage is gated on `PDPP_TEST_POSTGRES_URL` being set, and registers a single skipped test (not silently absent) when the variable is unset
