## ADDED Requirements

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
