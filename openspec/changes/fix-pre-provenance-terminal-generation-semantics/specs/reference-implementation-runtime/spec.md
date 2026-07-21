## ADDED Requirements

### Requirement: Recovery-first selection SHALL NOT starve forward evidence

Existing eligible non-pressure recovery work SHALL continue to take priority
over starting fresh forward-walk work for an implicit, unscoped dispatch or
run (no explicit `recoveryOnly` choice, no scoped resources/streams) — the
existing recovery-first policy is unchanged in that case. However, this
priority SHALL be bounded: when an implicit, unscoped dispatch finds eligible
non-pressure recovery work but the connection's current terminal evidence is
not `current`, or its newest folded fact's evidence timestamp is older than
`FORWARD_EVIDENCE_MAX_AGE` (`max(4 * scheduleIntervalMs, 1 hour)`), the
dispatch SHALL select forward collection instead of recovery-only for that
one dispatch. Once the resulting forward run mints current-generation
fact-carrying terminal evidence, recovery-first selection SHALL resume as
before. Explicit `requestedRecoveryOnly` (any boolean) and resource-scoped
runs SHALL never be overridden by this bound — they retain the same
precedence they already have over the implicit recovery-first default.

#### Scenario: Aged evidence with a large recovery backlog selects one forward run

- **GIVEN** a connection has a large eligible non-pressure recovery backlog
- **AND** its current terminal evidence is missing, historical, or older than
  `FORWARD_EVIDENCE_MAX_AGE`
- **WHEN** an implicit, unscoped scheduled tick or manual run is evaluated
- **THEN** the dispatch SHALL select forward collection, not recovery-only,
  for that dispatch
- **AND** once that run mints fresh current-generation terminal evidence,
  the next eligible tick SHALL resume recovery-first selection.

#### Scenario: Fresh evidence preserves ordinary recovery-first priority

- **GIVEN** a connection has eligible non-pressure recovery work
- **AND** its current terminal evidence is current and newer than
  `FORWARD_EVIDENCE_MAX_AGE`
- **WHEN** an implicit, unscoped dispatch is evaluated
- **THEN** recovery-only SHALL still win the dispatch, unchanged from today.

#### Scenario: Explicit recovery-only or scoped intent is never overridden by the debt bound

- **GIVEN** a caller explicitly requests `recoveryOnly: true` or `false`, or
  scopes the run to specific resources/streams
- **AND** the connection's forward evidence is aged past
  `FORWARD_EVIDENCE_MAX_AGE`
- **WHEN** the dispatch is evaluated
- **THEN** the explicit choice or scoped intent SHALL be honored exactly as
  before, unaffected by forward-evidence debt.
