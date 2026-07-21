## ADDED Requirements

### Requirement: Chase current-activity snapshot readiness SHALL be determined by the parser's output, not a locator predicate alone

The Chase connector SHALL attempt `parseCurrentActivityDom` against the
dashboard overview HTML it has already read before waiting on the
recent-activity row-selector locator, and SHALL accept a non-empty parse
result as proof of readiness without an additional wait. The connector SHALL
fall back to waiting for the row selector only when the immediate parse
yields no rows, and SHALL re-run the parse against HTML read after that wait
resolves or times out. The value reported as surface-readiness
(`rowSurfaceReady`) SHALL reflect the outcome of the parser's most recent
attempt against the HTML actually returned to the caller, and SHALL NOT be
derived solely from whether the row-selector wait promise resolved.

This requirement does not establish or claim a distinction between a genuine
Chase-side empty state and unrecognized or drifted markup. Absent verified
evidence of an explicit empty-state signal on this surface, a zero-row parse
result after the fallback wait SHALL continue to route to the connector's
existing `selectors_pending` diagnostic.

#### Scenario: Chase current activity accepts an already-parseable snapshot without waiting

- **WHEN** the Chase connector reads dashboard overview HTML for
  `current_activity`
- **AND** `parseCurrentActivityDom` finds one or more rows in that HTML on
  the first read
- **THEN** the connector SHALL accept that snapshot as ready
- **AND** SHALL NOT consult the recent-activity row-selector locator before
  returning it.

#### Scenario: Chase current activity falls back to the bounded wait only when the first parse is empty

- **WHEN** the Chase connector reads dashboard overview HTML for
  `current_activity`
- **AND** `parseCurrentActivityDom` finds zero rows in that HTML on the first
  read
- **THEN** the connector SHALL wait for the recent-activity row selector
  within the bounded DOM wait budget
- **AND** SHALL re-read and re-parse the dashboard HTML after that wait
  resolves or times out
- **AND** the reported surface-readiness SHALL reflect that re-parsed result,
  not merely whether the row-selector wait promise resolved.
