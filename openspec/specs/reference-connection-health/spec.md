# reference-connection-health Specification

## Purpose
TBD - created by archiving change define-connection-health-evidence-model. Update Purpose after archive.
## Requirements
### Requirement: Connection Health SHALL Preserve Evidence Before Projection

The reference implementation SHALL model connection health as raw facts normalized into typed conditions and then into a derived projection.

Stored-credential-presence evidence SHALL be connection-binding-scoped: it applies only to a connection that is bound as static-secret. For such a connection the credential-readiness condition SHALL distinguish "no usable stored credential" from "stored credential rejected" as durable connection evidence, derived from credential-presence evidence rather than inferred solely from a transient run reason code; both project as an owner reauth/capture action, with honest, non-conflated reason and copy. A connection bound as a browser session SHALL NOT project a "no usable stored credential" condition from an absent credential row, because it authenticates by owner-authenticated browser session rather than a stored credential. A credential-readiness or session-readiness condition SHALL NOT project the connection healthy or idle merely because a credential-shaped run reason code aged out; it SHALL remain derived from durable evidence until readiness is proven.

#### Scenario: Raw credential failure becomes typed evidence

**WHEN** a connector run observes a source credential rejection
**THEN** the reference implementation records a `CredentialsValid` condition with `status=false`, a stable reason code, safe message, origin, observed timestamp, and remediation metadata.

#### Scenario: No usable credential is honest evidence distinct from rejection

**WHEN** a static-secret-BOUND connection has no usable stored credential (never captured, or superseded) and no evidence that a stored credential was provider-rejected
**THEN** the reference implementation SHALL record a `CredentialsValid` condition whose reason is a distinct "credential required" reason, not the "credential rejected" reason
**AND** the owner-facing message and remediation SHALL describe capturing a credential for the existing connection rather than asserting the source rejected a credential
**AND** the projected owner action SHALL be an owner reauth/capture action for the same connection.

#### Scenario: Browser-session-bound connection does not project credential_required

**WHEN** a connection is bound as a browser session (a browser-session `source_binding.kind`) and has no stored credential row
**AND** the connector also supports a static-secret credential at the connector level
**THEN** the reference implementation SHALL NOT record a "credential required" `CredentialsValid` condition from the absent credential row
**AND** the connection's repair SHALL be surfaced as browser/session repair rather than static-secret credential capture.

#### Scenario: Stored credential rejection becomes durable connection evidence

**WHEN** a connector run that received a connection-scoped stored credential reports a definitive provider credential rejection
**THEN** the reference implementation SHALL mark that stored credential as rejected with a non-secret reason and timestamp
**AND** future run credential recovery SHALL treat that credential as unavailable until explicit owner capture or rotation writes a new active credential.

#### Scenario: Unavailable credential evidence does not fabricate a repair state

**WHEN** the credential-presence evidence cannot be read (for example a credential-store read fails) rather than being read as an authoritative "no stored credential" result
**THEN** the reference implementation SHALL treat the credential-presence evidence as unavailable and fall back to its prior run-reason-derived credential projection
**AND** it SHALL NOT project `credential_required` or an owner reconnect/capture action solely from the unavailable read.

#### Scenario: Credential repair state does not heal by age alone

**WHEN** the most recent credential-shaped run reason code for a connection ages out or is superseded but no proof of credential/session readiness exists
**THEN** the connection SHALL NOT be projected healthy or idle on the credential/session axis
**AND** it SHALL continue to project the unresolved credential-required or credential-rejected condition until a successful run or an active captured credential proves readiness.

#### Scenario: Scheduled run defers rejected credential recovery

**WHEN** a scheduled run cannot recover a connection-scoped stored credential because the credential is missing, revoked, or provider-rejected
**THEN** the reference implementation SHALL NOT spawn the connector with a stale credential or deployment-wide fallback secret
**AND** it SHALL record a skipped owner-repair state instead of a failed connector run
**AND** later automatic ticks SHALL NOT keep retrying the same unavailable credential while the connection remains marked as needing owner repair.

#### Scenario: Explicit credential rotation clears rejection

**WHEN** the owner captures or rotates a valid credential for a connection whose prior credential was rejected
**THEN** the stored credential SHALL return to active status
**AND** the rejected timestamp and reason SHALL no longer make the connection appear credential-blocked.

#### Scenario: Browser-session repair is not password storage

**WHEN** the owner repairs a browser-session connection by logging in through the secure browser
**THEN** the reference implementation MAY capture the browser session state needed for that connector
**AND** it SHALL NOT silently persist the password typed into the provider page as a stored credential.

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

The reference implementation SHALL model scheduler backoff, paused schedules,
and next due time as policy conditions separate from freshness, coverage, and
last successful ingest.

A connector's **auto-schedulability** SHALL likewise be separate from data
health. When a connector's manifest refresh policy declares it manual, paused,
or background-unsafe (`recommended_mode: "manual"`,
`recommended_mode: "paused"`, or `background_safe: false` — the refresh-policy
values that make it ineligible for background schedule enrollment), the
projection SHALL NOT treat stale freshness as a data-health degradation when the
connection has no explicit owner-created schedule. A connector whose manifest
does not declare it manual, paused, or background-unsafe SHALL be treated as
schedulable, and stale freshness SHALL degrade it as before.

When a connector is recommended manual but also declares
`background_safe: true`, and the owner has explicitly enabled a schedule for the
connection, the projection SHALL treat that connection as scheduled rather than
manual-refresh-only. In that posture, stale freshness SHALL NOT project as
`stale_manual_refresh` or `owner_refresh_due`.

#### Scenario: Newer success clears stale backoff

- **WHEN** a connection has a scheduler backoff fact older than a successful run
  for the same connection generation
- **THEN** the stale backoff SHALL NOT cause the connection projection to be
  blocked or failing.

#### Scenario: Active backoff is visible

- **WHEN** retry policy is currently delaying the next run and no newer success
  supersedes it
- **THEN** the connection projection SHALL expose `cooling_off` or equivalent
  policy state with retry timing.

#### Scenario: Manual connector staleness is not a scheduler-driven failure

- **WHEN** a connection whose manifest refresh policy declares it manual,
  paused, or background-unsafe has aged past its freshness window and has no
  enabled owner-created schedule
- **THEN** the projection SHALL NOT report `degraded` solely because of that
  staleness
- **AND** an otherwise schedulable connector with the identical staleness SHALL
  still degrade.

#### Scenario: Explicitly scheduled manual-default connector is schedulable

- **WHEN** a connection whose manifest refresh policy declares `recommended_mode: "manual"`
  and `background_safe: true` has an enabled owner-created schedule
- **AND** its retained data has aged past the freshness window
- **THEN** the projection SHALL treat the connection as scheduled rather than
  manual-refresh-only
- **AND** the projection SHALL NOT report `owner_refresh_due`
- **AND** the schedule/freshness surface SHALL explain the stale state as the
  scheduler's responsibility rather than an owner-refresh advisory.

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

Owner-console surfaces that classify connection status or owner actionability SHALL use a shared actionability projection over the server-owned rendered verdict. A surface MAY render a different layout or join additional surface-specific data, but it SHALL NOT independently decide whether the primary action is owner-satisfiable, whether the connection requires owner action now, or whether a source belongs in owner-required, review, system-issue, or checking work.

Owner surfaces that present a headline count of sources needing attention SHALL derive that headline count from one shared function over the shared actionability projection. The headline "needs your action" count SHALL equal the size of the owner-required (needs-you) work group and SHALL NOT sum in the review, system-issue, or checking groups. A surface MAY additionally show a separate, distinctly-labeled secondary count for the wider reviewable set, but SHALL NOT present that wider number as the headline "needs you" count. When a surface renders the owner-required work group as rows, the headline count SHALL equal the number of rows in that primary group on the same surface.

