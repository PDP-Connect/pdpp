## ADDED Requirements

### Requirement: Browser-backed connectors SHALL wait for the evidence surface they parse

Browser-backed connectors SHALL wait for the specific bounded selector or
readiness signal used by a source-specific DOM parser before snapshotting that
surface when the parsed surface hydrates independently from the page's coarse
navigation or account shell.

When a browser-backed connector parses such a source-specific DOM surface that
hydrates independently from the page's coarse navigation or account shell, the
connector SHALL wait for the specific bounded selector or readiness signal used
by the parser before snapshotting that surface. If the parser surface does not
appear within the connector's bounded wait budget, the connector MAY emit its
existing selector-drift or source-unavailable diagnostic, but it SHALL NOT treat
a different page shell selector as proof that the parser surface was ready.

#### Scenario: Chase current activity waits for recent-activity rows

- **WHEN** the Chase connector has reached the dashboard overview and intends to
  collect `current_activity`
- **AND** account-card selectors are present before the recent-activity table
  rows have hydrated
- **THEN** the connector SHALL wait for the recent-activity row selector before
  reading dashboard HTML for `current_activity`
- **AND** a successful wait SHALL cause the snapshot to include the parser's row
  surface.

#### Scenario: Chase current activity preserves selector diagnostics

- **WHEN** the Chase connector intends to collect `current_activity`
- **AND** the recent-activity row selector does not appear within the bounded
  DOM wait budget
- **THEN** the connector SHALL preserve the existing `selectors_pending`
  diagnostic path rather than fabricating coverage.
