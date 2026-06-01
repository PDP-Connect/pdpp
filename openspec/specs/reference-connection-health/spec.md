# reference-connection-health Specification

## Purpose
TBD - created by archiving change define-connection-health-evidence-model. Update Purpose after archive.
## Requirements
### Requirement: Connection Health SHALL Preserve Evidence Before Projection

The reference implementation SHALL model connection health as raw facts normalized into typed conditions and then into a derived projection.

#### Scenario: Raw credential failure becomes typed evidence

**WHEN** a connector run observes a source credential rejection
**THEN** the reference implementation records a `CredentialsValid` condition with `status=false`, a stable reason code, safe message, origin, observed timestamp, and remediation metadata.

#### Scenario: Projection is derived

**WHEN** a surface requests connection health
**THEN** the surface receives a projection derived from current conditions rather than independently inferring health from run history.

### Requirement: Conditions SHALL Be Typed, Current, And Safe

Every condition that can affect owner-facing health SHALL include a stable type, tri-state status, severity, reason, safe message, origin, observed timestamp, sensitivity, and optional remediation.

#### Scenario: Secret redaction

**WHEN** a credential or token-related failure is converted into a condition
**THEN** the condition message and remediation SHALL NOT include secret values and SHALL mark diagnostic sensitivity as `secret_redacted` when source details were redacted.

#### Scenario: Expired condition is not dominant

**WHEN** a condition has expired or is superseded by newer evidence for the same connection generation
**THEN** it SHALL NOT drive the dominant health projection.

### Requirement: Readiness SHALL Be First-Class

The reference implementation SHALL represent credential validity, runtime binding availability, remote surface availability, local exporter availability, and required external tools as readiness conditions when evidence exists.

#### Scenario: Missing runtime binding

**WHEN** a connector requires a browser surface and no usable surface is available
**THEN** the connection health SHALL expose a readiness condition explaining the missing runtime dependency.

#### Scenario: Unknown readiness remains explicit

**WHEN** no probe or failure evidence exists for a readiness dimension
**THEN** the reference implementation SHALL represent that readiness as unknown rather than guessing healthy or unhealthy.

### Requirement: Scheduler Policy SHALL Be Separate From Data Health

The reference implementation SHALL model scheduler backoff, paused schedules, and next due time as policy conditions separate from freshness, coverage, and last successful ingest.

#### Scenario: Newer success clears stale backoff

**WHEN** a connection has a scheduler backoff fact older than a successful run for the same connection generation
**THEN** the stale backoff SHALL NOT cause the connection projection to be blocked or failing.

#### Scenario: Active backoff is visible

**WHEN** retry policy is currently delaying the next run and no newer success supersedes it
**THEN** the connection projection SHALL expose `cooling_off` or equivalent policy state with retry timing.

### Requirement: Coverage, Work, And Attention SHALL Remain Decomplected

The reference implementation SHALL keep source coverage, local-device backlog, dead letters, retryable detail gaps, and owner attention as separate condition families.

#### Scenario: Successful run with partial coverage

**WHEN** a run succeeds but leaves terminal or retryable source gaps
**THEN** the projection MAY be degraded, but the underlying coverage condition SHALL identify the affected streams and recovery class.

#### Scenario: Local exporter has pending work

**WHEN** a local collector reports pending outbox records
**THEN** the connection projection SHALL expose pending device work without labeling the connection as a scheduler failure.

#### Scenario: Owner action blocks progress

**WHEN** a connector is waiting for current owner input
**THEN** `AttentionClear=false` or equivalent attention evidence SHALL dominate the projection until the request is satisfied, expires, or is canceled.

### Requirement: Owner Surfaces SHALL Share One Projection Contract

Dashboard, CLI, and owner-control-plane API surfaces SHALL consume the same connection health projection and condition contract.

#### Scenario: Dashboard and CLI agree