The owner-facing label and one-line explanation for each of the owner-required, review, system-issue, and checking work groups SHALL come from the shared actionability projection. Owner surfaces SHALL NOT re-author per-surface group labels or notes for these four groups, so the dashboard and Runs surfaces render identical category copy. The non-urgent owner-runnable (review) group SHALL be presented as concrete available actions — labeled as available actions and, per row, preferring the rendered verdict's action CTA — rather than as a "ready for review" taxonomy noun. This owner-facing copy SHALL stay product-facing and neutral: it SHALL NOT expose the internal term "reference" for the product, and SHALL NOT use dramatic phrasing for non-urgent states.

#### Scenario: Dashboard and CLI agree

**WHEN** the same connection is listed in the dashboard and CLI
**THEN** the dominant state, reason, freshness, coverage, and remediation summary SHALL be derived from the same projection payload.

#### Scenario: Owner console surfaces agree on primary action

**WHEN** the owner console renders the same connection in Overview, Sources, Runs, or connection detail
**THEN** each surface SHALL use the same owner-satisfiable primary-action predicate
**AND** a maintainer-only or wait-only primary action SHALL NOT be counted as owner-required on any of those surfaces
**AND** any Runs action card SHALL be visibly grouped by the same owner-required, review, system-issue, or checking work classification used by the source-attention surfaces.

#### Scenario: Headline count equals its primary group and matches across surfaces

**WHEN** an owner has one source in the owner-required (needs-you) group and at least one source in each of the review, system-issue, and checking groups
**THEN** the dashboard hero headline "needs you" count SHALL equal the number of owner-required sources
**AND** that headline count SHALL be strictly less than the total number of source-attention rows rendered on the dashboard
**AND** the Runs surface's primary "needs you" count SHALL equal the dashboard hero headline count for the same connector set
**AND** neither surface SHALL sum the review, system-issue, or checking groups into the headline "needs you" count.

#### Scenario: Work-group labels are shared, not re-authored

**WHEN** the dashboard and the Runs surface each render the owner-required, review, system-issue, and checking work groups
**THEN** the label and one-line note for each group SHALL be sourced from the shared actionability projection
**AND** the group labels rendered on the dashboard SHALL be identical to those rendered on Runs.

#### Scenario: The non-urgent owner-action group reads as concrete available actions

**WHEN** a source belongs to the review (owner-runnable, non-urgent) work group and the rendered verdict supplies its owner-satisfiable primary-action CTA
**THEN** the owner-facing group label SHALL name available actions rather than a review taxonomy noun
**AND** the owner-facing row SHALL prefer the concrete action from the verdict CTA (for example "Amazon - Personal: Refresh now" or "Chase - Personal: Retry now") over generic "ready for review" copy
**AND** a dashboard hero raised for that group SHALL lead with the same concrete action rather than "ready for review" copy.

#### Scenario: Owner-facing work-group copy stays product-facing and neutral

**WHEN** the shared actionability projection supplies the owner-facing label or note for any of the four work groups
**THEN** that copy SHALL NOT use the internal term "reference" for the product (it uses the product-facing name PDPP or neutral phrasing)
**AND** it SHALL NOT use dramatic or alarming phrasing for a non-urgent state.

#### Scenario: Surface layout remains local

**WHEN** a surface needs additional layout-specific data such as run rhythm, schedule editing state, or diagnostics detail
**THEN** it MAY derive that data locally
**AND** it SHALL still consume the shared actionability projection for status and owner-action semantics.

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

Owner dashboard summaries that roll up connection health SHALL include degraded or cooling-off connection projections in an attention-visible summary bucket. A dashboard SHALL NOT present a zero attention-relevant summary while visible connection cards are degraded, cooling off, have stalled local-device work, or carry owner-runnable advisory required actions.

Owner-runnable advisory required actions SHALL be surfaced as a distinct non-alarming review state. They SHALL NOT be promoted to urgent attention solely because the owner can run them, but they SHALL suppress calm/all-clear copy and route the owner to source review. Maintainer-only or system-only required actions SHALL remain distinct from owner-runnable actions.

#### Scenario: Degraded card appears in the list

- **WHEN** a connection card renders with dominant state `degraded`
- **THEN** the dashboard summary SHALL include that connection in an attention-visible count or a distinct degraded count
- **AND** the summary SHALL NOT imply that no operator-relevant work exists

#### Scenario: Local outbox is stalled

- **WHEN** a local-device connection projects stalled outbox work
- **THEN** the dashboard summary SHALL make that stalled/degraded state visible without reclassifying it as a scheduler failure

#### Scenario: Owner-runnable advisory action appears without urgent attention

- **WHEN** a connection verdict has `channel: "advisory"` and a required action with `audience: "owner"` and `satisfied_when.kind` other than `none`
- **THEN** the dashboard summary SHALL render a non-alarming review state for that connection
- **AND** the dashboard summary SHALL NOT render calm/all-clear copy
- **AND** the connection source list SHALL expose that an owner-runnable action is available without turning the list row into the mutation control

#### Scenario: Maintainer-only action is not shown as owner-runnable

- **WHEN** a connection verdict has a required action with `audience: "maintainer"` or `satisfied_when.kind: "none"`
- **THEN** the dashboard summary and source list SHALL NOT present that action as something the owner can fix directly
- **AND** the owner surface SHALL still make the degraded or unavailable state visible as reviewable status

#### Scenario: Retained-size internals stay out of primary owner copy

- **WHEN** retained-size or dataset-summary projection metadata contains internal stale/failure reasons
- **THEN** the owner dashboard hero SHALL describe the operational effect in owner-safe language
- **AND** primary owner copy SHALL NOT include raw internal terms such as `projection`, `rebuild`, `bulk write`, `unknown connection`, or `SQL`

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

### Requirement: Local collector coverage SHALL derive from durable coverage diagnostics

When the connection-health rollup cannot derive a coverage verdict from run evidence (no terminal spine run, no pending detail gap, no degrading or accepted-coverage known gap, and no contradictory manifest), it SHALL derive the connection's coverage axis from the connection's durable `coverage_diagnostics` records. Local-device collectors push records from a device outbox and write no spine run history, so without this the coverage axis can only be `unknown` for them even after a successful host-local drain.

The derivation SHALL mirror the safe classification already used for the device-exporter completeness diagnostics: a store is accounted for when its coverage status is any recognized safe status other than `unaccounted`. When at least one coverage record is observed and no store is `unaccounted`, the coverage axis SHALL be `complete`. When at least one observed store is `unaccounted`, the axis SHALL be a degrading coverage gap that the `SourceCoverageComplete` condition surfaces with an actionable remediation. When no coverage records are observed, the axis SHALL remain `unknown`.

An empty, idle, or fully-drained local outbox SHALL NOT be treated as proof of complete coverage. Only durable coverage evidence SHALL promote the coverage axis off `unknown`; absence of coverage evidence SHALL read as absence, not as completeness.

Run-derived coverage SHALL stay authoritative. When run evidence yields any non-`unknown` coverage axis — `complete`, `partial`, `retryable_gap`, `terminal_gap`, an accepted-coverage label, or a required-but-accepted contradiction — the local coverage diagnostics SHALL NOT override it. The diagnostics SHALL apply only as a fallback when the run path is `unknown`. A failure to read the coverage diagnostics SHALL NOT fabricate a `complete` axis; it SHALL leave the run-derived axis unchanged.

#### Scenario: Drained local collector with full coverage diagnostics is no longer coverage_unknown

- **WHEN** a local-device connection has a trusted, healthy, fully-drained outbox and durable `coverage_diagnostics` records whose stores are all accounted for (collected, inventory-only, excluded, deferred, missing, or unsupported)
- **THEN** the connection projection SHALL report `axes.coverage = "complete"` and a `SourceCoverageComplete` condition with status `true`
- **AND** the coverage condition reason SHALL NOT be `coverage_unknown`

#### Scenario: Local collector with an unaccounted store reports a coverage gap

- **WHEN** a local-device connection's durable `coverage_diagnostics` records include at least one store classified `unaccounted`
- **THEN** the connection projection SHALL report a degrading coverage axis rather than `unknown` or `complete`
- **AND** the `SourceCoverageComplete` condition SHALL have status `false` with an actionable remediation, not a generic unknown

