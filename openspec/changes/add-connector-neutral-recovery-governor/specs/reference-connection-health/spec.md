## ADDED Requirements

### Requirement: Owner projection SHALL represent recovery state explicitly

The reference connection-health projection SHALL expose typed recovery state for
connections with durable recoverable work. Owner surfaces SHALL use this typed
state to explain what happens next and whether the owner can act. Recoverable
work that the system can safely continue SHALL NOT be presented as an owner task
requiring repeated manual retries.

#### Scenario: Queued recovery is not owner-required

- **WHEN** a connection has pending recoverable detail work
- **AND** the recovery governor has a future eligible time or normal recovery
  cadence for that work
- **THEN** the owner-facing projection SHALL describe the work as queued,
  catching up, or waiting until the eligible time
- **AND** it SHALL NOT count the connection as owner-required solely because
  recoverable work remains.

#### Scenario: Owner can accelerate only when safe

- **WHEN** a connection has recoverable work that is eligible now
- **AND** an owner-started run would pass the same recovery admission gate as an
  automatic run
- **THEN** the projection MAY show a non-urgent owner-runnable action
- **AND** the action SHALL not appear when provider cooldown or owner repair is
  blocking the run.

#### Scenario: Connector issue is separate from owner action

- **WHEN** recovery evidence shows repeated deterministic no-progress or a
  connector defect
- **THEN** the owner projection SHALL classify the connection as a system or
  connector issue
- **AND** it SHALL NOT instruct the owner to keep retrying as if manual action
  would resolve the defect.

### Requirement: Checking SHALL be time-bounded and evidence-backed

Owner surfaces SHALL NOT use "Checking" as an indefinite bucket for unknown,
stale, queued, or failed states. "Checking" SHALL be used only when current
evidence shows active bounded work, such as an active connector run, an active
health or coverage probe, or an active summary-projection recomputation job. A
summary-projection recomputation is an internal server job that rebuilds owner
summary state from already-stored evidence; it is not provider collection and
SHALL NOT justify "Checking" unless that job is actually tracked as active. If
active bounded-work evidence expires without a new result, the projection SHALL
fall back to a concrete state.

#### Scenario: Active run may show checking

- **WHEN** a connection has an active run or active bounded probe
- **AND** the projection has not yet received enough evidence to classify the
  outcome
- **THEN** the owner surface MAY show a checking state
- **AND** the state SHALL carry or derive from the active work evidence
- **AND** the state SHALL not continue after that active work evidence expires.

#### Scenario: Queued recovery is not checking

- **WHEN** no active check is running
- **AND** a connection has queued recoverable work with a next eligible attempt
  time
- **THEN** the owner surface SHALL describe the queued recovery or wait time
- **AND** it SHALL NOT show the connection as simply checking.

#### Scenario: Unknown coverage without active work is not checking

- **WHEN** a stream has unknown coverage
- **AND** there is no active run, active bounded probe, or current projection
  rebuild that is expected to resolve the unknown
- **THEN** the owner surface SHALL describe the coverage as not yet measured or
  unavailable
- **AND** it SHALL NOT imply PDPP is actively checking.

#### Scenario: Stale read failure is not per-source checking

- **WHEN** the owner console cannot refresh connection summaries from the
  reference service
- **THEN** the surface SHALL present a scoped read-failure state for the surface
  or projection
- **AND** it SHALL NOT classify each source as checking solely because the
  summary read failed.

### Requirement: Source actionability groups SHALL route recovery states without vague taxonomy

The shared source-actionability projection SHALL route recovery states into
owner-required, owner-runnable, system issue, or passive/active-progress groups
using the rendered verdict and recovery state. The group labels and row copy
SHALL describe the owner's concrete option or the system's next step rather than
internal taxonomy. A source row SHALL present at most one primary sentence, one
evidence line, and one primary action. The primary sentence SHALL be derived
from current connection evidence and SHALL NOT expose raw internal labels such
as retry class, gap class, or projection bucket as the main owner-facing copy.

#### Scenario: Recovery waiting state is passive progress

- **WHEN** a connection is waiting for recovery cadence or provider cooldown
- **THEN** the shared actionability projection SHALL route it to a passive
  progress group rather than owner-required work
- **AND** row copy SHALL state the next system step or retry time.

#### Scenario: Eligible owner-runnable recovery is concrete

- **WHEN** a connection has eligible owner-runnable recovery work
- **THEN** the shared actionability projection SHALL render a concrete action
  such as "Retry now" or "Refresh now"
- **AND** that action SHALL start only if the runtime recovery admission gate
  allows it.

#### Scenario: Work-group counts match rows

- **WHEN** the owner surface shows counts for owner-required, owner-runnable,
  system issue, or passive progress groups
- **THEN** each count SHALL equal the number of rows rendered for that group on
  the same surface.

#### Scenario: Source row has one concrete sentence and one action

- **WHEN** a connection has active, queued, cooling, owner-required, or
  system-issue recovery state
- **THEN** the owner surface SHALL render one concrete primary sentence for the
  row
- **AND** it SHALL render supporting evidence separately from the primary
  sentence
- **AND** it SHALL render no more than one primary action for that row.

#### Scenario: Unsafe retry renders no retry action

- **WHEN** recovery work exists
- **AND** the recovery admission gate would deny an ordinary owner-started run
  because of cooldown, budget, owner repair, or connector defect
- **THEN** the owner surface SHALL explain the next step or blocker
- **AND** it SHALL NOT render a normal retry or refresh action that would
  bypass that gate.

### Requirement: Owner source detail SHALL expose recovery evidence progressively

The source-detail surface SHALL expose recovery evidence behind the source row
instead of forcing every detail into the attention list. The detail view SHALL
show current recovery step, progress counts, next eligible attempt when known,
the reason work is not running now, and recent non-secret evidence such as last
attempt, last progress, last classified failure, or captured-fixture
availability. The detail view SHALL NOT expose credentials, secret payloads,
private record content, raw provider URLs, or browser selectors as owner-facing
evidence.

#### Scenario: Detail panel explains queued recovery

- **WHEN** a connection has queued recoverable work
- **THEN** the source-detail surface SHALL show the recovery step as queued or
  catching up
- **AND** it SHALL show progress evidence such as recovered count, remaining
  floor count, last progress, or next eligible time when available.

#### Scenario: Detail panel explains why work is not running

- **WHEN** a connection has recoverable work but no active recovery run
- **THEN** the source-detail surface SHALL explain the blocker or next step,
  such as cooldown, budget, owner repair, connector issue, or unmeasured
  coverage
- **AND** it SHALL not require the owner to infer the reason from raw logs.

#### Scenario: Active recovery names the work

- **WHEN** a connection is actively recovering detail work
- **THEN** the owner surface SHALL name the work being done, such as syncing
  order details or measuring coverage
- **AND** it SHALL NOT collapse that state to an unnamed "Checking" bucket.

### Requirement: Stalled recovery SHALL surface as a system condition

Owner surfaces SHALL NOT present queued recovery as passive progress
indefinitely. When eligible recovery work has received no attempt within the
expected cadence window, the projection SHALL move the connection out of
passive progress into a system-issue presentation with the best available
evidence, and SHALL NOT instruct the owner to resolve the stall with manual
retries.

#### Scenario: Catching up must be making progress

- **WHEN** a connection shows queued or catching-up recovery state
- **THEN** the projection SHALL carry recency evidence such as last progress or
  last attempt time
- **AND** if eligible work has had no attempt beyond the expected cadence
  window, the surface SHALL present a system issue instead of continued passive
  progress.
