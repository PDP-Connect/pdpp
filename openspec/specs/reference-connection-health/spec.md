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

A connector's **auto-schedulability** SHALL likewise be separate from data health. When a connector's manifest refresh policy declares it manual, paused, or background-unsafe (`recommended_mode: "manual"`, `recommended_mode: "paused"`, or `background_safe: false` — the refresh-policy values that make it ineligible for background schedule enrollment), the projection SHALL NOT treat stale freshness as a data-health degradation, because such a connector structurally cannot auto-refresh and only an owner-initiated run advances its data. A connector whose manifest does not declare it manual, paused, or background-unsafe SHALL be treated as schedulable, and stale freshness SHALL degrade it as before.

#### Scenario: Newer success clears stale backoff

- **WHEN** a connection has a scheduler backoff fact older than a successful run for the same connection generation
- **THEN** the stale backoff SHALL NOT cause the connection projection to be blocked or failing.

#### Scenario: Active backoff is visible

- **WHEN** retry policy is currently delaying the next run and no newer success supersedes it
- **THEN** the connection projection SHALL expose `cooling_off` or equivalent policy state with retry timing.

#### Scenario: Manual connector staleness is not a scheduler-driven failure

- **WHEN** a connection whose manifest refresh policy declares it manual, paused, or background-unsafe has aged past its freshness window
- **THEN** the projection SHALL NOT report `degraded` solely because of that staleness
- **AND** an otherwise schedulable connector with the identical staleness SHALL still degrade.

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

### Requirement: Local-device connection summary SHALL expose count-backed outbox diagnostics

The reference implementation's local-device connection-summary projection SHALL expose a typed rollup of the outbox diagnostic counts the device already reports on its heartbeats (pending, retrying, stale leases, dead letters, backlog, leased, succeeded, total) plus an optional earliest-pending timestamp. The rollup SHALL be derived only from trusted source-instance heartbeat evidence (active device, active source, not revoked) and SHALL be `null` when no trusted source reports counts.

The rollup SHALL carry only non-negative integer counts and an optional ISO-8601 `oldest_pending_at` timestamp. It SHALL NOT carry a filesystem path, queue name, device token, hostname, base URL, or record payload. The reference SHALL NOT read a device's local outbox directly to compute it; the heartbeat-reported diagnostics are the only source.

These counts are owner-only diagnostics. They SHALL NOT be exposed to grant-scoped clients and SHALL NOT appear on scheduler-managed (non-local-device) connection summaries.

#### Scenario: Trusted sources roll up into connection-summary counts

- **WHEN** a local-device connection has trusted source instances whose heartbeats reported outbox diagnostics
- **THEN** the connection-summary projection SHALL expose a rolled-up `outbox_counts` summing the per-source counts across those trusted sources
- **AND** the earliest reported pending timestamp SHALL be preserved

#### Scenario: Revoked or untrusted sources do not contribute counts

- **WHEN** the only source rows for a connection are revoked or inactive
- **THEN** the connection-summary projection SHALL NOT surface outbox counts derived from those rows
- **AND** the count rollup SHALL be `null`

#### Scenario: Count rollup leaks no device-local internals

- **WHEN** the connection-summary projection exposes the outbox count rollup
- **THEN** the rollup SHALL contain only non-negative integer counts and an optional ISO-8601 timestamp
- **AND** it SHALL NOT contain a filesystem path, queue name, device token, hostname, base URL, or record payload

### Requirement: Owner console SHALL surface outbox scale only where it improves remediation

When the owner console renders count-backed outbox diagnostics for a connection, it SHALL do so only as part of the stalled-outbox remediation surface. The console SHALL keep healthy, idle, active, and unknown outbox connections free of count chips or numeric outbox badges.

#### Scenario: Stalled remediation shows the count-backed scale

- **WHEN** the console renders the stalled-outbox remediation for a connection whose summary carries a non-null outbox count rollup
- **THEN** the console SHALL render a count-backed scale line describing how much work is stuck (e.g. pending and dead-letter counts) alongside the existing remediation label and command

