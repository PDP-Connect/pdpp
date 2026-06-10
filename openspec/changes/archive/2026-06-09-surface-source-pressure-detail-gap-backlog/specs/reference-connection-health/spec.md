## ADDED Requirements

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
