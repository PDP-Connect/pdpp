## ADDED Requirements

### Requirement: Connector-neutral recovery-page selection SHALL make fair progress across a multi-page pending backlog

When the durable pending detail-gap backlog for a connection exceeds one
recovery page (bounded by the page byte budget), the store's recovery-page
selection SHALL NOT let a fixed subset of rows monopolize every page
indefinitely. A row that has been served for recovery one or more times
without being recovered or terminalized SHALL become no more likely to be
selected ahead of an unserved, equally-eligible row on a later selection.

#### Scenario: A backlog larger than one page rotates fair share of pages across runs

- **WHEN** the pending backlog for one connector instance and stream exceeds
  the recovery page's byte-bounded candidate limit
- **AND** the connector being served does not recover or re-defer every row
  it is served
- **THEN** across repeated successful runs, rows that were never previously
  served SHALL eventually be selected for a recovery page
- **AND** no subset of rows SHALL remain selected on every page while the
  rest of the backlog is never read from the store.

#### Scenario: Backoff-deferred rows remain excluded regardless of attempt history

- **WHEN** a pending row's `next_attempt_after` is in the future
- **THEN** the row SHALL NOT be selected for a recovery page
- **AND** this SHALL hold regardless of the row's `attempt_count` relative to
  other pending rows.

#### Scenario: Terminal rows never resurface regardless of attempt history

- **WHEN** a row has transitioned to `terminal`
- **THEN** it SHALL NOT be selected for a recovery page
- **AND** this SHALL hold regardless of its `attempt_count`.

#### Scenario: A backlog within one page is unaffected

- **WHEN** the pending backlog for one connector instance and stream is
  smaller than the recovery page's candidate limit
- **THEN** every eligible row SHALL be selected on the same page
- **AND** the selection order SHALL NOT change which rows are served, only
  the ordering among them.

#### Scenario: An old eligible row is not starved forever by a steady stream of fresh arrivals

- **WHEN** new zero-attempt rows keep arriving for the same connector
  instance and stream faster than an older eligible row is served
- **THEN** the older row SHALL eventually outrank the newer arrivals once it
  has waited longer than the recovery-page's rotation window
- **AND** ordering by `attempt_count` alone SHALL NOT be sufficient — age
  SHALL also factor into selection priority.

#### Scenario: The age component is computed identically on SQLite and Postgres

- **WHEN** a row's `last_attempt_at` is absent (NULL)
- **THEN** both backends SHALL fall back to `created_at` for the age
  component and the tie-break, identically
- **AND** this SHALL hold even in the degenerate case of an empty-string
  `last_attempt_at` — both backends SHALL treat an empty string the same as
  NULL (via `NULLIF`) rather than one backend aging from a different anchor
  than the other.
