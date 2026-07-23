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

#### Scenario: A row past the quarantine no-progress threshold is not starved forever behind a growing backlog

- **WHEN** a pending row's `attempt_count` exceeds the quarantine policy's
  `maxNoProgressAttempts` threshold
- **AND** a backlog of other eligible rows keeps arriving and being served
  ahead of it
- **THEN** the row's selection rank SHALL NOT keep growing worse without
  bound as its `attempt_count` climbs past the threshold
- **AND** the row SHALL eventually be selected again once it has aged past
  the rotation window, exactly as a row whose `attempt_count` equals the
  threshold would
- **AND** this SHALL hold so the row can reach quarantine evaluation
  (`maybeQuarantineGap`) rather than remaining pending indefinitely with no
  further attempts and no terminal classification.

#### Scenario: The attempt-count rank clamp is proven independently on both storage backends

- **WHEN** the attempt-count rank clamp is verified
- **THEN** a regression SHALL exist for BOTH the SQLite and the Postgres
  `pendingGapOrderBySql` branches, run against a real backend instance (a
  dedicated throwaway database for Postgres, never a live/production
  database)
- **AND** each backend's regression SHALL independently fail when only that
  backend's clamp is reverted, proving the two branches are not accidentally
  coupled and that fixing one does not stand in as proof for the other.

### Requirement: Recovery leases and provider attempts SHALL be separate durable facts

The runtime SHALL claim a served detail gap with a unique run-owned lease before
it sends the row to a connector. Claiming a lease SHALL NOT increment
`attempt_count` or replace `last_attempt_at`. A connector SHALL explicitly
report a provider attempt or a terminal recovery outcome; the runtime SHALL NOT
infer that an otherwise-silent row was unattempted merely from `DONE:succeeded`.
Lease attempt, recovery, re-deferral, and release mutations SHALL compare the
same gap, run, and lease identities.

#### Scenario: Legacy lease-less in-progress state is normalized at bootstrap

- **WHEN** bootstrap upgrades a pre-lease schema containing an `in_progress`
  detail gap with no lease run, lease id, or lease expiry
- **THEN** bootstrap SHALL return that row to `pending`
- **AND** it SHALL preserve the row's existing `attempt_count` and
  `last_attempt_at` as prior real-attempt evidence.

#### Scenario: Lease migration has a bounded mixed-version policy

- **WHEN** the lease migration is deployed
- **THEN** deployment SHALL drain active connector runs and restart only the
  new runtime version before bootstrap normalizes legacy lease-less rows
- **AND** bootstrap SHALL fail closed if the pre-lease schema still has a
  durable active-run row
- **AND** mixed old/new runtime operation SHALL be unsupported rather than
  maintained by a recurring distributed compatibility mechanism.

#### Scenario: A successful bounded prefix leaves its unadmitted suffix unattempted

- **WHEN** a runtime serves multiple pending detail gaps
- **AND** a connector cleanly completes after reporting a recovery outcome for
  only an admitted prefix
- **THEN** each remaining served row SHALL be `pending` with the same
  `attempt_count` it had before that run
- **AND** it SHALL retain any prior real `last_attempt_at` value unchanged.

#### Scenario: An explicit attempt survives failed, cancelled, or crashed cleanup

- **WHEN** a connector explicitly reports an attempt and then exits without a
  recovery outcome
- **THEN** cleanup SHALL return its owned lease to `pending` while retaining
  that attempt's count and timestamp.

#### Scenario: Gmail lookup misses explicitly settle an attempted lease

- **WHEN** Gmail receives a served attachment gap with an owned lease
- **AND** Gmail performs its bounded metadata lookup but cannot find the named
  attachment
- **THEN** Gmail SHALL report an explicit provider attempt followed by a
  lease-owned `temporary_unavailable` re-deferral
- **AND** the resulting pending row SHALL retain the real attempt evidence
  rather than relying on a silent successful `DONE` inference.

#### Scenario: Gmail's metadata-cap suffix remains untouched

- **WHEN** Gmail reaches its bounded metadata-lookup cap before it begins a
  served attachment gap
- **THEN** it SHALL report neither an attempt nor an outcome for that untouched
  suffix
- **AND** runtime cleanup SHALL CAS-release the suffix without changing its
  prior attempt count or timestamp.

#### Scenario: Stale cleanup cannot release a re-served row

- **WHEN** a lease expires, a later run reclaims and re-serves the gap, and the
  earlier run subsequently cleans up
- **THEN** the earlier cleanup SHALL not change the later lease, attempt count,
  or timestamp on either SQLite or Postgres.

#### Scenario: Same-page lease tokens cannot be swapped

- **WHEN** two detail gaps are served in the same recovery page
- **THEN** each SHALL receive a distinct `lease_id`
- **AND** an outcome or explicit attempt naming one gap with the other gap's
  lease id SHALL fail before settling either row.

### Requirement: The runtime SHALL preserve only validated aggregate recovery outcomes on existing progress events

When a connector includes an `attachment_recovery_outcome` on a `PROGRESS`
message, the runtime SHALL accept only the fixed discriminator and exact set
of non-negative integer aggregate fields: `served`, `metadata_lookups`,
`attempted`, `admitted`, `admitted_bytes`, `recovered`, `lookup_miss`,
`hydration_failed`, and `run_cap_deferred`. The runtime SHALL preserve a valid
object on the existing `run.progress_reported` event and SHALL reject any
extra field, identifier, locator, provider identity, content, error text, or
invalid count as a connector protocol violation.

#### Scenario: An aggregate recovery outcome reaches the existing spine without a new event type

- **WHEN** a connector emits a valid `PROGRESS.attachment_recovery_outcome`
- **THEN** the runtime SHALL record it on that same `run.progress_reported`
  event
- **AND** it SHALL NOT create a new durable subsystem or event type.

#### Scenario: A recovery outcome cannot carry private detail

- **WHEN** a connector emits an `attachment_recovery_outcome` with any field
  outside the fixed aggregate allowlist
- **THEN** the runtime SHALL reject the message before it reaches the spine.

#### Scenario: Success awaits accounting

- **WHEN** a connector reports `DONE:succeeded` with outstanding leases
- **THEN** the runtime SHALL await their durable CAS release before resolving
  success, committing state, or emitting terminal success evidence
- **AND** a durable accounting failure or explicitly-attempted lease without an
  outcome SHALL fail the run.
