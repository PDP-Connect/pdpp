## ADDED Requirements

### Requirement: PostgreSQL bootstrap locking SHALL have a bounded data-aware wait

The reference implementation SHALL resolve a single bounded PostgreSQL
bootstrap-lock deadline from a valid positive deployment override or from the
observed database size. It SHALL use bounded backoff and periodic progress
logging while waiting, and SHALL NOT fail merely because a fixed attempt count
was exhausted before the deadline.

#### Scenario: A populated database is still bootstrapping

- **WHEN** another process holds the bootstrap advisory lock and the database
  is populated
- **THEN** the loser SHALL continue bounded waiting within the populated
  database budget
- **AND** it SHALL emit wait progress
- **AND** it SHALL not crash due only to the former fixed retry window

#### Scenario: An operator supplies a valid override

- **WHEN** `PDPP_POSTGRES_BOOTSTRAP_LOCK_TIMEOUT_MS` is a positive integer
- **THEN** the reference SHALL honor that value subject to its hard safety cap

### Requirement: Optional startup maintenance SHALL follow listener readiness

The reference implementation SHALL bind the AS and RS listeners after required
schema bootstrap and before optional manifest reconciliation or heavy retrieval
maintenance. It SHALL preserve the dependency from reconciliation to retrieval
maintenance and SHALL isolate post-listener maintenance failures from serving.

#### Scenario: Required bootstrap completes

- **WHEN** required schema bootstrap completes successfully
- **THEN** AS and RS SHALL bind before optional manifest reconciliation starts
- **AND** readiness evidence SHALL not claim that optional maintenance is
  required for listener availability

#### Scenario: Optional maintenance fails

- **WHEN** post-listener manifest or retrieval maintenance rejects
- **THEN** the failure SHALL be logged with its maintenance phase
- **AND** the already-listening AS/RS process SHALL remain available
