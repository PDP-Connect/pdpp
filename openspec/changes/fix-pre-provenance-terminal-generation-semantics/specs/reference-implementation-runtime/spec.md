## ADDED Requirements

### Requirement: Recovery-first selection SHALL NOT starve forward evidence

Existing eligible non-pressure recovery work SHALL continue to take priority
over starting fresh forward-walk work for an implicit, unscoped dispatch or
run (no explicit `recoveryOnly` choice, no scoped resources/streams) — the
existing recovery-first policy is unchanged in that case. However, this
priority SHALL be bounded: when an implicit, unscoped dispatch finds eligible
non-pressure recovery work but the connection's terminal evidence is not
`current`, or the newest per-stream `evidence_as_of` timestamp among its
folded terminal facts is older than `FORWARD_EVIDENCE_MAX_AGE` (`max(4 *
scheduleIntervalMs, 1 hour)`), or its folded fact map is empty despite a
`current` state, the connection SHALL be treated as having forward-evidence
debt. `evidence_as_of` SHALL be read from each fact's own stored provenance
timestamp (stamped once at fold time from the terminal event's own
`occurred_at`), never from the terminal-facts component's observation/repair
timestamp — the latter is refreshed by the very reconcile pass the debt
probe itself triggers and would make the bound permanently unable to fire
once evidence is healed current.

Forward-evidence debt SHALL select forward collection instead of
recovery-only for one dispatch **only when forward dispatch is otherwise
permitted** by the connection's existing failure-backoff and source-pressure
cooldown gates. When debt is present but forward dispatch is NOT otherwise
permitted (e.g. a failure-backoff-inflated effective interval not yet
elapsed), the dispatch SHALL proceed as recovery-only on its own independent
recovery cadence exactly as if no debt were present — forward-evidence debt
SHALL NOT become a bypass of the backoff/cooldown gates for forward work,
and SHALL NOT cause a dispatch to select neither recovery nor forward. Once
a resulting forward run mints current-generation fact-carrying terminal
evidence, recovery-first selection SHALL resume as before. Explicit
`requestedRecoveryOnly` (any boolean) and resource-scoped runs SHALL never
be overridden by this bound — they retain the same precedence they already
have over the implicit recovery-first default.

#### Scenario: Aged evidence with a large recovery backlog selects one forward run

- **GIVEN** a connection has a large eligible non-pressure recovery backlog
- **AND** its terminal evidence is missing, historical, or its newest
  per-stream `evidence_as_of` is older than `FORWARD_EVIDENCE_MAX_AGE`
- **AND** forward dispatch is otherwise permitted (failure-backoff interval
  elapsed, no active source-pressure cooldown)
- **WHEN** an implicit, unscoped scheduled tick or manual run is evaluated
- **THEN** the dispatch SHALL select forward collection, not recovery-only,
  for that dispatch
- **AND** once that run mints fresh current-generation terminal evidence,
  the next eligible tick SHALL resume recovery-first selection.

#### Scenario: Debt present but forward not otherwise eligible still dispatches recovery, never nothing

- **GIVEN** a connection has a large eligible non-pressure recovery backlog
  and forward-evidence debt
- **AND** forward dispatch is NOT otherwise permitted (e.g. a
  failure-backoff-inflated effective interval has not yet elapsed)
- **WHEN** an implicit, unscoped scheduled tick is evaluated and the
  connection's own recovery cadence has elapsed
- **THEN** the dispatch SHALL select recovery-only, exactly as if forward-
  evidence debt were absent
- **AND** the dispatch SHALL NOT be ineligible (a tick that dispatches
  neither recovery nor forward work is never a valid outcome of this bound).

#### Scenario: Fresh evidence preserves ordinary recovery-first priority

- **GIVEN** a connection has eligible non-pressure recovery work
- **AND** its terminal evidence is current, with a non-empty fact map whose
  newest per-stream `evidence_as_of` is newer than `FORWARD_EVIDENCE_MAX_AGE`
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

### Requirement: A persistent forward-evidence-debt probe failure SHALL degrade to no-debt as an observable residual, not silently

The forward-evidence-debt probe (consumed at both the scheduler dispatch
governor and the controller's manual `runNow` seam) SHALL fail closed to "no
debt" on any read/reconcile error, so a transient probe failure never
diverts a tick to forward collection on a false positive. This fail-closed
default is deliberate policy, not an oversight: a persistent probe failure
degrades the connection to the pre-bound (unbounded recovery-first)
behavior, and this degradation SHALL be logged at each occurrence so it is
an observable residual condition rather than a silent one. No new counter,
attention item, or escalation subsystem is introduced by this change; adding
consecutive-failure escalation is explicitly out of scope for this tranche
and may be addressed by a future change if persistent probe failures are
observed in practice.

#### Scenario: A probe failure logs and degrades to no debt, never silently

- **GIVEN** the forward-evidence-debt probe's evidence read or reconcile call
  throws
- **WHEN** the dispatch or manual run is evaluated
- **THEN** the probe SHALL return `false` (no debt) so recovery-first
  proceeds unaffected by the failed probe
- **AND** the failure SHALL be logged at the point of occurrence.
