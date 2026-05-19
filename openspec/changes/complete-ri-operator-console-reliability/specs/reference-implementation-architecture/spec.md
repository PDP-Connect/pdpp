## ADDED Requirements

### Requirement: Operator console centers configured connections
The reference implementation SHALL treat a configured connection as the primary owner-facing operator-console unit. Connector type, runtime, device, run, schedule, remote surface, and grant identifiers SHALL remain distinct supporting concepts rather than replacing the configured connection as the source row.

#### Scenario: Owner has two accounts for one connector type
- **WHEN** the owner configures two accounts that use the same connector id
- **THEN** the operator console SHALL represent them as separate configured connections
- **AND** each connection SHALL have independent health, coverage, schedules, runs, state, gaps, and attention status

#### Scenario: A connection uses a local device runtime
- **WHEN** a configured connection is collected by a local device or collector runtime
- **THEN** the operator console SHALL present the configured connection as the owner-facing source
- **AND** it SHALL expose the device/runtime health as supporting diagnostic evidence rather than as the source identity itself

### Requirement: Connection health is projected from durable evidence
The reference implementation SHALL compute connection health from durable evidence including run outcomes, committed checkpoints, coverage, gaps, backlog, schedules, active work, runtime health, attention requests, and projection freshness. It SHALL NOT treat the last run terminal status alone as the connection health.

#### Scenario: Last run succeeded with required gaps
- **WHEN** the latest run for a connection succeeds but required requested coverage remains gap-bearing, deferred, stale, or incomplete
- **THEN** the connection health SHALL NOT be reported as healthy
- **AND** the operator console SHALL expose the useful collected data and the remaining coverage condition

#### Scenario: Last run failed after previous useful data
- **WHEN** a connection has prior committed data and a later run fails with a retryable or cooling-off condition
- **THEN** the connection health SHALL distinguish the available prior data from the current retry/cooldown condition
- **AND** it SHALL NOT collapse the connection into an opaque failed state without coverage context

#### Scenario: Server restarts
- **WHEN** the reference server restarts
- **THEN** the operator console SHALL reconstruct connection health from durable evidence
- **AND** it SHALL NOT require in-memory run state to explain pending, retrying, blocked, degraded, or healthy connection states

### Requirement: Connection health states are canonical and evidence-backed
The reference implementation SHALL use a canonical connection health projection that can represent healthy, degraded, needs attention, cooling off, blocked, idle, and unknown states. The projection SHALL be deterministic and SHALL preserve detailed evidence for owner inspection. Activity, freshness, coverage, and outbox/work status SHALL be represented as axes or badges rather than as additional headline health states.

#### Scenario: Required owner action is pending
- **WHEN** a connection has a current required owner attention request that has not expired
- **THEN** the connection SHALL project to a needs-attention state unless a higher-priority fatal blocked condition applies
- **AND** the operator console SHALL show the action target and expiry

#### Scenario: Retry policy is intentionally delaying work
- **WHEN** a connection has retryable failure evidence and schedule/backoff policy is intentionally delaying the next attempt
- **THEN** the connection SHALL project to cooling-off unless a higher-priority blocked or needs-attention condition applies
- **AND** the operator console SHALL show the next eligible attempt when known

#### Scenario: Active work is running
- **WHEN** a run or durable work item is active for a connection
- **THEN** the operator console SHALL expose activity or syncing as a badge or axis
- **AND** it SHALL NOT replace the headline health state with a separate syncing state

#### Scenario: Freshness policy is violated
- **WHEN** a connection has otherwise clean run evidence but the last successful durable progress is older than the configured freshness policy
- **THEN** the operator console SHALL expose stale freshness as an axis or badge
- **AND** it SHALL NOT require a separate stale headline health state

#### Scenario: Projection evidence is unreliable
- **WHEN** required evidence for the connection health projection is missing, stale beyond policy, or failed
- **THEN** the connection SHALL project to unknown
- **AND** the operator console SHALL name which evidence source made the projection unreliable

