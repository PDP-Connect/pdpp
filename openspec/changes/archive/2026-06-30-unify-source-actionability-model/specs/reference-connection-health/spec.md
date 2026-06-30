## MODIFIED Requirements

### Requirement: The agency policy SHALL decide silence per state from manifest-sourced evidence

The owner console SHALL derive source actionability from the server-owned rendered verdict, not by reinterpreting raw health axes per surface. When a rendered verdict is present, owner-console source lists and overview panels SHALL use the verdict's `channel` and ordered `required_actions[]` to decide whether a connection requires owner action, is owner-reviewable, is a system/maintainer issue, or is merely being checked. Legacy `connection_health.next_action` and failure-summary fallback MAY be used only when the rendered verdict is absent.

The owner console SHALL assign each visible connection to at most one actionability group on a given panel. A higher-priority owner-facing group SHALL own the row: owner-required work first, owner-reviewable work second, system/maintainer issues third, and passive checking last. Lower-priority facts for the same connection SHALL remain available on the exact connection detail surface rather than producing duplicate overview rows.

Owner-console detail surfaces that summarize a connection's source health SHALL use the same rendered-verdict-derived status and required-action helpers as overview/list surfaces. A detail surface MAY render lower-level evidence axes, logs, and diagnostics, but it SHALL NOT maintain a separate verdict tone-to-label table or owner-action CTA derivation for the same source verdict.

Owner-facing counts SHALL match the visible scope they describe. A count such as "3 need you" SHALL count only rows in the owner-required group. If the same panel also renders reviewable, system, or checking rows, those rows SHALL be separately grouped or separately counted, never implied by the owner-required count.

The UI SHALL NOT expose internal verdict taxonomy labels (`attention`, `advisory`, `terminal_gap`, `outbox`, retry disposition names, or raw projection/storage errors) as the primary owner-facing grouping language. Owner-facing grouping copy SHALL answer what can be done now: owner-required work, reviewable owner actions, system/maintainer issues, and checking/passive states.

#### Scenario: Overview count matches urgent owner rows

- **WHEN** three source verdicts are `channel: "attention"` with owner-satisfiable required actions
- **AND** additional source verdicts are reviewable, system/maintainer-only, or checking
- **THEN** the Overview hero MAY say that three sources need the owner
- **AND** the visible owner-required group SHALL contain exactly those three rows
- **AND** other rows SHALL be rendered under their own group headings or counts.

#### Scenario: Reviewable degraded source appears once

- **WHEN** a source verdict is non-attention, has an owner-satisfiable required action, and also carries an amber or red pill
- **THEN** the Overview actionability panel SHALL render one row for that source in the owner-review group
- **AND** it SHALL NOT render a second system-issue row for the same source in the same panel.

#### Scenario: Maintainer-only issue is not owner work

- **WHEN** a source verdict has only maintainer-audience or `satisfied_when.kind: "none"` required actions
- **THEN** the Overview actionability panel SHALL render it as a system/maintainer issue
- **AND** the row SHALL NOT be counted as owner-required work
- **AND** the row SHALL NOT render a CTA that implies the owner can complete the repair from the dashboard.

#### Scenario: Checking rows are passive

- **WHEN** a source verdict is `channel: "calm"` with a grey checking pill or equivalent unresolved passive state
- **THEN** the owner console MAY show the row in a muted checking group
- **AND** the row SHALL NOT be counted as a problem requiring owner action.

#### Scenario: Connection diagnostics uses the shared rendered verdict

- **WHEN** a connection detail diagnostics surface summarizes a source rendered verdict
- **THEN** the surface SHALL render the status label and tone from the shared source-actionability projection
- **AND** it SHALL preserve freshness context supplied by that projection
- **AND** it SHALL NOT derive the same label from a local verdict tone vocabulary.