#### Scenario: Drained outbox without coverage diagnostics stays unknown

- **WHEN** a local-device connection has a trusted, healthy, fully-drained outbox but no `coverage_diagnostics` records
- **THEN** the connection projection SHALL leave `axes.coverage = "unknown"` and the `SourceCoverageComplete` condition reason `coverage_unknown`
- **AND** the empty/drained outbox SHALL NOT be projected as `complete`

#### Scenario: Run-derived coverage is not overridden by local coverage diagnostics

- **WHEN** a connection has a terminal spine run whose evidence yields a non-`unknown` coverage axis (for example a terminal known gap) and also has `coverage_diagnostics` records claiming completeness
- **THEN** the connection projection SHALL keep the run-derived coverage axis
- **AND** the local coverage diagnostics SHALL NOT promote the axis to `complete`

### Requirement: Connection health SHALL surface a nullable source-pressure detail-gap backlog rollup

The connection-health projection SHALL expose an additive, nullable
source-pressure detail-gap backlog rollup on the connection-health snapshot,
projected from the durable `connector_detail_gaps` evidence the reference already
holds. The rollup SHALL carry a pending count, an optional recovered count, a
maximum recovery-attempt count, an optional next-attempt floor, and a separate
pending-other count for non-source-pressure pending detail gaps. It SHALL be
reason-scoped to account/source pressure (for example detail gaps whose reason is
`upstream_pressure` or `rate_limited`); detail gaps with other reasons SHALL NOT
contribute to the source-pressure pending count, maximum attempt count, next
attempt floor, recovered count, or cooldown semantics.

The rollup SHALL be honest about absence. It SHALL be `null` when the durable gap
evidence cannot be read, so an unreadable store surfaces as unmeasured rather than
as a fabricated empty backlog. A drained backlog SHALL be a real `0` pending
count, distinct from a `null` rollup. The pending count SHALL be the load-bearing
field and SHALL NOT be inferred from collected record counts or list/detail
deltas — only the durable pending source-pressure gap rows SHALL count. The
recovered count SHALL be optional and SHALL be `null` when it is not cheaply
available rather than fabricated.

The pending count SHALL be honest about any bound applied when reading the durable
gaps. The projection SHALL report either an exact total or a bound-aware floor; it
SHALL NOT present a silently truncated bounded read as an exact total.
The pending-other count SHALL follow the same honesty rule. It is diagnostic
only: it SHALL be used to prevent owner surfaces from implying that detail-gap
recovery is caught up while non-source-pressure pending gaps remain, but it SHALL
NOT change source-pressure cooldown or backlog semantics.

This rollup SHALL be distinct from the local-device `outbox_counts` rollup: it is
the scheduler-managed source-pressure analogue and SHALL be available for any
connection with pending source-pressure detail gaps, including manual-refresh
connectors that never reach the scheduler `cooling_off` state.

#### Scenario: Connection with pending source-pressure gaps exposes a backlog rollup

- **WHEN** the connection-health projection is computed for a connection whose durable `connector_detail_gaps` evidence has one or more pending gaps with a source-pressure reason
- **THEN** the snapshot SHALL expose a non-null backlog rollup whose pending count equals the count of pending source-pressure gaps for that connection
- **AND** the rollup SHALL carry the maximum recovery-attempt count across those gaps and the next-attempt floor when one is known

#### Scenario: Drained backlog is a real zero, not null

- **WHEN** the projection is computed for a connection whose durable gap evidence is readable and has no pending source-pressure gaps
- **THEN** the backlog rollup pending count SHALL be `0`
- **AND** the rollup SHALL NOT be `null` on the basis that the backlog is empty

#### Scenario: Unreadable gap evidence surfaces as null, not zero

- **WHEN** the durable gap evidence cannot be read for a connection
- **THEN** the backlog rollup SHALL be `null`
- **AND** the projection SHALL NOT fabricate a `0` pending count or any other backlog figure for that connection

#### Scenario: Recovered count is optional

- **WHEN** the projection cannot cheaply compute the recovered count
- **THEN** the rollup's recovered count SHALL be `null`
- **AND** the pending count SHALL still be reported when pending gaps are present

#### Scenario: Non-source-pressure gaps do not contribute

- **WHEN** a connection's only pending detail gaps have non-source-pressure reasons
- **THEN** the backlog rollup pending count SHALL NOT include those gaps
- **AND** the rollup SHALL report `0` source-pressure pending (or `null` if the evidence is unreadable) rather than counting unrelated gaps
- **AND** the rollup SHALL carry those unrelated pending gaps in the pending-other count when the evidence is readable

#### Scenario: Bounded non-source-pressure evidence remains visible

- **WHEN** a bounded durable read shows no pending source-pressure detail gaps but does show one or more pending non-source-pressure detail gaps
- **THEN** the backlog rollup SHALL report `0` source-pressure pending
- **AND** it SHALL report the non-source-pressure pending count, labeled as a floor when the read bound was hit
- **AND** owner surfaces SHALL NOT describe the detail-gap backlog as caught up

#### Scenario: Manual-refresh connector still exposes the backlog

- **WHEN** a manual-refresh connector that cannot arm a scheduler cooldown has pending source-pressure detail gaps
- **THEN** the projection SHALL expose the backlog rollup with the pending count
- **AND** the rollup's next-attempt floor MAY be set even when the connection-level next automatic-dispatch time is `null`

### Requirement: Source-pressure backlog rollup SHALL stay decomplected and non-secret

The source-pressure detail-gap backlog rollup SHALL be additive evidence only. It
SHALL NOT change the connection's headline health state, coverage axis, freshness
axis, forward disposition, or owner-action CTA; those SHALL continue to be derived
from their existing condition families. Live run progress SHALL remain distinct
from this retained-data backlog: the rollup describes the cross-run pending
source-pressure backlog, not the most recent run's per-stream collection facts.

The rollup SHALL carry only non-negative integer counts and an optional ISO-8601
timestamp. It SHALL NOT carry a stream record body, detail locator, record
payload, source or host name, base URL, bearer token, credential, or filesystem
path. It SHALL NOT encode a connector identity into owner-facing semantics; the
rollup SHALL be derived generically from the source-pressure reason scope, not
from any per-connector branch. These counts are owner-only diagnostics and SHALL
NOT be exposed to grant-scoped clients.

#### Scenario: Backlog rollup does not move the headline projection

- **WHEN** a connection has a non-null backlog rollup and otherwise-green coverage, freshness, attention, and forward-disposition evidence
- **THEN** the headline state, coverage axis, freshness axis, forward disposition, and owner-action CTA SHALL be exactly what the existing condition families produce
- **AND** the presence of the backlog rollup SHALL NOT by itself change any of them

#### Scenario: Backlog rollup carries no source identity or secret

- **WHEN** the projection exposes the source-pressure backlog rollup
- **THEN** the rollup SHALL contain only non-negative integer counts and an optional ISO-8601 timestamp
- **AND** it SHALL NOT contain a record body, detail locator, record payload, source or host name, base URL, token, credential, or filesystem path

#### Scenario: Backlog rollup is owner-only

- **WHEN** a grant-scoped client queries records or streams for a connection that has a source-pressure backlog
- **THEN** the backlog rollup SHALL NOT be exposed to that grant-scoped client

### Requirement: Owner console SHALL surface source-pressure backlog scale only where it aids catch-up

The owner console SHALL render a compact catch-up cue describing how much detail
is outstanding (for example a pending count, and a recovered count when present)
only when it renders a connection whose projection shows a source-pressure /
retryable-gap state and whose snapshot carries a non-null source-pressure backlog
rollup with a positive pending count. The cue SHALL be keyed on the existing
source-pressure reason class, never on a connector name, and SHALL fulfill the
existing "see how much is left to catch up" guidance rather than inventing a new
remote fix.

