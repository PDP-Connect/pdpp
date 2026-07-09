## MODIFIED Requirements

### Requirement: Owner source health SHALL expose the current actionable state

The reference implementation SHALL render source health from current durable evidence rather than stale historical progress evidence.

#### Scenario: Failed owner-runnable source with historical recovered gaps

**WHEN** a source has retained records and historical recovered gaps, but the latest relevant run failed and no run is active
**THEN** the rendered verdict SHALL NOT claim background collection is in progress
**AND** the owner SHALL receive a retry action when the source can be owner-run.

#### Scenario: Active run row exists

**WHEN** durable active-run evidence exists for a source
**THEN** the rendered verdict SHALL represent active work or active owner attention
**AND** SHALL NOT classify the source as resting idle solely because the latest terminal collection report lacks coverage measurements.

#### Scenario: Session assistance timed out

**WHEN** a browser/session-assisted source fails because the owner assistance window timed out
**THEN** the rendered verdict SHALL classify the gap as owner/session-recoverable
**AND** SHALL NOT present the source as a terminal maintainer code-fix issue.

#### Scenario: Idle source has retryable coverage gaps

**WHEN** a source is not actively syncing but current durable coverage evidence contains retryable gaps
**THEN** the rendered verdict SHALL offer an owner retry action
**AND** SHALL NOT describe the source as passively collecting unless active progress, scheduled retry, cooldown, or provider-pressure evidence proves the system is already handling the work.

#### Scenario: Source-pressure cooldown

**WHEN** a source is paused by the provider-pressure governor with a retry floor
**THEN** the rendered verdict SHALL preserve passive cooldown/wait semantics
**AND** SHALL NOT encourage repeated owner retries that bypass the governor.

#### Scenario: Idle connection with a prior success is stale, paused, or manual-refresh-due

**WHEN** a connection has a prior successful run (`last_success_at` is not null) and its headline state is `idle`, its freshness axis is `stale`, or its forward disposition is `owner_refresh_due`, with no coverage/attention/outbox degradation and no other broken state or disposition
**THEN** the rendered verdict pill tone SHALL NOT be `green`/`Healthy`
**AND** the pill SHALL render `amber`/`Needs refresh` (not `Degraded`) with an `advisory` channel and a refresh/resume action, so the owner can see the connection is not current without the connector being misread as broken.

#### Scenario: Idle connection with no prior success stays neutral

**WHEN** a connection has never completed a successful run (`last_success_at` is null) and carries no stale/degrading evidence
**THEN** the rendered verdict pill tone MAY remain `green` (fresh axis) or `grey`/`Not measured` (unknown axis)
**AND** SHALL NOT be forced to `amber` solely because the headline state is `idle`.

#### Scenario: Amber tone from a genuine degrading condition keeps the Degraded label

**WHEN** the pill tone is `amber` because of a real coverage gap (`resumable`, `awaiting_owner`, or any non-green per-stream coverage), an open attention condition, a stalled outbox, or a headline state other than `idle` (e.g. `degraded`, `needs_attention`, `cooling_off`)
**THEN** the rendered verdict pill label SHALL be `Degraded`, never `Needs refresh`
**AND** a `red` tone (terminal/unsupported/blocked) SHALL keep its existing `Can't collect` label, never `Needs refresh`.