**WHEN** the same connection is listed in the dashboard and CLI
**THEN** the dominant state, reason, freshness, coverage, and remediation summary SHALL be derived from the same projection payload.

#### Scenario: Grant-scoped clients are isolated

**WHEN** a grant-scoped client queries records or streams
**THEN** owner-only diagnostics such as credential rejection details SHALL NOT be exposed unless a separate owner-debug authorization explicitly permits them.

### Requirement: Implementation SHALL Include Regression Evidence

The change SHALL include tests or scripted checks for the primary failure modes that motivated the evidence model.

#### Scenario: GitHub credential and stale scheduler regression

**WHEN** tests simulate a rejected GitHub token followed by a newer successful run
**THEN** the first projection SHALL show credential remediation and the second projection SHALL not be blocked by stale scheduler backoff.

#### Scenario: Local-device connection without scheduler run

**WHEN** tests simulate a local collector connection with retained records and no scheduler run
**THEN** the projection SHALL describe device ingest state rather than `never run` or generic failure.

### Requirement: Stalled local-device outbox SHALL expose a visible operator remediation path

When the owner console surfaces a connection whose local-device outbox is stalled, it SHALL render the projection's remediation as visible operator copy and a copy-pasteable local command, not as hover-only text. The console SHALL NOT imply that the dashboard or a hosted service can drain a device-local outbox remotely.

The remediation command SHALL be deterministic and non-secret. It SHALL NOT include a base URL, bearer token, credential, or device-local filesystem path. It MAY be scoped by a non-secret connection identity already shown in diagnostics.

The remediation SHALL appear only when the outbox is stalled or when a current condition carries a `clear_backlog` remediation. Healthy, idle, active, and unknown outbox states SHALL NOT render remediation.

#### Scenario: Stalled outbox shows visible label and command

- **WHEN** the console renders a connection whose projection has `axes.outbox = "stalled"` or a current `clear_backlog` condition
- **THEN** the console SHALL render the condition's `remediation.label` as visible operator copy
- **AND** it SHALL render a copy-pasteable local collector diagnostic command for the operator to run on the host that holds the data

#### Scenario: Remediation command leaks no device-local internals

- **WHEN** the console renders the stalled-outbox remediation command
- **THEN** the command SHALL NOT contain a base URL, bearer token, credential, or local filesystem path
- **AND** it MAY include only a non-secret connection identity to scope the local diagnostic

#### Scenario: Non-stalled outboxes stay quiet

- **WHEN** the console renders a connection whose outbox is healthy, idle, active, or unknown and no current `clear_backlog` remediation applies
- **THEN** the console SHALL NOT render outbox remediation copy or a remediation command

### Requirement: Dashboard health summaries SHALL expose degraded work

Owner dashboard summaries that roll up connection health SHALL include degraded or cooling-off connection projections in an attention-visible summary bucket. A dashboard SHALL NOT present a zero attention-relevant summary while visible connection cards are degraded, cooling off, or have stalled local-device work.

#### Scenario: Degraded card appears in the list

- **WHEN** a connection card renders with dominant state `degraded`
- **THEN** the dashboard summary SHALL include that connection in an attention-visible count or a distinct degraded count
- **AND** the summary SHALL NOT imply that no operator-relevant work exists

#### Scenario: Local outbox is stalled

- **WHEN** a local-device connection projects stalled outbox work
- **THEN** the dashboard summary SHALL make that stalled/degraded state visible without reclassifying it as a scheduler failure

### Requirement: Dashboard connection counts SHALL name their population

Owner dashboard connection count labels SHALL identify whether they count all registered connections or only connections with durable progress. Registered connections with no data SHALL remain visible as their own population when they are excluded from the primary count.

#### Scenario: Registered no-data connections exist

- **WHEN** the owner has connections with durable progress and registered connections with no durable records
- **THEN** the dashboard summary SHALL avoid labeling only the durable-progress subset as all `Connections`
- **AND** the no-data population SHALL remain separately visible or included in a clear total/breakdown