The console SHALL keep quiet connections free of the cue. It SHALL NOT render the
cue on a connection whose backlog rollup is `null` (unmeasured), whose pending
count is `0` (drained), or whose projection is healthy, idle, or otherwise not in
a source-pressure / retryable-gap state. The cue SHALL carry only the counts
already exposed on the owner-only backlog rollup and SHALL NOT introduce new
telemetry or leak the raw `source_pressure` reason token into owner-facing copy.
When a projection path is already rendering detail-gap backlog scale and the
source-pressure pending count is `0`, the console SHALL NOT render "caught up" if
the same backlog rollup reports positive non-source-pressure pending detail gaps.

#### Scenario: Source-pressure connection with a positive backlog shows a catch-up cue

- **WHEN** the console renders a connection whose projection shows a source-pressure / retryable-gap state and whose snapshot carries a backlog rollup with a positive pending count
- **THEN** the console SHALL render a compact catch-up cue stating how much detail is pending (and recovered when present)
- **AND** the cue SHALL be derived from the source-pressure reason class with no connector name and no raw reason token in the copy

#### Scenario: Drained, unmeasured, and quiet connections render no cue

- **WHEN** the console renders a connection whose backlog rollup is `null`, whose pending count is `0`, or whose projection is healthy, idle, or otherwise not in a source-pressure / retryable-gap state
- **THEN** the console SHALL NOT render a source-pressure catch-up cue or a numeric backlog badge for that connection

#### Scenario: Other pending gaps suppress caught-up copy

- **WHEN** the console renders detail-gap backlog scale for a connection whose source-pressure pending count is `0`
- **AND** the same backlog rollup reports a positive non-source-pressure pending count
- **THEN** the console SHALL NOT say the backlog is caught up
- **AND** it SHALL render that other detail items remain pending without treating them as source-pressure gaps

#### Scenario: Catch-up cue introduces no new telemetry

- **WHEN** the console renders the source-pressure catch-up cue
- **THEN** the cue SHALL carry only the counts already present on the owner-only backlog rollup
- **AND** it SHALL NOT introduce new device or run telemetry beyond that rollup

### Requirement: Owner surfaces SHALL render one server-synthesized verdict and SHALL NOT re-derive health from the headline state

The reference implementation SHALL expose a single server-owned synthesized
`RenderedVerdict` object, produced by a pure function next to the connection-health
projection, and forwarded to owner surfaces verbatim through the same control-plane
seam that already forwards `connection_health`. The `RenderedVerdict` SHALL be the
only health object that owner-facing console surfaces render. No owner surface —
dashboard list, connection header, connection detail, owner-agent passport, or
operator console — SHALL re-derive a pill, badge, headline, or owner action from
the raw headline `state` or from individual axes; every such surface SHALL read the
synthesized verdict's fields.

The synthesis SHALL be a pure projection of evidence the snapshot already carries
(headline `state`, the coverage / freshness / attention / outbox axes,
`forward_disposition`, `conditions[]`, `interaction_posture`, the per-stream
rollups, the refresh evidence, and a `runtime_ok` input). It SHALL perform no I/O
and SHALL NOT read a clock; the same inputs SHALL always produce the same verdict.

The `RenderedVerdict` SHALL carry a `pill` (`tone` plus `label`), a `channel`, a
co-required `annotations[]` list, a derived `forward_statement`, an ordered
`required_actions[]` list, per-stream rows whose action reference indexes into
`required_actions[]`, a collection-model-aware `progress`, and an inspection-layer
`detail` object.

#### Scenario: Dashboard, header, and passport render the same synthesized verdict

- **WHEN** the same connection is rendered in the dashboard list, the connection
  header, and the owner-agent passport
- **THEN** all three surfaces SHALL render the same `pill`, `channel`,
  `forward_statement`, owner-actionable annotation, and primary required action
  from the one synthesized `RenderedVerdict`
- **AND** no surface SHALL compute a pill, badge, or owner action directly from the
  raw headline `state` or from an individual axis.

#### Scenario: Synthesis is pure

- **WHEN** `synthesizeRenderedVerdict` is called twice with the same snapshot,
  per-stream rollups, refresh evidence, and `runtime_ok` input
- **THEN** it SHALL return an identical `RenderedVerdict` both times
- **AND** it SHALL NOT read a clock, perform I/O, or depend on call order.

### Requirement: The verdict pill SHALL represent collection health, while freshness and action urgency SHALL remain separate

The synthesized `pill.tone` SHALL be computed as a worst-wins rollup over the
collection-health inputs — the base tone implied by the headline state, the worst
per-stream coverage tone, the freshness tone, the forward-disposition tone, the
attention tone, and the outbox tone — and SHALL NOT be a straight read of the
headline `state`. Freshness SHALL be co-rendered as a separate annotation. Stale
freshness SHALL NOT by itself downgrade an otherwise-healthy collection-health
pill: a manual-refresh source whose retained data is merely stale can therefore
remain `green` / `Healthy` while its freshness annotation and optional refresh
action explain that newer data is available. Unknown freshness, however, is
missing evidence: when no stronger degraded signal exists, it SHALL render as
`grey` / `Checking`, not `green` / `Healthy` or `amber` / `Degraded`.

The `pill.label` SHALL be assigned from `tone` by a fixed health-label bijection
(`green` ↔ `Healthy`, `amber` ↔ `Degraded`, `red` ↔ `Can't collect`, `grey` ↔
`Checking`); the same tone SHALL always map to the same label and a label SHALL
NOT appear under a different tone. The phrase `Needs you` SHALL NOT be used as a
health label; it is reserved for owner-attention/action presentation when
`channel === "attention"` and an owner-satisfiable required action exists.

When the freshness axis is not `fresh`, the verdict's `annotations[]` SHALL contain
a `freshness`-kind annotation; a non-`fresh` connection SHALL NOT render a pill
without its co-required freshness annotation. The verdict SHALL NOT present a
contradictory pair of signals: a per-stream collected count SHALL NOT exceed its
considered count, and the `forward_statement` SHALL NOT assert resumed collection
while a co-rendered chip reports a terminal or unknown disposition for the same
scope.

#### Scenario: Stale-but-otherwise-green connection stays healthy with a freshness annotation

- **WHEN** a connection has headline state `healthy` or `idle` and freshness axis
  `stale`
- **THEN** the synthesized `pill.tone` MAY remain `green` when no collection-health
  input is degraded
- **AND** the `pill.label` SHALL remain `Healthy`, not `Needs you`
- **AND** the verdict's `annotations[]` SHALL contain a `freshness`-kind annotation
  stating how long since the connection was fresh.

#### Scenario: Unknown freshness renders as checking rather than healthy or degraded

- **WHEN** a connection has otherwise-healthy collection-health inputs and
  freshness axis `unknown`
- **THEN** the synthesized `pill.tone` SHALL be `grey`
- **AND** the `pill.label` SHALL be `Checking`, not `Healthy` or `Degraded`
- **AND** the verdict's `annotations[]` SHALL contain a `freshness`-kind annotation
  explaining that freshness is unknown
- **AND** the `forward_statement` SHALL NOT claim the source is current or
  collecting normally.

#### Scenario: Worst axis wins over a healthy state

- **WHEN** a connection has headline state `healthy` but its worst per-stream
  coverage axis is degrading
- **THEN** `pill.tone` SHALL roll to the worst axis's tone rather than the
  state-implied `green`
- **AND** the `pill.label` SHALL be the fixed health-label for that tone.

#### Scenario: No contradictory collected-over-considered chip

- **WHEN** the verdict renders a per-stream coverage chip
- **THEN** the rendered collected count SHALL be clamped to at most the considered
  count, so an arithmetically impossible "3/2 collected" SHALL NOT appear
- **AND** the chip SHALL NOT pair a "resumes collection" phrase with an `unknown`
  or `terminal` coverage disposition for the same stream.

#### Scenario: Unknown coverage renders as checking rather than retryable

- **WHEN** a connection has otherwise-idle collection-health inputs and coverage
  axis `unknown`