#### Scenario: Quiet connections render no outbox counts

- **WHEN** the console renders a connection whose outbox is healthy, idle, active, or unknown
- **THEN** the console SHALL NOT render outbox count chips or a numeric outbox badge for that connection

### Requirement: Records-list row SHALL surface stalled-outbox scale only where it aids remediation

When the owner console renders a records-list row for a connection whose local-device outbox is stalled and whose connection summary carries a non-null `outbox_counts` rollup with at least one positive stuck-work count, the row SHALL surface a compact count-backed cue describing how much retryable work is stuck (drawn from pending, retrying, stale-lease, dead-letter, and backlog counts). The cue SHALL be rendered as part of the row's existing stalled-outbox guidance, which links to the connection detail remediation surface; the row SHALL NOT invent a new remote fix.

The cue SHALL show only positive stuck-work categories and SHALL NOT surface succeeded or total counts. The console SHALL NOT render the cue on rows whose outbox is healthy, idle, active, or unknown, on scheduler-managed rows that carry no local-device progress, or on stalled rows whose summary reports no positive stuck-work count. The cue SHALL carry only the rolled-up counts already exposed on the owner-only connection summary; it SHALL NOT introduce new device telemetry.

#### Scenario: Stalled row with counts shows a compact scale linked to remediation

- **WHEN** the records-list row renders a connection whose projection has `axes.outbox = "stalled"` and whose summary carries `outbox_counts` with a positive stuck-work count
- **THEN** the row SHALL render a compact count-backed cue (e.g. pending and dead-letter counts) within its stalled-outbox guidance
- **AND** that guidance SHALL link to the connection detail remediation surface rather than offering a new remote fix

#### Scenario: Quiet, scheduler-managed, and no-count rows show no cue

- **WHEN** the records-list row renders a connection whose outbox is healthy, idle, active, or unknown, or a scheduler-managed connection with no local-device progress, or a stalled connection whose summary reports no positive stuck-work count
- **THEN** the row SHALL NOT render an outbox count cue or a numeric outbox badge

#### Scenario: The cue is scoped to stuck work

- **WHEN** the records-list row renders the stalled-outbox count cue
- **THEN** the cue SHALL include only positive pending, retrying, stale-lease, dead-letter, and backlog counts
- **AND** it SHALL NOT include succeeded or total counts

### Requirement: Local-device collection verdict SHALL be terminal collection evidence

The connection-health projection SHALL recognize a local-device collection-succeeded verdict as terminal collection evidence equivalent to a succeeded spine run, so that a local-device-backed connection whose device-side evidence is fully green can project `healthy`.

The verdict SHALL be established only when all of the following hold for a local-device-backed connection: the outbox axis is `idle` derived from trusted heartbeat evidence (active device, active source, not revoked); durable `coverage_diagnostics` prove a `complete` coverage axis; and freshness is `fresh`. The freshness gate keeps the change purely additive — a drained collector with complete coverage but no satisfied freshness policy keeps `CollectionSucceeded` unknown and remains `idle` exactly as before; only the fully-green case is upgraded. When the verdict holds and no run-derived collection verdict exists, the projection SHALL treat the `CollectionSucceeded` condition as satisfied (`status = true`) with a local-device origin.

A run-derived collection verdict SHALL always take precedence. When a terminal spine run exists for the connection, the projection SHALL use the run outcome and SHALL NOT let device evidence override it. The verdict SHALL apply only to local-device-backed connections; scheduler-managed connections SHALL NOT receive it.

The verdict SHALL NOT relax any other gate to `healthy`. A local-device connection with no satisfied freshness policy SHALL remain `idle` rather than `healthy` or `unknown`. A stalled outbox, dead letters, retryable backlog, a stale lease, a stale heartbeat, a degrading or `unknown` coverage axis, open required attention, blocked credentials or runtime, and an empty outbox with no coverage diagnostics SHALL each keep the connection out of `healthy` exactly as before. Absence of trusted device evidence SHALL NOT establish the verdict.

