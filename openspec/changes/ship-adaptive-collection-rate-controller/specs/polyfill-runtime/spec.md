## ADDED Requirements

### Requirement: The send governor's learned rate SHALL be the sole rate authority, not a fixed launch-jitter floor

SHALL the polyfill-runtime's single pre-flight send governor take its
inter-request rate from the folded GCRA pacing signal, NOT from a fixed
launch-jitter floor. When a connector configures both a launch-jitter window and
a GCRA pacing hint, the launch-jitter window SHALL be small enough (an ε
anti-phase-lock noise band, on the order of tens of milliseconds) that it never
exceeds the controller's learned inter-request interval. The send governor's
pre-flight wait SHALL be the maximum of the ε-jitter and the pacing delay; since
the ε-jitter is bounded well below the slowest learned interval, the learned
interval is the binding rate authority whenever the controller has slowed below
the ε band.

A fixed launch-jitter floor that can exceed the controller's learned interval —
capping throughput regardless of what the controller learns — SHALL be treated as
a defect: it is a manual throttle, not a controller signal, and a single serial
collector has no competing flows for which a jitter *floor* (as opposed to ε
noise) has any convergence role.

#### Scenario: Learned interval below the jitter band binds the rate

- **WHEN** the controller has learned an inter-request interval shorter than the
  configured launch-jitter maximum
- **THEN** the launch-jitter window SHALL be an ε band (tens of ms), so the
  effective pre-flight wait tracks the larger of ε and the learned interval
- **AND** the learned interval SHALL bind the rate, never a fixed floor larger
  than it

#### Scenario: A jitter floor that exceeds the learned interval is a defect

- **WHEN** a connector is configured with a launch-jitter minimum larger than the
  controller's reachable minimum interval
- **THEN** the composition SHALL be treated as a defect (the floor caps
  throughput below the controller's learned rate)
- **AND** the runtime SHALL NOT ship a default configuration whose launch-jitter
  floor exceeds the controller's reachable minimum interval

### Requirement: The adaptive rate SHALL have exactly one owner-authored number — the rate ceiling — and never probe across it

SHALL the polyfill-runtime expose exactly ONE owner-authored safety number for
the adaptive rate loop: the rate ceiling, expressed as the minimum inter-request
interval (equivalently, the maximum sustained request rate) the controller's
additive-increase is forbidden to cross. The ceiling SHALL be a single
configurable value with a safe default set below the provider's estimated
behavioral-flagging threshold. The controller's additive increase (speed-up on
sustained success) SHALL floor at the ceiling and never go faster. In-flight
concurrency SHALL remain a hard, non-adaptive ceiling of 1; any concurrency-AIMD
machinery SHALL be inert under `maxConcurrency === 1` and SHALL NOT act as a
second adaptive control dimension.

#### Scenario: Additive increase floors at the rate ceiling

- **WHEN** the controller observes sustained success and additively reduces its
  interval toward the ceiling
- **THEN** the interval SHALL never drop below the configured minimum interval
  (the ceiling)
- **AND** the effective rate SHALL never exceed the ceiling rate

#### Scenario: Concurrency is a frozen ceiling, not a controller

- **WHEN** the detail lane runs with `maxConcurrency === 1`
- **THEN** the concurrency-increase path SHALL be inert (never raise concurrency)
- **AND** concurrency SHALL NOT be a second adaptive variable alongside the rate

### Requirement: The controller's learned rate SHALL persist across runs with a staleness guard

SHALL the polyfill-runtime persist the controller's learned inter-request
interval to durable connector state at run end and restore it at the next run's
start, so the AIMD descent compounds across runs instead of resetting to a cold
authored interval at every run boundary. The restore SHALL be guarded by a
staleness window: when the gap since the last run exceeds the guard (a multiple
of the controller's burst-tolerance horizon), the controller SHALL discard the
stale learned interval and resume from the conservative cold-start discovery
interval. The restored interval SHALL never be faster than the configured rate
ceiling.

#### Scenario: A fresh resume restores the prior run's learned interval

- **WHEN** a run starts and durable state carries a learned interval written
  recently (within the staleness guard)
- **THEN** the controller SHALL resume near the prior run's learned interval, not
  the cold default
- **AND** the restored interval SHALL be clamped to be no faster than the rate
  ceiling

#### Scenario: A stale resume falls back to the cold discovery interval

- **WHEN** a run starts and the durable learned interval is older than the
  staleness guard
- **THEN** the controller SHALL discard it and resume from the conservative
  cold-start discovery interval

### Requirement: A transient source-pressure circuit during recovery SHALL NOT terminate a run with remaining budget

SHALL the polyfill-runtime, when gap recovery stops short because a transient
source-pressure circuit opened (not because the run budget is exhausted),
continue to the forward walk while run budget (wall-clock or fetch count)
remains, rather than terminating the entire run. The run SHALL defer to the next
run only when the run budget is genuinely exhausted. The durable-gap invariant
SHALL be preserved: recovery items not hydrated this run SHALL remain recorded as
resumable `DETAIL_GAP` records regardless of whether the forward walk proceeds,
so the forward walk advancing never loses the deferred recovery tail.

#### Scenario: Source-pressure recovery stop with budget continues to forward walk

- **WHEN** gap recovery stops with pending items because a source-pressure
  circuit opened, and run budget remains
- **THEN** the run SHALL proceed to the forward walk (advancing the list cursor)
  rather than returning early
- **AND** the un-hydrated recovery items SHALL remain durable `DETAIL_GAP`
  records for the next run

#### Scenario: Genuine budget exhaustion still defers

- **WHEN** gap recovery consumes the run budget (wall-clock or fetch cap reached)
- **THEN** the run SHALL defer to the next run without starting the forward walk
- **AND** the deferral SHALL carry a budget-exhaustion reason disjoint from the
  source-pressure reason set

### Requirement: The adaptive controller's live rate state SHALL be legible to an operator

SHALL the polyfill-runtime surface the adaptive rate controller's live state so
an operator can see the adaptation. During a run the runtime SHALL emit the
controller's current inter-request interval (and equivalent effective rate), the
configured ceiling rate, and the last back-off event with its reason as
structured run-trace progress, redacting all conversation/account content. The
connection-detail diagnostics surface SHALL render a small honest "Collection
rate" readout (current rate, ceiling, and "last backed off at X for reason Y"
when applicable), degrading to an explicit unknown — never a false zero or false
green — when the controller state is unavailable.

#### Scenario: Controller state is emitted as redacted run-trace progress

- **WHEN** the controller speeds up on success or backs off on throttle during a
  run
- **THEN** the runtime SHALL emit a structured progress event carrying the
  current interval, the ceiling, and (on back-off) the reason
- **AND** the event SHALL NOT carry conversation ids, titles, tokens, or other
  account content

#### Scenario: The console readout degrades honestly when state is absent

- **WHEN** the connection-detail surface has no controller rate state to show
- **THEN** the Collection rate readout SHALL render an explicit unknown
- **AND** it SHALL NOT render a false zero or a false green