- **THEN** the forward disposition SHALL be `checking`, not `resumable`
- **AND** the synthesized `pill.tone` SHALL be `grey`
- **AND** the `pill.label` SHALL be `Checking`, not `Healthy` or `Degraded`
- **AND** the verdict SHALL NOT include a `retry_gap` required action
- **AND** the `forward_statement` SHALL NOT say that the next run is expected to
  fill remaining data.

### Requirement: The verdict channel SHALL route attention separately from tone and SHALL keep actionless signals out of the attention channel

The synthesized verdict SHALL carry a `channel` field
(`calm` | `advisory` | `attention`) computed in the same synthesis pass, AFTER
`tone`, that decides whether the connection interrupts the owner. `channel` SHALL
be orthogonal to `tone`: `tone` answers how worried to be (worst-wins over axes),
`channel` answers whether to interrupt (a function of who can resolve the
condition). The default `channel` SHALL be `calm`. The verdict MAY raise
`channel` to `advisory` for owner-actionable but non-urgent conditions,
owner-optional accelerants, or visible status conditions whose `audience` is
`maintainer` or `none` and that must be acknowledged without presenting a dead
owner button. The verdict SHALL raise `channel` to `attention` only when an
owner-satisfiable action exists and the owner is the sole resolution — the system
cannot make progress with the credentials and access it currently holds.

The attention channel SHALL NOT carry an actionless signal: when
`channel === "attention"` the verdict SHALL contain at least one required action
whose `audience` is `owner` and whose `satisfied_when.kind` is not `none`. A
required action whose `audience` is `maintainer` or `none` SHALL render as a status
line and SHALL NOT raise `channel` to `attention`.

Maintainer/status copy SHALL be factual reference-instance copy. It SHALL NOT use
hosted-service voice such as "we're updating it" or false reassurance such as
"nothing for you to do" for a source that cannot currently collect. A terminal
`code_fix` action SHALL communicate that connector code must change before the
source can collect again.

When a stream has both a `SKIP_RESULT` diagnostic and a pending `DETAIL_GAP`, the
pending detail gap SHALL be treated as the durable retry contract for that
stream. The diagnostic skip SHALL NOT promote the stream or connection to a
terminal/code-fix verdict unless separate terminal evidence remains after
correlating the same-stream pending detail gap.

#### Scenario: Action urgency is separate from health tone

- **WHEN** one stale connection is manual-refresh-only and otherwise healthy, and
  another amber connection has had its credential rejected so only re-auth resolves it
- **THEN** the manual-refresh connection SHALL be `channel: "advisory"` and the
  credential-rejected connection SHALL be `channel: "attention"`
- **AND** only the credential-rejected connection SHALL be eligible for
  owner-attention wording such as `Needs you`.

#### Scenario: Broken but recently refreshed data does not claim freshness as health

- **WHEN** a connection cannot currently collect but its retained data was refreshed
  recently
- **THEN** the health pill SHALL be `Can't collect`
- **AND** the freshness annotation SHALL say `Last successful refresh <age>` or
  equivalent, not `Fresh <age>`, so the surface does not imply the broken connector
  is healthy.

#### Scenario: Terminal code-fix status is factual and not hosted-service voice

- **WHEN** a connection has terminal coverage with no owner-satisfiable recovery
  action
- **THEN** the verdict SHALL include a `code_fix` required action with
  `audience: "maintainer"` and `satisfied_when.kind: "none"`
- **AND** the status copy SHALL say that connector code needs a fix before the
  source can collect again
- **AND** it SHALL NOT say that "we" are updating it or that there is "nothing
  for you to do."

#### Scenario: Retryable detail gap beats same-stream skip diagnostic

- **WHEN** a connector records a `SKIP_RESULT` diagnostic for a stream and also
  records a pending `DETAIL_GAP` for the same stream
- **THEN** the connection coverage SHALL remain retryable/resumable unless another
  terminal gap exists outside that same-stream detail-gap contract
- **AND** the owner surface SHALL render a degraded advisory with a retry
  affordance, not a terminal `code_fix` status.

#### Scenario: A fresh, fully self-handled connection stays calm

- **WHEN** a scheduled connection is fresh and every outstanding condition is one
  the system is itself resolving (a drain, a cooldown, or an in-flight run)
- **THEN** the verdict's `channel` SHALL be `calm`
- **AND** the verdict SHALL carry no owner-audience required action.

#### Scenario: A stalled outbox cannot be calm or say collection is normal

- **WHEN** a connection has `axes.outbox: "stalled"` even though its required
  coverage and forward disposition are otherwise complete
- **THEN** the verdict SHALL NOT assign `channel: "calm"`
- **AND** the verdict SHALL include an owner-audience required action telling the
  owner the cause-specific local collector recovery step
- **AND** the `forward_statement` SHALL NOT say that the source is current,
  collecting normally, or self-handled.

#### Scenario: State-read stalled outbox does not render dead-letter recovery

- **WHEN** a stalled local-device outbox is caused by
  `local_exporter_state_read_failed` or `outbox_state_read_failed`
- **THEN** the primary required action SHALL tell the owner to re-run the collector
  on the host
- **AND** the action's focused remediation payload SHALL carry
  `cause: "state_read_failed"` and only a local-collector run command
- **AND** the action, remediation, and forward statement SHALL NOT tell the owner
  to retry dead letters.

#### Scenario: Dead-letter stalled outbox renders retry-then-rerun recovery

- **WHEN** a stalled local-device outbox is caused by
  `local_exporter_dead_letter_backlog` or `outbox_dead_letter_backlog`
- **THEN** the primary required action's focused remediation payload SHALL carry
  `cause: "dead_letter_backlog"`
- **AND** the remediation commands SHALL include a recovery preview command and
  a recovery apply command in that order; the apply command SHALL requeue failed
  uploads when present and run the collector once.
- **AND** the action `cta`, `forward_statement`, and owner-facing summary SHALL
  explain that records saved on the local collector host did not upload to the
  server
- **AND** those primary owner-facing strings SHALL NOT use `dead-letter` as the
  owner-visible problem name; that term MAY appear only in command names,
  machine-readable reasons, or collapsed technical detail.

#### Scenario: Focused local-collector recovery shows exact commands and why to run them

- **WHEN** a local-device recovery action includes a focused remediation payload
- **THEN** the owner surface SHALL name the host or say `the host that holds the
  data` when the host name is unknown
- **AND** it SHALL render the exact copyable command or commands for that cause
- **AND** each command SHALL include a plain-language purpose so the owner does
  not need to remember the local-collector workflow.

#### Scenario: Local-collector recovery targets the source-instance profile, not the public connection id

- **WHEN** a local-device recovery action is rendered for a connection whose
  owner-facing `connection_id` / `connector_instance_id` differs from the
  device-binding `source_instance_id`
- **THEN** the copyable command SHALL target the device-binding
  `source_instance_id` and SHALL NOT substitute the public connection id into a
  local outbox command
- **AND** the command SHALL rely on the local collector's recovery/profile lookup
  to find the enrolled queue, connector, base URL, and device credential on that
  host
- **AND** if the owner surface cannot resolve exactly one source-instance binding
  for the focused recovery target, it SHALL render a non-copyable unavailable
  state rather than a command that can inspect the wrong queue.

#### Scenario: Local collector recover command loads the host profile before touching the outbox

- **WHEN** the owner runs a rendered local recovery command on the host that owns
  the collector
- **THEN** `pdpp-local-collector recover --source-instance-id <id>` SHALL locate
  the enrolled local profile for that `source_instance_id` when one exists and
  use that profile's durable outbox path, connector id, reference base URL, and
  device credential
- **AND** the dry-run form SHALL explain what would be recovered without mutating
  the outbox or uploading records
- **AND** the `--apply` form SHALL perform the cause-appropriate recovery and
  run the collector once using the same profile
- **AND** the command SHALL fail with an explicit operator error instead of
  falling back to an unrelated default queue when no matching profile or explicit
  queue environment is available.