#### Scenario: Drained local collector with complete coverage and fresh heartbeat projects healthy

- **WHEN** a local-device-backed connection has a trusted, healthy, fully-drained outbox (axis `idle`), durable `coverage_diagnostics` proving `complete` coverage, and freshness `fresh` because a recent heartbeat satisfies a declared refresh policy
- **THEN** the projection SHALL report `CollectionSucceeded` with status `true` and headline state `healthy`

#### Scenario: Drained local collector with complete coverage but no freshness policy stays idle

- **WHEN** a local-device-backed connection has a trusted idle/drained outbox and `complete` coverage but freshness is `unknown` because no refresh policy declares a staleness window
- **THEN** the verdict SHALL NOT be established and `CollectionSucceeded` SHALL remain unknown
- **AND** the headline state SHALL remain `idle` (neither `healthy` nor `unknown`)

#### Scenario: Local-device verdict never overrides a run outcome

- **WHEN** a connection has a terminal spine run and also satisfies the local-device verdict gates
- **THEN** the projection SHALL derive `CollectionSucceeded` from the run outcome
- **AND** a failed run SHALL NOT be promoted to `healthy` by device evidence

#### Scenario: Degraded or unproven device evidence is never greened by the verdict

- **WHEN** a local-device-backed connection has a stalled outbox, an untrusted/`unknown` outbox, a degrading or `unknown` coverage axis, or no `coverage_diagnostics` at all
- **THEN** the verdict SHALL NOT be established
- **AND** the projection SHALL keep its honest non-`healthy` state (`degraded`, `idle`, or `unknown` as the other axes dictate)

### Requirement: Manual / paused / background-unsafe connector stale freshness SHALL surface as an owner-action advisory, not a degradation

When a connection is manual-refresh-only — its manifest refresh policy declares `background_safe: false`, `recommended_mode: "manual"`, OR `recommended_mode: "paused"` — and its only non-green signal is that retained data has aged past the freshness window, the connection-health projection SHALL surface that staleness as an owner-action / manual-refresh advisory rather than a `degraded` headline. The advisory SHALL be an `idle` headline with reason code `stale_manual_refresh`, the `stale` freshness axis and badge SHALL remain set, and the `Fresh` condition SHALL be reported `false` at `info` severity (below the degrading threshold) with reason `stale_manual_refresh` and a manual-refresh remediation targeting a connector run.

The advisory SHALL fire only when the connection is otherwise green: the latest collection SHALL be a succeeded run (or an equivalent local-device collection verdict) and source coverage SHALL be complete. The projection SHALL continue to report `degraded` or a higher-precedence state for a manual-refresh-only connection on every real failure — incomplete coverage, terminal or retryable coverage gaps, a stalled outbox, a failed last run, credential rejection, active backoff, or open required attention. A connection that is not manual-refresh-only SHALL degrade on stale freshness exactly as before, and a manual-refresh-only connection that has never produced a succeeded collection SHALL remain the never-run `idle` (with a reason code other than `stale_manual_refresh`), not the advisory.

#### Scenario: Manual connector complete, succeeded, and stale projects an idle advisory

- **WHEN** a manual-refresh-only connection (manifest `recommended_mode: "manual"`, `recommended_mode: "paused"`, or `background_safe: false`) has a succeeded last run, complete coverage, and freshness `stale`
- **THEN** the headline state SHALL be `idle` with reason code `stale_manual_refresh`
- **AND** the `stale` freshness axis and badge SHALL remain set
- **AND** the `Fresh` condition SHALL be `false` at `info` severity with a manual-refresh remediation, so the projection never reports `degraded` for that staleness alone.

#### Scenario: Schedulable connector with the same stale evidence still degrades

