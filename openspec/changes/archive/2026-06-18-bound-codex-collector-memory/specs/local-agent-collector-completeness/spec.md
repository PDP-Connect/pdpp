## ADDED Requirements

### Requirement: Local agent collector reads are bounded

The reference implementation SHALL collect local-agent source state without
retaining whole static source files, whole Codex thread result sets, or unbounded
Codex pending-call state in process memory before record-level bounds apply.

#### Scenario: Large static local files are previewed before record construction

- **WHEN** the Claude Code or Codex local collector reads a static markdown-like
  source file for a collected stream
- **THEN** it SHALL retain only a bounded prefix before parsing or constructing
  records
- **AND** it SHALL NOT read the whole source file into memory before applying
  record-level preview limits.

#### Scenario: Codex thread rows stream during session emission

- **WHEN** the Codex local collector emits `sessions` from `state_5.sqlite#threads`
- **THEN** it SHALL iterate thread rows without materializing the full query
  result in memory
- **AND** rollout-only fallback sessions SHALL still emit for rollout aggregates
  that have no matching thread row.

#### Scenario: Codex offset-zero rollout replay bounds pending call state

- **WHEN** the Codex local collector parses a rollout file from byte offset 0
- **AND** the run is caused by enrollment or connector-version upgrade from
  legacy `file_mtimes` state without a rich byte-offset cursor
  **OR** by a rotated, truncated, or replaced rollout file whose prefix-integrity
  guard fails
- **AND** the file contains many function-call records without matching output
  records before EOF
- **THEN** the collector SHALL bound retained pending-call state independently of
  file size
- **AND** it SHALL emit evicted unmatched call records before EOF rather than
  retaining every unmatched call until the final flush.

#### Scenario: Codex late output after eviction is preserved

- **WHEN** the Codex local collector evicts an unmatched function-call record to
  keep pending-call state bounded
- **AND** a matching function-call-output record arrives later in the same parse
- **THEN** the collector SHALL emit the late output through the output-only
  fallback instead of dropping it
- **AND** it SHALL NOT re-grow retained pending-call state for the evicted call.