#### Scenario: Stale-pending stalled outbox renders rerun recovery

- **WHEN** a stalled local-device outbox is caused by
  `local_exporter_stale_pending` or `outbox_stale_pending`
- **THEN** the primary required action's focused remediation payload SHALL carry
  `cause: "stale_pending"`
- **AND** the remediation commands SHALL include the collector re-run step and
  SHALL NOT include a dead-letter retry command.

#### Scenario: A degraded resumable stale gap is advisory rather than silent

- **WHEN** a connection is `degraded`, has a resumable/partial coverage gap, and
  stale freshness
- **THEN** the verdict SHALL assign `channel: "advisory"`
- **AND** the verdict SHALL include a `retry_gap` required action with
  `audience: "owner"` and `satisfied_when.kind: "gap_recovered"`
- **AND** the degraded connection SHALL NOT collapse to a calm `wait` action.

#### Scenario: Attention channel always carries an owner-satisfiable action

- **WHEN** the synthesizer would emit a verdict with `channel === "attention"`
- **THEN** that verdict SHALL contain at least one required action with
  `audience === "owner"` and `satisfied_when.kind !== "none"`
- **AND** a verdict with no such action SHALL NOT be assigned `channel: "attention"`.

### Requirement: The forward statement SHALL be derived from the disposition and required actions and SHALL NOT contradict them

When a connection has terminal coverage gaps but current evidence proves the latest collection succeeded and the snapshot is degraded rather than blocked, the rendered verdict SHALL keep the coverage gap visible while avoiding total-failure copy. The pill SHALL render as degraded, and the forward statement SHALL describe known coverage gaps without claiming that collection failed to run or that a future run recovers terminal data.

#### Scenario: Successful terminal coverage is degraded review, not total failure

**WHEN** a connection snapshot is degraded, has terminal coverage, and carries a current `CollectionSucceeded=true` condition
**THEN** the rendered verdict pill is `Degraded`
**AND** the primary maintainer-status action uses coverage-review copy rather than generic connector-code-fix copy
**AND** the forward statement says the latest collection completed with known coverage gaps
**AND** the verdict SHALL NOT claim that a retry, refresh, or next run recovers the terminal coverage gap.

### Requirement: Owner actions SHALL be a typed required-action list with derived terminality and one unified satisfaction contract

The rendered verdict's primary required action SHALL remain the single action source consumed by owner surfaces. Owner surfaces SHALL NOT replace an owner-runnable required action with a generic run control. Owner surfaces SHALL render run-start controls only for required-action kinds that actually start a run from that surface, and SHALL route other owner-runnable actions to the appropriate detail flow.

When a server action starts or reports an existing run, the owner surface SHALL expose a concrete run-detail link whenever a run id is present. It SHALL preserve the full run id string returned or named by the server.

A credential-rejection condition's remediation label SHALL name the same single recovery action as the rendered verdict's reconnect CTA. The reference SHALL NOT emit a competing credential-recovery phrasing (for example one that offers "reconnect or update" as if they were two different actions) alongside the rendered verdict's single reconnect CTA for the same rejected credential.

#### Scenario: Owner-runnable non-run action is not rendered as generic sync

**WHEN** a source verdict's primary required action is owner-runnable but is not `refresh_now` or `retry_gap`
**THEN** the Sources view renders it as a detail hint using the server-owned CTA
**AND** the Sources view SHALL NOT render a generic `Sync now` button for that action.

#### Scenario: Run-start result links to the concrete run

**WHEN** the owner starts a run or the server reports a run is already active
**THEN** the Sources view shows the run-start result inline
**AND** when a run id is present, the result links to that run's detail route while preserving the full run id.

#### Scenario: Credential rejection names one reconnect action

**WHEN** a connection's credentials are rejected and both the rendered verdict CTA and the connection-health remediation label are produced for that condition
**THEN** the remediation label SHALL name the same single reconnect action as the rendered verdict CTA
**AND** the reference SHALL NOT present a "reconnect or update" phrasing that reads as two distinct owner actions for the one rejected credential.

### Requirement: Repair SHALL self-heal and auto-resume onto the existing connection

The reference implementation SHALL define a self-heal / auto-resume loop driven by
the unified `satisfied_when` contract. A watcher in the connection controller SHALL
evaluate each owner-actionable required action's `satisfied_when` against the
durable evidence the projection already reads. When the evidence flips to satisfied,
the controller SHALL automatically — without a separate "now run it" owner step —
re-attach the schedule if the action's `satisfied_when` is
`schedule_attached_and_enabled`, fire exactly one confirming run, drain recoverable
gaps, re-synthesize the verdict, and flip the connection to green on the EXISTING
connection so the schedule and stored tokens survive (no setup wizard, no new
connection).

The auto-resume SHALL NOT paint a false green: if the confirming run fails
identically, the verdict SHALL re-present the SAME required action with the failure
reason, and the connection SHALL NOT be reported healthy. On partial recovery, the
verdict SHALL keep the surviving terminal or owner-blocked stream's own required
action while clearing the recovered streams. The loop SHALL be bounded by the
existing backoff and cooldown so a flapping condition does not storm confirming
runs.

#### Scenario: Satisfying a refresh lands on the existing connection and auto-resumes

- **WHEN** the owner satisfies a `refresh_now` or `reauth` action and the durable
  evidence the `satisfied_when` watches flips to satisfied
- **THEN** the controller SHALL fire one confirming run, drain recoverable gaps,
  re-synthesize the verdict, and flip the pill green WITHOUT presenting a separate
  "now run it" step
- **AND** the repaired connection SHALL be the SAME `connection_id` with its
  schedule and stored tokens preserved, not a newly created connection.

#### Scenario: Identical re-failure does not paint a false green

- **WHEN** the confirming run after a satisfied action fails with the same cause
- **THEN** the verdict SHALL re-present the same required action with the failure
  reason
- **AND** the connection SHALL NOT be reported `healthy`.

#### Scenario: Partial recovery keeps the unrecovered stream's action

- **WHEN** the auto-resume run recovers some streams but leaves one terminal or
  owner-blocked stream unresolved
- **THEN** the recovered streams SHALL clear their actions
- **AND** the unresolved stream SHALL keep its own required action and SHALL keep
  the verdict honest about that stream.

### Requirement: The verdict SHALL route self-handled signals to an inspection layer and SHALL keep mechanistic counts off the dashboard

The synthesized verdict SHALL separate an attention layer from an inspection layer.
The attention layer (`pill`, `channel`, `forward_statement`, the one co-required
freshness annotation, and the primary owner-actionable required action when one
exists) SHALL answer "do I need to do anything?" for a non-technical owner. The
inspection layer (the verdict's `detail` object: the headline `state`, the
`reason_code`, the `dominant_condition_id`, the raw `forward_disposition`, the
`conditions[]`, the detail-gap backlog rollup, the next-attempt floor, and the
collection-rate snapshot) SHALL answer "what exactly is happening?" for an engineer,
reviewer, or power user.

A signal the system is itself handling, and that the owner cannot accelerate or
improve by acting now, SHALL be suppressed from the attention channel and routed to
the inspection-layer `detail`; it SHALL NOT be deleted. The `detail` object SHALL be
a strict superset of any evidence the attention layer drops, so suppressed truth is
always one disclosure away. Annotations on a `calm` or `advisory` verdict SHALL be
limited to `freshness`, `schedule`, or `activity` kinds with no raw counts in their
text; mechanistic figures — gap counts, retry counts, backlog scale — SHALL appear
only in `detail`. A `calm` verdict SHALL carry at most one annotation (the neutral
freshness or activity one).

The inspection-layer `detail` and the detail-gap backlog rollup SHALL remain
owner-only diagnostics and SHALL NOT be exposed to grant-scoped clients, identical
to the existing `detail_gap_backlog` exposure policy.

#### Scenario: A fully-drained scheduled connector shows no gap count on the dashboard

