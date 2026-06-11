## ADDED Requirements

### Requirement: The shared connector HTTP governor SHALL provide adaptive, fastest-safe collection by default

The shared API-connector HTTP governor (`createConnectorHttpGovernor`) SHALL,
when constructed with only a connector name, yield an adaptive rate controller:
it SHALL enter from a conservative slow-start discovery interval, accelerate
under sustained success (AIMD additive increase toward the rate ceiling), and
back off multiplicatively on a throttle signal — never crossing the
owner-authored rate ceiling. A connector author SHALL obtain this behavior with
no per-connector rate code beyond the bare factory call. The factory SHALL also
provide an explicit opt-out (a zero discovery interval) that disables pacing
entirely and preserves the pre-convergence byte-identical no-wait path.

#### Scenario: A bare governor cold-starts adaptive

- **WHEN** a connector constructs the governor with only its name
- **THEN** the governor SHALL cold-start at the shared conservative discovery
  interval
- **AND** its live rate snapshot SHALL be available (pacing is on by default)

#### Scenario: Sustained success accelerates the rate toward the ceiling

- **WHEN** the governor records a sequence of successful responses
- **THEN** the inter-request interval SHALL monotonically shrink (the rate rises)
- **AND** it SHALL never shrink below the rate ceiling

#### Scenario: A throttle backs the rate off and the back-off is legible

- **WHEN** the governor records a throttle signal
- **THEN** the inter-request interval SHALL increase (the rate slows)
- **AND** the back-off SHALL be visible in the governor's rate snapshot as a
  legible event with its reason

#### Scenario: A connector opts out of pacing

- **WHEN** a connector constructs the governor with a zero discovery interval
- **THEN** the governor SHALL perform no pre-flight pacing wait
- **AND** its rate snapshot SHALL be absent (no adaptive controller exists)

### Requirement: The shared governor SHALL expose a warm-start runtime seam so the learned rate compounds across runs

The shared governor SHALL accept a restored learned interval at construction
(seeding the controller warm-started, clamped to never be faster than the rate
ceiling) and SHALL expose a snapshot of its learned interval for persistence.
The runtime SHALL provide framework-owned helpers — restore (applying a staleness
guard), persist (durable state fields), and observability — so a connector author
threads only its durable state location and never hand-rolls the read/write or
the staleness logic. Warm-start state SHALL be persisted onto a declared stream
cursor (the runtime gates connector STATE on declared streams); a connector SHALL
NOT persist warm-start state under a synthetic, undeclared stream.

#### Scenario: A fresh resume restores the prior run's learned interval

- **WHEN** a run persists its learned interval and the next run restores it
  within the staleness window
- **THEN** the next run's controller SHALL warm-start FROM the restored interval,
  not the cold discovery seed

#### Scenario: A stale resume cold-starts conservatively

- **WHEN** a persisted learned interval is older than the staleness guard, or is
  absent or malformed
- **THEN** the restore SHALL yield nothing and the controller SHALL cold-start at
  the conservative discovery interval

#### Scenario: Warm-start state rides a declared stream cursor

- **WHEN** a connector persists its learned interval for warm-start
- **THEN** it SHALL merge the pacing fields onto an already-declared stream's
  cursor
- **AND** it SHALL NOT emit STATE for a synthetic stream the run never declared

### Requirement: The adaptive controller's live rate SHALL be legible for every governor-using connector

Any connector using the shared governor SHALL be able to emit its controller's
live rate as the redacted `collection_rate` run-trace progress via a single
framework-owned helper, so an operator can watch the controller speed up and back
off. The emitted rate state SHALL carry no account or content data — only rate
numbers (current and ceiling interval / effective rate) and the last back-off
reason. When pacing is opted out, the helper SHALL yield an explicit absence
rather than a false zero rate.

#### Scenario: Rate state is emitted as redacted progress

- **WHEN** a governor-using connector surfaces its controller state
- **THEN** the emitted `collection_rate` SHALL carry the current and ceiling
  interval, the corresponding rates per minute, and the last back-off reason
- **AND** it SHALL carry no account/content fields

#### Scenario: Absent controller reads as honest unknown

- **WHEN** the connector has opted out of pacing
- **THEN** the observability helper SHALL yield an explicit absence
- **AND** it SHALL NOT emit a false zero rate
