## MODIFIED Requirements

### Requirement: Version-churn observability SHALL serve the unfiltered hot path from the maintained projection without an unbounded history scan

The owner-only `GET /_ref/records/version-stats` read SHALL produce its bounded
top-churn diagnostic for an **unfiltered** request without running an unbounded
aggregate over the entire `record_changes` table. The reference implementation
SHALL source the unfiltered advisory from the maintained retained-size
projection and SHALL compute the ground-truth aggregate (`COUNT(*)`,
`COUNT(DISTINCT record_key)`, `MAX(emitted_at)`) only for a bounded candidate set
of clean projection rows whose facts could classify above `normal`.

This requirement governs how row facts are sourced for the unfiltered hot path.
It SHALL NOT alter what a row contains, the numeric churn thresholds, the
`risk_level` / `risk_reasons` classification, or the derived
`version_disposition`. A row whose facts are sourced from ground truth SHALL be
byte-identical to the row the prior full scan would have produced for that same
`(connector_instance_id, stream)` scope.

The reference implementation SHALL treat the projection's `record_history_count`
and current `record_count` as exact only when that projection row is not dirty.
For an unfiltered request, a dirty projection row SHALL be returned as an honest
projection-backed advisory row with `projection_dirty: true`; it SHALL NOT force
an immediate ground-truth scan. The unfiltered route SHALL also avoid the full
ground-truth fallback when the global retained-size projection is dirty. A dirty
or rebuilding global projection SHALL be reported in the envelope projection
metadata rather than repaired synchronously by a whole-history aggregate.

The bounded candidate set SHALL be derived conservatively from clean projection
rows so that a clean stream whose projection facts could place it at or above
the `watch` threshold is included in the bounded ground-truth computation.
Over-inclusion of a stream that proves `normal` SHALL be acceptable; omission of
a clean non-`normal` stream SHALL NOT occur.

Explicit diagnostic requests scoped by exact `connector_instance_id` and/or
exact `stream` MAY use the ground-truth computation for that bounded scope.

#### Scenario: Unfiltered request avoids the unbounded scan

- **WHEN** an owner-authenticated caller requests `GET /_ref/records/version-stats`
  with no `connector_instance_id` and no `stream` filter
- **THEN** the reference implementation SHALL NOT run an aggregate over
  `record_changes` that is unbounded by stream
- **AND** it SHALL compute the ground-truth `COUNT(*)`,
  `COUNT(DISTINCT record_key)`, and `MAX(emitted_at)` only for the bounded
  candidate set of clean projection rows.

#### Scenario: Candidate facts are byte-identical to the full scan

- **WHEN** the unfiltered request classifies a clean candidate stream as
  `watch` or `high` from the candidate ground-truth computation
- **THEN** that row's `record_history_count`, `record_key_count`,
  `last_history_at`, `versions_per_record`, `risk_level`, `risk_reasons`, and
  `version_disposition` SHALL equal the values the prior full `record_changes`
  scan would have produced for the same stream.

#### Scenario: A non-candidate normal stream is classified without a scan

- **WHEN** a stream's non-dirty projection facts are below the candidate
  threshold under the versions-per-record-maximizing denominator
- **THEN** the reference implementation SHALL classify the row from projection
  facts alone, reporting `projection_authority` as the projection, and SHALL
  report `record_key_count` and `last_history_at` as null
- **AND** it SHALL NOT issue a `record_changes` aggregate for that stream.

#### Scenario: A dirty projection row stays advisory on the default route

- **WHEN** an unfiltered request sees a dirty stream projection row
- **THEN** the reference implementation SHALL return that row from projection
  facts with `projection_dirty: true`
- **AND** it SHALL NOT include that row in the unfiltered ground-truth candidate
  set solely because it is dirty.

#### Scenario: A cold or rebuilding projection stays bounded

- **WHEN** an unfiltered request arrives while the global retained-size
  projection is dirty
- **THEN** the reference implementation SHALL return a bounded projection-backed
  advisory and expose the dirty projection metadata
- **AND** it SHALL NOT compute the diagnostic from a full unbounded
  `record_changes` aggregate.

#### Scenario: Filtered requests remain exact diagnostics

- **WHEN** an owner passes an exact `connector_instance_id` or exact `stream`
  filter
- **THEN** the reference implementation MAY apply that filter to the
  ground-truth computation as before
- **AND** result size SHALL remain capped by the server-enforced limit.