- **WHEN** a scheduled connection is fresh and its detail-gap backlog is fully
  recovered (zero pending, the recovered count present in the backlog rollup)
- **THEN** the dashboard attention layer SHALL render the connection as healthy and
  fresh with no gap count, no backlog scale, and no badge demanding attention
- **AND** the recovered gap count SHALL be present in the inspection-layer
  `detail.detail_gap_backlog`, not on the dashboard.

#### Scenario: Suppressed evidence is routed to detail, never deleted

- **WHEN** the silence predicate suppresses a self-handled signal from the
  attention channel
- **THEN** that signal SHALL be present in the verdict's `detail` object
- **AND** `detail` SHALL be a strict superset of the evidence dropped from the
  attention layer.

#### Scenario: Calm and advisory annotations carry no mechanistic counts

- **WHEN** the verdict's `channel` is `calm` or `advisory`
- **THEN** each annotation SHALL be a `freshness`, `schedule`, or `activity` kind
  with no raw gap, retry, or backlog count in its text
- **AND** a `calm` verdict SHALL carry at most one such annotation.

#### Scenario: Inspection-layer detail is owner-only

- **WHEN** a grant-scoped client reads records or streams for a connection
- **THEN** the verdict's inspection-layer `detail` and detail-gap backlog rollup
  SHALL NOT be exposed to that grant-scoped client.

### Requirement: A runtime fault SHALL NOT cascade into per-connection attention pulls

The synthesizer SHALL take a `runtime_ok: boolean` input and, when the runtime
serving the connections is itself the fault — the scheduler loop is dead, the
browser surface is down, or the collector device is offline — SHALL cap every
per-connection verdict's `channel` at `calm` and SHALL emit one global runtime
indicator separate from the per-connection list. No per-connection verdict SHALL be
assigned `channel: "attention"` while the runtime is the actual fault. The
per-connection pills SHALL remain honest about their own state; only the routing to
the attention channel SHALL be suppressed so one runtime fault does not produce N
false attention pulls.

#### Scenario: A dead runtime emits one indicator, not N alarms

- **WHEN** `runtime_ok` is false and multiple connections would otherwise surface
  individual attention pulls
- **THEN** every per-connection verdict's `channel` SHALL be capped at `calm`
- **AND** a single global runtime indicator SHALL be emitted above the connection
  list, and no per-connection verdict SHALL be `channel: "attention"`.

#### Scenario: Per-connection pills stay honest under a runtime fault

- **WHEN** `runtime_ok` is false
- **THEN** each connection's `pill.tone` SHALL still reflect its own honest state
- **AND** only the `channel` routing SHALL be suppressed, not the pill's truth.

### Requirement: The agency policy SHALL decide silence per state from manifest-sourced evidence

The owner console SHALL derive source actionability from the server-owned rendered
verdict, not by reinterpreting raw health axes per surface. When a rendered
verdict is present, owner-console source lists and overview panels SHALL use the
verdict's `channel` and ordered `required_actions[]` to decide whether a
connection requires owner action, is owner-reviewable, is a system/maintainer
issue, or is merely being checked. Legacy `connection_health.next_action` and
failure-summary fallback MAY be used only when the rendered verdict is absent.

The owner console SHALL assign each visible connection to at most one actionability
group on a given panel. A higher-priority owner-facing group SHALL own the row:
owner-required work first, owner-reviewable work second, system/maintainer issues
third, and passive checking last. Lower-priority facts for the same connection
SHALL remain available on the exact connection detail surface rather than
producing duplicate overview rows.

Owner-console detail surfaces that summarize a connection's source health SHALL
use the same rendered-verdict-derived status and required-action helpers as
overview/list surfaces. A detail surface MAY render lower-level evidence axes,
logs, and diagnostics, but it SHALL NOT maintain a separate verdict tone-to-label
table or owner-action CTA derivation for the same source verdict.

Owner-facing counts SHALL match the visible scope they describe. A count such as
"3 need you" SHALL count only rows in the owner-required group. If the same panel
also renders reviewable, system, or checking rows, those rows SHALL be separately
grouped or separately counted, never implied by the owner-required count.

The UI SHALL NOT expose internal verdict taxonomy labels (`attention`, `advisory`,
`terminal_gap`, `outbox`, retry disposition names, or raw projection/storage
errors) as the primary owner-facing grouping language. Owner-facing grouping copy
SHALL answer what can be done now: owner-required work, reviewable owner actions,
system/maintainer issues, and checking/passive states.

#### Scenario: Overview count matches urgent owner rows

- **WHEN** three source verdicts are `channel: "attention"` with owner-satisfiable
  required actions
- **AND** additional source verdicts are reviewable, system/maintainer-only, or
  checking
- **THEN** the Overview hero MAY say that three sources need the owner
- **AND** the visible owner-required group SHALL contain exactly those three rows
- **AND** other rows SHALL be rendered under their own group headings or counts.

#### Scenario: Reviewable degraded source appears once

- **WHEN** a source verdict is non-attention, has an owner-satisfiable required
  action, and also carries an amber or red pill
- **THEN** the Overview actionability panel SHALL render one row for that source in the owner-review group
- **AND** it SHALL NOT render a second system-issue row for the same source in the same panel.

#### Scenario: Maintainer-only issue is not owner work

- **WHEN** a source verdict has only maintainer-audience or
  `satisfied_when.kind: "none"` required actions
- **THEN** the Overview actionability panel SHALL render it as a system/maintainer issue
- **AND** the row SHALL NOT be counted as owner-required work
- **AND** the row SHALL NOT render a CTA that implies the owner can complete the repair from the dashboard.

#### Scenario: Checking rows are passive

- **WHEN** a source verdict is `channel: "calm"` with a grey checking pill or
  equivalent unresolved passive state
- **THEN** the owner console MAY show the row in a muted checking group
- **AND** the row SHALL NOT be counted as a problem requiring owner action.

#### Scenario: Connection diagnostics uses the shared rendered verdict

- **WHEN** a connection detail diagnostics surface summarizes a source rendered
  verdict
- **THEN** the surface SHALL render the status label and tone from the shared
  source-actionability projection
- **AND** it SHALL preserve freshness context supplied by that projection
- **AND** it SHALL NOT derive the same label from a local verdict tone vocabulary.

### Requirement: The verdict progress signal SHALL be collection-model-aware

The verdict SHALL carry a `progress` value that privileges the right productivity
signal for the connection's collection model rather than a lone `records_emitted`
count. The progress SHALL declare a `mode`
(`scheduled` | `manual` | `deferred` | `local_device`). For a `deferred` connector
whose per-run `records_emitted` is structurally zero, the progress SHALL privilege
gaps drained and retained records rather than the zero per-run count. For a
`scheduled` connector the progress SHALL privilege records committed by the last
run. For a `manual` connector the progress SHALL privilege retained records and the
"last refreshed Nd ago" recency. The "did it work?" signal SHALL NOT render a
structurally-zero number for a connector whose collection model does not emit
per-run records.

#### Scenario: A deferred connector never shows a structurally-zero records_emitted

- **WHEN** a `deferred` connector has succeeded runs whose `records_emitted` is
  structurally zero but has drained gaps and retained records
- **THEN** the verdict's `progress` SHALL declare `mode: "deferred"` and privilege
  gaps drained and retained records
- **AND** it SHALL NOT present the structurally-zero `records_emitted` as the
  "did it work?" signal.

#### Scenario: A scheduled connector privileges records committed

- **WHEN** a `scheduled` connector completes a run that commits records
- **THEN** the verdict's `progress` SHALL declare `mode: "scheduled"` and privilege
  the records committed by that run.

### Requirement: Self-Handled Local-Device Drains SHALL Render As Background Progress

Owner inspection surfaces SHALL render a visible calm background-drain summary
when a local-device connection's trusted device progress reports pending outbox
work and the rendered verdict has no owner-actionable local-device remediation.
The summary SHALL identify that saved work is uploading from the local host,
SHALL include available queue scale and last-progress evidence, and SHALL NOT
render recovery commands.