- **WHEN** a connection that is not manual-refresh-only has a succeeded last run, complete coverage, and freshness `stale`
- **THEN** the headline state SHALL be `degraded`
- **AND** the `Fresh` condition SHALL be `false` at `warning` severity.

#### Scenario: Manual connector with incomplete coverage still degrades

- **WHEN** a manual-refresh-only connection is stale and also has incomplete or gapped source coverage
- **THEN** the headline state SHALL be `degraded` and the coverage condition SHALL identify the gap, so the manual-stale advisory never masks a coverage failure.

#### Scenario: Manual connector with a failed last run still degrades or blocks

- **WHEN** a manual-refresh-only connection is stale and its latest terminal run failed
- **THEN** the projection SHALL report `degraded` (or `blocked` when the failure is a readiness/credential rejection), never the manual-stale `idle` advisory.

#### Scenario: Never-run manual connector that is stale stays never-run idle

- **WHEN** a manual-refresh-only connection has no succeeded run and no equivalent local-device collection verdict, and freshness is `stale`
- **THEN** the headline state SHALL be `idle` with a reason code other than `stale_manual_refresh`, reflecting the never-run state rather than the manual-stale advisory.

### Requirement: Stalled local-device outbox SHALL name its cause class

When the connection-health projection reports a stalled local-device outbox, it SHALL classify the cause from the heartbeat evidence the server already holds and render a cause-specific message, reason, and remediation in the `LocalExporterAvailable` and `BacklogClear` conditions instead of one generic stalled/blocked message. The cause SHALL be one of `state_read_failed`, `dead_letter_backlog`, or `stale_pending`.

A `blocked` heartbeat with no rolled-up dead letters SHALL classify as `state_read_failed`; a `blocked` heartbeat with one or more rolled-up dead letters SHALL classify as `dead_letter_backlog`; pending work whose heartbeat has gone stale past the freshness threshold SHALL classify as `stale_pending`. When a connection's trusted sources report different causes, the projection SHALL surface the most actionable cause, ordered `dead_letter_backlog` over `state_read_failed` over `stale_pending`.

The cause classification SHALL NOT widen or rename the outbox axis: the axis stays `idle | active | stalled | unknown`, and a non-stalled axis SHALL NOT carry a stalled cause. When a stalled axis carries no cause, the projection SHALL fall back to the generic stalled message rather than inventing a cause. The classification SHALL NOT introduce new device telemetry, change the heartbeat wire contract, or read a device's local outbox directly; it SHALL be derived only from the already-persisted heartbeat status and outbox-diagnostic counts.

#### Scenario: Blocked heartbeat with no dead letters names a state-read stall

- **WHEN** a trusted local-device heartbeat reports `blocked` status with no dead-lettered records
- **THEN** the projection SHALL classify the stalled cause as `state_read_failed`
- **AND** the `LocalExporterAvailable` condition SHALL state that the exporter is blocked reading prior state, that there is nothing to requeue, and that re-running the collector on the host clears it

#### Scenario: Blocked heartbeat with dead letters names a dead-letter backlog

- **WHEN** a trusted local-device heartbeat reports `blocked` status with one or more dead-lettered records
- **THEN** the projection SHALL classify the stalled cause as `dead_letter_backlog`
- **AND** the `LocalExporterAvailable` condition SHALL state that dead-lettered records must be retried and then drained by re-running the collector on the host

#### Scenario: Pending work with a stale heartbeat names a stalled drain

- **WHEN** a trusted local-device heartbeat reports pending work but has not been seen within the stale-heartbeat threshold
- **THEN** the projection SHALL classify the stalled cause as `stale_pending`
- **AND** the `LocalExporterAvailable` condition SHALL state that pending work stopped draining and that re-running the collector on the host resumes it

#### Scenario: A cause never leaks onto a non-stalled axis

- **WHEN** a connection's outbox axis is `idle`, `active`, or `unknown`
- **THEN** the projection SHALL NOT render a stalled cause message or remediation for that connection
- **AND** an `active` outbox SHALL read as queued work draining normally, not as a danger signal