#### Scenario: Required coverage is current and complete
- **WHEN** a connection has current committed checkpoints, required coverage is complete or explicitly accepted as unavailable, no required backlog or gaps remain, no required attention is active, and projection evidence is fresh enough
- **THEN** the connection MAY project to healthy

### Requirement: Connection coverage is first-class
The reference implementation SHALL preserve coverage by connection and stream or scope boundary where practical. Coverage SHALL distinguish complete, partial, stale, deferred, unsupported, unavailable, retryable gap, terminal gap, inventory-only, and unknown conditions as structured evidence rather than only timeline text.

#### Scenario: A stream is unsupported by implementation
- **WHEN** a requested or manifest-visible stream is not collected because the connector implementation does not support it
- **THEN** the operator console SHALL expose that stream as unsupported or unavailable coverage
- **AND** it SHALL NOT report the connection as fully healthy for that stream unless the policy explicitly accepts that unavailability

#### Scenario: A detail gap is recorded
- **WHEN** a connector records a durable detail gap or backlog item for a connection
- **THEN** the connection coverage SHALL include that gap with retryability and stream or boundary identity
- **AND** future runs or operator diagnostics SHALL be able to target that gap without relying only on prose from the original run timeline

### Requirement: Long-running executors are bounded and durable
The reference implementation SHALL ensure long-running executor paths use bounded memory, bounded concurrency, durable retryable work, active-run or lease fencing, cancellation where practical, resource policy, and restart reconstruction. Executor paths include local collectors, browser/API connector runs, scheduler-dispatched runs, read-model rebuilds, and remote browser surface allocation.

#### Scenario: A local collector emits a large first backfill
- **WHEN** a local collector emits more records than fit comfortably in one in-memory batch
- **THEN** the runner SHALL stream or batch work into durable bounded units
- **AND** it SHALL NOT require holding the full child connector output in memory before upload begins

#### Scenario: Retryable work is prepared before a crash
- **WHEN** retryable work is prepared and the process crashes before destination acknowledgement
- **THEN** a later execution SHALL recover or explain that work from durable evidence
- **AND** it SHALL NOT silently discard the work or advance committed progress beyond acknowledged effects

#### Scenario: Heavy work exceeds policy
- **WHEN** an executor reaches configured CPU, memory, disk, network, duration, concurrency, or backlog policy limits
- **THEN** the reference implementation SHALL pause, defer, cancel, or mark backlog honestly
- **AND** it SHALL NOT continue unbounded work that can destabilize the host

### Requirement: Checkpoints are destination-confirmed for retryable work
The reference implementation SHALL commit connection progress only when the records, gaps, blobs, and other effects that justify that progress have been durably accepted by the destination or represented as durable accepted gaps. Source-observed cursors and connector-emitted state SHALL be staged progress until that condition holds.

#### Scenario: Records are queued but not acknowledged
- **WHEN** records for a connection are queued or emitted but not yet acknowledged by the reference server
- **THEN** the committed checkpoint for the related boundary SHALL NOT advance past those unacknowledged records

#### Scenario: Required detail cannot be collected but gap is durable
- **WHEN** required detail cannot be collected and the connector records a durable retryable gap that is accepted by reference policy
- **THEN** the reference implementation MAY advance the list-level or boundary checkpoint only according to the accepted gap semantics
- **AND** the operator console SHALL continue to show the outstanding gap until recovered, accepted, or terminal

### Requirement: Owner attention is structured and actionable
The reference implementation SHALL represent required owner action as structured attention evidence. Attention evidence SHALL include attention identity, dedupe key, connection identity, run identity when applicable, kind or reason code, action target, owner-facing copy, timeout or expiry, auto-detection capability, privacy classification, notification policy, lifecycle state, and recovery semantics.