#### Scenario: Pending local-device work is actively draining

**WHEN** a connection has trusted `local_device_progress.records_pending > 0`
and the rendered verdict has no local-device remediation action
**THEN** the owner inspection surface shows a calm background-upload summary
**AND** the summary includes the pending scale and any available host/progress
timestamps
**AND** the surface does not tell the owner to run dead-letter recovery commands.

#### Scenario: Stalled local-device work remains owner-actionable

**WHEN** a connection has a rendered verdict required action whose remediation
target is `local_device`
**THEN** the owner inspection surface shows the cause-specific recovery panel
**AND** it does not replace that recovery path with a passive background-upload
summary.

### Requirement: Connection health SHALL project acquisition coverage without conflating it with scheduler failure

The reference connection-health projection SHALL treat acquisition-batch coverage
as evidence separate from scheduler policy, credential readiness, runtime
readiness, and collection success. Expected manual staleness, partial owner
artifacts, duplicate uploads, and declared missing media SHALL be surfaced as
coverage facts or advisories rather than generic failures unless the connector
declares them blocking.

#### Scenario: Manual artifact source becomes stale

- **WHEN** a connection's latest owner-artifact acquisition covers data only up
  to an older event timestamp
- **THEN** owner surfaces SHALL show the covered-through timestamp and a
  re-export or add-artifact action when available
- **AND** the projection SHALL NOT label the connection as failed solely because
  the source requires owner action for newer data.

#### Scenario: Manual artifact source needs an owner reminder

- **WHEN** an owner wants periodic prompting for a source that requires a new
  owner artifact
- **THEN** the reminder SHALL be represented as owner attention or notification
  cadence for the source
- **AND** it SHALL NOT be represented as an automatic connector run schedule
  unless the run can collect new data without a new owner artifact.

#### Scenario: Import succeeds with missing media

- **WHEN** an acquisition batch accepts records but reports missing optional
  media
- **THEN** owner surfaces SHALL show the missing-media coverage gap and the next
  action to add media when known
- **AND** the connection SHALL NOT be projected as a generic runtime or
  scheduler failure.

#### Scenario: Import produces no new records because it is duplicate

- **WHEN** an owner-artifact acquisition is entirely duplicate of a previous
  accepted batch
- **THEN** owner surfaces SHALL show that no new records were added because the
  artifact was already known
- **AND** the projection SHALL NOT report a failed import.

### Requirement: Owner surfaces SHALL provide coverage receipts for acquisition batches

When the reference accepts an acquisition batch, owner-facing surfaces SHALL be
able to render a receipt with safe counts, event-time coverage, duplicate/skipped
facts, and actionable gaps. The receipt SHALL avoid source-specific UI logic by
consuming connector/runtime-provided acquisition-batch facts.

#### Scenario: Owner artifact is parsed before commit

- **WHEN** the reference can parse an owner artifact before durable import
- **THEN** owner surfaces SHOULD preview accepted, duplicate, skipped, failed,
  event-time range, and gap facts before commit
- **AND** the preview SHALL be generated from the same connector/runtime facts
  used by the eventual receipt.

#### Scenario: Acquisition batch is committed

- **WHEN** an acquisition batch commits records
- **THEN** owner surfaces SHALL be able to show a receipt naming the source,
  acquisition method, event-time range, count summary, and any advisory gaps
- **AND** the receipt SHALL NOT claim full-source completeness unless the batch
  evidence supports that claim.

### Requirement: Dashboard, CLI, and owner API SHALL share acquisition coverage projection

Dashboard, CLI, and owner-control-plane API surfaces SHALL consume the same
connection-health and acquisition-coverage projection for owner-visible coverage
states. They SHALL NOT independently infer whether owner-artifact, device-sync,
device-backup, or browser-polyfill coverage is complete.

#### Scenario: Same source is viewed in dashboard and CLI

- **WHEN** the owner views a manual/exported-data source in the dashboard and CLI
- **THEN** both surfaces SHALL derive covered-through timestamp, partial
  coverage, duplicate-import, and missing-media status from the same projection
- **AND** differences in copy or layout SHALL NOT change the underlying state.

### Requirement: Owner source surfaces SHALL degrade transient read failures without premature alarm

When the owner console cannot refresh the source list because a read fails, the source surface SHALL distinguish a transient first failure from a persistent failure.

#### Scenario: First read failure during refresh

- **WHEN** a Sources route refresh fails during a dynamic read
- **AND** the console has not yet attempted its automatic recovery
- **THEN** it SHALL render quiet retrying copy
- **AND** it SHALL NOT render the explicit failure headline yet

#### Scenario: Automatic recovery also fails

- **WHEN** a Sources route refresh fails
- **AND** the automatic recovery has already been attempted
- **THEN** it SHALL render explicit read-failure copy
- **AND** it SHALL offer a manual retry control

#### Scenario: Last successful load timestamp

- **WHEN** the read-failure boundary has a client-cached timestamp for the last clean render
- **THEN** it MAY display that timestamp as the last successful load
- **AND** it SHALL NOT claim to render cached source rows unless such rows are actually rendered

### Requirement: Owner console SHALL consume the server-owned verdict without leaking local state across sources

The Sources view SHALL key source-detail state by the selected source identity so row-local toasts, confirmation ceremonies, and transient action state from one source cannot appear on another source after selection changes.

#### Scenario: Selecting another source clears local action state

**WHEN** the owner switches the selected source in the Sources view
**THEN** the rendered source-detail component remounts for the new source identity
**AND** transient local state from the previously selected source is not shown on the new source.

### Requirement: Connection repair state SHALL be evidence-derived and connection-scoped

The reference implementation SHALL derive current repair state for a connection from typed evidence such as credential validity, provider-grant validity, browser-session readiness, local-collector health, runtime-binding availability, run assistance, coverage gaps, and satisfied required actions. A run may create evidence, but the repaired object SHALL be the existing connection.

Repair state SHALL NOT be closed solely because a run ended, an owner-action row aged out, or a connector-specific status string disappeared. A connection may stop showing an old prompt when it expires or is superseded, but it SHALL NOT be projected healthy until current evidence proves readiness or the relevant issue no longer applies.

#### Scenario: Owner repairs the same connection

- **WHEN** the owner satisfies a reauthorization, credential rotation, browser-session repair, local-collector repair, or recoverable-gap action
- **THEN** the reference SHALL attach the repair evidence to the same `connection_id`
- **AND** it SHALL preserve that connection's schedules, grants, stored credential identity, and run history unless the owner explicitly creates a new connection.

#### Scenario: Old repair prompt expires without proof

- **WHEN** an owner-action prompt expires or is superseded without evidence that the connection is ready
- **THEN** the expired prompt SHALL NOT remain the dominant current action
- **AND** the connection SHALL still project any unresolved readiness, credential, session, coverage, or local-device condition that remains current.

#### Scenario: Confirmation run fails identically

- **WHEN** an owner repair action appears satisfied but the confirming run fails with the same repair cause
- **THEN** the connection SHALL return to the same repair-required class with updated evidence
- **AND** it SHALL NOT be projected healthy.

### Requirement: Unattended repair SHALL defer owner-mediated actions

Scheduled and otherwise unattended runs SHALL NOT initiate owner-mediated repair actions that require active owner participation. They SHALL record evidence that the existing connection needs repair and allow the connection-health projection to surface the appropriate owner action.

#### Scenario: Scheduled run needs a browser login

- **WHEN** a scheduled run detects that collection cannot proceed without owner browser operation
- **THEN** it SHALL record bounded repair-required evidence for the connection
- **AND** it SHALL NOT open an owner browser session, ask for a password, request OTP, or create repeated interactive prompts from the scheduled path.

#### Scenario: Owner repair can resume automatic collection

- **WHEN** the owner later starts and completes the required repair action
- **THEN** the reference SHALL verify the repair through current evidence or a bounded confirming run
- **AND** automatic collection MAY resume on the same connection if its schedule and policy allow it.
