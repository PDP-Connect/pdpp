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

#### Scenario: Source-pressure cooldown

**WHEN** a source is paused by the provider-pressure governor with a retry floor
**THEN** the rendered verdict SHALL preserve passive cooldown/wait semantics
**AND** SHALL NOT encourage repeated owner retries that bypass the governor.