#### Scenario: Connector needs an external approval
- **WHEN** a connector cannot continue until the owner approves a push notification, enters an OTP, completes re-consent, or verifies a source challenge
- **THEN** the reference implementation SHALL create structured attention evidence
- **AND** the operator console SHALL show where the owner should act and what happens if the request expires

#### Scenario: Repeated attention has the same dedupe key
- **WHEN** an equivalent owner-action request is raised repeatedly within the configured cooldown window
- **THEN** the reference implementation SHALL deduplicate or supersede the existing attention evidence rather than spamming duplicate prompts
- **AND** the durable timeline SHALL preserve enough evidence to explain the latest active request

#### Scenario: Attention lifecycle changes
- **WHEN** an attention request is opened, acknowledged, entered in progress, resolved, expired, cancelled, or superseded
- **THEN** the reference implementation SHALL persist that lifecycle transition
- **AND** connection health and notification policy SHALL derive from the current lifecycle state

#### Scenario: Attention is satisfied externally
- **WHEN** an attention request can be auto-detected after the owner acts outside the dashboard
- **THEN** the reference implementation SHALL allow the run or connection to recover without requiring a redundant owner confirmation when safe detection evidence exists

#### Scenario: Secret values are submitted
- **WHEN** an owner submits OTP, credential, or interaction values for a run
- **THEN** the reference implementation SHALL use those values only for the current authorized action
- **AND** it SHALL NOT persist the submitted secret values as durable credentials or expose them in diagnostics

### Requirement: Notifications deliver attention without owning state
The reference implementation SHALL treat PWA/Web Push and similar channels as delivery mechanisms for actionable attention or important health transitions. Notification delivery SHALL NOT be the authoritative source of connection, run, schedule, or coverage state.

#### Scenario: A connection enters needs-attention
- **WHEN** a connection enters a needs-attention state with an actionable target and notification policy allows delivery
- **THEN** the reference implementation MAY send a push notification
- **AND** the dashboard SHALL remain able to render the same attention state from durable evidence if the notification is missed

#### Scenario: A non-actionable retry occurs
- **WHEN** a connector enters a retryable cooling-off state that requires no owner action
- **THEN** the notification policy SHALL avoid repeated noisy prompts unless the transition crosses a configured owner-action threshold

### Requirement: Operator read models are derived and freshness-labeled
The reference implementation MAY use derived read models to make the operator console fast, but those read models SHALL be rebuildable from canonical evidence and SHALL expose freshness, stale, rebuilding, or failed states when relevant.

#### Scenario: A projection is stale
- **WHEN** a dashboard read model is stale, rebuilding, or failed
- **THEN** the operator console SHALL show freshness metadata or an honest fallback
- **AND** it SHALL NOT present stale projection values as fresh canonical truth

#### Scenario: A projection rebuild fails
- **WHEN** a read-model rebuild fails
- **THEN** canonical records, runs, gaps, checkpoints, and other durable evidence SHALL remain intact
- **AND** the operator console SHALL expose sanitized failure metadata

### Requirement: The reliability milestone has acceptance evidence
The reference implementation SHALL NOT claim the broader RI/operator-console reliability milestone is complete until executable or documented acceptance checks prove connection health projection, coverage honesty, executor bounds, restart reconstruction, attention handling, notification policy, projection freshness, and secret-safe diagnostics.

#### Scenario: Milestone closeout is attempted
- **WHEN** the owner attempts to close this milestone
- **THEN** the change SHALL include acceptance evidence for healthy, degraded, needs-attention, cooling-off, blocked, syncing, and unknown connection states
- **AND** it SHALL include evidence for local durable-work recovery, read-model stale/failure behavior, scheduler restart reconstruction, and at least one browser/API connector attention path

#### Scenario: Connector-specific work remains incomplete
- **WHEN** some connector-specific streams, selectors, or live-source fixes remain incomplete
- **THEN** the milestone MAY still close only if those conditions are represented as honest connection coverage or connector-specific follow-up work
- **AND** the operator console SHALL NOT report them as fully healthy without evidence
